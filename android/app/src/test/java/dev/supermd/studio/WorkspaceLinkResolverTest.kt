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
import android.provider.OpenableColumns
import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
import java.io.File
import java.nio.file.Files

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class WorkspaceLinkResolverTest {
    private lateinit var app: android.app.Application
    private lateinit var root: File
    private lateinit var authority: String
    private lateinit var provider: FakeTreeDocumentProvider
    private val viewModels = mutableListOf<ViewModelStore>()
    private val workspaceKeys = mutableListOf<String>()
    private var previousAutosave: Boolean? = null
    private var previousRecent: String? = null

    @Before
    fun setUp() {
        app = RuntimeEnvironment.getApplication()
        root = Files.createTempDirectory("workspace-link-test").toFile()
        authority = "dev.supermd.test.workspace.${System.nanoTime()}"
        File(root, "Index.md").writeText("# Index\n\nSee [[Sub Note#Deep Section]]\n")
        File(root, "Specs").mkdirs()
        File(root, "Specs/Sub Note.md").writeText("# Sub Note\n\n## Deep Section\n\nContent.\n")
        File(root, "Specs/Bundle.smd").writeText("# Plain text fallback smd\n")
        provider = FakeTreeDocumentProvider(root).also { it.attach(app, authority) }
        ShadowContentResolver.registerProviderInternal(authority, provider)
        val prefs = app.getSharedPreferences("studio", Context.MODE_PRIVATE)
        previousAutosave = prefs.getBoolean("autosave", true)
        previousRecent = prefs.getString("recent", null)
        prefs.edit().putBoolean("autosave", false).commit()
    }

    @After
    fun tearDown() {
        viewModels.forEach { it.clear() }
        app.getSharedPreferences("studio", Context.MODE_PRIVATE).edit().apply {
            putBoolean("autosave", previousAutosave ?: true)
            if (previousRecent == null) remove("recent") else putString("recent", previousRecent)
        }.commit()
        ShadowContentResolver.reset()
        root.deleteRecursively()
        workspaceKeys.forEach { File(app.filesDir, "workspaces/$it").deleteRecursively() }
    }

    @Test
    fun workspaceCacheRanksNestedWikilinksDeterministicallyWithoutWritingIndexFiles() {
        File(root, "Archive").mkdirs()
        File(root, "Archive/Topic.md").writeText("# Shallow Topic\n")
        File(root, "Specs/Deep").mkdirs()
        File(root, "Specs/Deep/topic.md").writeText("# Lowercase Same-Branch\n")
        File(root, "Specs/Sibling.smd").writeText("# Sibling SMD\n")
        File(root, "Archive/Sibling.md").writeText("# Other Dir MD\n")

        val treeUri = DocumentsContract.buildTreeDocumentUri(authority, "vault")
        val cache = WorkspaceLinkCache(lister = ContentResolverTreeLister(app), maxFiles = 20)

        assertEquals(
            "Specs/Sub Note.md",
            cache.resolve(treeUri, noteRelative = "Index.md", rawTarget = "Sub Note", wikilink = true).relative,
        )
        assertEquals(
            "Specs/Bundle.smd",
            cache.resolve(treeUri, noteRelative = "Index.md", rawTarget = "Bundle.smd", wikilink = true).relative,
        )
        // Exact case ("Topic") beats lowercase ("topic")
        assertEquals(
            "Archive/Topic.md",
            cache.resolve(treeUri, noteRelative = "Specs/Deep/Sub.md", rawTarget = "Topic", wikilink = true).relative,
        )
        // Same-directory ("Specs/Sibling.smd") beats other-directory ("Archive/Sibling.md") when case matches
        assertEquals(
            "Specs/Sibling.smd",
            cache.resolve(treeUri, noteRelative = "Specs/Sub Note.md", rawTarget = "Sibling", wikilink = true).relative,
        )
        // Zero hidden or index files written to disk
        assertTrue(root.walkTopDown().drop(1).none { it.name.startsWith(".") })
    }

    @Test
    fun standaloneWikilinkPromptsForFolderPermissionThenOpensTargetAndFocusesOpenTabsRetainingEdits() {
        val model = newModel()
        val standaloneIndexUri = DocumentsContract.buildDocumentUri(authority, "vault/Index.md")
        val subNoteUri = DocumentsContract.buildDocumentUri(authority, "vault/Specs/Sub Note.md")
        val treeUri = DocumentsContract.buildTreeDocumentUri(authority, "vault")
        grantReadWrite(standaloneIndexUri)
        grantReadWrite(subNoteUri)
        grantReadWrite(treeUri)

        model.open(standaloneIndexUri)
        await { model.state.value.tabs.any { it.uri == standaloneIndexUri.toString() } }
        val indexTab = model.state.value.tabs.single { it.uri == standaloneIndexUri.toString() }
        model.edit(indexTab.id, "# Index with unsaved edits\n")

        // Blocked targets fail containment upfront without prompting for folder access
        for (blocked in listOf("../outside.md", "Specs%2fSub Note.md", "bad%00.md", "diagram.png")) {
            val res = runBlocking {
                model.openWorkspaceLink(standaloneIndexUri.toString(), blocked, "", wikilink = false)
            }
            assertFalse("Expected blocked target $blocked to fail", res.getBoolean("opened"))
            assertFalse("Blocked target $blocked must not prompt for folder access", res.optBoolean("promptedFolderAccess"))
            assertNull(model.state.value.folderAccessPrompt)
        }
        for (blockedWikilink in listOf("../outside", "Specs%2fSub Note", "bad%00")) {
            val res = runBlocking {
                model.openWorkspaceLink(standaloneIndexUri.toString(), blockedWikilink, "", wikilink = true)
            }
            assertFalse("Expected blocked wikilink $blockedWikilink to fail", res.getBoolean("opened"))
            assertFalse("Blocked wikilink $blockedWikilink must not prompt for folder access", res.optBoolean("promptedFolderAccess"))
            assertNull(model.state.value.folderAccessPrompt)
        }

        // Nested wikilink from standalone note without tree grant prompts for folder permission
        val promptResult = runBlocking {
            model.openWorkspaceLink(standaloneIndexUri.toString(), "Sub Note", "Deep Section", wikilink = true)
        }
        assertFalse(promptResult.getBoolean("opened"))
        assertTrue(promptResult.optBoolean("promptedFolderAccess"))
        assertNotNull(model.state.value.folderAccessPrompt)
        assertTrue(shouldBlockNativeDrop(model.state.value.copy(welcomed = true, busy = false)))
        assertEquals("# Index with unsaved edits\n", model.state.value.tabs.single { it.id == indexTab.id }.content)

        // Granting folder permission resolves the nested wikilink, opens tab, sets pendingHeading, and updates recent
        app.contentResolver.takePersistableUriPermission(
            treeUri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
        )
        model.grantWorkspaceFolderForLink(treeUri)
        await {
            model.state.value.tabs.any { it.uri != null && sameDocument(Uri.parse(it.uri), subNoteUri) } &&
                model.state.value.folderAccessPrompt == null
        }
        assertFalse(shouldBlockNativeDrop(model.state.value.copy(welcomed = true, busy = false)))

        val subTab = model.state.value.tabs.single { it.uri != null && sameDocument(Uri.parse(it.uri), subNoteUri) }
        assertEquals(subTab.id, model.state.value.activeId)
        assertEquals("Deep Section", model.state.value.pendingHeading?.heading)
        assertEquals(subTab.id, model.state.value.pendingHeading?.noteId)
        assertTrue(sameDocument(Uri.parse(model.recent.value.first().uri), subNoteUri))
        assertEquals("# Index with unsaved edits\n", model.state.value.tabs.single { it.id == indexTab.id }.content)

        // Following ../Index.md back focuses the existing tab without duplicating it or clobbering its draft
        val tabCount = model.state.value.tabs.size
        val backResult = runBlocking {
            model.openWorkspaceLink(subTab.uri!!, "../Index.md", "", wikilink = false)
        }
        assertTrue(backResult.getBoolean("opened"))
        assertEquals(tabCount, model.state.value.tabs.size)
        assertEquals(indexTab.id, model.state.value.activeId)
        assertEquals("# Index with unsaved edits\n", model.state.value.active.content)
        assertTrue(sameDocument(Uri.parse(model.recent.value.first().uri), standaloneIndexUri))
    }

    private fun grantReadWrite(uri: Uri) {
        app.grantUriPermission(
            app.packageName,
            uri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
        )
    }

    private fun newModel(): StudioViewModel {
        val store = ViewModelStore().also(viewModels::add)
        val key = "workspace-link-${System.nanoTime()}".also(workspaceKeys::add)
        val model = StudioViewModel(app, key)
        model.readerFlushRequester = { true }
        store.put("model", model)
        return model
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

private class FakeTreeDocumentProvider(private val rootDir: File) : ContentProvider() {
    fun attach(context: Context, authority: String) {
        val info = ProviderInfo().apply {
            this.authority = authority
            exported = true
            grantUriPermissions = true
        }
        attachInfo(context, info)
    }

    override fun onCreate() = true

    private fun fileForDocId(docId: String): File {
        val rel = docId.removePrefix("vault").trimStart('/')
        return if (rel.isEmpty()) rootDir else File(rootDir, rel)
    }

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor {
        val pathSegments = uri.pathSegments
        if ("children" in pathSegments) {
            val childrenIdx = pathSegments.indexOf("children")
            val parentDocId = Uri.decode(pathSegments[childrenIdx - 1])
            val dir = fileForDocId(parentDocId)
            val cols = projection ?: arrayOf(
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_FLAGS,
            )
            return MatrixCursor(cols).apply {
                dir.listFiles()?.forEach { child ->
                    val childDocId = "$parentDocId/${child.name}"
                    val mime = if (child.isDirectory) DocumentsContract.Document.MIME_TYPE_DIR else "text/markdown"
                    addRow(
                        cols.map { col ->
                            when (col) {
                                DocumentsContract.Document.COLUMN_DOCUMENT_ID -> childDocId
                                DocumentsContract.Document.COLUMN_DISPLAY_NAME -> child.name
                                DocumentsContract.Document.COLUMN_MIME_TYPE -> mime
                                DocumentsContract.Document.COLUMN_FLAGS -> 0
                                else -> null
                            }
                        }.toTypedArray<Any?>(),
                    )
                }
            }
        }
        val docId = DocumentsContract.getDocumentId(uri)
        val file = fileForDocId(docId)
        val cols = projection ?: arrayOf(
            OpenableColumns.DISPLAY_NAME,
            OpenableColumns.SIZE,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
        )
        return MatrixCursor(cols).apply {
            if (file.exists()) {
                val mime = if (file.isDirectory) DocumentsContract.Document.MIME_TYPE_DIR else "text/markdown"
                addRow(
                    cols.map { col ->
                        when (col) {
                            DocumentsContract.Document.COLUMN_DOCUMENT_ID -> docId
                            OpenableColumns.DISPLAY_NAME, DocumentsContract.Document.COLUMN_DISPLAY_NAME -> file.name
                            OpenableColumns.SIZE, DocumentsContract.Document.COLUMN_SIZE -> file.length()
                            DocumentsContract.Document.COLUMN_MIME_TYPE -> mime
                            DocumentsContract.Document.COLUMN_FLAGS -> 0
                            else -> null
                        }
                    }.toTypedArray<Any?>(),
                )
            }
        }
    }

    override fun getType(uri: Uri): String {
        val file = runCatching { fileForDocId(DocumentsContract.getDocumentId(uri)) }.getOrNull()
        return if (file?.isDirectory == true) DocumentsContract.Document.MIME_TYPE_DIR else "text/markdown"
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        val file = fileForDocId(DocumentsContract.getDocumentId(uri))
        val flags = when (mode) {
            "r" -> ParcelFileDescriptor.MODE_READ_ONLY
            "rw" -> ParcelFileDescriptor.MODE_READ_WRITE
            "wt", "w" -> ParcelFileDescriptor.MODE_WRITE_ONLY or ParcelFileDescriptor.MODE_CREATE or ParcelFileDescriptor.MODE_TRUNCATE
            else -> throw java.io.FileNotFoundException("Unsupported mode: $mode")
        }
        return ParcelFileDescriptor.open(file, flags)
    }
}
