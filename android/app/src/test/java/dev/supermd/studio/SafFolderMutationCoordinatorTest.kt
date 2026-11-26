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
    private lateinit var treeUri: Uri
    private val stores = mutableListOf<ViewModelStore>()
    private val keys = mutableListOf<String>()

    @Before fun setUp() {
        app = RuntimeEnvironment.getApplication(); rootDir = Files.createTempDirectory("saf-mutation-test").toFile()
        val auth = "dev.supermd.test.saf.${UUID.randomUUID()}"
        ShadowContentResolver.registerProviderInternal(auth, MutationTreeProvider(app, rootDir, auth))
        treeUri = DocumentsContract.buildTreeDocumentUri(auth, "root")
        app.grantUriPermission(app.packageName, treeUri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or Intent.FLAG_GRANT_PREFIX_URI_PERMISSION)
    }

    @After fun tearDown() {
        stores.forEach { it.clear() }; ShadowContentResolver.reset(); rootDir.deleteRecursively()
        keys.forEach { k -> File(app.filesDir, "workspaces/$k.json").delete(); File(app.filesDir, "workspaces/$k").deleteRecursively(); app.deleteSharedPreferences("studio-window-$k") }
    }

    private fun newModel(): StudioViewModel = StudioViewModel(app, "saf-mut-${UUID.randomUUID()}".also(keys::add)).also {
        it.readerFlushRequester = { true }; ViewModelStore().also(stores::add).put("vm", it)
    }

    private fun await(predicate: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 5_000L
        while (System.currentTimeMillis() < deadline && !predicate()) { shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(20)); Thread.sleep(10) }
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(20)); assertTrue("Condition timed out", predicate())
    }

    @Test fun renameDraftTabAndRejectDuplicateNameInOpenSafFolder() {
        val model = newModel()
        model.rename(model.state.value.active.id, "Draft Idea"); await { model.state.value.active.name == "Draft Idea.md" }
        File(rootDir, "Alpha.md").writeText("# Alpha\n"); File(rootDir, "Beta.md").writeText("# Beta\n")
        model.setFolder(treeUri); await { model.state.value.folder == treeUri.toString() }
        val betaUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, "root/Beta.md")
        model.open(betaUri, "Beta.md"); await { model.state.value.active.uri == betaUri.toString() }
        var rejected: Pair<Boolean, String?>? = null
        model.rename(model.state.value.active.id, "Alpha", showGlobalError = false) { ok, err -> rejected = ok to err }; await { rejected != null }
        assertFalse(rejected!!.first); assertTrue(rejected!!.second?.contains("already exists") == true); assertNull(model.state.value.error)
    }

    @Test fun createSubfolderFolderNotesAndRenameNoteAndDirectoryUpdateOpenTabsAndFiles() {
        val model = newModel()
        model.setFolder(treeUri); await { model.state.value.folder == treeUri.toString() }
        model.createSubfolder("", "Notes"); await { model.state.value.files.any { it.name == "Notes" && it.directory } }
        model.createFolderNote("Notes", "Bundle", portable = true); await { model.state.value.active.name == "Bundle.smd" && model.state.value.active.portable }
        model.createFolderNote("Notes", "Topic", portable = false); await { model.state.value.active.name == "Topic.md" && !model.state.value.active.portable }
        model.renameFolderEntry(Uri.parse(model.state.value.active.uri!!), "Notes/Topic.md", isDirectory = false, requested = "Overview")
        await { model.state.value.active.relative == "Notes/Overview.md" && model.state.value.files.any { it.name == "Overview.md" } }
        model.renameFolderEntry(DocumentsContract.buildDocumentUriUsingTree(treeUri, "root/Notes"), "Notes", isDirectory = true, requested = "Archive")
        val expectedUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, "root/Archive/Overview.md").toString()
        await { model.state.value.active.uri == expectedUri && model.state.value.folderRelative == "Archive" }
        assertEquals("Archive/Overview.md", model.state.value.active.relative)
        assertTrue(model.state.value.files.any { it.name == "Overview.md" && it.relative == "Archive/Overview.md" })
    }
}

private class MutationTreeProvider(private val ctx: Application, private val root: File, private val auth: String) : ContentProvider() {
    init { attachInfo(ctx, ProviderInfo().apply { authority = auth; exported = true; grantUriPermissions = true }) }
    override fun onCreate() = true
    private fun fileFor(id: String) = if (id == "root") root else File(root, id.removePrefix("root/"))
    private fun idFor(f: File) = if (f.canonicalPath == root.canonicalPath) "root" else "root/${f.relativeTo(root).invariantSeparatorsPath}"
    private fun mimeFor(f: File) = if (f.isDirectory) Document.MIME_TYPE_DIR else if (f.extension == "smd") "application/vnd.supermd.smd" else "text/markdown"
    private fun treeDoc(id: String) = DocumentsContract.buildDocumentUriUsingTree(DocumentsContract.buildTreeDocumentUri(auth, "root"), id).also {
        ctx.grantUriPermission(ctx.packageName, it, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PREFIX_URI_PERMISSION)
    }
    private fun addRow(c: MatrixCursor, f: File) {
        if (!f.exists()) throw FileNotFoundException(f.path)
        val flags = if (f.isDirectory) Document.FLAG_DIR_SUPPORTS_CREATE or Document.FLAG_SUPPORTS_RENAME else Document.FLAG_SUPPORTS_WRITE or Document.FLAG_SUPPORTS_RENAME
        c.addRow(c.columnNames.map { col -> when (col) {
            Document.COLUMN_DOCUMENT_ID -> idFor(f); Document.COLUMN_DISPLAY_NAME, "_display_name" -> if (f == root) "Workspace" else f.name
            Document.COLUMN_MIME_TYPE -> mimeFor(f); Document.COLUMN_SIZE, "_size" -> if (f.isFile) f.length() else 0L
            Document.COLUMN_LAST_MODIFIED -> f.lastModified(); Document.COLUMN_FLAGS -> flags; else -> null
        } }.toTypedArray<Any?>())
    }
    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor {
        val cols = projection ?: arrayOf(Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE, Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED, Document.COLUMN_FLAGS)
        if (uri.pathSegments.lastOrNull() == "children") return MatrixCursor(cols).also { c -> fileFor(Uri.decode(uri.pathSegments[uri.pathSegments.size - 2])).listFiles()?.forEach { addRow(c, it) } }
        return MatrixCursor(cols).also { addRow(it, fileFor(DocumentsContract.getDocumentId(uri))) }
    }
    override fun getType(uri: Uri) = runCatching { mimeFor(fileFor(DocumentsContract.getDocumentId(uri))) }.getOrDefault("application/octet-stream")
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0
    override fun call(method: String, arg: String?, extras: Bundle?): Bundle = Bundle().apply {
        val inEx = extras ?: Bundle.EMPTY; val docUri = inEx.getParcelable("uri", Uri::class.java)
        when (method) {
            "android:createDocument" -> { val t = File(fileFor(DocumentsContract.getDocumentId(docUri!!)), inEx.getString(Document.COLUMN_DISPLAY_NAME)!!); if (inEx.getString(Document.COLUMN_MIME_TYPE) == Document.MIME_TYPE_DIR) check(t.mkdirs()) else check(t.createNewFile()); putParcelable("uri", treeDoc(idFor(t))) }
            "android:renameDocument" -> { val s = fileFor(DocumentsContract.getDocumentId(docUri!!)); val d = File(s.parentFile, inEx.getString(Document.COLUMN_DISPLAY_NAME)!!); check(s.renameTo(d)); putParcelable("uri", treeDoc(idFor(d))) }
            "android:deleteDocument" -> fileFor(DocumentsContract.getDocumentId(docUri!!)).deleteRecursively()
            "android:isChildDocument" -> { val p = DocumentsContract.getDocumentId(docUri!!).trimEnd('/'); val c = DocumentsContract.getDocumentId(inEx.getParcelable("targetUri", Uri::class.java)!!); putBoolean("result", c == p || c.startsWith("$p/")) }
        }
    }
    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor = ParcelFileDescriptor.open(fileFor(DocumentsContract.getDocumentId(uri)), if (mode == "wt" || mode == "w") ParcelFileDescriptor.MODE_WRITE_ONLY or ParcelFileDescriptor.MODE_CREATE or ParcelFileDescriptor.MODE_TRUNCATE else ParcelFileDescriptor.parseMode(mode))
}
