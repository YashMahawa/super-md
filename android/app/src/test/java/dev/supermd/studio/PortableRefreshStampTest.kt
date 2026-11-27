package dev.supermd.studio

import android.app.Application
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
import android.util.Base64
import androidx.test.core.app.ApplicationProvider
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileNotFoundException
import java.nio.file.Files
import java.nio.file.attribute.FileTime
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.random.Random
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.launch
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowContentResolver

private class StampedRefreshDocumentProvider : ContentProvider() {
    data class Entry(
        val file: File,
        val mimeType: String,
        val lastModified: Long?,
        val reportedSizeOverride: Long? = null,
    )

    companion object {
        const val AUTHORITY = "dev.supermd.studio.test.stampedrefresh"
        lateinit var appContext: Application
        lateinit var storageDir: File
        val entries = ConcurrentHashMap<String, Entry>()
        val queryCalls = AtomicInteger(0)
        val openReadCalls = AtomicInteger(0)
        val openWriteCalls = AtomicInteger(0)
        val enforceAuthorityGrants = AtomicBoolean(false)
        @Volatile var onTruncateWrite: ((Uri, File) -> Unit)? = null

        fun reset(app: Application, rootDir: File) {
            appContext = app
            storageDir = File(rootDir, "provider").apply { mkdirs() }
            entries.clear()
            queryCalls.set(0)
            openReadCalls.set(0)
            openWriteCalls.set(0)
            enforceAuthorityGrants.set(false)
            onTruncateWrite = null
        }

        fun uriFor(docId: String): Uri = DocumentsContract.buildDocumentUri(AUTHORITY, docId)

        private fun grantDefaultReadWriteIfNeeded(uri: Uri) {
            if (!enforceAuthorityGrants.get()) {
                appContext.grantUriPermission(
                    appContext.packageName,
                    uri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
                )
            }
        }

        fun putText(docId: String, text: String, lastModified: Long?, reportedSize: Long? = null) {
            putBytes(docId, text.toByteArray(Charsets.UTF_8), "text/markdown", lastModified, reportedSize)
        }

        fun putBytes(docId: String, bytes: ByteArray, mimeType: String, lastModified: Long?, reportedSize: Long? = null) {
            val file = entries[docId]?.file ?: File(storageDir, docId.replace('/', '_')).apply { parentFile?.mkdirs() }
            file.writeBytes(bytes)
            entries[docId] = Entry(file, mimeType, lastModified, reportedSize)
            grantDefaultReadWriteIfNeeded(uriFor(docId))
        }
    }

    override fun onCreate(): Boolean = true

    private fun checkGrant(uri: Uri, write: Boolean) {
        if (!enforceAuthorityGrants.get()) return
        val flag = if (write) Intent.FLAG_GRANT_WRITE_URI_PERMISSION else Intent.FLAG_GRANT_READ_URI_PERMISSION
        if (TestAuthorityGrants.check(uri, flag) != true) {
            throw SecurityException("Permission denied for $uri (write=$write)")
        }
    }

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor {
        queryCalls.incrementAndGet()
        checkGrant(uri, write = false)
        val documentId = DocumentsContract.getDocumentId(uri)
        val entry = entries[documentId] ?: throw FileNotFoundException(documentId)
        val cols = projection ?: arrayOf(
            Document.COLUMN_DOCUMENT_ID,
            Document.COLUMN_DISPLAY_NAME,
            Document.COLUMN_MIME_TYPE,
            OpenableColumns.SIZE,
            Document.COLUMN_LAST_MODIFIED,
            Document.COLUMN_FLAGS,
        )
        return MatrixCursor(cols).apply {
            addRow(
                cols.map { col ->
                    when (col) {
                        Document.COLUMN_DOCUMENT_ID -> documentId
                        Document.COLUMN_DISPLAY_NAME, OpenableColumns.DISPLAY_NAME -> documentId.substringAfterLast('/')
                        Document.COLUMN_MIME_TYPE -> entry.mimeType
                        OpenableColumns.SIZE, Document.COLUMN_SIZE -> entry.reportedSizeOverride ?: entry.file.length()
                        Document.COLUMN_LAST_MODIFIED -> entry.lastModified
                        Document.COLUMN_FLAGS -> Document.FLAG_SUPPORTS_WRITE
                        else -> null
                    }
                }.toTypedArray<Any?>(),
            )
        }
    }

    override fun getType(uri: Uri): String {
        val docId = runCatching { DocumentsContract.getDocumentId(uri) }.getOrNull()
        return entries[docId]?.mimeType ?: if (docId?.endsWith(".smd") == true) "application/vnd.supermd.smd" else "text/markdown"
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        val writes = mode.contains('w')
        checkGrant(uri, write = writes)
        val documentId = DocumentsContract.getDocumentId(uri)
        val entry = entries[documentId] ?: throw FileNotFoundException(documentId)
        if (!writes) {
            openReadCalls.incrementAndGet()
            return ParcelFileDescriptor.open(entry.file, ParcelFileDescriptor.MODE_READ_ONLY)
        }
        openWriteCalls.incrementAndGet()
        val flags = when (mode) {
            "rw" -> ParcelFileDescriptor.MODE_READ_WRITE
            "wt", "w" -> ParcelFileDescriptor.MODE_WRITE_ONLY or ParcelFileDescriptor.MODE_CREATE or ParcelFileDescriptor.MODE_TRUNCATE
            else -> ParcelFileDescriptor.parseMode(mode)
        }
        return ParcelFileDescriptor.open(entry.file, flags).also {
            entries[documentId] = entry.copy(
                lastModified = entry.lastModified?.let { prev -> prev + 1_000L },
                reportedSizeOverride = null,
            )
            if (mode.contains('t') || mode == "w") {
                onTruncateWrite?.invoke(uri, entry.file)
            }
        }
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PortableRefreshStampTest {
    private lateinit var app: Application
    private lateinit var tempDir: File
    private val models = mutableListOf<StudioViewModel>()
    private val createdWorkspaces = mutableListOf<String>()

    @Before
    fun setUp() {
        app = ApplicationProvider.getApplicationContext()
        tempDir = Files.createTempDirectory("supermd-portable-refresh-stamp-").toFile()
        TestAuthorityGrants.clear()
        StampedRefreshDocumentProvider.reset(app, tempDir)
        val provider = StampedRefreshDocumentProvider().apply {
            attachInfo(app, ProviderInfo().apply { authority = StampedRefreshDocumentProvider.AUTHORITY; exported = true; grantUriPermissions = true })
        }
        ShadowContentResolver.registerProviderInternal(StampedRefreshDocumentProvider.AUTHORITY, provider)
        app.getSharedPreferences("studio", Context.MODE_PRIVATE).edit().clear().commit()
        File(app.filesDir, "workspace.json").delete()
        File(app.filesDir, "portable-assets").deleteRecursively()
        File(app.filesDir, "attachments").deleteRecursively()
    }

    @After
    fun tearDown() {
        models.forEach { vm -> runCatching { vm.clearForTest() } }
        models.clear()
        drainAll()
        TestAuthorityGrants.clear()
        StampedRefreshDocumentProvider.reset(app, tempDir)
        ShadowContentResolver.reset()
        createdWorkspaces.forEach { key ->
            File(app.filesDir, "workspaces/$key.json").delete()
            File(app.filesDir, "workspaces/$key").deleteRecursively()
            app.getSharedPreferences("studio-window-$key", Context.MODE_PRIVATE).edit().clear().commit()
        }
        File(app.filesDir, "portable-assets").deleteRecursively()
        File(app.filesDir, "attachments").deleteRecursively()
        tempDir.deleteRecursively()
    }

    private fun StudioViewModel.clearForTest() {
        StudioViewModel::class.java.getDeclaredMethod("onCleared").apply { isAccessible = true }.invoke(this)
    }

    private fun newModel(workspaceKey: String = "stamp-${System.nanoTime()}", autosave: Boolean = false): StudioViewModel {
        createdWorkspaces += workspaceKey
        app.getSharedPreferences("studio", Context.MODE_PRIVATE).edit()
            .putBoolean("welcomed", true)
            .putBoolean("autosave", autosave)
            .putString("startup", "restore")
            .commit()
        return StudioViewModel(app, workspaceKey).also { vm ->
            vm.readerFlushRequester = { true }
            vm.requestPortableWrite = { save ->
                val active = vm.state.value.active
                val assets = vm.media.portableAssets(active.assetDirectory)
                vm.viewModelScope.launch {
                    vm.writePortable(active.id, active.content, assets, save = save, originalContent = active.content)
                }
                true
            }
            models += vm
        }
    }

    private fun drainAll(rounds: Int = 10, pauseMs: Long = 15L) {
        repeat(rounds) {
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(pauseMs)
            shadowOf(Looper.getMainLooper()).idle()
        }
    }

    private fun waitUntil(timeoutMs: Long = 5_000L, condition: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
        while (System.nanoTime() < deadline) {
            shadowOf(Looper.getMainLooper()).idle()
            if (condition()) return
            Thread.sleep(15L)
        }
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue("Timed out waiting for condition", condition())
    }

    private fun pngBytes(seed: Int, payloadSize: Int = 512): ByteArray {
        val header = Base64.decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
            Base64.DEFAULT,
        )
        return header + ByteArray(payloadSize).also { Random(seed).nextBytes(it) }
    }

    private fun buildPortableArchive(markdown: String, assets: Map<String, ByteArray>): ByteArray {
        val media = MediaStorage(app)
        val jsonAssets = JSONObject()
        assets.forEach { (key, bytes) ->
            jsonAssets.put(key, "data:image/png;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP))
        }
        return ByteArrayOutputStream().also { out -> media.writeFmd(out, markdown, jsonAssets) }.toByteArray()
    }

    @Test
    fun unchangedCleanPortableRefreshCreatesZeroExtractedFilesRetainsLiveCachesAndPromotesStamp() {
        var nowMs = 1_760_000_000_000L
        val docId = "deck.smd"
        val uri = StampedRefreshDocumentProvider.uriFor(docId)
        val noteAssets = (1..12).associate { idx -> "assets/slide-$idx.png" to pngBytes(idx, 1024) }
        val markdown = "# Slides\n\n" + noteAssets.keys.joinToString("\n") { "![]($it)" }
        StampedRefreshDocumentProvider.putBytes(docId, buildPortableArchive(markdown, noteAssets), "application/vnd.supermd.smd", lastModified = nowMs)

        val model = newModel()
        val capabilities = ReaderAssetCapabilities().also(model::attachReaderCapabilities)
        // Open inside the coarse timestamp guard window so initial open cannot record a verified stamp yet;
        // the first refresh must exercise the read-only portable fallback.
        nowMs += 500L
        model.refreshClockMs = { nowMs }
        model.open(uri)
        waitUntil { model.state.value.active.uri == uri.toString() && model.state.value.active.portable }
        val tab = model.state.value.active
        assertNull("Coarse timestamp inside guard window must not be marked verified yet", model.refreshStamps.get(tab.id))

        // Fill MediaStorage.localFileCache to capacity (244 attachments + 12 note assets = 256 == MAX_CACHED_LOCAL_ASSETS).
        // Under old openFmd refresh, extracting 12 temporary assets evicted the 12 eldest live entries!
        val attachmentsDir = File(app.filesDir, "attachments").apply { mkdirs() }
        val fillerFiles = (1..244).map { idx ->
            File(attachmentsDir, "import-live-$idx.png").apply { writeBytes(pngBytes(10_000 + idx, 384)) }.also { model.media.data(it) }
        }
        val (_, readerSource) = model.resolveReaderAsset(tab.id, "assets/slide-1.png")
        val capability = capabilities.register(tab.id, "assets/slide-1.png", readerSource.mime, readerSource.fingerprint, readerSource.target)
        assertNotNull(capability)

        val diskReads = AtomicInteger(0)
        model.media.localFileBytesReader = { file -> diskReads.incrementAndGet(); file.readBytes() }
        val portableRoot = File(app.filesDir, "portable-assets")
        val dirsBefore = portableRoot.list()?.toSet().orEmpty()
        model.media.portableAssetExtractions.set(0)
        model.media.portableBase64Decodes.set(0)
        StampedRefreshDocumentProvider.openReadCalls.set(0)

        // Advance past the 2.5s coarse guard window: first refresh runs Tier 2 read-only fallback and promotes stamp.
        nowMs += 3_000L
        model.refreshExternal(immediate = true)
        waitUntil { !model.isRefreshExternalActive() }

        assertEquals("Read-only fallback must read the stream once", 1, StampedRefreshDocumentProvider.openReadCalls.get())
        assertEquals("Unchanged portable refresh must extract zero files", 0, model.media.portableAssetExtractions.get())
        assertEquals("Shallow baseline copy must preserve validatedAssetMeta identity (zero Base64 decodes)", 0, model.media.portableBase64Decodes.get())
        assertEquals("No temporary portable-assets directory may be created", dirsBefore, portableRoot.list()?.toSet().orEmpty())
        assertNotNull("Stamp must be promoted after clean verification past guard window", model.refreshStamps.get(tab.id))

        // Verify zero live localFileCache entries were evicted and live ReaderAssetCapabilities still resolve.
        fillerFiles.forEach { file -> model.media.data(file) }
        noteAssets.keys.forEach { key -> model.media.data(model.media.local(key, tab.assetDirectory)!!) }
        assertEquals("All 256 live localFileCache entries must remain warm without disk re-reads", 0, diskReads.get())
        val resolvedCap = capabilities.lookup(capability!!.token) { id -> model.matchesReaderAssetNote(id) }
        assertNotNull(resolvedCap)
        model.openReaderAsset(resolvedCap!!).stream.use { stream ->
            assertArrayEquals(noteAssets.getValue("assets/slide-1.png"), stream.readBytes())
        }

        // Subsequent passive refresh (`onResume`) and tab switch (`select`) hit the verified per-tab stamp with zero stream opens.
        StampedRefreshDocumentProvider.openReadCalls.set(0)
        model.refreshExternal(immediate = true)
        waitUntil { !model.isRefreshExternalActive() }
        assertEquals("Verified stamp must skip stream open on passive refresh", 0, StampedRefreshDocumentProvider.openReadCalls.get())

        model.newNote(titleHint = "Scratch", content = "# Scratch")
        waitUntil { model.state.value.active.id != tab.id }
        StampedRefreshDocumentProvider.openReadCalls.set(0)
        model.select(tab.id)
        waitUntil { model.state.value.active.id == tab.id && !model.isRefreshExternalActive() }
        assertEquals("Tab switch onto clean stamped portable note must skip stream open", 0, StampedRefreshDocumentProvider.openReadCalls.get())
        assertEquals(0, model.media.portableAssetExtractions.get())
    }

    @Test
    fun targetedProviderChangeEventsBypassVerifiedStampAndCoalesceWithTabSwitch() {
        val baseTime = 1_760_010_000_000L
        val nowMs = baseTime + 5_000L
        val smdUri = StampedRefreshDocumentProvider.uriFor("report.smd")
        val mdUri = StampedRefreshDocumentProvider.uriFor("notes.md")
        val initialSmd = buildPortableArchive("# Report A", mapOf("assets/chart.png" to pngBytes(1, 256)))
        StampedRefreshDocumentProvider.putBytes("report.smd", initialSmd, "application/vnd.supermd.smd", lastModified = baseTime)
        StampedRefreshDocumentProvider.putText("notes.md", "# Notes A!", lastModified = baseTime)

        val model = newModel()
        model.refreshClockMs = { nowMs }
        model.open(smdUri)
        waitUntil { model.state.value.tabs.any { it.uri == smdUri.toString() } }
        model.open(mdUri)
        waitUntil { model.state.value.active.uri == mdUri.toString() }
        val smdTabId = model.state.value.tabs.first { it.uri == smdUri.toString() }.id
        val mdTabId = model.state.value.tabs.first { it.uri == mdUri.toString() }.id
        assertNotNull(model.refreshStamps.get(smdTabId))
        assertNotNull(model.refreshStamps.get(mdTabId))

        // Mutate provider bytes WITHOUT updating lastModified or reportedSize, simulating a provider that only notifies.
        val updatedSmd = buildPortableArchive("# Report B", mapOf("assets/chart.png" to pngBytes(2, 256)))
        StampedRefreshDocumentProvider.putBytes("report.smd", updatedSmd, "application/vnd.supermd.smd", lastModified = baseTime, reportedSize = initialSmd.size.toLong())
        StampedRefreshDocumentProvider.putText("notes.md", "# Notes B!", lastModified = baseTime)

        // Direct targeted refreshExternal(mdUri) must bypass mdTab's stamp.
        model.refreshExternal(mdUri, immediate = true)
        waitUntil { model.state.value.tabs.first { it.id == mdTabId }.content == "# Notes B!" }

        // ContentObserver notification for smdUri followed immediately (before 200ms debounce) by tab select(smdTabId)
        // must preserve forceVerifyRefreshUris and adopt the updated portable archive.
        app.contentResolver.notifyChange(smdUri, null)
        shadowOf(Looper.getMainLooper()).idle()
        model.select(smdTabId)
        waitUntil { model.state.value.active.id == smdTabId && model.state.value.active.content == "# Report B" }
        val updatedAssetFile = model.media.local("assets/chart.png", model.state.value.active.assetDirectory)
        assertNotNull(updatedAssetFile)
        assertArrayEquals(pngBytes(2, 256), updatedAssetFile!!.readBytes())
    }

    @Test
    fun unknownAndEpochSecondMetadataNeverCacheStampsAndDetectSameLengthEdits() {
        var nowMs = 1_760_020_000_000L
        val nullMetaMd = StampedRefreshDocumentProvider.uriFor("unknown-mod.md")
        val epochSecSmd = StampedRefreshDocumentProvider.uriFor("seconds-mod.smd")
        StampedRefreshDocumentProvider.putText("unknown-mod.md", "Alpha 1234", lastModified = null)
        StampedRefreshDocumentProvider.putBytes(
            "seconds-mod.smd",
            buildPortableArchive("Slide 0001", mapOf("assets/p.png" to pngBytes(7, 256))),
            "application/vnd.supermd.smd",
            lastModified = 1_760_020_000L, // Buggy Unix epoch seconds (~1.76e9) instead of ms
        )

        val model = newModel()
        model.refreshClockMs = { nowMs }
        model.open(nullMetaMd)
        waitUntil { model.state.value.tabs.any { it.uri == nullMetaMd.toString() } }
        model.open(epochSecSmd)
        waitUntil { model.state.value.active.uri == epochSecSmd.toString() }
        val mdId = model.state.value.tabs.first { it.uri == nullMetaMd.toString() }.id
        val smdId = model.state.value.tabs.first { it.uri == epochSecSmd.toString() }.id

        nowMs += 60_000L
        model.media.portableAssetExtractions.set(0)
        model.refreshExternal(immediate = true)
        waitUntil { !model.isRefreshExternalActive() }
        assertNull("Null lastModified must never cache a verified stamp", model.refreshStamps.get(mdId))
        assertNull("Epoch-second lastModified must never cache a verified stamp", model.refreshStamps.get(smdId))
        assertEquals("Unchanged portable fallback on unknown metadata must extract zero files", 0, model.media.portableAssetExtractions.get())

        // Same-length external edits without notifyChange: passive refresh must detect both!
        StampedRefreshDocumentProvider.putText("unknown-mod.md", "Bravo 5678", lastModified = null)
        StampedRefreshDocumentProvider.putBytes(
            "seconds-mod.smd",
            buildPortableArchive("Slide 0002", mapOf("assets/p.png" to pngBytes(7, 256))),
            "application/vnd.supermd.smd",
            lastModified = 1_760_020_000L,
        )
        model.refreshExternal(immediate = true)
        waitUntil {
            model.state.value.tabs.first { it.id == mdId }.content == "Bravo 5678" &&
                model.state.value.tabs.first { it.id == smdId }.content == "Slide 0002"
        }
    }

    @Test
    fun coarseAndSubSecondGuardWindowsCatchSameLengthExternalEditsBeforeStampPromotion() {
        val coarseMod = 1_760_030_000_000L
        var nowMs = coarseMod + 900L
        val safMdUri = StampedRefreshDocumentProvider.uriFor("coarse.md")
        StampedRefreshDocumentProvider.putText("coarse.md", "Tick-One!!", lastModified = coarseMod)

        val localFile = File(tempDir, "fine-tick.md").apply { writeText("Fine-One!!", Charsets.UTF_8) }
        val fineTime = FileTime.from(1_760_030_000_123_456_000L, TimeUnit.NANOSECONDS)
        Files.setLastModifiedTime(localFile.toPath(), fineTime)
        val localUri = Uri.fromFile(localFile)

        val model = newModel()
        model.refreshClockMs = { nowMs }
        model.open(safMdUri)
        waitUntil { model.state.value.tabs.any { it.uri == safMdUri.toString() } }
        val safId = model.state.value.tabs.first { it.uri == safMdUri.toString() }.id
        assertNull("Whole-second stamp within 2.5s guard window must not be trusted yet", model.refreshStamps.get(safId))

        nowMs = fineTime.toMillis() + 10L
        model.open(localUri)
        waitUntil { model.state.value.tabs.any { it.uri == localUri.toString() } }
        val localId = model.state.value.tabs.first { it.uri == localUri.toString() }.id
        assertNull("Sub-second stamp within 50ms kernel-tick guard window must not be trusted yet", model.refreshStamps.get(localId))

        // Same-length external edits preserving the EXACT same timestamps within the guard windows!
        StampedRefreshDocumentProvider.putText("coarse.md", "Tick-Two!!", lastModified = coarseMod)
        localFile.writeText("Fine-Two!!", Charsets.UTF_8)
        Files.setLastModifiedTime(localFile.toPath(), fineTime)

        nowMs = coarseMod + 1_200L
        model.refreshExternal(immediate = true)
        waitUntil {
            model.state.value.tabs.first { it.id == safId }.content == "Tick-Two!!" &&
                model.state.value.tabs.first { it.id == localId }.content == "Fine-Two!!"
        }

        nowMs = coarseMod + 3_000L
        model.refreshExternal(immediate = true)
        waitUntil { !model.isRefreshExternalActive() }
        assertNotNull(model.refreshStamps.get(safId))
        assertNotNull(model.refreshStamps.get(localId))
    }

    @Test
    fun dirtyPortableAndMarkdownConflictsPauseAutosaveAndInAppSaveInvalidatesStamp() {
        val t0 = 1_760_040_000_000L
        val nowMs = t0 + 5_000L
        val smdUri = StampedRefreshDocumentProvider.uriFor("dirty.smd")
        val mdUri = StampedRefreshDocumentProvider.uriFor("dirty.md")
        StampedRefreshDocumentProvider.putBytes("dirty.smd", buildPortableArchive("Base SMD 1", mapOf("assets/a.png" to pngBytes(11, 256))), "application/vnd.supermd.smd", lastModified = t0)
        StampedRefreshDocumentProvider.putText("dirty.md", "Base MD 01", lastModified = t0)

        val model = newModel(autosave = false)
        model.refreshClockMs = { nowMs }
        model.open(smdUri)
        waitUntil { model.state.value.tabs.any { it.uri == smdUri.toString() } }
        model.open(mdUri)
        waitUntil { model.state.value.active.uri == mdUri.toString() }
        val smdId = model.state.value.tabs.first { it.uri == smdUri.toString() }.id
        val mdId = model.state.value.tabs.first { it.uri == mdUri.toString() }.id

        model.edit(mdId, "Save MD 02")
        model.saveManual(noteId = mdId)
        waitUntil { !model.state.value.tabs.first { it.id == mdId }.dirty }
        assertNull("In-app save must invalidate cached stamp", model.refreshStamps.get(mdId))

        model.edit(smdId, "Local draft SMD")
        model.edit(mdId, "Local draft MD")

        // Unchanged passive refresh on dirty smdId uses its verified baseline stamp (zero stream opens, no false conflict).
        StampedRefreshDocumentProvider.openReadCalls.set(0)
        model.refreshExternal(smdUri, immediate = true, forceVerifyTarget = false)
        waitUntil { !model.isRefreshExternalActive() }
        assertEquals(0, StampedRefreshDocumentProvider.openReadCalls.get())
        assertTrue(model.state.value.conflictedTabIds.isEmpty())

        StampedRefreshDocumentProvider.putBytes("dirty.smd", buildPortableArchive("Disk SMD 2", mapOf("assets/a.png" to pngBytes(11, 256))), "application/vnd.supermd.smd", lastModified = t0 + 6_000L)
        StampedRefreshDocumentProvider.putText("dirty.md", "Disk MD 99", lastModified = t0 + 6_000L)

        model.refreshExternal(immediate = true)
        waitUntil { smdId in model.state.value.conflictedTabIds && mdId in model.state.value.conflictedTabIds }
        assertEquals("Local draft SMD", model.state.value.tabs.first { it.id == smdId }.content)
        assertEquals("Local draft MD", model.state.value.tabs.first { it.id == mdId }.content)
        assertNull(model.refreshStamps.get(smdId))
        assertNull(model.refreshStamps.get(mdId))
    }

    @Test
    fun concurrentTruncatingWritesSerializeCleanlyAgainstImmediateRefresh() {
        val t0 = 1_760_050_000_000L
        val nowMs = t0 + 5_000L
        val mdUri = StampedRefreshDocumentProvider.uriFor("race.md")
        val smdUri = StampedRefreshDocumentProvider.uriFor("race.smd")
        StampedRefreshDocumentProvider.putText("race.md", "Initial MD", lastModified = t0)
        StampedRefreshDocumentProvider.putBytes("race.smd", buildPortableArchive("Initial SMD", mapOf("assets/img.png" to pngBytes(21, 256))), "application/vnd.supermd.smd", lastModified = t0)

        val model = newModel(autosave = false)
        model.refreshClockMs = { nowMs }
        model.open(mdUri)
        waitUntil { model.state.value.active.uri == mdUri.toString() }
        val mdId = model.state.value.active.id

        model.edit(mdId, "Updated Markdown After Truncate")
        val mdRefreshPreIo = CountDownLatch(1)
        val mdTruncated = AtomicBoolean(false)
        model.refreshExternalPreIoObserver = { mdRefreshPreIo.countDown() }
        StampedRefreshDocumentProvider.onTruncateWrite = { uri, file ->
            if (uri == mdUri && mdTruncated.compareAndSet(false, true)) {
                assertEquals("Backing file is 0 bytes mid-truncation", 0L, file.length())
                android.os.Handler(Looper.getMainLooper()).post { model.refreshExternal(uri, immediate = true) }
                assertTrue(mdRefreshPreIo.await(3, TimeUnit.SECONDS))
                Thread.sleep(35)
            }
        }
        model.saveManual(noteId = mdId)
        waitUntil { mdTruncated.get() && !model.state.value.busy && !model.isRefreshExternalActive() && model.state.value.tabs.first { it.id == mdId }.saved == "Updated Markdown After Truncate" }
        assertFalse("Concurrent refresh must never observe 0-byte truncation or flag false conflict", mdId in model.state.value.conflictedTabIds)
        assertEquals("Updated Markdown After Truncate", model.state.value.tabs.first { it.id == mdId }.content)

        StampedRefreshDocumentProvider.onTruncateWrite = null
        model.refreshExternalPreIoObserver = null
        model.open(smdUri)
        waitUntil { model.state.value.active.uri == smdUri.toString() }
        val smdId = model.state.value.active.id
        model.edit(smdId, "Updated Portable After Truncate")
        val smdRefreshPreIo = CountDownLatch(1)
        val smdTruncated = AtomicBoolean(false)
        model.refreshExternalPreIoObserver = { smdRefreshPreIo.countDown() }
        StampedRefreshDocumentProvider.onTruncateWrite = { uri, file ->
            if (uri == smdUri && smdTruncated.compareAndSet(false, true)) {
                assertEquals("Backing portable file is 0 bytes mid-truncation", 0L, file.length())
                android.os.Handler(Looper.getMainLooper()).post { model.refreshExternal(uri, immediate = true) }
                assertTrue(smdRefreshPreIo.await(3, TimeUnit.SECONDS))
                Thread.sleep(35)
            }
        }
        model.saveManual(noteId = smdId)
        waitUntil { smdTruncated.get() && !model.state.value.busy && !model.isRefreshExternalActive() && model.state.value.tabs.first { it.id == smdId }.saved == "Updated Portable After Truncate" }
        model.refreshExternalPreIoObserver = null
        StampedRefreshDocumentProvider.onTruncateWrite = null
        assertFalse(smdId in model.state.value.conflictedTabIds)
        assertEquals("Updated Portable After Truncate", model.state.value.tabs.first { it.id == smdId }.content)
    }

    @Test
    fun safPermissionDowngradeAndRevocationUpdateBlockedWritesEvenWhenVerifiedStampMatches() {
        val t0 = 1_760_060_000_000L
        val nowMs = t0 + 5_000L
        val uri = StampedRefreshDocumentProvider.uriFor("guarded.smd")
        StampedRefreshDocumentProvider.enforceAuthorityGrants.set(true)
        TestAuthorityGrants.registerAuthority(StampedRefreshDocumentProvider.AUTHORITY)
        val rw = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        TestAuthorityGrants.grant(uri, rw, persistable = true)
        StampedRefreshDocumentProvider.putBytes("guarded.smd", buildPortableArchive("# Guarded", mapOf("assets/g.png" to pngBytes(31, 256))), "application/vnd.supermd.smd", lastModified = t0)

        val model = newModel(autosave = false)
        model.refreshClockMs = { nowMs }
        model.open(uri)
        waitUntil { model.state.value.active.uri == uri.toString() }
        val tabId = model.state.value.active.id
        assertNotNull("Verified stamp must be recorded on initial open", model.refreshStamps.get(tabId))
        assertFalse(model.documentWriteNeedsAccess(tabId))

        // Downgrade grant to read-only while verified stamp still matches: #137 write-block seeding must still run!
        TestAuthorityGrants.releasePersistable(uri, Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        TestAuthorityGrants.revoke(uri, Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        StampedRefreshDocumentProvider.openReadCalls.set(0)
        model.media.portableAssetExtractions.set(0)
        model.refreshExternal(immediate = true)
        waitUntil { !model.isRefreshExternalActive() }
        assertTrue("Read-only grant downgrade must mark write blocked even when stamp matches", model.documentWriteNeedsAccess(tabId))
        assertEquals("Matching verified stamp must still skip reopening stream", 0, StampedRefreshDocumentProvider.openReadCalls.get())
        assertEquals(0, model.media.portableAssetExtractions.get())

        // Restore RW via re-open, verify unblocked, then revoke ALL grants: ungranted URI must not probe metadata or trust stale stamp.
        TestAuthorityGrants.grant(uri, rw, persistable = true)
        model.open(uri)
        waitUntil { !model.documentWriteNeedsAccess(tabId) }
        TestAuthorityGrants.releasePersistable(uri, rw)
        TestAuthorityGrants.revoke(uri, rw)
        StampedRefreshDocumentProvider.queryCalls.set(0)
        model.refreshExternal(immediate = true)
        waitUntil { !model.isRefreshExternalActive() }
        assertEquals("Revoked read grant must not issue single-document metadata queries", 0, StampedRefreshDocumentProvider.queryCalls.get())
        assertTrue("Full grant revocation must mark write blocked via stream SecurityException", model.documentWriteNeedsAccess(tabId))
        assertNull("Revoked read grant must invalidate stale verified stamp", model.refreshStamps.get(tabId))
    }

    @Test
    fun cancellingChangedPortableRefreshBeforeAdoptionCleansUpExtractedTempDirsAndRetriesCleanly() {
        val t0 = 1_760_070_000_000L
        var nowMs = t0 + 5_000L
        val uri = StampedRefreshDocumentProvider.uriFor("cancel-me.smd")
        StampedRefreshDocumentProvider.putBytes("cancel-me.smd", buildPortableArchive("# Version 1", mapOf("assets/c.png" to pngBytes(41, 256))), "application/vnd.supermd.smd", lastModified = t0)

        val model = newModel(autosave = false)
        model.refreshClockMs = { nowMs }
        model.open(uri)
        waitUntil { model.state.value.active.uri == uri.toString() }
        val tabId = model.state.value.active.id
        val initialDir = model.state.value.active.assetDirectory!!
        val portableRoot = File(app.filesDir, "portable-assets")
        assertNotNull(model.refreshStamps.get(tabId))

        val t1 = t0 + 6_000L
        nowMs = t1 + 5_000L
        StampedRefreshDocumentProvider.putBytes("cancel-me.smd", buildPortableArchive("# Version 2", mapOf("assets/c.png" to pngBytes(42, 256))), "application/vnd.supermd.smd", lastModified = t1)
        val cancelledOnce = AtomicBoolean(false)
        var cancelledJob: kotlinx.coroutines.Job? = null
        model.refreshExternalIoObserver = {
            if (cancelledOnce.compareAndSet(false, true)) {
                cancelledJob = model.refreshJob
                model.refreshJob?.cancel()
                kotlinx.coroutines.yield()
            }
        }
        model.refreshExternal(uri, immediate = true)
        waitUntil { cancelledOnce.get() && cancelledJob?.isCompleted == true }
        model.refreshExternalIoObserver = null

        assertEquals("# Version 1", model.state.value.active.content)
        assertEquals(initialDir, model.state.value.active.assetDirectory)
        assertEquals("Cancelled extraction must clean up unreferenced temp dir while keeping live dir", setOf(initialDir), portableRoot.list()?.toSet().orEmpty())
        assertNull("Invalidated stamp must not be prematurely re-recorded after cancelled refresh", model.refreshStamps.get(tabId))

        model.refreshExternal(immediate = true)
        waitUntil { model.state.value.active.content == "# Version 2" && !model.isRefreshExternalActive() }
        val adoptedDir = model.state.value.active.assetDirectory!!
        assertEquals(setOf(adoptedDir), portableRoot.list()?.toSet().orEmpty())
        assertNotNull("Retry after cancellation must promote verified stamp for adopted archive", model.refreshStamps.get(tabId))
    }
}
