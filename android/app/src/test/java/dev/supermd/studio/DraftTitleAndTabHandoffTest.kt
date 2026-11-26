package dev.supermd.studio

import android.app.Application
import android.net.Uri
import android.os.Looper
import java.io.File
import java.nio.file.Files
import java.time.Duration
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
class DraftTitleAndTabHandoffTest {
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
        val temp = Files.createTempDirectory("draft-handoff-test").toFile()
        val key = "test-${UUID.randomUUID()}"
        val store = androidx.lifecycle.ViewModelStore()
        val factory = object : androidx.lifecycle.ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : androidx.lifecycle.ViewModel> create(modelClass: Class<T>): T =
                StudioViewModel(app, workspaceKey = key) as T
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

    private fun headingsJson(vararg titles: String): JSONArray = JSONArray().apply {
        titles.forEachIndexed { index, title ->
            put(
                JSONObject()
                    .put("id", "h-$index")
                    .put("title", title)
                    .put("level", 1)
                    .put("offset", index * 10),
            )
        }
    }

    @Test
    fun outlineDerivesTitleOnlyForActiveUntitledDraftsAndTracksNoteIdentity() {
        withWorkspace { _, temp, model ->
            model.readerFlushStatusRequester = { ReaderFlushStatus.ACKNOWLEDGED }
            val welcomeTabId = model.state.value.active.id
            assertEquals("Welcome.md", model.state.value.active.name)
            model.edit(welcomeTabId, "# Recoverable draft\n")
            model.outline(welcomeTabId, headingsJson("Recoverable draft"))
            // Welcome.md is already named and must NOT be renamed by outline derivation.
            assertEquals("Welcome.md", model.state.value.active.name)
            assertEquals(welcomeTabId, model.lastOutlineNoteId)

            // A fresh Untitled.md draft derives its title from the first heading once.
            model.newNote()
            waitUntil { model.state.value.active.id != welcomeTabId && model.state.value.active.name == "Untitled.md" }
            val draftTabId = model.state.value.active.id
            model.edit(draftTabId, "# Recoverable draft\n")
            model.outline(draftTabId, headingsJson("Recoverable draft"))
            assertEquals("Recoverable draft.md", model.state.value.active.name)
            assertEquals(draftTabId, model.lastOutlineNoteId)

            // Subsequent heading edits on an already-titled note must not rename it.
            model.edit(draftTabId, "# Different Heading\n")
            model.outline(draftTabId, headingsJson("Different Heading"))
            assertEquals("Recoverable draft.md", model.state.value.active.name)

            // Inactive outline events are ignored completely.
            model.outline("stale-tab-id", headingsJson("Should Be Ignored"))
            assertEquals(draftTabId, model.lastOutlineNoteId)
            assertEquals("Different Heading", model.headings.value.single().title)

            // Portable Untitled.smd draft derives a .smd title.
            model.newNote(format = "smd")
            waitUntil { model.state.value.active.name == "Untitled.smd" }
            val portableId = model.state.value.active.id
            model.edit(portableId, "# Portable Draft")
            model.outline(portableId, headingsJson("Portable / Draft?"))
            assertEquals("Portable  Draft.smd", model.state.value.active.name)
            assertEquals(portableId, model.lastOutlineNoteId)

            // File-backed Untitled.md keeps its disk filename even when headings arrive.
            val diskUntitled = File(temp, "Untitled.md").apply { writeText("# Disk Heading\n") }
            model.openDocument(Uri.fromFile(diskUntitled))
            waitUntil { model.state.value.active.uri == Uri.fromFile(diskUntitled).toString() }
            val diskId = model.state.value.active.id
            model.outline(diskId, headingsJson("Disk Heading"))
            assertEquals("Untitled.md", model.state.value.active.name)
            assertEquals(diskId, model.lastOutlineNoteId)
        }
    }

    @Test
    fun rapidNewCloseNewDraftAndRecoverySucceedAcrossPreSupermdLoadFlushHandoffs() {
        withWorkspace { _, _, model ->
            val sampleId = model.state.value.active.id
            assertEquals("Welcome.md", model.state.value.active.name)
            model.edit(sampleId, "# A clear place to think\n")
            model.outline(sampleId, headingsJson("A clear place to think"))
            assertEquals("Welcome.md", model.state.value.active.name)

            // Simulate the live WebView still holding sampleId while native creates, closes,
            // and opens tabs before Compose's LaunchedEffect delivers supermdLoad.
            val mountedReaderNoteId = AtomicReference(sampleId)
            model.readerFlushStatusRequester = { requestedId ->
                if (mountedReaderNoteId.get() == requestedId) ReaderFlushStatus.ACKNOWLEDGED
                else ReaderFlushStatus.WRONG_ACTIVE_NOTE
            }

            model.newNote()
            waitUntil { model.state.value.active.id != sampleId && model.state.value.active.name == "Untitled.md" }
            val emptyId = model.state.value.active.id

            // Close the empty tab while WebView still holds sampleId, then immediately open
            // the recoverable draft tab without waiting for intermediate supermdLoad frames.
            model.requestClose(emptyId)
            model.newNote()
            waitUntil {
                val state = model.state.value
                state.tabs.none { it.id == emptyId } &&
                    state.closedTabs.none { it.id == emptyId } &&
                    state.active.id != sampleId &&
                    state.active.id != emptyId &&
                    state.active.name == "Untitled.md"
            }

            val recoverableId = model.state.value.active.id
            model.edit(recoverableId, "# Recoverable draft")
            // WebView now loads recoverableId and emits document_outline for it.
            mountedReaderNoteId.set(recoverableId)
            model.outline(recoverableId, headingsJson("Recoverable draft"))
            assertEquals("Recoverable draft.md", model.state.value.active.name)
            assertEquals(recoverableId, model.lastOutlineNoteId)

            // Closing the dirty draft prompts for confirmation, discards into closedTabs, and reopens.
            model.requestClose(recoverableId)
            waitUntil { model.state.value.pendingCloseNoteId == recoverableId }
            mountedReaderNoteId.set(sampleId)
            model.resolveCloseConfirmation("discard")
            waitUntil {
                model.state.value.tabs.none { it.id == recoverableId } &&
                    model.state.value.closedTabs.any { it.id == recoverableId && it.name == "Recoverable draft.md" }
            }

            model.reopen()
            waitUntil {
                model.state.value.active.id == recoverableId &&
                    model.state.value.active.name == "Recoverable draft.md" &&
                    model.state.value.active.content == "# Recoverable draft"
            }
            assertNull(model.state.value.error)
        }
    }

    @Test
    fun consecutiveExternalOpensSucceedBeforeFirstTabLoadsInWebViewButFailOnGenuineFlushErrors() {
        withWorkspace { _, temp, model ->
            val initialId = model.state.value.active.id
            val mountedReaderNoteId = AtomicReference(initialId)
            model.readerFlushStatusRequester = { requestedId ->
                if (mountedReaderNoteId.get() == requestedId) ReaderFlushStatus.ACKNOWLEDGED
                else ReaderFlushStatus.WRONG_ACTIVE_NOTE
            }
            model.attachReaderOpenHandler { target, relative ->
                model.openDocument(
                    target.uri,
                    relative,
                    externalIntentFlags = target.externalIntentFlags,
                    externalCaller = target.externalCaller,
                )
            }

            val firstFile = File(temp, "first.md").apply { writeText("# First External Open\n") }
            val secondFile = File(temp, "second.md").apply { writeText("# Second External Open\n") }
            val thirdFile = File(temp, "third.md").apply { writeText("# Third External Open\n") }

            model.requestOpen(Uri.fromFile(firstFile))
            waitUntil { model.state.value.active.uri == Uri.fromFile(firstFile).toString() }

            // Second external open arrives while WebView still has initialId mounted (pre-supermdLoad).
            model.requestOpen(Uri.fromFile(secondFile))
            waitUntil {
                val state = model.state.value
                state.active.uri == Uri.fromFile(secondFile).toString() &&
                    state.tabs.any { it.uri == Uri.fromFile(firstFile).toString() }
            }
            val secondId = model.state.value.active.id

            // awaitReaderSnapshot still waits until WebView actually mounts secondId.
            runBlocking {
                assertFalse(model.awaitReaderSnapshot(secondId, timeoutMillis = 90))
                mountedReaderNoteId.set(secondId)
                assertTrue(model.awaitReaderSnapshot(secondId, timeoutMillis = 500))
            }

            // A genuine flush failure on the active tab still cancels barrier-guarded opens.
            model.readerFlushStatusRequester = { ReaderFlushStatus.FAILED }
            model.requestOpen(Uri.fromFile(thirdFile))
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(200))
            Thread.sleep(60)
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(200))
            assertEquals(secondId, model.state.value.active.id)
            assertTrue(model.state.value.message?.contains("The reader could not confirm its latest edits") == true)
        }
    }
}
