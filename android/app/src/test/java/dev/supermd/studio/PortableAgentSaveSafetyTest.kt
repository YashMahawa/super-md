package dev.supermd.studio

import android.net.Uri
import android.os.Looper
import android.util.Base64
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
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
import java.util.concurrent.TimeUnit

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

    private fun pumpMainLooper(advanceMs: Long = 25) {
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(advanceMs))
    }

    private fun awaitJob(job: Job, timeoutMs: Long = 5_000) {
        val deadlineNs = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
        while (!job.isCompleted && System.nanoTime() < deadlineNs) {
            pumpMainLooper(25)
            Thread.sleep(10)
        }
        pumpMainLooper(25)
        assertTrue("Job did not complete within ${timeoutMs}ms", job.isCompleted)
    }

    private fun awaitCondition(timeoutMs: Long = 5_000, predicate: () -> Boolean) {
        val deadlineNs = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
        while (!predicate() && System.nanoTime() < deadlineNs) {
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
        val workspaceKey = "test-${UUID.randomUUID()}"
        val store = androidx.lifecycle.ViewModelStore()
        val factory = object : androidx.lifecycle.ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : androidx.lifecycle.ViewModel> create(modelClass: Class<T>): T =
                StudioViewModel(app, workspaceKey).apply {
                    reading(autosave = false)
                    readerFlushRequester = { true }
                } as T
        }
        val model = androidx.lifecycle.ViewModelProvider(store, factory)[StudioViewModel::class.java]
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
            awaitJob(model.refreshJob!!)
            assertEquals(initialDir, model.state.value.active.assetDirectory)
            awaitCondition {
                bundlesRoot.listFiles()?.map { it.name }?.toSet().orEmpty() == baselineDirs + initialDir
            }

            // 2. Updating only an embedded asset externally reloads assetDirectory, invalidates reader assets, and deletes initialDir.
            val staleCapability = capabilities.register(noteId, "assets/fig.svg", "image/svg+xml", "fp-1")!!
            file.outputStream().use { model.media.writeFmd(it, "# Version 1\n\n![Fig](assets/fig.svg)\n", svgAssets("assets/fig.svg", svgB)) }
            model.refreshExternal()
            awaitJob(model.refreshJob!!)

            val assetUpdatedDir = model.state.value.active.assetDirectory!!
            assertNotEquals(initialDir, assetUpdatedDir)
            assertArrayEquals(svgB, model.media.local("assets/fig.svg", assetUpdatedDir)!!.readBytes())
            assertNull(capabilities.lookup(staleCapability.token) { true })
            awaitCondition {
                !File(bundlesRoot, initialDir).exists() &&
                    bundlesRoot.listFiles()?.map { it.name }?.toSet().orEmpty() == baselineDirs + assetUpdatedDir
            }

            // 3. Updating Markdown + asset externally with rapid consecutive refresh notifications adopts the latest archive without leaking.
            file.outputStream().use { model.media.writeFmd(it, "# Version 2\n\n![Fig](assets/fig.svg)\n", svgAssets("assets/fig.svg", svgA)) }
            val cancelEnteredIo = CompletableDeferred<Unit>()
            val cancelHoldIo = CompletableDeferred<Unit>()
            model.refreshExternalIoObserver = {
                cancelEnteredIo.complete(Unit)
                cancelHoldIo.await()
            }
            model.refreshExternal()
            val supersededRefreshJob = model.refreshJob!!
            awaitCondition { cancelEnteredIo.isCompleted }
            model.refreshExternalIoObserver = null
            model.refreshExternal()
            awaitJob(supersededRefreshJob)
            awaitJob(model.refreshJob!!)

            val reloadedDir = model.state.value.active.assetDirectory!!
            assertNotEquals(assetUpdatedDir, reloadedDir)
            assertEquals("# Version 2\n\n![Fig](assets/fig.svg)\n", model.state.value.active.content)
            assertEquals("# Version 2\n\n![Fig](assets/fig.svg)\n", model.state.value.active.saved)
            assertArrayEquals(svgA, model.media.local("assets/fig.svg", reloadedDir)!!.readBytes())
            awaitCondition {
                !File(bundlesRoot, assetUpdatedDir).exists() &&
                    bundlesRoot.listFiles()?.map { it.name }?.toSet().orEmpty() == baselineDirs + reloadedDir
            }

            // 4. Cancelling refreshJob right after state adoption preserves the newly adopted directory via the reference check while deleting superseded directories.
            file.outputStream().use { model.media.writeFmd(it, "# Version 2b\n\n![Fig](assets/fig.svg)\n", svgAssets("assets/fig.svg", svgB)) }
            var postAdoptCancelledJob: Job? = null
            model.refreshPostAdoptObserver = {
                postAdoptCancelledJob = model.refreshJob
                model.refreshJob?.cancel()
                kotlinx.coroutines.yield()
            }
            model.refreshExternal()
            awaitCondition { postAdoptCancelledJob?.isCompleted == true }
            model.refreshPostAdoptObserver = null

            val postCancelAdoptedDir = model.state.value.active.assetDirectory!!
            assertNotEquals(reloadedDir, postCancelAdoptedDir)
            assertEquals("# Version 2b\n\n![Fig](assets/fig.svg)\n", model.state.value.active.content)
            assertTrue(File(bundlesRoot, postCancelAdoptedDir).isDirectory)
            assertArrayEquals(svgB, model.media.local("assets/fig.svg", postCancelAdoptedDir)!!.readBytes())
            awaitCondition {
                !File(bundlesRoot, reloadedDir).exists() &&
                    bundlesRoot.listFiles()?.map { it.name }?.toSet().orEmpty() == baselineDirs + postCancelAdoptedDir
            }

            // 5. Local edits arriving after refresh starts abort adoption and delete any temporary extracted directory.
            file.outputStream().use { model.media.writeFmd(it, "# Version 3\n\n![Fig](assets/fig.svg)\n", svgAssets("assets/fig.svg", svgA)) }
            val editEnteredIo = CompletableDeferred<Unit>()
            val editReleaseIo = CompletableDeferred<Unit>()
            model.refreshExternalIoObserver = {
                editEnteredIo.complete(Unit)
                editReleaseIo.await()
            }
            model.refreshExternal()
            awaitCondition { editEnteredIo.isCompleted }
            model.edit(noteId, "# Unsaved local draft\n")
            model.refreshExternalIoObserver = null
            editReleaseIo.complete(Unit)
            awaitJob(model.refreshJob!!)

            assertEquals("# Unsaved local draft\n", model.state.value.active.content)
            assertEquals(postCancelAdoptedDir, model.state.value.active.assetDirectory)
            assertTrue(noteId in model.state.value.conflictedTabIds)
            awaitCondition {
                bundlesRoot.listFiles()?.map { it.name }?.toSet().orEmpty() == baselineDirs + postCancelAdoptedDir
            }
        } finally {
            model.refreshExternalPreIoObserver = null
            model.refreshExternalIoObserver = null
            model.refreshPostAdoptObserver = null
            model.detachReaderCapabilities(capabilities)
            val openDirs = model.state.value.tabs.mapNotNull { it.assetDirectory }
            store.clear()
            openDirs.forEach { File(bundlesRoot, it).deleteRecursively() }
            File(app.filesDir, "workspaces/$workspaceKey.json").deleteRecursively()
            File(app.filesDir, "workspaces/$workspaceKey").deleteRecursively()
            tempDir.deleteRecursively()
        }
    }

    @Test fun refreshExternalRevalidatesDirtySnapshotsAcrossConcurrentSaveRebindAndClose() {
        val app = RuntimeEnvironment.getApplication()
        val bundlesRoot = File(app.filesDir, "portable-assets")
        val baselineDirs = bundlesRoot.listFiles()?.map { it.name }?.toSet().orEmpty()
        val tempDir = Files.createTempDirectory("android-smd-dirty-revalidate").toFile()
        val workspaceKey = "test-${UUID.randomUUID()}"
        val store = androidx.lifecycle.ViewModelStore()
        val factory = object : androidx.lifecycle.ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : androidx.lifecycle.ViewModel> create(modelClass: Class<T>): T =
                StudioViewModel(app, workspaceKey).apply {
                    reading(autosave = false)
                    readerFlushRequester = { true }
                } as T
        }
        val model = androidx.lifecycle.ViewModelProvider(store, factory)[StudioViewModel::class.java]
        try {
            // 1. Concurrent ordinary Markdown save completing during an in-flight dirty scan does not produce a stale conflict.
            val mdFile = File(tempDir, "Concurrent.md").apply { writeText("# Version 1\n", Charsets.UTF_8) }
            awaitJob(model.open(Uri.fromFile(mdFile)))
            val mdId = model.state.value.active.id
            model.edit(mdId, "# Version 2\n")
            assertTrue(model.state.value.active.dirty)

            val mdPreIoEntered = CompletableDeferred<Unit>()
            val mdPreIoRelease = CompletableDeferred<Unit>()
            model.refreshExternalPreIoObserver = {
                mdPreIoEntered.complete(Unit)
                mdPreIoRelease.await()
            }
            model.refreshExternal()
            awaitCondition { mdPreIoEntered.isCompleted }

            // Save writes "# Version 2\n" to disk while refreshExternal still holds the pre-save dirty snapshot (saved = "# Version 1\n").
            model.saveManual(noteId = mdId)
            awaitCondition { !model.state.value.tabs.single { it.id == mdId }.dirty }
            assertEquals("# Version 2\n", mdFile.readText(Charsets.UTF_8))

            model.refreshExternalPreIoObserver = null
            mdPreIoRelease.complete(Unit)
            awaitJob(model.refreshJob!!)

            assertFalse("Concurrent successful Markdown save must not receive a stale conflict", mdId in model.state.value.conflictedTabIds)
            assertEquals("# Version 2\n", model.state.value.tabs.single { it.id == mdId }.saved)

            // 2. Concurrent portable .smd save completing during an in-flight dirty scan does not produce a stale conflict or leak directories.
            val smdFile = File(tempDir, "Concurrent.smd")
            smdFile.outputStream().use { model.media.writeFmd(it, "# Portable v1\n\n![Fig](assets/fig.svg)\n", svgAssets("assets/fig.svg", svgA)) }
            awaitJob(model.open(Uri.fromFile(smdFile)))
            val smdId = model.state.value.active.id
            val smdInitialDir = model.state.value.active.assetDirectory!!
            model.edit(smdId, "# Portable v2\n\n![Fig](assets/fig.svg)\n")
            assertTrue(model.state.value.active.dirty)

            val smdPreIoEntered = CompletableDeferred<Unit>()
            val smdPreIoRelease = CompletableDeferred<Unit>()
            model.refreshExternalPreIoObserver = {
                smdPreIoEntered.complete(Unit)
                smdPreIoRelease.await()
            }
            model.refreshExternal()
            awaitCondition { smdPreIoEntered.isCompleted }

            val portableSaveJob = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Main).launch {
                model.writePortable(
                    id = smdId,
                    content = "# Portable v2\n\n![Fig](assets/fig.svg)\n",
                    assets = svgAssets("assets/fig.svg", svgB),
                    save = true,
                    originalContent = "# Portable v2\n\n![Fig](assets/fig.svg)\n",
                )
            }
            awaitJob(portableSaveJob)
            val smdSavedDir = model.state.value.tabs.single { it.id == smdId }.assetDirectory!!
            assertNotEquals(smdInitialDir, smdSavedDir)
            assertFalse(model.state.value.tabs.single { it.id == smdId }.dirty)

            model.refreshExternalPreIoObserver = null
            smdPreIoRelease.complete(Unit)
            awaitJob(model.refreshJob!!)

            assertFalse("Concurrent successful portable save must not receive a stale conflict", smdId in model.state.value.conflictedTabIds)
            assertTrue(File(bundlesRoot, smdSavedDir).isDirectory)

            // 3. Save + immediate fresh local edit after IO gathered a dirty conflict still rejects the stale conflict because baseline changed.
            model.select(mdId)
            awaitCondition { model.state.value.activeId == mdId }
            model.edit(mdId, "# Version 3\n")
            mdFile.writeText("# External interim\n", Charsets.UTF_8)

            val saveThenEditIoEntered = CompletableDeferred<Unit>()
            val saveThenEditIoRelease = CompletableDeferred<Unit>()
            model.refreshExternalIoObserver = {
                saveThenEditIoEntered.complete(Unit)
                saveThenEditIoRelease.await()
            }
            model.refreshExternal()
            awaitCondition { saveThenEditIoEntered.isCompleted }

            awaitJob(model.save(noteId = mdId, forceOverwrite = true))
            model.edit(mdId, "# Version 4 unsaved\n")
            assertTrue(model.state.value.tabs.single { it.id == mdId }.dirty)
            assertEquals("# Version 3\n", model.state.value.tabs.single { it.id == mdId }.saved)

            model.refreshExternalIoObserver = null
            saveThenEditIoRelease.complete(Unit)
            awaitJob(model.refreshJob!!)

            assertFalse("Dirty tab on a newer post-save baseline must not receive stale pre-save conflict", mdId in model.state.value.conflictedTabIds)
            assertEquals("# Version 4 unsaved\n", model.state.value.tabs.single { it.id == mdId }.content)

            // 4. Changing target URI via Save As during the scan prevents a stale conflict from the old target.
            mdFile.writeText("# External edit on old target\n", Charsets.UTF_8)
            val rebindIoEntered = CompletableDeferred<Unit>()
            val rebindIoRelease = CompletableDeferred<Unit>()
            model.refreshExternalIoObserver = {
                rebindIoEntered.complete(Unit)
                rebindIoRelease.await()
            }
            model.refreshExternal()
            awaitCondition { rebindIoEntered.isCompleted }

            val copyFile = File(tempDir, "Concurrent-copy.md")
            awaitJob(model.save(uri = Uri.fromFile(copyFile), noteId = mdId))
            model.edit(mdId, "# Unsaved edit on new target\n")

            model.refreshExternalIoObserver = null
            rebindIoRelease.complete(Unit)
            awaitJob(model.refreshJob!!)

            assertFalse("Tab rebound via Save As must not inherit stale conflict from previous URI", mdId in model.state.value.conflictedTabIds)

            // 5. Closing a dirty tab during the scan prevents adding its closed ID to conflictedTabIds.
            copyFile.writeText("# External edit before close\n", Charsets.UTF_8)
            val closeIoEntered = CompletableDeferred<Unit>()
            val closeIoRelease = CompletableDeferred<Unit>()
            model.refreshExternalIoObserver = {
                closeIoEntered.complete(Unit)
                closeIoRelease.await()
            }
            model.refreshExternal()
            awaitCondition { closeIoEntered.isCompleted }

            model.close(mdId, discardChanges = true)
            awaitCondition { model.state.value.tabs.none { it.id == mdId } }

            model.refreshExternalIoObserver = null
            closeIoRelease.complete(Unit)
            awaitJob(model.refreshJob!!)

            assertFalse("Closed tab must not be added to conflictedTabIds", mdId in model.state.value.conflictedTabIds)

            // 6. Closing a portable tab keeps its extracted assetDirectory referenced for closed-tab reopen recovery.
            model.close(smdId)
            awaitCondition { model.state.value.closedTabs.any { it.id == smdId } }
            assertTrue(model.isPortableDirectoryReferenced(smdSavedDir))
            assertTrue(File(bundlesRoot, smdSavedDir).isDirectory)

            awaitCondition {
                bundlesRoot.listFiles()?.map { it.name }?.toSet().orEmpty() - setOf(smdInitialDir, smdSavedDir) == baselineDirs
            }
        } finally {
            model.refreshExternalPreIoObserver = null
            model.refreshExternalIoObserver = null
            model.refreshPostAdoptObserver = null
            val openDirs = model.state.value.tabs.mapNotNull { it.assetDirectory }
            val closedDirs = model.state.value.closedTabs.mapNotNull { it.assetDirectory }
            store.clear()
            (openDirs + closedDirs).forEach { File(bundlesRoot, it).deleteRecursively() }
            bundlesRoot.listFiles()?.forEach { dir ->
                if (dir.name !in baselineDirs) dir.deleteRecursively()
            }
            File(app.filesDir, "workspaces/$workspaceKey.json").deleteRecursively()
            File(app.filesDir, "workspaces/$workspaceKey").deleteRecursively()
            tempDir.deleteRecursively()
        }
    }

    private inline fun withPortableModel(block: (app: android.app.Application, tempDir: File, model: StudioViewModel) -> Unit) {
        val app = RuntimeEnvironment.getApplication()
        val bundlesRoot = File(app.filesDir, "portable-assets")
        val baselineDirs = bundlesRoot.listFiles()?.map { it.name }?.toSet().orEmpty()
        val tempDir = Files.createTempDirectory("android-smd-safety").toFile()
        val workspaceKey = "test-${UUID.randomUUID()}"
        val store = androidx.lifecycle.ViewModelStore()
        val factory = object : androidx.lifecycle.ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : androidx.lifecycle.ViewModel> create(modelClass: Class<T>): T =
                StudioViewModel(app, workspaceKey).apply {
                    reading(autosave = false)
                    readerFlushRequester = { true }
                } as T
        }
        val model = androidx.lifecycle.ViewModelProvider(store, factory)[StudioViewModel::class.java]
        try {
            block(app, tempDir, model)
        } finally {
            model.portablePostWriteObserver = null
            val openDirs = model.state.value.tabs.mapNotNull { it.assetDirectory }
            store.clear()
            openDirs.forEach { File(bundlesRoot, it).deleteRecursively() }
            bundlesRoot.listFiles()?.forEach { dir ->
                if (dir.name !in baselineDirs) dir.deleteRecursively()
            }
            File(app.filesDir, "workspaces/$workspaceKey.json").deleteRecursively()
            File(app.filesDir, "workspaces/$workspaceKey").deleteRecursively()
            tempDir.deleteRecursively()
        }
    }

    @Test fun uppercaseExpectedRevisionAcceptedInAgentAssetActionAndReplacePortableAsset() = withPortableModel { app, tempDir, model ->
        val importFile = File(app.filesDir, "attachments/import-${UUID.randomUUID()}.svg")
        try {
            val markdown = "# Case-insensitive Revision\n\n![Fig](assets/fig.svg)\n"
            val smdFile = File(tempDir, "UpperRev.smd")
            smdFile.outputStream().use { model.media.writeFmd(it, markdown, svgAssets("assets/fig.svg", svgA)) }
            awaitJob(model.open(Uri.fromFile(smdFile)))
            val noteId = model.state.value.active.id
            val upperRev = agentContentRevision(markdown).uppercase()

            val listResult = runSuspend {
                model.agentAssetAction(
                    JSONObject().put("tabId", noteId).put("assetAction", "list").put("expectedRevision", upperRev),
                )
            }
            assertEquals(1, listResult.getInt("total"))

            val sourceResult = runSuspend {
                model.agentAssetAction(
                    JSONObject().put("tabId", noteId).put("assetAction", "source")
                        .put("assetName", "assets/fig.svg").put("expectedRevision", upperRev),
                )
            }
            assertEquals("image/svg+xml", sourceResult.getString("mimeType"))

            val attachResult = runSuspend {
                model.agentAssetAction(
                    JSONObject().put("tabId", noteId).put("assetAction", "attach")
                        .put("assetName", "extra.svg").put("mimeType", "image/svg+xml")
                        .put("body", Base64.encodeToString(svgB, Base64.NO_WRAP)).put("expectedRevision", upperRev),
                )
            }
            assertTrue(attachResult.getBoolean("saved"))

            importFile.parentFile?.mkdirs()
            importFile.writeBytes(svgB)
            val replaceResult = runSuspend {
                model.replacePortableAsset(noteId, "assets/fig.svg", "assets/${importFile.name}", upperRev)
            }
            assertTrue(replaceResult.getBoolean("saved"))
            assertTrue(replaceResult.getBoolean("changed"))
        } finally {
            importFile.delete()
        }
    }

    @Test fun agentAssetActionAttachRollbackRestoresOurWriteAndPreservesConcurrentExternalBytes() = withPortableModel { app, tempDir, model ->
        val markdown = "# Attach Rollback\n\n![Fig](assets/fig.svg)\n"
        val smdFile = File(tempDir, "Rollback.smd")
        smdFile.outputStream().use { model.media.writeFmd(it, markdown, svgAssets("assets/fig.svg", svgA)) }
        val backupBytes = smdFile.readBytes()

        awaitJob(model.open(Uri.fromFile(smdFile)))
        val noteId = model.state.value.active.id

        // 1. RESTORE_OUR_WRITE: draft changes after staged write while disk still matches stagedBytes -> restores backupBytes.
        val restoreEntered = CompletableDeferred<Unit>()
        val restoreRelease = CompletableDeferred<Unit>()
        model.portablePostWriteObserver = {
            restoreEntered.complete(Unit)
            restoreRelease.await()
        }
        var restoreFailure: Throwable? = null
        val restoreAttempt = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Default).launch {
            restoreFailure = runCatching {
                model.agentAssetAction(
                    JSONObject().put("tabId", noteId).put("assetAction", "attach")
                        .put("assetName", "attached-one.svg").put("mimeType", "image/svg+xml")
                        .put("body", Base64.encodeToString(svgB, Base64.NO_WRAP))
                        .put("expectedRevision", agentContentRevision(markdown)),
                )
            }.exceptionOrNull()
        }
        awaitCondition { restoreEntered.isCompleted }
        assertFalse("Staged bytes should be on disk before rollback", smdFile.readBytes().contentEquals(backupBytes))
        model.edit(noteId, "# Local draft edited mid-attach\n")
        model.portablePostWriteObserver = null
        restoreRelease.complete(Unit)
        awaitJob(restoreAttempt)
        assertTrue("Expected failure on mid-attach edit, got $restoreFailure", restoreFailure is IllegalArgumentException || restoreFailure is IllegalStateException)
        assertTrue("Unexpected message: ${restoreFailure?.message}", restoreFailure?.message.orEmpty().contains("document changed while the image was being attached"))
        assertArrayEquals("Rollback must restore original backup when disk still matches stagedBytes", backupBytes, smdFile.readBytes())

        // Reset tab back to clean baseline so we can exercise LEAVE_CONCURRENT_BYTES.
        model.reloadFromDisk(noteId)
        awaitCondition { !model.state.value.active.dirty && model.state.value.active.content == markdown }

        // 2. LEAVE_CONCURRENT_BYTES: external writer updates .smd after staged write and before rollback -> concurrent bytes preserved.
        val concurrentBytes = java.io.ByteArrayOutputStream().also { out ->
            MediaStorage(app).writeFmd(out, "# External concurrent update\n", svgAssets("assets/fig.svg", svgB))
        }.toByteArray()
        val concurrentEntered = CompletableDeferred<Unit>()
        val concurrentRelease = CompletableDeferred<Unit>()
        model.portablePostWriteObserver = {
            concurrentEntered.complete(Unit)
            concurrentRelease.await()
        }
        var concurrentFailure: Throwable? = null
        val concurrentAttempt = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Default).launch {
            concurrentFailure = runCatching {
                model.agentAssetAction(
                    JSONObject().put("tabId", noteId).put("assetAction", "attach")
                        .put("assetName", "attached-two.svg").put("mimeType", "image/svg+xml")
                        .put("body", Base64.encodeToString(svgB, Base64.NO_WRAP))
                        .put("expectedRevision", agentContentRevision(markdown)),
                )
            }.exceptionOrNull()
        }
        awaitCondition { concurrentEntered.isCompleted }
        smdFile.writeBytes(concurrentBytes)
        model.edit(noteId, "# Local draft edited during concurrent write\n")
        model.portablePostWriteObserver = null
        concurrentRelease.complete(Unit)
        awaitJob(concurrentAttempt)

        assertTrue("Expected IllegalStateException when concurrent bytes prevent rollback, got $concurrentFailure", concurrentFailure is IllegalStateException)
        assertTrue(concurrentFailure?.message.orEmpty().contains("destination was not overwritten during recovery"))
        val causeChainMessages = generateSequence(concurrentFailure) { it.cause }.mapNotNull { it.message }.toList()
        assertTrue("Expected cause chain to mention leaving concurrent bytes intact, got $causeChainMessages", causeChainMessages.any { it.contains("left intact to avoid overwriting newer bytes") })
        assertArrayEquals("Concurrent external .smd bytes must remain untouched during rollback", concurrentBytes, smdFile.readBytes())
    }

    private fun <T> runSuspend(timeoutMs: Long = 5_000, block: suspend () -> T): T {
        var result: Result<T>? = null
        val job = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Default).launch {
            result = runCatching { block() }
        }
        awaitJob(job, timeoutMs)
        return result!!.getOrThrow()
    }
}
