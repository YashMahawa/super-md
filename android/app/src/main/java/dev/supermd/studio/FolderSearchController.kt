package dev.supermd.studio

import android.app.Application
import android.net.Uri
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class PendingSeededFind(
    val query: String,
    val caseSensitive: Boolean,
    val nonce: Long = System.nanoTime(),
    val targetTabId: String? = null,
    val targetUri: String? = null,
    val sourceStart: Int? = null,
    val sourceEnd: Int? = null,
    val matchText: String? = null,
)

internal class FolderSearchController(
    private val app: Application,
    private val scope: CoroutineScope,
    private val media: MediaStorage,
    private val documentAccess: DocumentAccess,
    private val readState: () -> StudioState,
    private val readRecent: () -> List<RecentNote>,
    private val flushActiveReader: suspend (String) -> Unit,
    private val sameDocumentUri: (String, String) -> Boolean,
    private val onBarrierActiveTab: suspend (String) -> Unit,
    private val onSelectTab: (String) -> Unit,
    private val onOpenUri: (Uri, String?) -> Unit,
) {
    internal val folderSearchMutable = MutableStateFlow(FolderSearchState())
    val state: StateFlow<FolderSearchState> = folderSearchMutable.asStateFlow()
    internal val seededFindMutable = MutableStateFlow<PendingSeededFind?>(null)
    val seededFind: StateFlow<PendingSeededFind?> = seededFindMutable.asStateFlow()
    private var folderSearchJob: Job? = null

    fun cancel() {
        folderSearchJob?.cancel()
        folderSearchJob = null
    }

    fun openFolderSearch(initialQuery: String? = null) {
        folderSearchJob?.cancel()
        val previous = folderSearchMutable.value
        val nextQuery = initialQuery ?: previous.query
        folderSearchMutable.value = previous.copy(
            visible = true,
            query = nextQuery,
            scanning = nextQuery.isNotEmpty(),
            matches = if (nextQuery == previous.query && nextQuery.isNotEmpty()) previous.matches else emptyList(),
            scannedFiles = if (nextQuery == previous.query && nextQuery.isNotEmpty()) previous.scannedFiles else 0,
            truncated = false,
        )
        folderSearchJob = scope.launch {
            if (readState().tabs.isNotEmpty()) {
                val activeId = readState().active.id
                if (activeId.isNotEmpty()) {
                    try {
                        flushActiveReader(activeId)
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (_: Exception) {
                    }
                }
            }
            if (nextQuery.isNotEmpty()) {
                runFolderSearchScan(nextQuery, previous.caseSensitive, previous.includeDiagrams)
            }
        }
    }

    fun updateFolderSearch(
        query: String = folderSearchMutable.value.query,
        caseSensitive: Boolean = folderSearchMutable.value.caseSensitive,
        includeDiagrams: Boolean = folderSearchMutable.value.includeDiagrams,
    ) {
        folderSearchJob?.cancel()
        folderSearchJob = null
        val visible = folderSearchMutable.value.visible
        if (query.isEmpty()) {
            folderSearchMutable.value = FolderSearchState(
                visible = visible,
                query = "",
                caseSensitive = caseSensitive,
                includeDiagrams = includeDiagrams,
                scanning = false,
            )
            return
        }
        folderSearchMutable.value = FolderSearchState(
            visible = visible,
            query = query,
            caseSensitive = caseSensitive,
            includeDiagrams = includeDiagrams,
            scanning = true,
        )
        folderSearchJob = scope.launch {
            runFolderSearchScan(query, caseSensitive, includeDiagrams)
        }
    }

    private suspend fun runFolderSearchScan(
        query: String,
        caseSensitive: Boolean,
        includeDiagrams: Boolean,
    ) {
        val currentState = readState()
        val tabsSnapshot = currentState.tabs
        val activeTabId = currentState.active.id
        val recentSnapshot = readRecent()
        val folderUri = currentState.folder?.let(Uri::parse)
        val finalState = withContext(Dispatchers.IO) {
            streamTextSearch(
                query = query,
                tabs = tabsSnapshot,
                recents = recentSnapshot,
                folderRoot = resolveSearchRoot(app, folderUri),
                media = media,
                openUriStream = { candidateUri ->
                    val target = documentAccess.resolve(candidateUri, writing = false)
                    if (target.scheme == "file") target.path?.let(::File)?.inputStream()
                    else app.contentResolver.openInputStream(target)
                },
                activeTabId = activeTabId,
                caseSensitive = caseSensitive,
                excludeDiagrams = !includeDiagrams,
                onBatch = { batch, scannedFiles, truncated, done ->
                    if (batch.isNotEmpty() || done) {
                        withContext(Dispatchers.Main.immediate) {
                            val current = folderSearchMutable.value
                            if (current.visible &&
                                current.query == query &&
                                current.caseSensitive == caseSensitive &&
                                current.includeDiagrams == includeDiagrams
                            ) {
                                folderSearchMutable.value = current.copy(
                                    matches = current.matches + batch,
                                    scannedFiles = scannedFiles,
                                    truncated = truncated,
                                    scanning = !done,
                                )
                            }
                        }
                    }
                },
            )
        }
        val current = folderSearchMutable.value
        if (current.visible &&
            current.query == query &&
            current.caseSensitive == caseSensitive &&
            current.includeDiagrams == includeDiagrams
        ) {
            folderSearchMutable.value = finalState.copy(visible = true)
        }
    }

    fun closeFolderSearch() {
        folderSearchJob?.cancel()
        folderSearchJob = null
        if (folderSearchMutable.value.visible || folderSearchMutable.value.scanning) {
            folderSearchMutable.value = folderSearchMutable.value.copy(visible = false, scanning = false)
        }
    }

    fun cancelWorkspaceSearch() {
        closeFolderSearch()
    }

    fun openSearchMatch(match: FolderSearchMatch) {
        val currentSearch = folderSearchMutable.value
        val query = currentSearch.query
        val caseSensitive = currentSearch.caseSensitive
        closeFolderSearch()
        val currentState = readState()
        val existing = currentState.tabs.firstOrNull { tab ->
            (match.tabId != null && tab.id == match.tabId) ||
                (!match.uri.isNullOrBlank() && !tab.uri.isNullOrBlank() && sameDocumentUri(tab.uri, match.uri))
        }
        val hasValidRange = match.sourceStart >= 0 && match.sourceEnd >= match.sourceStart
        if (query.isNotEmpty()) {
            seededFindMutable.value = PendingSeededFind(
                query = query,
                caseSensitive = caseSensitive,
                targetTabId = existing?.id ?: match.tabId,
                targetUri = existing?.uri ?: match.uri,
                sourceStart = if (hasValidRange) match.sourceStart else null,
                sourceEnd = if (hasValidRange) match.sourceEnd else null,
                matchText = if (hasValidRange) match.matchText.takeIf { it.isNotEmpty() } else null,
            )
        }
        if (existing != null) {
            if (currentState.active.id == existing.id) {
                scope.launch { onBarrierActiveTab(existing.id) }
            } else {
                onSelectTab(existing.id)
            }
        } else if (!match.uri.isNullOrBlank()) {
            onOpenUri(Uri.parse(match.uri), match.relative)
        }
    }

    fun consumeSeededFind(nonce: Long) {
        if (seededFindMutable.value?.nonce == nonce) {
            seededFindMutable.value = null
        }
    }

    fun activeMatchesSeedTarget(note: Note, seed: PendingSeededFind): Boolean {
        if (note.id.isEmpty()) return false
        if (seed.targetTabId != null && note.id == seed.targetTabId) return true
        if (!seed.targetUri.isNullOrBlank() && !note.uri.isNullOrBlank() && sameDocumentUri(note.uri, seed.targetUri)) return true
        return false
    }
}
