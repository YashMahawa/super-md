package dev.supermd.studio

import android.app.Application
import android.net.Uri
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

internal class TabNavigationCoordinator(
    private val app: Application,
    private val scope: CoroutineScope,
    private val media: MediaStorage,
    private val openRequests: OpenRequestGate,
    private val closedNoteMutex: Mutex,
    private val closedNoteStore: ClosedNoteStore,
    private val readerEcho: () -> MutableMap<String, String>,
    private val readClosedNoteRefs: () -> List<ClosedNoteReference>,
    private val writeClosedNoteRefs: (List<ClosedNoteReference>) -> Unit,
    private val saveClosedNoteIndex: (List<ClosedNoteReference>) -> Unit,
    private val readState: () -> StudioState,
    private val writeState: (StudioState) -> Unit,
    private val changeState: ((StudioState) -> StudioState) -> Unit,
    private val performReaderBarrier: suspend (String, () -> Unit) -> Boolean,
    private val performCurrentReaderBarrier: suspend ((String) -> Unit) -> Boolean,
    private val readerBarrierFailed: () -> Unit,
    private val refreshExternalImmediate: (Uri) -> Unit,
    private val recordPortableBaseline: (String, String?) -> Unit,
) {
    fun newNote(
        titleHint: String? = null,
        content: String? = null,
        background: Boolean = false,
        format: String = "md",
        onCreated: ((Note?) -> Unit)? = null,
    ) {
        if (format !in setOf("md", "smd")) {
            onCreated?.invoke(null)
            return
        }
        openRequests.invalidate()
        scope.launch {
            val nativeFormat = if (format == "smd") NativeExportFormat.PORTABLE_SMD else NativeExportFormat.MARKDOWN
            val title = ExportFilename.suggestedName(titleHint ?: "Untitled", nativeFormat)
            val assets = if (format == "smd") media.createEmptyPortableDirectory() else null
            val note = Note(name = title, content = content ?: "", assetDirectory = assets)
            val accepted = performCurrentReaderBarrier {
                changeState { state ->
                    val preservedId = state.tabs.firstOrNull { it.id == state.activeId }?.id ?: state.tabs.firstOrNull()?.id ?: note.id
                    state.copy(tabs = state.tabs + note, activeId = if (background) preservedId else note.id)
                }
            }
            if (!accepted) {
                assets?.let { File(app.filesDir, "portable-assets/$it").deleteRecursively() }
                readerBarrierFailed()
            }
            onCreated?.invoke(note.takeIf { accepted })
        }
    }

    fun select(id: String) = selectExpected(readState().active.id, id)

    fun cycle(direction: Int) {
        val state = readState()
        if (state.tabs.isEmpty()) return
        val index = state.tabs.indexOfFirst { it.id == state.active.id }
        selectExpected(state.active.id, state.tabs[Math.floorMod(index + direction, state.tabs.size)].id)
    }

    fun tabNumber(number: Int) {
        val state = readState()
        val index = if (number == 9) state.tabs.lastIndex else number - 1
        state.tabs.getOrNull(index)?.let { selectExpected(state.active.id, it.id) }
    }

    private fun selectExpected(expectedActiveId: String, targetId: String) {
        // A later explicit tab choice must not be overwritten by a file load
        // that began earlier and is still waiting on I/O or the reader flush.
        openRequests.invalidate()
        scope.launch {
            var switchedUri: Uri? = null
            val accepted = performReaderBarrier(expectedActiveId) {
                val target = readState().tabs.find { it.id == targetId }
                if (target != null) {
                    changeState { it.copy(activeId = targetId) }
                    if (target.id !in readState().conflictedTabIds) switchedUri = target.uri?.let(Uri::parse)
                }
            }
            if (!accepted) readerBarrierFailed()
            else switchedUri?.let(refreshExternalImmediate)
        }
    }

    fun reorder(id: String, index: Int) = changeState { it.copy(tabs = reorderedNotes(it.tabs, id, index)) }

    fun migrateLegacyClosedNotes() = scope.launch {
        var locked = false
        try {
            closedNoteMutex.lock()
            locked = true
            val existingIds = readClosedNoteRefs().map { it.id }.toSet()
            val legacy = readState().closedTabs.filter { it.id !in existingIds }
            if (legacy.isEmpty()) return@launch
            val migrated = runCatching { withContext(Dispatchers.IO) { legacy.map { it to closedNoteStore.save(it) } } }.getOrElse {
                writeState(readState().copy(message = "Some older closed notes could not be moved to disk; they remain available in memory."))
                return@launch
            }
            val stillClosed = migrated.filter { (old, _) -> readState().closedTabs.any { it == old } }
            if (stillClosed.isEmpty()) return@launch
            val activeIds = readState().tabs.map { it.id }.toSet()
            val currentRefs = withContext(Dispatchers.IO) { closedNoteStore.loadIndexStrict() }
            val next = (stillClosed.map { it.second } + currentRefs).distinctBy { it.id }
                .filterNot { it.id in activeIds }.take(ClosedNoteStore.LIMIT)
            withContext(Dispatchers.IO) { saveClosedNoteIndex(next); writeClosedNoteRefs(next) }
            val replacements = stillClosed.associate { it.first.id to it }
            val finalRefs = next.filter { ref ->
                val old = replacements[ref.id]?.first
                old == null || readState().closedTabs.any { it == old }
            }
            if (finalRefs != next) withContext(Dispatchers.IO) { saveClosedNoteIndex(finalRefs); writeClosedNoteRefs(finalRefs) }
            writeClosedNoteRefs(finalRefs)
            changeState { state ->
                state.copy(
                    closedTabs = state.closedTabs.map { old ->
                        replacements[old.id]?.takeIf { it.first == old }?.second?.placeholder() ?: old
                    }.take(ClosedNoteStore.LIMIT),
                )
            }
        } catch (error: Exception) {
            writeState(readState().copy(message = "Older closed-note recovery could not be updated; the notes remain available. ${error.message}"))
        } finally {
            if (locked) closedNoteMutex.unlock()
        }
    }

    fun reopen() {
        openRequests.invalidate()
        val referenceNote = readState().closedTabs.firstOrNull() ?: return
        val reference = readClosedNoteRefs().firstOrNull { it.id == referenceNote.id }
        scope.launch {
            val note = try {
                if (reference == null) referenceNote else withContext(Dispatchers.IO) { closedNoteStore.load(reference) }
            } catch (error: Exception) {
                writeState(readState().copy(message = "Could not reopen the closed note: ${error.message}"))
                return@launch
            }
            var updatedRefs: List<ClosedNoteReference>? = null
            val accepted = closedNoteMutex.withLock {
                performCurrentReaderBarrier {
                    if (readState().closedTabs.none { it.id == referenceNote.id }) return@performCurrentReaderBarrier
                    readerEcho().remove(note.id)
                    if (note.portable && note.uri != null && !note.assetsDirty) recordPortableBaseline(note.id, note.assetDirectory)
                    val nextRefs = readClosedNoteRefs().filterNot { it.id == note.id }
                    writeClosedNoteRefs(nextRefs)
                    updatedRefs = nextRefs
                    changeState { state ->
                        val existing = state.tabs.find { it.id == note.id }
                        val tabs = if (existing == null) state.tabs + note else state.tabs
                        state.copy(
                            tabs = tabs,
                            closedTabs = state.closedTabs.dropWhile { it.id == referenceNote.id }.filterNot { it.id == referenceNote.id },
                            activeId = note.id,
                        )
                    }
                }.also { barrierAccepted ->
                    if (barrierAccepted) {
                        updatedRefs?.let { refs ->
                            withContext(NonCancellable + Dispatchers.IO) {
                                runCatching { saveClosedNoteIndex(refs) }
                            }
                        }
                    }
                }
            }
            if (!accepted) readerBarrierFailed()
        }
    }
}
