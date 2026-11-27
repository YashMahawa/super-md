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
import org.json.*
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import org.robolectric.*
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowContentResolver

@RunWith(RobolectricTestRunner::class) @Config(sdk = [35])
class SafWorkspaceCoordinatorTest {
    private lateinit var app: Application; private lateinit var rootDir: File; private lateinit var treeUri: Uri
    private val stores = mutableListOf<ViewModelStore>(); private val keys = mutableListOf<String>()

    @Before fun setUp() {
        app = RuntimeEnvironment.getApplication(); rootDir = Files.createTempDirectory("saf-workspace-test").toFile()
        val auth = "dev.supermd.test.safws.${UUID.randomUUID()}"
        ShadowContentResolver.registerProviderInternal(auth, WorkspaceTreeProvider(app, rootDir, auth))
        treeUri = DocumentsContract.buildTreeDocumentUri(auth, "root")
        app.grantUriPermission(app.packageName, treeUri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or Intent.FLAG_GRANT_PREFIX_URI_PERMISSION)
    }
    @After fun tearDown() {
        stores.forEach { it.clear() }; ShadowContentResolver.reset(); rootDir.deleteRecursively()
        app.getSharedPreferences("studio", 0).edit().remove("readingPositions").remove("linkedAssetGrants").remove("recent").commit()
        keys.forEach { k -> File(app.filesDir, "workspaces/$k.json").delete(); File(app.filesDir, "workspaces/$k").deleteRecursively(); app.deleteSharedPreferences("studio-window-$k") }
    }
    private fun newModel(key: String = "saf-ws-${UUID.randomUUID()}".also(keys::add)): StudioViewModel =
        StudioViewModel(app, key).also { it.readerFlushRequester = { true }; ViewModelStore().also(stores::add).put("vm", it) }
    private fun await(predicate: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 5_000L
        while (System.currentTimeMillis() < deadline && !predicate()) { shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(20)); Thread.sleep(10) }
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(20)); assertTrue("Condition timed out", predicate())
    }

    @Test fun listFolderRejectsInvalidPathRestoresNavigatesUpAndClosesCleanly() {
        File(rootDir, "Course/Week1").mkdirs(); File(rootDir, "Course/Week1/Notes.md").writeText("# Week 1\n")
        val key = "saf-nav-${UUID.randomUUID()}".also(keys::add); val model = newModel(key)
        model.setFolder(treeUri); await { model.state.value.folder == treeUri.toString() && model.state.value.files.any { it.name == "Course" } }
        model.listFolder(treeUri, "Course/Week1"); await { model.state.value.folderRelative == "Course/Week1" && model.state.value.files.any { it.name == "Notes.md" } }
        model.listFolder(treeUri, "../escape"); await { model.state.value.error == "Could not list folder: Invalid folder path" }
        assertEquals("Course/Week1", model.state.value.folderRelative)

        val restored = newModel(key); await { restored.state.value.folderRelative == "Course/Week1" && restored.state.value.files.any { it.name == "Notes.md" } }
        assertTrue(restored.navigateFolderUp()); await { restored.state.value.folderRelative == "Course" }
        assertTrue(restored.navigateFolderUp()); await { restored.state.value.folderRelative == "" }
        assertFalse(restored.navigateFolderUp())
        restored.documentAccess = DocumentAccess(object : ContextWrapper(app) {
            override fun checkUriPermission(uri: Uri?, pid: Int, uid: Int, modeFlags: Int) = android.content.pm.PackageManager.PERMISSION_DENIED
        })
        restored.listFolder(treeUri, ""); await { restored.state.value.error == "Could not list folder: Choose the folder again to restore access" }
        restored.closeFolder()
        assertNull(restored.state.value.folder); assertEquals("", restored.state.value.folderRelative); assertTrue(restored.state.value.files.isEmpty())
        assertNull(app.getSharedPreferences("studio-window-$key", 0).getString("folder", null)); assertFalse(restored.navigateFolderUp())
    }

    @Test fun applyUriRemapsUpdatesPersistedMetadataRecentsTabsAndSeededFindAcrossWindows() {
        File(rootDir, "Docs").mkdirs(); File(rootDir, "Docs/Guide.md").writeText("# Guide\nneedle\n")
        val primary = newModel(); val secondary = newModel()
        primary.setFolder(treeUri); secondary.setFolder(treeUri)
        await { primary.state.value.folder == treeUri.toString() && secondary.state.value.folder == treeUri.toString() }
        val oldUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, "root/Docs/Guide.md")
        primary.open(oldUri, "Docs/Guide.md"); secondary.open(oldUri, "Docs/Guide.md")
        await { primary.state.value.active.uri == oldUri.toString() && secondary.state.value.active.uri == oldUri.toString() }

        val prefs = app.getSharedPreferences("studio", 0)
        prefs.edit().putString("readingPositions", JSONObject().put(oldUri.toString(), JSONObject().put("top", 42.0).put("offset", 8.0).put("zoom", 100.0).put("mode", "live")).toString())
            .putString("linkedAssetGrants", JSONArray().put(JSONObject().put("document", oldUri.toString()).put("source", "fig.png").put("uri", "content://asset/1")).toString()).commit()
        val secTab = secondary.state.value.active; secondary.openFolderSearch("needle")
        secondary.openSearchMatch(FolderSearchMatch("k", secTab.id, secTab.uri, secTab.name, "Docs/Guide.md", 2, 1, "needle", 0, 6, dirty = false, isOpen = true))
        assertEquals(oldUri.toString(), secondary.seededFind.value?.targetUri)

        primary.renameFolderEntry(DocumentsContract.buildDocumentUriUsingTree(treeUri, "root/Docs"), "Docs", isDirectory = true, requested = "Handbook")
        val newUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, "root/Handbook/Guide.md").toString()
        await { primary.state.value.active.uri == newUri && secondary.state.value.active.uri == newUri }
        assertEquals("Handbook/Guide.md", secondary.state.value.active.relative)
        assertEquals(newUri, primary.recent.value.first { it.name == "Guide.md" }.uri); assertEquals(newUri, secondary.seededFind.value?.targetUri)
        val positions = JSONObject(prefs.getString("readingPositions", "{}")!!)
        assertFalse(positions.has(oldUri.toString())); assertEquals(42.0, positions.getJSONObject(newUri).getDouble("top"), 0.01)
        assertEquals(newUri, JSONArray(prefs.getString("linkedAssetGrants", "[]")!!).getJSONObject(0).getString("document"))
    }
}

private class WorkspaceTreeProvider(private val ctx: Application, private val root: File, private val auth: String) : ContentProvider() {
    init { attachInfo(ctx, ProviderInfo().apply { authority = auth; exported = true; grantUriPermissions = true }) }
    override fun onCreate() = true
    private fun fileFor(id: String) = if (id == "root") root else File(root, id.removePrefix("root/"))
    private fun idFor(f: File) = if (f.canonicalPath == root.canonicalPath) "root" else "root/${f.relativeTo(root).invariantSeparatorsPath}"
    private fun mimeFor(f: File) = if (f.isDirectory) Document.MIME_TYPE_DIR else "text/markdown"
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
        return if (uri.pathSegments.lastOrNull() == "children") MatrixCursor(cols).also { c -> fileFor(Uri.decode(uri.pathSegments[uri.pathSegments.size - 2])).listFiles()?.forEach { addRow(c, it) } }
        else MatrixCursor(cols).also { addRow(it, fileFor(DocumentsContract.getDocumentId(uri))) }
    }
    override fun getType(uri: Uri) = runCatching { mimeFor(fileFor(DocumentsContract.getDocumentId(uri))) }.getOrDefault("application/octet-stream")
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null; override fun delete(uri: Uri, s: String?, a: Array<out String>?) = 0; override fun update(uri: Uri, v: ContentValues?, s: String?, a: Array<out String>?) = 0
    override fun call(method: String, arg: String?, extras: Bundle?): Bundle = Bundle().apply {
        val inEx = extras ?: Bundle.EMPTY; val docUri = inEx.getParcelable("uri", Uri::class.java)
        if (method == "android:renameDocument") { val s = fileFor(DocumentsContract.getDocumentId(docUri!!)); val d = File(s.parentFile, inEx.getString(Document.COLUMN_DISPLAY_NAME)!!); check(s.renameTo(d)); putParcelable("uri", DocumentsContract.buildDocumentUriUsingTree(DocumentsContract.buildTreeDocumentUri(auth, "root"), idFor(d)).also { ctx.grantUriPermission(ctx.packageName, it, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PREFIX_URI_PERMISSION) }) }
        else if (method == "android:isChildDocument") { val p = DocumentsContract.getDocumentId(docUri!!).trimEnd('/'); val c = DocumentsContract.getDocumentId(inEx.getParcelable("targetUri", Uri::class.java)!!); putBoolean("result", c == p || c.startsWith("$p/")) }
    }
    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor = ParcelFileDescriptor.open(fileFor(DocumentsContract.getDocumentId(uri)), if (mode == "wt" || mode == "w") ParcelFileDescriptor.MODE_WRITE_ONLY or ParcelFileDescriptor.MODE_CREATE or ParcelFileDescriptor.MODE_TRUNCATE else ParcelFileDescriptor.parseMode(mode))
}
