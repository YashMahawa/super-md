package dev.supermd.studio

import android.app.Application
import android.content.Intent
import android.net.Uri
import android.os.Looper
import androidx.lifecycle.ViewModelStore
import java.io.File
import java.time.Duration
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.runBlocking
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
class ReaderBarrierAndTabNavigationCoordinatorTest {
    private lateinit var app: Application
    private val stores = mutableListOf<ViewModelStore>()
    private val keys = mutableListOf<String>()

    @Before fun setUp() { app = RuntimeEnvironment.getApplication() }

    @After fun tearDown() {
        stores.forEach { it.clear() }
        keys.forEach { k ->
            File(app.filesDir, "workspaces/$k.json").delete()
            File(app.filesDir, "workspaces/$k").deleteRecursively()
            app.deleteSharedPreferences("studio-window-$k")
        }
    }

    private fun newModel(key: String = "rb-tn-${UUID.randomUUID()}".also(keys::add)): StudioViewModel =
        StudioViewModel(app, key).also {
            it.reading(autosave = false)
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

    @Test fun newNoteFormatsBackgroundBarrierRollbackNavigationReorderAndReopenWork() {
        val model = newModel()
        val initialId = model.state.value.active.id
        val invalid = AtomicReference<Note?>(Note())
        model.newNote(format = "pdf") { invalid.set(it) }
        assertNull(invalid.get())

        val mdCreated = AtomicReference<Note?>()
        model.newNote(titleHint = "Study", content = "# One", format = "md") { mdCreated.set(it) }
        await { mdCreated.get() != null }
        val mdId = mdCreated.get()!!.id
        assertEquals("Study.md", model.state.value.active.name)

        val smdCreated = AtomicReference<Note?>()
        model.newNote(titleHint = "Portable", content = "# Two", background = true, format = "smd") { smdCreated.set(it) }
        await { smdCreated.get() != null }
        val smdNote = smdCreated.get()!!
        val portableRoot = File(app.filesDir, "portable-assets")
        assertNotNull(smdNote.assetDirectory)
        assertTrue(File(portableRoot, smdNote.assetDirectory!!).isDirectory)
        assertEquals(mdId, model.state.value.active.id)

        val beforeDirs = portableRoot.list()?.toSet().orEmpty()
        model.readerFlushStatusRequester = { ReaderFlushStatus.FAILED }
        val failedSmd = AtomicReference<Note?>(Note())
        model.newNote(titleHint = "Rollback", format = "smd") { failedSmd.set(it) }
        await { failedSmd.get() == null }
        assertEquals(beforeDirs, portableRoot.list()?.toSet().orEmpty())
        assertTrue(model.state.value.message?.contains("The reader could not confirm its latest edits") == true)

        model.readerFlushStatusRequester = { ReaderFlushStatus.ACKNOWLEDGED }
        model.select(initialId)
        await { model.state.value.active.id == initialId }
        model.cycle(1)
        await { model.state.value.active.id == mdId }
        model.tabNumber(9)
        await { model.state.value.active.id == smdNote.id }
        model.reorder(smdNote.id, 0)
        assertEquals(listOf(smdNote.id, initialId, mdId), model.state.value.tabs.map { it.id })

        model.close(mdId, discardChanges = true)
        await { model.state.value.tabs.none { it.id == mdId } && model.state.value.closedTabs.any { it.id == mdId } }
        model.reopen()
        await { model.state.value.active.id == mdId && model.state.value.closedTabs.isEmpty() }
        assertEquals("# One", model.state.value.active.content)
        File(portableRoot, smdNote.assetDirectory!!).deleteRecursively()
    }

    @Test fun awaitReaderSnapshotAndInitialExternalOpenDeduplicationWork() {
        val model = newModel()
        val activeId = model.state.value.active.id
        val polls = AtomicInteger(0)
        model.readerFlushStatusRequester = {
            if (polls.incrementAndGet() < 2) ReaderFlushStatus.WRONG_ACTIVE_NOTE else ReaderFlushStatus.ACKNOWLEDGED
        }
        assertTrue(runBlocking { model.awaitReaderSnapshot(activeId, timeoutMillis = 500) })
        model.readerFlushStatusRequester = { ReaderFlushStatus.FAILED }
        assertFalse(runBlocking { model.awaitReaderSnapshot(activeId, timeoutMillis = 200) })

        val opened = mutableListOf<Uri>()
        model.attachReaderOpenHandler { target, _ -> opened += target.uri }
        val firstUri = Uri.parse("content://dev.supermd.test/doc-1")
        model.requestInitialExternalOpen(firstUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        model.requestInitialExternalOpen(firstUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        assertEquals(listOf(firstUri), opened)

        val rejectedUri = Uri.parse("content://dev.supermd.test/bad")
        model.rejectExternalOpen(rejectedUri, "Blocked", initial = true)
        assertEquals("Could not open note: Blocked", model.state.value.error)
        model.fail("")
        model.rejectExternalOpen(rejectedUri, "Blocked again", initial = true)
        assertEquals("", model.state.value.error)
    }
}
