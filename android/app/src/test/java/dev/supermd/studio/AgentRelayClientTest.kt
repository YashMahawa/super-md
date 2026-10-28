package dev.supermd.studio

import android.util.Base64
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class AgentRelayClientTest {
    private val client = AgentRelayClient()
    private val revision = "a".repeat(64)
    private val svg = "<svg xmlns='http://www.w3.org/2000/svg'/>".toByteArray()

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
}
