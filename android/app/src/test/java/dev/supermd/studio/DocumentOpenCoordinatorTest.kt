package dev.supermd.studio

import android.app.Application
import android.content.*
import android.content.pm.ProviderInfo
import android.database.MatrixCursor
import android.net.Uri
import android.os.*
import android.provider.*
import androidx.lifecycle.ViewModelStore
import java.io.File
import java.nio.file.Files
import java.time.Duration
import java.util.UUID
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import org.robolectric.*
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowContentResolver

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class DocumentOpenCoordinatorTest {
    private lateinit var app: Application
    private lateinit var tempDir: File
    private val stores = mutableListOf<ViewModelStore>()
    private val keys = mutableListOf<String>()

    @Before fun setUp() {
        app = RuntimeEnvironment.getApplication(); tempDir = Files.createTempDirectory("doc-open-coord").toFile()
        File(app.filesDir, "portable-assets").deleteRecursively(); app.getSharedPreferences("studio", 0).edit().putBoolean("autosave", false).commit()
    }

    @After fun tearDown() {
        stores.forEach { it.clear() }; ShadowContentResolver.reset(); tempDir.deleteRecursively(); File(app.filesDir, "portable-assets").deleteRecursively()
        app.getSharedPreferences("studio", 0).edit().clear().commit()
        keys.forEach { k -> File(app.filesDir, "workspaces/$k.json").delete(); File(app.filesDir, "workspaces/$k").deleteRecursively(); app.deleteSharedPreferences("studio-window-$k") }
    }

    private fun newModel(key: String = "doc-${UUID.randomUUID()}".also(keys::add)) = StudioViewModel(app, key).also {
        it.readerFlushStatusRequester = { ReaderFlushStatus.ACKNOWLEDGED }; ViewModelStore().also(stores::add).put("vm", it)
    }

    private fun await(p: () -> Boolean) {
        val d = System.currentTimeMillis() + 5_000L
        while (System.currentTimeMillis() < d && !p()) { shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(25)); Thread.sleep(10) }
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(25)); assertTrue(p())
    }

    private fun writeSmd(f: File, md: String) = MediaStorage(app).let { m ->
        f.outputStream().use { m.writeFmd(it, md, JSONObject().put("assets/dot.svg", m.portableImageData("image/svg+xml", "<svg xmlns='http://www.w3.org/2000/svg'/>".toByteArray()))) }
    }

    @Test fun openLoadsBomMarkdownAndPortableNotesAndDeduplicatesPreservingDrafts() {
        val model = newModel()
        val mdUri = Uri.fromFile(File(tempDir, "Guide.md").apply { writeText("\uFEFF# Guide\n\n## Intro\n") })
        val smdUri = Uri.fromFile(File(tempDir, "Bundle.smd").also { writeSmd(it, "# Bundle\n![dot](assets/dot.svg)\n") })
        model.open(mdUri, pendingHeading = "intro"); await { model.state.value.active.uri == mdUri.toString() }
        assertEquals("# Guide\n\n## Intro\n", model.state.value.active.content); assertEquals("intro", model.state.value.pendingHeading?.heading)
        val mdId = model.state.value.active.id.also { model.edit(it, "# Unsaved draft\n") }
        model.open(smdUri); await { model.state.value.active.uri == smdUri.toString() && model.state.value.active.portable }
        model.open(mdUri, pendingHeading = "updated"); await { model.state.value.activeId == mdId && model.state.value.pendingHeading?.heading == "updated" }
        assertEquals("# Unsaved draft\n", model.state.value.active.content); assertEquals(1, model.state.value.tabs.count { it.uri == mdUri.toString() })
    }

    @Test fun supersededConcurrentOpensRetainBackgroundTabsWithoutStealingActiveOrLeakingAssets() {
        val model = newModel()
        val bgSmd = Uri.fromFile(File(tempDir, "Bg.smd").also { writeSmd(it, "# Background\n") })
        val dupSmd = Uri.fromFile(File(tempDir, "Dup.smd").also { writeSmd(it, "# Duplicate\n") })
        val finalMd = Uri.fromFile(File(tempDir, "Final.md").apply { writeText("# Final\n") })
        val jobs = listOf(model.open(bgSmd), model.open(dupSmd), model.open(dupSmd), model.open(finalMd)); await { jobs.all { it.isCompleted } }
        assertEquals(finalMd.toString(), model.state.value.active.uri); assertTrue(model.state.value.tabs.any { it.uri == bgSmd.toString() })
        assertEquals(1, model.state.value.tabs.count { it.uri == dupSmd.toString() })
        val liveDirs = model.state.value.tabs.mapNotNull { it.assetDirectory }.toSet(); assertEquals(2, liveDirs.size)
        assertEquals(liveDirs, File(app.filesDir, "portable-assets").listFiles()?.map { it.name }?.toSet().orEmpty())
    }

    @Test fun grantWorkspaceFolderForLinkClearsPromptAndOpensRequestedTarget() {
        val auth = "dev.supermd.test.open.${System.nanoTime()}"; File(tempDir, "Index.md").writeText("# Index\n[[Sub/Target#sec]]\n")
        File(tempDir, "Sub").apply { mkdirs(); File(this, "Target.md").writeText("# Target\n## sec\n") }
        MiniTreeProvider(tempDir).also { it.attachInfo(app, ProviderInfo().apply { authority = auth; exported = true; grantUriPermissions = true }); ShadowContentResolver.registerProviderInternal(auth, it) }
        val indexUri = DocumentsContract.buildDocumentUri(auth, "vault/Index.md"); val targetUri = DocumentsContract.buildDocumentUri(auth, "vault/Sub/Target.md"); val treeUri = DocumentsContract.buildTreeDocumentUri(auth, "vault")
        val rw = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        listOf(indexUri, targetUri, treeUri).forEach { app.grantUriPermission(app.packageName, it, rw or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION) }
        val model = newModel().also { it.open(indexUri) }; await { model.state.value.active.uri == indexUri.toString() }
        assertTrue(runBlocking { model.openWorkspaceLink(indexUri.toString(), "Target", "sec", wikilink = true) }.optBoolean("promptedFolderAccess"))
        app.contentResolver.takePersistableUriPermission(treeUri, rw); model.grantWorkspaceFolderForLink(treeUri)
        await { model.state.value.folderAccessPrompt == null && sameDocument(Uri.parse(model.state.value.active.uri ?: ""), targetUri) }
        assertEquals("sec", model.state.value.pendingHeading?.heading)
    }
}

private class MiniTreeProvider(private val root: File) : ContentProvider() {
    override fun onCreate() = true
    private fun fileFor(id: String) = id.removePrefix("vault").trimStart('/').let { if (it.isEmpty()) root else File(root, it) }
    override fun query(uri: Uri, projection: Array<out String>?, s: String?, a: Array<out String>?, o: String?) =
        (projection ?: arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_FLAGS)).let { cols ->
            MatrixCursor(cols).apply {
                val segs = uri.pathSegments
                if ("children" in segs) Uri.decode(segs[segs.indexOf("children") - 1]).let { p -> fileFor(p).listFiles()?.forEach { f -> addRow(cols.map { rowVal(it, "$p/${f.name}", f) }.toTypedArray()) } }
                else DocumentsContract.getDocumentId(uri).let { id -> fileFor(id).takeIf(File::exists)?.let { f -> addRow(cols.map { rowVal(it, id, f) }.toTypedArray()) } }
            }
        }
    private fun rowVal(col: String, id: String, f: File): Any? = when (col) {
        DocumentsContract.Document.COLUMN_DOCUMENT_ID -> id; OpenableColumns.DISPLAY_NAME, DocumentsContract.Document.COLUMN_DISPLAY_NAME -> f.name
        OpenableColumns.SIZE, DocumentsContract.Document.COLUMN_SIZE -> f.length(); DocumentsContract.Document.COLUMN_MIME_TYPE -> if (f.isDirectory) DocumentsContract.Document.MIME_TYPE_DIR else "text/markdown"
        DocumentsContract.Document.COLUMN_FLAGS -> 0; else -> null
    }
    override fun getType(uri: Uri) = "text/markdown"; override fun insert(u: Uri, v: ContentValues?): Uri? = null
    override fun delete(u: Uri, s: String?, a: Array<out String>?) = 0; override fun update(u: Uri, v: ContentValues?, s: String?, a: Array<out String>?) = 0
    override fun openFile(uri: Uri, mode: String) = ParcelFileDescriptor.open(fileFor(DocumentsContract.getDocumentId(uri)), if (mode == "r") ParcelFileDescriptor.MODE_READ_ONLY else ParcelFileDescriptor.MODE_READ_WRITE)
}
