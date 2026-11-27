package dev.supermd.studio

import android.app.Application
import android.net.Uri
import android.os.Looper
import android.util.Base64
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import java.time.Duration
import java.util.UUID
import javax.imageio.ImageIO
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ReloadDraftArchiveTest {
    private fun makePngDataUrl(rgb: Int): String {
        val image = BufferedImage(2, 2, BufferedImage.TYPE_INT_ARGB).apply {
            setRGB(0, 0, rgb)
            setRGB(1, 1, rgb)
        }
        val bytes = ByteArrayOutputStream().also { ImageIO.write(image, "png", it) }.toByteArray()
        return "data:image/png;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
    }

    private val pngDraft = makePngDataUrl(0xFF1E88E5.toInt())
    private val pngDisk = makePngDataUrl(0xFFD81B60.toInt())
    private val pngPrior = makePngDataUrl(0xFF43A047.toInt())
    private val pngExtra = makePngDataUrl(0xFFFB8C00.toInt())
    private val pngConcurrent = makePngDataUrl(0xFF8E24AA.toInt())

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

    private fun createViewModel(app: Application, key: String): Pair<androidx.lifecycle.ViewModelStore, StudioViewModel> {
        val store = androidx.lifecycle.ViewModelStore()
        val factory = object : androidx.lifecycle.ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : androidx.lifecycle.ViewModel> create(modelClass: Class<T>): T =
                StudioViewModel(app, workspaceKey = key) as T
        }
        val model = androidx.lifecycle.ViewModelProvider(store, factory)[StudioViewModel::class.java]
        model.reading(autosave = false)
        return store to model
    }

    private fun withWorkspace(block: (Application, File, String, StudioViewModel) -> Unit) {
        val app = RuntimeEnvironment.getApplication()
        val temp = Files.createTempDirectory("reload-archive-test").toFile()
        val key = "test-${UUID.randomUUID()}"
        val (store, model) = createViewModel(app, key)
        try {
            block(app, temp, key, model)
        } finally {
            store.clear()
            File(app.filesDir, "workspaces/$key.json").deleteRecursively()
            File(app.filesDir, "workspaces/$key").deleteRecursively()
            temp.deleteRecursively()
        }
    }

    @Test
    fun reloadFromDiskArchivesDirtyMarkdownAndPortableDraftWithAssetsAndSurvivesRestart() = withWorkspace { app, temp, key, model ->
        // 1. Dirty Markdown draft is archived before Reload from disk and can be reopened alongside the reloaded tab.
        val mdFile = File(temp, "Draft.md").apply { writeText("# Disk v1\n", Charsets.UTF_8) }
        model.open(Uri.fromFile(mdFile))
        waitUntil { model.state.value.active.uri == Uri.fromFile(mdFile).toString() }
        val mdId = model.state.value.active.id

        model.edit(mdId, "# Unsaved local prose\n\nKeep me safe.\n")
        mdFile.writeText("# Disk v2\n", Charsets.UTF_8)
        model.refreshExternal()
        waitUntil { model.state.value.activeConflicted }

        val mdReloadJob = model.reloadFromDisk(mdId)
        waitUntil { mdReloadJob.isCompleted && !model.state.value.activeConflicted && !model.state.value.active.dirty && model.state.value.active.content == "# Disk v2\n" }
        assertEquals(1, model.state.value.closedTabs.size)
        assertEquals("Recovered Draft.md", model.state.value.closedTabs.first().name)

        val tabsBeforeReopen = model.state.value.tabs.size
        model.reopen()
        waitUntil { model.state.value.tabs.size == tabsBeforeReopen + 1 && model.state.value.active.name == "Recovered Draft.md" }
        val reopenedMd = model.state.value.active
        assertNotEquals(mdId, reopenedMd.id)
        assertEquals(null, reopenedMd.uri)
        assertEquals("# Unsaved local prose\n\nKeep me safe.\n", reopenedMd.content)
        assertTrue(reopenedMd.dirty)
        assertEquals("# Disk v2\n", mdFile.readText(Charsets.UTF_8))

        // Clean reload does not append duplicate closed-tab snapshots.
        model.select(mdId)
        waitUntil { model.state.value.active.id == mdId }
        val closedBeforeClean = model.state.value.closedTabs
        mdFile.writeText("# Disk v3\n", Charsets.UTF_8)
        val cleanReloadJob = model.reloadFromDisk(mdId)
        waitUntil { cleanReloadJob.isCompleted && model.state.value.active.content == "# Disk v3\n" }
        assertEquals(closedBeforeClean, model.state.value.closedTabs)

        // 2. Dirty portable .smd draft preserves both markdown and portable-assets across Reload from disk AND restart.
        val smdFile = File(temp, "Notebook.smd")
        smdFile.outputStream().use { out ->
            model.media.writeFmd(out, "# Portable v1\n\n![plot](assets/plot.png)\n", JSONObject().put("assets/plot.png", pngDraft))
        }
        model.open(Uri.fromFile(smdFile))
        waitUntil { model.state.value.active.uri == Uri.fromFile(smdFile).toString() }
        val smdId = model.state.value.active.id
        val draftAssetDir = model.state.value.active.assetDirectory
        assertNotNull(draftAssetDir)

        model.edit(smdId, "# Portable local draft\n\n![plot](assets/plot.png)\n")
        model.markAssetsDirty(smdId)
        smdFile.outputStream().use { out ->
            model.media.writeFmd(out, "# Portable disk v2\n\n![plot](assets/plot.png)\n", JSONObject().put("assets/plot.png", pngDisk))
        }
        model.refreshExternal()
        waitUntil { model.state.value.activeConflicted }

        val smdReloadJob = model.reloadFromDisk(smdId)
        waitUntil {
            smdReloadJob.isCompleted &&
                !model.state.value.activeConflicted &&
                !model.state.value.active.dirty &&
                model.state.value.active.content.startsWith("# Portable disk v2")
        }
        val reloadedAssetDir = model.state.value.active.assetDirectory
        val archivedAssetDir = model.state.value.closedTabs.firstOrNull()?.assetDirectory
        assertNotNull(reloadedAssetDir)
        assertNotNull(archivedAssetDir)
        assertNotEquals(draftAssetDir, reloadedAssetDir)
        assertNotEquals(draftAssetDir, archivedAssetDir)
        assertNotEquals(archivedAssetDir, reloadedAssetDir)
        assertEquals(pngDisk, model.media.portableAssets(reloadedAssetDir).getString("assets/plot.png"))
        // Archived closed-note snapshot owns a dedicated copied portable-assets directory, while the superseded open-tab directory is cleaned up.
        assertFalse(File(app.filesDir, "portable-assets/$draftAssetDir").exists())
        assertTrue(File(app.filesDir, "portable-assets/$archivedAssetDir").isDirectory)
        assertEquals(pngDraft, model.media.portableAssets(archivedAssetDir).getString("assets/plot.png"))

        runBlocking { model.flushRecoveryAndAwait() }

        // Simulate app restart on the same workspace key and verify reopen restores draft + portable assets.
        val (restartedStore, restartedModel) = createViewModel(app, key)
        try {
            assertEquals("Recovered Notebook.smd", restartedModel.state.value.closedTabs.firstOrNull()?.name)
            restartedModel.reopen()
            waitUntil { restartedModel.state.value.active.name == "Recovered Notebook.smd" }
            val recoveredPortable = restartedModel.state.value.active
            assertEquals("# Portable local draft\n\n![plot](assets/plot.png)\n", recoveredPortable.content)
            assertTrue(recoveredPortable.portable)
            assertTrue(recoveredPortable.dirty)
            assertEquals(pngDraft, restartedModel.media.portableAssets(recoveredPortable.assetDirectory).getString("assets/plot.png"))
        } finally {
            restartedStore.clear()
            File(app.filesDir, "portable-assets/$draftAssetDir").deleteRecursively()
            File(app.filesDir, "portable-assets/$archivedAssetDir").deleteRecursively()
            File(app.filesDir, "portable-assets/$reloadedAssetDir").deleteRecursively()
        }
    }

    @Test
    fun failedArchiveOrFailedReloadKeepsDirtyDraftAndPortableAssetsRecoverable() = withWorkspace { app, temp, key, model ->
        val smdFile = File(temp, "Critical.smd")
        smdFile.outputStream().use { out ->
            model.media.writeFmd(out, "# Initial\n\n![plot](assets/plot.png)\n", JSONObject().put("assets/plot.png", pngDraft))
        }
        model.open(Uri.fromFile(smdFile))
        waitUntil { model.state.value.active.uri == Uri.fromFile(smdFile).toString() }
        val smdId = model.state.value.active.id
        val draftAssetDir = model.state.value.active.assetDirectory
        assertNotNull(draftAssetDir)

        model.edit(smdId, "# Unsaved critical draft\n\n![plot](assets/plot.png)\n")
        smdFile.outputStream().use { out ->
            model.media.writeFmd(out, "# External update\n\n![plot](assets/plot.png)\n", JSONObject().put("assets/plot.png", pngDisk))
        }
        model.refreshExternal()
        waitUntil { model.state.value.activeConflicted }

        // 1. Block ClosedNoteStore directory with a regular file so archiving fails.
        val closedDir = File(app.filesDir, "workspaces/$key/closed-notes")
        closedDir.deleteRecursively()
        closedDir.parentFile!!.mkdirs()
        closedDir.writeText("blocked-by-file", Charsets.UTF_8)

        val failedArchiveJob = model.reloadFromDisk(smdId)
        waitUntil { failedArchiveJob.isCompleted && model.state.value.error?.contains("Could not archive draft before reloading") == true }
        assertEquals("# Unsaved critical draft\n\n![plot](assets/plot.png)\n", model.state.value.active.content)
        assertEquals(draftAssetDir, model.state.value.active.assetDirectory)
        assertTrue(model.state.value.activeConflicted)
        assertTrue(File(app.filesDir, "portable-assets/$draftAssetDir").isDirectory)
        assertEquals(pngDraft, model.media.portableAssets(draftAssetDir).getString("assets/plot.png"))

        // Verify workspace.json durable recovery snapshot immediately retains the dirty draft + assets across restart.
        val (crashStore, crashModel) = createViewModel(app, key)
        try {
            val recoveredTab = crashModel.state.value.tabs.first { it.id == smdId }
            assertEquals("# Unsaved critical draft\n\n![plot](assets/plot.png)\n", recoveredTab.content)
            assertEquals(pngDraft, crashModel.media.portableAssets(recoveredTab.assetDirectory).getString("assets/plot.png"))
        } finally {
            crashStore.clear()
        }

        // Restore closed-notes directory, then delete disk file so reload itself fails.
        closedDir.delete()
        model.dismissError()
        assertTrue(smdFile.delete())

        val failedReloadJob = model.reloadFromDisk(smdId)
        waitUntil { failedReloadJob.isCompleted && (model.state.value.error?.contains("Could not reload note") == true || model.documentWriteNeedsAccess(smdId)) }
        assertEquals("# Unsaved critical draft\n\n![plot](assets/plot.png)\n", model.state.value.active.content)
        assertEquals(draftAssetDir, model.state.value.active.assetDirectory)
        assertEquals(pngDraft, model.media.portableAssets(draftAssetDir).getString("assets/plot.png"))
        File(app.filesDir, "portable-assets/$draftAssetDir").deleteRecursively()
    }

    @Test
    fun cancellationImmediatelyAfterIndexPublicationKeepsArchiveAndPortableAssetsConsistent() = withWorkspace { app, temp, key, model ->
        val bundlesRoot = File(app.filesDir, "portable-assets")
        val closedStore = ClosedNoteStore(File(app.filesDir, "workspaces/$key/closed-notes"))
        val createdDirs = mutableSetOf<String>()
        val importedFiles = mutableListOf<File>()
        try {
            // Seed an existing retained portable closed-note entry so recovery already holds portable assets.
            val priorFile = File(temp, "PriorEntry.smd")
            priorFile.outputStream().use { out ->
                model.media.writeFmd(out, "# Prior disk\n\n![prior](assets/prior.png)\n", JSONObject().put("assets/prior.png", pngPrior))
            }
            model.open(Uri.fromFile(priorFile))
            waitUntil { model.state.value.active.uri == Uri.fromFile(priorFile).toString() }
            val priorId = model.state.value.active.id
            val priorAssetDir = model.state.value.active.assetDirectory!!
            createdDirs += priorAssetDir
            model.edit(priorId, "# Prior retained draft\n\n![prior](assets/prior.png)\n")
            var closeDone = false
            model.close(priorId, discardChanges = true) { closeDone = true }
            waitUntil { closeDone && model.state.value.closedTabs.any { it.id == priorId } }

            // Open target portable note and make it dirty with both bundle and newly imported portable assets.
            val smdFile = File(temp, "CancelTarget.smd")
            smdFile.outputStream().use { out ->
                model.media.writeFmd(out, "# Disk v1\n\n![plot](assets/plot.png)\n", JSONObject().put("assets/plot.png", pngDraft))
            }
            model.open(Uri.fromFile(smdFile))
            waitUntil { model.state.value.active.uri == Uri.fromFile(smdFile).toString() }
            val smdId = model.state.value.active.id
            val draftAssetDir = model.state.value.active.assetDirectory!!
            createdDirs += draftAssetDir

            val importedSource = model.media.importJson(
                org.json.JSONArray().put(JSONObject().put("name", "extra.png").put("data", pngExtra))
            ).getJSONObject(0).getString("source")
            model.media.local(importedSource, draftAssetDir)?.let(importedFiles::add)
            val expectedDraftContent = "# Unsaved portable draft\n\n![plot](assets/plot.png)\n![extra]($importedSource)\n"
            model.edit(smdId, expectedDraftContent)
            model.markAssetsDirty(smdId)

            smdFile.outputStream().use { out ->
                model.media.writeFmd(out, "# Disk v2\n\n![plot](assets/plot.png)\n", JSONObject().put("assets/plot.png", pngDisk))
            }
            model.refreshExternal()
            waitUntil { model.state.value.activeConflicted }

            val baselineDirs = bundlesRoot.list()?.toSet().orEmpty()

            // 1. Cancellation immediately after index publication on Dispatchers.IO (when index rollback succeeds):
            //    on-disk index rolls back to [priorId], copied archive dir + reloaded dir are cleaned up, and
            //    both active draft and retained PriorEntry.smd remain recoverable with their portable assets.
            var publishedDirDuringCancel1: String? = null
            lateinit var cancelJob1: kotlinx.coroutines.Job
            model.reloadAfterIndexCommitObserver = {
                val diskIndex = closedStore.loadIndexStrict()
                val inMemRefs = model.currentClosedNoteReferencesForTest()
                assertEquals(diskIndex, inMemRefs)
                val published = diskIndex.first()
                publishedDirDuringCancel1 = published.assetDirectory
                assertNotNull(publishedDirDuringCancel1)
                assertTrue(model.isPortableDirectoryReferenced(publishedDirDuringCancel1!!))
                cancelJob1.cancel(kotlinx.coroutines.CancellationException("Cancel right after index commit"))
                currentCoroutineContext().ensureActive()
            }
            cancelJob1 = model.reloadFromDisk(smdId)
            waitUntil { cancelJob1.isCompleted }
            model.reloadAfterIndexCommitObserver = null

            assertNotNull(publishedDirDuringCancel1)
            assertFalse(File(bundlesRoot, publishedDirDuringCancel1!!).exists())
            assertEquals(baselineDirs, bundlesRoot.list()?.toSet().orEmpty())
            assertEquals(listOf(priorId), closedStore.loadIndexStrict().map { it.id })
            assertEquals(listOf(priorId), model.currentClosedNoteReferencesForTest().map { it.id })
            assertEquals(listOf(priorId), model.state.value.closedTabs.map { it.id })
            assertEquals(expectedDraftContent, model.state.value.active.content)
            assertEquals(draftAssetDir, model.state.value.active.assetDirectory)
            assertEquals(pngDraft, model.media.portableAssets(draftAssetDir).getString("assets/plot.png"))
            assertNotNull(model.media.local(importedSource, draftAssetDir))

            // 2. Cancellation immediately after index publication when rollback index write ALSO fails:
            //    on-disk index cannot roll back, so in-memory closedNoteRefs + closedTabs stay synchronized with
            //    on-disk index, and cleanup MUST preserve the copied archive directory while cleaning the unused reload dir.
            var publishedRefDuringCancel2: ClosedNoteReference? = null
            lateinit var cancelJob2: kotlinx.coroutines.Job
            model.reloadAfterIndexCommitObserver = {
                val diskIndex = closedStore.loadIndexStrict()
                publishedRefDuringCancel2 = diskIndex.first()
                createdDirs += publishedRefDuringCancel2!!.assetDirectory!!
                model.closedNoteIndexSaveInterceptor = {
                    throw java.io.IOException("Simulated index rollback failure on cancellation")
                }
                cancelJob2.cancel(kotlinx.coroutines.CancellationException("Cancel with rollback failure"))
                currentCoroutineContext().ensureActive()
            }
            cancelJob2 = model.reloadFromDisk(smdId)
            waitUntil { cancelJob2.isCompleted }
            model.reloadAfterIndexCommitObserver = null
            model.closedNoteIndexSaveInterceptor = null

            val retainedArchivedRef = publishedRefDuringCancel2!!
            val retainedArchivedDir = retainedArchivedRef.assetDirectory!!
            assertEquals(listOf(retainedArchivedRef.id, priorId), closedStore.loadIndexStrict().map { it.id })
            assertEquals(listOf(retainedArchivedRef.id, priorId), model.currentClosedNoteReferencesForTest().map { it.id })
            assertEquals(listOf(retainedArchivedRef.id, priorId), model.state.value.closedTabs.map { it.id })
            assertTrue(File(bundlesRoot, retainedArchivedDir).isDirectory)
            // Only the retained copied archive directory was added beyond baselineDirs (the unused disk reload dir was cleaned up).
            assertEquals(baselineDirs + retainedArchivedDir, bundlesRoot.list()?.toSet().orEmpty())
            assertEquals(pngDraft, model.media.portableAssets(retainedArchivedDir).getString("assets/plot.png"))
            assertEquals(pngExtra, model.media.portableAssets(retainedArchivedDir).getString(importedSource))

            // Verify across restart that the active draft AND every retained recovery entry reopen with portable assets.
            val (restartStore, restartModel) = createViewModel(app, key)
            try {
                val activeAfterRestart = restartModel.state.value.tabs.first { it.id == smdId }
                assertEquals(expectedDraftContent, activeAfterRestart.content)
                assertEquals(pngDraft, restartModel.media.portableAssets(activeAfterRestart.assetDirectory).getString("assets/plot.png"))
                assertNotNull(restartModel.media.local(importedSource, activeAfterRestart.assetDirectory))

                assertEquals(listOf(retainedArchivedRef.id, priorId), restartModel.state.value.closedTabs.map { it.id })

                // Reopen retained entry #1 (the archived CancelTarget.smd snapshot).
                restartModel.reopen()
                waitUntil { restartModel.state.value.active.id == retainedArchivedRef.id }
                val reopenedArchived = restartModel.state.value.active
                assertEquals(expectedDraftContent, reopenedArchived.content)
                assertEquals(pngDraft, restartModel.media.portableAssets(reopenedArchived.assetDirectory).getString("assets/plot.png"))
                assertEquals(pngExtra, restartModel.media.portableAssets(reopenedArchived.assetDirectory).getString(importedSource))

                // Reopen retained entry #2 (PriorEntry.smd).
                restartModel.reopen()
                waitUntil { restartModel.state.value.active.id == priorId }
                val reopenedPrior = restartModel.state.value.active
                assertEquals("# Prior retained draft\n\n![prior](assets/prior.png)\n", reopenedPrior.content)
                assertEquals(pngPrior, restartModel.media.portableAssets(reopenedPrior.assetDirectory).getString("assets/prior.png"))

                // Also verify closing and reopening the active draft itself preserves its portable assets.
                var activeClosed = false
                restartModel.close(smdId, discardChanges = true) { activeClosed = true }
                waitUntil { activeClosed && restartModel.state.value.closedTabs.firstOrNull()?.id == smdId }
                restartModel.reopen()
                waitUntil { restartModel.state.value.active.id == smdId }
                val reopenedActive = restartModel.state.value.active
                assertEquals(expectedDraftContent, reopenedActive.content)
                assertEquals(pngDraft, restartModel.media.portableAssets(reopenedActive.assetDirectory).getString("assets/plot.png"))
                assertNotNull(restartModel.media.local(importedSource, reopenedActive.assetDirectory))
            } finally {
                restartStore.clear()
            }

            // Also verify live in-session reopen on the original ViewModel for every retained recovery entry.
            model.reopen()
            waitUntil { model.state.value.active.id == retainedArchivedRef.id }
            assertEquals(expectedDraftContent, model.state.value.active.content)
            assertEquals(pngDraft, model.media.portableAssets(model.state.value.active.assetDirectory).getString("assets/plot.png"))
            assertEquals(pngExtra, model.media.portableAssets(model.state.value.active.assetDirectory).getString(importedSource))

            model.reopen()
            waitUntil { model.state.value.active.id == priorId }
            assertEquals("# Prior retained draft\n\n![prior](assets/prior.png)\n", model.state.value.active.content)
            assertEquals(pngPrior, model.media.portableAssets(model.state.value.active.assetDirectory).getString("assets/prior.png"))
        } finally {
            model.reloadAfterIndexCommitObserver = null
            model.closedNoteIndexSaveInterceptor = null
            createdDirs.forEach { File(bundlesRoot, it).deleteRecursively() }
            importedFiles.forEach { it.delete() }
        }
    }

    @Test
    fun concurrentEditWithRollbackWriteFailureKeepsArchiveIndexAndPortableAssetsRecoverable() = withWorkspace { app, temp, key, model ->
        val bundlesRoot = File(app.filesDir, "portable-assets")
        val closedStore = ClosedNoteStore(File(app.filesDir, "workspaces/$key/closed-notes"))
        val createdDirs = mutableSetOf<String>()
        val importedFiles = mutableListOf<File>()
        try {
            // Seed two prior retained portable closed notes.
            fun seedClosedPortable(name: String, assetKey: String, png: String): String {
                val file = File(temp, name)
                file.outputStream().use { out ->
                    model.media.writeFmd(out, "# $name disk\n\n![img]($assetKey)\n", JSONObject().put(assetKey, png))
                }
                model.open(Uri.fromFile(file))
                waitUntil { model.state.value.active.uri == Uri.fromFile(file).toString() }
                val id = model.state.value.active.id
                createdDirs += model.state.value.active.assetDirectory!!
                model.edit(id, "# $name retained\n\n![img]($assetKey)\n")
                var closed = false
                model.close(id, discardChanges = true) { closed = true }
                waitUntil { closed && model.state.value.closedTabs.any { it.id == id } }
                return id
            }
            val retainedId1 = seedClosedPortable("RetainedOne.smd", "assets/one.png", pngPrior)
            val retainedId2 = seedClosedPortable("RetainedTwo.smd", "assets/two.png", pngExtra)

            // Open target portable note and make a dirty draft v1.
            val smdFile = File(temp, "Concurrent.smd")
            smdFile.outputStream().use { out ->
                model.media.writeFmd(out, "# Disk v1\n\n![plot](assets/plot.png)\n", JSONObject().put("assets/plot.png", pngDraft))
            }
            model.open(Uri.fromFile(smdFile))
            waitUntil { model.state.value.active.uri == Uri.fromFile(smdFile).toString() }
            val smdId = model.state.value.active.id
            val draftAssetDir = model.state.value.active.assetDirectory!!
            createdDirs += draftAssetDir

            val draftV1 = "# Draft v1 before concurrent edit\n\n![plot](assets/plot.png)\n"
            model.edit(smdId, draftV1)

            smdFile.outputStream().use { out ->
                model.media.writeFmd(out, "# Disk v2\n\n![plot](assets/plot.png)\n", JSONObject().put("assets/plot.png", pngDisk))
            }
            model.refreshExternal()
            waitUntil { model.state.value.activeConflicted }

            val concurrentSource = model.media.importJson(
                org.json.JSONArray().put(JSONObject().put("name", "concurrent.png").put("data", pngConcurrent))
            ).getJSONObject(0).getString("source")
            model.media.local(concurrentSource, draftAssetDir)?.let(importedFiles::add)
            val draftV2 = "# Draft v2 concurrent edit\n\n![plot](assets/plot.png)\n![concurrent]($concurrentSource)\n"

            val baselineDirs = bundlesRoot.list()?.toSet().orEmpty()
            var publishedRef: ClosedNoteReference? = null

            model.reloadAfterIndexCommitObserver = {
                publishedRef = closedStore.loadIndexStrict().first()
                createdDirs += publishedRef!!.assetDirectory!!
                kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main) {
                    model.edit(smdId, draftV2)
                    model.markAssetsDirty(smdId)
                }
                model.closedNoteIndexSaveInterceptor = {
                    throw java.io.IOException("Simulated rollback write failure after concurrent edit")
                }
            }

            val reloadJob = model.reloadFromDisk(smdId)
            waitUntil { reloadJob.isCompleted }
            model.reloadAfterIndexCommitObserver = null
            model.closedNoteIndexSaveInterceptor = null

            val archivedRef = publishedRef!!
            val archivedDir = archivedRef.assetDirectory!!

            // Active draft kept the latest concurrent edit + portable assets without being overwritten by disk.
            assertEquals(draftV2, model.state.value.active.content)
            assertEquals(draftAssetDir, model.state.value.active.assetDirectory)
            assertTrue(model.state.value.message?.contains("changed while reloading from disk") == true)
            assertEquals(pngDraft, model.media.portableAssets(draftAssetDir).getString("assets/plot.png"))
            assertNotNull(model.media.local(concurrentSource, draftAssetDir))

            // Failed rollback left archivedRef in index.bin, so in-memory closedNoteRefs + closedTabs stay consistent
            // and cleanup preserved archivedDir while deleting only the unused reloaded bundle directory.
            val expectedClosedIds = listOf(archivedRef.id, retainedId2, retainedId1)
            assertEquals(expectedClosedIds, closedStore.loadIndexStrict().map { it.id })
            assertEquals(expectedClosedIds, model.currentClosedNoteReferencesForTest().map { it.id })
            assertEquals(expectedClosedIds, model.state.value.closedTabs.map { it.id })
            assertTrue(File(bundlesRoot, archivedDir).isDirectory)
            assertEquals(baselineDirs + archivedDir, bundlesRoot.list()?.toSet().orEmpty())
            assertEquals(pngDraft, model.media.portableAssets(archivedDir).getString("assets/plot.png"))

            // Verify in-session reopen AND post-restart reopen for the active draft and every retained recovery entry.
            val (restartStore, restartModel) = createViewModel(app, key)
            try {
                assertEquals(expectedClosedIds, restartModel.state.value.closedTabs.map { it.id })
                val activeRestored = restartModel.state.value.tabs.first { it.id == smdId }
                assertEquals(draftV2, activeRestored.content)
                assertEquals(pngDraft, restartModel.media.portableAssets(activeRestored.assetDirectory).getString("assets/plot.png"))
                assertNotNull(restartModel.media.local(concurrentSource, activeRestored.assetDirectory))

                // Reopen all 3 retained recovery entries and verify each restores its markdown and portable assets.
                restartModel.reopen()
                waitUntil { restartModel.state.value.active.id == archivedRef.id }
                assertEquals(draftV1, restartModel.state.value.active.content)
                assertEquals(pngDraft, restartModel.media.portableAssets(restartModel.state.value.active.assetDirectory).getString("assets/plot.png"))

                restartModel.reopen()
                waitUntil { restartModel.state.value.active.id == retainedId2 }
                assertEquals("# RetainedTwo.smd retained\n\n![img](assets/two.png)\n", restartModel.state.value.active.content)
                assertEquals(pngExtra, restartModel.media.portableAssets(restartModel.state.value.active.assetDirectory).getString("assets/two.png"))

                restartModel.reopen()
                waitUntil { restartModel.state.value.active.id == retainedId1 }
                assertEquals("# RetainedOne.smd retained\n\n![img](assets/one.png)\n", restartModel.state.value.active.content)
                assertEquals(pngPrior, restartModel.media.portableAssets(restartModel.state.value.active.assetDirectory).getString("assets/one.png"))
                assertTrue(restartModel.state.value.closedTabs.isEmpty())

                // Close and reopen the active draft itself to confirm it also reopens cleanly with all portable assets.
                var activeClosed = false
                restartModel.close(smdId, discardChanges = true) { activeClosed = true }
                waitUntil { activeClosed && restartModel.state.value.closedTabs.single().id == smdId }
                restartModel.reopen()
                waitUntil { restartModel.state.value.active.id == smdId }
                assertEquals(draftV2, restartModel.state.value.active.content)
                assertEquals(pngDraft, restartModel.media.portableAssets(restartModel.state.value.active.assetDirectory).getString("assets/plot.png"))
                assertNotNull(restartModel.media.local(concurrentSource, restartModel.state.value.active.assetDirectory))
            } finally {
                restartStore.clear()
            }

            // Also verify live in-session reopen on the original ViewModel for all 3 retained recovery entries.
            model.reopen()
            waitUntil { model.state.value.active.id == archivedRef.id }
            assertEquals(draftV1, model.state.value.active.content)
            assertEquals(pngDraft, model.media.portableAssets(model.state.value.active.assetDirectory).getString("assets/plot.png"))

            model.reopen()
            waitUntil { model.state.value.active.id == retainedId2 }
            assertEquals("# RetainedTwo.smd retained\n\n![img](assets/two.png)\n", model.state.value.active.content)
            assertEquals(pngExtra, model.media.portableAssets(model.state.value.active.assetDirectory).getString("assets/two.png"))

            model.reopen()
            waitUntil { model.state.value.active.id == retainedId1 }
            assertEquals("# RetainedOne.smd retained\n\n![img](assets/one.png)\n", model.state.value.active.content)
            assertEquals(pngPrior, model.media.portableAssets(model.state.value.active.assetDirectory).getString("assets/one.png"))
        } finally {
            model.reloadAfterIndexCommitObserver = null
            model.closedNoteIndexSaveInterceptor = null
            createdDirs.forEach { File(bundlesRoot, it).deleteRecursively() }
            importedFiles.forEach { it.delete() }
        }
    }
}
