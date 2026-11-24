package dev.supermd.studio

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.UriPermission
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
    fun readerUrlClassificationBlocksInternalAppAssetsAndAllowsExternalWebAndMailto() {
        assertEquals(
            ReaderUrlDecision.ALLOW_READER,
            classifyReaderNavigationUrl(
                Uri.parse("https://appassets.androidplatform.net/assets/web/android-reader.html"),
                isForMainFrame = true,
            ),
        )
        // Relative note links resolved against appassets.androidplatform.net must NEVER open a browser
        assertEquals(
            ReaderUrlDecision.BLOCK_INTERNAL,
            classifyReaderNavigationUrl(
                Uri.parse("https://appassets.androidplatform.net/assets/web/Other%20Note.md"),
                isForMainFrame = true,
            ),
        )
        assertEquals(
            ReaderUrlDecision.OPEN_EXTERNAL,
            classifyReaderNavigationUrl(Uri.parse("https://example.org/guide"), isForMainFrame = true),
        )
        assertEquals(
            ReaderUrlDecision.OPEN_EXTERNAL,
            classifyReaderNavigationUrl(Uri.parse("mailto:author@example.org"), isForMainFrame = true),
        )
        assertEquals(
            ReaderUrlDecision.BLOCK_INTERNAL,
            classifyReaderNavigationUrl(Uri.parse("javascript:alert(1)"), isForMainFrame = true),
        )
        assertEquals(
            ReaderUrlDecision.BLOCK_INTERNAL,
            classifyReaderNavigationUrl(Uri.parse("content://$authority/document/vault%2FIndex.md"), isForMainFrame = true),
        )
    }

    @Test
    fun lexicalPathAndBoundedCacheResolveNestedNotesAndRejectEscapesAndVirtualEntries() {
        assertEquals(
            listOf("Index.md"),
            workspaceRelativePathParts("Specs", "../Index.md"),
        )
        for (invalid in listOf("../Outside.md", "/etc/passwd", "Specs/%2e%2e/%2e%2e/Outside.md", "Specs%2fSub.md", "https://example.org/a.md")) {
            val failed = runCatching { workspaceRelativePathParts("", invalid) }.exceptionOrNull()
            assertTrue("Expected failure for $invalid", failed is WorkspaceLinkException)
        }

        val treeUri = DocumentsContract.buildTreeDocumentUri(authority, "vault")
        var now = 1_000L
        val cache = WorkspaceLinkCache(
            lister = ContentResolverTreeLister(app),
            maxFiles = 10,
            clock = { now },
        )

        val resolvedWiki = cache.resolve(treeUri, noteRelative = "Index.md", rawTarget = "Sub Note", wikilink = true)
        assertEquals("Specs/Sub Note.md", resolvedWiki.relative)

        val resolvedSmd = cache.resolve(treeUri, noteRelative = "Index.md", rawTarget = "Bundle.smd", wikilink = true)
        assertEquals("Specs/Bundle.smd", resolvedSmd.relative)

        val resolvedParent = cache.resolve(treeUri, noteRelative = "Specs/Sub Note.md", rawTarget = "../Index.md", wikilink = false)
        assertEquals("Index.md", resolvedParent.relative)

        // Zero index files written to disk
        assertEquals(
            setOf("Index.md", "Specs", "Sub Note.md", "Bundle.smd"),
            root.walkTopDown().drop(1).map { it.name }.toSet(),
        )
    }

    @Test
    fun standaloneNotePromptsForFolderPermissionThenOpensTargetTabRetainingEditsAndHeadingJump() {
        val model = newModel()
        val standaloneIndexUri = DocumentsContract.buildDocumentUri(authority, "vault/Index.md")
        val subNoteUri = DocumentsContract.buildDocumentUri(authority, "vault/Specs/Sub Note.md")
        val treeUri = DocumentsContract.buildTreeDocumentUri(authority, "vault")
        grantReadWrite(standaloneIndexUri)
        grantReadWrite(subNoteUri)
        grantReadWrite(treeUri)

        // 1. Unsaved draft clicking relative link gives clear non-destructive notice
        val draftId = model.state.value.active.id
        model.edit(draftId, "# Unsaved local draft")
        val draftResult = runBlocking {
            model.openWorkspaceLink(draftId, "./Specs/Sub Note.md", "Deep Section", wikilink = false)
        }
        assertFalse(draftResult.getBoolean("opened"))
        assertTrue(model.state.value.message.orEmpty().contains("Save this note first"))
        assertEquals("# Unsaved local draft", model.state.value.active.content)

        // 2. Open standalone file WITHOUT folder permission; edit it and follow a link -> prompts for folder access
        model.open(standaloneIndexUri)
        await { model.state.value.tabs.any { it.uri == standaloneIndexUri.toString() } }
        val indexTab = model.state.value.tabs.single { it.uri == standaloneIndexUri.toString() }
        model.edit(indexTab.id, "# Index with unsaved edits\n")

        val promptResult = runBlocking {
            model.openWorkspaceLink(standaloneIndexUri.toString(), "Sub Note", "Deep Section", wikilink = true)
        }
        assertFalse(promptResult.getBoolean("opened"))
        assertTrue(promptResult.optBoolean("promptedFolderAccess"))
        assertNotNull(model.state.value.folderAccessPrompt)
        assertEquals("# Index with unsaved edits\n", model.state.value.tabs.single { it.id == indexTab.id }.content)

        // 3. Grant folder permission via grantWorkspaceFolderForLink -> resolves link, opens tab, sets pendingHeading, updates recent
        grantReadWrite(treeUri)
        app.contentResolver.takePersistableUriPermission(
            treeUri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
        )
        model.grantWorkspaceFolderForLink(treeUri)
        await {
            model.state.value.tabs.any { it.uri != null && sameDocument(Uri.parse(it.uri), subNoteUri) } &&
                model.state.value.folderAccessPrompt == null
        }

        val subTab = model.state.value.tabs.single { it.uri != null && sameDocument(Uri.parse(it.uri), subNoteUri) }
        assertEquals(subTab.id, model.state.value.activeId)
        assertEquals("Deep Section", model.state.value.pendingHeading?.heading)
        assertEquals(subTab.id, model.state.value.pendingHeading?.noteId)
        assertTrue(sameDocument(Uri.parse(model.recent.value.first().uri), subNoteUri))
        // Previous tab's unsaved edits remain intact!
        assertEquals("# Index with unsaved edits\n", model.state.value.tabs.single { it.id == indexTab.id }.content)

        // 4. Following ../Index.md back focuses the existing tab without duplicating it or clobbering its draft
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

    @Test
    fun standaloneContainmentReaderBridgeBarrierLocalFileAndAlignedRankingWorkEndToEnd() {
        // 1. Desktop-aligned workspace ranking: exact case > same directory > shallower depth > extension priority
        File(root, "Archive").mkdirs()
        File(root, "Archive/Topic.md").writeText("# Shallow Topic\n")
        File(root, "Specs/Deep").mkdirs()
        File(root, "Specs/Deep/topic.md").writeText("# Lowercase Same-Branch\n")
        File(root, "Specs/Sibling.smd").writeText("# Sibling SMD\n")
        File(root, "Archive/Sibling.md").writeText("# Other Dir MD\n")

        val treeUri = DocumentsContract.buildTreeDocumentUri(authority, "vault")
        val cache = WorkspaceLinkCache(lister = ContentResolverTreeLister(app))
        // Exact case match ("Topic") beats lowercase ("topic")
        assertEquals(
            "Archive/Topic.md",
            cache.resolve(treeUri, noteRelative = "Specs/Deep/Sub.md", rawTarget = "Topic", wikilink = true).relative,
        )
        // Same-directory match ("Specs/Sibling.smd") beats other-directory match ("Archive/Sibling.md") when case matches
        assertEquals(
            "Specs/Sibling.smd",
            cache.resolve(treeUri, noteRelative = "Specs/Sub Note.md", rawTarget = "Sibling", wikilink = true).relative,
        )

        // 2. Standalone content:// note WITHOUT folder tree rejects ../, %2f, %00, and non-note extensions BEFORE prompting
        val model = newModel()
        val standaloneIndexUri = DocumentsContract.buildDocumentUri(authority, "vault/Index.md")
        grantReadWrite(standaloneIndexUri)
        model.open(standaloneIndexUri)
        await { model.state.value.tabs.any { it.uri == standaloneIndexUri.toString() } }

        for (blocked in listOf("../outside.md", "Specs%2fSub Note.md", "bad%00.md", "diagram.png")) {
            val res = runBlocking {
                model.openWorkspaceLink(standaloneIndexUri.toString(), blocked, "", wikilink = false)
            }
            assertFalse("Expected blocked target $blocked to fail", res.getBoolean("opened"))
            assertFalse("Blocked target $blocked must not prompt for folder access", res.optBoolean("promptedFolderAccess"))
            assertNull(model.state.value.folderAccessPrompt)
        }

        // 3. Local file:// note resolves sibling note cleanly and rejects symlink escapes
        val localIndex = Uri.fromFile(File(root, "Index.md"))
        model.open(localIndex)
        await { model.state.value.tabs.any { it.uri == localIndex.toString() } }
        val localRes = runBlocking {
            model.openWorkspaceLink(localIndex.toString(), "Specs/Sub Note.md", "Deep Section", wikilink = false)
        }
        assertTrue(localRes.getBoolean("opened"))
        assertEquals("Deep Section", model.state.value.pendingHeading?.heading)

        // 4. ReaderBridge routes open_workspace_link, flushes active reader via readerFlushRequester, and launches external URLs safely
        val flushedIds = mutableListOf<String>()
        model.readerFlushRequester = { id -> flushedIds.add(id); true }
        grantReadWrite(treeUri)
        app.contentResolver.takePersistableUriPermission(
            treeUri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
        )
        model.setFolder(treeUri)
        await { model.state.value.folder == treeUri.toString() }
        model.open(standaloneIndexUri)
        await { model.state.value.active.uri != null && sameDocument(Uri.parse(model.state.value.active.uri), standaloneIndexUri) }
        val activeBeforeBridge = model.state.value.active.id
        flushedIds.clear()

        val webView = object : android.webkit.WebView(app) {
            override fun post(action: Runnable?): Boolean =
                action?.let { android.os.Handler(Looper.getMainLooper()).post(it) } ?: false
        }
        val scope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.Main.immediate)
        try {
            configureReader(webView, model, scope, ready = {}, rendererGone = {})
            val bridge = webView.getTag(R.id.reader_bridge_tag) as ReaderBridge
            val client = shadowOf(webView).webViewClient

            // Internal appassets note navigation is blocked without launching an external browser
            shadowOf(app).clearNextStartedActivities()
            val internalReq = object : android.webkit.WebResourceRequest {
                override fun getUrl(): Uri = Uri.parse("https://appassets.androidplatform.net/assets/web/Specs/Sub%20Note.md")
                override fun isForMainFrame(): Boolean = true
                override fun isRedirect(): Boolean = false
                override fun hasGesture(): Boolean = true
                override fun getMethod(): String = "GET"
                override fun getRequestHeaders(): Map<String, String> = emptyMap()
            }
            assertTrue(client.shouldOverrideUrlLoading(webView, internalReq))
            assertNull(shadowOf(app).nextStartedActivity)

            // External https navigation launches ACTION_VIEW with FLAG_ACTIVITY_NEW_TASK on Application context
            val externalReq = object : android.webkit.WebResourceRequest {
                override fun getUrl(): Uri = Uri.parse("https://example.org/reference")
                override fun isForMainFrame(): Boolean = true
                override fun isRedirect(): Boolean = false
                override fun hasGesture(): Boolean = true
                override fun getMethod(): String = "GET"
                override fun getRequestHeaders(): Map<String, String> = emptyMap()
            }
            assertTrue(client.shouldOverrideUrlLoading(webView, externalReq))
            val started = shadowOf(app).nextStartedActivity
            assertNotNull(started)
            assertEquals(Intent.ACTION_VIEW, started.action)
            assertEquals(Uri.parse("https://example.org/reference"), started.data)
            assertTrue((started.flags and Intent.FLAG_ACTIVITY_NEW_TASK) != 0)

            // Bridge post("open_workspace_link") flushes reader edits before switching tabs
            bridge.post(
                "bridge-1",
                "open_workspace_link",
                org.json.JSONObject()
                    .put("documentPath", standaloneIndexUri.toString())
                    .put("target", "Sub Note")
                    .put("fragment", "Deep Section")
                    .put("wikilink", true)
                    .toString(),
            )
            await { model.state.value.active.name == "Sub Note.md" }
            assertTrue(flushedIds.contains(activeBeforeBridge))
            assertEquals("Deep Section", model.state.value.pendingHeading?.heading)
        } finally {
            retireAndDestroyReader(webView)
            scope.coroutineContext[kotlinx.coroutines.Job]?.cancel()
        }
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
        val isChildren = "children" in pathSegments
        if (isChildren) {
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
