package dev.supermd.studio

import android.net.Uri
import android.os.Looper
import androidx.lifecycle.ViewModelStore
import java.io.File
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.junit.After
import org.junit.Assert.assertEquals
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
class ReaderBarrierSyncTest {
    private lateinit var app: android.app.Application
    private val workspaceKeys = mutableListOf<String>()
    private val stores = mutableListOf<ViewModelStore>()
    private val tempFiles = mutableListOf<File>()

    @Before fun setUp() {
        app = RuntimeEnvironment.getApplication()
    }

    @After fun tearDown() {
        stores.forEach { it.clear() }
        tempFiles.forEach { it.delete() }
        workspaceKeys.forEach { File(app.filesDir, "workspaces/$it").deleteRecursively() }
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

    @Test fun consecutiveExternalOpensSucceedBeforeReaderLoadsIntermediateTab() {
        val store = ViewModelStore().also(stores::add)
        val key = "barrier-${System.nanoTime()}".also(workspaceKeys::add)
        val model = StudioViewModel(app, key)
        store.put("model", model)

        val loadedNote = AtomicReference<String?>(null)
        val flushedNotes = mutableListOf<String>()
        val flushCalls = AtomicInteger(0)
        model.readerLoadedNoteId = { loadedNote.get() }
        model.readerFlushRequester = { noteId ->
            flushCalls.incrementAndGet()
            flushedNotes += noteId
            loadedNote.get() == noteId
        }

        val firstFile = File(app.cacheDir, "$key-first.md").apply {
            writeText("# First External Open\n\nFirst body.\n")
        }.also(tempFiles::add)
        val secondFile = File(app.cacheDir, "$key-second.md").apply {
            writeText("# Second External Open\n\nSecond body.\n")
        }.also(tempFiles::add)
        val firstUri = Uri.fromFile(firstFile)
        val secondUri = Uri.fromFile(secondFile)

        // Simulate cold reader_ready attach before LaunchedEffect has dispatched supermdLoad(welcomeId).
        model.open(firstUri)
        idleUntil { model.state.value.active.uri == firstUri.toString() }
        assertNull(model.state.value.message)
        assertEquals(0, flushCalls.get())

        // Simulate immediate second external open before LaunchedEffect has dispatched supermdLoad(firstId).
        loadedNote.set("stale-welcome-id")
        model.open(secondUri)
        idleUntil {
            val state = model.state.value
            state.active.uri == secondUri.toString() && state.tabs.any { it.uri == firstUri.toString() }
        }
        assertNull(model.state.value.message)
        assertEquals(0, flushCalls.get())

        // Once the active tab has been loaded into the reader, tab switches still flush it through the bridge.
        val secondId = model.state.value.active.id
        val firstId = model.state.value.tabs.first { it.uri == firstUri.toString() }.id
        loadedNote.set(secondId)
        model.select(firstId)
        idleUntil { model.state.value.active.id == firstId }
        assertEquals(listOf(secondId), flushedNotes)
    }
}
