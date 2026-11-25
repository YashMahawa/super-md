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
import android.webkit.WebResourceRequest
import android.webkit.WebView
import androidx.lifecycle.ViewModelStore
import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowContentResolver

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class RelativeNoteNavigationTest {
    private lateinit var app: android.app.Application
    private lateinit var root: File
    private lateinit var provider: RelativeNoteProvider
    private lateinit var authority: String
    private val workspaceKeys = mutableListOf<String>()
    private val viewModels = mutableListOf<ViewModelStore>()

    @Before fun setUp() {
        app = RuntimeEnvironment.getApplication()
        root = Files.createTempDirectory("relative-note-nav").toFile()
        authority = "dev.supermd.test.relative.${System.nanoTime()}"
        provider = RelativeNoteProvider(root).also { it.attach(app, authority) }
        ShadowContentResolver.registerProviderInternal(authority, provider)
        shadowOf(app).clearNextStartedActivities()
    }

    @After fun tearDown() {
        viewModels.forEach { it.clear() }
        ShadowContentResolver.reset()
        root.deleteRecursively()
        workspaceKeys.forEach { File(app.filesDir, "workspaces/$it").deleteRecursively() }
    }

    @Test fun readerUrlOverrideNeverLaunchesBrowserForAppAssetsUrls() {
        val web = attachedWebView()
        val model = newModel()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        configureReader(web, model, scope, ready = {}, rendererGone = {})
        val client = shadowOf(web).webViewClient
        shadowOf(app).clearNextStartedActivities()

        val readerRequest = fakeRequest("https://appassets.androidplatform.net/assets/web/android-reader.html", mainFrame = true)
        assertFalse(client.shouldOverrideUrlLoading(web, readerRequest))
        assertNull(shadowOf(app).nextStartedActivity)

        for (blockedUrl in listOf(
            "https://appassets.androidplatform.net/assets/web/Lecture%202.md",
            "https://appassets.androidplatform.net/assets/web/study.smd",
            "https://appassets.androidplatform.net/outside.md",
            "http://appassets.androidplatform.net/assets/web/Lecture%202.md",
        )) {
            assertTrue(client.shouldOverrideUrlLoading(web, fakeRequest(blockedUrl, mainFrame = true)))
            assertNull("Must never launch external browser for $blockedUrl", shadowOf(app).nextStartedActivity)
        }

        assertTrue(client.shouldOverrideUrlLoading(web, fakeRequest("https://example.org/reference", mainFrame = true)))
        val external = shadowOf(app).nextStartedActivity
        assertNotNull(external)
        assertEquals(Intent.ACTION_VIEW, external.action)
        assertEquals(Uri.parse("https://example.org/reference"), external.data)
    }

    @Test fun treeGrantedWorkspaceOpensRelativeNotesFlushesEditsAndAppliesOneShotPendingHeading() {
        val treeUri = DocumentsContract.buildTreeDocumentUri(authority, "course")
        val indexUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, "course/Index.md")
        val lectureUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, "course/Lecture 2.md")
        val deckUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, "course/sub/study.smd")

        for (uri in listOf(treeUri, indexUri, lectureUri, deckUri)) {
            grantReadWrite(uri)
        }

        var flushedIds = mutableListOf<String>()
        val model = newModel { activeId ->
            flushedIds += activeId
            true
        }
        model.open(indexUri)
        await { model.state.value.active.uri == indexUri.toString() }
        val indexId = model.state.value.active.id
        flushedIds.clear()

        val web = attachedWebView()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        configureReader(web, model, scope, ready = {}, rendererGone = {})
        val bridge = web.getTag(R.id.reader_bridge_tag) as ReaderBridge

        bridge.post("req-1", "open_workspace_link", JSONObject()
            .put("documentPath", indexUri.toString())
            .put("target", "Lecture 2")
            .put("fragment", "bayes")
            .put("wikilink", true)
            .toString())

        await { model.state.value.active.uri == lectureUri.toString() }
        assertEquals(listOf(indexId), flushedIds)
        val lectureNote = model.state.value.active
        val pendingJump = model.state.value.pendingHeading
        assertNotNull(pendingJump)
        assertEquals(lectureNote.id, pendingJump!!.noteId)
        assertEquals("bayes", pendingJump.heading)
        assertTrue(pendingJump.token.isNotBlank())
        model.consumePendingHeading(pendingJump.token)
        assertNull("pendingHeading must be consumed once", model.state.value.pendingHeading)

        val openedDeck = callSuspend { model.openWorkspaceLink(lectureUri.toString(), "sub/study.smd", "", wikilink = false) }
        assertTrue(openedDeck.getBoolean("opened"))
        await { model.state.value.active.uri == deckUri.toString() }
        assertEquals("# Study Deck\n", model.state.value.active.content)
        assertNull(shadowOf(app).nextStartedActivity)
    }

    @Test fun blocksTraversalEncodedSeparatorsAndUnsavedNotesWithSafeStatusNotices() {
        val treeUri = DocumentsContract.buildTreeDocumentUri(authority, "course")
        val indexUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, "course/Index.md")
        grantRead(treeUri)
        grantRead(indexUri)

        val model = newModel()
        // Unsaved default note surfaces a status notice.
        val unsavedId = model.state.value.active.id
        val unsavedReply = callSuspend { model.openWorkspaceLink(unsavedId, "Lecture%202.md", "", wikilink = false) }
        assertFalse(unsavedReply.getBoolean("opened"))
        assertEquals("Save this note before opening linked notes.", model.state.value.message)

        model.open(indexUri)
        await { model.state.value.active.uri == indexUri.toString() }

        for (blocked in listOf("../outside.md", "sub%2f..%2foutside.md", "sub%5cstudy.smd", "bad%00.md")) {
            val rejected = callSuspend { model.openWorkspaceLink(indexUri.toString(), blocked, "", wikilink = false) }
            assertFalse("Expected $blocked to fail containment", rejected.getBoolean("opened"))
            assertEquals(indexUri.toString(), model.state.value.active.uri)
            assertTrue(!model.state.value.message.isNullOrBlank())
        }
        assertNull(shadowOf(app).nextStartedActivity)
    }

    @Test fun singleFileWithoutFolderGrantPromptsForAccessWithoutLaunchingExternalBrowser() {
        val singleIndexUri = DocumentsContract.buildDocumentUri(authority, "course/Index.md")
        val ungrantedSiblingUri = DocumentsContract.buildDocumentUri(authority, "course/Lecture 2.md")
        grantRead(singleIndexUri)

        val model = newModel()
        model.open(singleIndexUri)
        await { model.state.value.active.uri == singleIndexUri.toString() }

        val reply = callSuspend { model.openWorkspaceLink(singleIndexUri.toString(), "Lecture%202.md", "bayes", wikilink = false) }
        assertFalse(reply.getBoolean("opened"))
        assertEquals(DOCUMENT_ACCESS_MESSAGE, model.state.value.message)
        val accessRequest = model.documentAccessRequests.value
        assertNotNull(accessRequest)
        assertEquals(ungrantedSiblingUri.toString(), accessRequest!!.uri)
        assertFalse(accessRequest.writing)
        assertNull(shadowOf(app).nextStartedActivity)
    }

    private fun attachedWebView(): WebView {
        val activity = Robolectric.buildActivity(android.app.Activity::class.java).setup().get()
        return WebView(activity).also { activity.setContentView(it) }
    }

    private fun grantRead(uri: Uri) {
        provider.grant(uri)
        app.grantUriPermission(app.packageName, uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }

    private fun grantReadWrite(uri: Uri) {
        provider.grant(uri)
        app.grantUriPermission(app.packageName, uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
    }

    private fun fakeRequest(rawUrl: String, mainFrame: Boolean): WebResourceRequest = object : WebResourceRequest {
        override fun getUrl(): Uri = Uri.parse(rawUrl)
        override fun isForMainFrame(): Boolean = mainFrame
        override fun isRedirect(): Boolean = false
        override fun hasGesture(): Boolean = true
        override fun getMethod(): String = "GET"
        override fun getRequestHeaders(): Map<String, String> = emptyMap()
    }

    private fun newModel(flush: suspend (String) -> Boolean = { true }): StudioViewModel {
        val store = ViewModelStore().also(viewModels::add)
        val key = "relative-note-${System.nanoTime()}".also(workspaceKeys::add)
        val model = StudioViewModel(app, key)
        model.readerFlushRequester = flush
        store.put("model", model)
        return model
    }

    private fun <T> callSuspend(block: suspend () -> T): T {
        var outcome: Result<T>? = null
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            outcome = runCatching { block() }
        }
        await { outcome != null }
        return outcome!!.getOrThrow()
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

private class RelativeNoteProvider(private val root: File) : ContentProvider() {
    private val grantedUris = mutableSetOf<String>()
    private val grantedTrees = mutableSetOf<String>()

    init {
        File(root, "outside.md").writeText("# Secret Outside\n")
        File(root, "course").mkdirs()
        File(root, "course/Index.md").writeText("# Index\n\n[[Lecture 2#Bayes]]\n")
        File(root, "course/Lecture 2.md").writeText("# Lecture 2\n\n## Bayes\n\nPosterior probability.\n")
        File(root, "course/sub").mkdirs()
        File(root, "course/sub/study.smd").writeText("# Study Deck\n")
    }

    fun grant(uri: Uri) {
        grantedUris += uri.toString()
        if (DocumentsContract.isTreeUri(uri)) {
            runCatching { DocumentsContract.getTreeDocumentId(uri) }.getOrNull()?.let { grantedTrees += it }
        }
    }

    private fun checkGranted(uri: Uri) {
        if (uri.toString() in grantedUris) return
        val docId = runCatching { DocumentsContract.getDocumentId(uri) }.getOrNull() ?: throw SecurityException("Denied: $uri")
        val coveredByTree = DocumentsContract.isTreeUri(uri) && grantedTrees.any { tree ->
            docId == tree || docId.startsWith("${tree.trimEnd('/')}/")
        }
        if (!coveredByTree) throw SecurityException("Permission Denial: reading $uri")
    }

    fun attach(context: Context, authority: String) {
        val info = ProviderInfo().apply { this.authority = authority; exported = true; grantUriPermissions = true }
        attachInfo(context, info)
    }

    override fun onCreate() = true

    private fun resolveFile(uri: Uri): File {
        val docId = DocumentsContract.getDocumentId(uri)
        return File(root, docId)
    }

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor {
        val segments = uri.pathSegments
        val childrenIndex = segments.indexOf("children")
        if (childrenIndex > 0) {
            checkGranted(uri)
            val parentId = segments[childrenIndex - 1]
            val dir = File(root, parentId)
            if (!dir.isDirectory) throw java.io.FileNotFoundException(uri.toString())
            val columns = projection?.toList() ?: listOf(
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
            )
            return MatrixCursor(columns.toTypedArray()).apply {
                dir.listFiles()?.sortedBy { it.name }?.forEach { child ->
                    val childId = "${parentId.trimEnd('/')}/${child.name}"
                    addRow(columns.map { col ->
                        when (col) {
                            DocumentsContract.Document.COLUMN_DOCUMENT_ID -> childId
                            DocumentsContract.Document.COLUMN_DISPLAY_NAME, OpenableColumns.DISPLAY_NAME -> child.name
                            DocumentsContract.Document.COLUMN_MIME_TYPE -> if (child.isDirectory) DocumentsContract.Document.MIME_TYPE_DIR else "text/markdown"
                            OpenableColumns.SIZE -> child.length()
                            else -> null
                        }
                    }.toTypedArray<Any?>())
                }
            }
        }
        val file = resolveFile(uri)
        if (!file.exists()) throw java.io.FileNotFoundException(uri.toString())
        val columns = projection?.toList() ?: listOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        return MatrixCursor(columns.toTypedArray()).apply {
            addRow(columns.map { col ->
                when (col) {
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID -> DocumentsContract.getDocumentId(uri)
                    OpenableColumns.DISPLAY_NAME -> file.name
                    OpenableColumns.SIZE -> file.length()
                    DocumentsContract.Document.COLUMN_MIME_TYPE -> if (file.isDirectory) DocumentsContract.Document.MIME_TYPE_DIR else "text/markdown"
                    else -> null
                }
            }.toTypedArray<Any?>())
        }
    }

    override fun getType(uri: Uri) = "text/markdown"
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        checkGranted(uri)
        val file = resolveFile(uri)
        if (!file.isFile) throw java.io.FileNotFoundException(uri.toString())
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
    }
}
