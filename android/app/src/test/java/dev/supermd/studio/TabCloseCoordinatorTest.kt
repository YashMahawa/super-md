package dev.supermd.studio

import android.app.Application
import android.net.Uri
import android.os.Looper
import androidx.lifecycle.ViewModelStore
import java.io.File
import java.nio.file.Files
import java.time.Duration
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class TabCloseCoordinatorTest {
    private lateinit var app: Application
    private lateinit var tempDir: File
    private val stores = mutableListOf<ViewModelStore>()
    private val keys = mutableListOf<String>()

    @Before fun setUp() { app = RuntimeEnvironment.getApplication(); tempDir = Files.createTempDirectory("tab-close-coord").toFile() }

    @After fun tearDown() {
        stores.forEach { it.clear() }
        tempDir.deleteRecursively()
        keys.forEach { k ->
            File(app.filesDir, "workspaces/$k.json").delete()
            File(app.filesDir, "workspaces/$k").deleteRecursively()
            app.deleteSharedPreferences("studio-window-$k")
        }
    }

    private fun newModel(key: String = "tc-${UUID.randomUUID()}".also(keys::add)): StudioViewModel =
        StudioViewModel(app, key).also {
            it.reading(autosave = false)
            it.readerFlushStatusRequester = { ReaderFlushStatus.ACKNOWLEDGED }
            ViewModelStore().also(stores::add).put("vm", it)
        }

    private fun await(predicate: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 5_000L
        while (System.currentTimeMillis() < deadline && !predicate()) {
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(25)); Thread.sleep(10)
        }
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(25))
        assertTrue("Condition timed out", predicate())
    }

    @Test fun requestCloseDiscardsBlankTabAndHandlesDirtyPromptDismissAndDiscard() {
        val model = newModel()
        val blankCreated = AtomicReference<Note?>()
        model.newNote { blankCreated.set(it) }
        await { blankCreated.get() != null }
        val blankId = blankCreated.get()!!.id
        model.requestClose(blankId)
        await { model.state.value.tabs.none { it.id == blankId } }
        assertNull(model.state.value.pendingCloseNoteId)
        assertTrue(model.state.value.closedTabs.none { it.id == blankId })
        assertEquals("Empty tab discarded", model.state.value.message)

        val file = File(tempDir, "Draft.md").apply { writeText("# Base\n", Charsets.UTF_8) }
        model.open(Uri.fromFile(file))
        await { model.state.value.active.uri == Uri.fromFile(file).toString() }
        val dirtyId = model.state.value.active.id
        model.edit(dirtyId, "# Base\n\nUnsaved edits\n")

        model.requestClose(dirtyId)
        await { model.state.value.pendingCloseNoteId == dirtyId }
        model.dismissCloseConfirmation()
        assertNull(model.state.value.pendingCloseNoteId)
        assertTrue(model.state.value.tabs.any { it.id == dirtyId })

        model.requestClose(dirtyId)
        await { model.state.value.pendingCloseNoteId == dirtyId }
        model.resolveCloseConfirmation("discard")
        await { model.state.value.tabs.none { it.id == dirtyId } && model.state.value.closedTabs.firstOrNull()?.id == dirtyId }
        assertNull(model.state.value.pendingCloseNoteId)
        assertEquals("# Base\n", file.readText(Charsets.UTF_8))
    }

    @Test fun closeEnforcesDirtyGuardAndExpectedRevisionWhileArchivingCleanMatches() {
        val model = newModel()
        val file = File(tempDir, "Revision.md").apply { writeText("# Clean v1\n", Charsets.UTF_8) }
        model.open(Uri.fromFile(file))
        await { model.state.value.active.uri == Uri.fromFile(file).toString() }
        val id = model.state.value.active.id
        model.edit(id, "# Dirty v2\n")

        val dirtyOutcome = AtomicReference("waiting")
        model.close(id, refuseDirty = true) { dirtyOutcome.set(it ?: "ok") }
        await { dirtyOutcome.get() != "waiting" }
        assertTrue(dirtyOutcome.get().contains("unsaved changes"))
        assertTrue(model.state.value.tabs.any { it.id == id })

        model.saveManual(noteId = id)
        await { !model.state.value.tabs.first { it.id == id }.dirty }
        val staleOutcome = AtomicReference("waiting")
        model.close(id, expectedRevision = "0".repeat(64)) { staleOutcome.set(it ?: "ok") }
        await { staleOutcome.get() != "waiting" }
        assertTrue(staleOutcome.get().contains("Revision conflict"))
        assertTrue(model.state.value.tabs.any { it.id == id })

        val matchingOutcome = AtomicReference("waiting")
        model.close(id, expectedRevision = agentContentRevision("# Dirty v2\n").uppercase(), refuseDirty = true) { matchingOutcome.set(it ?: "ok") }
        await { matchingOutcome.get() != "waiting" }
        assertEquals("ok", matchingOutcome.get())
        assertFalse(model.state.value.tabs.any { it.id == id })
        assertEquals(id, model.state.value.closedTabs.firstOrNull()?.id)
    }

    @Test fun closingSoleOpenTabCreatesFreshUntitledActiveTabAndClearsStaleConflicts() {
        val model = newModel()
        val soleId = model.state.value.tabs.single().id
        val file = File(tempDir, "Sole.md").apply { writeText("# v1\n", Charsets.UTF_8) }
        model.save(Uri.fromFile(file))
        await { model.state.value.active.uri == Uri.fromFile(file).toString() }
        model.edit(soleId, "# local v2\n")
        file.writeText("# external v2\n", Charsets.UTF_8)
        model.refreshExternal(immediate = true)
        await { soleId in model.state.value.conflictedTabIds }

        val closed = AtomicReference("waiting")
        model.close(soleId, discardChanges = true) { closed.set(it ?: "ok") }
        await { closed.get() != "waiting" }
        assertEquals("ok", closed.get())
        val replacement = model.state.value.tabs.single()
        assertNotEquals(soleId, replacement.id)
        assertEquals(replacement.id, model.state.value.active.id)
        assertEquals("Untitled.md", replacement.name)
        assertEquals("", replacement.content)
        assertNull(replacement.uri)
        assertFalse(soleId in model.state.value.conflictedTabIds)
        assertEquals(soleId, model.state.value.closedTabs.firstOrNull()?.id)
    }
}
