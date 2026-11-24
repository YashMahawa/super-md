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
import android.os.Bundle
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import androidx.lifecycle.ViewModelStore
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FilterInputStream
import java.io.IOException
import java.nio.file.Files
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
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
class ReaderAssetCapabilitiesTest {
    private lateinit var app: Application
    private lateinit var tempDir: File
    private var previousAutosave: Boolean? = null
    private var previousRecent: String? = null
    private val workspaceKeys = mutableListOf<String>()
    private val viewModels = mutableListOf<ViewModelStore>()

    @Before fun setUp() {
        app = RuntimeEnvironment.getApplication()
        tempDir = Files.createTempDirectory("reader-asset-test").toFile()
        val prefs = app.getSharedPreferences("studio", Context.MODE_PRIVATE)
        previousAutosave = prefs.getBoolean("autosave", true)
        previousRecent = prefs.getString("recent", null)
        prefs.edit().putBoolean("autosave", false).commit()
    }

    @After fun tearDown() {
        viewModels.forEach { it.clear() }
        app.getSharedPreferences("studio", Context.MODE_PRIVATE).edit().apply {
            putBoolean("autosave", previousAutosave ?: true)
            if (previousRecent == null) remove("recent") else putString("recent", previousRecent)
        }.commit()
        ShadowContentResolver.reset()
        tempDir.deleteRecursively()
        workspaceKeys.forEach { File(app.filesDir, "workspaces/$it").deleteRecursively() }
    }

    @Test fun repeatedResolutionDeduplicatesWithoutPuttingSourceInToken() {
        val table = ReaderAssetCapabilities()
        val first = table.register("note-1", "images/photo.png", "image/png", "revision-a")!!
        val again = table.register("note-1", "images/photo.png", "image/png", "revision-a")

        assertEquals(first, again)
        assertTrue(first.token.matches(Regex("[a-f0-9]{32}")))
        assertFalse(first.token.contains("photo"))
        assertEquals(1, table.size())
    }

    @Test fun changedRevisionGetsNewCapabilityAndClosedNotesAreRejectedOnEveryLookup() {
        val table = ReaderAssetCapabilities()
        val old = table.register("note-1", "images/photo.png", "image/png", "revision-a")!!
        val changed = table.register("note-1", "images/photo.png", "image/png", "revision-b")!!

        assertNotEquals(old.token, changed.token)
        assertNotNull(table.lookup(old.token) { true })
        assertNull(table.lookup(old.token) { false })
        assertEquals(1, table.size()) // the closed note's capability is revoked, not just denied
        assertNull(table.lookup("../../outside") { true })
    }

    @Test fun capabilityTableKeepsLiveUrlsAndFallsBackForNewResolutionsAtItsBound() {
        val table = ReaderAssetCapabilities(capacity = 2)
        val first = table.register("n", "a.png", "image/png", "1")!!
        table.register("n", "b.png", "image/png", "1")
        assertEquals(first, table.register("n", "a.png", "image/png", "1"))
        assertNull(table.register("n", "c.png", "image/png", "1"))

        assertEquals(2, table.size())
        assertEquals(first, table.lookup(first.token) { true })

        val handler = ReaderAssetPathHandler(
            table,
            { _, _, fingerprint -> OpenReaderAsset("image/png", fingerprint, ByteArrayInputStream(byteArrayOf(7))) },
            { true },
        )
        val response = handler.handle(first.token)
        assertEquals(200, response.statusCode)
        assertEquals(7, response.data.read())
        response.data.close()
    }

    @Test fun metadataTimestampDerivesFingerprintWithoutOpeningStreamAndMissingTimestampHashesBytes() {
        val fromMetadata = readerAssetFingerprint("provider-uri", 3L, 100L) {
            error("timestamped asset must not stream bytes during revision fingerprinting")
        }
        assertEquals(readerAssetFingerprint("provider-uri", 3L, 100L), fromMetadata)
        assertNotEquals(fromMetadata, readerAssetFingerprint("provider-uri", 4L, 100L))
        assertNotEquals(fromMetadata, readerAssetFingerprint("provider-uri", 3L, 101L))
        assertNotEquals(fromMetadata, readerAssetFingerprint("other-uri", 3L, 100L))

        val untimestampedA = readerAssetFingerprint("provider-uri", 3L, 0L) { ByteArrayInputStream(byteArrayOf(1, 2, 3)) }
        val untimestampedB = readerAssetFingerprint("provider-uri", 3L, 0L) { ByteArrayInputStream(byteArrayOf(1, 2, 4)) }
        val negativeModifiedB = readerAssetFingerprint("provider-uri", 3L, -1L) { ByteArrayInputStream(byteArrayOf(1, 2, 4)) }
        val unknownSizeB = readerAssetFingerprint("provider-uri", -1L, 100L) { ByteArrayInputStream(byteArrayOf(1, 2, 4)) }
        assertNotEquals(untimestampedA, untimestampedB)
        assertEquals(untimestampedB, negativeModifiedB)
        assertEquals(untimestampedB, unknownSizeB)

        assertThrows(IllegalArgumentException::class.java) {
            readerAssetFingerprint("provider-uri", BoundedAssetInputStream.MAX_READER_ASSET_BYTES + 1L, 100L) {
                error("oversized metadata must fail before opening")
            }
        }
    }

    @Test fun streamLimitAllowsExactBoundaryAndClosesOnOverflow() {
        var closed = false
        val input = BoundedAssetInputStream(ByteArrayInputStream(byteArrayOf(1, 2, 3)), limit = 2) { closed = true }
        val buffer = ByteArray(8)

        assertEquals(2, input.read(buffer))
        try {
            input.read(buffer)
            throw AssertionError("expected overflow")
        } catch (_: IllegalArgumentException) {
            assertTrue(closed)
        }
    }

    @Test fun streamProviderFailureClosesTheUnderlyingStream() {
        var closed = false
        val provider = object : ByteArrayInputStream(byteArrayOf(1)) {
            override fun read(buffer: ByteArray, offset: Int, length: Int): Int = throw IOException("provider failed")
            override fun close() { closed = true; super.close() }
        }
        val bounded = BoundedAssetInputStream(provider)

        try {
            bounded.read(ByteArray(4))
            throw AssertionError("expected provider failure")
        } catch (_: IOException) {
            assertTrue(closed)
        }
    }

    @Test fun missingCapabilityUsesExplicitNonCacheable404() {
        val handler = ReaderAssetPathHandler(ReaderAssetCapabilities(), { _, _, _ -> error("must not open") }, { true })
        val response = handler.handle("unknown-token")

        assertEquals(404, response.statusCode)
        assertEquals("Not Found", response.reasonPhrase)
        assertEquals("no-store", response.responseHeaders["Cache-Control"])
        assertEquals("nosniff", response.responseHeaders["X-Content-Type-Options"])
        assertNotNull(response.data)
        assertEquals(-1, response.data.read())
    }

    @Test fun twentyFiveMegabyteTimestampedImagesInHundredFileFolderIndexOnceAndStream100MbTotal() {
        val env = createSharedFolderEnvironment(totalImagesInFolder = 100, imageBytes = 5_000_000)
        val model = newModel()
        val capabilities = ReaderAssetCapabilities().also(model::attachReaderCapabilities)
        val handler = ReaderAssetPathHandler(
            capabilities = capabilities,
            openCapability = model::openReaderAsset,
            noteIsOpen = { id -> model.matchesReaderAssetNote(id) },
        )
        val noteId = openNote(model, env.noteUri, relative = "Note.md")

        val resolvedCapabilities = (0 until 20).map { index ->
            val source = "images/img-%02d.png".format(index)
            val (resolvedNoteId, asset) = model.resolveReaderAsset(noteId, source)
            assertEquals(noteId, resolvedNoteId)
            assertEquals("image/png", asset.mime)
            requireNotNull(capabilities.register(resolvedNoteId, source, asset.mime, asset.fingerprint, asset.target))
        }

        // All 20 relative lookups in the 100-file shared folder reuse 1 directory query per folder level
        // and derive revisions from positive timestamps without opening any image stream.
        assertEquals(1, env.provider.childQueryCount("vault"))
        assertEquals(1, env.provider.childQueryCount("vault/images"))
        assertEquals(0, env.provider.imageOpenCount.get())

        val totalStreamedBytes = AtomicLong(0L)
        val buffer = ByteArray(64 * 1024)
        for (capability in resolvedCapabilities) {
            val response = handler.handle("${capability.token}?v=${capability.fingerprint}")
            assertEquals(200, response.statusCode)
            assertEquals("image/png", response.mimeType)
            assertEquals("no-store", response.responseHeaders["Cache-Control"])
            assertEquals("nosniff", response.responseHeaders["X-Content-Type-Options"])
            response.data.use { stream ->
                while (true) {
                    val count = stream.read(buffer)
                    if (count < 0) break
                    totalStreamedBytes.addAndGet(count.toLong())
                }
            }
        }

        // Opening the 20 retained targets performs zero additional folder walks, opens each image once,
        // and reads 20 * 5,000,000 = 100,000,000 bytes total.
        assertEquals(1, env.provider.childQueryCount("vault"))
        assertEquals(1, env.provider.childQueryCount("vault/images"))
        assertEquals(20, env.provider.imageOpenCount.get())
        assertEquals(100_000_000L, totalStreamedBytes.get())
    }

    @Test fun twentyConcurrentRasterStreamsQueueAcrossFourSlotsWithZero503sAndBoundedTimeoutReturns503() {
        val capabilities = ReaderAssetCapabilities()
        val payload = ByteArray(16_384) { (it and 0xff).toByte() }
        val activeStreams = AtomicInteger(0)
        val peakStreams = AtomicInteger(0)
        val tokens = (0 until 20).map { index ->
            capabilities.register("note-1", "images/img-$index.png", "image/png", "rev-$index")!!.token
        }

        val handler = ReaderAssetPathHandler(
            capabilities = capabilities,
            openCapability = { capability ->
                val concurrent = activeStreams.incrementAndGet()
                peakStreams.accumulateAndGet(concurrent, ::maxOf)
                val tracked = object : FilterInputStream(ByteArrayInputStream(payload)) {
                    private var released = false
                    override fun close() {
                        if (!released) {
                            released = true
                            activeStreams.decrementAndGet()
                        }
                        super.close()
                    }
                }
                OpenReaderAsset(capability.mime, capability.fingerprint, tracked)
            },
            noteIsOpen = { true },
            acquireTimeoutMillis = 5_000L,
        )

        val startGate = CountDownLatch(1)
        val executor = Executors.newFixedThreadPool(20)
        try {
            val futures = tokens.map { token ->
                executor.submit<Pair<Int, Int>> {
                    startGate.await(5, TimeUnit.SECONDS)
                    val response = handler.handle(token)
                    val status = response.statusCode
                    var bytes = 0
                    response.data.use { stream ->
                        Thread.sleep(15)
                        val buf = ByteArray(4096)
                        while (true) {
                            val read = stream.read(buf)
                            if (read < 0) break
                            bytes += read
                        }
                    }
                    status to bytes
                }
            }
            startGate.countDown()
            val results = futures.map { it.get(10, TimeUnit.SECONDS) }
            assertEquals(20, results.count { it.first == 200 })
            assertEquals(0, results.count { it.first == 503 })
            assertTrue(results.all { it.second == payload.size })
            assertTrue("expected queueing at the 4-stream ceiling, peak=${peakStreams.get()}", peakStreams.get() in 2..ReaderAssetPathHandler.MAX_CONCURRENT_STREAMS)
            assertEquals(0, activeStreams.get())
        } finally {
            executor.shutdownNow()
        }

        // Verify bounded timeout returns 503 when all 4 permits stay occupied past acquireTimeoutMillis.
        val shortTimeoutHandler = ReaderAssetPathHandler(
            capabilities = capabilities,
            openCapability = { capability ->
                OpenReaderAsset(capability.mime, capability.fingerprint, ByteArrayInputStream(byteArrayOf(42)))
            },
            noteIsOpen = { true },
            acquireTimeoutMillis = 50L,
        )
        val heldResponses = tokens.take(ReaderAssetPathHandler.MAX_CONCURRENT_STREAMS).map { shortTimeoutHandler.handle(it) }
        assertTrue(heldResponses.all { it.statusCode == 200 })

        val saturated = shortTimeoutHandler.handle(tokens[ReaderAssetPathHandler.MAX_CONCURRENT_STREAMS])
        assertEquals(503, saturated.statusCode)
        assertEquals("no-store", saturated.responseHeaders["Cache-Control"])
        assertEquals("nosniff", saturated.responseHeaders["X-Content-Type-Options"])

        heldResponses.first().data.close()
        val recovered = shortTimeoutHandler.handle(tokens[ReaderAssetPathHandler.MAX_CONCURRENT_STREAMS])
        assertEquals(200, recovered.statusCode)
        recovered.data.close()
        heldResponses.drop(1).forEach { it.data.close() }
    }

    @Test fun untimestampedProviderFallsBackToByteHashAndRejectsChangedOrOversizedStreams() {
        val env = createSharedFolderEnvironment(totalImagesInFolder = 2, imageBytes = 256, initialModified = 0L)
        val model = newModel()
        val capabilities = ReaderAssetCapabilities().also(model::attachReaderCapabilities)
        val handler = ReaderAssetPathHandler(
            capabilities = capabilities,
            openCapability = model::openReaderAsset,
            noteIsOpen = { id -> model.matchesReaderAssetNote(id) },
        )
        val noteId = openNote(model, env.noteUri, relative = "Note.md")

        val (_, firstAsset) = model.resolveReaderAsset(noteId, "images/img-00.png")
        assertEquals("untimestamped asset hashes bytes during resolution", 1, env.provider.imageOpenCount.get())
        val firstCapability = requireNotNull(capabilities.register(noteId, "images/img-00.png", firstAsset.mime, firstAsset.fingerprint, firstAsset.target))

        // Mutate underlying bytes while keeping length = 256 and lastModified = 0L.
        env.provider.overwriteImageBytes("vault/images/img-00.png", ByteArray(256) { 0x7a }, lastModified = 0L)

        val staleResponse = handler.handle(firstCapability.token)
        assertEquals(404, staleResponse.statusCode)
        assertEquals(-1, staleResponse.data.read())
        assertEquals("stale capability is revoked on mismatch", 0, capabilities.size())

        val (_, updatedAsset) = model.resolveReaderAsset(noteId, "images/img-00.png")
        assertNotEquals(firstAsset.fingerprint, updatedAsset.fingerprint)

        // Untimestamped stream exceeding 25 MB with unknown provider size (-1L) fails during fallback hashing.
        val oversizedFile = File(tempDir, "oversized.png").apply {
            outputStream().use { out ->
                val chunk = ByteArray(1_000_000)
                repeat(25) { out.write(chunk) }
                out.write(byteArrayOf(1))
            }
        }
        env.provider.putCustomEntry("vault/images/oversized.png", "oversized.png", "image/png", oversizedFile, reportedSize = -1L, lastModified = 0L)
        model.invalidateNoteAssets(noteId)
        assertThrows(IllegalArgumentException::class.java) {
            model.resolveReaderAsset(noteId, "images/oversized.png")
        }
    }

    @Test fun tabCloseTabMoveAndMetadataChangesInvalidateFolderIndexesAndStreamingGrants() {
        val env = createSharedFolderEnvironment(totalImagesInFolder = 4, imageBytes = 512)
        val model = newModel()
        val capabilities = ReaderAssetCapabilities().also(model::attachReaderCapabilities)
        val handler = ReaderAssetPathHandler(
            capabilities = capabilities,
            openCapability = model::openReaderAsset,
            noteIsOpen = { id -> model.matchesReaderAssetNote(id) },
        )
        val noteId = openNote(model, env.noteUri, relative = "Note.md")
        val otherId = openNote(model, env.otherUri, relative = "Other.md")

        val (_, noteAsset1) = model.resolveReaderAsset(noteId, "images/img-00.png")
        val noteCap1 = requireNotNull(capabilities.register(noteId, "images/img-00.png", noteAsset1.mime, noteAsset1.fingerprint, noteAsset1.target))
        val (_, otherAsset1) = model.resolveReaderAsset(otherId, "images/img-01.png")
        val otherCap1 = requireNotNull(capabilities.register(otherId, "images/img-01.png", otherAsset1.mime, otherAsset1.fingerprint, otherAsset1.target))

        assertTrue(model.readerFolderIndex.hasNoteEntries(noteId))
        assertTrue(model.readerFolderIndex.hasNoteEntries(otherId))

        // 1. Metadata timestamp change invalidates prior capability on stream open without serving stale bytes.
        env.provider.updateLastModified("vault/images/img-00.png", 1_900_000_000_000L)
        val opensBeforeStaleCheck = env.provider.imageOpenCount.get()
        val changedMetaResponse = handler.handle(noteCap1.token)
        assertEquals(404, changedMetaResponse.statusCode)
        assertEquals("timestamp mismatch rejects before opening stream", opensBeforeStaleCheck, env.provider.imageOpenCount.get())

        // Re-resolve noteId after metadata update, then rename/move noteId.
        val (_, noteAsset2) = model.resolveReaderAsset(noteId, "images/img-00.png")
        val noteCap2 = requireNotNull(capabilities.register(noteId, "images/img-00.png", noteAsset2.mime, noteAsset2.fingerprint, noteAsset2.target))
        assertEquals(2, capabilities.size())

        // 2. Moving/renaming noteId clears its folder index and revokes its streaming grant while preserving otherId.
        model.select(noteId)
        await { model.state.value.activeId == noteId }
        model.rename(noteId, "MovedNote.md")
        await { model.state.value.tabs.single { it.id == noteId }.name == "MovedNote.md" }

        assertFalse("renamed tab folder index cleared", model.readerFolderIndex.hasNoteEntries(noteId))
        assertTrue("unrelated open tab folder index preserved", model.readerFolderIndex.hasNoteEntries(otherId))
        assertEquals(1, capabilities.size())
        val movedTabResponse = handler.handle(noteCap2.token)
        assertEquals(404, movedTabResponse.statusCode)
        assertEquals("moved tab grant blocked before opening", opensBeforeStaleCheck, env.provider.imageOpenCount.get())

        // Other tab's capability remains valid and streams cleanly.
        val otherValidResponse = handler.handle(otherCap1.token)
        assertEquals(200, otherValidResponse.statusCode)
        otherValidResponse.data.close()

        // 3. Closing otherId clears its folder index and revokes its streaming grant.
        val opensBeforeClosedCheck = env.provider.imageOpenCount.get()
        model.close(otherId)
        await { model.state.value.tabs.none { it.id == otherId } }

        assertFalse("closed tab folder index cleared", model.readerFolderIndex.hasNoteEntries(otherId))
        assertEquals(0, capabilities.size())
        val closedTabResponse = handler.handle(otherCap1.token)
        assertEquals(404, closedTabResponse.statusCode)
        assertEquals("closed tab grant blocked before opening", opensBeforeClosedCheck, env.provider.imageOpenCount.get())
    }

    @Test fun unsafePathsAndSymlinksFailBeforeOpeningAnyFile() {
        val env = createSharedFolderEnvironment(totalImagesInFolder = 1, imageBytes = 128)
        val model = newModel()
        val noteId = openNote(model, env.noteUri, relative = "Note.md")

        val rejectedSources = listOf(
            "../outside.png",
            "images/../../outside.png",
            "/etc/passwd",
            "\\windows\\win.ini",
            "//cdn.example/photo.png",
            "file:///etc/passwd",
            "https://evil.example/photo.png",
            "content://${env.authority}/document/vault%2Fimages%2Fimg-00.png",
            "images/photo\u0000.png",
            "images/photo%00.png",
            "images%2fphoto.png",
            "images%5cphoto.png",
        )
        for (unsafe in rejectedSources) {
            val failure = runCatching { model.resolveReaderAsset(noteId, unsafe) }.exceptionOrNull()
            assertNotNull("expected $unsafe to be rejected", failure)
        }
        assertEquals("no provider file opens on unsafe paths", 0, env.provider.imageOpenCount.get())
        assertEquals("no folder queries on rejected path syntax or root escape", 0, env.provider.childQueryCount("vault"))

        // Symlink inside app attachments pointing outside app storage is rejected before opening.
        val id = UUID.randomUUID().toString()
        val outside = File(tempDir, "outside-$id.png").apply { writeBytes(byteArrayOf(1, 2, 3, 4)) }
        val link = File(File(app.filesDir, "attachments").apply { mkdirs() }, "import-$id.png")
        try {
            val created = runCatching { Files.createSymbolicLink(link.toPath(), outside.toPath()); true }.getOrDefault(false)
            if (created) {
                assertThrows(IllegalArgumentException::class.java) {
                    model.resolveReaderAsset(noteId, "assets/import-$id.png")
                }
            }
        } finally {
            link.delete()
            outside.delete()
        }
    }

    private data class SharedFolderEnvironment(
        val authority: String,
        val treeUri: Uri,
        val noteUri: Uri,
        val otherUri: Uri,
        val provider: SharedFolderDocumentProvider,
    )

    private fun createSharedFolderEnvironment(
        totalImagesInFolder: Int,
        imageBytes: Int,
        initialModified: Long = 1_700_000_000_000L,
    ): SharedFolderEnvironment {
        val authority = "dev.supermd.test.streaming.${System.nanoTime()}"
        val treeUri = DocumentsContract.buildTreeDocumentUri(authority, "vault")
        val noteUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, "vault/Note.md")
        val otherUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, "vault/Other.md")
        val provider = SharedFolderDocumentProvider(tempDir, totalImagesInFolder, imageBytes, initialModified).also {
            it.attach(app, authority)
        }
        ShadowContentResolver.registerProviderInternal(authority, provider)
        val grantFlags = Intent.FLAG_GRANT_READ_URI_PERMISSION or
            Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
            Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
        app.grantUriPermission(app.packageName, treeUri, grantFlags)
        app.grantUriPermission(app.packageName, noteUri, grantFlags)
        app.grantUriPermission(app.packageName, otherUri, grantFlags)
        app.contentResolver.takePersistableUriPermission(
            treeUri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
        )
        return SharedFolderEnvironment(authority, treeUri, noteUri, otherUri, provider)
    }

    private fun newModel(): StudioViewModel {
        val store = ViewModelStore().also(viewModels::add)
        val key = "reader-assets-${System.nanoTime()}".also(workspaceKeys::add)
        val model = StudioViewModel(app, key)
        model.readerFlushRequester = { true }
        store.put("model", model)
        return model
    }

    private fun openNote(model: StudioViewModel, uri: Uri, relative: String? = null): String {
        model.open(uri, relative = relative)
        await { model.state.value.tabs.any { it.uri == uri.toString() } }
        return model.state.value.tabs.single { it.uri == uri.toString() }.id
    }

    private fun await(timeoutMs: Long = 5_000, condition: () -> Boolean) {
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
}

private class SharedFolderDocumentProvider(
    private val tempDir: File,
    totalImagesInFolder: Int,
    imageBytes: Int,
    initialModified: Long,
) : ContentProvider() {
    data class Entry(
        var documentId: String,
        var parentId: String?,
        var displayName: String,
        val mimeType: String,
        var file: File?,
        var reportedSize: Long,
        var lastModified: Long,
    )

    private val entries = ConcurrentHashMap<String, Entry>()
    private val childQueries = ConcurrentHashMap<String, AtomicInteger>()
    val imageOpenCount = AtomicInteger(0)

    init {
        val noteFile = File(tempDir, "Note.md").apply { writeText("# Shared folder note\n") }
        val otherFile = File(tempDir, "Other.md").apply { writeText("# Second shared folder note\n") }
        val sharedImageBacking = File(tempDir, "shared-raster.png").apply {
            outputStream().use { out ->
                val header = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
                if (imageBytes <= header.size) {
                    out.write(header.copyOf(imageBytes))
                } else {
                    out.write(header)
                    var remaining = imageBytes - header.size
                    val chunk = ByteArray(minOf(65_536, remaining)) { (it and 0xff).toByte() }
                    while (remaining > 0) {
                        val step = minOf(chunk.size, remaining)
                        out.write(chunk, 0, step)
                        remaining -= step
                    }
                }
            }
        }
        entries["vault"] = Entry("vault", null, "vault", DocumentsContract.Document.MIME_TYPE_DIR, null, 0L, 1_700_000_000_000L)
        entries["vault/Note.md"] = Entry("vault/Note.md", "vault", "Note.md", "text/markdown", noteFile, noteFile.length(), 1_700_000_000_000L)
        entries["vault/Other.md"] = Entry("vault/Other.md", "vault", "Other.md", "text/markdown", otherFile, otherFile.length(), 1_700_000_000_000L)
        entries["vault/images"] = Entry("vault/images", "vault", "images", DocumentsContract.Document.MIME_TYPE_DIR, null, 0L, 1_700_000_000_000L)
        for (index in 0 until totalImagesInFolder) {
            val name = if (index < 20) "img-%02d.png".format(index) else "extra-%02d.png".format(index)
            val docId = "vault/images/$name"
            val modified = if (initialModified > 0L) initialModified + index else initialModified
            entries[docId] = Entry(docId, "vault/images", name, "image/png", sharedImageBacking, imageBytes.toLong(), modified)
        }
    }

    fun attach(context: Context, authority: String) {
        val info = ProviderInfo().apply {
            this.authority = authority
            exported = true
            grantUriPermissions = true
        }
        attachInfo(context, info)
    }

    fun childQueryCount(parentDocumentId: String): Int = childQueries[parentDocumentId]?.get() ?: 0

    fun updateLastModified(documentId: String, lastModified: Long) {
        entries.computeIfPresent(documentId) { _, entry -> entry.copy(lastModified = lastModified) }
    }

    fun overwriteImageBytes(documentId: String, bytes: ByteArray, lastModified: Long) {
        val replacement = File(tempDir, "custom-${UUID.randomUUID()}.png").apply { writeBytes(bytes) }
        entries.computeIfPresent(documentId) { _, entry ->
            entry.copy(file = replacement, reportedSize = bytes.size.toLong(), lastModified = lastModified)
        }
    }

    fun putCustomEntry(documentId: String, name: String, mime: String, file: File, reportedSize: Long, lastModified: Long) {
        val parent = documentId.substringBeforeLast('/')
        entries[documentId] = Entry(documentId, parent, name, mime, file, reportedSize, lastModified)
    }

    override fun onCreate(): Boolean = true

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor {
        val path = uri.pathSegments
        if (path.lastOrNull() == "children") {
            val parentId = DocumentsContract.getDocumentId(uri)
            childQueries.computeIfAbsent(parentId) { AtomicInteger(0) }.incrementAndGet()
            val columns = projection ?: arrayOf(
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
            )
            return MatrixCursor(columns).apply {
                entries.values
                    .filter { it.parentId == parentId }
                    .sortedBy { it.displayName }
                    .forEach { child -> addRow(rowFor(child, columns)) }
            }
        }
        val docId = DocumentsContract.getDocumentId(uri)
        val entry = entries[docId] ?: return MatrixCursor(projection ?: arrayOf(OpenableColumns.DISPLAY_NAME))
        val columns = projection ?: arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED,
        )
        return MatrixCursor(columns).apply { addRow(rowFor(entry, columns)) }
    }

    private fun rowFor(entry: Entry, columns: Array<out String>): Array<Any?> =
        columns.map { col ->
            when (col) {
                DocumentsContract.Document.COLUMN_DOCUMENT_ID -> entry.documentId
                DocumentsContract.Document.COLUMN_DISPLAY_NAME, OpenableColumns.DISPLAY_NAME -> entry.displayName
                DocumentsContract.Document.COLUMN_MIME_TYPE -> entry.mimeType
                DocumentsContract.Document.COLUMN_SIZE, OpenableColumns.SIZE ->
                    if (entry.reportedSize >= 0L) entry.reportedSize else null
                DocumentsContract.Document.COLUMN_LAST_MODIFIED ->
                    if (entry.lastModified > 0L) entry.lastModified else null
                else -> null
            }
        }.toTypedArray()

    override fun getType(uri: Uri): String? = entries[DocumentsContract.getDocumentId(uri)]?.mimeType

    override fun call(method: String, arg: String?, extras: Bundle?): Bundle? {
        if (method == "android:renameDocument" && extras != null) {
            @Suppress("DEPRECATION")
            val sourceUri = extras.getParcelable<Uri>("uri") ?: return null
            val newName = extras.getString(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
                ?: extras.getString(Intent.EXTRA_TITLE)
                ?: return null
            val oldId = DocumentsContract.getDocumentId(sourceUri)
            val existing = entries.remove(oldId) ?: return null
            val parent = existing.parentId
            val newId = if (parent.isNullOrEmpty()) newName else "$parent/$newName"
            val updated = existing.copy(documentId = newId, displayName = newName)
            entries[newId] = updated
            val renamedUri = if (DocumentsContract.isTreeUri(sourceUri)) {
                DocumentsContract.buildDocumentUriUsingTree(sourceUri, newId)
            } else {
                DocumentsContract.buildDocumentUri(sourceUri.authority, newId)
            }
            return Bundle().apply { putParcelable("uri", renamedUri) }
        }
        return super.call(method, arg, extras)
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        val docId = DocumentsContract.getDocumentId(uri)
        val entry = entries[docId] ?: throw java.io.FileNotFoundException("Missing $docId")
        val file = entry.file ?: throw java.io.FileNotFoundException("Directory $docId cannot be opened")
        if (entry.mimeType.startsWith("image/")) {
            imageOpenCount.incrementAndGet()
        }
        val flags = when (mode) {
            "r" -> ParcelFileDescriptor.MODE_READ_ONLY
            "rw" -> ParcelFileDescriptor.MODE_READ_WRITE
            "wt", "w" -> ParcelFileDescriptor.MODE_WRITE_ONLY or ParcelFileDescriptor.MODE_CREATE or ParcelFileDescriptor.MODE_TRUNCATE
            else -> throw java.io.FileNotFoundException("Unsupported mode $mode")
        }
        return ParcelFileDescriptor.open(file, flags)
    }
}
