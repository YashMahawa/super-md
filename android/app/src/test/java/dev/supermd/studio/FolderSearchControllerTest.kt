package dev.supermd.studio

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.ProviderInfo
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.provider.OpenableColumns
import androidx.lifecycle.ViewModelStore
import java.io.File
import java.io.FileNotFoundException
import java.nio.file.Files
import java.time.Duration
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
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
import org.robolectric.shadows.ShadowContentResolver

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class FolderSearchControllerTest {
    private val app = RuntimeEnvironment.getApplication()
    private val stores = mutableListOf<ViewModelStore>()
    private val keys = mutableListOf<String>()
    private val tempDirs = mutableListOf<File>()
    private var previousAutosave: Boolean? = null
    private var previousRecent: String? = null

    @Before
    fun setUp() {
        val prefs = app.getSharedPreferences("studio", Context.MODE_PRIVATE)
        previousAutosave = prefs.getBoolean("autosave", true)
        previousRecent = prefs.getString("recent", null)
        prefs.edit().putBoolean("autosave", false).remove("recent").commit()
    }

    @After
    fun tearDown() {
        stores.forEach { it.clear() }
        app.getSharedPreferences("studio", Context.MODE_PRIVATE).edit().apply {
            putBoolean("autosave", previousAutosave ?: true)
            if (previousRecent == null) remove("recent") else putString("recent", previousRecent)
        }.commit()
        ShadowContentResolver.reset()
        keys.forEach { key ->
            File(app.filesDir, "workspaces/$key.json").delete()
            File(app.filesDir, "workspaces/$key").deleteRecursively()
            File(app.filesDir, "deleted-drafts/$key").deleteRecursively()
            app.deleteSharedPreferences("studio-window-$key")
        }
        tempDirs.forEach { it.deleteRecursively() }
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

        // Verify readerFlushStatusRequester (#130) also flushes live edits before scanning without readerFlushRequester.
        val statusFlushedIds = CopyOnWriteArrayList<String>()
        model.readerFlushRequester = null
        model.readerFlushStatusRequester = { id ->
            statusFlushedIds.add(id)
            model.readerEdit(id, "# Live Note\n\nStatusFlushNeedle on line three.\n")
            ReaderFlushStatus.ACKNOWLEDGED
        }
        model.openFolderSearch("StatusFlushNeedle")
        await { !model.folderSearch.value.scanning && model.folderSearch.value.matches.size == 1 }
        assertEquals(listOf(activeId), statusFlushedIds.toList())
        assertEquals("StatusFlushNeedle on line three.", model.folderSearch.value.matches.single().snippet)

        model.updateFolderSearch(query = "", caseSensitive = true, includeDiagrams = true)
        assertEquals(
            FolderSearchState(visible = true, query = "", caseSensitive = true, includeDiagrams = true, scanning = false),
            model.folderSearch.value,
        )

        model.updateFolderSearch(query = "StatusFlushNeedle", caseSensitive = true)
        await { !model.folderSearch.value.scanning && model.folderSearch.value.matches.size == 1 }
        model.openSearchMatch(model.folderSearch.value.matches.single())
        assertFalse(model.folderSearch.value.visible)
        assertFalse(model.folderSearch.value.scanning)

        val seed = model.seededFind.value
        assertNotNull(seed)
        assertEquals("StatusFlushNeedle", seed!!.query)
        assertTrue(seed.caseSensitive)
        assertEquals("StatusFlushNeedle", seed.matchText)
        assertEquals(
            "StatusFlushNeedle",
            model.state.value.active.content.substring(seed.sourceStart!!, seed.sourceEnd!!),
        )
        assertTrue(model.activeMatchesSeedTarget(model.state.value.active, seed))
        assertFalse(model.activeMatchesSeedTarget(Note(id = "", name = "Empty.md"), seed))
        assertTrue(
            model.activeMatchesSeedTarget(
                Note(id = "other", uri = "file:///tmp/seeded.md"),
                seed.copy(targetTabId = null, targetUri = "file:///tmp/seeded.md"),
            ),
        )
        model.consumeSeededFind(seed.nonce + 1L)
        assertEquals(seed, model.seededFind.value)
        model.consumeSeededFind(seed.nonce)
        assertNull(model.seededFind.value)

        // Synthetic match without valid source offsets clears sourceStart/sourceEnd/matchText to null.
        model.openFolderSearch("StatusFlushNeedle")
        await { !model.folderSearch.value.scanning && model.folderSearch.value.matches.size == 1 }
        val syntheticNoRangeMatch = model.folderSearch.value.matches.single().copy(
            sourceStart = -1,
            sourceEnd = -1,
            matchText = "ignored",
        )
        model.openSearchMatch(syntheticNoRangeMatch)
        val unindexedSeed = model.seededFind.value!!
        assertNull(unindexedSeed.sourceStart)
        assertNull(unindexedSeed.sourceEnd)
        assertNull(unindexedSeed.matchText)
        model.consumeSeededFind(unindexedSeed.nonce)

        val flushEntered = AtomicBoolean(false)
        val jobCancelled = AtomicBoolean(false)
        val gate = CompletableDeferred<Boolean>()
        val inFlightStore = ViewModelStore().also(stores::add)
        val inFlightModel = newModel(inFlightStore) { _, _ ->
            flushEntered.set(true)
            try {
                gate.await()
            } catch (cancelled: CancellationException) {
                jobCancelled.set(true)
                throw cancelled
            }
        }
        inFlightModel.openFolderSearch("PendingCancelQuery")
        await { flushEntered.get() && inFlightModel.folderSearch.value.scanning }
        inFlightStore.clear()
        await { jobCancelled.get() }
        assertTrue(jobCancelled.get())
    }

    @Test
    fun cancellationDuringFlushOrActiveFolderScanAbortsWorkAndDropsStaleResults() {
        val rootDir = newTempDir("search-cancel")
        File(rootDir, "01-blocked.md").writeText("# One\nCancelScanNeedle\n")
        File(rootDir, "02-later.md").writeText("# Two\nCancelScanNeedle and ReplacementNeedle\n")
        val authority = "dev.supermd.test.searchcancel.${UUID.randomUUID()}"
        val provider = SearchSafTestProvider(rootDir).also { it.attach(app, authority) }
        ShadowContentResolver.registerProviderInternal(authority, provider)
        val treeUri = DocumentsContract.buildTreeDocumentUri(authority, "root")
        grantTreeReadWrite(treeUri)

        val flushGate = CompletableDeferred<Boolean>()
        val flushEntered = AtomicBoolean(false)
        val flushCancelled = AtomicBoolean(false)
        val model = newModel { _, _ ->
            if (!flushEntered.getAndSet(true)) {
                try {
                    flushGate.await()
                } catch (cancelled: CancellationException) {
                    flushCancelled.set(true)
                    throw cancelled
                }
            } else {
                true
            }
        }
        model.setFolder(treeUri)
        await { model.state.value.folder == treeUri.toString() && model.state.value.files.size == 2 }
        provider.readOpenCounts.clear()

        // Cancelling while openFolderSearch awaits active-reader flush must propagate CancellationException
        // and never begin scanning folder files on IO.
        model.openFolderSearch("CancelScanNeedle")
        await { flushEntered.get() && model.folderSearch.value.scanning }
        model.cancelWorkspaceSearch()
        await { flushCancelled.get() }
        assertFalse(model.folderSearch.value.visible)
        assertFalse(model.folderSearch.value.scanning)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(60))
        assertEquals(0, provider.totalReadOpens())

        // Cancelling mid-scan (or superseding via updateFolderSearch) must not commit stale batches,
        // and a replacement query must publish only its own matches.
        val blockFirstReadClaimed = AtomicBoolean(false)
        val blockFirstReadEntered = CountDownLatch(1)
        val releaseBlockedRead = CountDownLatch(1)
        provider.readHook = { docId ->
            if (docId == "root/01-blocked.md" && blockFirstReadClaimed.compareAndSet(false, true)) {
                blockFirstReadEntered.countDown()
                releaseBlockedRead.await(15, TimeUnit.SECONDS)
            }
        }
        try {
            model.openFolderSearch("CancelScanNeedle")
            awaitLatch(blockFirstReadEntered)
            assertTrue(model.folderSearch.value.visible && model.folderSearch.value.scanning)

            model.updateFolderSearch(query = "ReplacementNeedle")
            releaseBlockedRead.countDown()
            await { !model.folderSearch.value.scanning && model.folderSearch.value.query == "ReplacementNeedle" }
            assertTrue(model.folderSearch.value.visible)
            assertEquals(1, model.folderSearch.value.matches.size)
            assertEquals("02-later.md", model.folderSearch.value.matches.single().name)
        } finally {
            provider.readHook = null
            releaseBlockedRead.countDown()
        }

        // Explicit cancelWorkspaceSearch while scanning hides the modal and clears scanning immediately.
        val secondReadClaimed = AtomicBoolean(false)
        val secondReadEntered = CountDownLatch(1)
        val releaseSecondRead = CountDownLatch(1)
        provider.readHook = { docId ->
            if (docId == "root/01-blocked.md" && secondReadClaimed.compareAndSet(false, true)) {
                secondReadEntered.countDown()
                releaseSecondRead.await(15, TimeUnit.SECONDS)
            }
        }
        try {
            model.updateFolderSearch(query = "CancelScanNeedle")
            awaitLatch(secondReadEntered)
            model.cancelWorkspaceSearch()
            assertFalse(model.folderSearch.value.visible)
            assertFalse(model.folderSearch.value.scanning)
        } finally {
            provider.readHook = null
            releaseSecondRead.countDown()
        }
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(80))
        assertFalse(model.folderSearch.value.visible)
        assertFalse(model.folderSearch.value.scanning)
    }

    @Test
    fun safProviderDeduplicationAndSelectionOrderHandleSlowOpensAndStaleMatches() {
        val rootDir = newTempDir("search-selection")
        File(rootDir, "OpenDirty.md").writeText("# Open Dirty\nDiskStaleOnlyToken and SharedDedupNeedle\n")
        File(rootDir, "UnopenedTarget.md").writeText("# Unopened\nSharedDedupNeedle in folder\n")
        File(rootDir, "ClosableSaved.md").writeText("# Closable\nReopenSavedNeedle on disk\n")
        File(rootDir, "SlowBackground.md").writeText("# Slow\nSlowBackgroundContent\n")

        val authority = "dev.supermd.test.searchselect.${UUID.randomUUID()}"
        val provider = SearchSafTestProvider(rootDir).also { it.attach(app, authority) }
        ShadowContentResolver.registerProviderInternal(authority, provider)
        val treeUri = DocumentsContract.buildTreeDocumentUri(authority, "root")
        grantTreeReadWrite(treeUri)

        // Plain standalone document URI (distinct URI representation from treeUri child URI)
        val plainOpenDirtyUri = DocumentsContract.buildDocumentUri(authority, "root/OpenDirty.md")
        app.grantUriPermission(
            app.packageName,
            plainOpenDirtyUri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
        )

        val model = newModel { _, _ -> true }
        model.setFolder(treeUri)
        await { model.state.value.folder == treeUri.toString() && model.state.value.files.size == 4 }

        model.open(plainOpenDirtyUri)
        await { model.state.value.active.uri != null && sameDocument(Uri.parse(model.state.value.active.uri), plainOpenDirtyUri) }
        val openDirtyTabId = model.state.value.active.id
        model.edit(openDirtyTabId, "# Open Dirty\nLiveEditedBuffer and SharedDedupNeedle\n")

        provider.readOpenCounts.clear()
        model.openFolderSearch("SharedDedupNeedle")
        await { !model.folderSearch.value.scanning && model.folderSearch.value.matches.size == 2 }

        // #114 SAF provider deduplication: OpenDirty.md was matched from the live dirty tab once
        // without opening a duplicate SAF stream for root/OpenDirty.md during folder traversal.
        assertEquals(0, provider.readOpenCounts["root/OpenDirty.md"]?.get() ?: 0)
        assertEquals(1, provider.readOpenCounts["root/UnopenedTarget.md"]?.get() ?: 0)
        val dirtyMatch = model.folderSearch.value.matches.single { it.name == "OpenDirty.md" }
        val unopenedMatch = model.folderSearch.value.matches.single { it.name == "UnopenedTarget.md" }
        assertTrue(dirtyMatch.isOpen && dirtyMatch.dirty)
        assertFalse(unopenedMatch.isOpen)

        // Selecting an unopened folder match closes search first, seeds PendingSeededFind, and opens the note.
        model.openSearchMatch(unopenedMatch)
        assertFalse(model.folderSearch.value.visible)
        assertFalse(model.folderSearch.value.scanning)
        assertNotNull(model.seededFind.value)
        await { model.state.value.active.name == "UnopenedTarget.md" }
        assertTrue(model.activeMatchesSeedTarget(model.state.value.active, model.seededFind.value!!))
        model.consumeSeededFind(model.seededFind.value!!.nonce)

        // Start a slow background open, then select the already-open OpenDirty.md match from folder search:
        // select() invalidates the earlier slow open request so SlowBackground.md is retained in background
        // without stealing focus from the selected search match.
        val slowUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, "root/SlowBackground.md")
        val slowReadClaimed = AtomicBoolean(false)
        val slowReadEntered = CountDownLatch(1)
        val releaseSlowRead = CountDownLatch(1)
        provider.readHook = { docId ->
            if (docId == "root/SlowBackground.md" && slowReadClaimed.compareAndSet(false, true)) {
                slowReadEntered.countDown()
                releaseSlowRead.await(15, TimeUnit.SECONDS)
            }
        }
        try {
            model.open(slowUri, "SlowBackground.md")
            awaitLatch(slowReadEntered)

            model.openFolderSearch("LiveEditedBuffer")
            await { !model.folderSearch.value.scanning && model.folderSearch.value.matches.size == 1 }
            val liveDirtyMatch = model.folderSearch.value.matches.single()
            model.openSearchMatch(liveDirtyMatch)
            assertFalse(model.folderSearch.value.visible)
            await { model.state.value.active.id == openDirtyTabId }
            assertEquals("LiveEditedBuffer", model.seededFind.value?.query)
            assertTrue(model.activeMatchesSeedTarget(model.state.value.active, model.seededFind.value!!))
        } finally {
            provider.readHook = null
            releaseSlowRead.countDown()
        }
        await { model.state.value.tabs.any { it.name == "SlowBackground.md" } }
        assertEquals("Earlier slow open must not steal focus after search match tab selection", openDirtyTabId, model.state.value.active.id)

        // Stale match 1: file-backed tab closed after search ran -> openSearchMatch reopens by URI and matches seed by URI.
        val closableUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, "root/ClosableSaved.md")
        model.open(closableUri, "ClosableSaved.md")
        await { model.state.value.active.name == "ClosableSaved.md" }
        val originalClosableId = model.state.value.active.id
        model.openFolderSearch("ReopenSavedNeedle")
        await { !model.folderSearch.value.scanning && model.folderSearch.value.matches.size == 1 }
        val staleSavedMatch = model.folderSearch.value.matches.single()
        assertEquals(originalClosableId, staleSavedMatch.tabId)
        model.requestClose(originalClosableId)
        await { model.state.value.tabs.none { it.id == originalClosableId } }

        model.openSearchMatch(staleSavedMatch)
        assertFalse(model.folderSearch.value.visible)
        await { model.state.value.active.name == "ClosableSaved.md" }
        assertNotEquals(originalClosableId, model.state.value.active.id)
        assertTrue(model.activeMatchesSeedTarget(model.state.value.active, model.seededFind.value!!))

        // Stale match 2: unsaved draft tab closed before selection -> search closes cleanly, active tab stays unchanged,
        // and the unrelated active tab does NOT match the closed draft's seeded find.
        val activeBeforeDraft = model.state.value.active.id
        model.newNote()
        await { model.state.value.active.id != activeBeforeDraft && model.state.value.active.uri == null }
        val draftId = model.state.value.active.id
        model.edit(draftId, "# Ephemeral\nClosedDraftNeedle\n")
        model.openFolderSearch("ClosedDraftNeedle")
        await { !model.folderSearch.value.scanning && model.folderSearch.value.matches.size == 1 }
        val staleDraftMatch = model.folderSearch.value.matches.single()
        assertNull(staleDraftMatch.uri)
        model.requestClose(draftId)
        await { model.state.value.pendingCloseNoteId == draftId }
        model.resolveCloseConfirmation("discard")
        await { model.state.value.tabs.none { it.id == draftId } }
        val currentActiveAfterClose = model.state.value.active.id

        model.openSearchMatch(staleDraftMatch)
        assertFalse(model.folderSearch.value.visible)
        assertFalse(model.folderSearch.value.scanning)
        assertEquals(currentActiveAfterClose, model.state.value.active.id)
        assertNotNull(model.seededFind.value)
        assertFalse(model.activeMatchesSeedTarget(model.state.value.active, model.seededFind.value!!))
    }

    @Test
    fun openSearchMatchPreservesGuardedNoteOpenAndBlockedWriteState() {
        val rootDir = newTempDir("search-guarded")
        File(rootDir, "RevokedTarget.md").writeText("# Revoked\nGuardedOpenNeedle in revoked file\n")
        File(rootDir, "ReadOnlyBlocked.md").writeText("# ReadOnly\nGuardedOpenNeedle in read-only file\n")

        val authority = "dev.supermd.test.searchguarded.${UUID.randomUUID()}"
        val provider = SearchSafTestProvider(rootDir).also { it.attach(app, authority) }
        ShadowContentResolver.registerProviderInternal(authority, provider)
        val treeUri = DocumentsContract.buildTreeDocumentUri(authority, "root")
        // Grant READ-ONLY on treeUri so opening does not clear blocked write state.
        app.grantUriPermission(
            app.packageName,
            treeUri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION or
                Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or
                Intent.FLAG_GRANT_PREFIX_URI_PERMISSION,
        )

        val model = newModel { _, _ -> true }
        model.setFolder(treeUri)
        await { model.state.value.folder == treeUri.toString() && model.state.value.files.size == 2 }

        // Open ReadOnlyBlocked.md and trigger a write-permission failure so it is tracked as write-blocked (#137).
        val readOnlyUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, "root/ReadOnlyBlocked.md")
        model.open(readOnlyUri, "ReadOnlyBlocked.md")
        await { model.state.value.active.name == "ReadOnlyBlocked.md" }
        val readOnlyTabId = model.state.value.active.id
        model.edit(readOnlyTabId, "# ReadOnly\nGuardedOpenNeedle in read-only file (dirty)\n")
        provider.failWriteDocIds.add("root/ReadOnlyBlocked.md")
        model.saveManual(readOnlyTabId)
        await { model.documentWriteNeedsAccess(readOnlyTabId) }
        model.dismissDocumentAccess()

        // Switch away to Welcome.md so ReadOnlyBlocked.md is inactive.
        val welcomeTabId = model.state.value.tabs.first { it.name == "Welcome.md" }.id
        model.select(welcomeTabId)
        await { model.state.value.active.id == welcomeTabId }

        // Discover both matches via openFolderSearch while RevokedTarget.md is still readable.
        model.openFolderSearch("GuardedOpenNeedle")
        await { !model.folderSearch.value.scanning && model.folderSearch.value.matches.size == 2 }
        val revokedMatch = model.folderSearch.value.matches.single { it.name == "RevokedTarget.md" }

        // 1. Revoke read access on RevokedTarget.md before selecting its search match:
        // openSearchMatch closes search first, then routes through StudioViewModel's guarded openNoteInternal,
        // surfacing a read DocumentAccessRequest without crashing or corrupting the active tab.
        provider.failReadDocIds.add("root/RevokedTarget.md")
        model.openSearchMatch(revokedMatch)
        assertFalse(model.folderSearch.value.visible)
        assertFalse(model.folderSearch.value.scanning)
        await { model.documentAccessRequests.value != null }
        val accessReq = model.documentAccessRequests.value!!
        assertFalse(accessReq.writing)
        assertTrue(sameDocument(Uri.parse(accessReq.uri), Uri.parse(revokedMatch.uri!!)))
        assertEquals(DOCUMENT_ACCESS_MESSAGE, model.state.value.message)
        assertEquals(welcomeTabId, model.state.value.active.id)
        model.dismissDocumentAccess()

        // 2. Selecting the blocked-write tab match switches to ReadOnlyBlocked.md, seeds in-note find,
        // and preserves documentWriteNeedsAccess(readOnlyTabId) == true.
        provider.failReadDocIds.remove("root/RevokedTarget.md")
        model.openFolderSearch("GuardedOpenNeedle")
        await { !model.folderSearch.value.scanning && model.folderSearch.value.matches.any { it.name == "ReadOnlyBlocked.md" } }
        val refreshedBlockedMatch = model.folderSearch.value.matches.first { it.name == "ReadOnlyBlocked.md" }
        model.openSearchMatch(refreshedBlockedMatch)
        await { model.state.value.active.id == readOnlyTabId }
        assertTrue("Write-blocked state must remain guarded on search match selection", model.documentWriteNeedsAccess(readOnlyTabId))
        assertNotNull(model.seededFind.value)
        assertTrue(model.activeMatchesSeedTarget(model.state.value.active, model.seededFind.value!!))
    }

    @Test
    fun occurrenceUtf16OffsetsStaleRangeFallbackAndBoundedBatchPublication() {
        val rootDir = newTempDir("search-occurrences-bounded")
        val crlfUnicodeContent = listOf(
            "# İstanbul \uD83D\uDCD3 Lab",
            "First AuroraSignal and second \uD83D\uDCD3 AuroraSignal on same CRLF line.",
            "Straße precedes [hidden](https://example.com/AuroraSignal) and fourth AURORASIGNAL.",
        ).joinToString("\r\n")
        File(rootDir, "00-unicode.md").writeBytes(crlfUnicodeContent.toByteArray(Charsets.UTF_8))
        val unicodeAuthority = "dev.supermd.test.searchocc.${UUID.randomUUID()}"
        val unicodeProvider = SearchSafTestProvider(rootDir).also { it.attach(app, unicodeAuthority) }
        ShadowContentResolver.registerProviderInternal(unicodeAuthority, unicodeProvider)
        val unicodeTreeUri = DocumentsContract.buildTreeDocumentUri(unicodeAuthority, "root")
        grantTreeReadWrite(unicodeTreeUri)

        val barrierFlushedIds = CopyOnWriteArrayList<String>()
        val model = newModel { activeId, _ ->
            barrierFlushedIds.add(activeId)
            true
        }
        model.setFolder(unicodeTreeUri)
        await { model.state.value.folder == unicodeTreeUri.toString() && model.state.value.files.size == 1 }

        // 1. Selected occurrence & UTF-16 offsets across CRLF, surrogate pairs, and Unicode case folding (#96).
        model.openFolderSearch("aurorasignal")
        await { !model.folderSearch.value.scanning && model.folderSearch.value.matches.size == 4 }
        val occurrences = model.folderSearch.value.matches
        assertEquals(
            listOf("AuroraSignal", "AuroraSignal", "AuroraSignal", "AURORASIGNAL"),
            occurrences.map { crlfUnicodeContent.substring(it.sourceStart, it.sourceEnd) },
        )
        val thirdOccurrence = occurrences[2]
        model.openSearchMatch(thirdOccurrence)
        assertFalse(model.folderSearch.value.visible)
        await { model.state.value.active.name == "00-unicode.md" }
        val thirdSeed = model.seededFind.value!!
        assertEquals(thirdOccurrence.sourceStart, thirdSeed.sourceStart)
        assertEquals(thirdOccurrence.sourceEnd, thirdSeed.sourceEnd)
        assertEquals("AuroraSignal", thirdSeed.matchText)
        assertTrue(thirdSeed.sourceStart!! > occurrences[1].sourceEnd)
        assertEquals("AuroraSignal", model.state.value.active.content.substring(thirdSeed.sourceStart!!, thirdSeed.sourceEnd!!))
        model.consumeSeededFind(thirdSeed.nonce)

        // Case-insensitive "strasse" -> "Straße" preserves exact 6-UTF-16-unit source span despite 7-char folded query.
        model.openFolderSearch("strasse")
        await { !model.folderSearch.value.scanning && model.folderSearch.value.matches.size == 1 }
        val strasseMatch = model.folderSearch.value.matches.single()
        model.openSearchMatch(strasseMatch)
        val strasseSeed = model.seededFind.value!!
        assertEquals(6, strasseSeed.sourceEnd!! - strasseSeed.sourceStart!!)
        assertEquals("Straße", strasseSeed.matchText)
        assertEquals("Straße", model.state.value.active.content.substring(strasseSeed.sourceStart!!, strasseSeed.sourceEnd!!))
        model.consumeSeededFind(strasseSeed.nonce)

        // 2. Stale-range fallback:
        // (a) When the active note is edited after folder search ran so [sourceStart, sourceEnd) is now stale,
        // FolderSearchController forwards the original occurrence bounds + matchText and flushes the active-tab
        // reader barrier so the WebView handoff enters passive 0 / N stale-range fallback instead of jumping to 1 / N.
        model.openFolderSearch("AuroraSignal")
        await { !model.folderSearch.value.scanning && model.folderSearch.value.matches.size == 4 }
        val fourthOccurrence = model.folderSearch.value.matches[3]
        val unicodeTabId = model.state.value.active.id
        model.edit(unicodeTabId, "# Shortened after search\nOnly one AuroraSignal remains.\n")
        assertTrue(fourthOccurrence.sourceEnd > model.state.value.active.content.length)
        barrierFlushedIds.clear()
        model.openSearchMatch(fourthOccurrence)
        await { barrierFlushedIds.contains(unicodeTabId) }
        val staleRangeSeed = model.seededFind.value!!
        assertEquals(fourthOccurrence.sourceStart, staleRangeSeed.sourceStart)
        assertEquals(fourthOccurrence.sourceEnd, staleRangeSeed.sourceEnd)
        assertEquals("AURORASIGNAL", staleRangeSeed.matchText)
        assertTrue(model.activeMatchesSeedTarget(model.state.value.active, staleRangeSeed))
        model.consumeSeededFind(staleRangeSeed.nonce)

        // (b) Inverted or negative occurrence bounds normalize cleanly to null.
        model.openFolderSearch("AuroraSignal")
        await { !model.folderSearch.value.scanning && model.folderSearch.value.matches.size == 1 }
        val invertedMatch = model.folderSearch.value.matches.single().copy(sourceStart = 18, sourceEnd = 10, matchText = "AuroraSignal")
        model.openSearchMatch(invertedMatch)
        val invertedSeed = model.seededFind.value!!
        assertNull(invertedSeed.sourceStart)
        assertNull(invertedSeed.sourceEnd)
        assertNull(invertedSeed.matchText)
        model.consumeSeededFind(invertedSeed.nonce)

        // 3. Bounded Android search results (50 per note, 500 total, truncated = true) and progressive batch publication.
        val boundedDir = newTempDir("search-bounded-batches")
        // note_00 has 65 hits (capped at MAX_MATCHES_PER_NOTE = 50); notes 01..11 have 50 hits each -> 600 capped at 500.
        File(boundedDir, "note_00.md").writeText((1..65).joinToString("\n") { "BoundedHit line $it in note 00" })
        for (idx in 1..11) {
            val label = "%02d".format(idx)
            File(boundedDir, "note_$label.md").writeText((1..50).joinToString("\n") { "BoundedHit line $it in note $label" })
        }
        val boundedAuthority = "dev.supermd.test.searchbounded.${UUID.randomUUID()}"
        val boundedProvider = SearchSafTestProvider(boundedDir).also { it.attach(app, boundedAuthority) }
        ShadowContentResolver.registerProviderInternal(boundedAuthority, boundedProvider)
        val boundedTreeUri = DocumentsContract.buildTreeDocumentUri(boundedAuthority, "root")
        grantTreeReadWrite(boundedTreeUri)
        model.setFolder(boundedTreeUri)
        await { model.state.value.folder == boundedTreeUri.toString() && model.state.value.files.size == 12 }

        val publishedCounts = CopyOnWriteArrayList<Pair<Int, Boolean>>()
        val collectorScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        try {
            collectorScope.launch {
                model.folderSearch.collect { state ->
                    if (state.query == "BoundedHit" && state.visible) {
                        publishedCounts.add(state.matches.size to state.scanning)
                    }
                }
            }
            model.openFolderSearch("BoundedHit")
            await { !model.folderSearch.value.scanning && model.folderSearch.value.query == "BoundedHit" }

            val finalSearch = model.folderSearch.value
            assertTrue(finalSearch.visible)
            assertFalse(finalSearch.scanning)
            assertTrue("Expected truncated = true once total matches reach 500", finalSearch.truncated)
            assertEquals(500, finalSearch.matches.size)
            assertEquals(50, finalSearch.matches.count { it.name == "note_00.md" })
            assertTrue(
                "Expected progressive streaming batch publications while scanning before final 500-match cap",
                publishedCounts.any { (count, scanning) -> scanning && count in 1..499 },
            )
            val countsOnly = publishedCounts.map { it.first }
            assertEquals("Published match counts must grow monotonically", countsOnly.sorted(), countsOnly)
        } finally {
            collectorScope.cancel()
        }
    }

    @Test
    fun filesModeScansSafMetadataWithoutOpeningStreamsAndOpensMatchWithoutSeededFind() {
        val rootDir = newTempDir("saf-files-mode")
        val subDir = File(rootDir, "research").apply { mkdirs() }
        File(rootDir, "alpha.md").writeText("# Alpha\n\nBody token SecretBodyHit.\n", Charsets.UTF_8)
        File(subDir, "quantum-notes.smd").writeText("not-even-a-valid-zip-if-opened", Charsets.UTF_8)

        val filesAuthority = "dev.supermd.test.filesmode.${UUID.randomUUID()}"
        val provider = SearchSafTestProvider(rootDir).also { it.attach(app, filesAuthority) }
        ShadowContentResolver.registerProviderInternal(filesAuthority, provider)
        val treeUri = DocumentsContract.buildTreeDocumentUri(filesAuthority, "root")
        grantTreeReadWrite(treeUri)

        var flushCalls = 0
        val model = newModel { _, _ -> flushCalls++; true }
        model.setFolder(treeUri)
        await { model.state.value.folder == treeUri.toString() && model.state.value.files.isNotEmpty() }

        model.openFolderSearch("SecretBodyHit", FolderSearchMode.TEXT)
        await { !model.folderSearch.value.scanning && model.folderSearch.value.matches.size == 1 }
        model.openSearchMatch(model.folderSearch.value.matches.single())
        await { model.seededFind.value?.query == "SecretBodyHit" }

        provider.readOpenCounts.clear()
        flushCalls = 0
        model.openFolderSearch("quantum", FolderSearchMode.FILES)
        await {
            !model.folderSearch.value.scanning &&
                model.folderSearch.value.mode == FolderSearchMode.FILES &&
                model.folderSearch.value.matches.size == 1
        }
        assertEquals("Files mode must not flush active reader on open", 0, flushCalls)
        assertEquals("Files mode must never open SAF file streams", 0, provider.readOpenCounts.values.sumOf { it.get() })
        assertTrue(model.folderSearch.value.matches.single().isFileMatch)
        assertEquals("research/quantum-notes.smd", model.folderSearch.value.matches.single().relative)

        model.updateFolderSearch(query = "alpha", mode = FolderSearchMode.FILES)
        await { !model.folderSearch.value.scanning && model.folderSearch.value.matches.map { it.name } == listOf("alpha.md") }
        assertEquals("Files mode update must never open SAF file streams", 0, provider.readOpenCounts.values.sumOf { it.get() })

        model.openSearchMatch(model.folderSearch.value.matches.single())
        await { model.state.value.active.name == "alpha.md" }
        assertNull("Opening a Files-mode match must not arm in-note seededFind", model.seededFind.value)
    }

    private fun grantTreeReadWrite(treeUri: Uri) {
        app.grantUriPermission(
            app.packageName,
            treeUri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION or
                Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or
                Intent.FLAG_GRANT_PREFIX_URI_PERMISSION,
        )
    }

    private fun newTempDir(prefix: String): File =
        Files.createTempDirectory(prefix).toFile().also(tempDirs::add)

    private fun newModel(
        store: ViewModelStore = ViewModelStore().also(stores::add),
        flush: suspend (String, StudioViewModel) -> Boolean,
    ): StudioViewModel {
        val key = "folder-search-ctrl-${UUID.randomUUID()}".also(keys::add)
        return StudioViewModel(app, key).also { vm ->
            vm.readerFlushRequester = { id -> flush(id, vm) }
            store.put("vm-$key", vm)
        }
    }

    private fun awaitLatch(latch: CountDownLatch) {
        val deadline = System.currentTimeMillis() + 15_000L
        while (System.currentTimeMillis() < deadline) {
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(20))
            if (latch.await(15, TimeUnit.MILLISECONDS)) return
        }
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(20))
        assertTrue("Timed out waiting for background latch", latch.await(15, TimeUnit.MILLISECONDS))
    }

    private fun await(predicate: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 15_000L
        while (System.currentTimeMillis() < deadline) {
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(20))
            if (predicate()) return
            Thread.sleep(10)
        }
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(20))
        assertTrue(predicate())
    }
}

private class SearchSafTestProvider(private val rootDir: File) : ContentProvider() {
    val readOpenCounts = ConcurrentHashMap<String, AtomicInteger>()
    val failReadDocIds: MutableSet<String> = ConcurrentHashMap.newKeySet()
    val failWriteDocIds: MutableSet<String> = ConcurrentHashMap.newKeySet()
    @Volatile var readHook: ((String) -> Unit)? = null

    fun attach(context: Context, authority: String) {
        val info = ProviderInfo().apply {
            this.authority = authority
            exported = true
            grantUriPermissions = true
        }
        attachInfo(context, info)
    }

    fun totalReadOpens(): Int = readOpenCounts.values.sumOf { it.get() }

    override fun onCreate(): Boolean = true

    private fun fileForDocId(docId: String): File {
        val rel = docId.removePrefix("root").trimStart('/')
        return if (rel.isEmpty()) rootDir else File(rootDir, rel)
    }

    private fun docIdForFile(file: File): String {
        val rel = file.relativeTo(rootDir).invariantSeparatorsPath
        return if (rel.isEmpty()) "root" else "root/$rel"
    }

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor {
        val columns = projection ?: arrayOf(
            Document.COLUMN_DOCUMENT_ID,
            Document.COLUMN_DISPLAY_NAME,
            Document.COLUMN_MIME_TYPE,
            Document.COLUMN_SIZE,
            Document.COLUMN_LAST_MODIFIED,
            Document.COLUMN_FLAGS,
        )
        val cursor = MatrixCursor(columns)
        val encodedPath = uri.encodedPath.orEmpty()
        if ("/children" in encodedPath) {
            val parentId = DocumentsContract.getDocumentId(
                Uri.Builder().scheme(uri.scheme).authority(uri.authority)
                    .encodedPath(encodedPath.substringBefore("/children")).build(),
            )
            val dir = fileForDocId(parentId)
            dir.listFiles()?.sortedBy { it.name }?.forEach { child ->
                cursor.addRow(rowFor(columns, child))
            }
        } else {
            val docId = runCatching { DocumentsContract.getDocumentId(uri) }
                .getOrElse { DocumentsContract.getTreeDocumentId(uri) }
            val file = fileForDocId(docId)
            if (!file.exists()) throw FileNotFoundException(docId)
            cursor.addRow(rowFor(columns, file))
        }
        return cursor
    }

    private fun rowFor(columns: Array<out String>, file: File): Array<Any?> =
        columns.map { col ->
            when (col) {
                Document.COLUMN_DOCUMENT_ID -> docIdForFile(file)
                Document.COLUMN_DISPLAY_NAME, OpenableColumns.DISPLAY_NAME -> file.name
                Document.COLUMN_MIME_TYPE -> if (file.isDirectory) Document.MIME_TYPE_DIR else "text/markdown"
                Document.COLUMN_SIZE, OpenableColumns.SIZE -> file.length()
                Document.COLUMN_LAST_MODIFIED -> file.lastModified()
                Document.COLUMN_FLAGS -> Document.FLAG_SUPPORTS_WRITE
                else -> null
            }
        }.toTypedArray()

    override fun getType(uri: Uri): String {
        val docId = runCatching { DocumentsContract.getDocumentId(uri) }.getOrDefault("root")
        return if (fileForDocId(docId).isDirectory) Document.MIME_TYPE_DIR else "text/markdown"
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        val docId = DocumentsContract.getDocumentId(uri)
        val writing = mode != "r"
        if (writing && docId in failWriteDocIds) {
            throw SecurityException("Write permission denied for $docId")
        }
        if (!writing) {
            if (docId in failReadDocIds) {
                throw SecurityException("Read permission denied for $docId")
            }
            readOpenCounts.computeIfAbsent(docId) { AtomicInteger(0) }.incrementAndGet()
            readHook?.invoke(docId)
        }
        val file = fileForDocId(docId)
        if (!file.exists() && !writing) throw FileNotFoundException(docId)
        val flags = when (mode) {
            "r" -> ParcelFileDescriptor.MODE_READ_ONLY
            "rw" -> ParcelFileDescriptor.MODE_READ_WRITE
            "wt", "w" -> ParcelFileDescriptor.MODE_WRITE_ONLY or ParcelFileDescriptor.MODE_CREATE or ParcelFileDescriptor.MODE_TRUNCATE
            else -> ParcelFileDescriptor.parseMode(mode)
        }
        return ParcelFileDescriptor.open(file, flags)
    }
}
