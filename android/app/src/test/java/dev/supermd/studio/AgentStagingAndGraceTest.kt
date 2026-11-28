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
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
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

    private fun await(timeoutMillis: Long = 15_000L, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMillis
        while (!condition() && System.currentTimeMillis() < deadline) {
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(10)
        }
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue("Timed out waiting for condition", condition())
    }

    /**
     * Runs [block] off Robolectric's Main Thread while idling [Looper.getMainLooper] so
     * [StudioViewModel]'s `viewModelScope` (`Dispatchers.Main`) coroutines can finish and
     * release `documentWrites` instead of deadlocking against a blocked Main Thread.
     */
    private fun <T> runWithMainLooper(timeoutMillis: Long = 15_000L, block: suspend () -> T): T {
        val scope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.Default)
        val deferred = scope.async { block() }
        try {
            val deadline = System.currentTimeMillis() + timeoutMillis
            while (deferred.isActive && System.currentTimeMillis() < deadline) {
                shadowOf(Looper.getMainLooper()).idle()
                Thread.sleep(5)
            }
            shadowOf(Looper.getMainLooper()).idle()
            assertFalse("Timed out after ${timeoutMillis}ms waiting for suspending operation", deferred.isActive)
            return runBlocking { deferred.await() }
        } finally {
            scope.cancel()
        }
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
        runWithMainLooper {
            model.commitAgentSnapshotPatch(inactiveId, baseRev, patchedContent, patchedRev)
        }
        val elapsedMillis = (System.nanoTime() - startedAt) / 1_000_000.0
        assertTrue("Inactive recovery staging took ${elapsedMillis}ms (> 10000ms)", elapsedMillis < 10_000.0)

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
            runWithMainLooper {
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
        runWithMainLooper {
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
            runWithMainLooper {
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
        runWithMainLooper {
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
            runWithMainLooper {
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

    @Test fun mainActivityOverlappingLifecycleFlushRequiresStagedSnapshotCommitBeforeAcknowledgment() {
        val workspaceKey = UUID.randomUUID().toString()
        workspaceKeys += workspaceKey
        val config = AgentAccessConfig(
            serverOrigin = "https://relay.example.test",
            groupId = "group-overlap-flush-1",
            deviceId = "device-overlap-flush-1",
            deviceKey = "device-secret-1",
            pairingKey = "A".repeat(43),
            connectorKey = "B".repeat(43),
            displayName = "Pixel Overlap Flush Test",
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

        // Use Dispatchers.Main (queued on MainLooper) so IO recovery commits can complete while MainLooper is paused.
        val bridgeScope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.Main)
        var modelRef: StudioViewModel? = null
        val releaseInFlight = java.util.concurrent.CountDownLatch(1)
        val releaseV1RetryWrite = java.util.concurrent.CountDownLatch(1)
        val releaseV2Retry = java.util.concurrent.CountDownLatch(1)
        try {
            controller.create().start().resume()
            shadowOf(Looper.getMainLooper()).idle()
            harness.sendServerFrame(JSONObject().put("type", "registered").put("groupId", config.groupId).put("deviceId", config.deviceId))
            shadowOf(Looper.getMainLooper()).idle()
            assertEquals(AgentRelayClient.State.CONNECTED, activity.agentRelayState)

            val model = androidx.lifecycle.ViewModelProvider(activity)[StudioViewModel::class.java]
            modelRef = model
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
            val recoveryFile = File(app.filesDir, "workspaces/$workspaceKey.json")
            runWithMainLooper { assertTrue(model.flushRecoveryAndAwait()) }

            val baseContent = provider.readText("folder/Inactive.md")
            val v1Content = baseContent.replace("Original background body.", "Patched across lifecycle flush v1.")
            val v2Content = v1Content.replace("Patched across lifecycle flush v1.", "Patched across lifecycle flush v2.")
            val baseRev = agentContentRevision(baseContent)
            val v1Rev = agentContentRevision(v1Content)
            val v2Rev = agentContentRevision(v2Content)
            val canonicalTabId = "tab:${config.deviceId}:$workspaceKey:$inactiveId"

            // Window 1: An earlier write is in flight while stagedState is queued in pending, and
            // MainActivity.onStop() calls model.flush() (coalescing pending to the unchanged baseline).
            val inFlightStarted = java.util.concurrent.CountDownLatch(1)
            val baselineAfterStopWritten = java.util.concurrent.CountDownLatch(1)
            val v1RetryWriteStarted = java.util.concurrent.CountDownLatch(1)
            val blockInitialWrite = java.util.concurrent.atomic.AtomicBoolean(true)
            val stopTriggered = java.util.concurrent.atomic.AtomicBoolean(false)

            model.recoverySnapshotWriter = { writer, state ->
                val inactiveNote = state.tabs.firstOrNull { it.id == inactiveId }
                if (blockInitialWrite.compareAndSet(true, false)) {
                    inFlightStarted.countDown()
                    releaseInFlight.await(15, java.util.concurrent.TimeUnit.SECONDS)
                } else if (inactiveNote?.content == v1Content) {
                    v1RetryWriteStarted.countDown()
                    releaseV1RetryWrite.await(15, java.util.concurrent.TimeUnit.SECONDS)
                }
                NoteRecovery.write(writer, state)
                if (stopTriggered.get() && inactiveNote?.content == baseContent) {
                    baselineAfterStopWritten.countDown()
                }
            }

            // Start an in-flight baseline flush and wait until it is blocked on IO
            model.flush()
            assertTrue("Initial flush should start on IO", inFlightStarted.await(15, java.util.concurrent.TimeUnit.SECONDS))

            // Dispatch inactive-tab patch_tab (v1) so commitAgentSnapshotPatch queues stagedState (v1) in pending
            harness.sentFrames.clear()
            harness.sendServerFrame(
                JSONObject()
                    .put("type", "request")
                    .put("requestId", "patch_overlap_1")
                    .put("deviceId", config.deviceId)
                    .put("action", "patch_tab")
                    .put("tabId", canonicalTabId)
                    .put("expectedRevision", baseRev)
                    .put("operations", org.json.JSONArray()),
            )
            shadowOf(Looper.getMainLooper()).idle()
            activity.deliverAgentReply(
                "patch_overlap_1",
                JSONObject()
                    .put("tabId", inactiveId)
                    .put("baseRevision", baseRev)
                    .put("baseSourceLength", activity.agentSourceLength(baseContent))
                    .put("revision", v1Rev)
                    .put("sourceLength", activity.agentSourceLength(v1Content))
                    .put("patchedContent", v1Content)
                    .put("changed", true),
                null,
            )
            shadowOf(Looper.getMainLooper()).idle()
            assertTrue("Patch must not acknowledge before staged write commits", harness.sentFrames.isEmpty())

            // Trigger lifecycle onStop() -> model.flush() while MainLooper is NOT idled afterward,
            // then release in-flight write so the coalesced baseline flush commits to disk first!
            stopTriggered.set(true)
            controller.pause().stop()
            val stopFlushRev = model.latestScheduledRecoveryRevision()
            releaseInFlight.countDown()
            assertTrue(
                "Overlapping lifecycle baseline flush should write unchanged baseline first",
                baselineAfterStopWritten.await(15, java.util.concurrent.TimeUnit.SECONDS),
            )
            val commitDeadline = System.currentTimeMillis() + 15_000
            while (model.committedRecoveryRevision() < stopFlushRev && System.currentTimeMillis() < commitDeadline) {
                Thread.sleep(5)
            }
            assertTrue("Overlapping lifecycle baseline flush must commit to disk", model.committedRecoveryRevision() >= stopFlushRev)
            shadowOf(Looper.getMainLooper()).idle()

            // Even after baseline flush committed, patch MUST NOT be acknowledged until v1 staged retry commits!
            assertTrue("Retry of v1 staged snapshot should start", v1RetryWriteStarted.await(15, java.util.concurrent.TimeUnit.SECONDS))
            shadowOf(Looper.getMainLooper()).idle()
            assertTrue("Uncommitted patch must NOT be acknowledged after baseline flush", harness.sentFrames.isEmpty())

            val onDiskBeforeAck = recoveryFile.bufferedReader().use { NoteRecovery.read(it, StudioState()) }
            assertEquals(baseContent, onDiskBeforeAck.tabs.single { it.id == inactiveId }.content)

            // Now let the retried staged snapshot commit and verify acknowledgment + durable state
            releaseV1RetryWrite.countDown()
            await { harness.sentFrames.isNotEmpty() }
            val v1Reply = JSONObject(harness.sentFrames.single())
            assertTrue("Expected successful reply after staged retry commits, got: $v1Reply", v1Reply.isNull("error"))
            assertEquals(v1Rev, v1Reply.getJSONObject("result").getString("revision"))

            val onDiskAfterV1 = recoveryFile.bufferedReader().use { NoteRecovery.read(it, StudioState()) }
            val recoveredV1 = onDiskAfterV1.tabs.single { it.id == inactiveId }
            assertEquals(v1Content, recoveredV1.content)
            assertTrue(recoveredV1.agentStaged)
            assertTrue(recoveredV1.agentUnreviewed)
            assertEquals(1, recoveredV1.agentEdits.size)
            assertEquals(activeId, model.state.value.activeId)

            // Window 2: Return to foreground, then trigger model.flush() MID-WRITE of v2 stagedState (before commitIfLatest)
            controller.restart().start().resume()
            shadowOf(Looper.getMainLooper()).idle()

            val firstV2Attempt = java.util.concurrent.atomic.AtomicBoolean(true)
            val v2RetryStarted = java.util.concurrent.CountDownLatch(1)
            model.recoverySnapshotWriter = { writer, state ->
                val inactiveNote = state.tabs.firstOrNull { it.id == inactiveId }
                NoteRecovery.write(writer, state)
                if (inactiveNote?.content == v2Content) {
                    if (firstV2Attempt.compareAndSet(true, false)) {
                        // Submit unchanged v1 baseline via lifecycle flush right before commitIfLatest!
                        model.flush()
                    } else {
                        v2RetryStarted.countDown()
                        releaseV2Retry.await(15, java.util.concurrent.TimeUnit.SECONDS)
                    }
                }
            }

            harness.sentFrames.clear()
            harness.sendServerFrame(
                JSONObject()
                    .put("type", "request")
                    .put("requestId", "patch_overlap_2")
                    .put("deviceId", config.deviceId)
                    .put("action", "patch_tab")
                    .put("tabId", canonicalTabId)
                    .put("expectedRevision", v1Rev)
                    .put("operations", org.json.JSONArray()),
            )
            shadowOf(Looper.getMainLooper()).idle()
            activity.deliverAgentReply(
                "patch_overlap_2",
                JSONObject()
                    .put("tabId", inactiveId)
                    .put("baseRevision", v1Rev)
                    .put("baseSourceLength", activity.agentSourceLength(v1Content))
                    .put("revision", v2Rev)
                    .put("sourceLength", activity.agentSourceLength(v2Content))
                    .put("patchedContent", v2Content)
                    .put("changed", true),
                null,
            )
            val waitDeadline = System.currentTimeMillis() + 15_000
            while (v2RetryStarted.count > 0 && System.currentTimeMillis() < waitDeadline) {
                shadowOf(Looper.getMainLooper()).idle()
                Thread.sleep(10)
            }
            assertEquals("Mid-write superseded patch must retry staged write", 0L, v2RetryStarted.count)
            shadowOf(Looper.getMainLooper()).idle()
            assertTrue("Mid-write superseded patch must NOT acknowledge before retry commits", harness.sentFrames.isEmpty())

            releaseV2Retry.countDown()
            await { harness.sentFrames.isNotEmpty() }
            val v2Reply = JSONObject(harness.sentFrames.single())
            assertTrue("Expected successful v2 reply after retry commits, got: $v2Reply", v2Reply.isNull("error"))
            assertEquals(v2Rev, v2Reply.getJSONObject("result").getString("revision"))

            val onDiskAfterV2 = recoveryFile.bufferedReader().use { NoteRecovery.read(it, StudioState()) }
            val recoveredV2 = onDiskAfterV2.tabs.single { it.id == inactiveId }
            assertEquals(v2Content, recoveredV2.content)
            assertTrue(recoveredV2.agentStaged)
            assertEquals(2, recoveredV2.agentEdits.size)
            assertEquals(0, provider.writesFor("folder/Inactive.md"))
        } finally {
            releaseInFlight.countDown()
            releaseV1RetryWrite.countDown()
            releaseV2Retry.countDown()
            modelRef?.recoverySnapshotWriter = NoteRecovery::write
            bridgeScope.coroutineContext[kotlinx.coroutines.Job]?.cancel()
            runCatching { controller.destroy() }
            shadowOf(Looper.getMainLooper()).idle()
        }
    }

    @Test fun unrelatedEditsBoundStagingRetryUnderDocumentWritesSoSavesAreNotHeldIndefinitely() {
        val (workspaceKey, model) = newModel()
        model.open(inactiveUri)
        await { model.state.value.tabs.any { it.uri == inactiveUri.toString() } }
        val inactiveId = model.state.value.tabs.single { it.uri == inactiveUri.toString() }.id

        model.open(activeUri)
        await { model.state.value.tabs.any { it.uri == activeUri.toString() } && model.state.value.active.uri == activeUri.toString() }
        val activeId = model.state.value.active.id

        val baseContent = provider.readText("folder/Inactive.md")
        val patchedContent = baseContent.replace("Original background body.", "Patched during active typing storm.")
        val baseRev = agentContentRevision(baseContent)
        val patchedRev = agentContentRevision(patchedContent)

        val stagedAttempts = AtomicInteger(0)
        val injectConcurrentActiveEdits = java.util.concurrent.atomic.AtomicBoolean(true)
        val firstStageEntered = java.util.concurrent.CountDownLatch(1)
        val saveQueued = java.util.concurrent.CountDownLatch(1)

        model.recoverySnapshotWriter = { writer, state ->
            val inactiveNote = state.tabs.firstOrNull { it.id == inactiveId }
            NoteRecovery.write(writer, state)
            if (injectConcurrentActiveEdits.get() && inactiveNote?.content == patchedContent) {
                val n = stagedAttempts.incrementAndGet()
                // Simulate continuous unrelated edits on the active tab during every stage attempt
                model.edit(activeId, "# Active\n\nConcurrent active edit #$n.\n")
                if (n == 1) {
                    firstStageEntered.countDown()
                    saveQueued.await(15, java.util.concurrent.TimeUnit.SECONDS)
                }
            }
        }

        // Run commitAgentSnapshotPatch on a background thread while concurrently triggering saveManual() on the active tab
        var patchError: Throwable? = null
        val patchThread = Thread {
            patchError = runCatching {
                runBlocking {
                    model.commitAgentSnapshotPatch(inactiveId, baseRev, patchedContent, patchedRev)
                }
            }.exceptionOrNull()
        }.apply { start() }

        try {
            assertTrue("Staged write should start", firstStageEntered.await(15, java.util.concurrent.TimeUnit.SECONDS))
            // Queue a manual save on the active tab while documentWrites is held by commitAgentSnapshotPatch
            model.saveManual()
            shadowOf(Looper.getMainLooper()).idle()
            saveQueued.countDown()

            val joinDeadline = System.currentTimeMillis() + 15_000
            while (patchThread.isAlive && System.currentTimeMillis() < joinDeadline) {
                shadowOf(Looper.getMainLooper()).idle()
                patchThread.join(10)
            }
            shadowOf(Looper.getMainLooper()).idle()
            assertFalse("commitAgentSnapshotPatch must be bounded and never hang under continuous unrelated edits", patchThread.isAlive)
            assertEquals("Staging retries while holding documentWrites must be bounded to MAX_AGENT_STAGE_ATTEMPTS", MAX_AGENT_STAGE_ATTEMPTS, stagedAttempts.get())
            assertTrue("Expected recoverable IllegalStateException, got: $patchError", patchError is IllegalStateException)
            assertTrue("Error should instruct caller to retry: ${patchError?.message}", patchError?.message.orEmpty().contains("retry", ignoreCase = true))
            assertFalse("Error must not misreport revision conflict: ${patchError?.message}", patchError?.message.orEmpty().contains("revision conflict", ignoreCase = true))

            // Active tab manual save must complete promptly once bounded retry releases documentWrites!
            // Also wait for StudioViewModel.save() to resume on MainLooper, clear busy/dirty state, and release documentWrites.
            val expectedSavedActive = "# Active\n\nConcurrent active edit #$MAX_AGENT_STAGE_ATTEMPTS.\n"
            await {
                provider.writesFor("folder/Active.md") >= 1 &&
                    provider.readText("folder/Active.md") == expectedSavedActive &&
                    !model.state.value.busy &&
                    model.state.value.tabs.single { it.id == activeId }.saved == expectedSavedActive
            }
            assertEquals(0, provider.writesFor("folder/Inactive.md"))

            // Inactive tab remains unpatched in memory and in durable recovery
            val unchangedInactive = model.state.value.tabs.single { it.id == inactiveId }
            assertEquals(baseContent, unchangedInactive.content)
            assertFalse(unchangedInactive.agentStaged)
            assertFalse(unchangedInactive.agentUnreviewed)
            assertTrue(unchangedInactive.agentEdits.isEmpty())

            injectConcurrentActiveEdits.set(false)
            runWithMainLooper { assertTrue(model.flushRecoveryAndAwait()) }
            val recoveryFile = File(app.filesDir, "workspaces/$workspaceKey.json")
            val recoveredAfterStorm = recoveryFile.bufferedReader().use { NoteRecovery.read(it, StudioState()) }
            assertEquals(baseContent, recoveredAfterStorm.tabs.single { it.id == inactiveId }.content)
            assertEquals(expectedSavedActive, recoveredAfterStorm.tabs.single { it.id == activeId }.content)

            // Once the edit storm subsides, retrying with the exact same baseRev succeeds cleanly
            stagedAttempts.set(0)
            model.recoverySnapshotWriter = NoteRecovery::write
            runWithMainLooper {
                model.commitAgentSnapshotPatch(inactiveId, baseRev, patchedContent, patchedRev)
            }
            val stagedNote = model.state.value.tabs.single { it.id == inactiveId }
            assertEquals(patchedContent, stagedNote.content)
            assertTrue(stagedNote.agentStaged)
            assertEquals(1, stagedNote.agentEdits.size)
            val recoveredFinal = recoveryFile.bufferedReader().use { NoteRecovery.read(it, StudioState()) }
            assertEquals(patchedContent, recoveredFinal.tabs.single { it.id == inactiveId }.content)
        } finally {
            injectConcurrentActiveEdits.set(false)
            saveQueued.countDown()
            model.recoverySnapshotWriter = NoteRecovery::write
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
