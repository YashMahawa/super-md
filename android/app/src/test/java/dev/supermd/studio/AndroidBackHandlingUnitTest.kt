package dev.supermd.studio

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.Text
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.getValue
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class AndroidBackHandlingUnitTest {
    private lateinit var app: android.app.Application
    private val workspaceKeys = mutableListOf<String>()
    private val stores = mutableListOf<ViewModelStore>()
    private val scopes = mutableListOf<CoroutineScope>()

    @Before fun setUp() {
        app = RuntimeEnvironment.getApplication()
    }

    @After fun tearDown() {
        scopes.forEach { it.cancel() }
        stores.forEach { it.clear() }
        shadowOf(Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(32))
        app.getSharedPreferences("studio", Context.MODE_PRIVATE).edit().clear().commit()
        workspaceKeys.forEach { key ->
            File(app.filesDir, "workspaces/$key.json").delete()
            File(app.filesDir, "workspaces/$key").deleteRecursively()
        }
    }

    private fun newModel(): StudioViewModel {
        val store = ViewModelStore().also(stores::add)
        val key = java.util.UUID.randomUUID().toString().also(workspaceKeys::add)
        val model = StudioViewModel(app, key)
        model.readerFlushRequester = { true }
        store.put("model-${stores.size}", model)
        return model
    }

    private fun idleUntil(timeoutMs: Long = 5_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        val mainLooper = shadowOf(Looper.getMainLooper())
        val frameStep = java.time.Duration.ofMillis(16)
        while (System.currentTimeMillis() < deadline) {
            mainLooper.idleFor(frameStep)
            if (condition()) return
            Thread.sleep(10)
        }
        mainLooper.idleFor(frameStep)
        assertTrue("Condition was not met within ${timeoutMs}ms", condition())
    }

    @Test fun shouldInterceptStudioBackCoversInlineDismissiblesAndReleasesForSystemBack() {
        assertFalse(
            shouldInterceptStudioBack(
                contentsShown = false,
                fullscreen = false,
                drawerOpen = false,
                readerOverlay = false,
                readerDismissible = false,
            ),
        )
        assertTrue(
            shouldInterceptStudioBack(
                contentsShown = false,
                fullscreen = false,
                drawerOpen = false,
                readerOverlay = false,
                readerDismissible = true,
            ),
        )
        assertTrue(
            shouldInterceptStudioBack(
                contentsShown = false,
                fullscreen = false,
                drawerOpen = false,
                readerOverlay = true,
                readerDismissible = false,
            ),
        )
        assertTrue(
            shouldInterceptStudioBack(
                contentsShown = false,
                fullscreen = true,
                drawerOpen = false,
                readerOverlay = false,
                readerDismissible = false,
            ),
        )
    }

    @Test fun readerBridgeTracksReaderDismissibleSeparatelyFromOverlayChrome() {
        val model = newModel()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate).also(scopes::add)
        val web = object : WebView(app) {
            override fun post(action: Runnable?): Boolean =
                action?.let { Handler(Looper.getMainLooper()).post(it) } ?: false

            override fun evaluateJavascript(script: String, resultCallback: android.webkit.ValueCallback<String>?) {
                resultCallback?.onReceiveValue("null")
            }
        }
        val bridge = ReaderBridge(web, model, scope, ready = {}, assetCapabilities = ReaderAssetCapabilities())

        assertFalse(model.state.value.readerDismissible)
        assertFalse(model.state.value.readerOverlay)
        assertFalse(model.imageOverlay.value)

        bridge.post("req-1", "reader_dismissible_changed", JSONObject().put("open", true).toString())
        idleUntil { model.state.value.readerDismissible }
        assertFalse("Active Live edits and .cm-search must not hide native chrome via readerOverlay", model.state.value.readerOverlay)
        assertFalse(model.imageOverlay.value)

        bridge.post("req-2", "reader_dismissible_changed", JSONObject().put("open", false).toString())
        idleUntil { !model.state.value.readerDismissible }
        assertFalse(model.state.value.readerOverlay)
    }

    @Test fun applyReaderDismissResultReconcilesStateImmediatelyAndPreservesSecondBack() {
        val model = newModel()
        model.fullscreen(true)
        model.readerDismissible(true)
        assertTrue(model.state.value.fullscreen)
        assertTrue(model.state.value.readerDismissible)

        // First Back in fullscreen dismisses active Live edit / Source search while keeping fullscreen active.
        val firstPayload = JSONObject()
            .put("dismissed", true)
            .put("overlay", false)
            .put("image", false)
            .put("dismissible", false)
            .toString()
        applyReaderDismissResult(model, JSONObject.quote(firstPayload))
        assertFalse(model.state.value.readerDismissible)
        assertFalse(model.state.value.readerOverlay)
        assertTrue("First Back must keep fullscreen active when an edit or search was dismissed", model.state.value.fullscreen)

        // Second Back in fullscreen exits fullscreen because no overlay or edit remains.
        val secondPayload = JSONObject()
            .put("dismissed", false)
            .put("overlay", false)
            .put("image", false)
            .put("dismissible", false)
            .toString()
        applyReaderDismissResult(model, JSONObject.quote(secondPayload))
        assertFalse(model.state.value.fullscreen)
        assertFalse(
            "After fullscreen exits, Back interception must be disabled so the next Back reaches system Back",
            shouldInterceptStudioBack(
                contentsShown = false,
                fullscreen = model.state.value.fullscreen,
                drawerOpen = false,
                readerOverlay = model.state.value.readerOverlay,
                readerDismissible = model.state.value.readerDismissible,
            ),
        )
        assertEquals(StudioState().active.content, model.state.value.active.content)
    }

    @Test fun modeSwitchBarrierRequiresAcknowledgedReaderSnapshotAfterNativeEdit() {
        val store = ViewModelStore().also(stores::add)
        val key = java.util.UUID.randomUUID().toString().also(workspaceKeys::add)
        val model = StudioViewModel(app, key)
        store.put("model-barrier", model)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate).also(scopes::add)
        var readerContent = model.state.value.active.content
        lateinit var bridge: ReaderBridge
        val web = object : WebView(app) {
            override fun post(action: Runnable?): Boolean =
                action?.let { Handler(Looper.getMainLooper()).post(it) } ?: false

            override fun evaluateJavascript(script: String, resultCallback: android.webkit.ValueCallback<String>?) {
                val tokenMatch = Regex("""token:"([^"]+)"""").find(script)
                if (tokenMatch != null) {
                    val token = tokenMatch.groupValues[1]
                    bridge.post(
                        "flush-1",
                        "document_flushed",
                        JSONObject()
                            .put("id", model.state.value.active.id)
                            .put("token", token)
                            .put("content", readerContent)
                            .toString(),
                    )
                }
                resultCallback?.onReceiveValue("null")
            }
        }
        bridge = ReaderBridge(web, model, scope, ready = {}, assetCapabilities = ReaderAssetCapabilities())
        model.readerFlushRequester = { noteId -> bridge.requestFlush(noteId) }

        val activeId = model.state.value.active.id
        val updated = "# Source Back Test\n\nAlpha needle in source mode."

        // Reproduces the exact race from AndroidBackHandlingTest: calling edit() + mode("editor")
        // before Compose sends supermdLoad(updated) causes ReaderBridge to flush stale readerContent.
        model.edit(activeId, updated)
        model.mode("editor")
        idleUntil { model.state.value.message != null }
        assertEquals("live", model.state.value.mode)
        assertTrue(model.state.value.message.orEmpty().contains("could not confirm its latest edits"))

        // Once the reader loads and acknowledges the updated snapshot (or mode switches before edit),
        // mode("editor") succeeds cleanly while keeping the draft intact.
        model.dismissMessage()
        readerContent = updated
        bridge.post(
            "sync-1",
            "document_sync",
            JSONObject()
                .put("id", activeId)
                .put("epoch", "epoch-1")
                .put("revision", 0)
                .put("content", updated)
                .toString(),
        )
        idleUntil { model.readerStateIsNativeAuthoritative(activeId) }
        model.mode("editor")
        idleUntil { model.state.value.mode == "editor" }
        assertEquals(updated, model.state.value.active.content)
    }

    @Test fun composeBackHandlerWithClosedModalDrawerReleasesForSystemBackOnSecondPress() {
        val prefs = app.getSharedPreferences("studio", Context.MODE_PRIVATE)
        prefs.edit().putBoolean("welcomed", true).putString("startup", "restore").commit()
        val model = newModel()
        val draft = "# Live Back Test\n\nDraft preserved across second Back."
        model.edit(model.state.value.active.id, draft)
        val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
        try {
            val activity = controller.get()
            activity.setContent {
                val state by model.state.collectAsStateWithLifecycle()
                val drawer = rememberDrawerState(DrawerValue.Closed)
                BackHandler(
                    shouldInterceptStudioBack(
                        contentsShown = false,
                        fullscreen = state.fullscreen,
                        drawerOpen = drawer.isOpen,
                        readerOverlay = state.readerOverlay,
                        readerDismissible = state.readerDismissible,
                    ),
                ) {
                    applyReaderDismissResult(
                        model,
                        JSONObject.quote(
                            JSONObject()
                                .put("dismissed", state.readerDismissible || state.readerOverlay)
                                .put("overlay", false)
                                .put("image", false)
                                .put("dismissible", false)
                                .toString(),
                        ),
                    )
                }
                ModalNavigationDrawer(
                    drawerState = drawer,
                    gesturesEnabled = drawer.isOpen && !state.fullscreen,
                    drawerContent = { ModalDrawerSheet { Text("Drawer") } },
                ) {
                    Text(state.active.content)
                }
            }
            idleUntil { !activity.onBackPressedDispatcher.hasEnabledCallbacks() }

            model.readerDismissible(true)
            idleUntil { activity.onBackPressedDispatcher.hasEnabledCallbacks() }

            // First Back dismisses active Live edit / Source search and disables Studio BackHandler.
            activity.onBackPressedDispatcher.onBackPressed()
            idleUntil { !model.state.value.readerDismissible && !activity.onBackPressedDispatcher.hasEnabledCallbacks() }
            assertFalse(activity.isFinishing)
            assertEquals(draft, model.state.value.active.content)

            // Second Back reaches system Back and finishes the Activity while keeping the draft intact.
            activity.onBackPressedDispatcher.onBackPressed()
            idleUntil { activity.isFinishing }
            assertEquals(draft, model.state.value.active.content)
        } finally {
            runCatching { controller.pause().stop().destroy() }
            shadowOf(Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(32))
        }
    }

    @Test fun nativeEditAfterModeSwitchFlushClearsPreviousProtocolSessionAndResynchronizes() {
        val store = ViewModelStore().also(stores::add)
        val key = java.util.UUID.randomUUID().toString().also(workspaceKeys::add)
        val model = StudioViewModel(app, key)
        store.put("model-post-mode-edit", model)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate).also(scopes::add)
        var readerContent = model.state.value.active.content
        var syncedInitialSession = false
        lateinit var bridge: ReaderBridge
        val web = object : WebView(app) {
            override fun post(action: Runnable?): Boolean =
                action?.let { Handler(Looper.getMainLooper()).post(it) } ?: false

            override fun evaluateJavascript(script: String, resultCallback: android.webkit.ValueCallback<String>?) {
                val tokenMatch = Regex("""token:"([^"]+)"""").find(script)
                if (tokenMatch != null) {
                    val token = tokenMatch.groupValues[1]
                    val activeId = model.state.value.active.id
                    // Matches ReaderEdits.flush() in src/readerEdits.ts: the first flush of an untouched
                    // session sends document_sync(epoch, revision = 0, content) before document_flushed.
                    if (!syncedInitialSession) {
                        syncedInitialSession = true
                        bridge.post(
                            "sync-initial",
                            "document_sync",
                            JSONObject()
                                .put("id", activeId)
                                .put("epoch", "epoch-initial")
                                .put("revision", 0)
                                .put("content", readerContent)
                                .toString(),
                        )
                    }
                    bridge.post(
                        "flush-initial",
                        "document_flushed",
                        JSONObject()
                            .put("id", activeId)
                            .put("token", token)
                            .put("content", readerContent)
                            .toString(),
                    )
                }
                resultCallback?.onReceiveValue("null")
            }
        }
        bridge = ReaderBridge(web, model, scope, ready = {}, assetCapabilities = ReaderAssetCapabilities())
        model.readerFlushRequester = { noteId -> bridge.requestFlush(noteId) }

        val activeId = model.state.value.active.id
        model.mode("editor")
        idleUntil { model.state.value.mode == "editor" && model.state.value.message == null }

        // Next, native code updates the note (exact sequence in AndroidBackHandlingTest lines 191..203).
        // WebView receives supermdLoad(initial) -> ReaderEdits.open(id, initial), which stays lazy (ready=false)
        // and does NOT send document_sync until the user edits inside WebView.
        val initial = "# Source Back Test\n\nAlpha needle in source mode."
        model.readerEcho[activeId] = initial
        model.edit(activeId, initial)
        readerContent = initial

        assertFalse("Native edit() must clear stale readerEcho entries so Compose sends updated content", model.readerEcho.containsKey(activeId))
        assertTrue(
            "Native edit() after a mode-switch flush must clear the stale ReaderEditProtocol session so readerStateIsNativeAuthoritative matches native content",
            model.readerStateIsNativeAuthoritative(activeId),
        )

        // Subsequent WebView edit opens a fresh protocol epoch and patches cleanly onto initial.
        val suffix = "\nDraft kept after Find in note."
        bridge.post(
            "sync-after-edit",
            "document_sync",
            JSONObject()
                .put("id", activeId)
                .put("epoch", "epoch-after-edit")
                .put("revision", 0)
                .put("content", initial)
                .toString(),
        )
        bridge.post(
            "patch-after-edit",
            "document_patch",
            JSONObject()
                .put("id", activeId)
                .put("epoch", "epoch-after-edit")
                .put("baseRevision", 0)
                .put("revision", 1)
                .put(
                    "changes",
                    org.json.JSONArray().put(
                        JSONObject()
                            .put("from", initial.length)
                            .put("to", initial.length)
                            .put("insert", suffix),
                    ),
                )
                .toString(),
        )
        idleUntil { model.state.value.active.content == initial + suffix }
        assertTrue(model.readerStateIsNativeAuthoritative(activeId))
    }

    @Test fun realMainActivityPersistsDraftAcrossSystemBackAndReopen() {
        val prefs = app.getSharedPreferences("studio", Context.MODE_PRIVATE)
        prefs.edit()
            .putBoolean("welcomed", true)
            .putBoolean("motion", false)
            .putString("startup", "restore")
            .putBoolean("autosave", false)
            .commit()
        val workspace = java.util.UUID.randomUUID().toString().also(workspaceKeys::add)
        val draft = "# Live Back Test\n\nEdited live draft kept across Back. Second pass in normal mode."
        val intent = android.content.Intent(app, MainActivity::class.java).putExtra("workspace", workspace)
        val controller = Robolectric.buildActivity(MainActivity::class.java, intent).setup()
        try {
            val activity = controller.get()
            val model = androidx.lifecycle.ViewModelProvider(activity)[StudioViewModel::class.java]
            idleUntil { !activity.onBackPressedDispatcher.hasEnabledCallbacks() }

            model.edit(model.state.value.active.id, draft)
            model.readerDismissible(true)
            idleUntil { activity.onBackPressedDispatcher.hasEnabledCallbacks() }

            // Reconcile first-Back dismissal (as returned by READER_DISMISS_SCRIPT on real WebView)
            // and verify MainActivity releases its BackHandler for second Back.
            applyReaderDismissResult(
                model,
                JSONObject.quote(
                    JSONObject()
                        .put("dismissed", true)
                        .put("overlay", false)
                        .put("image", false)
                        .put("dismissible", false)
                        .toString(),
                ),
            )
            idleUntil { !model.state.value.readerDismissible && !activity.onBackPressedDispatcher.hasEnabledCallbacks() }
            assertFalse(activity.isFinishing)
            assertEquals(draft, model.state.value.active.content)

            // Second Back in normal mode reaches system Back, finishes MainActivity, and onStop flushes recovery.
            activity.onBackPressedDispatcher.onBackPressed()
            idleUntil { activity.isFinishing }
            controller.pause().stop().destroy()
            shadowOf(Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(32))
        } finally {
            runCatching { controller.destroy() }
            shadowOf(Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(32))
        }

        val snapshot = File(app.filesDir, "workspaces/$workspace.json")
        idleUntil {
            snapshot.isFile && snapshot.bufferedReader().use { reader ->
                NoteRecovery.read(reader, StudioState()).tabs.any { it.content == draft }
            }
        }

        val reopenController = Robolectric.buildActivity(MainActivity::class.java, intent).setup()
        try {
            val reopenedModel = androidx.lifecycle.ViewModelProvider(reopenController.get())[StudioViewModel::class.java]
            idleUntil { reopenedModel.state.value.active.content == draft }
        } finally {
            runCatching { reopenController.pause().stop().destroy() }
            shadowOf(Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(32))
        }
    }

    @Test fun findReplaceAndMatchStepShortcutsCoexistWithDismissibleBackAndEscape() {
        val prefs = app.getSharedPreferences("studio", Context.MODE_PRIVATE)
        prefs.edit().putBoolean("welcomed", true).putBoolean("motion", false).commit()
        val workspace = java.util.UUID.randomUUID().toString().also(workspaceKeys::add)
        val intent = android.content.Intent(app, MainActivity::class.java).putExtra("workspace", workspace)
        val controller = Robolectric.buildActivity(MainActivity::class.java, intent).setup()
        try {
            val activity = controller.get()
            val model = androidx.lifecycle.ViewModelProvider(activity)[StudioViewModel::class.java]
            idleUntil { !activity.onBackPressedDispatcher.hasEnabledCallbacks() }

            val openedReplaceFlags = mutableListOf<Boolean>()
            val stepDirections = mutableListOf<Int>()
            var dismissCalls = 0
            activity.openReaderFind = { replace -> openedReplaceFlags += replace }
            activity.stepReaderFind = { direction -> stepDirections += direction }
            activity.dismissDocument = {
                dismissCalls += 1
                applyReaderDismissResult(
                    model,
                    JSONObject.quote(
                        JSONObject()
                            .put("dismissed", true)
                            .put("overlay", false)
                            .put("image", false)
                            .put("dismissible", false)
                            .toString(),
                    ),
                )
            }

            assertTrue(
                activity.handleShortcut(
                    android.view.KeyEvent(0L, 0L, android.view.KeyEvent.ACTION_DOWN, android.view.KeyEvent.KEYCODE_H, 0, android.view.KeyEvent.META_CTRL_ON),
                ),
            )
            assertEquals(listOf(true), openedReplaceFlags)

            assertTrue(
                activity.handleShortcut(
                    android.view.KeyEvent(0L, 0L, android.view.KeyEvent.ACTION_DOWN, android.view.KeyEvent.KEYCODE_F3, 0, 0),
                ),
            )
            assertEquals(listOf(1), stepDirections)

            model.readerDismissible(true)
            idleUntil { activity.onBackPressedDispatcher.hasEnabledCallbacks() }
            assertTrue(
                activity.handleShortcut(
                    android.view.KeyEvent(0L, 0L, android.view.KeyEvent.ACTION_DOWN, android.view.KeyEvent.KEYCODE_ESCAPE, 0, 0),
                ),
            )
            assertEquals(1, dismissCalls)
            idleUntil { !model.state.value.readerDismissible && !activity.onBackPressedDispatcher.hasEnabledCallbacks() }
        } finally {
            runCatching { controller.pause().stop().destroy() }
            shadowOf(Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(32))
        }
    }
}
