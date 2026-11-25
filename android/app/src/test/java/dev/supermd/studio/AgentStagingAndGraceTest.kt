package dev.supermd.studio

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.ProviderInfo
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.runBlocking
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.Timeout
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowContentResolver
import org.robolectric.shadows.ShadowLooper
import java.io.File
import java.nio.file.Files
import java.time.Duration
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class AgentStagingAndGraceTest {
    private lateinit var app: android.app.Application
    private lateinit var root: File
    private lateinit var provider: CountingDocumentProvider
    private lateinit var authority: String
    private lateinit var activeUri: Uri
    private lateinit var inactiveUri: Uri
    private var previousAutosave: Boolean? = null
    private val workspaceKeys = mutableListOf<String>()
    private val viewModels = mutableListOf<ViewModelStore>()

    @Before fun setUp() {
        app = RuntimeEnvironment.getApplication()
        root = Files.createTempDirectory("agent-staging-test").toFile()
        authority = "dev.supermd.test.staging.${System.nanoTime()}"
        activeUri = DocumentsContract.buildDocumentUri(authority, "folder/Active.md")
        inactiveUri = DocumentsContract.buildDocumentUri(authority, "folder/Inactive.md")
        provider = CountingDocumentProvider(root).also { it.attach(app, authority) }
        ShadowContentResolver.registerProviderInternal(authority, provider)
        app.grantUriPermission(app.packageName, activeUri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        app.grantUriPermission(app.packageName, inactiveUri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        val prefs = app.getSharedPreferences("studio", Context.MODE_PRIVATE)
        previousAutosave = prefs.getBoolean("autosave", true)
        prefs.edit().putBoolean("autosave", true).commit()
    }

    @After fun tearDown() {
        viewModels.forEach { it.clear() }
        app.getSharedPreferences("studio", Context.MODE_PRIVATE).edit()
            .putBoolean("autosave", previousAutosave ?: true).commit()
        app.getSharedPreferences("agent_access", Context.MODE_PRIVATE).edit().clear().commit()
        ShadowContentResolver.reset()
        root.deleteRecursively()
        workspaceKeys.forEach {
            File(app.filesDir, "workspaces/$it.json").delete()
            File(app.filesDir, "workspaces/$it").deleteRecursively()
        }
    }

    private fun newModel(): Pair<String, StudioViewModel> {
        val key = UUID.randomUUID().toString()
        workspaceKeys += key
        val model = StudioViewModel(app, key)
        model.readerFlushRequester = { true }
        val store = ViewModelStore().apply {
            val put = ViewModelStore::class.java.getDeclaredMethod("put", String::class.java, androidx.lifecycle.ViewModel::class.java)
            put.isAccessible = true
            put.invoke(this, key, model)
        }
        viewModels += store
        return key to model
    }

    private fun await(condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 5_000
        while (!condition() && System.currentTimeMillis() < deadline) {
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(10)
        }
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue("Timed out waiting for condition", condition())
    }

    @Test fun inactiveTabPatchStagesRecoveryImmediatelyPausesAutosaveUntilActivatedAndNeverStealsFocus() {
        val (workspaceKey, model) = newModel()
        model.open(inactiveUri)
        await { model.state.value.tabs.any { it.uri == inactiveUri.toString() } }
        val inactiveId = model.state.value.tabs.single { it.uri == inactiveUri.toString() }.id

        model.open(activeUri)
        await { model.state.value.tabs.any { it.uri == activeUri.toString() } && model.state.value.active.uri == activeUri.toString() }
        val activeId = model.state.value.active.id
        assertEquals(0, provider.writesFor("folder/Inactive.md"))

        val baseContent = provider.readText("folder/Inactive.md")
        val patchedContent = baseContent.replace("Original background body.", "Agent staged background body.")
        val baseRev = agentContentRevision(baseContent)
        val patchedRev = agentContentRevision(patchedContent)

        val startedAt = System.nanoTime()
        runBlocking {
            model.commitAgentSnapshotPatch(inactiveId, baseRev, patchedContent, patchedRev)
        }
        val elapsedMillis = (System.nanoTime() - startedAt) / 1_000_000.0
        assertTrue("Inactive recovery staging took ${elapsedMillis}ms (> 1200ms)", elapsedMillis < 1200.0)

        // Focus/active tab must NOT change when an inactive tab is edited
        assertEquals(activeId, model.state.value.activeId)
        assertEquals(inactiveId, model.state.value.agentJumpTabId)

        val stagedNote = model.state.value.tabs.single { it.id == inactiveId }
        assertTrue(stagedNote.agentStaged)
        assertTrue(stagedNote.agentUnreviewed)
        assertEquals(1, stagedNote.agentEdits.size)
        assertEquals(baseContent, stagedNote.agentEdits.single().before)
        assertEquals(patchedContent, stagedNote.agentEdits.single().after)

        // Recovery snapshot on disk already contains the staged draft, edits, and jump tab ID
        val recoveryFile = File(app.filesDir, "workspaces/$workspaceKey.json")
        assertTrue(recoveryFile.isFile)
        val recovered = recoveryFile.bufferedReader().use { NoteRecovery.read(it, StudioState()) }
        assertEquals(inactiveId, recovered.agentJumpTabId)
        val recoveredNote = recovered.tabs.single { it.id == inactiveId }
        assertEquals(patchedContent, recoveredNote.content)
        assertTrue(recoveredNote.agentStaged)
        assertTrue(recoveredNote.agentUnreviewed)
        assertEquals(1, recoveredNote.agentEdits.size)

        // Even after advancing virtual looper time well past the 900ms autosave debounce, zero automatic disk writes happen!
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(1500))
        Thread.sleep(50)
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals("Automatic disk autosave must stay paused while staged", 0, provider.writesFor("folder/Inactive.md"))
        assertEquals(baseContent, provider.readText("folder/Inactive.md"))

        // Activating (or clicking Jump to) the tab clears agentStaged & agentJumpTabId and resumes autosave!
        model.select(inactiveId)
        await { model.state.value.activeId == inactiveId && !model.state.value.tabs.single { it.id == inactiveId }.agentStaged }
        assertNull(model.state.value.agentJumpTabId)
        // agentUnreviewed remains true so the in-note Undo banner displays upon opening the tab
        assertTrue(model.state.value.tabs.single { it.id == inactiveId }.agentUnreviewed)

        // Advance virtual looper past the 900ms autosave delay, then wait for IO write completion
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(1200))
        val writeDeadline = System.currentTimeMillis() + 3_000
        while (provider.writesFor("folder/Inactive.md") == 0 && System.currentTimeMillis() < writeDeadline) {
            Thread.sleep(25)
            shadowOf(Looper.getMainLooper()).idle()
        }
        assertEquals(1, provider.writesFor("folder/Inactive.md"))
        assertEquals(patchedContent, provider.readText("folder/Inactive.md"))

        // Dismissing the in-note banner clears agentUnreviewed
        model.dismissAgentBanner(inactiveId)
        assertFalse(model.state.value.tabs.single { it.id == inactiveId }.agentUnreviewed)
    }

    @Test fun failedInactiveRecoveryWriteKeepsStateConsistentPreservesPriorSnapshotAndAllowsSameRevisionRetry() {
        val (workspaceKey, model) = newModel()
        model.open(inactiveUri)
        await { model.state.value.tabs.any { it.uri == inactiveUri.toString() } }
        val inactiveId = model.state.value.tabs.single { it.uri == inactiveUri.toString() }.id

        model.open(activeUri)
        await { model.state.value.tabs.any { it.uri == activeUri.toString() } && model.state.value.active.uri == activeUri.toString() }
        val activeId = model.state.value.active.id
        assertEquals(0, provider.writesFor("folder/Inactive.md"))

        val baseContent = provider.readText("folder/Inactive.md")
        val v1Content = baseContent.replace("Original background body.", "First staged background body.")
        val v2Content = v1Content.replace("First staged background body.", "Second staged background body.")
        val baseRev = agentContentRevision(baseContent)
        val v1Rev = agentContentRevision(v1Content)
        val v2Rev = agentContentRevision(v2Content)

        // 1. Fail the initial stage when no recovery file can be replaced on disk
        val recoveryFile = File(app.filesDir, "workspaces/$workspaceKey.json")
        recoveryFile.delete()
        assertTrue(recoveryFile.mkdirs())
        File(recoveryFile, "blocker").writeText("locked")

        val initialFailure = assertThrows(IllegalStateException::class.java) {
            runBlocking {
                model.commitAgentSnapshotPatch(inactiveId, baseRev, v1Content, v1Rev)
            }
        }
        assertTrue(initialFailure.message.orEmpty().contains("retry", ignoreCase = true))
        assertFalse(initialFailure.message.orEmpty().contains("revision conflict", ignoreCase = true))
        assertTrue(
            "Temporary recovery staging files must be cleaned up on failure",
            recoveryFile.parentFile!!.listFiles().orEmpty().none { it.name.startsWith("${recoveryFile.name}.") },
        )

        // In-memory state, focus, jump indicator, and backing file stay untouched
        assertEquals(activeId, model.state.value.activeId)
        assertNull(model.state.value.agentJumpTabId)
        val unchangedNote = model.state.value.tabs.single { it.id == inactiveId }
        assertEquals(baseContent, unchangedNote.content)
        assertEquals(baseRev, agentContentRevision(unchangedNote.content))
        assertFalse(unchangedNote.agentStaged)
        assertFalse(unchangedNote.agentUnreviewed)
        assertTrue(unchangedNote.agentEdits.isEmpty())
        assertEquals(0, provider.writesFor("folder/Inactive.md"))

        // Clear the filesystem blocker and retry with the exact same baseRev -> succeeds!
        assertTrue(recoveryFile.deleteRecursively())
        runBlocking {
            model.commitAgentSnapshotPatch(inactiveId, baseRev, v1Content, v1Rev)
        }

        assertTrue(recoveryFile.isFile)
        val v1Note = model.state.value.tabs.single { it.id == inactiveId }
        assertEquals(v1Content, v1Note.content)
        assertTrue(v1Note.agentStaged)
        assertTrue(v1Note.agentUnreviewed)
        assertEquals(1, v1Note.agentEdits.size)
        assertEquals(baseContent, v1Note.agentEdits.single().before)
        assertEquals(v1Content, v1Note.agentEdits.single().after)
        assertEquals(inactiveId, model.state.value.agentJumpTabId)

        val recoveredAfterV1 = recoveryFile.bufferedReader().use { NoteRecovery.read(it, StudioState()) }
        val recoveredV1Note = recoveredAfterV1.tabs.single { it.id == inactiveId }
        assertEquals(v1Content, recoveredV1Note.content)
        assertTrue(recoveredV1Note.agentStaged)
        assertEquals(1, recoveredV1Note.agentEdits.size)

        // 2. Fail a subsequent stage (v1 -> v2) while durable v1 snapshot already exists on disk
        model.recoverySnapshotWriter = { _, _ -> throw java.io.IOException("Simulated disk full") }
        val secondFailure = assertThrows(IllegalStateException::class.java) {
            runBlocking {
                model.commitAgentSnapshotPatch(inactiveId, v1Rev, v2Content, v2Rev)
            }
        }
        assertTrue(secondFailure.message.orEmpty().contains("retry", ignoreCase = true))
        assertFalse(secondFailure.message.orEmpty().contains("revision conflict", ignoreCase = true))

        // Both durable recovery snapshot and in-memory state remain at v1
        val afterSecondFailureNote = model.state.value.tabs.single { it.id == inactiveId }
        assertEquals(v1Content, afterSecondFailureNote.content)
        assertEquals(v1Rev, agentContentRevision(afterSecondFailureNote.content))
        assertTrue(afterSecondFailureNote.agentStaged)
        assertTrue(afterSecondFailureNote.agentUnreviewed)
        assertEquals(1, afterSecondFailureNote.agentEdits.size)
        assertEquals(inactiveId, model.state.value.agentJumpTabId)

        val durableStillV1 = recoveryFile.bufferedReader().use { NoteRecovery.read(it, StudioState()) }
        val durableV1Note = durableStillV1.tabs.single { it.id == inactiveId }
        assertEquals(v1Content, durableV1Note.content)
        assertTrue(durableV1Note.agentStaged)
        assertEquals(1, durableV1Note.agentEdits.size)

        // Restore writer and retry v1 -> v2 with the same v1Rev -> commits cleanly!
        model.recoverySnapshotWriter = NoteRecovery::write
        runBlocking {
            model.commitAgentSnapshotPatch(inactiveId, v1Rev, v2Content, v2Rev)
        }
        val v2Note = model.state.value.tabs.single { it.id == inactiveId }
        assertEquals(v2Content, v2Note.content)
        assertTrue(v2Note.agentStaged)
        assertTrue(v2Note.agentUnreviewed)
        assertEquals(2, v2Note.agentEdits.size)
        assertEquals(v1Content, v2Note.agentEdits[1].before)
        assertEquals(v2Content, v2Note.agentEdits[1].after)
        assertTrue(v2Note.agentEdits[1].seq > v2Note.agentEdits[0].seq)

        val durableV2 = recoveryFile.bufferedReader().use { NoteRecovery.read(it, StudioState()) }
        val durableV2Note = durableV2.tabs.single { it.id == inactiveId }
        assertEquals(v2Content, durableV2Note.content)
        assertTrue(durableV2Note.agentStaged)
        assertEquals(2, durableV2Note.agentEdits.size)
        assertEquals(0, provider.writesFor("folder/Inactive.md"))
    }

    @Test fun mainActivityInactivePatchTabReportsRecoverableFailureWhenRecoveryWriteFailsAndSucceedsOnRetry() {
        val workspaceKey = UUID.randomUUID().toString()
        workspaceKeys += workspaceKey
        val config = AgentAccessConfig(
            serverOrigin = "https://relay.example.test",
            groupId = "group-durability-1",
            deviceId = "device-durability-1",
            deviceKey = "device-secret-1",
            pairingKey = "A".repeat(43),
            connectorKey = "B".repeat(43),
            displayName = "Pixel Durability Test",
            platform = "android",
        )
        val harness = FakeRelayTransport(config)
        AgentAccessState(app).setEnabled(true)

        val intent = Intent(app, MainActivity::class.java).putExtra("workspace", workspaceKey)
        val controller = Robolectric.buildActivity(MainActivity::class.java, intent)
        val activity = controller.get()
        activity.agentConfigOverrideForTest = config
        activity.agentRelayCallFactoryForTest = harness.callFactory
        activity.agentRelayWebSocketFactoryForTest = harness.webSocketFactory

        val bridgeScope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.Main.immediate)
        try {
            controller.create().start().resume()
            shadowOf(Looper.getMainLooper()).idle()
            harness.sendServerFrame(JSONObject().put("type", "registered").put("groupId", config.groupId).put("deviceId", config.deviceId))
            shadowOf(Looper.getMainLooper()).idle()
            assertEquals(AgentRelayClient.State.CONNECTED, activity.agentRelayState)

            val model = androidx.lifecycle.ViewModelProvider(activity)[StudioViewModel::class.java]
            model.readerFlushRequester = { true }
            val testWebView = android.webkit.WebView(activity)
            activity.setAgentRequestHandlers(
                bridge = bridge@{ incoming, reply ->
                    val request = JSONObject(incoming.toString())
                    val target = checkNotNull(activity.localAgentTabId(request.getString("tabId")))
                    request.put("tabId", target)
                    val snapshot = checkNotNull(model.state.value.tabs.firstOrNull { it.id == target })
                    handleInactiveTabSnapshotRequest(
                        activity = activity,
                        model = model,
                        scope = bridgeScope,
                        web = testWebView,
                        request = request,
                        target = target,
                        snapshot = snapshot,
                        canonicalTabId = { note -> "tab:${config.deviceId}:$workspaceKey:${note.id}" },
                        reply = reply,
                    )
                },
                ui = null,
            )
            model.open(inactiveUri)
            await { model.state.value.tabs.any { it.uri == inactiveUri.toString() } }
            val inactiveId = model.state.value.tabs.single { it.uri == inactiveUri.toString() }.id

            model.open(activeUri)
            await { model.state.value.tabs.any { it.uri == activeUri.toString() } && model.state.value.active.uri == activeUri.toString() }
            val activeId = model.state.value.active.id

            val baseContent = provider.readText("folder/Inactive.md")
            val patchedContent = baseContent.replace("Original background body.", "Patched via MainActivity bridge.")
            val baseRev = agentContentRevision(baseContent)
            val patchedRev = agentContentRevision(patchedContent)
            val canonicalTabId = "tab:${config.deviceId}:$workspaceKey:$inactiveId"
            val operations = org.json.JSONArray().put(
                JSONObject()
                    .put("type", "replace")
                    .put("oldText", "Original background body.")
                    .put("newText", "Patched via MainActivity bridge."),
            )

            fun computedPatchResult() = JSONObject()
                .put("tabId", inactiveId)
                .put("baseRevision", baseRev)
                .put("baseSourceLength", activity.agentSourceLength(baseContent))
                .put("revision", patchedRev)
                .put("sourceLength", activity.agentSourceLength(patchedContent))
                .put("patchedContent", patchedContent)
                .put("changed", true)

            // Inject recovery write failure and dispatch inactive-tab patch_tab over the real MainActivity handler
            model.recoverySnapshotWriter = { _, _ -> throw java.io.IOException("Simulated recovery write failure") }
            harness.sentFrames.clear()
            harness.sendServerFrame(
                JSONObject()
                    .put("type", "request")
                    .put("requestId", "patch_fail_1")
                    .put("deviceId", config.deviceId)
                    .put("action", "patch_tab")
                    .put("tabId", canonicalTabId)
                    .put("expectedRevision", baseRev)
                    .put("operations", operations),
            )
            shadowOf(Looper.getMainLooper()).idle()
            activity.deliverAgentReply("patch_fail_1", computedPatchResult(), null)
            await { harness.sentFrames.isNotEmpty() }

            val failedReply = JSONObject(harness.sentFrames.single())
            assertEquals("reply", failedReply.getString("type"))
            assertEquals("patch_fail_1", failedReply.getString("requestId"))
            assertTrue("Failed recovery write must not acknowledge result", failedReply.isNull("result"))
            val errorText = failedReply.getString("error")
            assertTrue("Caller must receive a recoverable error message, got: $errorText", errorText.contains("retry", ignoreCase = true))
            assertFalse("Recoverable storage failure must not masquerade as a revision conflict: $errorText", errorText.trimStart().startsWith("{"))

            assertEquals(activeId, model.state.value.activeId)
            assertNull(model.state.value.agentJumpTabId)
            val afterFailNote = model.state.value.tabs.single { it.id == inactiveId }
            assertEquals(baseContent, afterFailNote.content)
            assertFalse(afterFailNote.agentStaged)
            assertFalse(afterFailNote.agentUnreviewed)
            assertTrue(afterFailNote.agentEdits.isEmpty())
            assertEquals(0, provider.writesFor("folder/Inactive.md"))

            // Restore recovery writer and retry the exact same patch_tab request with baseRev
            model.recoverySnapshotWriter = NoteRecovery::write
            harness.sentFrames.clear()
            harness.sendServerFrame(
                JSONObject()
                    .put("type", "request")
                    .put("requestId", "patch_retry_2")
                    .put("deviceId", config.deviceId)
                    .put("action", "patch_tab")
                    .put("tabId", canonicalTabId)
                    .put("expectedRevision", baseRev)
                    .put("operations", operations),
            )
            shadowOf(Looper.getMainLooper()).idle()
            activity.deliverAgentReply("patch_retry_2", computedPatchResult(), null)
            await { harness.sentFrames.isNotEmpty() }

            val okReply = JSONObject(harness.sentFrames.single())
            assertEquals("reply", okReply.getString("type"))
            assertEquals("patch_retry_2", okReply.getString("requestId"))
            assertTrue("Retry should succeed without error, got: $okReply", okReply.isNull("error"))
            val resultObj = okReply.getJSONObject("result")
            assertEquals(canonicalTabId, resultObj.getString("tabId"))
            assertEquals(patchedRev, resultObj.getString("revision"))
            assertFalse("Internal patchedContent must be stripped from reply", resultObj.has("patchedContent"))

            val recoveryFile = File(app.filesDir, "workspaces/$workspaceKey.json")
            assertTrue(recoveryFile.isFile)
            val recovered = recoveryFile.bufferedReader().use { NoteRecovery.read(it, StudioState()) }
            val recoveredNote = recovered.tabs.single { it.id == inactiveId }
            assertEquals(patchedContent, recoveredNote.content)
            assertTrue(recoveredNote.agentStaged)
            assertTrue(recoveredNote.agentUnreviewed)
            assertEquals(1, recoveredNote.agentEdits.size)
            assertEquals(0, provider.writesFor("folder/Inactive.md"))
        } finally {
            bridgeScope.coroutineContext[kotlinx.coroutines.Job]?.cancel()
            runCatching { controller.destroy() }
            shadowOf(Looper.getMainLooper()).idle()
        }
    }

    @Test fun enforceSixtyStepHistoryCapAndTwoMiBSnapshotGuard() {
        var steps = emptyList<AgentEditStep>()
        for (seq in 1L..65L) {
            steps = appendAgentEditSteps(steps, seq, "before-$seq", "after-$seq")
        }
        assertEquals(MAX_AGENT_EDIT_STEPS, steps.size)
        assertEquals(6L, steps.first().seq)
        assertEquals(65L, steps.last().seq)

        // Single large edit within 2 MiB stays intact while older steps trim under 2 MiB budget
        val chunk = "x".repeat(700_000)
        var largeSteps = emptyList<AgentEditStep>()
        largeSteps = appendAgentEditSteps(largeSteps, 1L, chunk, chunk + "1")
        largeSteps = appendAgentEditSteps(largeSteps, 2L, chunk + "1", chunk + "2")
        assertEquals("Combined steps exceeding 2 MiB trim oldest while preserving latest step", 1, largeSteps.size)
        assertEquals(2L, largeSteps.single().seq)

        // Oversized (> 2 MiB) inactive snapshot patch is rejected
        val (_, model) = newModel()
        val tab = model.state.value.active
        val oversized = "a".repeat(2 * 1024 * 1024 + 16)
        assertThrows(IllegalArgumentException::class.java) {
            runBlocking {
                model.commitAgentSnapshotPatch(
                    tab.id,
                    agentContentRevision(tab.content),
                    oversized,
                    agentContentRevision(oversized),
                )
            }
        }
    }

    @Test fun relayClientTracksRetryingAndMainActivityKeepsThreeMinuteBackgroundGraceWindow() {
        val workspaceKey = UUID.randomUUID().toString()
        workspaceKeys += workspaceKey
        val config = AgentAccessConfig(
            serverOrigin = "https://relay.example.test",
            groupId = "group-grace-1",
            deviceId = "device-grace-1",
            deviceKey = "device-secret-1",
            pairingKey = "A".repeat(43),
            connectorKey = "B".repeat(43),
            displayName = "Pixel Test",
            platform = "android",
        )
        val harness = FakeRelayTransport(config)
        AgentAccessState(app).setEnabled(true)

        val intent = Intent(app, MainActivity::class.java).putExtra("workspace", workspaceKey)
        val controller = Robolectric.buildActivity(MainActivity::class.java, intent)
        val activity = controller.get()
        activity.agentConfigOverrideForTest = config
        activity.agentRelayCallFactoryForTest = harness.callFactory
        activity.agentRelayWebSocketFactoryForTest = harness.webSocketFactory

        try {
            assertEquals("Default grace window must be 3 minutes (180,000 ms)", 180_000L, activity.agentBackgroundGraceMillis)

            assertFalse("Pill hidden when agent access disabled and disconnected",
                resolveAgentStatusPillUi(false, AgentRelayClient.State.DISCONNECTED, false).visible)

            controller.create().start().resume()
            shadowOf(Looper.getMainLooper()).idle()

            assertTrue(activity.agentAccessEnabled)
            assertEquals(AgentRelayClient.State.CONNECTING, activity.agentRelayState)
            assertFalse(activity.agentRelayRetrying)
            assertEquals(
                AgentStatusPillUi(true, "AI connecting…", "connecting"),
                resolveAgentStatusPillUi(activity.agentAccessEnabled, activity.agentRelayState, activity.agentRelayRetrying),
            )

            // Relay confirms registration -> CONNECTED
            harness.sendServerFrame(JSONObject().put("type", "registered").put("groupId", config.groupId).put("deviceId", config.deviceId))
            shadowOf(Looper.getMainLooper()).idle()
            assertEquals(AgentRelayClient.State.CONNECTED, activity.agentRelayState)
            assertFalse(activity.agentRelayRetrying)
            assertEquals(
                AgentStatusPillUi(true, "AI connected", "connected"),
                resolveAgentStatusPillUi(activity.agentAccessEnabled, activity.agentRelayState, activity.agentRelayRetrying),
            )

            // Simulate transient WebSocket drop -> immediately enters retrying state
            harness.failCurrentSocket()
            shadowOf(Looper.getMainLooper()).idle()
            assertEquals(AgentRelayClient.State.DISCONNECTED, activity.agentRelayState)
            assertTrue("Top-bar status must reflect retrying immediately on transient drop", activity.agentRelayRetrying)
            assertEquals(
                AgentStatusPillUi(true, "AI retrying…", "retrying"),
                resolveAgentStatusPillUi(activity.agentAccessEnabled, activity.agentRelayState, activity.agentRelayRetrying),
            )

            // Advance past backoff so reconnect completes and registers again
            ShadowLooper.idleMainLooper(5, java.util.concurrent.TimeUnit.SECONDS)
            harness.sendServerFrame(JSONObject().put("type", "registered").put("groupId", config.groupId).put("deviceId", config.deviceId))
            shadowOf(Looper.getMainLooper()).idle()
            assertEquals(AgentRelayClient.State.CONNECTED, activity.agentRelayState)
            assertFalse(activity.agentRelayRetrying)

            // Install a request handler so we can verify incoming relay requests succeed while backgrounded!
            activity.setAgentRequestHandlers(
                bridge = { request, reply ->
                    reply(JSONObject().put("handledWhileStopped", true).put("echoAction", request.optString("action")), null)
                },
                ui = null,
            )

            // Background the Activity (onPause -> onStop): relay MUST stay connected for the 3-minute grace window!
            controller.pause().stop()
            shadowOf(Looper.getMainLooper()).idle()
            assertEquals("Relay must stay connected on onStop during grace window", AgentRelayClient.State.CONNECTED, activity.agentRelayState)
            assertTrue("Grace timer lease must keep WebView JS timers alive while stopped", ReaderTimerOwners.process.startedOwnerCount() >= 1)

            // Advance 2 minutes into background grace window and send an incoming relay request!
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMinutes(2))
            assertEquals(AgentRelayClient.State.CONNECTED, activity.agentRelayState)

            harness.sentFrames.clear()
            harness.sendServerFrame(
                JSONObject()
                    .put("type", "request")
                    .put("requestId", "bg_req_1")
                    .put("deviceId", config.deviceId)
                    .put("action", "list_tabs"),
            )
            shadowOf(Looper.getMainLooper()).idle()
            assertEquals("Incoming agent request must complete during background grace window", 1, harness.sentFrames.size)
            val replyJson = JSONObject(harness.sentFrames.single())
            assertEquals("reply", replyJson.getString("type"))
            assertEquals("bg_req_1", replyJson.getString("requestId"))
            assertTrue(replyJson.getJSONObject("result").getBoolean("handledWhileStopped"))

            // Returning to foreground before 3 minutes cancels the pending disconnect!
            controller.restart().start().resume()
            shadowOf(Looper.getMainLooper()).idle()
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMinutes(2))
            assertEquals("Foregrounding before 3 minutes must cancel the scheduled grace disconnect", AgentRelayClient.State.CONNECTED, activity.agentRelayState)

            // Background again and stay backgrounded past the full 3-minute grace window
            controller.pause().stop()
            shadowOf(Looper.getMainLooper()).idle()
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(179))
            assertEquals("Still connected at 2m59s", AgentRelayClient.State.CONNECTED, activity.agentRelayState)

            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2))
            assertEquals("Relay must disconnect cleanly at 3 minutes if still backgrounded", AgentRelayClient.State.DISCONNECTED, activity.agentRelayState)
            assertEquals(
                AgentStatusPillUi(true, "AI offline", "offline"),
                resolveAgentStatusPillUi(activity.agentAccessEnabled, activity.agentRelayState, activity.agentRelayRetrying),
            )
            assertEquals("Grace timer lease must release on disconnect", 0, ReaderTimerOwners.process.startedOwnerCount())
            assertTrue("WebSocket close(1000) should have been invoked", harness.closedCodes.contains(1000))
        } finally {
            runCatching { controller.destroy() }
            shadowOf(Looper.getMainLooper()).idle()
        }
    }
}

private class FakeRelayTransport(private val config: AgentAccessConfig) {
    val sentFrames = CopyOnWriteArrayList<String>()
    val closedCodes = CopyOnWriteArrayList<Int>()
    @Volatile private var latestListener: WebSocketListener? = null
    @Volatile private var latestSocket: WebSocket? = null

    val callFactory = Call.Factory { request ->
        object : Call {
            private var executed = false
            override fun cancel() {}
            override fun clone(): Call = this
            override fun enqueue(responseCallback: Callback) {
                executed = true
                val body = JSONObject().put("groupId", config.groupId).toString().toResponseBody("application/json".toMediaType())
                val response = Response.Builder()
                    .request(request)
                    .protocol(Protocol.HTTP_1_1)
                    .code(200)
                    .message("OK")
                    .body(body)
                    .build()
                responseCallback.onResponse(this, response)
            }
            override fun execute(): Response = error("Async only")
            override fun isCanceled(): Boolean = false
            override fun isExecuted(): Boolean = executed
            override fun request(): Request = request
            override fun timeout(): Timeout = Timeout.NONE
        }
    }

    val webSocketFactory = WebSocket.Factory { request, listener ->
        val socket = object : WebSocket {
            override fun cancel() {}
            override fun close(code: Int, reason: String?): Boolean {
                closedCodes += code
                return true
            }
            override fun queueSize(): Long = 0L
            override fun request(): Request = request
            override fun send(text: String): Boolean {
                sentFrames += text
                return true
            }
            override fun send(bytes: ByteString): Boolean = false
        }
        latestSocket = socket
        latestListener = listener
        val openResponse = Response.Builder()
            .request(request)
            .protocol(Protocol.HTTP_1_1)
            .code(101)
            .message("Switching Protocols")
            .body("".toResponseBody(null))
            .build()
        listener.onOpen(socket, openResponse)
        socket
    }

    fun sendServerFrame(frame: JSONObject) {
        val socket = checkNotNull(latestSocket) { "WebSocket not open" }
        val listener = checkNotNull(latestListener) { "WebSocketListener not attached" }
        listener.onMessage(socket, frame.toString())
    }

    fun failCurrentSocket() {
        val socket = checkNotNull(latestSocket)
        val listener = checkNotNull(latestListener)
        listener.onFailure(socket, java.io.IOException("simulated network drop"), null)
    }
}

private class CountingDocumentProvider(private val root: File) : ContentProvider() {
    private val writeCounts = java.util.concurrent.ConcurrentHashMap<String, AtomicInteger>()

    fun attach(context: Context, authority: String) {
        attachInfo(context, ProviderInfo().apply {
            this.authority = authority
            exported = true
            grantUriPermissions = true
        })
        fileFor("folder/Active.md").writeText("# Active\n\nFocused body.\n")
        fileFor("folder/Inactive.md").writeText("# Inactive\n\nOriginal background body.\n")
        writeCounts.clear()
    }

    fun writesFor(docId: String): Int = writeCounts[docId]?.get() ?: 0
    fun readText(docId: String): String = fileFor(docId).readText()

    private fun fileFor(docId: String): File = File(root, docId).apply { parentFile?.mkdirs() }

    override fun onCreate(): Boolean = true

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor {
        val id = DocumentsContract.getDocumentId(uri)
        val file = fileFor(id)
        val cols = projection ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE, DocumentsContract.Document.COLUMN_LAST_MODIFIED)
        return MatrixCursor(cols).apply {
            addRow(cols.map { col ->
                when (col) {
                    OpenableColumns.DISPLAY_NAME -> file.name
                    OpenableColumns.SIZE -> file.length()
                    DocumentsContract.Document.COLUMN_LAST_MODIFIED -> file.lastModified()
                    else -> null
                }
            })
        }
    }

    override fun getType(uri: Uri): String = "text/markdown"

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        val id = DocumentsContract.getDocumentId(uri)
        val file = fileFor(id)
        val writing = mode.contains('w')
        if (writing) writeCounts.computeIfAbsent(id) { AtomicInteger(0) }.incrementAndGet()
        val pfdMode = if (writing) {
            ParcelFileDescriptor.MODE_WRITE_ONLY or ParcelFileDescriptor.MODE_CREATE or ParcelFileDescriptor.MODE_TRUNCATE
        } else {
            ParcelFileDescriptor.MODE_READ_ONLY
        }
        return ParcelFileDescriptor.open(file, pfdMode)
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0
}
