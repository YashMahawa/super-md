package dev.supermd.studio

import android.net.Uri
import android.os.Looper
import android.util.Base64
import kotlinx.coroutines.Job
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.io.File
import java.nio.file.Files
import java.time.Duration
import java.util.UUID

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

    @Test fun refreshExternalReloadsCleanPortableNoteDeletesOldCacheAndAvoidsLeaks() {
        val app = RuntimeEnvironment.getApplication()
        val bundlesRoot = File(app.filesDir, "portable-assets")
        val baselineDirs = bundlesRoot.listFiles()?.map { it.name }?.toSet().orEmpty()
        val tempDir = Files.createTempDirectory("android-smd-refresh").toFile()
        val model = newTestModel()
        val capabilities = ReaderAssetCapabilities()
        model.attachReaderCapabilities(capabilities)
        try {
            val file = File(tempDir, "refresh.smd")
            file.outputStream().use { model.media.writeFmd(it, "# Version 1\n\n![Fig](assets/fig.svg)\n", svgAssets("assets/fig.svg", svgA)) }
            awaitJob(model.open(Uri.fromFile(file)))

            val noteId = model.state.value.active.id
            val initialDir = model.state.value.active.assetDirectory!!
            assertTrue(File(bundlesRoot, initialDir).isDirectory)

            // 1. Refreshing an unchanged .smd archive keeps the current directory and cleans up its temporary extraction.
            model.refreshExternal()
            Thread.sleep(280)
            pumpMainLooper(300)
            assertEquals(initialDir, model.state.value.active.assetDirectory)
            awaitCondition {
                bundlesRoot.listFiles()?.map { it.name }?.toSet().orEmpty() == baselineDirs + initialDir
            }

            // 2. Updating only an embedded asset externally reloads assetDirectory, invalidates reader assets, and deletes initialDir.
            val staleCapability = capabilities.register(noteId, "assets/fig.svg", "image/svg+xml", "fp-1")!!
            file.outputStream().use { model.media.writeFmd(it, "# Version 1\n\n![Fig](assets/fig.svg)\n", svgAssets("assets/fig.svg", svgB)) }
            model.refreshExternal()
            awaitCondition { model.state.value.active.assetDirectory != initialDir }

            val assetUpdatedDir = model.state.value.active.assetDirectory!!
            assertArrayEquals(svgB, model.media.local("assets/fig.svg", assetUpdatedDir)!!.readBytes())
            assertNull(capabilities.lookup(staleCapability.token) { true })
            awaitCondition {
                !File(bundlesRoot, initialDir).exists() &&
                    bundlesRoot.listFiles()?.map { it.name }?.toSet().orEmpty() == baselineDirs + assetUpdatedDir
            }

            // 3. Updating Markdown + asset externally with rapid consecutive refresh notifications adopts the latest archive without leaking.
            file.outputStream().use { model.media.writeFmd(it, "# Version 2\n\n![Fig](assets/fig.svg)\n", svgAssets("assets/fig.svg", svgA)) }
            model.refreshExternal()
            Thread.sleep(220)
            model.refreshExternal()
            awaitCondition { model.state.value.active.content == "# Version 2\n\n![Fig](assets/fig.svg)\n" }

            val reloadedDir = model.state.value.active.assetDirectory!!
            assertNotEquals(assetUpdatedDir, reloadedDir)
            assertEquals("# Version 2\n\n![Fig](assets/fig.svg)\n", model.state.value.active.saved)
            assertArrayEquals(svgA, model.media.local("assets/fig.svg", reloadedDir)!!.readBytes())
            awaitCondition {
                !File(bundlesRoot, assetUpdatedDir).exists() &&
                    bundlesRoot.listFiles()?.map { it.name }?.toSet().orEmpty() == baselineDirs + reloadedDir
            }

            // 4. Local edits arriving after refresh starts abort adoption and delete any temporary extracted directory.
            file.outputStream().use { model.media.writeFmd(it, "# Version 3\n\n![Fig](assets/fig.svg)\n", svgAssets("assets/fig.svg", svgB)) }
            model.refreshExternal()
            Thread.sleep(220)
            model.edit(noteId, "# Unsaved local draft\n")
            Thread.sleep(250)
            pumpMainLooper(300)

            assertEquals("# Unsaved local draft\n", model.state.value.active.content)
            assertEquals(reloadedDir, model.state.value.active.assetDirectory)
            awaitCondition {
                bundlesRoot.listFiles()?.map { it.name }?.toSet().orEmpty() == baselineDirs + reloadedDir
            }
        } finally {
            model.detachReaderCapabilities(capabilities)
            model.state.value.tabs.mapNotNull { it.assetDirectory }.forEach {
                File(bundlesRoot, it).deleteRecursively()
            }
            tempDir.deleteRecursively()
        }
    }
}
