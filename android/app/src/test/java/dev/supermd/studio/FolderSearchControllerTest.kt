package dev.supermd.studio

import android.os.Looper
import androidx.lifecycle.ViewModelStore
import java.io.File
import java.time.Duration
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import org.junit.After
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
class FolderSearchControllerTest {
    private val app = RuntimeEnvironment.getApplication()
    private val stores = mutableListOf<ViewModelStore>()
    private val keys = mutableListOf<String>()

    @After
    fun tearDown() {
        stores.forEach { it.clear() }
        keys.forEach { key ->
            File(app.filesDir, "workspaces/$key.json").delete()
            File(app.filesDir, "workspaces/$key").deleteRecursively()
            app.deleteSharedPreferences("studio-window-$key")
        }
    }

    @Test
    fun lifecycleFlushesReaderClearsEmptyQuerySeedsNonceAndCancelsOnClear() {
        val flushedIds = CopyOnWriteArrayList<String>()
        val model = newModel { activeId, vm ->
            flushedIds.add(activeId)
            vm.readerEdit(activeId, "# Live Note\n\nFlushedSearchNeedle appears here.\n")
            true
        }
        val activeId = model.state.value.active.id

        model.openFolderSearch("FlushedSearchNeedle")
        await { !model.folderSearch.value.scanning && model.folderSearch.value.matches.size == 1 }
        assertTrue(model.folderSearch.value.visible)
        assertEquals(listOf(activeId), flushedIds.toList())
        assertEquals(3, model.folderSearch.value.matches.single().line)

        model.updateFolderSearch(query = "", caseSensitive = true, includeDiagrams = true)
        assertEquals(FolderSearchState(visible = true, query = "", caseSensitive = true, includeDiagrams = true, scanning = false), model.folderSearch.value)

        model.updateFolderSearch(query = "FlushedSearchNeedle", caseSensitive = true)
        await { !model.folderSearch.value.scanning && model.folderSearch.value.matches.size == 1 }
        model.openSearchMatch(model.folderSearch.value.matches.single())
        assertFalse(model.folderSearch.value.visible)

        val seed = model.seededFind.value
        assertNotNull(seed)
        assertEquals("FlushedSearchNeedle", seed!!.query)
        assertTrue(seed.caseSensitive)
        assertTrue(model.activeMatchesSeedTarget(model.state.value.active, seed))
        assertFalse(model.activeMatchesSeedTarget(Note(id = "", name = "Empty.md"), seed))
        assertTrue(model.activeMatchesSeedTarget(Note(id = "other", uri = "file:///tmp/seeded.md"), seed.copy(targetTabId = null, targetUri = "file:///tmp/seeded.md")))
        model.consumeSeededFind(seed.nonce + 1L)
        assertEquals(seed, model.seededFind.value)
        model.consumeSeededFind(seed.nonce)
        assertNull(model.seededFind.value)

        val flushEntered = AtomicBoolean(false)
        val jobCancelled = AtomicBoolean(false)
        val gate = CompletableDeferred<Boolean>()
        val inFlightStore = ViewModelStore().also(stores::add)
        val inFlightModel = newModel(inFlightStore) { _, _ ->
            flushEntered.set(true)
            try { gate.await() } catch (cancelled: CancellationException) { jobCancelled.set(true); throw cancelled }
        }
        inFlightModel.openFolderSearch("PendingCancelQuery")
        await { flushEntered.get() && inFlightModel.folderSearch.value.scanning }
        inFlightStore.clear()
        await { jobCancelled.get() }
        assertTrue(jobCancelled.get())
    }

    private fun newModel(store: ViewModelStore = ViewModelStore().also(stores::add), flush: suspend (String, StudioViewModel) -> Boolean): StudioViewModel {
        val key = "folder-search-ctrl-${UUID.randomUUID()}".also(keys::add)
        return StudioViewModel(app, key).also { vm -> vm.readerFlushRequester = { id -> flush(id, vm) }; store.put("vm-$key", vm) }
    }

    private fun await(predicate: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 5_000L
        while (System.currentTimeMillis() < deadline) {
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(20))
            if (predicate()) return
            Thread.sleep(10)
        }
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(20))
        assertTrue(predicate())
    }
}
