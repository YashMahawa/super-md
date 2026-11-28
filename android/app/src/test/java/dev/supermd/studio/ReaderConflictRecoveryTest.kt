package dev.supermd.studio

import android.app.Application
import android.os.Looper
import androidx.lifecycle.ViewModelStore
import java.io.File
import java.nio.file.Files
import java.time.Duration
import java.util.UUID
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
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
class ReaderConflictRecoveryTest {
    private lateinit var app: Application
    private lateinit var outsideDir: File
    private val stores = mutableListOf<ViewModelStore>()
    private val keys = mutableListOf<String>()

    @Before
    fun setUp() {
        app = RuntimeEnvironment.getApplication()
        outsideDir = Files.createTempDirectory("reader-conflict-outside").toFile()
        cleanConflictDir()
    }

    @After
    fun tearDown() {
        stores.forEach { it.clear() }
        outsideDir.deleteRecursively()
        cleanConflictDir()
        app.getSharedPreferences("studio", 0).edit().clear().commit()
        keys.forEach { key ->
            Files.deleteIfExists(File(app.filesDir, "workspaces/$key.json").toPath())
            File(app.filesDir, "workspaces/$key.json").deleteRecursively()
            File(app.filesDir, "workspaces/$key").deleteRecursively()
            File(app.filesDir, "deleted-drafts/$key").deleteRecursively()
            app.deleteSharedPreferences("studio-window-$key")
        }
    }

    private fun cleanConflictDir() {
        val conflictPath = File(app.filesDir, "reader-conflicts").toPath()
        if (Files.isSymbolicLink(conflictPath)) {
            Files.deleteIfExists(conflictPath)
        } else {
            conflictPath.toFile().deleteRecursively()
        }
    }

    private fun newKey(): String = "rc-${UUID.randomUUID()}".also(keys::add)

    private fun newModel(
        key: String = newKey(),
        flushStatus: (suspend (String) -> ReaderFlushStatus)? = { ReaderFlushStatus.ACKNOWLEDGED },
    ): Pair<ViewModelStore, StudioViewModel> {
        val store = ViewModelStore().also(stores::add)
        val model = StudioViewModel(app, key).also { vm ->
            vm.readerFlushStatusRequester = flushStatus
            vm.reading(autosave = false)
            store.put("vm", vm)
        }
        return store to model
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

    private fun writeConflictJson(
        fileName: String,
        id: String,
        name: String,
        content: String,
        lastModifiedMillis: Long? = null,
    ): File {
        val dir = File(app.filesDir, "reader-conflicts").apply { mkdirs() }
        val file = File(dir, fileName)
        val payload = JSONObject()
            .put("id", id)
            .put("name", name)
            .put("content", content)
            .toString()
        file.writeBytes(payload.toByteArray(Charsets.UTF_8))
        if (lastModifiedMillis != null) assertTrue(file.setLastModified(lastModifiedMillis))
        return file
    }

    @Test
    fun recoversValidConflictAsDetachedDraftPreservingOriginalBytesAndSurvivingRestart() {
        val key = newKey()
        val (store1, model1) = newModel(key)
        model1.newNote(titleHint = "Lecture", format = "smd", content = "# Authoritative native\n")
        await { model1.state.value.active.name == "Lecture.smd" }
        val sourceTab = model1.state.value.active

        // Include UTF-8 BOM, CRLF, trailing spaces, emoji surrogate pair, and math bytes.
        val exactDraft = "\uFEFF# Conflicting reader draft  \r\nMath: α + β = 😀\r\n\tIndented trailing\n"
        val resync = model1.readerResync(sourceTab.id, "ep-conflict", 0L, listOf("# Stale base"), exactDraft)
        assertFalse(resync.getBoolean("accepted"))

        val conflictDir = File(app.filesDir, "reader-conflicts")
        await { (conflictDir.listFiles { f -> f.extension == "json" }?.size ?: 0) == 1 }
        val conflictFile = conflictDir.listFiles { f -> f.extension == "json" }!!.single()
        val originalFileBytes = conflictFile.readBytes()

        // Flush the pre-conflict workspace snapshot, then restart BEFORE recovering:
        // the private conflict file on disk remains recoverable across restart.
        kotlinx.coroutines.runBlocking { assertTrue(model1.flushRecoveryAndAwait()) }
        store1.clear()
        stores.remove(store1)
        val (store2, model2) = newModel(key)
        assertEquals(sourceTab.id, model2.state.value.active.id)

        val tabsBeforeRecovery = model2.state.value.tabs.size
        model2.recoverDeletedDraft()
        await { model2.state.value.tabs.size == tabsBeforeRecovery + 1 && model2.state.value.active.id != sourceTab.id }

        val recovered = model2.state.value.active
        assertNotEquals(sourceTab.id, recovered.id)
        assertEquals("Recovered Lecture.md", recovered.name)
        assertNull(recovered.uri)
        assertNull(recovered.relative)
        assertNull(recovered.assetDirectory)
        assertFalse(recovered.portable)
        assertEquals("", recovered.saved)
        assertTrue(recovered.dirty)
        assertEquals(exactDraft, recovered.content)
        assertArrayEquals(exactDraft.toByteArray(Charsets.UTF_8), recovered.content.toByteArray(Charsets.UTF_8))

        // Active .json candidate is retired, while exact original file bytes remain preserved in .recovered.
        assertFalse(conflictFile.exists())
        val retiredFile = File(conflictDir, "${conflictFile.name}.recovered")
        assertTrue(retiredFile.isFile)
        assertArrayEquals(originalFileBytes, retiredFile.readBytes())

        // Restart AFTER recovering (without manual flush): restored detached tab survives in
        // the workspace recovery snapshot written by recoverDeletedDraft() before retirement.
        store2.clear()
        stores.remove(store2)
        val (_, model3) = newModel(key)
        val afterRestart = model3.state.value.tabs.firstOrNull { it.id == recovered.id }
        assertEquals(exactDraft, afterRestart?.content)
        assertEquals("", afterRestart?.saved)
        assertTrue(afterRestart?.dirty == true)
        assertNull(afterRestart?.uri)

        // Even in a workspace where recovered.id is not open, the retired candidate is not re-opened.
        val (_, model4) = newModel()
        assertTrue(model4.state.value.tabs.none { it.id == recovered.id })
        model4.recoverDeletedDraft()
        await { model4.state.value.message == "No additional deleted drafts to recover." }
        assertTrue(model4.state.value.tabs.none { it.id == recovered.id })
    }

    @Test
    fun failedReaderBarrierAndFailedSnapshotWriteDoNotRetireCandidatePrematurely() {
        val key = newKey()
        var barrierStatus = ReaderFlushStatus.FAILED
        val (store1, model1) = newModel(key, flushStatus = { barrierStatus })
        val activeId = model1.state.value.active.id
        val conflictFile = writeConflictJson(
            fileName = "reader-conflict-barrier.json",
            id = activeId,
            name = "BarrierNote.md",
            content = "# Protected across barrier failure\n",
        )
        val originalBytes = conflictFile.readBytes()

        // 1. Failed reader barrier cancels recovery and leaves .json candidate untouched.
        model1.recoverDeletedDraft()
        await {
            model1.state.value.message ==
                "The reader could not confirm its latest edits. The action was canceled; keep the note open and try again."
        }
        assertEquals(1, model1.state.value.tabs.size)
        assertTrue(conflictFile.isFile)
        assertArrayEquals(originalBytes, conflictFile.readBytes())

        // 2. Reader barrier succeeds, but durable workspace snapshot write fails: candidate still must NOT retire.
        barrierStatus = ReaderFlushStatus.ACKNOWLEDGED
        val snapshotTarget = File(app.filesDir, "workspaces/$key.json")
        snapshotTarget.deleteRecursively()
        assertTrue(File(snapshotTarget, "blocking-child").mkdirs())

        model1.recoverDeletedDraft()
        await {
            model1.state.value.error ==
                "Draft recovery could not be saved. The previous recovery snapshot is preserved; please save your note to a file."
        }
        assertEquals(1, model1.state.value.tabs.size)
        assertTrue(conflictFile.isFile)
        assertArrayEquals(originalBytes, conflictFile.readBytes())

        // 3. Unblock snapshot storage and restart: unretired candidate recovers and retires once durably accepted.
        store1.clear()
        stores.remove(store1)
        snapshotTarget.deleteRecursively()

        val (_, model2) = newModel(key)
        model2.recoverDeletedDraft()
        await { model2.state.value.active.content == "# Protected across barrier failure\n" }
        assertFalse(conflictFile.exists())
        assertTrue(File(conflictFile.parentFile, "${conflictFile.name}.recovered").isFile)
    }

    @Test
    fun recoversTwoConflictCandidatesInOrderAndPreservesSurvivingOrdinaryDeletedDrafts() {
        val key = newKey()
        val (_, model) = newModel(key)

        // Seed an older surviving ordinary deleted draft in DeletedDraftStore.
        val deletedStore = DeletedDraftStore(File(app.filesDir, "deleted-drafts/$key"))
        val ordinaryOld = Note(
            name = "Recovered OrdinaryOld.md",
            uri = null,
            content = "# Surviving ordinary deleted draft\n",
            saved = "",
        )
        deletedStore.save(ordinaryOld)
        File(app.filesDir, "deleted-drafts/$key").listFiles().orEmpty().forEach {
            assertTrue(it.setLastModified(10_000L))
        }

        // Seed two valid conflict candidates in chronological order (older = 20s, newer = 30s).
        val firstConflict = writeConflictJson(
            fileName = "reader-conflict-01.json",
            id = model.state.value.active.id,
            name = "First.md",
            content = "# First conflict draft\n",
            lastModifiedMillis = 20_000L,
        )
        val secondConflict = writeConflictJson(
            fileName = "reader-conflict-02.json",
            id = "unknown-reader",
            name = "Reader draft",
            content = "# Second conflict draft\n",
            lastModifiedMillis = 30_000L,
        )

        // 1st recovery: newest conflict candidate (# Second conflict draft).
        model.recoverDeletedDraft()
        await { model.state.value.active.content == "# Second conflict draft\n" }
        assertEquals("Recovered Reader draft.md", model.state.value.active.name)
        assertNull(model.state.value.active.uri)
        assertFalse(secondConflict.exists())
        assertTrue(firstConflict.isFile)

        // 2nd recovery: older conflict candidate (# First conflict draft).
        model.recoverDeletedDraft()
        await { model.state.value.active.content == "# First conflict draft\n" }
        assertEquals("Recovered First.md", model.state.value.active.name)
        assertNull(model.state.value.active.uri)
        assertFalse(firstConflict.exists())

        // 3rd recovery: surviving ordinary deleted draft from DeletedDraftStore.
        model.recoverDeletedDraft()
        await { model.state.value.active.id == ordinaryOld.id }
        assertEquals("# Surviving ordinary deleted draft\n", model.state.value.active.content)
        assertEquals("Recovered OrdinaryOld.md", model.state.value.active.name)

        // 4th recovery: exhausted both stores cleanly.
        model.recoverDeletedDraft()
        await { model.state.value.message == "No additional deleted drafts to recover." }

        // Also verify when a newer ordinary deleted draft arrives after an older conflict candidate:
        // latest across both stores wins first, and the older conflict candidate still recovers next.
        val olderConflict = writeConflictJson(
            fileName = "reader-conflict-03.json",
            id = "note-3",
            name = "OlderConflict.md",
            content = "# Older conflict after newer deleted\n",
            lastModifiedMillis = 40_000L,
        )
        val newerOrdinary = Note(
            name = "Recovered NewerOrdinary.md",
            uri = null,
            content = "# Newer ordinary deleted draft\n",
            saved = "",
        )
        deletedStore.save(newerOrdinary)
        File(app.filesDir, "deleted-drafts/$key").listFiles().orEmpty()
            .filter { it.lastModified() != 10_000L }
            .forEach { assertTrue(it.setLastModified(50_000L)) }

        model.recoverDeletedDraft()
        await { model.state.value.active.id == newerOrdinary.id }
        assertTrue(olderConflict.isFile)

        model.recoverDeletedDraft()
        await { model.state.value.active.content == "# Older conflict after newer deleted\n" }
        assertFalse(olderConflict.exists())
    }

    @Test
    fun skipsMalformedOversizedAndPrivatePathOutOfBoundsEntriesWithoutTouchingTheirBytes() {
        val conflictDir = File(app.filesDir, "reader-conflicts").apply { mkdirs() }
        val secretOutside = File(outsideDir, "secret.json").apply {
            writeText(JSONObject().put("id", "ext").put("name", "Secret.md").put("content", "# Outside secret").toString())
        }
        val secretBytes = secretOutside.readBytes()

        // Valid older candidate (mtime = 15_000L) that should be recovered after skipping newer invalid entries.
        val validCandidate = writeConflictJson(
            fileName = "valid.json",
            id = "note-ok",
            name = "Valid.md",
            content = "# Valid conflict after skipping bad entries\n",
            lastModifiedMillis = 15_000L,
        )

        // Newer malformed / non-candidate / symlink / oversized entries (mtime = 60_000L).
        val brokenSyntax = File(conflictDir, "broken-syntax.json").apply {
            writeText("{not valid json")
            assertTrue(setLastModified(60_000L))
        }
        val invalidUtf8 = File(conflictDir, "invalid-utf8.json").apply {
            writeBytes(byteArrayOf(0x7B, 0x22, 0xFF.toByte(), 0xFE.toByte(), 0x7D))
            assertTrue(setLastModified(60_000L))
        }
        val missingContent = File(conflictDir, "missing-content.json").apply {
            writeText(JSONObject().put("id", "n1").put("name", "NoContent.md").toString())
            assertTrue(setLastModified(60_000L))
        }
        val wrongType = File(conflictDir, "wrong-type.json").apply {
            writeText("""{"id":"n1","name":"BadType.md","content":12345}""")
            assertTrue(setLastModified(60_000L))
        }
        val extraKey = File(conflictDir, "extra-key.json").apply {
            writeText(JSONObject().put("id", "n1").put("name", "Extra.md").put("content", "x").put("unexpected", "y").toString())
            assertTrue(setLastModified(60_000L))
        }
        val blankName = File(conflictDir, "blank-name.json").apply {
            writeText(JSONObject().put("id", "n1").put("name", "   ").put("content", "x").toString())
            assertTrue(setLastModified(60_000L))
        }
        val trailingGarbage = File(conflictDir, "trailing.json").apply {
            writeText("""{"id":"n1","name":"Trail.md","content":"x"} trailing""")
            assertTrue(setLastModified(60_000L))
        }
        val stagingTmp = File(conflictDir, "reader-conflict-staging.json.tmp").apply {
            writeText(JSONObject().put("id", "n1").put("name", "Tmp.md").put("content", "# Tmp").toString())
            assertTrue(setLastModified(60_000L))
        }
        val subdirJson = File(conflictDir, "nested.json").apply {
            mkdirs()
            File(this, "inner.json").writeText(JSONObject().put("id", "n1").put("name", "Inner.md").put("content", "# Inner").toString())
            assertTrue(setLastModified(60_000L))
        }
        // Exceeds 20_000_000 UTF-8 bytes while staying under 20_000_000 UTF-16 code units (5_000_001 * 4 bytes = 20_000_004 bytes).
        val oversizedUtf8 = writeConflictJson(
            fileName = "oversized-utf8.json",
            id = "n1",
            name = "Huge.md",
            content = "😀".repeat(5_000_001),
            lastModifiedMillis = 60_000L,
        )
        val symlinkEntry = File(conflictDir, "linked.json")
        Files.createSymbolicLink(symlinkEntry.toPath(), secretOutside.toPath())

        val (_, model) = newModel()
        model.recoverDeletedDraft()
        await { model.state.value.active.content == "# Valid conflict after skipping bad entries\n" }
        assertFalse(validCandidate.exists())

        // Every skipped entry and external symlink target remains completely untouched.
        assertEquals("{not valid json", brokenSyntax.readText())
        assertTrue(invalidUtf8.isFile)
        assertTrue(missingContent.isFile)
        assertTrue(wrongType.isFile)
        assertTrue(extraKey.isFile)
        assertTrue(blankName.isFile)
        assertTrue(trailingGarbage.isFile)
        assertTrue(stagingTmp.isFile)
        assertTrue(subdirJson.isDirectory)
        assertTrue(oversizedUtf8.isFile)
        assertTrue(Files.isSymbolicLink(symlinkEntry.toPath()))
        assertArrayEquals(secretBytes, secretOutside.readBytes())

        // Subsequent recovery sees no valid candidates remaining and never reads symlinked reader-conflicts root.
        model.recoverDeletedDraft()
        await { model.state.value.message == "No additional deleted drafts to recover." }

        cleanConflictDir()
        Files.createSymbolicLink(File(app.filesDir, "reader-conflicts").toPath(), outsideDir.toPath())
        assertNull(ReaderConflictDraftStore(app.filesDir).latestCandidate())
        assertArrayEquals(secretBytes, secretOutside.readBytes())
    }

    @Test
    fun recoversLiveReaderResyncAndMalformedResyncConflictsInOrder() {
        val (_, model) = newModel()
        val conflictDir = File(app.filesDir, "reader-conflicts")
        val activeId = model.state.value.active.id

        val resync = model.readerResync(activeId, "ep-1", 0L, listOf("# Old"), "# Live conflict one\n")
        assertFalse(resync.getBoolean("accepted"))
        await { (conflictDir.listFiles { f -> f.extension == "json" }?.size ?: 0) == 1 }

        Thread.sleep(5)
        model.preserveMalformedReaderResync(activeId, "# Live malformed resync two\n")
        await { (conflictDir.listFiles { f -> f.extension == "json" }?.size ?: 0) == 2 }

        model.recoverDeletedDraft()
        await { model.state.value.active.content == "# Live malformed resync two\n" }

        model.recoverDeletedDraft()
        await { model.state.value.active.content == "# Live conflict one\n" }
        assertEquals(0, conflictDir.listFiles { f -> f.extension == "json" }?.size ?: 0)
        assertEquals(2, conflictDir.listFiles { f -> f.name.endsWith(".json.recovered") }?.size ?: 0)
    }
}
