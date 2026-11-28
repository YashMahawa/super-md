package dev.supermd.studio

import android.app.Application
import android.content.*
import android.content.pm.ProviderInfo
import android.database.*
import android.net.Uri
import android.os.*
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import androidx.lifecycle.ViewModelStore
import java.io.*
import java.nio.file.Files
import java.time.Duration
import java.util.UUID
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import org.robolectric.*
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowContentResolver

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class SafFolderMutationCoordinatorTest {
    private lateinit var app: Application
    private lateinit var rootDir: File
    private lateinit var provider: FolderCreationTestProvider
    private lateinit var treeUri: Uri
    private val stores = mutableListOf<ViewModelStore>()
    private val keys = mutableListOf<String>()

    @Before fun setUp() {
        app = RuntimeEnvironment.getApplication()
        rootDir = Files.createTempDirectory("saf-mutation-test").toFile()
        val auth = "dev.supermd.test.saf.${UUID.randomUUID()}"
        provider = FolderCreationTestProvider(app, rootDir, auth)
        ShadowContentResolver.registerProviderInternal(auth, provider)
        treeUri = DocumentsContract.buildTreeDocumentUri(auth, "root")
        app.grantUriPermission(
            app.packageName, treeUri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or Intent.FLAG_GRANT_PREFIX_URI_PERMISSION,
        )
    }

    @After fun tearDown() {
        stores.forEach { it.clear() }; ShadowContentResolver.reset(); rootDir.deleteRecursively()
        keys.forEach { k ->
            File(app.filesDir, "workspaces/$k.json").delete()
            File(app.filesDir, "workspaces/$k").deleteRecursively()
            app.deleteSharedPreferences("studio-window-$k")
        }
    }

    private fun newModel(): StudioViewModel =
        StudioViewModel(app, "saf-mut-${UUID.randomUUID()}".also(keys::add)).also {
            it.readerFlushRequester = { true }; ViewModelStore().also(stores::add).put("vm", it)
        }

    private fun await(predicate: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 5_000L
        while (System.currentTimeMillis() < deadline && !predicate()) {
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(20)); Thread.sleep(10)
        }
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(20))
        assertTrue("Condition timed out", predicate())
    }

    @Test fun createFolderNoteAndCreateSubfolderRequireOpenFolderAndRejectDuplicates() {
        val model = newModel()

        var missingNoteDone = false
        var missingNoteResult: Note? = Note(name = "sentinel.md")
        model.createFolderNote("", "Orphan") { missingNoteResult = it; missingNoteDone = true }
        assertTrue(missingNoteDone); assertNull(missingNoteResult)
        assertEquals("Open a folder first to create a folder note", model.state.value.error)

        var missingSubDone = false
        var missingSubResult: FileEntry? = FileEntry("sentinel", "content://x", true, "sentinel")
        model.createSubfolder("", "OrphanDir") { missingSubResult = it; missingSubDone = true }
        assertTrue(missingSubDone); assertNull(missingSubResult)
        assertEquals("Open a folder first to create a subfolder", model.state.value.error)

        model.setFolder(treeUri); await { model.state.value.folder == treeUri.toString() }

        var createdSub: FileEntry? = null
        model.createSubfolder("", "Sem1") { createdSub = it }; await { createdSub != null }
        assertEquals("Sem1", createdSub!!.name); assertEquals("Sem1", createdSub!!.relative); assertTrue(createdSub!!.directory)

        var nestedSub: FileEntry? = null
        model.createSubfolder("Sem1", "Math") { nestedSub = it }; await { nestedSub != null }
        assertEquals("Math", nestedSub!!.name); assertEquals("Sem1/Math", nestedSub!!.relative)
        assertEquals("Sem1", model.state.value.folderRelative)
        assertTrue(model.state.value.files.any { it.name == "Math" && it.directory && it.relative == "Sem1/Math" })

        var dupSubDone = false
        var dupSubResult: FileEntry? = createdSub
        model.createSubfolder("Sem1", "math") { dupSubResult = it; dupSubDone = true }; await { dupSubDone }
        assertNull(dupSubResult); assertTrue(model.state.value.error?.contains("already exists") == true)

        var mdNote: Note? = null
        model.createFolderNote("Sem1/Math", "Lecture 1", portable = false) { mdNote = it }; await { mdNote != null }
        assertEquals("Lecture 1.md", mdNote!!.name); assertEquals("Sem1/Math/Lecture 1.md", mdNote!!.relative)
        assertFalse(mdNote!!.portable); assertEquals(mdNote!!.id, model.state.value.active.id)
        assertEquals("Sem1/Math", model.state.value.folderRelative)
        assertTrue(model.documentAccess.hasWriteGrant(Uri.parse(mdNote!!.uri!!)))

        var smdNote: Note? = null
        model.createFolderNote("Sem1/Math", "Workbook", portable = true) { smdNote = it }; await { smdNote != null }
        assertEquals("Workbook.smd", smdNote!!.name); assertEquals("Sem1/Math/Workbook.smd", smdNote!!.relative)
        assertTrue(smdNote!!.portable); assertNotNull(smdNote!!.assetDirectory)
        assertTrue(File(app.filesDir, "portable-assets/${smdNote!!.assetDirectory}").isDirectory)
        assertTrue(File(rootDir, "Sem1/Math/Workbook.smd").length() > 0L)
        assertTrue(model.documentAccess.hasWriteGrant(Uri.parse(smdNote!!.uri!!)))

        var dupNoteDone = false
        var dupNoteResult: Note? = mdNote
        model.createFolderNote("Sem1/Math", "lecture 1", portable = false) { dupNoteResult = it; dupNoteDone = true }
        await { dupNoteDone }
        assertNull(dupNoteResult); assertTrue(model.state.value.error?.contains("already exists") == true)
    }

    @Test fun createFolderNoteRetainsBackgroundTabOnFailedBarrierAndCleansUpOnWriteFailure() {
        val model = newModel()
        model.setFolder(treeUri); await { model.state.value.folder == treeUri.toString() }

        val originalActiveId = model.state.value.active.id
        model.readerFlushRequester = { false }
        var backgroundNote: Note? = null
        model.createFolderNote("", "Background Note", portable = false) { backgroundNote = it }
        await { backgroundNote != null }
        assertEquals(originalActiveId, model.state.value.active.id)
        assertTrue(model.state.value.tabs.any { it.name == "Background Note.md" && it.uri == backgroundNote!!.uri })
        assertEquals("Created Background Note.md", model.state.value.message)

        model.readerFlushRequester = { true }
        val portableAssetsRoot = File(app.filesDir, "portable-assets")
        val beforeAssetDirs = portableAssetsRoot.list()?.toSet().orEmpty()
        val beforeStagedFiles = app.cacheDir.list()?.filter { it.startsWith("create-smd-") }?.toSet().orEmpty()

        provider.failWriteOpens = true
        var failedDone = false
        var failedResult: Note? = backgroundNote
        model.createFolderNote("", "Broken Bundle", portable = true) { failedResult = it; failedDone = true }
        await { failedDone }
        assertNull(failedResult)
        assertFalse("Failed portable creation must delete provider document", File(rootDir, "Broken Bundle.smd").exists())
        assertEquals(beforeAssetDirs, portableAssetsRoot.list()?.toSet().orEmpty())
        assertEquals(beforeStagedFiles, app.cacheDir.list()?.filter { it.startsWith("create-smd-") }?.toSet().orEmpty())
        assertTrue(model.state.value.error?.contains("Could not create note:") == true)
    }
}

private class FolderCreationTestProvider(
    private val ctx: Application, private val root: File, private val auth: String,
) : ContentProvider() {
    @Volatile var failWriteOpens: Boolean = false
    init { attachInfo(ctx, ProviderInfo().apply { authority = auth; exported = true; grantUriPermissions = true }) }
    override fun onCreate() = true
    private fun fileFor(id: String) = if (id == "root") root else File(root, id.removePrefix("root/"))
    private fun idFor(f: File) = if (f.canonicalPath == root.canonicalPath) "root" else "root/${f.relativeTo(root).invariantSeparatorsPath}"
    private fun mimeFor(f: File) = when {
        f.isDirectory -> Document.MIME_TYPE_DIR
        f.extension == "smd" -> "application/vnd.supermd.smd"
        else -> "text/markdown"
    }
    private fun treeDoc(id: String): Uri =
        DocumentsContract.buildDocumentUriUsingTree(DocumentsContract.buildTreeDocumentUri(auth, "root"), id).also {
            ctx.grantUriPermission(ctx.packageName, it, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PREFIX_URI_PERMISSION)
        }
    private fun addRow(c: MatrixCursor, f: File) {
        if (!f.exists()) throw FileNotFoundException(f.path)
        val flags = if (f.isDirectory) Document.FLAG_DIR_SUPPORTS_CREATE else Document.FLAG_SUPPORTS_WRITE
        c.addRow(c.columnNames.map { col -> when (col) {
            Document.COLUMN_DOCUMENT_ID -> idFor(f); Document.COLUMN_DISPLAY_NAME, "_display_name" -> if (f == root) "Workspace" else f.name
            Document.COLUMN_MIME_TYPE -> mimeFor(f); Document.COLUMN_SIZE, "_size" -> if (f.isFile) f.length() else 0L
            Document.COLUMN_LAST_MODIFIED -> f.lastModified(); Document.COLUMN_FLAGS -> flags; else -> null
        } }.toTypedArray<Any?>())
    }
    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor {
        val cols = projection ?: arrayOf(Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE, Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED, Document.COLUMN_FLAGS)
        return if (uri.pathSegments.lastOrNull() == "children") MatrixCursor(cols).also { c -> fileFor(Uri.decode(uri.pathSegments[uri.pathSegments.size - 2])).listFiles()?.forEach { addRow(c, it) } }
        else MatrixCursor(cols).also { addRow(it, fileFor(DocumentsContract.getDocumentId(uri))) }
    }
    override fun getType(uri: Uri) = runCatching { mimeFor(fileFor(DocumentsContract.getDocumentId(uri))) }.getOrDefault("application/octet-stream")
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0
    override fun call(method: String, arg: String?, extras: Bundle?): Bundle = Bundle().apply {
        val inEx = extras ?: Bundle.EMPTY; val docUri = inEx.getParcelable("uri", Uri::class.java)
        when (method) {
            "android:createDocument" -> {
                val target = File(fileFor(DocumentsContract.getDocumentId(docUri!!)), inEx.getString(Document.COLUMN_DISPLAY_NAME)!!)
                if (inEx.getString(Document.COLUMN_MIME_TYPE) == Document.MIME_TYPE_DIR) check(target.mkdirs()) else check(target.createNewFile())
                putParcelable("uri", treeDoc(idFor(target)))
            }
            "android:deleteDocument" -> putBoolean("result", fileFor(DocumentsContract.getDocumentId(docUri!!)).deleteRecursively())
            "android:isChildDocument" -> {
                val p = DocumentsContract.getDocumentId(docUri!!).trimEnd('/'); val c = DocumentsContract.getDocumentId(inEx.getParcelable("targetUri", Uri::class.java)!!)
                putBoolean("result", c == p || c.startsWith("$p/"))
            }
        }
    }
    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        if (failWriteOpens && (mode == "wt" || mode == "w")) throw FileNotFoundException("Simulated write failure")
        val flags = if (mode == "wt" || mode == "w") ParcelFileDescriptor.MODE_WRITE_ONLY or ParcelFileDescriptor.MODE_CREATE or ParcelFileDescriptor.MODE_TRUNCATE else ParcelFileDescriptor.parseMode(mode)
        return ParcelFileDescriptor.open(fileFor(DocumentsContract.getDocumentId(uri)), flags)
    }
}
