package dev.supermd.studio

import android.net.Uri
import android.os.Looper
import android.util.Base64
import android.view.KeyEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.io.File
import java.nio.file.Files
import java.time.Duration
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class PortableAgentSaveSafetyTest {
    private val svgA = "<svg xmlns='http://www.w3.org/2000/svg'><circle r='3'/></svg>".toByteArray(Charsets.UTF_8)
    private val svgB = "<svg xmlns='http://www.w3.org/2000/svg'><rect width='5' height='5'/></svg>".toByteArray(Charsets.UTF_8)
    private val originalAssets = JSONObject().put("assets/figure.png", "data:image/png;base64,AA==")
    private val note = Note(
        id = "portable-note",
        name = "Research.smd",
        uri = "content://provider/document/1",
        content = "# Current draft\n",
        saved = "# Saved on disk\n",
        assetDirectory = "00000000-0000-0000-0000-000000000001",
    )

    private fun svgAssets(name: String, bytes: ByteArray): JSONObject =
        JSONObject().put(name, "data:image/svg+xml;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP))

    private fun newTestModel(): StudioViewModel {
        val app = RuntimeEnvironment.getApplication()
        return StudioViewModel(app, UUID.randomUUID().toString()).apply {
            reading(autosave = false)
            readerFlushRequester = { true }
        }
    }

    private fun pumpMainLooper(advanceMs: Long = 20) {
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(advanceMs))
        shadowOf(Looper.getMainLooper()).idle()
    }

    private fun awaitJob(job: Job, timeoutMs: Long = 5_000) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (!job.isCompleted && System.currentTimeMillis() < deadline) {
            pumpMainLooper(20)
            Thread.sleep(10)
        }
        pumpMainLooper(20)
        assertTrue("Job did not complete within ${timeoutMs}ms", job.isCompleted)
    }

    private fun <T> runWithMainLooper(block: suspend () -> T): Result<T> {
        val outcome = AtomicReference<Result<T>?>(null)
        val job = CoroutineScope(Dispatchers.Default).launch {
            outcome.set(runCatching { block() })
        }
        awaitJob(job)
        return outcome.get() ?: error("Suspend block did not record a result")
    }

    private fun awaitCondition(timeoutMs: Long = 5_000, predicate: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (!predicate() && System.currentTimeMillis() < deadline) {
            pumpMainLooper(25)
            Thread.sleep(15)
        }
        pumpMainLooper(25)
        assertTrue("Condition did not complete before timeout", predicate())
    }

    @Test fun portableSaveRequiresCurrentRevisionSourceAndEveryAssetToMatch() {
        val revision = agentContentRevision(note.content)
        assertTrue(portableSaveSnapshotMatches(note, revision, note.saved, originalAssets, JSONObject(originalAssets.toString())))
        assertFalse(portableSaveSnapshotMatches(note, "0".repeat(64), note.saved, originalAssets, JSONObject(originalAssets.toString())))
        assertFalse(portableSaveSnapshotMatches(note, revision, "# Externally changed\n", originalAssets, JSONObject(originalAssets.toString())))
        assertFalse(portableSaveSnapshotMatches(note, revision, note.saved, originalAssets, JSONObject().put("assets/figure.png", "data:image/png;base64,BB==")))
        assertFalse(portableSaveSnapshotMatches(note, revision, note.saved, originalAssets, JSONObject()))
    }

    @Test fun recoveryRestoresOnlyBytesThatStillMatchThisSaveAttempt() {
        val backup = "original portable bytes".toByteArray()
        val staged = "our staged portable bytes".toByteArray()
        val concurrent = "newer bytes from another writer".toByteArray()
        val concurrentBefore = concurrent.copyOf()

        assertEquals(PortableSaveRecovery.ORIGINAL_INTACT, portableSaveRecovery(backup, backup, staged))
        assertEquals(PortableSaveRecovery.RESTORE_OUR_WRITE, portableSaveRecovery(staged, backup, staged))
        assertEquals(PortableSaveRecovery.LEAVE_CONCURRENT_BYTES, portableSaveRecovery(concurrent, backup, staged))
        assertArrayEquals("The external writer's bytes are not altered by the recovery decision", concurrentBefore, concurrent)
    }

    @Test fun mainActivityShortcutsRouteCtrlSAndCtrlShiftSToSaveAndSaveAs() {
        val controller = Robolectric.buildActivity(MainActivity::class.java)
        val activity = controller.get()
        var saves = 0
        var saveAsCalls = 0
        activity.saveNote = { saves++ }
        activity.saveNoteAs = { saveAsCalls++ }

        val ctrlS = KeyEvent(0L, 0L, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_S, 0, KeyEvent.META_CTRL_ON)
        assertTrue(activity.handleShortcut(ctrlS))
        assertEquals(1, saves)
        assertEquals(0, saveAsCalls)

        val ctrlShiftS = KeyEvent(0L, 0L, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_S, 0, KeyEvent.META_CTRL_ON or KeyEvent.META_SHIFT_ON)
        assertTrue(activity.handleShortcut(ctrlShiftS))
        assertEquals(1, saves)
        assertEquals(1, saveAsCalls)
    }

    @Test fun manualMarkdownSaveBlocksExternalEditAndMissingFileWhileSaveAsUpdatesTabUri() {
        val tempDir = Files.createTempDirectory("android-md-conflict").toFile()
        val model = newTestModel()
        try {
            val original = File(tempDir, "notes.md").apply { writeText("# Original\n", Charsets.UTF_8) }
            awaitJob(model.open(Uri.fromFile(original)))
            val activeId = model.state.value.active.id
            model.edit(activeId, "# Local draft\n")

            original.writeText("# External edit\n", Charsets.UTF_8)
            var conflictError: String? = null
            awaitJob(model.save(onComplete = { conflictError = it }))
            assertEquals("# External edit\n", original.readText(Charsets.UTF_8))
            assertEquals("# Local draft\n", model.state.value.active.content)
            assertTrue(model.state.value.active.dirty)
            assertNotNull(conflictError)
            assertTrue(conflictError!!.contains("Save as"))

            assertTrue(original.delete())
            var missingError: String? = null
            awaitJob(model.save(onComplete = { missingError = it }))
            assertFalse("Missing file must not be recreated by in-place Save", original.exists())
            assertNotNull(missingError)
            assertTrue(missingError!!.contains("Save as"))

            val saveAsTarget = File(tempDir, "notes-copy.md")
            var saveAsError: String? = "pending"
            awaitJob(model.save(uri = Uri.fromFile(saveAsTarget), onComplete = { saveAsError = it }))
            assertEquals(null, saveAsError)
            assertEquals("# Local draft\n", saveAsTarget.readText(Charsets.UTF_8))
            assertEquals(Uri.fromFile(saveAsTarget).toString(), model.state.value.active.uri)
            assertEquals("notes-copy.md", model.state.value.active.name)
            assertFalse(model.state.value.active.dirty)
        } finally {
            tempDir.deleteRecursively()
        }
    }

    @Test fun manualPortableSaveBlocksExternalChangesAndSaveAsUpdatesTabUriAndAssets() {
        val tempDir = Files.createTempDirectory("android-smd-conflict").toFile()
        val model = newTestModel()
        try {
            val original = File(tempDir, "study.smd")
            original.outputStream().use { model.media.writeFmd(it, "# Baseline\n\n![Diagram](assets/fig.svg)\n", svgAssets("assets/fig.svg", svgA)) }
            awaitJob(model.open(Uri.fromFile(original)))
            val activeId = model.state.value.active.id
            val draft = "# Local draft\n\n![Diagram](assets/fig.svg)\n"
            model.edit(activeId, draft)

            // Modify only the embedded portable asset externally on disk.
            original.outputStream().use { model.media.writeFmd(it, "# Baseline\n\n![Diagram](assets/fig.svg)\n", svgAssets("assets/fig.svg", svgB)) }
            val failed = runWithMainLooper {
                model.writePortable(activeId, draft, svgAssets("assets/fig.svg", svgA), save = true, originalContent = draft)
            }
            assertTrue(failed.isFailure)
            assertTrue(failed.exceptionOrNull()?.message?.contains("Save as") == true)
            val diskAfterConflict = original.inputStream().use(model.media::openFmd)
            try {
                assertEquals("# Baseline\n\n![Diagram](assets/fig.svg)\n", diskAfterConflict.markdown)
                assertArrayEquals(svgB, model.media.local("assets/fig.svg", diskAfterConflict.directory)!!.readBytes())
            } finally {
                File(RuntimeEnvironment.getApplication().filesDir, "portable-assets/${diskAfterConflict.directory}").deleteRecursively()
            }

            // Missing file on disk also blocks silent in-place recreation.
            val missingCopy = File(tempDir, "deleted.smd")
            original.copyTo(missingCopy, overwrite = true)
            assertTrue(original.delete())
            val missingResult = runWithMainLooper {
                model.writePortable(activeId, draft, svgAssets("assets/fig.svg", svgA), save = true, originalContent = draft)
            }
            assertTrue(missingResult.isFailure)
            assertFalse(original.exists())
            missingCopy.copyTo(original, overwrite = true)

            // Save as writes to the new destination, updates tab URI/name/saved baseline, and leaves the original intact.
            val saveAsTarget = File(tempDir, "study-copy.smd")
            model.setPortableDestination(Uri.fromFile(saveAsTarget), saveAs = true)
            val succeeded = runWithMainLooper {
                model.writePortable(activeId, draft, svgAssets("assets/fig.svg", svgA), save = false, originalContent = draft)
            }
            assertTrue("Save as failed: ${succeeded.exceptionOrNull()}", succeeded.isSuccess)

            assertEquals(Uri.fromFile(saveAsTarget).toString(), model.state.value.active.uri)
            assertEquals("study-copy.smd", model.state.value.active.name)
            assertFalse(model.state.value.active.dirty)
            val savedOpened = saveAsTarget.inputStream().use(model.media::openFmd)
            try {
                assertEquals(draft, savedOpened.markdown)
                assertArrayEquals(svgA, model.media.local("assets/fig.svg", savedOpened.directory)!!.readBytes())
            } finally {
                File(RuntimeEnvironment.getApplication().filesDir, "portable-assets/${savedOpened.directory}").deleteRecursively()
            }
        } finally {
            tempDir.deleteRecursively()
        }
    }

    @Test fun refreshExternalReloadsCleanPortableNoteDeletesOldCacheAndAbortsWhenEdited() {
        val app = RuntimeEnvironment.getApplication()
        val tempDir = Files.createTempDirectory("android-smd-refresh").toFile()
        val model = newTestModel()
        try {
            val file = File(tempDir, "refresh.smd")
            file.outputStream().use { model.media.writeFmd(it, "# Version 1\n\n![Fig](assets/fig.svg)\n", svgAssets("assets/fig.svg", svgA)) }
            awaitJob(model.open(Uri.fromFile(file)))

            val initialDir = model.state.value.active.assetDirectory!!
            assertTrue(File(app.filesDir, "portable-assets/$initialDir").isDirectory)

            // Update both Markdown and asset externally while note is clean.
            file.outputStream().use { model.media.writeFmd(it, "# Version 2\n\n![Fig](assets/fig.svg)\n", svgAssets("assets/fig.svg", svgB)) }
            model.refreshExternal()
            awaitCondition { model.state.value.active.content == "# Version 2\n\n![Fig](assets/fig.svg)\n" }

            val reloadedDir = model.state.value.active.assetDirectory!!
            assertNotEquals(initialDir, reloadedDir)
            assertEquals("# Version 2\n\n![Fig](assets/fig.svg)\n", model.state.value.active.saved)
            assertArrayEquals(svgB, model.media.local("assets/fig.svg", reloadedDir)!!.readBytes())
            awaitCondition { !File(app.filesDir, "portable-assets/$initialDir").exists() }

            // Start another external refresh, but introduce a local edit during the debounce window:
            // refreshExternal must abort without clobbering the draft or leaking temporary asset directories.
            val beforeDirs = File(app.filesDir, "portable-assets").listFiles()?.map { it.name }?.toSet().orEmpty()
            file.outputStream().use { model.media.writeFmd(it, "# Version 3\n\n![Fig](assets/fig.svg)\n", svgAssets("assets/fig.svg", svgA)) }
            model.refreshExternal()
            model.edit(model.state.value.active.id, "# Unsaved local draft\n")
            Thread.sleep(320)
            pumpMainLooper(350)

            assertEquals("# Unsaved local draft\n", model.state.value.active.content)
            assertEquals(reloadedDir, model.state.value.active.assetDirectory)
            awaitCondition {
                File(app.filesDir, "portable-assets").listFiles()?.map { it.name }?.toSet().orEmpty() == beforeDirs
            }
        } finally {
            tempDir.deleteRecursively()
        }
    }
}
