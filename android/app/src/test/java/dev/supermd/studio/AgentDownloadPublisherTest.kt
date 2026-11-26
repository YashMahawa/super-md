package dev.supermd.studio

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.ProviderInfo
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.Base64
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.nio.file.Files
import java.util.UUID
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowContentResolver

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class AgentDownloadPublisherTest {
    private val pngBytes = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d)
    private val svgBytes = "<svg xmlns=\"http://www.w3.org/2000/svg\"><circle r=\"4\"/></svg>".toByteArray(Charsets.UTF_8)

    private lateinit var tempDir: File
    private lateinit var downloadsProvider: TestDownloadsProvider
    private lateinit var safProvider: TestSafTreeProvider
    private lateinit var treeUri: Uri
    private lateinit var media: MediaStorage

    @Before
    fun setUp() {
        val app = RuntimeEnvironment.getApplication()
        tempDir = Files.createTempDirectory("agent-download-publisher-test").toFile()
        downloadsProvider = TestDownloadsProvider(File(tempDir, "downloads").apply { mkdirs() }).apply {
            attachInfo(app, ProviderInfo().apply { authority = MediaStore.AUTHORITY })
        }
        ShadowContentResolver.registerProviderInternal(MediaStore.AUTHORITY, downloadsProvider)

        val safAuthority = "dev.supermd.test.publisher.${UUID.randomUUID()}"
        safProvider = TestSafTreeProvider(app, File(tempDir, "saf").apply { mkdirs() }, safAuthority)
        ShadowContentResolver.registerProviderInternal(safAuthority, safProvider)
        treeUri = DocumentsContract.buildTreeDocumentUri(safAuthority, "root")
        app.grantUriPermission(app.packageName, treeUri, Intent.FLAG_GRANT_READ_URI_PERMISSION or
            Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or Intent.FLAG_GRANT_PREFIX_URI_PERMISSION)
        media = MediaStorage(app)
    }

    @After
    fun tearDown() {
        ShadowContentResolver.reset()
        tempDir.deleteRecursively()
    }

    @Test
    fun downloadsPublishingTransitionsPendingDeduplicatesCollisionsAndDeletesEntries() {
        val firstMedia = media.saveAgentMedia(mediaArgs("diagram.png", "image/png", pngBytes), "")
        val firstMediaUri = Uri.parse(firstMedia.getString("uri"))
        assertEquals("diagram.png", firstMedia.getString("filename"))
        assertEquals(pngBytes.size, firstMedia.getInt("bytes"))
        assertEquals("image/png", firstMedia.getString("mimeType"))
        val firstMediaEntry = downloadsProvider.entries.getValue(firstMediaUri)
        assertEquals(listOf(1, 1, 0), listOf(firstMediaEntry.pendingOnInsert, firstMediaEntry.pendingOnWrite, firstMediaEntry.pending))
        assertEquals("${android.os.Environment.DIRECTORY_DOWNLOADS}/Super MD/", firstMediaEntry.relativePath)
        assertArrayEquals(pngBytes, firstMediaEntry.file.readBytes())

        val secondMedia = media.saveAgentMedia(mediaArgs("diagram.png", "image/png", pngBytes), null)
        assertEquals("diagram (2).png", secondMedia.getString("filename"))

        val mdBytes = "# Exported Note\n".toByteArray(Charsets.UTF_8)
        val (firstDocUri, firstDocName) = media.writeAgentDocument("Notes.md", "text/markdown; charset=utf-8", "") { _, out -> out.write(mdBytes) }
        assertEquals("Notes.md", firstDocName)
        val firstDocEntry = downloadsProvider.entries.getValue(firstDocUri)
        assertEquals(listOf(1, 1, 0), listOf(firstDocEntry.pendingOnInsert, firstDocEntry.pendingOnWrite, firstDocEntry.pending))
        assertArrayEquals(mdBytes, firstDocEntry.file.readBytes())

        val (_, secondDocName) = media.writeAgentDocument("Notes.md", "text/markdown", null) { _, out -> out.write(mdBytes) }
        assertEquals("Notes (2).md", secondDocName)
        val (_, dotlessFirst) = media.writeAgentDocument("README", "text/markdown", "") { _, out -> out.write(mdBytes) }
        val (_, dotlessSecond) = media.writeAgentDocument("README", "text/markdown", "") { _, out -> out.write(mdBytes) }
        assertEquals(listOf("README", "README (2)"), listOf(dotlessFirst, dotlessSecond))

        media.deleteAgentDocument(firstMediaUri)
        media.deleteAgentDocument(firstDocUri)
        assertFalse(downloadsProvider.entries.containsKey(firstMediaUri) || firstMediaEntry.file.exists())
        assertFalse(downloadsProvider.entries.containsKey(firstDocUri) || firstDocEntry.file.exists())
        assertEquals(4, downloadsProvider.entries.size)
    }

    @Test
    fun downloadsZeroRowsUpdatedWhenClearingPendingThrowsAndDeletesPendingEntry() {
        downloadsProvider.updateResult = 0
        val mediaError = assertThrows(IllegalArgumentException::class.java) {
            media.saveAgentMedia(mediaArgs("chart.svg", "image/svg+xml", svgBytes), "")
        }
        assertTrue(mediaError.message!!.contains("publish the Downloads entry"))
        assertTrue(downloadsProvider.entries.isEmpty())
        assertEquals(1, downloadsProvider.deleteCount)

        val docError = assertThrows(IllegalArgumentException::class.java) {
            media.writeAgentDocument("Report.pdf", "application/pdf", null) { _, out -> out.write("%PDF-1.7".toByteArray()) }
        }
        assertTrue(docError.message!!.contains("publish the Downloads entry"))
        assertTrue(downloadsProvider.entries.isEmpty())
        assertEquals(2, downloadsProvider.deleteCount)
    }

    @Test
    fun nonTreeConfiguredLocationRejectedByBothMethodsWithoutDownloadsFallback() {
        val nonTreeUri = "content://com.example.provider/document/not-a-tree"
        val mediaError = assertThrows(IllegalArgumentException::class.java) {
            media.saveAgentMedia(mediaArgs("diagram.png", "image/png", pngBytes), nonTreeUri)
        }
        assertTrue(mediaError.message!!.contains("not a folder"))
        val docError = assertThrows(IllegalArgumentException::class.java) {
            media.writeAgentDocument("Notes.md", "text/markdown", nonTreeUri) { _, out -> out.write(byteArrayOf(1)) }
        }
        assertTrue(docError.message!!.contains("not a folder"))
        assertTrue(downloadsProvider.entries.isEmpty())
    }

    @Test
    fun safTreeFolderPublishingDeduplicatesCleansUpOnWriteFailureAndDeletes() {
        val configuredTree = treeUri.toString()
        val firstSvg = media.saveAgentMedia(mediaArgs("figure.svg", "image/svg+xml", svgBytes), configuredTree)
        val secondSvg = media.saveAgentMedia(mediaArgs("figure.svg", "image/svg+xml", svgBytes), configuredTree)
        assertEquals(listOf("figure.svg", "figure (2).svg"), listOf(firstSvg.getString("filename"), secondSvg.getString("filename")))
        assertArrayEquals(svgBytes, safProvider.backingFile("figure.svg").readBytes())
        assertArrayEquals(svgBytes, safProvider.backingFile("figure (2).svg").readBytes())

        val pdfBytes = "%PDF-1.7\n".toByteArray(Charsets.US_ASCII)
        val (pdfUri, pdfName) = media.writeAgentDocument("Bundle.pdf", "application/pdf", configuredTree) { _, out -> out.write(pdfBytes) }
        assertEquals("Bundle.pdf", pdfName)
        assertArrayEquals(pdfBytes, safProvider.backingFile("Bundle.pdf").readBytes())

        assertThrows(IOException::class.java) {
            media.writeAgentDocument("Partial.pdf", "application/pdf", configuredTree) { _, out ->
                out.write("partial".toByteArray()); throw IOException("Simulated write failure")
            }
        }
        assertFalse(safProvider.backingFile("Partial.pdf").exists())

        safProvider.failOpenOutputForName = "broken.png"
        assertThrows(FileNotFoundException::class.java) {
            media.saveAgentMedia(mediaArgs("broken.png", "image/png", pngBytes), configuredTree)
        }
        assertFalse(safProvider.backingFile("broken.png").exists())
        assertEquals(0, downloadsProvider.entries.size)

        media.deleteAgentDocument(pdfUri)
        assertFalse(safProvider.backingFile("Bundle.pdf").exists())
        assertTrue(safProvider.backingFile("figure.svg").exists())
    }

    @Test
    @Config(sdk = [28])
    fun api28RequiresConfiguredFolderWhenPublishingToDownloads() {
        assertThrows(IllegalStateException::class.java) { media.saveAgentMedia(mediaArgs("diagram.png", "image/png", pngBytes), "") }
        assertThrows(IllegalStateException::class.java) { media.writeAgentDocument("Notes.md", "text/markdown", null) { _, out -> out.write(byteArrayOf(1)) } }
    }

    private fun mediaArgs(filename: String, mimeType: String, bytes: ByteArray): JSONObject =
        JSONObject().put("filename", filename).put("mimeType", mimeType).put("body", Base64.encodeToString(bytes, Base64.NO_WRAP))
}

private class TestDownloadsProvider(private val root: File) : ContentProvider() {
    data class Entry(val id: Long, val displayName: String, val mimeType: String, val relativePath: String, val pendingOnInsert: Int, var pendingOnWrite: Int = -1, var pending: Int, val file: File)
    private var nextId = 1L
    val entries = linkedMapOf<Uri, Entry>()
    var updateResult = 1
    var deleteCount = 0
    override fun onCreate(): Boolean = true

    override fun insert(uri: Uri, values: ContentValues?): Uri {
        val v = requireNotNull(values); val id = nextId++; val pending = v.getAsInteger(MediaStore.Downloads.IS_PENDING) ?: 0
        val itemUri = Uri.parse("content://${MediaStore.AUTHORITY}/external/downloads/$id")
        entries[itemUri] = Entry(id, v.getAsString(MediaStore.Downloads.DISPLAY_NAME), v.getAsString(MediaStore.Downloads.MIME_TYPE).orEmpty(),
            v.getAsString(MediaStore.Downloads.RELATIVE_PATH).orEmpty(), pending, -1, pending, File(root, "download-$id").apply { createNewFile() })
        return itemUri
    }

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        val entry = entries[uri] ?: throw FileNotFoundException("Missing URI: $uri")
        if (mode.contains('w')) entry.pendingOnWrite = entry.pending
        val flags = if (mode.contains('w')) ParcelFileDescriptor.MODE_WRITE_ONLY or ParcelFileDescriptor.MODE_CREATE or ParcelFileDescriptor.MODE_TRUNCATE else ParcelFileDescriptor.MODE_READ_ONLY
        return ParcelFileDescriptor.open(entry.file, flags)
    }

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor {
        val cols = projection ?: arrayOf(MediaStore.Downloads._ID, MediaStore.Downloads.DISPLAY_NAME, OpenableColumns.DISPLAY_NAME)
        val cursor = MatrixCursor(cols)
        val matched = if (entries.containsKey(uri)) listOf(entries.getValue(uri)) else entries.values.filter { entry ->
            if (selection != null && selectionArgs != null && selectionArgs.size == 2) entry.displayName == selectionArgs[0] && entry.relativePath == selectionArgs[1] else true
        }
        matched.forEach { entry ->
            cursor.addRow(cols.map<String, Any?> { col -> when (col) { MediaStore.Downloads._ID -> entry.id; MediaStore.Downloads.DISPLAY_NAME, OpenableColumns.DISPLAY_NAME -> entry.displayName; else -> null } }.toTypedArray())
        }
        return cursor
    }

    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int {
        if (updateResult <= 0) return updateResult
        val entry = entries[uri] ?: return 0
        values?.getAsInteger(MediaStore.Downloads.IS_PENDING)?.let { entry.pending = it }
        return updateResult
    }

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int {
        deleteCount++
        return if (entries.remove(uri)?.also { it.file.delete() } != null) 1 else 0
    }

    override fun getType(uri: Uri): String? = entries[uri]?.mimeType
}

private class TestSafTreeProvider(private val appContext: Context, private val rootDir: File, private val authority: String) : ContentProvider() {
    private val mimeByDocId = mutableMapOf("root" to Document.MIME_TYPE_DIR)
    var failOpenOutputForName: String? = null

    init { attachInfo(appContext, ProviderInfo().apply { this.authority = this@TestSafTreeProvider.authority; exported = true; grantUriPermissions = true }) }
    fun backingFile(name: String): File = File(rootDir, name)
    private fun fileForId(docId: String): File = if (docId == "root") rootDir else File(rootDir, docId.removePrefix("root/"))
    override fun onCreate(): Boolean = true

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor {
        val cols = projection ?: arrayOf(Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE, Document.COLUMN_SIZE, Document.COLUMN_FLAGS)
        val cursor = MatrixCursor(cols)
        if (uri.pathSegments.lastOrNull() == "children") rootDir.listFiles()?.sortedBy { it.name }?.forEach { includeRow(cursor, "root/${it.name}", it) }
        else { val docId = DocumentsContract.getDocumentId(uri); val file = fileForId(docId); if (!file.exists()) throw FileNotFoundException(docId); includeRow(cursor, docId, file) }
        return cursor
    }

    private fun includeRow(cursor: MatrixCursor, docId: String, file: File) {
        val flags = if (file.isDirectory) Document.FLAG_DIR_SUPPORTS_CREATE else Document.FLAG_SUPPORTS_WRITE or Document.FLAG_SUPPORTS_DELETE
        val mime = if (file.isDirectory) Document.MIME_TYPE_DIR else mimeByDocId[docId] ?: "application/octet-stream"
        cursor.addRow(cursor.columnNames.map<String, Any?> { col ->
            when (col) {
                Document.COLUMN_DOCUMENT_ID -> docId
                Document.COLUMN_DISPLAY_NAME, OpenableColumns.DISPLAY_NAME -> if (docId == "root") "Notes" else file.name
                Document.COLUMN_MIME_TYPE -> mime
                Document.COLUMN_SIZE, OpenableColumns.SIZE -> if (file.isFile) file.length() else 0L
                Document.COLUMN_FLAGS -> flags
                else -> null
            }
        }.toTypedArray())
    }

    override fun call(method: String, arg: String?, extras: Bundle?): Bundle {
        val inExtras = extras ?: Bundle.EMPTY
        val docUri = requireNotNull(inExtras.getParcelable("uri", Uri::class.java))
        val out = Bundle()
        when (method) {
            "android:createDocument" -> {
                val displayName = requireNotNull(inExtras.getString(Document.COLUMN_DISPLAY_NAME))
                check(File(rootDir, displayName).createNewFile())
                val newId = "root/$displayName"
                mimeByDocId[newId] = inExtras.getString(Document.COLUMN_MIME_TYPE).orEmpty()
                val createdUri = DocumentsContract.buildDocumentUriUsingTree(DocumentsContract.buildTreeDocumentUri(authority, "root"), newId)
                appContext.grantUriPermission(appContext.packageName, createdUri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                out.putParcelable("uri", createdUri)
            }
            "android:deleteDocument" -> {
                val docId = DocumentsContract.getDocumentId(docUri)
                out.putBoolean("result", fileForId(docId).delete().also { mimeByDocId.remove(docId) })
            }
        }
        return out
    }

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        val file = fileForId(DocumentsContract.getDocumentId(uri))
        if (mode.contains('w') && file.name == failOpenOutputForName) throw FileNotFoundException("Simulated openOutputStream failure")
        val flags = if (mode.contains('w')) ParcelFileDescriptor.MODE_WRITE_ONLY or ParcelFileDescriptor.MODE_CREATE or ParcelFileDescriptor.MODE_TRUNCATE else ParcelFileDescriptor.MODE_READ_ONLY
        return ParcelFileDescriptor.open(file, flags)
    }

    override fun getType(uri: Uri): String? = mimeByDocId[DocumentsContract.getDocumentId(uri)]
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0
}
