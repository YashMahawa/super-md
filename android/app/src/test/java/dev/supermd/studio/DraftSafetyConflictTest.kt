package dev.supermd.studio

import android.app.Application
import android.net.Uri
import android.os.Looper
import android.util.Base64
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.StringReader
import java.io.StringWriter
import java.nio.file.Files
import java.time.Duration
import java.util.UUID
import javax.imageio.ImageIO
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class DraftSafetyConflictTest {
    private fun makePngDataUrl(rgb: Int): String {
        val image = BufferedImage(2, 2, BufferedImage.TYPE_INT_ARGB).apply {
            setRGB(0, 0, rgb)
            setRGB(1, 1, rgb)
        }
        val bytes = ByteArrayOutputStream().also { ImageIO.write(image, "png", it) }.toByteArray()
        return "data:image/png;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
    }

    private val pngOne = makePngDataUrl(0xFF2266CC.toInt())
    private val pngTwo = makePngDataUrl(0xFFCC4422.toInt())

    private fun waitUntil(timeoutMs: Long = 5_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        val mainLooper = shadowOf(Looper.getMainLooper())
        while (System.currentTimeMillis() < deadline) {
            mainLooper.idleFor(Duration.ofMillis(50))
            if (condition()) return
            Thread.sleep(15)
        }
        mainLooper.idleFor(Duration.ofMillis(50))
        assertTrue("Timed out waiting for condition", condition())
    }

    private fun withWorkspace(block: (Application, File, StudioViewModel) -> Unit) {
        val app = RuntimeEnvironment.getApplication()
        val temp = Files.createTempDirectory("draft-safety-test").toFile()
        val key = "test-${UUID.randomUUID()}"
        val store = androidx.lifecycle.ViewModelStore()
        val factory = object : androidx.lifecycle.ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : androidx.lifecycle.ViewModel> create(modelClass: Class<T>): T = StudioViewModel(app, workspaceKey = key) as T
        }
        val model = androidx.lifecycle.ViewModelProvider(store, factory)[StudioViewModel::class.java]
        try {
            model.reading(autosave = false)
            block(app, temp, model)
        } finally {
            store.clear()
            File(app.filesDir, "workspaces/$key.json").deleteRecursively()
            File(app.filesDir, "workspaces/$key").deleteRecursively()
            temp.deleteRecursively()
        }
    }

    @Test
    fun noteRecoveryAndClosedNoteStorePreserveAssetsDirty() {
        val temp = Files.createTempDirectory("assets-dirty-store").toFile()
        try {
            val dirtyAssetNote = Note(
                id = "asset-note",
                name = "Figures.smd",
                uri = "file:///tmp/Figures.smd",
                content = "# Figures\n",
                saved = "# Figures\n",
                assetDirectory = "00000000-0000-0000-0000-000000000001",
                assetsDirty = true,
            )
            assertTrue(dirtyAssetNote.dirty)
            assertTrue(dirtyAssetNote.requiresCloseConfirmation)

            val writer = StringWriter()
            NoteRecovery.write(writer, StudioState(tabs = listOf(dirtyAssetNote), activeId = dirtyAssetNote.id))
            val restoredState = NoteRecovery.read(StringReader(writer.toString()), StudioState())
            assertTrue(restoredState.tabs.single().assetsDirty)
            assertTrue(restoredState.tabs.single().dirty)

            val store = ClosedNoteStore(File(temp, "closed"))
            val ref = store.save(dirtyAssetNote)
            val loaded = store.load(ref)
            assertEquals(dirtyAssetNote, loaded)
            assertTrue(loaded.assetsDirty)
        } finally {
            temp.deleteRecursively()
        }
    }

    @Test
    fun interactiveClosePromptsOnDirtyTabAndDiscardPreservesClosedSnapshotAcrossRestart() = withWorkspace { app, temp, model ->
        val file = File(temp, "Lecture.md").apply { writeText("# Lecture\n", Charsets.UTF_8) }
        model.open(Uri.fromFile(file))
        waitUntil { model.state.value.active.uri == Uri.fromFile(file).toString() }
        val noteId = model.state.value.active.id

        model.edit(noteId, "# Lecture\n\nUnsaved proof.\n")
        assertTrue(model.state.value.active.dirty)

        // Interactive close must open confirmation dialog instead of closing immediately.
        model.requestClose(noteId)
        waitUntil { model.state.value.pendingCloseNoteId == noteId }
        assertTrue(model.state.value.tabs.any { it.id == noteId })

        // Cancel keeps the tab open and dirty.
        model.resolveCloseConfirmation("cancel")
        assertNull(model.state.value.pendingCloseNoteId)
        assertTrue(model.state.value.tabs.any { it.id == noteId })

        // Discard closes the tab AND preserves a snapshot in closed-tab history.
        model.requestClose(noteId)
        waitUntil { model.state.value.pendingCloseNoteId == noteId }
        model.resolveCloseConfirmation("discard")
        waitUntil {
            model.state.value.tabs.none { it.id == noteId } &&
                model.state.value.closedTabs.firstOrNull()?.id == noteId
        }
        assertEquals("# Lecture\n", file.readText(Charsets.UTF_8))

        // Reopen restores the most recently closed draft and persists removal across restart.
        model.reopen()
        waitUntil { model.state.value.active.id == noteId }
        assertEquals("# Lecture\n\nUnsaved proof.\n", model.state.value.active.content)
        waitUntil {
            ClosedNoteStore(File(app.filesDir, "workspaces/${model.workspaceKey}/closed-notes"))
                .loadIndex()
                .none { it.id == noteId }
        }

        // Choosing Save in the close confirmation writes changes and closes the tab.
        model.requestClose(noteId)
        waitUntil { model.state.value.pendingCloseNoteId == noteId }
        model.resolveCloseConfirmation("save")
        waitUntil { model.state.value.tabs.none { it.id == noteId } }
        assertEquals("# Lecture\n\nUnsaved proof.\n", file.readText(Charsets.UTF_8))
    }

    @Test
    fun externalMarkdownEditPausesAutosaveSurfacesInlineConflictWithoutModalAndGuardsManualSave() = withWorkspace { _, temp, model ->
        val file = File(temp, "Notes.md").apply { writeText("# Baseline\n", Charsets.UTF_8) }
        model.open(Uri.fromFile(file))
        waitUntil { model.state.value.active.uri == Uri.fromFile(file).toString() }
        val noteId = model.state.value.active.id

        model.reading(autosave = true)
        model.edit(noteId, "# Local draft\n")
        // Modify file externally before autosave fires.
        file.writeText("# External edit\n", Charsets.UTF_8)

        model.refreshExternal()
        waitUntil { model.state.value.activeConflicted }
        assertNull("Conflict detection must not surface a blocking error modal", model.state.value.error)
        assertEquals("# External edit\n", file.readText(Charsets.UTF_8))

        // Typing further while conflicted must keep autosave paused and never show an error dialog.
        model.edit(noteId, "# Local draft with more typing\n")
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(1_200))
        Thread.sleep(100)
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals("# External edit\n", file.readText(Charsets.UTF_8))
        assertNull(model.state.value.error)
        assertTrue(model.state.value.activeConflicted)

        // Guarded manual Save blocks overwrite and prompts resolution.
        model.saveManual()
        waitUntil { model.state.value.pendingSaveConflictNoteId == noteId }
        assertEquals("# External edit\n", file.readText(Charsets.UTF_8))
        assertNull(model.state.value.error)

        // Cancel leaves conflict active and disk untouched.
        model.resolveSaveConflict("cancel")
        assertNull(model.state.value.pendingSaveConflictNoteId)
        assertEquals("# External edit\n", file.readText(Charsets.UTF_8))
        assertTrue(model.state.value.activeConflicted)

        // Overwrite writes local draft and clears conflict + dirty state.
        model.saveManual()
        waitUntil { model.state.value.pendingSaveConflictNoteId == noteId }
        model.resolveSaveConflict("overwrite")
        waitUntil { !model.state.value.activeConflicted && !model.state.value.active.dirty }
        assertEquals("# Local draft with more typing\n", file.readText(Charsets.UTF_8))
    }

    @Test
    fun portableSmdAssetConflictReloadAndSaveAsRebinding() = withWorkspace { _, temp, model ->
        val originalSmd = File(temp, "Study.smd")
        originalSmd.outputStream().use { out ->
            model.media.writeFmd(out, "# Portable study\n\n![one](assets/fig.png)\n", JSONObject().put("assets/fig.png", pngOne))
        }
        model.open(Uri.fromFile(originalSmd))
        waitUntil { model.state.value.active.uri == Uri.fromFile(originalSmd).toString() }
        val noteId = model.state.value.active.id
        assertTrue(model.state.value.active.portable)

        // User edits text locally while external writer updates only the embedded asset in Study.smd.
        model.edit(noteId, "# Portable study\n\nLocal edit\n\n![one](assets/fig.png)\n")
        originalSmd.outputStream().use { out ->
            model.media.writeFmd(out, "# Portable study\n\n![one](assets/fig.png)\n", JSONObject().put("assets/fig.png", pngTwo))
        }

        // Guarded manual Save detects embedded asset conflict and blocks overwrite.
        model.saveManual()
        waitUntil { model.state.value.pendingSaveConflictNoteId == noteId }
        assertTrue(model.state.value.activeConflicted)
        assertNull(model.state.value.error)

        // Save As to a new .smd file writes text + portable assets, rebinds the tab, and clears conflict.
        val copySmd = File(temp, "Study copy.smd")
        var requestedSaveAsNote: Note? = null
        model.requestSaveAs = { requestedSaveAsNote = it }
        model.resolveSaveConflict("save_as")
        waitUntil { requestedSaveAsNote != null }
        assertEquals(noteId, requestedSaveAsNote!!.id)

        model.completePortableSaveAs(Uri.fromFile(copySmd), noteId)
        waitUntil {
            model.state.value.active.uri == Uri.fromFile(copySmd).toString() &&
                !model.state.value.active.dirty &&
                !model.state.value.activeConflicted
        }
        assertEquals("Study copy.smd", model.state.value.active.name)

        // Verify original file kept external asset (pngTwo) while rebound copy saved local text + asset (pngOne).
        val origOpened = originalSmd.inputStream().use(model.media::openFmd)
        val copyOpened = copySmd.inputStream().use(model.media::openFmd)
        try {
            assertEquals(pngTwo, model.media.portableAssets(origOpened.directory).getString("assets/fig.png"))
            assertEquals("# Portable study\n\nLocal edit\n\n![one](assets/fig.png)\n", copyOpened.markdown)
            assertEquals(pngOne, model.media.portableAssets(copyOpened.directory).getString("assets/fig.png"))
        } finally {
            File(RuntimeEnvironment.getApplication().filesDir, "portable-assets/${origOpened.directory}").deleteRecursively()
            File(RuntimeEnvironment.getApplication().filesDir, "portable-assets/${copyOpened.directory}").deleteRecursively()
        }

        // Reload from disk on a conflicted tab restores external content and clears conflict.
        model.edit(noteId, "# Diverged again\n")
        copySmd.outputStream().use { out ->
            model.media.writeFmd(out, "# Updated externally\n", JSONObject().put("assets/fig.png", pngTwo))
        }
        model.refreshExternal()
        waitUntil { model.state.value.activeConflicted }
        model.reloadFromDisk(noteId)
        waitUntil { !model.state.value.activeConflicted && !model.state.value.active.dirty }
        assertEquals("# Updated externally\n", model.state.value.active.content)
        assertNotNull(model.state.value.active.assetDirectory)
    }

    @Test
    fun markdownSaveAsRebindsTabAndClearsConflict() = withWorkspace { _, temp, model ->
        val originalMd = File(temp, "Draft.md").apply { writeText("v1\n", Charsets.UTF_8) }
        val copyMd = File(temp, "Draft copy.md")
        model.open(Uri.fromFile(originalMd))
        waitUntil { model.state.value.active.uri == Uri.fromFile(originalMd).toString() }
        val noteId = model.state.value.active.id

        model.edit(noteId, "local v2\n")
        originalMd.writeText("external v2\n", Charsets.UTF_8)
        model.refreshExternal()
        waitUntil { model.state.value.activeConflicted }

        model.save(Uri.fromFile(copyMd))
        waitUntil {
            model.state.value.active.uri == Uri.fromFile(copyMd).toString() &&
                !model.state.value.active.dirty &&
                !model.state.value.activeConflicted
        }
        assertEquals("Draft copy.md", model.state.value.active.name)
        assertEquals("external v2\n", originalMd.readText(Charsets.UTF_8))
        assertEquals("local v2\n", copyMd.readText(Charsets.UTF_8))
    }
}
