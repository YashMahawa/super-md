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
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import androidx.lifecycle.ViewModelStore
import java.io.File
import java.io.FileNotFoundException
import java.nio.file.Files
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
class SafChildProjectionTest {
    private lateinit var baseApp: Application
    private lateinit var app: PermissionEnforcingApplication
    private lateinit var tempDir: File
    private lateinit var authority: String
    private lateinit var treeUri: Uri
    private lateinit var provider: CountingSafDocumentProvider
    private var previousAutosave: Boolean? = null
    private var previousRecent: String? = null
    private val workspaceKeys = mutableListOf<String>()
    private val viewModels = mutableListOf<ViewModelStore>()

    @Before
    fun setUp() {
        baseApp = RuntimeEnvironment.getApplication()
        app = PermissionEnforcingApplication(baseApp)
        tempDir = Files.createTempDirectory("saf-child-projection-test").toFile()
        authority = EXTERNAL_STORAGE_DOCUMENTS_AUTHORITY
        provider = CountingSafDocumentProvider(tempDir).also { it.attach(app, authority) }
        ShadowContentResolver.registerProviderInternal(authority, provider)
        treeUri = DocumentsContract.buildTreeDocumentUri(authority, "primary:vault")
        val grantFlags = Intent.FLAG_GRANT_READ_URI_PERMISSION or
            Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
            Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
        app.grantUriPermission(app.packageName, treeUri, grantFlags)
        app.contentResolver.takePersistableUriPermission(
            treeUri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
        )

        val prefs = app.getSharedPreferences("studio", Context.MODE_PRIVATE)
        previousAutosave = prefs.getBoolean("autosave", true)
        previousRecent = prefs.getString("recent", null)
        prefs.edit().putBoolean("autosave", false).remove("recent").commit()
    }

    @After
    fun tearDown() {
        viewModels.forEach { it.clear() }
        app.getSharedPreferences("studio", Context.MODE_PRIVATE).edit().apply {
            putBoolean("autosave", previousAutosave ?: true)
            if (previousRecent == null) remove("recent") else putString("recent", previousRecent)
        }.commit()
        ShadowContentResolver.reset()
        tempDir.deleteRecursively()
        workspaceKeys.forEach { key ->
            File(app.filesDir, "workspaces/$key.json").delete()
            File(app.filesDir, "workspaces/$key").deleteRecursively()
            File(app.filesDir, "deleted-drafts/$key").deleteRecursively()
            app.deleteSharedPreferences("studio-window-$key")
        }
    }

    @Test
    fun listFolderQueriesOncePerDirectoryLevelPreservesSubfolderStateAndFallsBackToSurvivingAncestor() {
        val model = newModel()
        provider.resetCounts()

        model.setFolder(treeUri)
        await { model.state.value.files.isNotEmpty() }

        val rootEntries = model.state.value.files
        // 1 directory ("Course") + 50 supported notes (.md, .txt, .smd, .markdown, .fmd)
        assertEquals(51, rootEntries.size)
        assertTrue(rootEntries.first().directory)
        assertEquals("Course", rootEntries.first().name)
        assertTrue("Supported .txt notes must be listed", rootEntries.any { it.name == "1.2 Linear Algebra.txt" })
        assertFalse("Hidden dotfiles must be excluded", rootEntries.any { it.name.startsWith('.') })
        assertFalse("Virtual SAF documents must be excluded", rootEntries.any { it.name == "VirtualShortcut.md" })
        assertFalse("Extensionless 'md' file must be excluded", rootEntries.any { it.name == "md" })
        assertFalse("Extensionless 'txt' file must be excluded", rootEntries.any { it.name == "txt" })
        assertFalse("Non-note binary assets must be excluded", rootEntries.any { it.name.endsWith(".png") })
        assertEquals(
            "Listing a 65-entry root folder must issue exactly 1 child-projection query instead of per-child DocumentFile queries",
            1,
            provider.totalQueryCalls.get(),
        )
        assertEquals(1, provider.childQueryCount("primary:vault"))
        assertEquals(0, provider.singleDocQueryCalls.get())

        provider.resetCounts()
        model.listFolder(treeUri, "Course/Week1")
        await { model.state.value.folderRelative == "Course/Week1" && model.state.value.files.size == 15 && model.state.value.files.first().relative.startsWith("Course/Week1/") }

        assertEquals(
            "Listing a 2-level nested folder must issue 1 child-projection query per level (root + Course + Week1 = 3)",
            3,
            provider.totalQueryCalls.get(),
        )
        assertEquals(1, provider.childQueryCount("primary:vault"))
        assertEquals(1, provider.childQueryCount("primary:vault/Course"))
        assertEquals(1, provider.childQueryCount("primary:vault/Course/Week1"))
        assertEquals(0, provider.singleDocQueryCalls.get())

        // Stored subfolder state restores across ViewModel recreation using stateless child projection (3 queries).
        provider.resetCounts()
        val recreated = newModel(model.workspaceKey)
        assertEquals("Course/Week1", recreated.state.value.folderRelative)
        await { recreated.state.value.files.size == 15 && recreated.state.value.files.first().relative.startsWith("Course/Week1/") }
        assertEquals(3, provider.totalQueryCalls.get())
        assertEquals(0, provider.singleDocQueryCalls.get())

        // Stateless projection: adding a file externally appears on the next listFolder without cache invalidation.
        provider.putFile("primary:vault/Course/Week1/Lecture-16.md", "primary:vault/Course/Week1", "Lecture-16.md", "# Lecture 16\n")
        provider.resetCounts()
        recreated.listFolder(treeUri, "Course/Week1")
        await { recreated.state.value.files.any { it.name == "Lecture-16.md" } }
        assertEquals(3, provider.totalQueryCalls.get())

        // Deleting the active nested subfolder falls back to the nearest surviving ancestor ("Course") in 2 queries.
        provider.removeSubtree("primary:vault/Course/Week1")
        provider.resetCounts()
        recreated.refreshMetadata()
        await {
            recreated.state.value.folderRelative == "Course" &&
                recreated.state.value.files.map { it.name } == listOf("Syllabus.md")
        }
        assertEquals(2, provider.totalQueryCalls.get())
        assertEquals(1, provider.childQueryCount("primary:vault"))
        assertEquals(1, provider.childQueryCount("primary:vault/Course"))
        assertEquals(0, provider.childQueryCount("primary:vault/Course/Week1"))
        assertEquals(0, provider.singleDocQueryCalls.get())
    }

    @Test
    fun refreshMetadataSharesSingleChildProjectionAcrossOpenFolderTabsAndRecentsAndArchivesDeletedDrafts() {
        val model = newModel()
        model.setFolder(treeUri)
        await { model.state.value.files.size == 51 }

        // Open 5 tabs and populate 3 additional recent notes from the same root folder.
        for (index in 6..8) {
            val name = "Note-%02d.md".format(index)
            val uri = DocumentsContract.buildDocumentUriUsingTree(treeUri, "primary:vault/$name")
            app.grantUriPermission(app.packageName, uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            val id = openNote(model, uri, relative = name)
            model.close(id)
            await { model.state.value.tabs.none { it.id == id } }
        }
        val openedIds = (1..5).map { index ->
            val name = "Note-%02d.md".format(index)
            val uri = DocumentsContract.buildDocumentUriUsingTree(treeUri, "primary:vault/$name")
            app.grantUriPermission(app.packageName, uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            openNote(model, uri, relative = name)
        }
        assertEquals(5, openedIds.size)
        assertTrue(model.recent.value.size >= 8)

        // Rename Note-01 in place on the provider and add Note-51 to the open folder.
        provider.renameDisplayName("primary:vault/Note-01.md", "Renamed-01.md")
        provider.putFile("primary:vault/Note-51.md", "primary:vault", "Note-51.md", "# Added externally\n")
        provider.resetCounts()

        model.refreshMetadata()
        await {
            model.state.value.tabs.any { it.name == "Renamed-01.md" } &&
                model.state.value.files.any { it.name == "Note-51.md" }
        }

        assertEquals(
            "Refreshing 5 tabs, 8 recents, and a 52-entry open folder in the same root must execute 1 child-projection query total",
            1,
            provider.totalQueryCalls.get(),
        )
        assertEquals(1, provider.childQueryCount("primary:vault"))
        assertEquals(0, provider.singleDocQueryCalls.get())
        assertEquals("Renamed-01.md", model.state.value.tabs.first { it.id == openedIds[0] }.relative)
        assertTrue(model.recent.value.any { it.name == "Renamed-01.md" && it.relative == "Renamed-01.md" })
        assertEquals("Updated renamed note", model.state.value.message)

        // Edit Note-02 locally (making it dirty), then delete Note-02 externally on the provider.
        val deletedTabId = openedIds[1]
        val unsavedDraft = "# Unsaved local draft for Note 02\n"
        model.edit(deletedTabId, unsavedDraft)
        provider.removeEntry("primary:vault/Note-02.md")
        provider.resetCounts()

        model.refreshMetadata()
        await { model.state.value.tabs.none { it.id == deletedTabId } }

        // 1 child-projection query for primary:vault + 1 single-doc confirmation query for the missing Note-02.md.
        assertEquals(2, provider.totalQueryCalls.get())
        assertEquals(1, provider.childQueryCount("primary:vault"))
        assertEquals(1, provider.singleDocQueryCalls.get())
        assertEquals(4, model.state.value.tabs.count { it.uri != null })
        val recovered = model.state.value.closedTabs.first()
        assertEquals("Recovered Note-02.md", recovered.name)
        assertEquals(unsavedDraft, recovered.content)
        val archivedStore = DeletedDraftStore(File(app.filesDir, "deleted-drafts/${model.workspaceKey}"))
        val archivedLatest = archivedStore.latest(emptySet())
        assertEquals("Recovered Note-02.md", archivedLatest?.name)
        assertEquals(unsavedDraft, archivedLatest?.content)
    }

    @Test
    fun refreshMetadataBatchesSiblingSubfolderTabsAndSupportsOpaqueDocumentIds() {
        val model = newModel()
        // Open 4 notes in primary:vault/Course/Week1 with the folder drawer closed.
        for (index in 1..4) {
            val name = "Lecture-%02d.md".format(index)
            val uri = DocumentsContract.buildDocumentUriUsingTree(treeUri, "primary:vault/Course/Week1/$name")
            app.grantUriPermission(app.packageName, uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            openNote(model, uri, relative = "Course/Week1/$name")
        }
        model.closeFolder()
        provider.renameDisplayName("primary:vault/Course/Week1/Lecture-03.md", "Lecture-03-Revised.md")
        provider.resetCounts()

        model.refreshMetadata()
        await { model.state.value.tabs.any { it.name == "Lecture-03-Revised.md" } }

        assertEquals(
            "4 tabs in the same subfolder on ExternalStorageProvider must share a single parent child-projection query",
            1,
            provider.totalQueryCalls.get(),
        )
        assertEquals(1, provider.childQueryCount("primary:vault/Course/Week1"))
        assertEquals(0, provider.singleDocQueryCalls.get())

        // Verify opaque-ID DocumentsProvider, including valid children whose opaque IDs resemble paths,
        // "$treeRoot-" prefixes, or volume-colon IDs, bounded strictly to the selected tree grant.
        val opaqueAuthority = "dev.supermd.test.opaque.${System.nanoTime()}"
        val opaqueProvider = CountingSafDocumentProvider(tempDir, opaqueRoot = true).also { it.attach(app, opaqueAuthority) }
        ShadowContentResolver.registerProviderInternal(opaqueAuthority, opaqueProvider)
        val opaqueTree = DocumentsContract.buildTreeDocumentUri(opaqueAuthority, "root_opaque")
        app.grantUriPermission(
            app.packageName,
            opaqueTree,
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION,
        )
        app.contentResolver.takePersistableUriPermission(opaqueTree, Intent.FLAG_GRANT_READ_URI_PERMISSION)

        val opaqueModel = newModel()
        opaqueModel.setFolder(opaqueTree)
        // 1 subfolder ("OpaqueSub") + 6 notes (doc_alpha, doc_beta, doc_gamma, archive/2026/doc_path, root_opaque-prefixed, bucket:doc_colon)
        await { opaqueModel.state.value.files.size == 7 }
        assertTrue(opaqueModel.state.value.files.any { it.name == "PathChild.md" })
        assertTrue(opaqueModel.state.value.files.any { it.name == "PrefixedChild.md" })
        assertTrue(opaqueModel.state.value.files.any { it.name == "ColonChild.txt" })

        // Open children from the folder list relying ONLY on the tree grant (no per-child grantUriPermission),
        // matching real Android ACTION_OPEN_DOCUMENT_TREE behavior.
        val openedOpaqueIds = mutableMapOf<String, String>()
        for ((docId, name) in listOf(
            "doc_alpha" to "Alpha.md",
            "doc_beta" to "Beta.md",
            "archive/2026/doc_path" to "PathChild.md",
            "root_opaque-prefixed" to "PrefixedChild.md",
            "bucket:doc_colon" to "ColonChild.txt",
        )) {
            val uri = DocumentsContract.buildDocumentUriUsingTree(opaqueTree, docId)
            openedOpaqueIds[docId] = openNote(opaqueModel, uri, relative = name)
        }
        opaqueProvider.renameDisplayName("doc_beta", "Beta-Renamed.md")
        opaqueProvider.renameDisplayName("archive/2026/doc_path", "PathChild-Renamed.md")
        opaqueProvider.renameDisplayName("root_opaque-prefixed", "PrefixedChild-Renamed.md")
        opaqueProvider.renameDisplayName("bucket:doc_colon", "ColonChild-Renamed.txt")
        opaqueProvider.resetCounts()

        opaqueModel.refreshMetadata()
        await {
            opaqueModel.state.value.tabs.any { it.name == "Beta-Renamed.md" } &&
                opaqueModel.state.value.tabs.any { it.name == "PathChild-Renamed.md" } &&
                opaqueModel.state.value.tabs.any { it.name == "PrefixedChild-Renamed.md" } &&
                opaqueModel.state.value.tabs.any { it.name == "ColonChild-Renamed.txt" }
        }

        assertEquals(1, opaqueProvider.totalQueryCalls.get())
        assertEquals(1, opaqueProvider.childQueryCount("root_opaque"))
        assertEquals("Opaque IDs with slashes must not infer fake parent directory IDs", 0, opaqueProvider.childQueryCount("archive/2026"))
        assertEquals(0, opaqueProvider.singleDocQueryCalls.get())
        assertTrue(opaqueModel.recent.value.any { it.name == "PathChild-Renamed.md" })
        assertTrue(opaqueModel.recent.value.any { it.name == "PrefixedChild-Renamed.md" })

        // With the folder drawer closed, provider-confirmed child membership still refreshes root and nested
        // path-like and prefix-like opaque IDs without manufacturing path-inferred parent queries.
        for ((docId, rel) in listOf(
            "shards/sub/nested_doc" to "OpaqueSub/NestedPath.md",
            "root_opaque-nested" to "OpaqueSub/NestedPrefixed.md",
        )) {
            openNote(opaqueModel, DocumentsContract.buildDocumentUriUsingTree(opaqueTree, docId), relative = rel)
        }
        opaqueModel.closeFolder()
        opaqueProvider.renameDisplayName("archive/2026/doc_path", "PathChild-ClosedDrawer.md")
        opaqueProvider.renameDisplayName("shards/sub/nested_doc", "NestedPath-Renamed.md")
        opaqueProvider.resetCounts()

        opaqueModel.refreshMetadata()
        await {
            opaqueModel.state.value.tabs.any { it.name == "PathChild-ClosedDrawer.md" } &&
                opaqueModel.state.value.tabs.any { it.name == "NestedPath-Renamed.md" }
        }
        // 1 query for root_opaque + 1 query for dir_opaque_sub (walked via relativeHint "OpaqueSub/...")
        assertEquals(2, opaqueProvider.totalQueryCalls.get())
        assertEquals(1, opaqueProvider.childQueryCount("root_opaque"))
        assertEquals(1, opaqueProvider.childQueryCount("dir_opaque_sub"))
        assertEquals(0, opaqueProvider.childQueryCount("archive/2026"))
        assertEquals(0, opaqueProvider.childQueryCount("shards/sub"))
        assertEquals(0, opaqueProvider.singleDocQueryCalls.get())

        // Deleting a dirty path-like opaque child archives its draft via DeletedDraftStore.
        val pathTabId = openedOpaqueIds.getValue("archive/2026/doc_path")
        val pathDraft = "# Unsaved opaque path-like draft\n"
        opaqueModel.edit(pathTabId, pathDraft)
        opaqueProvider.removeEntry("archive/2026/doc_path")
        opaqueProvider.resetCounts()

        opaqueModel.refreshMetadata()
        await { opaqueModel.state.value.tabs.none { it.id == pathTabId } }
        // 1 query for root_opaque + 1 query for dir_opaque_sub + 1 single-doc confirmation for deleted pathTabId
        assertEquals(3, opaqueProvider.totalQueryCalls.get())
        assertEquals(1, opaqueProvider.childQueryCount("root_opaque"))
        assertEquals(1, opaqueProvider.childQueryCount("dir_opaque_sub"))
        assertEquals(1, opaqueProvider.singleDocQueryCalls.get())
        assertEquals("Recovered PathChild-ClosedDrawer.md", opaqueModel.state.value.closedTabs.first().name)
        assertEquals(pathDraft, opaqueModel.state.value.closedTabs.first().content)

        // Ungranted plain or unconfirmed cross-tree opaque IDs stay bounded to the selected grant (0 out-of-tree queries),
        // while a directly granted standalone opaque URI refreshes via its direct grant.
        val ungrantedOpaquePlain = DocumentsContract.buildDocumentUri(opaqueAuthority, "root_opaque/FakePath.md")
        val unconfirmedOpaqueTreeEscape = DocumentsContract.buildDocumentUriUsingTree(opaqueTree, "ungranted_root/Secret.md")
        val unconfirmedOpaquePrefixEscape = DocumentsContract.buildDocumentUriUsingTree(opaqueTree, "root_opaque-ungranted")
        injectNotes(
            opaqueModel,
            listOf(
                Note(id = "opaque-plain-denied", name = "FakePath.md", uri = ungrantedOpaquePlain.toString(), content = "dirty-a", saved = ""),
                Note(id = "opaque-tree-escape", name = "Secret.md", uri = unconfirmedOpaqueTreeEscape.toString(), content = "dirty-b", saved = ""),
                Note(id = "opaque-prefix-escape", name = "Secret2.md", uri = unconfirmedOpaquePrefixEscape.toString(), content = "dirty-c", saved = ""),
            ),
        )
        opaqueProvider.resetCounts()
        opaqueModel.refreshMetadata()
        advanceAndIdle(350)

        assertEquals(0, opaqueProvider.childQueryCount("ungranted_root"))
        assertEquals(0, opaqueProvider.singleDocQueryCalls.get())
        assertFalse(opaqueProvider.queriedUris.any { it.toString().contains("ungranted_root") || it.toString().contains("root_opaque-ungranted") || it.toString().contains("FakePath") })
        assertTrue(opaqueModel.state.value.tabs.any { it.id == "opaque-plain-denied" })
        assertTrue(opaqueModel.state.value.tabs.any { it.id == "opaque-tree-escape" })
        assertTrue(opaqueModel.state.value.tabs.any { it.id == "opaque-prefix-escape" })

        val directStandaloneOpaque = DocumentsContract.buildDocumentUri(opaqueAuthority, "standalone_bucket/DirectOnly.md")
        app.grantUriPermission(app.packageName, directStandaloneOpaque, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        injectNotes(
            opaqueModel,
            listOf(Note(id = "opaque-direct-ok", name = "StaleName.md", uri = directStandaloneOpaque.toString(), content = "# Direct\n", saved = "# Direct\n")),
        )
        opaqueProvider.resetCounts()
        opaqueModel.refreshMetadata()
        await { opaqueModel.state.value.tabs.any { it.id == "opaque-direct-ok" && it.name == "DirectOnly.md" } }
        assertEquals(0, opaqueProvider.childQueryCount("ungranted_root"))
        assertEquals(0, opaqueProvider.childQueryCount("standalone_bucket"))
        assertEquals(1, opaqueProvider.singleDocQueryCalls.get())
        assertFalse(opaqueProvider.queriedUris.any { it.toString().contains("ungranted_root") })

        // Revoking the opaque tree grant blocks opaque tree queries while preserving the valid direct standalone grant.
        app.contentResolver.releasePersistableUriPermission(opaqueTree, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        app.revokeUriPermission(
            opaqueTree,
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION,
        )
        opaqueProvider.renameDisplayName("standalone_bucket/DirectOnly.md", "DirectAfterTreeRevoke.md")
        opaqueProvider.resetCounts()

        opaqueModel.listFolder(opaqueTree, "")
        await { opaqueModel.state.value.error == "Could not list folder: Choose the folder again to restore access" }
        assertEquals(0, opaqueProvider.totalQueryCalls.get())

        opaqueProvider.resetCounts()
        opaqueModel.refreshMetadata()
        await { opaqueModel.state.value.tabs.any { it.id == "opaque-direct-ok" && it.name == "DirectAfterTreeRevoke.md" } }
        assertEquals(1, opaqueProvider.totalQueryCalls.get())
        assertEquals(0, opaqueProvider.childQueryCount("root_opaque"))
        assertEquals(0, opaqueProvider.childQueryCount("dir_opaque_sub"))
        assertEquals(1, opaqueProvider.singleDocQueryCalls.get())
    }

    @Test
    fun permissionChecksBlockRevokedAndOutOfTreeQueriesWhileReusingPersistedContainingTree() {
        val model = newModel()
        // 1. Plain document URIs inside the persisted containing tree ("primary:vault") whose direct single-URI
        // grants were revoked still resolve through the user-granted containing tree in 1 batch query.
        val plainOne = DocumentsContract.buildDocumentUri(authority, "primary:vault/Note-01.md")
        val plainTwo = DocumentsContract.buildDocumentUri(authority, "primary:vault/Note-02.md")
        val rwFlags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        app.grantUriPermission(app.packageName, plainOne, rwFlags)
        app.grantUriPermission(app.packageName, plainTwo, rwFlags)
        val tabOneId = openNote(model, plainOne)
        openNote(model, plainTwo)
        // Revoke direct single-file grants; persisted tree grant on `treeUri` remains active.
        app.revokeUriPermission(plainOne, rwFlags)
        app.revokeUriPermission(plainTwo, rwFlags)
        provider.renameDisplayName("primary:vault/Note-01.md", "ViaContainingTree.md")
        provider.resetCounts()

        model.refreshMetadata()
        await { model.state.value.tabs.any { it.id == tabOneId && it.name == "ViaContainingTree.md" } }
        assertEquals(1, provider.totalQueryCalls.get())
        assertEquals(1, provider.childQueryCount("primary:vault"))
        assertEquals(0, provider.singleDocQueryCalls.get())

        // 2. Sibling-prefix ("primary:vault-2/Secret.md"), unrelated ("primary:other/Secret.md"), and traversal URIs
        // must NEVER manufacture queries against the granted "primary:vault" tree.
        provider.putDirectory("primary:vault-2", null, "vault-2")
        provider.putFile("primary:vault-2/Secret.md", "primary:vault-2", "Secret.md", "# Secret sibling\n")
        provider.putDirectory("primary:other", null, "other")
        provider.putFile("primary:other/Secret.md", "primary:other", "Secret.md", "# Secret other\n")

        val ungrantedSiblingPlain = DocumentsContract.buildDocumentUri(authority, "primary:vault-2/Secret.md")
        val ungrantedOtherPlain = DocumentsContract.buildDocumentUri(authority, "primary:other/Secret.md")
        val craftedCrossTree = DocumentsContract.buildDocumentUriUsingTree(treeUri, "primary:vault-2/Secret.md")
        val craftedTraversal = DocumentsContract.buildDocumentUriUsingTree(treeUri, "primary:vault/../other/Secret.md")

        injectNotes(
            model,
            listOf(
                Note(id = "sib", name = "Secret.md", uri = ungrantedSiblingPlain.toString(), content = "dirty-1", saved = ""),
                Note(id = "oth", name = "Secret.md", uri = ungrantedOtherPlain.toString(), content = "dirty-2", saved = ""),
                Note(id = "craft-sib", name = "Secret.md", uri = craftedCrossTree.toString(), content = "dirty-3", saved = ""),
                Note(id = "craft-trav", name = "Secret.md", uri = craftedTraversal.toString(), content = "dirty-4", saved = ""),
            ),
        )
        provider.resetCounts()
        model.refreshMetadata()
        advanceAndIdle(350)

        assertEquals("No queries may be issued for vault-2 or other", 0, provider.childQueryCount("primary:vault-2"))
        assertEquals(0, provider.childQueryCount("primary:other"))
        assertFalse(provider.queriedUris.any { it.toString().contains("vault-2") || it.toString().contains("other") })
        assertTrue("Ungranted notes must be treated as Unavailable and keep their drafts open", model.state.value.tabs.any { it.id == "sib" })
        assertTrue(model.state.value.tabs.any { it.id == "craft-sib" })
        assertTrue(model.state.value.tabs.any { it.id == "craft-trav" })

        provider.resetCounts()
        model.listFolder(treeUri, "../other")
        await { model.state.value.error == "Could not list folder: Invalid folder path" }
        assertEquals(0, provider.totalQueryCalls.get())

        // 3. Revoking the folder tree permission blocks both listFolder and refreshMetadata with 0 provider queries.
        model.edit(tabOneId, "# Unsaved edit before revocation\n")
        app.contentResolver.releasePersistableUriPermission(
            treeUri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
        )
        app.revokeUriPermission(
            treeUri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION,
        )
        provider.resetCounts()

        model.listFolder(treeUri, "")
        await { model.state.value.error == "Could not list folder: Choose the folder again to restore access" }
        assertEquals(0, provider.totalQueryCalls.get())

        provider.resetCounts()
        model.refreshMetadata()
        advanceAndIdle(350)
        assertEquals("Revoked tree grant must issue 0 provider queries during refreshMetadata", 0, provider.totalQueryCalls.get())
        assertTrue("Dirty tab must remain open when access is revoked", model.state.value.tabs.any { it.id == tabOneId && it.dirty })

        // 4. Directly granted standalone URI outside `primary:vault` queries only its own document URI, never manufacturing a tree query.
        val grantedStandalone = DocumentsContract.buildDocumentUri(authority, "primary:other/Secret.md")
        app.grantUriPermission(app.packageName, grantedStandalone, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        injectNotes(model, listOf(Note(id = "standalone-ok", name = "OldName.md", uri = grantedStandalone.toString(), content = "# Secret other\n", saved = "# Secret other\n")))
        provider.resetCounts()
        model.refreshMetadata()
        await { model.state.value.tabs.any { it.id == "standalone-ok" && it.name == "Secret.md" } }
        assertEquals(1, provider.totalQueryCalls.get())
        assertEquals(0, provider.childQueryCount("primary:other"))
        assertEquals(0, provider.childQueryCount("primary:vault-2"))
        assertEquals(1, provider.singleDocQueryCalls.get())
    }

    private fun newModel(existingKey: String? = null): StudioViewModel {
        val store = ViewModelStore().also(viewModels::add)
        val key = existingKey ?: "saf-projection-${System.nanoTime()}".also(workspaceKeys::add)
        val model = StudioViewModel(app, key)
        model.readerFlushRequester = { true }
        store.put("model-${System.nanoTime()}", model)
        return model
    }

    private fun openNote(model: StudioViewModel, uri: Uri, relative: String? = null): String {
        model.open(uri, relative = relative)
        await { model.state.value.tabs.any { it.uri == uri.toString() } }
        return model.state.value.tabs.single { it.uri == uri.toString() }.id
    }

    private fun injectNotes(model: StudioViewModel, extra: List<Note>) {
        val field = StudioViewModel::class.java.getDeclaredField("mutable").apply { isAccessible = true }
        @Suppress("UNCHECKED_CAST")
        val flow = field.get(model) as kotlinx.coroutines.flow.MutableStateFlow<StudioState>
        flow.value = flow.value.copy(tabs = flow.value.tabs + extra)
    }

    private fun advanceAndIdle(totalMs: Long) {
        val mainLooper = shadowOf(Looper.getMainLooper())
        var remaining = totalMs
        while (remaining > 0) {
            val step = minOf(50L, remaining)
            mainLooper.idleFor(java.time.Duration.ofMillis(step))
            Thread.sleep(10)
            mainLooper.idle()
            remaining -= step
        }
    }

    private fun await(timeoutMs: Long = 5_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        val mainLooper = shadowOf(Looper.getMainLooper())
        while (System.currentTimeMillis() < deadline) {
            mainLooper.idleFor(java.time.Duration.ofMillis(25))
            mainLooper.idle()
            if (condition()) return
            Thread.sleep(10)
        }
        mainLooper.idle()
        assertTrue("Condition was not met within ${timeoutMs}ms", condition())
    }
}

private class CountingSafDocumentProvider(
    private val tempDir: File,
    opaqueRoot: Boolean = false,
) : ContentProvider() {
    data class Entry(
        val documentId: String,
        val parentId: String?,
        var displayName: String,
        val mimeType: String,
        val file: File?,
        val flags: Int = 0,
    )

    private val entries = ConcurrentHashMap<String, Entry>()
    private val childQueries = ConcurrentHashMap<String, AtomicInteger>()
    val totalQueryCalls = AtomicInteger(0)
    val singleDocQueryCalls = AtomicInteger(0)
    val queriedUris = CopyOnWriteArrayList<Uri>()

    init {
        if (opaqueRoot) {
            putDirectory("root_opaque", null, "OpaqueVault")
            putFile("doc_alpha", "root_opaque", "Alpha.md", "# Alpha\n")
            putFile("doc_beta", "root_opaque", "Beta.md", "# Beta\n")
            putFile("doc_gamma", "root_opaque", "Gamma.md", "# Gamma\n")
            putFile("archive/2026/doc_path", "root_opaque", "PathChild.md", "# Path-like opaque ID\n")
            putFile("root_opaque-prefixed", "root_opaque", "PrefixedChild.md", "# Prefix-like opaque ID\n")
            putFile("bucket:doc_colon", "root_opaque", "ColonChild.txt", "Colon opaque .txt ID\n", mimeType = "text/plain")
            putDirectory("dir_opaque_sub", "root_opaque", "OpaqueSub")
            putFile("shards/sub/nested_doc", "dir_opaque_sub", "NestedPath.md", "# Nested path-like\n")
            putFile("root_opaque-nested", "dir_opaque_sub", "NestedPrefixed.md", "# Nested prefix-like\n")
            putDirectory("ungranted_root", null, "UngrantedRoot")
            putFile("ungranted_root/Secret.md", "ungranted_root", "Secret.md", "# Secret\n")
            putFile("root_opaque-ungranted", "ungranted_root", "Secret2.md", "# Secret 2\n")
            putDirectory("standalone_bucket", null, "StandaloneBucket")
            putFile("standalone_bucket/DirectOnly.md", "standalone_bucket", "DirectOnly.md", "# Direct\n")
        } else {
            putDirectory("primary:vault", null, "vault")
            for (index in 1..43) {
                val name = "Note-%02d.md".format(index)
                putFile("primary:vault/$name", "primary:vault", name, "# Note $index\n")
            }
            putFile("primary:vault/1.2 Linear Algebra.txt", "primary:vault", "1.2 Linear Algebra.txt", "Linear algebra notes\n", mimeType = "text/plain")
            putFile("primary:vault/Portable-01.smd", "primary:vault", "Portable-01.smd", "# Portable 1\n")
            putFile("primary:vault/Portable-02.smd", "primary:vault", "Portable-02.smd", "# Portable 2\n")
            putFile("primary:vault/Guide-01.markdown", "primary:vault", "Guide-01.markdown", "# Guide 1\n")
            putFile("primary:vault/Guide-02.markdown", "primary:vault", "Guide-02.markdown", "# Guide 2\n")
            putFile("primary:vault/Legacy-01.fmd", "primary:vault", "Legacy-01.fmd", "# Legacy 1\n")
            putFile("primary:vault/Legacy-02.fmd", "primary:vault", "Legacy-02.fmd", "# Legacy 2\n")
            // Non-note files, dotfiles, extensionless "md"/"txt", and virtual document
            for (index in 1..9) {
                val img = "diagram-%02d.png".format(index)
                putFile("primary:vault/$img", "primary:vault", img, "png", mimeType = "image/png")
            }
            putFile("primary:vault/md", "primary:vault", "md", "not an extension", mimeType = "text/plain")
            putFile("primary:vault/txt", "primary:vault", "txt", "not an extension", mimeType = "text/plain")
            putFile("primary:vault/.hidden.md", "primary:vault", ".hidden.md", "# Hidden\n")
            putDirectory("primary:vault/.obsidian", "primary:vault", ".obsidian")
            putFile(
                "primary:vault/VirtualShortcut.md",
                "primary:vault",
                "VirtualShortcut.md",
                "# Virtual\n",
                flags = DocumentsContract.Document.FLAG_VIRTUAL_DOCUMENT,
            )

            putDirectory("primary:vault/Course", "primary:vault", "Course")
            putFile("primary:vault/Course/Syllabus.md", "primary:vault/Course", "Syllabus.md", "# Syllabus\n")
            putDirectory("primary:vault/Course/Week1", "primary:vault/Course", "Week1")
            for (index in 1..15) {
                val name = "Lecture-%02d.md".format(index)
                putFile("primary:vault/Course/Week1/$name", "primary:vault/Course/Week1", name, "# Lecture $index\n")
            }
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

    fun resetCounts() {
        totalQueryCalls.set(0)
        singleDocQueryCalls.set(0)
        childQueries.clear()
        queriedUris.clear()
    }

    fun childQueryCount(parentDocumentId: String): Int = childQueries[parentDocumentId]?.get() ?: 0

    fun putDirectory(documentId: String, parentId: String?, displayName: String) {
        entries[documentId] = Entry(documentId, parentId, displayName, DocumentsContract.Document.MIME_TYPE_DIR, null)
    }

    fun putFile(
        documentId: String,
        parentId: String?,
        displayName: String,
        content: String,
        mimeType: String = "text/markdown",
        flags: Int = 0,
    ) {
        val safeId = documentId.replace('/', '_').replace(':', '_')
        val backing = File(tempDir, safeId + "_" + displayName).apply { writeText(content) }
        entries[documentId] = Entry(documentId, parentId, displayName, mimeType, backing, flags)
    }

    fun renameDisplayName(documentId: String, newName: String) {
        entries.computeIfPresent(documentId) { _, existing -> existing.copy(displayName = newName) }
    }

    fun removeEntry(documentId: String) {
        entries.remove(documentId)
    }

    fun removeSubtree(rootDocumentId: String) {
        val toRemove = linkedSetOf(rootDocumentId)
        var changed = true
        while (changed) {
            changed = false
            for ((docId, entry) in entries) {
                if (entry.parentId in toRemove && toRemove.add(docId)) {
                    changed = true
                }
            }
        }
        toRemove.forEach(entries::remove)
    }

    override fun onCreate(): Boolean = true

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor {
        totalQueryCalls.incrementAndGet()
        queriedUris += uri
        if (uri.pathSegments.lastOrNull() == "children") {
            val parentId = DocumentsContract.getDocumentId(uri)
            childQueries.computeIfAbsent(parentId) { AtomicInteger(0) }.incrementAndGet()
            if (!entries.containsKey(parentId)) throw FileNotFoundException("Missing folder $parentId")
            val columns = projection ?: arrayOf(
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_FLAGS,
            )
            return MatrixCursor(columns).apply {
                entries.values
                    .filter { it.parentId == parentId }
                    .sortedBy { it.displayName }
                    .forEach { child -> addRow(rowFor(child, columns)) }
            }
        }
        singleDocQueryCalls.incrementAndGet()
        val docId = DocumentsContract.getDocumentId(uri)
        val entry = entries[docId] ?: throw FileNotFoundException("Missing document $docId")
        val columns = projection ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        return MatrixCursor(columns).apply { addRow(rowFor(entry, columns)) }
    }

    private fun rowFor(entry: Entry, columns: Array<out String>): Array<Any?> =
        columns.map { column ->
            when (column) {
                DocumentsContract.Document.COLUMN_DOCUMENT_ID -> entry.documentId
                DocumentsContract.Document.COLUMN_DISPLAY_NAME, OpenableColumns.DISPLAY_NAME -> entry.displayName
                DocumentsContract.Document.COLUMN_MIME_TYPE -> entry.mimeType
                DocumentsContract.Document.COLUMN_FLAGS -> entry.flags
                DocumentsContract.Document.COLUMN_SIZE, OpenableColumns.SIZE -> entry.file?.length() ?: 0L
                else -> null
            }
        }.toTypedArray()

    override fun getType(uri: Uri): String? = entries[DocumentsContract.getDocumentId(uri)]?.mimeType
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        val docId = DocumentsContract.getDocumentId(uri)
        val entry = entries[docId] ?: throw FileNotFoundException("Missing document $docId")
        val backing = entry.file ?: throw FileNotFoundException("Cannot open directory $docId")
        val flags = when (mode) {
            "r" -> ParcelFileDescriptor.MODE_READ_ONLY
            "rw" -> ParcelFileDescriptor.MODE_READ_WRITE
            "wt", "w" -> ParcelFileDescriptor.MODE_WRITE_ONLY or ParcelFileDescriptor.MODE_CREATE or ParcelFileDescriptor.MODE_TRUNCATE
            else -> throw FileNotFoundException("Unsupported mode $mode")
        }
        return ParcelFileDescriptor.open(backing, flags)
    }
}

private class PermissionEnforcingApplication(base: Application) : Application() {
    private val grants = ConcurrentHashMap<Uri, Int>()

    init {
        attachBaseContext(base)
    }

    override fun getApplicationContext(): Context = this

    override fun grantUriPermission(toPackage: String?, uri: Uri?, modeFlags: Int) {
        if (uri != null) {
            val mask = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            grants.merge(uri, modeFlags and mask) { old, added -> old or added }
        }
        super.grantUriPermission(toPackage, uri, modeFlags)
    }

    override fun revokeUriPermission(uri: Uri?, modeFlags: Int) {
        if (uri != null) {
            val mask = modeFlags and (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            val iterator = grants.entries.iterator()
            while (iterator.hasNext()) {
                val entry = iterator.next()
                if (entry.key == uri || (DocumentsContract.isTreeUri(uri) && entry.key.toString().startsWith(uri.toString() + "/"))) {
                    val remaining = entry.value and mask.inv()
                    if (remaining == 0) iterator.remove() else entry.setValue(remaining)
                }
            }
        }
        super.revokeUriPermission(uri, modeFlags)
    }

    override fun revokeUriPermission(targetPackage: String?, uri: Uri?, modeFlags: Int) {
        revokeUriPermission(uri, modeFlags)
    }

    override fun checkUriPermission(uri: Uri?, pid: Int, uid: Int, modeFlags: Int): Int {
        if (uri == null) return android.content.pm.PackageManager.PERMISSION_DENIED
        val required = modeFlags and (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        val held = grants.entries
            .filter { (granted, _) ->
                granted == uri || (DocumentsContract.isTreeUri(granted) && uri.toString().startsWith(granted.toString() + "/"))
            }
            .fold(0) { acc, (_, flags) -> acc or flags }
        return if ((held and required) == required) {
            android.content.pm.PackageManager.PERMISSION_GRANTED
        } else {
            android.content.pm.PackageManager.PERMISSION_DENIED
        }
    }
}

