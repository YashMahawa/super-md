package dev.supermd.studio

import android.content.Context
import android.net.Uri
import android.os.Looper
import android.webkit.WebView
import androidx.lifecycle.ViewModelStore
import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class NativeTabViewStateTest {
    private lateinit var app: android.app.Application
    private lateinit var tempRoot: File
    private val workspaceKeys = mutableListOf<String>()
    private val stores = mutableListOf<ViewModelStore>()
    private val scopes = mutableListOf<CoroutineScope>()
    private var savedPrefsSnapshot: Map<String, Any?> = emptyMap()

    @Before
    fun setUp() {
        app = RuntimeEnvironment.getApplication()
        tempRoot = Files.createTempDirectory("native-tab-view-state").toFile()
        val prefs = app.getSharedPreferences("studio", Context.MODE_PRIVATE)
        savedPrefsSnapshot = prefs.all.toMap()
        prefs.edit()
            .remove("readingMode")
            .remove("normalZoom")
            .remove("fullscreenZoom")
            .remove("noteViewStates")
            .commit()
    }

    @After
    fun tearDown() {
        scopes.forEach { it.cancel() }
        stores.forEach { it.clear() }
        tempRoot.deleteRecursively()
        val prefs = app.getSharedPreferences("studio", Context.MODE_PRIVATE)
        prefs.edit().apply {
            clear()
            for ((k, v) in savedPrefsSnapshot) {
                when (v) {
                    is Boolean -> putBoolean(k, v)
                    is Float -> putFloat(k, v)
                    is Int -> putInt(k, v)
                    is Long -> putLong(k, v)
                    is String -> putString(k, v)
                    is Set<*> -> @Suppress("UNCHECKED_CAST") putStringSet(k, v as Set<String>)
                }
            }
        }.commit()
        workspaceKeys.forEach { key ->
            File(app.filesDir, "workspaces/$key.json").delete()
            File(app.filesDir, "workspaces/$key").deleteRecursively()
            app.deleteSharedPreferences("studio-window-$key")
        }
    }

    private fun newModel(key: String = "tabview-${System.nanoTime()}".also(workspaceKeys::add)): StudioViewModel {
        val store = ViewModelStore().also(stores::add)
        if (key !in workspaceKeys) workspaceKeys.add(key)
        val model = StudioViewModel(app, key)
        model.readerFlushRequester = { true }
        store.put("vm-${stores.size}", model)
        return model
    }

    private fun idleUntil(timeoutMs: Long = 5_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        val mainLooper = shadowOf(Looper.getMainLooper())
        while (System.currentTimeMillis() < deadline) {
            mainLooper.idle()
            if (condition()) return
            Thread.sleep(10)
        }
        mainLooper.idle()
        assertTrue("Condition was not met within ${timeoutMs}ms", condition())
    }

    @Test
    fun preservesExplicitModeAndZoomPerNoteAcrossTabSwitchesIncludingUnsavedDraftsAndUsesDefaultsForNewNotes() {
        val model = newModel()
        model.defaultView(mode = "live", normalZoom = 110f, fullscreenZoom = 120f)

        val savedFileA = File(tempRoot, "NoteA.md").apply { writeText("# Note A\n\nSaved note alpha.\n") }
        model.open(Uri.fromFile(savedFileA))
        idleUntil { model.state.value.active.uri == Uri.fromFile(savedFileA).toString() }
        val noteAId = model.state.value.active.id
        assertEquals("live", model.state.value.mode)
        assertEquals(110f, model.state.value.zoom, 0.01f)

        // Explicitly customize Note A mode + normal and fullscreen zoom.
        model.mode("reader")
        model.zoom(165f)
        model.fullscreen(true)
        assertEquals(165f, model.state.value.zoom, 0.01f)
        model.zoom(215f)
        assertEquals(215f, model.state.value.zoom, 0.01f)
        model.fullscreen(false)
        assertEquals("reader", model.state.value.mode)
        assertEquals(165f, model.state.value.zoom, 0.01f)
        assertEquals("live", model.state.value.defaultMode)
        assertEquals(110f, model.state.value.defaultNormalZoom, 0.01f)
        assertEquals(120f, model.state.value.defaultFullscreenZoom, 0.01f)

        // Create unsaved Draft B -> starts with configured defaults, then takes explicit overrides.
        model.newNote()
        val draftBId = model.state.value.active.id
        assertEquals("live", model.state.value.mode)
        assertEquals(110f, model.state.value.zoom, 0.01f)
        model.edit(draftBId, "# Draft B\n\nUnsaved draft body.\n")
        model.mode("editor")
        model.zoom(145f)
        assertEquals("editor", model.state.value.mode)
        assertEquals(145f, model.state.value.zoom, 0.01f)

        // Switch between Note A and Draft B using select, cycle, and tabNumber.
        model.select(noteAId)
        assertEquals("reader", model.state.value.mode)
        assertEquals(165f, model.state.value.zoom, 0.01f)

        model.select(draftBId)
        assertEquals("editor", model.state.value.mode)
        assertEquals(145f, model.state.value.zoom, 0.01f)

        model.cycle(-1)
        assertEquals(noteAId, model.state.value.activeId)
        assertEquals("reader", model.state.value.mode)
        assertEquals(165f, model.state.value.zoom, 0.01f)

        // Create a brand-new Note C and open an unconfigured saved Note D -> both use configured defaults.
        model.newNote()
        val noteCId = model.state.value.active.id
        assertEquals("live", model.state.value.mode)
        assertEquals(110f, model.state.value.zoom, 0.01f)

        val savedFileD = File(tempRoot, "NoteD.md").apply { writeText("# Note D\n\nFresh saved note.\n") }
        model.open(Uri.fromFile(savedFileD))
        idleUntil { model.state.value.active.uri == Uri.fromFile(savedFileD).toString() }
        assertEquals("live", model.state.value.mode)
        assertEquals(110f, model.state.value.zoom, 0.01f)

        // Updating configured defaults updates un-overridden tabs and new notes without touching Note A or Draft B.
        model.defaultView(mode = "split", normalZoom = 125f)
        assertEquals("split", model.state.value.mode)
        assertEquals(125f, model.state.value.zoom, 0.01f)

        model.select(noteCId)
        assertEquals("split", model.state.value.mode)
        assertEquals(125f, model.state.value.zoom, 0.01f)

        model.select(noteAId)
        assertEquals("reader", model.state.value.mode)
        assertEquals(165f, model.state.value.zoom, 0.01f)

        model.select(draftBId)
        assertEquals("editor", model.state.value.mode)
        assertEquals(145f, model.state.value.zoom, 0.01f)
    }

    @Test
    fun readerBridgeZoomChangedUpdatesOutgoingNoteIdAndPersistsAcrossSaveRenameCloseAndRecovery() {
        val workspaceKey = "persist-${System.nanoTime()}".also(workspaceKeys::add)
        val model = newModel(workspaceKey)
        model.defaultView(mode = "live", normalZoom = 105f, fullscreenZoom = 115f)

        val alphaFile = File(tempRoot, "Alpha.md").apply { writeText("# Alpha\n\nSaved alpha.\n") }
        model.open(Uri.fromFile(alphaFile))
        idleUntil { model.state.value.active.uri == Uri.fromFile(alphaFile).toString() }
        val alphaId = model.state.value.active.id
        model.mode("reader")
        model.zoom(155f)

        model.newNote()
        val betaDraftId = model.state.value.active.id
        model.edit(betaDraftId, "# Beta Draft\n\nUnsaved work.\n")
        model.mode("split")
        model.zoom(135f)

        // Post zoom_changed via ReaderBridge with explicit outgoing alphaId while betaDraftId is active.
        val scripts = mutableListOf<String>()
        val web = object : WebView(app) {
            override fun post(action: Runnable?): Boolean =
                action?.let { android.os.Handler(Looper.getMainLooper()).post(it) } ?: false

            override fun evaluateJavascript(script: String, resultCallback: android.webkit.ValueCallback<String>?) {
                scripts += script
                resultCallback?.onReceiveValue("null")
            }
        }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate).also(scopes::add)
        val bridge = ReaderBridge(web, model, scope, ready = {}, assetCapabilities = ReaderAssetCapabilities())

        bridge.post("outgoing-zoom", "zoom_changed", """{"id":"$alphaId","zoom":180,"fullscreen":false}""")
        idleUntil { scripts.any { it.contains("\"outgoing-zoom\"") } }
        assertEquals("split", model.state.value.mode)
        assertEquals(135f, model.state.value.zoom, 0.01f)

        model.select(alphaId)
        assertEquals("reader", model.state.value.mode)
        assertEquals(180f, model.state.value.zoom, 0.01f)

        // Close and reopen Beta Draft -> ClosedNoteStore preserves its explicit mode and zoom.
        model.close(betaDraftId)
        idleUntil { model.state.value.tabs.none { it.id == betaDraftId } && model.state.value.closedTabs.isNotEmpty() }
        model.reopen()
        idleUntil { model.state.value.active.content.contains("Beta Draft") }
        val reopenedBetaId = model.state.value.active.id
        assertEquals("split", model.state.value.mode)
        assertEquals(135f, model.state.value.zoom, 0.01f)

        // Save reopened Beta Draft to disk and create another unsaved Gamma Draft.
        val betaSavedFile = File(tempRoot, "BetaSaved.md").apply { writeText("") }
        model.save(Uri.fromFile(betaSavedFile))
        idleUntil { model.state.value.tabs.first { it.id == reopenedBetaId }.uri == Uri.fromFile(betaSavedFile).toString() }

        model.newNote()
        val gammaDraftId = model.state.value.active.id
        model.edit(gammaDraftId, "# Gamma Draft\n\nUnsaved gamma.\n")
        model.mode("editor")
        model.zoom(150f)

        // Remap Alpha URI (simulating file/folder rename) -> noteViewStates remaps cleanly.
        val alphaRenamedFile = File(tempRoot, "AlphaRenamed.md")
        alphaFile.renameTo(alphaRenamedFile)
        model.applyUriRemaps(
            listOf(
                UriRemap(
                    oldUri = Uri.fromFile(alphaFile).toString(),
                    newUri = Uri.fromFile(alphaRenamedFile).toString(),
                    newName = "AlphaRenamed.md",
                ),
            ),
        )

        runBlocking { model.flushRecoveryAndAwait() }

        // Recreate StudioViewModel on the same workspaceKey -> restores per-note view overrides & defaults.
        val restored = newModel(workspaceKey)
        idleUntil { restored.state.value.tabs.size >= 3 }

        val restoredAlpha = restored.state.value.tabs.first { it.name == "AlphaRenamed.md" }
        val restoredBeta = restored.state.value.tabs.first { it.name == "BetaSaved.md" }
        val restoredGamma = restored.state.value.tabs.first { it.id == gammaDraftId }

        restored.select(restoredAlpha.id)
        assertEquals("reader", restored.state.value.mode)
        assertEquals(180f, restored.state.value.zoom, 0.01f)

        restored.select(restoredBeta.id)
        assertEquals("split", restored.state.value.mode)
        assertEquals(135f, restored.state.value.zoom, 0.01f)

        restored.select(restoredGamma.id)
        assertEquals("editor", restored.state.value.mode)
        assertEquals(150f, restored.state.value.zoom, 0.01f)

        restored.newNote()
        assertEquals("live", restored.state.value.mode)
        assertEquals(105f, restored.state.value.zoom, 0.01f)
    }
}
