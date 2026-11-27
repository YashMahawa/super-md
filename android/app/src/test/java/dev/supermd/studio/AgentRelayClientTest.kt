package dev.supermd.studio

import android.os.Looper
import android.util.Base64
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.ByteString
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows
import org.robolectric.annotation.Config
import java.io.File
import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class AgentRelayClientTest {
    private val client = AgentRelayClient()
    private val revision = "a".repeat(64)
    private val svg = "<svg xmlns='http://www.w3.org/2000/svg'/>".toByteArray()

    private fun contractJson(): JSONObject = listOf("../../docs/agent-contract.json", "../docs/agent-contract.json", "docs/agent-contract.json")
        .map(::File).first { it.exists() }.readText(Charsets.UTF_8).let(::JSONObject)

    private class RecordingWebSocket(private val initialRequest: Request) : WebSocket {
        val sent = CopyOnWriteArrayList<String>()
        @Volatile var closedCode: Int? = null
        override fun request(): Request = initialRequest
        override fun queueSize(): Long = 0L
        override fun send(text: String): Boolean = sent.add(text)
        override fun send(bytes: ByteString): Boolean = false
        override fun close(code: Int, reason: String?): Boolean = if (closedCode != null) false else { closedCode = code; true }
        override fun cancel() = Unit
    }

    private fun JSONArray.strings(): List<String> = (0 until length()).map(::getString)
    private fun assertRejected(request: JSONObject) { assertThrows(IllegalArgumentException::class.java) { client.validateRequest(request) } }

    private class FakeRelayHarness(val config: AgentAccessConfig = AgentAccessConfig("https://relay.example.test", "group-1", "device-1", "device-secret", "pairing-secret", "connector-secret", "Android", "android")) {
        val states = CopyOnWriteArrayList<AgentRelayClient.State>()
        val enrolls = AtomicInteger()
        val sockets = CopyOnWriteArrayList<Pair<RecordingWebSocket, WebSocketListener>>()
        private val opened = Semaphore(0)
        val relay = AgentRelayClient { states += it }.also { r ->
            r.client = OkHttpClient.Builder().addInterceptor { chain ->
                enrolls.incrementAndGet()
                Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("OK")
                    .body(JSONObject().put("groupId", config.groupId).toString().toResponseBody("application/json".toMediaType())).build()
            }.build()
            r.webSocketFactory = WebSocket.Factory { req, listener -> RecordingWebSocket(req).also { sockets += it to listener; opened.release() } }
        }
        val registeredFrame: String = JSONObject().put("type", "registered").put("groupId", config.groupId).put("deviceId", config.deviceId).toString()
        fun awaitSocket(): Pair<RecordingWebSocket, WebSocketListener> { assertTrue(opened.tryAcquire(5, TimeUnit.SECONDS)); synchronized(relay) {}; return sockets.last() }
        fun register(pair: Pair<RecordingWebSocket, WebSocketListener>) { pair.second.onMessage(pair.first, registeredFrame); Shadows.shadowOf(Looper.getMainLooper()).idle() }
    }

    private fun connectTestSession(
        handler: (JSONObject, (Any?, String?) -> Unit) -> Unit = { _, reply -> reply(JSONObject().put("ok", true), null) },
    ): Triple<AgentRelayClient, RecordingWebSocket, WebSocketListener> {
        val h = FakeRelayHarness(); h.relay.connect(h.config, handler)
        val pair = h.awaitSocket(); h.register(pair); assertEquals(AgentRelayClient.State.CONNECTED, h.relay.currentState())
        return Triple(h.relay, pair.first, pair.second)
    }

    private fun request(action: String = "attach", body: String = Base64.encodeToString(svg, Base64.NO_WRAP)) = JSONObject()
        .put("requestId", "asset_1").put("action", "asset_action").put("tabId", "tab:device:workspace:1")
        .put("expectedRevision", revision).put("assetAction", action)
        .put("assetName", "assets/model.svg").put("mimeType", "image/svg+xml").put("body", body)

    @Test fun acceptsBoundedPortableImageMutationAndReadActions() {
        client.validateRequest(request())
        client.validateRequest(request("list").put("body", "").put("offset", 50).put("limit", 50))
        client.validateRequest(request("source").put("body", ""))
    }

    @Test fun rejectsOversizedMalformedOrUnrevisionedAssetRequests() {
        assertThrows(IllegalArgumentException::class.java) {
            client.validateRequest(request(body = Base64.encodeToString(ByteArray(1_048_577), Base64.NO_WRAP)))
        }
        assertThrows(IllegalArgumentException::class.java) {
            client.validateRequest(request().put("mimeType", "text/html"))
        }
        assertThrows(IllegalArgumentException::class.java) {
            client.validateRequest(request().put("assetName", "assets/../escape.svg"))
        }
        assertThrows(IllegalArgumentException::class.java) {
            val missing = request()
            missing.remove("expectedRevision")
            client.validateRequest(missing)
        }
        assertEquals("asset_action", request().getString("action"))
    }

    @Test fun acceptsViewportImageFormatOnlyForRenderTabAndOnlySupportedEncodings() {
        val jpeg = JSONObject().put("requestId", "render_1").put("action", "render_tab")
            .put("tabId", "tab:device:workspace:1").put("imageFormat", "jpeg").put("width", 1000)
        client.validateRequest(jpeg)
        client.validateRequest(JSONObject(jpeg.toString()).put("imageFormat", "png"))
        client.validateRequest(JSONObject(jpeg.toString()).put("action", "get_diagram_image")
            .put("expectedRevision", revision).put("diagramId", "diagram:1"))

        assertThrows(IllegalArgumentException::class.java) {
            client.validateRequest(JSONObject(jpeg.toString()).put("imageFormat", "webp"))
        }
        assertThrows(IllegalArgumentException::class.java) {
            client.validateRequest(JSONObject(jpeg.toString()).put("action", "read_tab"))
        }
        assertThrows(IllegalArgumentException::class.java) {
            val missingTab = JSONObject(jpeg.toString())
            missingTab.remove("tabId")
            client.validateRequest(missingTab)
        }
    }

    @Test fun authenticatedWebSocketAdvertisesSupportedPreviewFormats() {
        val config = AgentAccessConfig(
            serverOrigin = "https://relay.example.test",
            groupId = "group-1",
            deviceId = "device-1",
            deviceKey = "device-secret",
            pairingKey = "pairing-secret",
            connectorKey = "connector-secret",
            displayName = "Android",
            platform = "android",
        )

        val request = client.authenticatedWebSocketRequest(config)
        assertEquals("png,jpeg", request.header("X-SuperMD-Preview-Formats"))
        assertEquals("Bearer device-secret", request.header("Authorization"))
        assertEquals("https", request.url.scheme)
    }

    @Test fun validatesCloudDocumentLifecycleOptionsAndStrictWriteRevisions() {
        val create = JSONObject().put("requestId", "create_1").put("action", "document_action")
            .put("documentAction", "create").put("content", "hello")
            .put("options", JSONObject().put("title", "Draft").put("format", "smd").put("background", true))
        client.validateRequest(create)
        assertEquals("Draft", create.getString("titleHint"))
        assertEquals("smd", create.getString("format"))
        client.validateRequest(JSONObject().put("requestId", "activate_1").put("action", "document_action")
            .put("documentAction", "activate").put("tabId", "tab:device:workspace:1"))
        client.validateRequest(JSONObject().put("requestId", "save_1").put("action", "document_action")
            .put("documentAction", "save").put("tabId", "tab:device:workspace:1")
            .put("expectedRevision", revision).put("options", JSONObject().put("saveAs", false)))
        val saveAs = JSONObject().put("requestId", "save_as_1").put("action", "document_action")
            .put("documentAction", "save").put("tabId", "tab:device:workspace:1")
            .put("expectedRevision", revision).put("options", JSONObject().put("saveAs", true).put("filename", "Draft.md").put("format", "md"))
        client.validateRequest(saveAs)
        assertEquals("Draft.md", saveAs.getString("filename"))
        client.validateRequest(JSONObject().put("requestId", "close_1").put("action", "document_action")
            .put("documentAction", "close").put("tabId", "tab:device:workspace:1")
            .put("expectedRevision", revision).put("options", JSONObject().put("discardChanges", true)))

        assertThrows(IllegalArgumentException::class.java) {
            client.validateRequest(JSONObject().put("requestId", "save_2").put("action", "document_action")
                .put("documentAction", "save").put("tabId", "tab:device:workspace:1"))
        }
        assertThrows(IllegalArgumentException::class.java) {
            client.validateRequest(JSONObject().put("requestId", "close_2").put("action", "document_action")
                .put("documentAction", "close").put("tabId", "tab:device:workspace:1")
                .put("expectedRevision", "stale"))
        }
        assertThrows(IllegalArgumentException::class.java) {
            client.validateRequest(JSONObject().put("requestId", "create_2").put("action", "document_action")
                .put("documentAction", "create").put("options", JSONObject().put("background", "yes")))
        }
        assertThrows(IllegalArgumentException::class.java) {
            client.validateRequest(JSONObject().put("requestId", "save_as_2").put("action", "document_action")
                .put("documentAction", "save").put("tabId", "tab:device:workspace:1")
                .put("expectedRevision", revision).put("options", JSONObject().put("saveAs", true)))
        }
    }

    @Test fun acceptsReaderSearchOptionsAndOnlyReviewedRepairIndexShapes() {
        client.validateRequest(JSONObject().put("requestId", "diagrams_1").put("action", "list_diagrams")
            .put("tabId", "tab:device:workspace:1").put("offset", 0).put("limit", 20))
        client.validateRequest(JSONObject().put("requestId", "search_1").put("action", "search_tab")
            .put("tabId", "tab:device:workspace:1").put("query", "needle").put("offset", 4)
            .put("caseSensitive", true).put("wholeWord", false).put("regex", true).put("excludeDiagrams", true))
        client.validateRequest(JSONObject().put("requestId", "latex_1").put("action", "latex_review")
            .put("tabId", "tab:device:workspace:1"))
        client.validateRequest(JSONObject().put("requestId", "latex_2").put("action", "latex_apply")
            .put("tabId", "tab:device:workspace:1").put("expectedRevision", revision)
            .put("repairIndices", org.json.JSONArray().put(0).put(2)))

        assertThrows(IllegalArgumentException::class.java) {
            client.validateRequest(JSONObject().put("requestId", "latex_3").put("action", "latex_apply")
                .put("tabId", "tab:device:workspace:1").put("expectedRevision", revision)
                .put("repairIndices", org.json.JSONArray().put(1).put(1)))
        }
        assertThrows(IllegalArgumentException::class.java) {
            client.validateRequest(JSONObject().put("requestId", "search_2").put("action", "search_tab")
                .put("tabId", "tab:device:workspace:1").put("query", "needle").put("wholeWord", "yes"))
        }
        assertThrows(IllegalArgumentException::class.java) {
            client.validateRequest(JSONObject().put("requestId", "search_3").put("action", "search_tab")
                .put("tabId", "tab:device:workspace:1").put("query", "x".repeat(501)))
        }
    }

    @Test fun validatesBoundedExportChunksAndDocumentOutlineAlias() {
        val chunk = JSONObject().put("requestId", "chunk_1").put("action", "document_action")
            .put("documentAction", "export_chunk").put("jobId", "job_1")
            .put("offset", 3_000_000_000L).put("limit", 524_288)
        client.validateRequest(chunk)
        val optionsJob = JSONObject().put("requestId", "chunk_2").put("action", "document_action")
            .put("documentAction", "export_chunk").put("options", JSONObject().put("jobId", "job_2"))
        client.validateRequest(optionsJob)
        assertEquals("job_2", optionsJob.getString("jobId"))
        client.validateRequest(JSONObject().put("requestId", "outline_1").put("action", "document_action")
            .put("documentAction", "outline").put("tabId", "tab:device:workspace:1").put("heading", "Introduction"))

        listOf(
            JSONObject(chunk.toString()).put("limit", 0),
            JSONObject(chunk.toString()).put("limit", 524_289),
            JSONObject(chunk.toString()).put("offset", -1),
            JSONObject(chunk.toString()).put("path", "/arbitrary/file.pdf"),
        ).forEach { invalid -> assertThrows(IllegalArgumentException::class.java) { client.validateRequest(invalid) } }
    }

    @Test fun conformsToSharedAgentContractManifestBounds() {
        val contract = contractJson()
        val revLen = contract.getJSONObject("revision").getInt("length")
        val ids = contract.getJSONObject("identifiers")
        val exports = contract.getJSONObject("exportFormats")
        val search = contract.getJSONObject("search")
        val mutations = contract.getJSONObject("mutations")
        val viewport = contract.getJSONObject("viewport")
        val reqMax = ids.getInt("requestIdMax"); val jobMax = ids.getInt("jobIdMax")
        val diagPrefix = ids.getString("diagramIdPrefix"); val diagMin = ids.getInt("diagramIdMin"); val diagMax = ids.getInt("diagramIdMax")
        val mixedRev = "aB09".repeat(revLen / 4)

        client.validateRequest(JSONObject().put("requestId", "r".repeat(reqMax)).put("action", "list_tabs"))
        for (badReq in listOf("", "r".repeat(reqMax + 1), "bad id")) assertRejected(JSONObject().put("requestId", badReq).put("action", "list_tabs"))
        client.validateRequest(JSONObject().put("requestId", "job_ok").put("action", "document_action").put("documentAction", "open").put("jobId", "j".repeat(jobMax)))
        for (badJob in listOf("", "j".repeat(jobMax + 1))) assertRejected(JSONObject().put("requestId", "job_bad").put("action", "document_action").put("documentAction", "open").put("jobId", badJob))

        val minDiag = diagPrefix + "x".repeat(diagMin - diagPrefix.length)
        val maxDiag = diagPrefix + "x".repeat(diagMax - diagPrefix.length)
        val badDiagIds = listOf(diagPrefix + "x".repeat(diagMin - diagPrefix.length - 1), diagPrefix + "x".repeat(diagMax - diagPrefix.length + 1), "figure:12345")
        for (diagramAction in listOf("get_diagram", "get_diagram_image", "list_diagrams")) {
            for (validId in listOf(minDiag, maxDiag)) client.validateRequest(JSONObject().put("requestId", "diag_ok").put("action", diagramAction).put("tabId", "tab:1").put("expectedRevision", mixedRev).put("diagramId", validId))
            for (badId in badDiagIds) assertRejected(JSONObject().put("requestId", "diag_bad").put("action", diagramAction).put("tabId", "tab:1").put("expectedRevision", mixedRev).put("diagramId", badId))
        }
        for (badRev in listOf("a".repeat(revLen - 1), "a".repeat(revLen + 1), "g".repeat(revLen))) {
            assertRejected(JSONObject().put("requestId", "rev_bad").put("action", "get_diagram").put("tabId", "tab:1").put("expectedRevision", badRev).put("diagramId", minDiag))
        }

        val liveFormats = exports.getJSONArray("live").strings()
        val createSaveFormats = exports.getJSONArray("createAndSave").strings()
        assertTrue(liveFormats.contains("mdzip"))
        for (fmt in liveFormats) client.validateRequest(JSONObject().put("requestId", "exp_1").put("action", "document_action").put("documentAction", "export").put("tabId", "tab:1").put("options", JSONObject().put("format", fmt).put("archive", fmt == "mdzip")))
        assertRejected(JSONObject().put("requestId", "exp_bad").put("action", "document_action").put("documentAction", "export").put("tabId", "tab:1").put("format", "docx"))
        assertRejected(JSONObject().put("requestId", "arc_bad").put("action", "document_action").put("documentAction", "export").put("tabId", "tab:1").put("options", JSONObject().put("archive", "yes")))
        for (docAct in listOf("create", "save")) {
            for (fmt in createSaveFormats) client.validateRequest(JSONObject().put("requestId", "cs_ok").put("action", "document_action").put("documentAction", docAct).put("tabId", "tab:1").put("expectedRevision", revision).put("format", fmt))
            for (disallowed in liveFormats - createSaveFormats.toSet()) assertRejected(JSONObject().put("requestId", "cs_bad").put("action", "document_action").put("documentAction", docAct).put("tabId", "tab:1").put("expectedRevision", revision).put("format", disallowed))
        }

        val baseSearch = JSONObject().put("requestId", "s_1").put("action", "search_tab").put("tabId", "tab:1")
            .put("query", "q".repeat(search.getInt("queryMaxChars"))).put("limit", search.getInt("limitMax")).put("context", search.getInt("contextMax"))
        search.getJSONArray("booleanFlags").strings().forEach { baseSearch.put(it, true) }
        client.validateRequest(baseSearch)
        client.validateRequest(JSONObject(baseSearch.toString()).put("query", "q".repeat(search.getInt("queryMinChars"))).put("limit", search.getInt("limitMin")).put("context", search.getInt("contextMin")))
        listOf(
            JSONObject(baseSearch.toString()).put("query", ""),
            JSONObject(baseSearch.toString()).put("limit", search.getInt("limitMin") - 1),
            JSONObject(baseSearch.toString()).put("limit", search.getInt("limitMax") + 1),
            JSONObject(baseSearch.toString()).put("context", search.getInt("contextMax") + 1),
            JSONObject(baseSearch.toString()).put(search.getJSONArray("booleanFlags").getString(0), "true"),
        ).forEach(::assertRejected)

        val maxOps = mutations.getInt("maxPatchOperations")
        val op = JSONObject().put("type", "insert").put("line", 1).put("text", "x")
        client.validateRequest(JSONObject().put("requestId", "p_ok").put("action", "patch_tab").put("tabId", "tab:1").put("expectedRevision", revision).put("operations", JSONArray((0 until maxOps).map { op })))
        assertRejected(JSONObject().put("requestId", "p_bad").put("action", "patch_tab").put("tabId", "tab:1").put("expectedRevision", revision).put("operations", JSONArray((0..maxOps).map { op })))
        val maxRepairs = mutations.getInt("repairIndicesMax")
        client.validateRequest(JSONObject().put("requestId", "r_ok").put("action", "latex_apply").put("tabId", "tab:1").put("expectedRevision", revision).put("repairIndices", JSONArray((0 until maxRepairs).toList())))
        for (badCount in listOf(0, maxRepairs + 1)) assertRejected(JSONObject().put("requestId", "r_bad").put("action", "latex_apply").put("tabId", "tab:1").put("expectedRevision", revision).put("repairIndices", JSONArray((0 until badCount).toList())))
        for (fmt in viewport.getJSONArray("imageFormats").strings()) {
            for (w in listOf(viewport.getInt("rpcMinWidth"), viewport.getInt("minWidth"), viewport.getInt("maxWidth"))) client.validateRequest(JSONObject().put("requestId", "v_ok").put("action", "render_tab").put("tabId", "tab:1").put("imageFormat", fmt).put("width", w))
        }
        for (badWidth in listOf(0, viewport.getInt("maxWidth") + 1)) assertRejected(JSONObject().put("requestId", "v_bad").put("action", "render_tab").put("tabId", "tab:1").put("width", badWidth))
    }

    @Test fun parameterValidationFailuresSendErrorRepliesKeepSocketOpenAndClearActiveRequests() {
        val handled = mutableListOf<JSONObject>()
        val (relay, socket, listener) = connectTestSession { req, reply -> handled += req; reply(JSONObject().put("exported", req.optString("format")), null) }
        try {
            for (index in 1..10) {
                val frame = if (index % 2 == 1) JSONObject().put("type", "request").put("requestId", "bad_exp_$index").put("deviceId", "device-1").put("action", "document_action").put("documentAction", "export").put("tabId", "tab:1").put("format", "docx")
                else JSONObject().put("type", "request").put("requestId", "bad_diag_$index").put("deviceId", "device-1").put("action", "get_diagram").put("tabId", "tab:1").put("expectedRevision", revision).put("diagramId", "bad")
                listener.onMessage(socket, frame.toString())
            }
            assertNull(socket.closedCode); assertTrue(handled.isEmpty()); assertEquals(10, socket.sent.size)
            socket.sent.forEachIndexed { i, raw ->
                val reply = JSONObject(raw)
                assertEquals("reply", reply.getString("type"))
                assertEquals(if ((i + 1) % 2 == 1) "bad_exp_${i + 1}" else "bad_diag_${i + 1}", reply.getString("requestId"))
                assertTrue(reply.getString("error").isNotBlank() && !reply.getString("error").contains("Too many"))
                assertFalse(reply.has("result"))
            }
            listener.onMessage(socket, JSONObject().put("type", "request").put("requestId", "valid_mdzip").put("deviceId", "device-1")
                .put("action", "document_action").put("documentAction", "export").put("tabId", "tab:1")
                .put("options", JSONObject().put("format", "mdzip").put("archive", true)).toString())
            Shadows.shadowOf(Looper.getMainLooper()).idle()
            assertNull(socket.closedCode); assertEquals(1, handled.size)
            val validReply = JSONObject(socket.sent.last())
            assertEquals("valid_mdzip", validReply.getString("requestId"))
            assertEquals("mdzip", validReply.getJSONObject("result").getString("exported"))
        } finally { relay.disconnect() }
    }

    @Test fun envelopeViolationsCloseWebSocketWithPolicyCode1008() {
        for (badFrame in listOf(
            JSONObject().put("type", "request").put("requestId", "wrong_dev").put("deviceId", "other-device").put("action", "list_tabs"),
            JSONObject().put("type", "request").put("requestId", "bad_action").put("deviceId", "device-1").put("action", "unsupported_action"),
        )) {
            val (relay, socket, listener) = connectTestSession()
            listener.onMessage(socket, badFrame.toString())
            assertEquals(1008, socket.closedCode); assertTrue(socket.sent.isEmpty()); relay.disconnect()
        }
    }

    @Test fun ignoresReplacedSocketLateCallbacksAndCompletionsWhileReplacementRemainsOnline() {
        val h = FakeRelayHarness()
        val pending = CopyOnWriteArrayList<Pair<String, (Any?, String?) -> Unit>>()
        fun rpc(id: String) = JSONObject().put("type", "request").put("requestId", id).put("deviceId", h.config.deviceId).put("action", "list_tabs").toString()
        try {
            h.relay.connect(h.config) { req, reply -> pending += req.getString("requestId") to reply }
            val a = h.awaitSocket().also(h::register)
            val (socketA, listenerA) = a
            listenerA.onMessage(socketA, rpc("shared_1")); listenerA.onMessage(socketA, rpc("shared_2"))
            Shadows.shadowOf(Looper.getMainLooper()).idle()
            val (_, replyA1) = pending[0]; val (_, replyA2) = pending[1]

            listenerA.onFailure(socketA, IOException("transient drop"), null)
            Shadows.shadowOf(Looper.getMainLooper()).idleFor(2, TimeUnit.SECONDS)
            val b = h.awaitSocket(); val (socketB, listenerB) = b
            assertEquals(AgentRelayClient.State.CONNECTING, h.relay.currentState())
            listenerA.onMessage(socketA, h.registeredFrame); Shadows.shadowOf(Looper.getMainLooper()).idle()
            assertEquals(AgentRelayClient.State.CONNECTING, h.relay.currentState())
            h.register(b); assertEquals(AgentRelayClient.State.CONNECTED, h.relay.currentState())
            listenerB.onMessage(socketB, rpc("shared_1")); listenerB.onMessage(socketB, rpc("shared_2"))
            Shadows.shadowOf(Looper.getMainLooper()).idle()
            val (_, replyB1) = pending[2]; val (_, replyB2) = pending[3]
            val stateCountOnB = h.states.size

            listenerA.onMessage(socketA, h.registeredFrame); listenerA.onMessage(socketA, rpc("late_from_a"))
            listenerA.onClosed(socketA, 1000, "late close"); listenerA.onFailure(socketA, IOException("late failure"), null)
            replyA1(JSONObject().put("from", "A1"), null); replyA2(JSONObject().put("from", "A2"), null)
            Shadows.shadowOf(Looper.getMainLooper()).idleFor(2, TimeUnit.MINUTES)
            assertEquals(AgentRelayClient.State.CONNECTED, h.relay.currentState())
            assertEquals(stateCountOnB, h.states.size)
            assertEquals(2, h.enrolls.get()); assertEquals(2, h.sockets.size); assertEquals(4, pending.size)
            assertNull(socketB.closedCode); assertTrue(socketA.sent.isEmpty() && socketB.sent.isEmpty())

            replyB1(JSONObject().put("from", "B1"), null)
            assertEquals("B1", JSONObject(socketB.sent.single()).getJSONObject("result").getString("from"))
            assertNull(socketB.closedCode); assertEquals(AgentRelayClient.State.CONNECTED, h.relay.currentState())
            listenerB.onMessage(socketB, rpc("shared_2"))
            assertEquals(1008, socketB.closedCode)

            h.relay.connect(h.config) { req, reply -> pending += req.getString("requestId") to reply }
            val c = h.awaitSocket().also(h::register); val (socketC, _) = c
            assertEquals(AgentRelayClient.State.CONNECTED, h.relay.currentState())
            listenerB.onMessage(socketB, h.registeredFrame); listenerB.onClosed(socketB, 1008, "late close B")
            replyB2(JSONObject().put("from", "B2"), null)
            Shadows.shadowOf(Looper.getMainLooper()).idleFor(2, TimeUnit.MINUTES)
            assertEquals(AgentRelayClient.State.CONNECTED, h.relay.currentState())
            assertEquals(3, h.enrolls.get()); assertNull(socketC.closedCode); assertTrue(socketC.sent.isEmpty())
        } finally { h.relay.disconnect() }
    }

    @Test fun enforces150CapOnAttachWhilePreserving159CompatKeysForSourceAndReplace() {
        val maxNew = "assets/${"a".repeat(146)}.svg"
        val compat159 = "assets/${"a".repeat(155)}.svg"
        val over160 = "assets/${"a".repeat(156)}.svg"
        val assetSha = "f".repeat(64)

        client.validateRequest(request("attach").put("assetName", maxNew))
        assertThrows(IllegalArgumentException::class.java) {
            client.validateRequest(request("attach").put("assetName", compat159))
        }

        for (validExisting in listOf(maxNew, compat159, assetSha)) {
            client.validateRequest(request("source").put("body", "").put("assetName", validExisting))
            client.validateRequest(
                JSONObject()
                    .put("requestId", "replace_1")
                    .put("action", "replace_tab_asset")
                    .put("tabId", "tab:device:workspace:1")
                    .put("expectedRevision", revision)
                    .put("assetName", validExisting)
                    .put("assetPath", "updated.svg")
            )
        }

        for (invalid in listOf(over160, "assets/.", "assets/..", "../escape.svg")) {
            assertThrows(IllegalArgumentException::class.java) {
                client.validateRequest(request("source").put("body", "").put("assetName", invalid))
            }
            assertThrows(IllegalArgumentException::class.java) {
                client.validateRequest(
                    JSONObject()
                        .put("requestId", "replace_2")
                        .put("action", "replace_tab_asset")
                        .put("tabId", "tab:device:workspace:1")
                        .put("expectedRevision", revision)
                        .put("assetName", invalid)
                        .put("assetPath", "updated.svg")
                )
            }
        }
    }
}
