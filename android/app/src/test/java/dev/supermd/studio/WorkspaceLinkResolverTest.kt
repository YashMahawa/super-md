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
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import java.util.concurrent.atomic.AtomicReference
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
        // Case-folded wikilinks and subpath links resolve to exact on-disk casing
        assertEquals(
            "Specs/Sub Note.md",
            cache.resolve(treeUri, noteRelative = "Index.md", rawTarget = "sub note", wikilink = true).relative,
        )
        assertEquals(
            "Specs/Bundle.smd",
            cache.resolve(treeUri, noteRelative = "Index.md", rawTarget = "specs/bundle.smd", wikilink = true).relative,
        )
        assertEquals(
            "Specs/Sub Note.md",
            cache.resolve(treeUri, noteRelative = "specs/bundle.smd", rawTarget = "./sub%20note.md", wikilink = false).relative,
        )
        // Exact case ("Topic") beats lowercase ("topic")
        assertEquals(
            "Archive/Topic.md",
            cache.resolve(treeUri, noteRelative = "Specs/Deep/Sub.md", rawTarget = "Topic", wikilink = true).relative,
        )
        // Same-directory ("Specs/Sibling.smd") beats other-directory ("Archive/Sibling.md") even when noteRelative folder casing differs
        assertEquals(
            "Specs/Sibling.smd",
            cache.resolve(treeUri, noteRelative = "specs/Sub Note.md", rawTarget = "Sibling", wikilink = true).relative,
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

        // Even after closing the folder sidebar (state.folder == null), a persisted SAF workspace grant
        // resolves case-folded nested wikilinks from a standalone note URI without re-prompting.
        model.closeFolder()
        assertNull(model.state.value.folder)
        val grantedLookupResult = runBlocking {
            model.openWorkspaceLink(standaloneIndexUri.toString(), "sub note", "Deep Section", wikilink = true)
        }
        assertTrue(grantedLookupResult.getBoolean("opened"))
        assertFalse(grantedLookupResult.optBoolean("promptedFolderAccess"))
        assertNull(model.state.value.folderAccessPrompt)
        assertEquals(subTab.id, model.state.value.activeId)
        assertEquals("Deep Section", model.state.value.pendingHeading?.heading)
    }

    @Test
    fun stagedOpenTabAndLocalPathProbesSkipFullTreeScanAndAvoidDuplicateStreamOpens() {
        // Build a 24-note + 240-PNG workspace to verify local/open-tab probes avoid full scans and duplicate opens.
        // Fixture already has 3 notes (Index.md, Specs/Sub Note.md, Specs/Bundle.smd); add 21 more across 7 folders.
        for (i in 0 until 21) {
            val section = File(root, "Section%02d".format(i % 7)).apply { mkdirs() }
            File(section, "Note%02d.md".format(i)).writeText("# Note $i\n")
        }
        val assetsDir = File(root, "assets").apply { mkdirs() }
        for (i in 0 until 240) {
            File(assetsDir, "img_%03d.png".format(i)).writeBytes(byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47))
        }

        val model = newModel()
        val treeUri = DocumentsContract.buildTreeDocumentUri(authority, "vault")
        grantTreeReadWrite(treeUri)
        val indexTreeDocUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, "vault/Index.md")
        val subTreeDocUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, "vault/Specs/Sub Note.md")

        model.setFolder(treeUri)
        await { model.state.value.folder == treeUri.toString() }
        model.open(indexTreeDocUri)
        await { model.state.value.tabs.any { it.uri != null && sameDocument(Uri.parse(it.uri), indexTreeDocUri) } }
        val indexTab = model.state.value.tabs.single { it.uri != null && sameDocument(Uri.parse(it.uri), indexTreeDocUri) }
        model.edit(indexTab.id, "# Dirty Index Draft\n")

        // Stage 1B (cold wikilink subpath to unopened note): queries only root + Specs, 0 asset/unrelated folder queries, 1 stream open.
        model.workspaceLinks.invalidate()
        provider.resetTelemetry()
        val coldSubOpen = callSuspend {
            model.openWorkspaceLink(indexTab.uri!!, "Specs/Sub Note", "Deep Section", wikilink = true)
        }
        assertTrue(coldSubOpen.getBoolean("opened"))
        assertEquals(setOf("vault", "vault/Specs"), provider.childDirectoryQueries.toSet())
        assertFalse(provider.childDirectoryQueries.any { it.contains("assets") || it.contains("Section") })
        assertEquals(listOf("vault/Specs/Sub Note.md"), provider.openedDocumentIds.toList())
        val subTab = model.state.value.tabs.single { it.uri != null && sameDocument(Uri.parse(it.uri), subTreeDocUri) }
        assertEquals(subTab.id, model.state.value.activeId)

        // Stage 1A (explicit relative to open tab): 0 child-directory queries, 1 stream open, dirty draft preserved.
        model.workspaceLinks.invalidate()
        provider.resetTelemetry()
        val backToIndex = callSuspend {
            model.openWorkspaceLink(subTab.uri!!, "../Index.md", "", wikilink = false)
        }
        assertTrue(backToIndex.getBoolean("opened"))
        assertEquals(emptyList<String>(), provider.childDirectoryQueries.toList())
        assertEquals(listOf("vault/Index.md"), provider.openedDocumentIds.toList())
        assertEquals(indexTab.id, model.state.value.activeId)
        assertEquals("# Dirty Index Draft\n", model.state.value.active.content)

        // Stage 1A (wikilink subpath to confirmed open tab): 0 child-directory queries, 1 stream open.
        model.workspaceLinks.invalidate()
        provider.resetTelemetry()
        val jumpToOpenSub = callSuspend {
            model.openWorkspaceLink(indexTab.uri!!, "Specs/Sub Note", "Deep Section", wikilink = true)
        }
        assertTrue(jumpToOpenSub.getBoolean("opened"))
        assertEquals(emptyList<String>(), provider.childDirectoryQueries.toList())
        assertEquals(listOf("vault/Specs/Sub Note.md"), provider.openedDocumentIds.toList())
        assertEquals(subTab.id, model.state.value.activeId)

        // Stage 1B (local sibling wikilink to unopened .smd): queries only root + Specs, 0 asset/unrelated folder queries, 1 stream open.
        model.workspaceLinks.invalidate()
        provider.resetTelemetry()
        val siblingBundle = callSuspend {
            model.openWorkspaceLink(subTab.uri!!, "Bundle", "", wikilink = true)
        }
        assertTrue(siblingBundle.getBoolean("opened"))
        assertEquals(setOf("vault", "vault/Specs"), provider.childDirectoryQueries.toSet())
        assertFalse(provider.childDirectoryQueries.any { it.contains("assets") || it.contains("Section") })
        assertEquals(listOf("vault/Specs/Bundle.smd"), provider.openedDocumentIds.toList())
    }

    @Test
    fun stagedProbesPreserveExactCasePriorityOverFoldedSiblingAndOpenTabsAcrossAllModes() {
        File(root, "Archive").mkdirs()
        File(root, "Archive/Topic.md").writeText("# Exact Archive Topic\n")
        File(root, "Specs/Deep").mkdirs()
        File(root, "Specs/Deep/Sub.md").writeText("# Sub\n")
        File(root, "Specs/Deep/topic.md").writeText("# Folded Sibling Topic\n")

        val model = newModel()
        val treeUri = DocumentsContract.buildTreeDocumentUri(authority, "vault")
        grantTreeReadWrite(treeUri)
        model.setFolder(treeUri)
        await { model.state.value.folder == treeUri.toString() }

        val subUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, "vault/Specs/Deep/Sub.md")
        val foldedSiblingUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, "vault/Specs/Deep/topic.md")
        val exactArchiveUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, "vault/Archive/Topic.md")

        // Even when folded sibling `Specs/Deep/topic.md` is ALREADY open with dirty edits, `[[Topic]]` from
        // `Specs/Deep/Sub.md` must skip the folded sibling in Stage 1A/1B and open exact-case `Archive/Topic.md`.
        model.open(foldedSiblingUri)
        await { model.state.value.tabs.any { it.uri != null && sameDocument(Uri.parse(it.uri), foldedSiblingUri) } }
        val foldedTab = model.state.value.tabs.single { it.uri != null && sameDocument(Uri.parse(it.uri), foldedSiblingUri) }
        model.edit(foldedTab.id, "# Dirty Folded Sibling\n")

        model.open(subUri)
        await { model.state.value.tabs.any { it.uri != null && sameDocument(Uri.parse(it.uri), subUri) } }
        val subTab = model.state.value.tabs.single { it.uri != null && sameDocument(Uri.parse(it.uri), subUri) }

        provider.resetTelemetry()
        val nestedExactRes = callSuspend {
            model.openWorkspaceLink(subTab.uri!!, "Topic", "", wikilink = true)
        }
        assertTrue(nestedExactRes.getBoolean("opened"))
        assertTrue(sameDocument(Uri.parse(model.state.value.active.uri!!), exactArchiveUri))
        assertEquals(listOf("vault/Archive/Topic.md"), provider.openedDocumentIds.toList())
        assertEquals("# Dirty Folded Sibling\n", model.state.value.tabs.single { it.id == foldedTab.id }.content)

        // When exact-case `Specs/Deep/Topic.smd` coexists with folded `Specs/Deep/topic.md` in the same folder,
        // both explicit relative `./Topic` and wikilink `[[Topic]]` prefer `Topic.smd` over `topic.md` without scanning Archive.
        File(root, "Specs/Deep/Topic.smd").writeText("# Exact Sibling SMD\n")
        val exactSiblingSmdUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, "vault/Specs/Deep/Topic.smd")

        provider.resetTelemetry()
        val explicitExactRes = callSuspend {
            model.openWorkspaceLink(subTab.uri!!, "./Topic", "", wikilink = false)
        }
        assertTrue(explicitExactRes.getBoolean("opened"))
        assertTrue(sameDocument(Uri.parse(model.state.value.active.uri!!), exactSiblingSmdUri))
        assertFalse(provider.childDirectoryQueries.contains("vault/Archive"))
        assertEquals(listOf("vault/Specs/Deep/Topic.smd"), provider.openedDocumentIds.toList())

        // Verify `file://` local resolution also prioritizes exact-case `Topic.smd` over folded `topic.md`,
        // while still supporting case-folded fallback when no exact-case match exists.
        assertEquals(
            "Topic.smd",
            resolveLocalFileWorkspaceLink(
                sourceUri = Uri.fromFile(File(root, "Specs/Deep/Sub.md")),
                rawTarget = "./Topic",
                wikilink = false,
            )?.relative,
        )
        assertEquals(
            "Sub Note.md",
            resolveLocalFileWorkspaceLink(
                sourceUri = Uri.fromFile(File(root, "Specs/Bundle.smd")),
                rawTarget = "./sub%20note.md",
                wikilink = false,
            )?.relative,
        )
    }

    @Test
    fun realDirectoryMutationsStayImmediatelyVisibleWithinCacheTtlAndScanBoundsHold() {
        File(root, "Archive").mkdirs()
        File(root, "Archive/Initial.md").writeText("# Initial\n")

        val model = newModel()
        val treeUri = DocumentsContract.buildTreeDocumentUri(authority, "vault")
        grantTreeReadWrite(treeUri)
        model.setFolder(treeUri)
        await { model.state.value.folder == treeUri.toString() }

        val indexUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, "vault/Index.md")
        val subUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, "vault/Specs/Sub Note.md")
        model.open(indexUri)
        await { model.state.value.tabs.any { it.uri != null && sameDocument(Uri.parse(it.uri), indexUri) } }
        val indexTab = model.state.value.tabs.single { it.uri != null && sameDocument(Uri.parse(it.uri), indexUri) }
        model.open(subUri)
        await { model.state.value.tabs.any { it.uri != null && sameDocument(Uri.parse(it.uri), subUri) } }
        val subTab = model.state.value.tabs.single { it.uri != null && sameDocument(Uri.parse(it.uri), subUri) }

        // Populate the 5s WorkspaceLinkCache with a nested lookup.
        val warmRes = callSuspend {
            model.openWorkspaceLink(indexTab.uri!!, "Initial", "", wikilink = true)
        }
        assertTrue(warmRes.getBoolean("opened"))

        // Without invalidating workspaceLinks, add a new sibling note and a new nested note on disk.
        File(root, "Specs/FreshSibling.md").writeText("# Fresh Sibling\n")
        File(root, "Archive/FreshNested.md").writeText("# Fresh Nested\n")

        provider.resetTelemetry()
        val siblingRes = callSuspend {
            model.openWorkspaceLink(subTab.uri!!, "FreshSibling", "", wikilink = true)
        }
        assertTrue(siblingRes.getBoolean("opened"))
        assertEquals(listOf("vault/Specs/FreshSibling.md"), provider.openedDocumentIds.toList())

        provider.resetTelemetry()
        val nestedRes = callSuspend {
            model.openWorkspaceLink(indexTab.uri!!, "FreshNested", "", wikilink = true)
        }
        assertTrue(nestedRes.getBoolean("opened"))
        assertEquals(listOf("vault/Archive/FreshNested.md"), provider.openedDocumentIds.toList())

        // Rename/delete a cached nested note on disk within TTL: stale target fails cleanly and renamed target resolves.
        File(root, "Archive/Initial.md").renameTo(File(root, "Archive/RenamedInitial.md"))
        model.close(model.state.value.tabs.single { it.name == "Initial.md" }.id)
        await { model.state.value.tabs.none { it.name == "Initial.md" } }

        val deletedRes = callSuspend {
            model.openWorkspaceLink(indexTab.uri!!, "Initial", "", wikilink = true)
        }
        assertFalse(deletedRes.getBoolean("opened"))

        val renamedRes = callSuspend {
            model.openWorkspaceLink(indexTab.uri!!, "RenamedInitial", "", wikilink = true)
        }
        assertTrue(renamedRes.getBoolean("opened"))
        assertEquals("RenamedInitial.md", model.state.value.active.name)

        // Verify WorkspaceLinkCache scan bounds (maxFiles, maxDirectories, maxDepth) remain strictly enforced.
        File(root, "Specs/TooDeep/Level3").mkdirs()
        File(root, "Specs/TooDeep/Level3/HiddenByDepth.md").writeText("# Deep\n")
        val boundedCache = WorkspaceLinkCache(
            lister = ContentResolverTreeLister(app),
            maxFiles = 3,
            maxDirectories = 3,
            maxDepth = 1,
        )
        val boundedBatch = boundedCache.resolveCandidatesBatch(
            treeUri = treeUri,
            noteRelative = "Index.md",
            rawTarget = "HiddenByDepth",
            wikilink = true,
        )
        assertTrue(boundedBatch.candidates.isEmpty())
    }

    private fun grantTreeReadWrite(treeUri: Uri) {
        grantReadWrite(treeUri)
        app.contentResolver.takePersistableUriPermission(
            treeUri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
        )
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

    private fun <T> callSuspend(block: suspend () -> T): T {
        val outcome = AtomicReference<Result<T>?>()
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            outcome.set(runCatching { block() })
        }
        await { outcome.get() != null }
        return outcome.get()!!.getOrThrow()
    }

    private fun await(timeoutMs: Long = 15_000, condition: () -> Boolean) {
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
    val childDirectoryQueries: MutableList<String> = java.util.Collections.synchronizedList(mutableListOf())
    val openedDocumentIds: MutableList<String> = java.util.Collections.synchronizedList(mutableListOf())

    fun resetTelemetry() {
        childDirectoryQueries.clear()
        openedDocumentIds.clear()
    }

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

    private fun mimeForFile(file: File): String = when {
        file.isDirectory -> DocumentsContract.Document.MIME_TYPE_DIR
        file.extension.equals("png", ignoreCase = true) -> "image/png"
        else -> "text/markdown"
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
            childDirectoryQueries += parentDocId
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
                    val mime = mimeForFile(child)
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
                val mime = mimeForFile(file)
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
        val file = runCatching { fileForDocId(DocumentsContract.getDocumentId(uri)) }.getOrNull() ?: return "text/markdown"
        return mimeForFile(file)
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        val docId = DocumentsContract.getDocumentId(uri)
        if (mode == "r") {
            openedDocumentIds += docId
        }
        val file = fileForDocId(docId)
        val flags = when (mode) {
            "r" -> ParcelFileDescriptor.MODE_READ_ONLY
            "rw" -> ParcelFileDescriptor.MODE_READ_WRITE
            "wt", "w" -> ParcelFileDescriptor.MODE_WRITE_ONLY or ParcelFileDescriptor.MODE_CREATE or ParcelFileDescriptor.MODE_TRUNCATE
            else -> throw java.io.FileNotFoundException("Unsupported mode: $mode")
        }
        return ParcelFileDescriptor.open(file, flags)
    }
}
