package dev.supermd.studio

import android.app.Application
import android.net.Uri
import android.os.Looper
import androidx.lifecycle.ViewModelStore
import java.io.File
import java.nio.file.Files
import java.time.Duration
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
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
class StudioSettingsAndProtocolCoordinatorTest {
    private lateinit var app: Application
    private lateinit var tempDir: File
    private val stores = mutableListOf<ViewModelStore>()
    private val keys = mutableListOf<String>()

    @Before fun setUp() {
        app = RuntimeEnvironment.getApplication()
        tempDir = Files.createTempDirectory("settings-protocol-test").toFile()
        File(app.filesDir, "reader-conflicts").deleteRecursively()
        File(app.filesDir, "derived-python").deleteRecursively()
        File(app.cacheDir, "derived-python").deleteRecursively()
    }

    @After fun tearDown() {
        stores.forEach { it.clear() }
        tempDir.deleteRecursively()
        app.getSharedPreferences("studio", 0).edit().clear().commit()
        File(app.filesDir, "reader-conflicts").deleteRecursively()
        File(app.filesDir, "derived-python").deleteRecursively()
        File(app.cacheDir, "derived-python").deleteRecursively()
        keys.forEach { k ->
            File(app.filesDir, "workspaces/$k.json").delete()
            File(app.filesDir, "workspaces/$k").deleteRecursively()
            app.deleteSharedPreferences("studio-window-$k")
        }
    }

    private fun newModel(key: String = "sp-${UUID.randomUUID()}".also(keys::add)): StudioViewModel =
        StudioViewModel(app, key).also {
            it.readerFlushStatusRequester = { ReaderFlushStatus.ACKNOWLEDGED }
            ViewModelStore().also(stores::add).put("vm", it)
        }

    private fun await(predicate: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 5_000L
        while (System.currentTimeMillis() < deadline && !predicate()) {
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(25))
            Thread.sleep(10)
        }
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(25))
        assertTrue("Condition timed out", predicate())
    }

    @Test fun coldRestoreSettingsPreferencesZoomOverlayModeAndStorageCleanupWorkEndToEnd() {
        val prefs = app.getSharedPreferences("studio", 0)
        prefs.edit().putString("patternKind", "dots").putFloat("patternOpacity", 0.12f).putBoolean("centerLock", false)
            .putBoolean("restorePosition", true).putFloat("imageContrast", 1.5f).commit()

        val model = newModel()
        assertEquals("dots", model.state.value.patternKind)
        assertEquals(0.12f, model.state.value.patternOpacity, 0.001f)
        assertFalse(model.state.value.centerLock)
        assertEquals(1.5f, model.state.value.imageContrast, 0.001f)

        model.appearance(accent = "cobalt", theme = "dark", fullTheme = "black", motion = false, font = "Inter", size = 18f)
        model.appearance(size = 99f) // out-of-range ignored
        model.reading(widthPercent = 200f, lineHeight = 1.0f, autosave = false)
        model.writing(spellCheck = true, grammarCheck = true)
        model.themeBackgroundPreference("patternSize", 24f)
        model.themeBackgroundPreference("patternOpacity", 0.9f) // out-of-range ignored
        model.latexAutofix(true); model.typewriterScroll(true); model.overlay(open = true, image = true)
        model.editorFocus(true); model.zoom(140f); model.fullscreen(true); model.readerZoom(180f, fullscreen = true)
        await {
            val s = model.state.value
            s.theme == "dark" && s.size == 18f && s.widthPercent == 150f && s.lineHeight == 1.15f && !s.autosave &&
                s.spellCheck && s.grammarCheck && s.patternSize == 24f && s.patternOpacity == 0.12f &&
                s.latexAutofix && s.typewriterScroll && s.readerOverlay && model.imageOverlay.value &&
                s.normalZoom == 140f && s.fullscreen && s.fullscreenZoom == 180f && s.editorFocused
        }

        model.mode("reader")
        await { model.state.value.mode == "reader" && !model.state.value.editorFocused }
        model.resetThemeBackground()
        await { model.state.value.patternKind.isEmpty() && model.state.value.patternSize == 0f }

        val noteFile = File(tempDir, "Pos.md").apply { writeText("# Position\n") }
        val noteUri = Uri.fromFile(noteFile)
        model.openDocument(noteUri)
        await { model.state.value.active.uri == noteUri.toString() }
        model.readingPosition(model.state.value.active.id, JSONObject().put("top", 64.0).put("offset", 12.0).put("zoom", 110.0).put("mode", "live"))
        assertEquals(64.0, model.readingLocation(noteUri.toString())!!.getDouble("top"), 0.01)

        File(app.filesDir, "derived-python").apply { mkdirs(); File(this, "plot.png").writeBytes(ByteArray(32)) }
        model.inspectStorage()
        await { !model.state.value.storageScanning && model.state.value.storageReport?.executionResults?.files == 1 }
        model.clearPythonStorage()
        await { !model.state.value.storageScanning && model.state.value.storageReport?.executionResults?.files == 0 }
        assertTrue(model.state.value.message?.contains("Cleared 1 temporary Python result files") == true)
        assertNull(model.state.value.error)
    }

    @Test fun outlineDraftTitlesAndReaderProtocolConflictRecoveryPersistCleanly() {
        val model = newModel()
        model.reading(autosave = false)
        model.newNote()
        await { model.state.value.active.name == "Untitled.md" }
        val mdId = model.state.value.active.id
        model.outline(mdId, JSONArray().put(JSONObject().put("id", "h1").put("title", "  Clean: Title?*  ").put("level", 9).put("offset", -4)))
        assertEquals("Clean Title.md", model.state.value.active.name)
        assertEquals(mdId, model.lastOutlineNoteId)
        assertEquals(6, model.headings.value.single().level)
        assertEquals(0, model.headings.value.single().offset)

        model.newNote(format = "smd")
        await { model.state.value.active.name == "Untitled.smd" }
        val smdId = model.state.value.active.id
        model.edit(smdId, "# Seed")
        model.outline(smdId, JSONArray().put(JSONObject().put("id", "s1").put("title", "Portable <Draft>.").put("level", 1).put("offset", 0)))
        assertEquals("Portable Draft.smd", model.state.value.active.name)
        assertEquals(smdId, model.lastOutlineNoteId)

        assertTrue(model.readerSync(smdId, "ep-1", 0L, "# Seed").getBoolean("accepted"))
        assertTrue(model.readerPatch(smdId, "ep-1", 0L, 1L, listOf(ReaderEditChange(6, 6, "\nBody"))).getBoolean("accepted"))
        assertEquals("# Seed\nBody", model.state.value.active.content)
        assertTrue(model.readerStateIsNativeAuthoritative(smdId))

        val conflict = model.readerResync(smdId, "ep-2", 0L, listOf("# StaleBase"), "# Conflicting reader text")
        assertFalse(conflict.getBoolean("accepted"))
        model.preserveMalformedReaderResync(smdId, "# Malformed envelope draft")
        val conflictDir = File(app.filesDir, "reader-conflicts")
        await {
            (conflictDir.listFiles { f -> f.extension == "json" }?.size ?: 0) == 2 &&
                model.state.value.error != null
        }
        val payloads = conflictDir.listFiles { f -> f.extension == "json" }!!.map { JSONObject(it.readText()).getString("content") }.toSet()
        assertEquals(setOf("# Conflicting reader text", "# Malformed envelope draft"), payloads)
        assertEquals("Reader edits conflicted with newer native content. A private recovery copy was saved.", model.state.value.error)

        conflictDir.deleteRecursively()
        repeat(8) { index -> model.preserveMalformedReaderResync(smdId, "# Concurrent draft $index") }
        await { (conflictDir.listFiles { f -> f.extension == "json" }?.size ?: 0) == 8 }
    }
}
