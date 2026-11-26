package dev.supermd.studio

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.ProviderInfo
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.os.Looper
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import androidx.lifecycle.ViewModelStore
import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.launch
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

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class DocumentAccessTest {
    private lateinit var app: android.app.Application
    private lateinit var root: File
    private lateinit var provider: FailingDocumentProvider
    private lateinit var authority: String
    private lateinit var noteUri: Uri
    private lateinit var otherUri: Uri
    private var previousAutosave: Boolean? = null
    private var previousRecent: String? = null
    private val workspaceKeys = mutableListOf<String>()
    private val viewModels = mutableListOf<ViewModelStore>()

    @Before fun setUp() {
        app = RuntimeEnvironment.getApplication()
        root = Files.createTempDirectory("document-access-test").toFile()
        authority = "dev.supermd.test.documents.${System.nanoTime()}"
        noteUri = DocumentsContract.buildDocumentUri(authority, "folder/Note.md")
        otherUri = DocumentsContract.buildDocumentUri(authority, "folder/Other.md")
        provider = FailingDocumentProvider(root).also { it.attach(app, authority) }
        ShadowContentResolver.registerProviderInternal(authority, provider)
        app.grantUriPermission(app.packageName, noteUri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        app.grantUriPermission(app.packageName, otherUri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        val prefs = app.getSharedPreferences("studio", Context.MODE_PRIVATE)
        previousAutosave = prefs.getBoolean("autosave", true)
        previousRecent = prefs.getString("recent", null)
        prefs.edit().putBoolean("autosave", false).commit()
    }

    @After fun tearDown() {
        viewModels.forEach { it.clear() }
        app.getSharedPreferences("studio", Context.MODE_PRIVATE).edit().apply {
            putBoolean("autosave", previousAutosave ?: true)
            if (previousRecent == null) remove("recent") else putString("recent", previousRecent)
        }.commit()
        ShadowContentResolver.reset()
        root.deleteRecursively()
        workspaceKeys.forEach { File(app.filesDir, "workspaces/$it").deleteRecursively() }
    }

    @Test fun readGrantSurvivesProviderRejectingTheWriteGrant() {
        val seen = mutableListOf<Int>()
        val retained = persistDocumentGrants { mode ->
            seen += mode
            if (mode == Intent.FLAG_GRANT_WRITE_URI_PERMISSION) throw SecurityException("write grant unavailable")
        }

        assertEquals(listOf(Intent.FLAG_GRANT_READ_URI_PERMISSION, Intent.FLAG_GRANT_WRITE_URI_PERMISSION), seen)
        assertTrue(retained and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
        assertFalse(retained and Intent.FLAG_GRANT_WRITE_URI_PERMISSION != 0)
    }

    @Test fun documentIdentityMatchesPlainAndTreeUrisOnlyForTheSameProviderDocument() {
        val tree = DocumentsContract.buildTreeDocumentUri(authority, "folder")
        val sameFileViaTree = DocumentsContract.buildDocumentUriUsingTree(tree, "folder/Note.md")
        val differentFileViaTree = DocumentsContract.buildDocumentUriUsingTree(tree, "folder/Other.md")
        val otherAuthority = DocumentsContract.buildDocumentUri("other.${authority}", "folder/Note.md")

        assertTrue(sameDocument(noteUri, sameFileViaTree))
        assertTrue(sameDocument(sameFileViaTree, noteUri))
        assertFalse(sameDocument(noteUri, differentFileViaTree))
        assertFalse(sameDocument(noteUri, otherAuthority))
    }

    @Test fun treeContainmentAndReadAccessRespectKnownExternalStoragePathsAndOpaqueProviderIds() {
        assertTrue(isKnownPathContainedInTree(EXTERNAL_STORAGE_DOCUMENTS_AUTHORITY, "primary:", "primary:Notes/Note.md"))
        assertTrue(isKnownPathContainedInTree(EXTERNAL_STORAGE_DOCUMENTS_AUTHORITY, "primary:folder", "primary:folder"))
        assertTrue(isKnownPathContainedInTree(EXTERNAL_STORAGE_DOCUMENTS_AUTHORITY, "primary:folder", "primary:folder/Note.md"))
        assertTrue(isKnownPathContainedInTree(EXTERNAL_STORAGE_DOCUMENTS_AUTHORITY, "primary:folder/", "primary:folder/Sub/Note.md"))
        assertFalse(isKnownPathContainedInTree(EXTERNAL_STORAGE_DOCUMENTS_AUTHORITY, "primary:folder", "primary:folder-other/Note.md"))
        assertFalse(isKnownPathContainedInTree(EXTERNAL_STORAGE_DOCUMENTS_AUTHORITY, "primary:folder", "primary:folder/../outside/Note.md"))
        assertFalse(isKnownPathContainedInTree(EXTERNAL_STORAGE_DOCUMENTS_AUTHORITY, "primary:", "primary:../outside/Note.md"))
        assertFalse(isKnownPathContainedInTree(EXTERNAL_STORAGE_DOCUMENTS_AUTHORITY, "primary:folder", "secondary:folder/Note.md"))
        assertFalse("Opaque providers must not infer containment from path syntax", isKnownPathContainedInTree(authority, "folder", "folder/Note.md"))

        val grantedUris = mutableMapOf<Uri, Int>()
        val enforcingContext = object : android.content.ContextWrapper(app) {
            override fun checkUriPermission(uri: Uri?, pid: Int, uid: Int, modeFlags: Int): Int {
                if (uri == null) return android.content.pm.PackageManager.PERMISSION_DENIED
                val held = grantedUris.entries
                    .filter { (granted, _) ->
                        granted == uri || (DocumentsContract.isTreeUri(granted) && uri.toString().startsWith(granted.toString() + "/"))
                    }
                    .fold(0) { acc, (_, flags) -> acc or flags }
                return if ((held and modeFlags) == modeFlags) {
                    android.content.pm.PackageManager.PERMISSION_GRANTED
                } else {
                    android.content.pm.PackageManager.PERMISSION_DENIED
                }
            }
        }

        val access = DocumentAccess(enforcingContext)
        val extProvider = FailingDocumentProvider(root).also { it.attach(app, EXTERNAL_STORAGE_DOCUMENTS_AUTHORITY) }
        ShadowContentResolver.registerProviderInternal(EXTERNAL_STORAGE_DOCUMENTS_AUTHORITY, extProvider)
        val extTree = DocumentsContract.buildTreeDocumentUri(EXTERNAL_STORAGE_DOCUMENTS_AUTHORITY, "primary:folder")
        grantedUris[extTree] = Intent.FLAG_GRANT_READ_URI_PERMISSION
        app.contentResolver.takePersistableUriPermission(extTree, Intent.FLAG_GRANT_READ_URI_PERMISSION)

        val ungrantedInside = DocumentsContract.buildDocumentUri(EXTERNAL_STORAGE_DOCUMENTS_AUTHORITY, "primary:folder/Inside.md")
        val ungrantedSibling = DocumentsContract.buildDocumentUri(EXTERNAL_STORAGE_DOCUMENTS_AUTHORITY, "primary:folder-2/Outside.md")
        val craftedEscape = DocumentsContract.buildDocumentUriUsingTree(extTree, "primary:folder-2/Outside.md")
        val craftedTraversal = DocumentsContract.buildDocumentUriUsingTree(extTree, "primary:folder/../outside/Outside.md")

        assertTrue(access.resolveReadAccess(ungrantedInside) is SafReadAccess.InGrantedTree)
        assertEquals(SafReadAccess.Denied, access.resolveReadAccess(ungrantedSibling))
        assertEquals(SafReadAccess.Denied, access.resolveReadAccess(craftedEscape))
        assertEquals(SafReadAccess.Denied, access.resolveReadAccess(craftedTraversal))

        val grantedOutside = DocumentsContract.buildDocumentUri(EXTERNAL_STORAGE_DOCUMENTS_AUTHORITY, "primary:standalone/Single.md")
        grantedUris[grantedOutside] = Intent.FLAG_GRANT_READ_URI_PERMISSION
        assertEquals(SafReadAccess.StandaloneDocument(grantedOutside), access.resolveReadAccess(grantedOutside))

        // Opaque providers must NOT reject slashes, trailing colons, or "$treeRoot-" prefixes,
        // and must NOT manufacture tree access from ungranted plain URIs without provider confirmation.
        val opaqueTree = DocumentsContract.buildTreeDocumentUri(authority, "root_opaque")
        val colonTree = DocumentsContract.buildTreeDocumentUri(authority, "root_colon:")
        grantedUris[opaqueTree] = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        grantedUris[colonTree] = Intent.FLAG_GRANT_READ_URI_PERMISSION
        app.contentResolver.takePersistableUriPermission(opaqueTree, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)

        val opaquePathLikeChild = DocumentsContract.buildDocumentUriUsingTree(opaqueTree, "archive/2026/doc_path")
        val plainForOpaquePathLikeChild = DocumentsContract.buildDocumentUri(authority, "archive/2026/doc_path")
        val opaquePrefixLikeChild = DocumentsContract.buildDocumentUriUsingTree(opaqueTree, "root_opaque-child")
        val opaqueColonRootChild = DocumentsContract.buildDocumentUriUsingTree(colonTree, "opaque_child")
        val ungrantedPlainOpaque = DocumentsContract.buildDocumentUri(authority, "root_opaque/LooksInside.md")
        val grantedPlainOpaque = DocumentsContract.buildDocumentUri(authority, "archive/2026/standalone")
        grantedUris[grantedPlainOpaque] = Intent.FLAG_GRANT_READ_URI_PERMISSION

        assertEquals(SafReadAccess.Denied, access.resolveReadAccess(ungrantedPlainOpaque))
        assertEquals(SafReadAccess.StandaloneDocument(grantedPlainOpaque), access.resolveReadAccess(grantedPlainOpaque))
        assertTrue(access.resolveReadAccess(opaquePathLikeChild) is SafReadAccess.PendingTreeMembership)
        assertTrue(access.resolveReadAccess(opaquePrefixLikeChild) is SafReadAccess.PendingTreeMembership)
        assertTrue(access.resolveReadAccess(opaqueColonRootChild) is SafReadAccess.PendingTreeMembership)
        assertFalse("Unconfirmed opaque tree candidate must not count as confirmed read grant", access.hasReadGrant(opaquePathLikeChild))
        assertFalse("Unconfirmed opaque tree candidate must not count as confirmed write grant", access.hasWriteGrant(opaquePathLikeChild))
        grantedUris[plainForOpaquePathLikeChild] = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        assertFalse(
            "Unconfirmed opaque tree candidate must not count as confirmed write grant via standalone plain grant",
            access.hasWriteGrant(opaquePathLikeChild),
        )
        grantedUris.remove(plainForOpaquePathLikeChild)

        val confirmedSet = setOf("archive/2026/doc_path", "root_opaque-child", "opaque_child")
        val confirmFn: (Uri, String) -> Boolean = { _, id -> id in confirmedSet }
        assertTrue(access.resolveReadAccess(opaquePathLikeChild, isConfirmedTreeChild = confirmFn) is SafReadAccess.InGrantedTree)
        assertTrue(access.resolveReadAccess(opaquePrefixLikeChild, isConfirmedTreeChild = confirmFn) is SafReadAccess.InGrantedTree)
        assertTrue(access.resolveReadAccess(opaqueColonRootChild, isConfirmedTreeChild = confirmFn) is SafReadAccess.InGrantedTree)
        assertTrue(access.hasReadGrant(opaquePathLikeChild, isConfirmedTreeChild = confirmFn))
        assertTrue(access.hasWriteGrant(opaquePathLikeChild, isConfirmedTreeChild = confirmFn))

        grantedUris.remove(opaqueTree)
        assertEquals(SafReadAccess.Denied, access.resolveReadAccess(opaquePathLikeChild, isConfirmedTreeChild = confirmFn))
    }

    @Test fun resolveRecoversConfirmedThirdPartyPlainNoteAcrossGrantMigrationAndHonorsGrantModes() {
        val grantedUris = mutableMapOf<Uri, Int>()
        val enforcingContext = object : android.content.ContextWrapper(app) {
            override fun checkUriPermission(uri: Uri?, pid: Int, uid: Int, modeFlags: Int): Int {
                if (uri == null) return android.content.pm.PackageManager.PERMISSION_DENIED
                val held = grantedUris.entries
                    .filter { (granted, _) ->
                        granted == uri || (DocumentsContract.isTreeUri(granted) && uri.toString().startsWith(granted.toString() + "/"))
                    }
                    .fold(0) { acc, (_, flags) -> acc or flags }
                return if ((held and modeFlags) == modeFlags) {
                    android.content.pm.PackageManager.PERMISSION_GRANTED
                } else {
                    android.content.pm.PackageManager.PERMISSION_DENIED
                }
            }
        }

        val thirdPartyAuthority = "dev.supermd.test.thirdparty.${System.nanoTime()}"
        val thirdPartyProvider = object : ContentProvider() {
            var childQueries = 0
            var singleDocQueries = 0
            override fun onCreate() = true
            override fun query(
                uri: Uri,
                projection: Array<out String>?,
                selection: String?,
                selectionArgs: Array<out String>?,
                sortOrder: String?,
            ): Cursor {
                val cols = projection ?: arrayOf(
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                    DocumentsContract.Document.COLUMN_MIME_TYPE,
                    DocumentsContract.Document.COLUMN_FLAGS,
                )
                if (uri.pathSegments.lastOrNull() == "children") {
                    childQueries++
                    val parentId = DocumentsContract.getDocumentId(uri)
                    return MatrixCursor(cols).apply {
                        when (parentId) {
                            "opaque_vault" -> {
                                addRow(arrayOf<Any?>("opaque_note_1", "Migrated.md", "text/markdown", 0))
                                addRow(arrayOf<Any?>("opaque_subdir", "Sub", DocumentsContract.Document.MIME_TYPE_DIR, 0))
                                addRow(arrayOf<Any?>("opaque_virtual_shortcut", "Shortcut.md", "text/markdown", DocumentsContract.Document.FLAG_VIRTUAL_DOCUMENT))
                            }
                            "opaque_subdir" -> {
                                addRow(arrayOf<Any?>("nested_opaque_note", "Nested.md", "text/markdown", 0))
                            }
                        }
                    }
                }
                singleDocQueries++
                return MatrixCursor(cols)
            }
            override fun getType(uri: Uri) = "text/markdown"
            override fun insert(uri: Uri, values: ContentValues?): Uri? = null
            override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0
            override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0
        }.also {
            it.attachInfo(app, ProviderInfo().apply {
                authority = thirdPartyAuthority
                exported = true
                grantUriPermissions = true
            })
        }
        ShadowContentResolver.registerProviderInternal(thirdPartyAuthority, thirdPartyProvider)

        val confirmedKeys = mutableSetOf<String>()
        val access = DocumentAccess(
            context = enforcingContext,
            isConfirmedTreeChildProvider = { tree, docId ->
                DocumentsContract.buildDocumentUriUsingTree(tree, docId).toString() in confirmedKeys
            },
            onConfirmedTreeKeys = { confirmedKeys.addAll(it) },
        )

        val plainNote = DocumentsContract.buildDocumentUri(thirdPartyAuthority, "opaque_note_1")
        val plainNested = DocumentsContract.buildDocumentUri(thirdPartyAuthority, "nested_opaque_note")
        val plainSubdir = DocumentsContract.buildDocumentUri(thirdPartyAuthority, "opaque_subdir")
        val plainVirtual = DocumentsContract.buildDocumentUri(thirdPartyAuthority, "opaque_virtual_shortcut")
        val plainOutside = DocumentsContract.buildDocumentUri(thirdPartyAuthority, "outside_ungranted_note")
        val vaultTree = DocumentsContract.buildTreeDocumentUri(thirdPartyAuthority, "opaque_vault")
        val expectedTreeNote = DocumentsContract.buildDocumentUriUsingTree(vaultTree, "opaque_note_1")
        val expectedTreeNested = DocumentsContract.buildDocumentUriUsingTree(vaultTree, "nested_opaque_note")

        // 1. Direct note grant active -> resolves directly with 0 tree queries.
        grantedUris[plainNote] = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        assertEquals(plainNote, access.resolve(plainNote, writing = false))
        assertEquals(plainNote, access.resolve(plainNote, writing = true))
        assertEquals(0, thirdPartyProvider.childQueries)

        // 2. Migrate: individual plain note grant expires while read-only persisted containing folder grant remains.
        grantedUris.remove(plainNote)
        grantedUris[vaultTree] = Intent.FLAG_GRANT_READ_URI_PERMISSION
        app.contentResolver.takePersistableUriPermission(vaultTree, Intent.FLAG_GRANT_READ_URI_PERMISSION)

        assertEquals(expectedTreeNote, access.resolve(plainNote, writing = false))
        assertEquals(1, thirdPartyProvider.childQueries)
        assertEquals(0, thirdPartyProvider.singleDocQueries)

        // Write resolution must NOT manufacture write access from a read-only folder grant (0 extra queries).
        val queriesBeforeWriteCheck = thirdPartyProvider.childQueries
        assertEquals(plainNote, access.resolve(plainNote, writing = true))
        assertEquals(queriesBeforeWriteCheck, thirdPartyProvider.childQueries)

        // Out-of-tree plain URI, directory entry, and virtual document must NOT upgrade to vaultTree.
        assertEquals(plainOutside, access.resolve(plainOutside, writing = false))
        assertEquals(plainSubdir, access.resolve(plainSubdir, writing = false))
        assertEquals(plainVirtual, access.resolve(plainVirtual, writing = false))
        assertEquals(0, thirdPartyProvider.singleDocQueries)

        // 3. Upgrade containing folder grant to read + write -> both root and nested plain notes resolve for write too.
        grantedUris[vaultTree] = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        app.contentResolver.takePersistableUriPermission(
            vaultTree,
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
        )
        thirdPartyProvider.childQueries = 0
        // Root note was already confirmed in confirmedKeys -> 0 queries!
        assertEquals(expectedTreeNote, access.resolve(plainNote, writing = true))
        assertEquals(0, thirdPartyProvider.childQueries)
        assertEquals(expectedTreeNested, access.resolve(plainNested, writing = true))

        // 4. Revoke containing folder grant -> 0 provider queries on revoked access.
        grantedUris.clear()
        app.contentResolver.releasePersistableUriPermission(
            vaultTree,
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
        )
        thirdPartyProvider.childQueries = 0
        thirdPartyProvider.singleDocQueries = 0
        assertEquals(plainNote, access.resolve(plainNote, writing = false))
        assertEquals(plainNote, access.resolve(plainNote, writing = true))
        assertEquals(0, thirdPartyProvider.childQueries)
        assertEquals(0, thirdPartyProvider.singleDocQueries)
    }

    @Test fun reopeningRecentNoteAfterReadRevocationOffersRecoveryAndKeepsItsDraft() {
        val model = newModel()
        val noteId = openBaseline(model)
        val draft = "# Unsaved draft\n\n![diagram](assets/figure.svg)\n"
        model.edit(noteId, draft)
        provider.failRead = true

        model.open(noteUri)
        await { model.documentAccessRequests.value != null }

        val request = model.documentAccessRequests.value!!
        val note = model.state.value.tabs.single { it.id == noteId }
        assertEquals(noteUri.toString(), request.uri)
        assertEquals("Note.md", request.name)
        assertEquals(noteId, request.noteId)
        assertFalse(request.writing)
        assertEquals(draft, note.content)
        assertEquals(provider.baseline, note.saved)
        assertTrue(note.dirty)
    }

    @Test fun writeDenialPromptsOnceAndRecoveryRejectsAnotherFileWithoutReplacingDraftOrBaseline() {
        val model = newModel()
        val noteId = openBaseline(model)
        var draft = "# Draft after edits\n\n![asset](assets/figure.svg)\n"
        model.edit(noteId, draft)
        provider.failWrite = true
        // Focus this unit test on provider denial classification and recovery
        // state. The production save pipeline also stages media through JNI;
        // an API 35 instrumentation case covers that full native path.
        val writeFailure = runCatching {
            app.contentResolver.openOutputStream(noteUri, "wt")!!.use { it.write("must not replace the baseline".toByteArray()) }
        }.exceptionOrNull() ?: throw AssertionError("The fake provider should reject this write")
        assertTrue("the provider denial is recognized as an access failure", isDocumentAccessFailure(writeFailure))
        model.reportDocumentSaveFailure(noteId, writeFailure, "Could not save note")
        await { model.documentAccessRequests.value != null }

        val noteBeforeRecovery = model.state.value.tabs.single { it.id == noteId }
        val request = model.documentAccessRequests.value!!
        assertTrue(request.writing)
        assertEquals(draft, noteBeforeRecovery.content)
        assertEquals(provider.baseline, noteBeforeRecovery.saved)
        assertTrue(noteBeforeRecovery.dirty)
        assertEquals(provider.baseline, provider.noteFile.readText())

        // A file-backed image/asset directory pointer is part of the live note
        // identity. Access recovery must only rebind its SAF URI.
        replaceNote(model, noteId) { it.copy(assetDirectory = "private-asset-directory") }
        model.dismissDocumentAccess()
        assertTrue(model.requestWriteAccessIfBlocked(noteId))
        assertNull(model.documentAccessRequests.value)
        model.reading(autosave = true)
        draft += "\nMore changes while access is blocked\n"
        model.edit(noteId, draft)
        model.reportDocumentSaveFailure(noteId, SecurityException("repeated agent write denial"), "generic failure")
        assertNull("repeated background/agent failures do not reopen a dismissed prompt", model.documentAccessRequests.value)
        assertEquals("editing while blocked does not schedule another provider write", 1, provider.writeAttempts)
        model.reading(autosave = false)

        model.requestWriteAccessIfBlocked(noteId, explicit = true)
        val explicitRequest = model.documentAccessRequests.value!!
        assertEquals(request.uri, explicitRequest.uri)
        assertTrue(explicitRequest.writing)

        model.restoreDocumentAccess(explicitRequest, otherUri)
        await { model.documentAccessRequests.value?.detail != null }
        assertEquals(noteUri.toString(), model.state.value.tabs.single { it.id == noteId }.uri)
        assertEquals("private-asset-directory", model.state.value.tabs.single { it.id == noteId }.assetDirectory)
        assertEquals(draft, model.state.value.tabs.single { it.id == noteId }.content)
        assertEquals(provider.baseline, model.state.value.tabs.single { it.id == noteId }.saved)

        provider.failWrite = false
        model.restoreDocumentAccess(model.documentAccessRequests.value!!, noteUri)
        await { model.documentAccessRequests.value == null && model.state.value.message == "File access restored; your draft is unchanged" }

        val restored = model.state.value.tabs.single { it.id == noteId }
        assertEquals(noteUri.toString(), restored.uri)
        assertEquals(draft, restored.content)
        assertEquals(provider.baseline, restored.saved)
        assertEquals("private-asset-directory", restored.assetDirectory)
        assertTrue(restored.dirty)
        assertEquals("grant verification does not overwrite or reload the original file", provider.baseline, provider.noteFile.readText())
    }

    @Test
    fun startupRestoreSeedsBlockedWritesForRevokedAndReadOnlyGrantsWhileRespectingDirectAndContainingFolderGrants() {
        val extProvider = StartupGuardDocumentProvider(root).also {
            it.attach(app, EXTERNAL_STORAGE_DOCUMENTS_AUTHORITY)
        }
        ShadowContentResolver.registerProviderInternal(EXTERNAL_STORAGE_DOCUMENTS_AUTHORITY, extProvider)

        val opaqueAuthority = "dev.supermd.test.startup.opaque.${System.nanoTime()}"
        val opaqueProvider = StartupGuardDocumentProvider(root).also {
            it.attach(app, opaqueAuthority)
        }
        ShadowContentResolver.registerProviderInternal(opaqueAuthority, opaqueProvider)

        val grantedUris = mutableMapOf<Uri, Int>()
        val persistedUris = mutableMapOf<Uri, Int>()
        val enforcingApp = StartupEnforcingApplication(app, grantedUris, persistedUris)
        extProvider.permissionChecker = { uri, required ->
            enforcingApp.checkUriPermission(uri, android.os.Process.myPid(), android.os.Process.myUid(), required) ==
                android.content.pm.PackageManager.PERMISSION_GRANTED
        }
        opaqueProvider.permissionChecker = extProvider.permissionChecker

        val rwFlags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        val persistRw = rwFlags or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION

        val revokedCleanUri = extProvider.putDoc("primary:study/RevokedClean.md", "# Clean cached note\n")
        val revokedDraftUri = extProvider.putDoc("primary:study/RevokedDraft.md", "# Draft baseline\n")
        val readOnlyUri = extProvider.putDoc("primary:study/ReadOnly.md", "# Read-only note\n")
        val directValidUri = extProvider.putDoc("primary:study/DirectValid.md", "# Direct valid note\n")
        val folderCoveredUri = extProvider.putDoc("primary:vault/Sub/FolderCovered.md", "# Covered by external storage folder\n")
        val extTreeUri = DocumentsContract.buildTreeDocumentUri(EXTERNAL_STORAGE_DOCUMENTS_AUTHORITY, "primary:vault")

        val opaqueTreeUri = DocumentsContract.buildTreeDocumentUri(opaqueAuthority, "opaque_root")
        val opaqueCoveredUri = opaqueProvider.putDoc("opaque_doc_1", "# Covered by opaque folder\n", parentId = "opaque_root")

        listOf(
            revokedCleanUri,
            revokedDraftUri,
            readOnlyUri,
            directValidUri,
            folderCoveredUri,
            extTreeUri,
            opaqueTreeUri,
            opaqueCoveredUri,
        ).forEach { uri ->
            enforcingApp.grantPersistable(uri, persistRw)
        }

        val workspaceKey = "startup-guard-${System.nanoTime()}".also(workspaceKeys::add)
        val initialStore = ViewModelStore().also(viewModels::add)
        val initialModel = StudioViewModel(enforcingApp, workspaceKey).also {
            it.readerFlushRequester = { true }
            initialStore.put("initial", it)
        }
        initialModel.reading(autosave = false)
        initialModel.setFolder(opaqueTreeUri)
        await { initialModel.state.value.files.any { it.name == "opaque_doc_1.md" } }

        for (uri in listOf(revokedCleanUri, revokedDraftUri, readOnlyUri, directValidUri, folderCoveredUri)) {
            initialModel.open(uri)
            await { initialModel.state.value.tabs.any { it.uri != null && sameDocument(Uri.parse(it.uri), uri) } }
        }
        initialModel.open(opaqueCoveredUri, relative = "opaque_doc_1.md")
        await { initialModel.state.value.tabs.any { it.uri != null && sameDocument(Uri.parse(it.uri), opaqueCoveredUri) } }

        val cleanId = initialModel.state.value.tabs.single { it.uri != null && sameDocument(Uri.parse(it.uri), revokedCleanUri) }.id
        val draftId = initialModel.state.value.tabs.single { it.uri != null && sameDocument(Uri.parse(it.uri), revokedDraftUri) }.id
        val readOnlyId = initialModel.state.value.tabs.single { it.uri != null && sameDocument(Uri.parse(it.uri), readOnlyUri) }.id
        val directId = initialModel.state.value.tabs.single { it.uri != null && sameDocument(Uri.parse(it.uri), directValidUri) }.id
        val folderCoveredId = initialModel.state.value.tabs.single { it.uri != null && sameDocument(Uri.parse(it.uri), folderCoveredUri) }.id
        val opaqueCoveredId = initialModel.state.value.tabs.single { it.uri != null && sameDocument(Uri.parse(it.uri), opaqueCoveredUri) }.id

        val draftContent = "# Draft baseline\nUnsaved paragraph before cold restart.\n"
        initialModel.edit(draftId, draftContent)
        assertTrue(kotlinx.coroutines.runBlocking { initialModel.flushRecoveryAndAwait() })
        initialStore.clear()
        shadowOf(Looper.getMainLooper()).idle()

        // Revoke grants while the app is not running:
        enforcingApp.revokeAll(revokedCleanUri)
        enforcingApp.revokeAll(revokedDraftUri)
        enforcingApp.downgradeToReadOnly(readOnlyUri)
        enforcingApp.revokeAll(folderCoveredUri) // Covered by persisted extTreeUri (primary:vault)
        enforcingApp.revokeAll(opaqueCoveredUri) // Covered by persisted opaqueTreeUri (opaque_root)

        val restoredStore = ViewModelStore().also(viewModels::add)
        val restoredModel = StudioViewModel(enforcingApp, workspaceKey).also {
            it.readerFlushRequester = { true }
            restoredStore.put("restored", it)
        }

        await {
            restoredModel.documentWriteNeedsAccess(cleanId) &&
                restoredModel.documentWriteNeedsAccess(draftId) &&
                restoredModel.documentWriteNeedsAccess(readOnlyId)
        }

        // Revoked and read-only notes are seeded in blockedDocumentWrites + StudioState without losing cached text or drafts.
        assertTrue(restoredModel.state.value.writeNeedsAccess(cleanId))
        assertTrue(restoredModel.state.value.writeNeedsAccess(draftId))
        assertTrue(restoredModel.state.value.writeNeedsAccess(readOnlyId))
        assertNull("Startup seeding must not display unsolicited modal dialogs", restoredModel.documentAccessRequests.value)

        val restoredClean = restoredModel.state.value.tabs.single { it.id == cleanId }
        assertEquals("# Clean cached note\n", restoredClean.content)
        assertEquals("# Clean cached note\n", restoredClean.saved)
        assertFalse(restoredClean.dirty)

        val restoredDraft = restoredModel.state.value.tabs.single { it.id == draftId }
        assertEquals(draftContent, restoredDraft.content)
        assertEquals("# Draft baseline\n", restoredDraft.saved)
        assertTrue(restoredDraft.dirty)

        // Direct valid grant and both containing-folder grants (ExternalStorage + confirmed opaque tree) remain unblocked ("Saved").
        assertFalse(restoredModel.documentWriteNeedsAccess(directId))
        assertFalse(restoredModel.documentWriteNeedsAccess(folderCoveredId))
        assertFalse(restoredModel.documentWriteNeedsAccess(opaqueCoveredId))

        // Reusing the existing reauthorization flow unblocks the restored note while preserving its draft.
        restoredModel.saveManual(noteId = draftId)
        await { restoredModel.documentAccessRequests.value?.noteId == draftId }
        val request = restoredModel.documentAccessRequests.value!!
        assertTrue(request.writing)

        enforcingApp.grantPersistable(revokedDraftUri, persistRw)
        restoredModel.restoreDocumentAccess(request, revokedDraftUri)
        await { restoredModel.documentAccessRequests.value == null && !restoredModel.documentWriteNeedsAccess(draftId) }
        assertFalse(restoredModel.state.value.writeNeedsAccess(draftId))
        assertEquals(draftContent, restoredModel.state.value.tabs.single { it.id == draftId }.content)
    }

    @Test
    fun externalRefreshSeedsBlockedWritesOnPermissionDenialWhileKeepingOrdinaryProviderErrorsDistinct() {
        val refreshAuthority = "dev.supermd.test.refresh.guard.${System.nanoTime()}"
        val refreshProvider = StartupGuardDocumentProvider(root).also {
            it.attach(app, refreshAuthority)
        }
        ShadowContentResolver.registerProviderInternal(refreshAuthority, refreshProvider)

        val grantedUris = mutableMapOf<Uri, Int>()
        val persistedUris = mutableMapOf<Uri, Int>()
        val enforcingApp = StartupEnforcingApplication(app, grantedUris, persistedUris)
        refreshProvider.permissionChecker = { uri, required ->
            enforcingApp.checkUriPermission(uri, android.os.Process.myPid(), android.os.Process.myUid(), required) ==
                android.content.pm.PackageManager.PERMISSION_GRANTED
        }

        val persistRw = Intent.FLAG_GRANT_READ_URI_PERMISSION or
            Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
            Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION

        val cleanMdUri = refreshProvider.putDoc("Clean.md", "# Clean markdown\n")
        val dirtyMdUri = refreshProvider.putDoc("Dirty.md", "# Dirty baseline\n")
        val cleanSmdFile = File(root, "Bundle.smd")
        val media = MediaStorage(app)
        val svgData = media.portableImageData(
            "image/svg+xml",
            "<svg xmlns='http://www.w3.org/2000/svg'><rect width='4' height='4'/></svg>".toByteArray(),
        )
        cleanSmdFile.outputStream().use {
            media.writeFmd(it, "# Portable baseline\n", org.json.JSONObject().put("assets/box.svg", svgData))
        }
        val cleanSmdUri = refreshProvider.registerExistingFile("Bundle.smd", cleanSmdFile)

        listOf(cleanMdUri, dirtyMdUri, cleanSmdUri).forEach { enforcingApp.grantPersistable(it, persistRw) }

        val store = ViewModelStore().also(viewModels::add)
        val key = "refresh-guard-${System.nanoTime()}".also(workspaceKeys::add)
        val model = StudioViewModel(enforcingApp, key).also {
            it.readerFlushRequester = { true }
            store.put("model", it)
        }
        model.reading(autosave = false)

        for (uri in listOf(cleanMdUri, dirtyMdUri, cleanSmdUri)) {
            model.open(uri)
            await { model.state.value.tabs.any { it.uri == uri.toString() } }
        }
        val cleanMdId = model.state.value.tabs.single { it.uri == cleanMdUri.toString() }.id
        val dirtyMdId = model.state.value.tabs.single { it.uri == dirtyMdUri.toString() }.id
        val cleanSmdId = model.state.value.tabs.single { it.uri == cleanSmdUri.toString() }.id
        val originalSmdDir = model.state.value.tabs.single { it.id == cleanSmdId }.assetDirectory
        assertNotNull(originalSmdDir)

        val unsavedDraft = "# Dirty baseline\nLocal unsaved draft.\n"
        model.edit(dirtyMdId, unsavedDraft)

        // 1. Ordinary provider errors (FileNotFoundException, IOException, corrupt archive, IllegalStateException)
        // must NOT seed blockedDocumentWrites or open documentAccessRequests.
        val originalSmdBytes = cleanSmdFile.readBytes()
        cleanSmdFile.writeBytes("corrupt-not-a-valid-smd-archive".toByteArray())
        refreshProvider.ordinaryFailureByDocId["Clean.md"] = { java.io.FileNotFoundException("Transient missing replica") }
        refreshProvider.ordinaryFailureByDocId["Dirty.md"] = { IllegalStateException("Provider temporarily busy") }

        var committedCount = 0
        kotlinx.coroutines.runBlocking {
            model.refreshExternalTabs(model.state.value.tabs) { committedCount++ }
        }
        assertEquals(1, committedCount)
        assertFalse(model.documentWriteNeedsAccess(cleanMdId))
        assertFalse(model.documentWriteNeedsAccess(dirtyMdId))
        assertFalse(model.documentWriteNeedsAccess(cleanSmdId))
        assertNull(model.documentAccessRequests.value)
        assertEquals("# Clean markdown\n", model.state.value.tabs.single { it.id == cleanMdId }.content)
        assertEquals(unsavedDraft, model.state.value.tabs.single { it.id == dirtyMdId }.content)
        assertEquals("# Portable baseline\n", model.state.value.tabs.single { it.id == cleanSmdId }.content)
        assertEquals(originalSmdDir, model.state.value.tabs.single { it.id == cleanSmdId }.assetDirectory)

        // Restore valid archive bytes and clear ordinary failures.
        cleanSmdFile.writeBytes(originalSmdBytes)
        refreshProvider.ordinaryFailureByDocId.clear()

        // 2. Actual permission denials (revoked SAF grants / EACCES) during external refresh seed blocked writes
        // while preserving cached text, portable assets, and unsaved drafts.
        enforcingApp.revokeAll(cleanMdUri)
        enforcingApp.revokeAll(cleanSmdUri)
        refreshProvider.ordinaryFailureByDocId["Dirty.md"] = {
            SecurityException("Permission denial wrapping EACCES", android.system.ErrnoException("open", android.system.OsConstants.EACCES))
        }

        model.refreshExternal(immediate = true)
        await {
            model.documentWriteNeedsAccess(cleanMdId) &&
                model.documentWriteNeedsAccess(dirtyMdId) &&
                model.documentWriteNeedsAccess(cleanSmdId)
        }
        assertTrue(model.state.value.writeNeedsAccess(cleanMdId))
        assertTrue(model.state.value.writeNeedsAccess(dirtyMdId))
        assertTrue(model.state.value.writeNeedsAccess(cleanSmdId))
        assertNull("Background refresh must not pop an unsolicited modal dialog", model.documentAccessRequests.value)

        assertEquals("# Clean markdown\n", model.state.value.tabs.single { it.id == cleanMdId }.content)
        assertEquals(unsavedDraft, model.state.value.tabs.single { it.id == dirtyMdId }.content)
        assertEquals("# Dirty baseline\n", model.state.value.tabs.single { it.id == dirtyMdId }.saved)
        assertEquals("# Portable baseline\n", model.state.value.tabs.single { it.id == cleanSmdId }.content)
        assertEquals(originalSmdDir, model.state.value.tabs.single { it.id == cleanSmdId }.assetDirectory)

        // 3. Passive read-only refresh must not clear an active write block; explicit reauthorization via
        // restoreDocumentAccess verifies read-write access and clears the blocked state cleanly.
        refreshProvider.ordinaryFailureByDocId.clear()
        enforcingApp.grantPersistable(cleanMdUri, persistRw)
        model.refreshExternal(cleanMdUri, immediate = true)
        await { !model.isRefreshExternalActive() }
        assertTrue("Passive read-only refresh must not silently clear blocked writes", model.documentWriteNeedsAccess(cleanMdId))

        model.requestWriteAccessIfBlocked(cleanMdId, explicit = true)
        val recoveryRequest = model.documentAccessRequests.value!!
        model.restoreDocumentAccess(recoveryRequest, cleanMdUri)
        await { model.documentAccessRequests.value == null && !model.documentWriteNeedsAccess(cleanMdId) }
        assertFalse(model.state.value.writeNeedsAccess(cleanMdId))
    }

    @Test
    fun restoredAccessStatePreservesGrantedNativeLinkResolutionAndPendingHeadingHandoff() {
        val extProvider = StartupGuardDocumentProvider(root).also {
            it.attach(app, EXTERNAL_STORAGE_DOCUMENTS_AUTHORITY)
        }
        ShadowContentResolver.registerProviderInternal(EXTERNAL_STORAGE_DOCUMENTS_AUTHORITY, extProvider)

        val grantedUris = mutableMapOf<Uri, Int>()
        val persistedUris = mutableMapOf<Uri, Int>()
        val enforcingApp = StartupEnforcingApplication(app, grantedUris, persistedUris)
        extProvider.permissionChecker = { uri, required ->
            enforcingApp.checkUriPermission(uri, android.os.Process.myPid(), android.os.Process.myUid(), required) ==
                android.content.pm.PackageManager.PERMISSION_GRANTED
        }

        val persistRw = Intent.FLAG_GRANT_READ_URI_PERMISSION or
            Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
            Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION

        val vaultTreeUri = DocumentsContract.buildTreeDocumentUri(EXTERNAL_STORAGE_DOCUMENTS_AUTHORITY, "primary:course")
        val vaultIndexUri = extProvider.putDoc(
            "primary:course/Index.md",
            "# Index\n\n[[Lecture 2#bayes]]\n",
            parentId = "primary:course",
        )
        val vaultLectureUri = extProvider.putDoc(
            "primary:course/Lecture 2.md",
            "# Lecture 2\n\n## Bayes\n",
            parentId = "primary:course",
        )
        val standaloneIndexUri = extProvider.putDoc(
            "primary:standalone/Hub.md",
            "# Hub\n\n[Draft](RevokedDraft.md#proof)\n[Unopened](UnopenedSibling.md#lemma)\n",
        )
        val revokedDraftUri = extProvider.putDoc(
            "primary:standalone/RevokedDraft.md",
            "# Baseline\n\n## Proof\n",
        )
        val unopenedSiblingUri = extProvider.putDoc(
            "primary:standalone/UnopenedSibling.md",
            "# Sibling\n\n## Lemma\n",
        )

        listOf(vaultTreeUri, vaultIndexUri, vaultLectureUri, standaloneIndexUri, revokedDraftUri).forEach {
            enforcingApp.grantPersistable(it, persistRw)
        }

        val workspaceKey = "link-handoff-${System.nanoTime()}".also(workspaceKeys::add)
        val initialStore = ViewModelStore().also(viewModels::add)
        val initialModel = StudioViewModel(enforcingApp, workspaceKey).also {
            it.readerFlushRequester = { true }
            initialStore.put("initial", it)
        }
        initialModel.reading(autosave = false)
        for (uri in listOf(vaultIndexUri, standaloneIndexUri, revokedDraftUri)) {
            initialModel.open(uri)
            await { initialModel.state.value.tabs.any { it.uri != null && sameDocument(Uri.parse(it.uri), uri) } }
        }
        val draftId = initialModel.state.value.tabs.single { it.uri != null && sameDocument(Uri.parse(it.uri), revokedDraftUri) }.id
        val draftText = "# Baseline\n\n## Proof\n\nUnsaved local derivation.\n"
        initialModel.edit(draftId, draftText)
        assertTrue(kotlinx.coroutines.runBlocking { initialModel.flushRecoveryAndAwait() })
        initialStore.clear()
        shadowOf(Looper.getMainLooper()).idle()

        // Revoke individual note grants while keeping vaultTreeUri and standaloneIndexUri valid.
        enforcingApp.revokeAll(vaultIndexUri)
        enforcingApp.revokeAll(vaultLectureUri)
        enforcingApp.revokeAll(revokedDraftUri)

        val restoredStore = ViewModelStore().also(viewModels::add)
        val restoredModel = StudioViewModel(enforcingApp, workspaceKey).also {
            it.readerFlushRequester = { true }
            restoredStore.put("restored", it)
        }
        await { restoredModel.documentWriteNeedsAccess(draftId) }
        val vaultIndexId = restoredModel.state.value.tabs.single { it.uri != null && sameDocument(Uri.parse(it.uri), vaultIndexUri) }.id
        assertFalse("Containing-folder grant keeps restored note unblocked", restoredModel.documentWriteNeedsAccess(vaultIndexId))

        fun callLink(docPath: String, target: String, fragment: String, wikilink: Boolean): org.json.JSONObject {
            val outcome = java.util.concurrent.atomic.AtomicReference<Result<org.json.JSONObject>?>()
            kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.IO).launch {
                outcome.set(runCatching { restoredModel.openWorkspaceLink(docPath, target, fragment, wikilink) })
            }
            await { outcome.get() != null }
            return outcome.get()!!.getOrThrow()
        }

        // 1. Granted containing-folder native link resolution opens sibling note and hands off pendingHeading.
        val treeReply = callLink(vaultIndexUri.toString(), "Lecture 2", "bayes", wikilink = true)
        assertTrue(treeReply.getBoolean("opened"))
        await { restoredModel.state.value.active.uri?.let { sameDocument(Uri.parse(it), vaultLectureUri) } == true }
        val lectureNote = restoredModel.state.value.active
        assertFalse(restoredModel.documentWriteNeedsAccess(lectureNote.id))
        val lectureHeading = restoredModel.state.value.pendingHeading
        assertNotNull(lectureHeading)
        assertEquals(lectureNote.id, lectureHeading!!.noteId)
        assertEquals("bayes", lectureHeading.heading)
        restoredModel.consumePendingHeading(lectureHeading.token)
        assertNull(restoredModel.state.value.pendingHeading)

        // 2. Link to restored tab with revoked grant prompts for access, then restoreDocumentAccess preserves
        // unchanged cached draft text, activates the tab, and hands off pendingHeading.
        val draftReply = callLink(standaloneIndexUri.toString(), "RevokedDraft.md", "proof", wikilink = false)
        assertFalse(draftReply.getBoolean("opened"))
        val draftRequest = restoredModel.documentAccessRequests.value
        assertNotNull(draftRequest)
        assertEquals(draftId, draftRequest!!.noteId)
        assertFalse(draftRequest.writing)

        // Granting read-only first keeps write blocked while still preserving draft + handing off heading.
        enforcingApp.downgradeToReadOnly(revokedDraftUri)
        restoredModel.restoreDocumentAccess(draftRequest, revokedDraftUri)
        await { restoredModel.documentAccessRequests.value == null && restoredModel.state.value.active.id == draftId }
        assertEquals(draftText, restoredModel.state.value.active.content)
        assertEquals("# Baseline\n\n## Proof\n", restoredModel.state.value.active.saved)
        assertTrue("Read-only restore must preserve blocked-write state", restoredModel.documentWriteNeedsAccess(draftId))
        val draftHeading = restoredModel.state.value.pendingHeading
        assertNotNull(draftHeading)
        assertEquals(draftId, draftHeading!!.noteId)
        assertEquals("proof", draftHeading.heading)
        restoredModel.consumePendingHeading(draftHeading.token)

        // Upgrading to read-write clears blocked-write state while keeping draft text intact.
        restoredModel.requestWriteAccessIfBlocked(draftId, explicit = true)
        val writeRequest = restoredModel.documentAccessRequests.value!!
        enforcingApp.grantPersistable(revokedDraftUri, persistRw)
        restoredModel.restoreDocumentAccess(writeRequest, revokedDraftUri)
        await { restoredModel.documentAccessRequests.value == null && !restoredModel.documentWriteNeedsAccess(draftId) }
        assertEquals(draftText, restoredModel.state.value.tabs.single { it.id == draftId }.content)

        // 3. Link to unopened sibling without folder grant prompts and hands off pendingHeading on restoreDocumentAccess.
        val unopenedReply = callLink(standaloneIndexUri.toString(), "UnopenedSibling.md", "lemma", wikilink = false)
        assertFalse(unopenedReply.getBoolean("opened"))
        val unopenedRequest = restoredModel.documentAccessRequests.value!!
        assertNull(unopenedRequest.noteId)
        enforcingApp.grantPersistable(unopenedSiblingUri, persistRw)
        restoredModel.restoreDocumentAccess(unopenedRequest, unopenedSiblingUri)
        await { restoredModel.state.value.active.uri?.let { sameDocument(Uri.parse(it), unopenedSiblingUri) } == true }
        val siblingHeading = restoredModel.state.value.pendingHeading
        assertNotNull(siblingHeading)
        assertEquals(restoredModel.state.value.active.id, siblingHeading!!.noteId)
        assertEquals("lemma", siblingHeading.heading)
        restoredModel.consumePendingHeading(siblingHeading.token)

        // 4. If a containing-folder tree grant is later revoked while a restored tab still carries an embedded tree URI,
        // openWorkspaceLink falls back cleanly from the revoked tree to standalone sibling access / prompt + pendingHeading.
        val revokedTreeUri = DocumentsContract.buildTreeDocumentUri(EXTERNAL_STORAGE_DOCUMENTS_AUTHORITY, "primary:revoked-vault")
        val treeHubPlainUri = extProvider.putDoc(
            "primary:revoked-vault/Hub.md",
            "# Vault Hub\n\n[Target](Target.md#corollary)\n",
            parentId = "primary:revoked-vault",
        )
        val treeTargetPlainUri = extProvider.putDoc(
            "primary:revoked-vault/Target.md",
            "# Target\n\n## Corollary\n",
            parentId = "primary:revoked-vault",
        )
        val embeddedHubUri = DocumentsContract.buildDocumentUriUsingTree(revokedTreeUri, "primary:revoked-vault/Hub.md")
        enforcingApp.grantPersistable(revokedTreeUri, persistRw)
        restoredModel.open(embeddedHubUri)
        await { restoredModel.state.value.active.uri == embeddedHubUri.toString() }

        // Revoke the folder tree grant and grant standalone access to Hub.md + Target.md.
        enforcingApp.revokeAll(revokedTreeUri)
        enforcingApp.grantPersistable(treeHubPlainUri, persistRw)
        enforcingApp.grantPersistable(treeTargetPlainUri, persistRw)

        val fallbackReply = callLink(embeddedHubUri.toString(), "Target.md", "corollary", wikilink = false)
        assertTrue("Revoked embedded tree must fall back to standalone granted sibling", fallbackReply.getBoolean("opened"))
        await { restoredModel.state.value.active.uri?.let { sameDocument(Uri.parse(it), treeTargetPlainUri) } == true }
        val fallbackHeading = restoredModel.state.value.pendingHeading
        assertNotNull(fallbackHeading)
        assertEquals(restoredModel.state.value.active.id, fallbackHeading!!.noteId)
        assertEquals("corollary", fallbackHeading.heading)
        restoredModel.consumePendingHeading(fallbackHeading.token)

        // 5. Cold-start MainActivity.onResume() refreshExternal(immediate = true) concurrently with an opaque
        // third-party containing-folder projection must await initialFolderLoadJob and keep covered notes unblocked.
        val opaqueAuthority = "dev.supermd.test.opaque.coldstart.${System.nanoTime()}"
        val opaqueProvider = StartupGuardDocumentProvider(root).also { it.attach(app, opaqueAuthority) }
        ShadowContentResolver.registerProviderInternal(opaqueAuthority, opaqueProvider)
        opaqueProvider.permissionChecker = extProvider.permissionChecker
        val opaqueTreeUri = DocumentsContract.buildTreeDocumentUri(opaqueAuthority, "opaque-root")
        val opaqueNotePlainUri = opaqueProvider.putDoc("opaque-doc-42", "# Opaque Covered\n", parentId = "opaque-root")
        enforcingApp.grantPersistable(opaqueTreeUri, persistRw)
        enforcingApp.grantPersistable(opaqueNotePlainUri, persistRw)

        val opaqueKey = "opaque-coldstart-${System.nanoTime()}".also(workspaceKeys::add)
        val opaqueSetupStore = ViewModelStore().also(viewModels::add)
        val opaqueSetupModel = StudioViewModel(enforcingApp, opaqueKey).also {
            it.readerFlushRequester = { true }
            opaqueSetupStore.put("opaque-setup", it)
        }
        // Open plain URI BEFORE setFolder so workspace.json stores the plain document URI, then set opaque folder.
        opaqueSetupModel.open(opaqueNotePlainUri)
        await { opaqueSetupModel.state.value.tabs.any { it.uri == opaqueNotePlainUri.toString() } }
        opaqueSetupModel.setFolder(opaqueTreeUri)
        await { opaqueSetupModel.state.value.files.any { it.name == "opaque-doc-42.md" } }
        val opaqueCoveredId = opaqueSetupModel.state.value.tabs.single { it.uri != null && sameDocument(Uri.parse(it.uri), opaqueNotePlainUri) }.id
        assertTrue(kotlinx.coroutines.runBlocking { opaqueSetupModel.flushRecoveryAndAwait() })
        opaqueSetupStore.clear()
        shadowOf(Looper.getMainLooper()).idle()

        // Revoke direct plain grant while keeping opaque folder tree grant valid, then cold-restore + immediate refreshExternal.
        enforcingApp.revokeAll(opaqueNotePlainUri)
        val opaqueRestoredStore = ViewModelStore().also(viewModels::add)
        val opaqueRestoredModel = StudioViewModel(enforcingApp, opaqueKey).also {
            it.readerFlushRequester = { true }
            opaqueRestoredStore.put("opaque-restored", it)
        }
        opaqueRestoredModel.refreshExternal(immediate = true)
        await { !opaqueRestoredModel.isRefreshExternalActive() && !opaqueRestoredModel.isStartupAccessSeedActive() }
        assertFalse(
            "Cold-start refreshExternal must await opaque folder projection and keep containing-folder note unblocked",
            opaqueRestoredModel.documentWriteNeedsAccess(opaqueCoveredId),
        )
    }

    @Test
    fun sharedFolderGrantAndWorkspaceLinkSelectionKeepWriteAccessStrictlyScoped() {
        val extProvider = StartupGuardDocumentProvider(root).also {
            it.attach(app, EXTERNAL_STORAGE_DOCUMENTS_AUTHORITY)
        }
        ShadowContentResolver.registerProviderInternal(EXTERNAL_STORAGE_DOCUMENTS_AUTHORITY, extProvider)

        val opaqueAuthority = "dev.supermd.test.opaque.scoped.${System.nanoTime()}"
        val opaqueProvider = StartupGuardDocumentProvider(root).also {
            it.attach(app, opaqueAuthority)
        }
        ShadowContentResolver.registerProviderInternal(opaqueAuthority, opaqueProvider)

        val grantedUris = mutableMapOf<Uri, Int>()
        val persistedUris = mutableMapOf<Uri, Int>()
        val enforcingApp = StartupEnforcingApplication(app, grantedUris, persistedUris)
        val checker: (Uri, Int) -> Boolean = { uri, required ->
            enforcingApp.checkUriPermission(uri, android.os.Process.myPid(), android.os.Process.myUid(), required) ==
                android.content.pm.PackageManager.PERMISSION_GRANTED
        }
        extProvider.permissionChecker = checker
        opaqueProvider.permissionChecker = checker

        val persistRw = Intent.FLAG_GRANT_READ_URI_PERMISSION or
            Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
            Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION

        val vaultTreeUri = DocumentsContract.buildTreeDocumentUri(EXTERNAL_STORAGE_DOCUMENTS_AUTHORITY, "primary:vault")
        val specsTreeUri = DocumentsContract.buildTreeDocumentUri(EXTERNAL_STORAGE_DOCUMENTS_AUTHORITY, "primary:vault/Specs")
        extProvider.putDir("primary:vault/Specs", "Specs", parentId = "primary:vault")
        val vaultIndexUri = extProvider.putDoc(
            "primary:vault/Index.md",
            "# Vault Index\n\n[[Sub Note#deep-section]]\n[[ReadOnlyNew#intro]]\n[[DirectWritable#keep-rw]]\n",
            parentId = "primary:vault",
        )
        val subNoteUri = extProvider.putDoc(
            "primary:vault/Specs/Sub Note.md",
            "# Sub Note\n\n## Deep Section\n",
            parentId = "primary:vault/Specs",
        )
        val readOnlyNewUri = extProvider.putDoc(
            "primary:vault/Specs/ReadOnlyNew.md",
            "# ReadOnlyNew\n\n## Intro\n",
            parentId = "primary:vault/Specs",
        )
        val directWritableUri = extProvider.putDoc(
            "primary:vault/Specs/DirectWritable.md",
            "# DirectWritable\n\n## Keep RW\n",
            parentId = "primary:vault/Specs",
        )
        val outsideUri = extProvider.putDoc(
            "primary:outside/Outside.md",
            "# Outside Vault\n",
            parentId = "primary:outside",
        )

        val opaqueTreeUri = DocumentsContract.buildTreeDocumentUri(opaqueAuthority, "opaque_root")
        val opaqueRealUri = opaqueProvider.putDoc("opaque_child_1", "# Opaque Real\n", parentId = "opaque_root")
        val opaqueUnlistedPrefixedUri = opaqueProvider.putDoc("opaque_root/unlisted_secret", "# Unlisted Secret\n", parentId = null)

        listOf(vaultIndexUri, subNoteUri, directWritableUri, outsideUri, opaqueRealUri, opaqueUnlistedPrefixedUri).forEach {
            enforcingApp.grantPersistable(it, persistRw)
        }

        val workspaceKey = "scoped-folder-links-${System.nanoTime()}".also(workspaceKeys::add)
        val store = ViewModelStore().also(viewModels::add)
        val model = StudioViewModel(enforcingApp, workspaceKey).also {
            it.readerFlushRequester = { true }
            store.put("model", it)
        }
        model.reading(autosave = false)

        for (uri in listOf(outsideUri, opaqueRealUri, opaqueUnlistedPrefixedUri, subNoteUri, vaultIndexUri)) {
            model.open(uri)
            await { model.state.value.tabs.any { it.uri != null && sameDocument(Uri.parse(it.uri), uri) } }
        }

        val indexId = model.state.value.tabs.single { it.uri != null && sameDocument(Uri.parse(it.uri), vaultIndexUri) }.id
        val subNoteId = model.state.value.tabs.single { it.uri != null && sameDocument(Uri.parse(it.uri), subNoteUri) }.id
        val outsideId = model.state.value.tabs.single { it.uri != null && sameDocument(Uri.parse(it.uri), outsideUri) }.id
        val opaqueRealId = model.state.value.tabs.single { it.uri != null && sameDocument(Uri.parse(it.uri), opaqueRealUri) }.id
        val opaqueUnlistedId = model.state.value.tabs.single { it.uri != null && sameDocument(Uri.parse(it.uri), opaqueUnlistedPrefixedUri) }.id

        val subNoteDraft = "# Sub Note\n\n## Deep Section\n\nLocal unsaved draft before revocation.\n"
        model.edit(subNoteId, subNoteDraft)

        // Revoke write access across the open tabs while keeping directWritableUri read-write.
        enforcingApp.downgradeToReadOnly(vaultIndexUri)
        enforcingApp.revokeAll(subNoteUri)
        enforcingApp.revokeAll(outsideUri)
        enforcingApp.revokeAll(opaqueRealUri)
        enforcingApp.revokeAll(opaqueUnlistedPrefixedUri)

        model.refreshExternal(immediate = true)
        await {
            !model.isRefreshExternalActive() &&
                model.documentWriteNeedsAccess(indexId) &&
                model.documentWriteNeedsAccess(subNoteId) &&
                model.documentWriteNeedsAccess(outsideId) &&
                model.documentWriteNeedsAccess(opaqueRealId) &&
                model.documentWriteNeedsAccess(opaqueUnlistedId)
        }

        fun callLink(docPath: String, target: String, fragment: String, wikilink: Boolean): org.json.JSONObject {
            val outcome = java.util.concurrent.atomic.AtomicReference<Result<org.json.JSONObject>?>()
            kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.IO).launch {
                outcome.set(runCatching { model.openWorkspaceLink(docPath, target, fragment, wikilink) })
            }
            await { outcome.get() != null }
            return outcome.get()!!.getOrThrow()
        }

        // 1. Following a nested wikilink without a folder grant surfaces folderAccessPrompt.
        model.select(indexId)
        await { model.state.value.active.id == indexId }
        val promptReply = callLink(vaultIndexUri.toString(), "Sub Note", "deep-section", wikilink = true)
        assertFalse(promptReply.getBoolean("opened"))
        assertTrue(promptReply.optBoolean("promptedFolderAccess"))
        val folderPrompt = model.state.value.folderAccessPrompt
        assertNotNull(folderPrompt)
        assertEquals("Sub Note", folderPrompt!!.target)
        assertEquals("deep-section", folderPrompt.fragment)

        // 2. Granting a READ-ONLY shared folder via grantWorkspaceFolderForLink opens/focuses Sub Note with its
        // draft and pendingHeading intact, while keeping every blocked tab write-blocked.
        enforcingApp.downgradeToReadOnly(vaultTreeUri)
        model.grantWorkspaceFolderForLink(vaultTreeUri)
        await {
            model.state.value.folderAccessPrompt == null &&
                model.state.value.active.id == subNoteId
        }
        assertEquals(subNoteDraft, model.state.value.active.content)
        val subHeading = model.state.value.pendingHeading
        assertNotNull(subHeading)
        assertEquals(subNoteId, subHeading!!.noteId)
        assertEquals("deep-section", subHeading.heading)
        model.consumePendingHeading(subHeading.token)
        assertTrue("Read-only folder grant must keep Sub Note write-blocked", model.documentWriteNeedsAccess(subNoteId))
        assertTrue("Read-only folder grant must keep Index write-blocked", model.documentWriteNeedsAccess(indexId))
        assertTrue("Outside note must remain write-blocked", model.documentWriteNeedsAccess(outsideId))

        // Newly opened note through the read-only folder must also be marked write-blocked (never falsely Saved),
        // while a note that already holds its own direct RW grant must keep RW and stay unblocked.
        val roNewReply = callLink(vaultIndexUri.toString(), "ReadOnlyNew", "intro", wikilink = true)
        assertTrue(roNewReply.getBoolean("opened"))
        await { model.state.value.active.name == "ReadOnlyNew.md" }
        val roNewId = model.state.value.active.id
        assertTrue("Note opened via read-only folder link must be write-blocked", model.documentWriteNeedsAccess(roNewId))
        model.state.value.pendingHeading?.token?.let(model::consumePendingHeading)

        val directRwReply = callLink(vaultIndexUri.toString(), "DirectWritable", "keep-rw", wikilink = true)
        assertTrue(directRwReply.getBoolean("opened"))
        await { model.state.value.active.name == "DirectWritable.md" }
        val directRwTab = model.state.value.active
        assertFalse("Direct RW standalone grant must not be downgraded by read-only folder link", model.documentWriteNeedsAccess(directRwTab.id))
        assertEquals(directWritableUri.toString(), directRwTab.uri)
        model.state.value.pendingHeading?.token?.let(model::consumePendingHeading)

        // 3. Granting RW to subfolder primary:vault/Specs unblocks notes inside Specs (Sub Note + ReadOnlyNew),
        // while keeping parent primary:vault/Index.md and unrelated primary:outside/Outside.md write-blocked.
        enforcingApp.revokeAll(vaultTreeUri)
        enforcingApp.grantPersistable(specsTreeUri, persistRw)
        model.setFolder(specsTreeUri)
        await {
            model.state.value.folder == specsTreeUri.toString() &&
                !model.documentWriteNeedsAccess(subNoteId) &&
                !model.documentWriteNeedsAccess(roNewId)
        }
        assertEquals(subNoteDraft, model.state.value.tabs.single { it.id == subNoteId }.content)
        assertTrue("Parent folder note outside subfolder grant must stay write-blocked", model.documentWriteNeedsAccess(indexId))
        assertTrue("Outside note must stay write-blocked", model.documentWriteNeedsAccess(outsideId))

        // 4. Granting RW to parent primary:vault unblocks Index.md too, while provider-level 'rw' denial or outside paths stay blocked.
        extProvider.ordinaryFailureByDocId["primary:vault/Index.md"] = {
            SecurityException("Simulated provider rw denial", android.system.ErrnoException("open", android.system.OsConstants.EACCES))
        }
        enforcingApp.grantPersistable(vaultTreeUri, persistRw)
        model.setFolder(vaultTreeUri)
        await { model.state.value.folder == vaultTreeUri.toString() }
        assertTrue("Provider rw denial must prevent premature unblocking", model.documentWriteNeedsAccess(indexId))

        extProvider.ordinaryFailureByDocId.remove("primary:vault/Index.md")
        model.setFolder(vaultTreeUri)
        await { !model.documentWriteNeedsAccess(indexId) }
        assertFalse(model.documentWriteNeedsAccess(subNoteId))
        assertTrue("Note outside granted vault must still remain write-blocked", model.documentWriteNeedsAccess(outsideId))

        // 5. Opaque third-party folder grant unblocks only confirmed children and never unlisted prefix-matching IDs.
        enforcingApp.grantPersistable(opaqueTreeUri, persistRw)
        assertNull(
            "Opaque unlisted prefix ID must not match workspaceLinks.noteRelativeInTree",
            model.workspaceLinks.noteRelativeInTree(opaqueTreeUri, opaqueUnlistedPrefixedUri),
        )
        model.setFolder(opaqueTreeUri)
        await {
            model.state.value.folder == opaqueTreeUri.toString() &&
                !model.documentWriteNeedsAccess(opaqueRealId)
        }
        assertTrue(
            "Unlisted opaque document with root-prefixed ID must remain write-blocked",
            model.documentWriteNeedsAccess(opaqueUnlistedId),
        )
        assertTrue("ExternalStorage outside note must remain write-blocked", model.documentWriteNeedsAccess(outsideId))
    }

    @Test
    fun unconfirmedTreeCandidateFromWriteResolutionCannotSelfPromoteOrAffectLaterGrants() {
        val opaqueAuthority = "dev.supermd.test.opaque.unconfirmed.${System.nanoTime()}"
        val opaqueProvider = StartupGuardDocumentProvider(root).also {
            it.attach(app, opaqueAuthority)
        }
        ShadowContentResolver.registerProviderInternal(opaqueAuthority, opaqueProvider)

        val grantedUris = mutableMapOf<Uri, Int>()
        val persistedUris = mutableMapOf<Uri, Int>()
        val enforcingApp = StartupEnforcingApplication(app, grantedUris, persistedUris)
        opaqueProvider.permissionChecker = { uri, required ->
            enforcingApp.checkUriPermission(uri, android.os.Process.myPid(), android.os.Process.myUid(), required) ==
                android.content.pm.PackageManager.PERMISSION_GRANTED
        }

        val persistRw = Intent.FLAG_GRANT_READ_URI_PERMISSION or
            Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
            Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION

        val vaultTreeUri = DocumentsContract.buildTreeDocumentUri(opaqueAuthority, "vault_root")
        val confirmedChildPlainUri = opaqueProvider.putDoc("confirmed_member", "# Confirmed Member\n", parentId = "vault_root")
        val unconfirmedRegrantPlainUri = opaqueProvider.putDoc("outside_regrant_doc", "# Regrant Baseline\n", parentId = null)
        val unconfirmedOpenPlainUri = opaqueProvider.putDoc("outside_open_doc", "# Open Baseline\n", parentId = null)
        val unconfirmedProbePlainUri = opaqueProvider.putDoc("outside_probe_doc", "# Probe Baseline\n", parentId = null)
        val unconfirmedResRegrantPlainUri = opaqueProvider.putDoc("outside_res_regrant_doc", "# Res Regrant Baseline\n", parentId = null)
        val unconfirmedResOpenPlainUri = opaqueProvider.putDoc("outside_res_open_doc", "# Res Open Baseline\n", parentId = null)
        val unconfirmedResStandaloneRwPlainUri = opaqueProvider.putDoc("outside_res_standalone_rw_doc", "# Res Standalone RW\n", parentId = null)

        val unconfirmedRegrantTreeUri = DocumentsContract.buildDocumentUriUsingTree(vaultTreeUri, "outside_regrant_doc")
        val unconfirmedOpenTreeUri = DocumentsContract.buildDocumentUriUsingTree(vaultTreeUri, "outside_open_doc")
        val unconfirmedProbeTreeUri = DocumentsContract.buildDocumentUriUsingTree(vaultTreeUri, "outside_probe_doc")
        val unconfirmedResRegrantTreeUri = DocumentsContract.buildDocumentUriUsingTree(vaultTreeUri, "outside_res_regrant_doc")
        val unconfirmedResOpenTreeUri = DocumentsContract.buildDocumentUriUsingTree(vaultTreeUri, "outside_res_open_doc")
        val unconfirmedResStandaloneRwTreeUri = DocumentsContract.buildDocumentUriUsingTree(vaultTreeUri, "outside_res_standalone_rw_doc")

        val workspaceKey = "unconfirmed-tree-isolation-${System.nanoTime()}".also(workspaceKeys::add)
        val store = ViewModelStore().also(viewModels::add)
        val model = StudioViewModel(enforcingApp, workspaceKey).also {
            it.readerFlushRequester = { true }
            store.put("model", it)
        }
        model.reading(autosave = false)

        // Open confirmed_member, outside_regrant_doc, outside_res_regrant_doc, and outside_probe_doc with standalone RW first, then revoke.
        listOf(
            confirmedChildPlainUri,
            unconfirmedRegrantPlainUri,
            unconfirmedResRegrantPlainUri,
            unconfirmedProbePlainUri,
        ).forEach {
            enforcingApp.grantPersistable(it, persistRw)
            model.open(it)
            await { model.state.value.tabs.any { tab -> tab.uri != null && sameDocument(Uri.parse(tab.uri), it) } }
        }
        val confirmedTabId = model.state.value.tabs.single { it.uri != null && sameDocument(Uri.parse(it.uri), confirmedChildPlainUri) }.id
        val regrantTabId = model.state.value.tabs.single { it.uri != null && sameDocument(Uri.parse(it.uri), unconfirmedRegrantPlainUri) }.id
        val resRegrantTabId = model.state.value.tabs.single { it.uri != null && sameDocument(Uri.parse(it.uri), unconfirmedResRegrantPlainUri) }.id
        val probeTabId = model.state.value.tabs.single { it.uri != null && sameDocument(Uri.parse(it.uri), unconfirmedProbePlainUri) }.id

        val regrantDraft = "# Regrant Baseline\nUnsaved local draft during read regrant.\n"
        val resRegrantDraft = "# Res Regrant Baseline\nUnsaved local draft during plain read regrant.\n"
        val probeDraft = "# Probe Baseline\nUnsaved local draft during failed probe.\n"
        model.edit(regrantTabId, regrantDraft)
        model.edit(resRegrantTabId, resRegrantDraft)
        model.edit(probeTabId, probeDraft)

        enforcingApp.revokeAll(confirmedChildPlainUri)
        enforcingApp.revokeAll(unconfirmedRegrantPlainUri)
        enforcingApp.revokeAll(unconfirmedResRegrantPlainUri)
        enforcingApp.revokeAll(unconfirmedProbePlainUri)
        model.refreshExternal(immediate = true)
        await {
            !model.isRefreshExternalActive() &&
                model.documentWriteNeedsAccess(confirmedTabId) &&
                model.documentWriteNeedsAccess(regrantTabId) &&
                model.documentWriteNeedsAccess(resRegrantTabId) &&
                model.documentWriteNeedsAccess(probeTabId)
        }

        // Install a DocumentAccess wrapper where write resolution returns an unconfirmed tree-qualified URI
        // even when resolving plain document URIs on the fake provider.
        val baseAccess = model.documentAccess
        val unconfirmedWriteCandidateDocIds = setOf(
            "outside_probe_doc",
            "outside_res_regrant_doc",
            "outside_res_open_doc",
            "outside_res_standalone_rw_doc",
        )
        model.documentAccess = object : DocumentAccess(
            context = enforcingApp,
            activeFolderUriProvider = baseAccess.activeFolderUriProvider,
            relativeHintProvider = baseAccess.relativeHintProvider,
            isConfirmedTreeChildProvider = baseAccess.isConfirmedTreeChildProvider,
            onConfirmedTreeKeys = baseAccess.onConfirmedTreeKeys,
        ) {
            override fun resolve(uri: Uri, writing: Boolean): Uri {
                val resolved = super.resolve(uri, writing)
                if (writing && uri.authority == opaqueAuthority) {
                    val docId = runCatching { DocumentsContract.getDocumentId(uri) }.getOrNull()
                    if (docId != null && docId in unconfirmedWriteCandidateDocIds) {
                        return DocumentsContract.buildDocumentUriUsingTree(vaultTreeUri, docId)
                    }
                }
                return resolved
            }
        }

        // 1. Failed write probe on both plain read-regrant and plain/tree note-open (including provider rw rejection):
        //    write resolution returns unconfirmedProbeTreeUri; failed verification must retain blocked state,
        //    keep tab.uri unpromoted, AND leave zero poisoned membership entries behind.
        enforcingApp.downgradeToReadOnly(unconfirmedProbePlainUri)
        opaqueProvider.writeFailureDocIds.add("outside_probe_doc")
        assertEquals(unconfirmedProbeTreeUri, model.documentAccess.resolve(unconfirmedProbePlainUri, writing = true))

        model.open(unconfirmedProbePlainUri)
        await { model.state.value.active.id == probeTabId }
        assertTrue("Read-only reopen must keep probe note write-blocked", model.documentWriteNeedsAccess(probeTabId))
        assertEquals(unconfirmedProbePlainUri.toString(), model.state.value.tabs.single { it.id == probeTabId }.uri)

        enforcingApp.revokeAll(unconfirmedProbePlainUri)
        model.open(unconfirmedProbePlainUri)
        await { model.documentAccessRequests.value?.noteId == probeTabId }
        val probeReadRequest = model.documentAccessRequests.value!!
        assertFalse(probeReadRequest.writing)

        enforcingApp.downgradeToReadOnly(unconfirmedProbePlainUri)
        model.restoreDocumentAccess(probeReadRequest, unconfirmedProbePlainUri)
        await { model.documentAccessRequests.value == null }
        assertEquals(probeDraft, model.state.value.tabs.single { it.id == probeTabId }.content)
        assertEquals(unconfirmedProbePlainUri.toString(), model.state.value.tabs.single { it.id == probeTabId }.uri)
        assertTrue(
            "Failed write probe during plain read-regrant must retain blocked write state",
            model.documentWriteNeedsAccess(probeTabId),
        )

        // Also run read-regrant and note-open with direct unconfirmedProbeTreeUri while write probe fails.
        enforcingApp.revokeAll(unconfirmedProbePlainUri)
        model.open(unconfirmedProbePlainUri)
        await { model.documentAccessRequests.value?.noteId == probeTabId }
        val probeTreeReadRequest = model.documentAccessRequests.value!!
        enforcingApp.downgradeToReadOnly(unconfirmedProbePlainUri)
        model.restoreDocumentAccess(probeTreeReadRequest, unconfirmedProbeTreeUri)
        await { model.documentAccessRequests.value == null }
        assertEquals(unconfirmedProbePlainUri.toString(), model.state.value.tabs.single { it.id == probeTabId }.uri)
        assertTrue(
            "Failed write probe during tree-candidate read-regrant must retain blocked write state",
            model.documentWriteNeedsAccess(probeTabId),
        )
        model.open(unconfirmedProbeTreeUri)
        await { model.state.value.active.id == probeTabId }
        assertEquals(unconfirmedProbePlainUri.toString(), model.state.value.tabs.single { it.id == probeTabId }.uri)
        assertTrue(
            "Failed write probe during blocked note-open must retain blocked write state",
            model.documentWriteNeedsAccess(probeTabId),
        )

        // 2. Grant RW to vaultTreeUri and clear the provider rw rejection! Even though OS URI permission checks
        //    now allow rw on tree/vault_root/*, write resolution returning an unconfirmed tree-qualified URI must
        //    NEVER self-promote or unblock on plain read-regrant, plain note-open, plain standalone-RW open, or
        //    direct tree-URI open/regrant!
        opaqueProvider.writeFailureDocIds.remove("outside_probe_doc")
        enforcingApp.grantPersistable(vaultTreeUri, persistRw)

        // 2a. Plain note-open + write-regrant where write resolution returns unconfirmedResOpenTreeUri:
        enforcingApp.downgradeToReadOnly(unconfirmedResOpenPlainUri)
        assertEquals(unconfirmedResOpenTreeUri, model.documentAccess.resolve(unconfirmedResOpenPlainUri, writing = true))
        model.open(unconfirmedResOpenPlainUri)
        await { model.state.value.tabs.any { it.uri != null && sameDocument(Uri.parse(it.uri), unconfirmedResOpenPlainUri) } }
        val resOpenTab = model.state.value.tabs.single { it.uri != null && sameDocument(Uri.parse(it.uri), unconfirmedResOpenPlainUri) }
        val resOpenTabId = resOpenTab.id
        assertEquals(
            "Plain note-open must not promote tab URI to unconfirmed tree writeTarget",
            unconfirmedResOpenPlainUri.toString(),
            resOpenTab.uri,
        )
        assertTrue(
            "Plain note-open with unconfirmed tree writeTarget must remain write-blocked",
            model.documentWriteNeedsAccess(resOpenTabId),
        )
        val resOpenDraft = "# Res Open Baseline\nDraft kept while write resolution returns unconfirmed tree URI.\n"
        model.edit(resOpenTabId, resOpenDraft)
        opaqueProvider.writeFailureDocIds.add("outside_res_open_doc")
        model.open(unconfirmedResOpenPlainUri)
        await { model.state.value.active.id == resOpenTabId }
        assertTrue(
            "Blocked plain note-open with failed probe on unconfirmed writeTarget must retain blocked state",
            model.documentWriteNeedsAccess(resOpenTabId),
        )
        opaqueProvider.writeFailureDocIds.remove("outside_res_open_doc")
        model.open(unconfirmedResOpenPlainUri)
        await { model.state.value.active.id == resOpenTabId }
        assertEquals(unconfirmedResOpenPlainUri.toString(), model.state.value.tabs.single { it.id == resOpenTabId }.uri)
        assertTrue(
            "Blocked plain note-open must still retain blocked state when write resolution returns unconfirmed tree URI",
            model.documentWriteNeedsAccess(resOpenTabId),
        )
        // Direct save() must reject the unconfirmed tree writeTarget, fall back to the read-only plain URI,
        // leave the on-disk baseline untouched, and prompt for write access without self-promoting tab.uri.
        var directSaveOutcome: String? = null
        model.save(noteId = resOpenTabId) { directSaveOutcome = it ?: "ok" }
        await { directSaveOutcome != null }
        assertTrue("Direct save must fail rather than writing via unconfirmed tree writeTarget", directSaveOutcome != "ok")
        assertTrue(model.state.value.tabs.single { it.id == resOpenTabId }.dirty)
        assertNotNull(model.documentAccessRequests.value)
        val resExplicitWriteRequest = model.documentAccessRequests.value!!
        assertTrue(resExplicitWriteRequest.writing)
        assertEquals(unconfirmedResOpenPlainUri.toString(), model.state.value.tabs.single { it.id == resOpenTabId }.uri)
        assertTrue(
            "Direct save must not promote or unblock via unconfirmed tree writeTarget",
            model.documentWriteNeedsAccess(resOpenTabId),
        )
        model.restoreDocumentAccess(resExplicitWriteRequest, unconfirmedResOpenPlainUri)
        await { model.documentAccessRequests.value?.detail != null }
        assertTrue(
            "Write-regrant whose write resolution returns an unconfirmed tree URI must reject self-promotion and retain blocked state",
            model.documentWriteNeedsAccess(resOpenTabId),
        )
        model.dismissDocumentAccess()

        // 2b. Plain read-regrant where write resolution returns unconfirmedResRegrantTreeUri while vaultTreeUri holds RW:
        model.open(unconfirmedResRegrantPlainUri)
        await { model.documentAccessRequests.value?.noteId == resRegrantTabId }
        val resRegrantReadRequest = model.documentAccessRequests.value!!
        assertFalse(resRegrantReadRequest.writing)
        enforcingApp.downgradeToReadOnly(unconfirmedResRegrantPlainUri)
        assertEquals(unconfirmedResRegrantTreeUri, model.documentAccess.resolve(unconfirmedResRegrantPlainUri, writing = true))
        model.restoreDocumentAccess(resRegrantReadRequest, unconfirmedResRegrantPlainUri)
        await { model.documentAccessRequests.value == null }
        val restoredResRegrantTab = model.state.value.tabs.single { it.id == resRegrantTabId }
        assertEquals(resRegrantDraft, restoredResRegrantTab.content)
        assertEquals(
            "Read-regrant must not promote tab URI to unconfirmed tree writeCandidate",
            unconfirmedResRegrantPlainUri.toString(),
            restoredResRegrantTab.uri,
        )
        assertTrue(
            "Unconfirmed tree writeCandidate from write resolution during plain read-regrant must not self-promote or unblock",
            model.documentWriteNeedsAccess(resRegrantTabId),
        )

        // 2c. Standalone-RW plain document where write resolution returns unconfirmedResStandaloneRwTreeUri:
        //     must remain writable via its plain grant WITHOUT promoting tab.uri or poisoning tree membership!
        enforcingApp.grantPersistable(unconfirmedResStandaloneRwPlainUri, persistRw)
        assertEquals(unconfirmedResStandaloneRwTreeUri, model.documentAccess.resolve(unconfirmedResStandaloneRwPlainUri, writing = true))
        model.open(unconfirmedResStandaloneRwPlainUri)
        await { model.state.value.tabs.any { it.uri != null && sameDocument(Uri.parse(it.uri), unconfirmedResStandaloneRwPlainUri) } }
        val standaloneRwTab = model.state.value.tabs.single { it.uri != null && sameDocument(Uri.parse(it.uri), unconfirmedResStandaloneRwPlainUri) }
        val standaloneRwTabId = standaloneRwTab.id
        assertEquals(
            "Standalone-RW plain open must not promote tab URI to unconfirmed tree writeTarget",
            unconfirmedResStandaloneRwPlainUri.toString(),
            standaloneRwTab.uri,
        )
        assertFalse(
            "Standalone-RW plain note must stay writable via its own plain grant",
            model.documentWriteNeedsAccess(standaloneRwTabId),
        )
        val standaloneSavedDraft = "# Res Standalone RW\nSaved directly via standalone plain grant.\n"
        model.edit(standaloneRwTabId, standaloneSavedDraft)
        var standaloneSaveError: String? = "pending"
        model.save(noteId = standaloneRwTabId) { standaloneSaveError = it }
        await { standaloneSaveError != "pending" }
        assertNull("Standalone-RW plain save must succeed via its plain grant", standaloneSaveError)
        assertEquals(
            "Saving standalone-RW plain note must not promote tab URI to unconfirmed tree writeTarget",
            unconfirmedResStandaloneRwPlainUri.toString(),
            model.state.value.tabs.single { it.id == standaloneRwTabId }.uri,
        )
        assertFalse(
            "Unconfirmed tree writeTarget must still not count as confirmed write grant",
            model.documentAccess.hasWriteGrant(unconfirmedResStandaloneRwTreeUri),
        )
        assertTrue(
            "Unconfirmed tree writeTarget must remain PendingTreeMembership rather than InGrantedTree",
            model.documentAccess.resolveReadAccess(unconfirmedResStandaloneRwTreeUri) is SafReadAccess.PendingTreeMembership,
        )
        assertFalse(
            "Unconfirmed tree writeTarget must not populate confirmed tree membership cache",
            baseAccess.isConfirmedTreeChildProvider?.invoke(vaultTreeUri, "outside_res_standalone_rw_doc") == true,
        )

        // Restore default DocumentAccess and verify direct unconfirmed tree-qualified URI inputs as well.
        model.documentAccess = baseAccess
        val standaloneProbeAccess = DocumentAccess(enforcingApp)

        // 2d. Direct unconfirmedOpenTreeUri note-open + write-regrant + refreshExternal:
        assertEquals(unconfirmedOpenTreeUri, standaloneProbeAccess.resolve(unconfirmedOpenTreeUri, writing = true))
        model.open(unconfirmedOpenTreeUri)
        await { model.state.value.tabs.any { it.uri != null && sameDocument(Uri.parse(it.uri), unconfirmedOpenPlainUri) } }
        val openTabId = model.state.value.tabs.single { it.uri != null && sameDocument(Uri.parse(it.uri), unconfirmedOpenPlainUri) }.id
        assertTrue(
            "Unconfirmed tree-qualified URI opened under RW folder grant must not self-promote to writable",
            model.documentWriteNeedsAccess(openTabId),
        )
        val openDraft = "# Open Baseline\nDraft kept while unconfirmed tree URI remains blocked.\n"
        model.edit(openTabId, openDraft)
        opaqueProvider.writeFailureDocIds.add("outside_open_doc")
        model.open(unconfirmedOpenTreeUri)
        await { model.state.value.active.id == openTabId }
        assertEquals(openDraft, model.state.value.tabs.single { it.id == openTabId }.content)
        assertTrue(
            "Blocked note-open with failed rw probe on unconfirmed tree URI must retain blocked state",
            model.documentWriteNeedsAccess(openTabId),
        )
        opaqueProvider.writeFailureDocIds.remove("outside_open_doc")
        model.open(unconfirmedOpenTreeUri)
        await { model.state.value.active.id == openTabId }
        assertTrue(
            "Blocked note-open on unconfirmed tree URI must still retain blocked state without tree enumeration proof",
            model.documentWriteNeedsAccess(openTabId),
        )
        assertTrue(model.requestWriteAccessIfBlocked(openTabId, explicit = true))
        val explicitWriteRequest = model.documentAccessRequests.value!!
        assertTrue(explicitWriteRequest.writing)
        model.restoreDocumentAccess(explicitWriteRequest, unconfirmedOpenTreeUri)
        await { model.documentAccessRequests.value?.detail != null }
        assertTrue(
            "Write-regrant with unconfirmed tree URI must reject self-promotion and retain blocked state",
            model.documentWriteNeedsAccess(openTabId),
        )
        model.dismissDocumentAccess()

        // 2e. Direct unconfirmedRegrantTreeUri read-regrant while vaultTreeUri holds RW:
        model.open(unconfirmedRegrantPlainUri)
        await { model.documentAccessRequests.value?.noteId == regrantTabId }
        val regrantReadRequest = model.documentAccessRequests.value!!
        assertFalse(regrantReadRequest.writing)

        enforcingApp.downgradeToReadOnly(unconfirmedRegrantPlainUri)
        assertEquals(unconfirmedRegrantTreeUri, standaloneProbeAccess.resolve(unconfirmedRegrantTreeUri, writing = true))
        model.restoreDocumentAccess(regrantReadRequest, unconfirmedRegrantTreeUri)
        await { model.documentAccessRequests.value == null }
        val regrantTab = model.state.value.tabs.single { it.id == regrantTabId }
        assertEquals(regrantDraft, regrantTab.content)
        assertEquals(
            "Read-regrant with unconfirmed tree URI must preserve readable plain URI instead of rebinding to tree URI",
            unconfirmedRegrantPlainUri.toString(),
            regrantTab.uri,
        )
        assertTrue(
            "Unconfirmed tree-qualified writeCandidate during read-regrant must not self-promote or unblock",
            model.documentWriteNeedsAccess(regrantTabId),
        )

        // 3. Downgrade standaloneRwTabId to read-only so refreshExternal verifies it becomes write-blocked without
        //    falling back to vaultTreeUri, then revoke standalone grants on all outside_* documents and apply
        //    vaultTreeUri as the workspace folder. ONLY truly enumerated children (confirmed_member) may be unblocked!
        enforcingApp.downgradeToReadOnly(unconfirmedResStandaloneRwPlainUri)
        model.refreshExternal(immediate = true)
        await {
            !model.isRefreshExternalActive() &&
                model.documentWriteNeedsAccess(standaloneRwTabId)
        }
        listOf(
            unconfirmedProbePlainUri,
            unconfirmedRegrantPlainUri,
            unconfirmedResRegrantPlainUri,
            unconfirmedResOpenPlainUri,
            unconfirmedResStandaloneRwPlainUri,
        ).forEach(enforcingApp::revokeAll)
        model.setFolder(vaultTreeUri)
        await {
            model.state.value.folder == vaultTreeUri.toString() &&
                !model.documentWriteNeedsAccess(confirmedTabId)
        }
        assertTrue(
            "Earlier failed probe on outside_probe_doc must not affect later vaultTreeUri grant",
            model.documentWriteNeedsAccess(probeTabId),
        )
        assertTrue(
            "Earlier unconfirmed read-regrant on outside_regrant_doc must not affect vaultTreeUri grant",
            model.documentWriteNeedsAccess(regrantTabId),
        )
        assertTrue(
            "Earlier unconfirmed plain read-regrant on outside_res_regrant_doc must not affect vaultTreeUri grant",
            model.documentWriteNeedsAccess(resRegrantTabId),
        )
        assertTrue(
            "Earlier unconfirmed plain note-open on outside_res_open_doc must not affect vaultTreeUri grant",
            model.documentWriteNeedsAccess(resOpenTabId),
        )
        assertTrue(
            "Earlier standalone-RW note with unconfirmed writeTarget must not affect vaultTreeUri grant after plain revoke",
            model.documentWriteNeedsAccess(standaloneRwTabId),
        )
        assertTrue(
            "Earlier unconfirmed note-open on outside_open_doc must not affect vaultTreeUri grant",
            model.documentWriteNeedsAccess(openTabId),
        )

        // Workspace link resolution from confirmed_member inside vaultTreeUri must NOT open an unconfirmed outside document.
        val confirmedTabUri = model.state.value.tabs.single { it.id == confirmedTabId }.uri!!
        var linkResult: org.json.JSONObject? = null
        kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Main.immediate).launch {
            linkResult = model.openWorkspaceLink(
                documentPath = confirmedTabUri,
                target = "./outside_res_open_doc.md",
                fragment = "",
                wikilink = false,
                allowFolderPrompt = false,
            )
        }
        await { linkResult != null }
        assertFalse(
            "Earlier unconfirmed write-resolution candidate must not allow workspace link resolution inside vaultTreeUri",
            linkResult!!.optBoolean("opened", true),
        )

        // Attempting to open plain outside_probe_doc after revoking its standalone grant must NOT resolve via vaultTreeUri.
        model.dismissDocumentAccess()
        model.open(unconfirmedProbePlainUri)
        await { model.documentAccessRequests.value?.noteId == probeTabId }
        assertEquals(probeDraft, model.state.value.tabs.single { it.id == probeTabId }.content)
    }

    private fun newModel(): StudioViewModel {
        val store = ViewModelStore().also(viewModels::add)
        val key = "document-access-${System.nanoTime()}".also(workspaceKeys::add)
        val model = StudioViewModel(app, key)
        // Opening/saving in this test does not need a WebView, but the model
        // still requires an explicit successful reader flush acknowledgement.
        model.readerFlushRequester = { true }
        store.put("model", model)
        return model
    }

    private fun openBaseline(model: StudioViewModel): String {
        model.open(noteUri)
        await { model.state.value.tabs.any { it.uri == noteUri.toString() } }
        val note = model.state.value.tabs.single { it.uri == noteUri.toString() }
        assertEquals(provider.baseline, note.content)
        assertEquals(provider.baseline, note.saved)
        return note.id
    }

    private fun replaceNote(model: StudioViewModel, id: String, edit: (Note) -> Note) {
        val field = StudioViewModel::class.java.getDeclaredField("mutable").apply { isAccessible = true }
        @Suppress("UNCHECKED_CAST")
        val flow = field.get(model) as kotlinx.coroutines.flow.MutableStateFlow<StudioState>
        flow.value = flow.value.copy(tabs = flow.value.tabs.map { if (it.id == id) edit(it) else it })
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

private class FailingDocumentProvider(private val directory: File) : ContentProvider() {
    val baseline = "# Saved baseline\n"
    val noteFile = File(directory, "Note.md").apply { writeText(baseline) }
    val otherFile = File(directory, "Other.md").apply { writeText("other note") }
    var failRead = false
    var failWrite = false
    var writeAttempts = 0

    fun attach(context: Context, authority: String) {
        val info = ProviderInfo().apply { this.authority = authority; exported = true; grantUriPermissions = true }
        attachInfo(context, info)
    }

    override fun onCreate() = true

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor {
        val columns = projection?.toList() ?: listOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        val id = DocumentsContract.getDocumentId(uri).substringAfterLast('/')
        val file = if (id == "Other.md") otherFile else noteFile
        return MatrixCursor(columns.toTypedArray()).apply {
            addRow(columns.map { column -> when (column) {
                OpenableColumns.DISPLAY_NAME -> file.name
                OpenableColumns.SIZE -> file.length()
                else -> null
            } }.toTypedArray<Any?>())
        }
    }

    override fun getType(uri: Uri) = "text/markdown"
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        val id = DocumentsContract.getDocumentId(uri).substringAfterLast('/')
        val file = if (id == "Other.md") otherFile else noteFile
        val writing = mode != "r"
        if (writing) writeAttempts++
        if (writing && failWrite) throw SecurityException("test provider write denied")
        if (!writing && failRead) throw SecurityException("test provider read denied")
        val flags = when (mode) {
            "r" -> ParcelFileDescriptor.MODE_READ_ONLY
            "rw" -> ParcelFileDescriptor.MODE_READ_WRITE
            "wt", "w" -> ParcelFileDescriptor.MODE_WRITE_ONLY or ParcelFileDescriptor.MODE_CREATE or ParcelFileDescriptor.MODE_TRUNCATE
            else -> throw java.io.FileNotFoundException("Unsupported test mode: $mode")
        }
        return ParcelFileDescriptor.open(file, flags)
    }
}

private class StartupEnforcingApplication(
    base: android.app.Application,
    private val grantedUris: MutableMap<Uri, Int>,
    private val persistedUris: MutableMap<Uri, Int>,
) : android.app.Application() {
    init {
        attachBaseContext(base)
    }

    fun grantPersistable(uri: Uri, flags: Int) {
        val access = flags and (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        grantUriPermission(packageName, uri, flags)
        persistedUris[uri] = (persistedUris[uri] ?: 0) or access
        contentResolver.takePersistableUriPermission(uri, access)
    }

    fun downgradeToReadOnly(uri: Uri) {
        revokeAll(uri)
        val readPersist = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
        grantUriPermission(packageName, uri, readPersist)
        persistedUris[uri] = Intent.FLAG_GRANT_READ_URI_PERMISSION
        contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }

    fun revokeAll(uri: Uri) {
        val rw = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        runCatching { contentResolver.releasePersistableUriPermission(uri, rw) }
        runCatching { contentResolver.releasePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
        runCatching { contentResolver.releasePersistableUriPermission(uri, Intent.FLAG_GRANT_WRITE_URI_PERMISSION) }
        revokeUriPermission(uri, rw or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        grantedUris.remove(uri)
        persistedUris.remove(uri)
    }

    override fun grantUriPermission(toPackage: String?, uri: Uri?, modeFlags: Int) {
        super.grantUriPermission(toPackage, uri, modeFlags)
        if (uri != null) {
            val access = modeFlags and (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            grantedUris[uri] = (grantedUris[uri] ?: 0) or access
        }
    }

    override fun revokeUriPermission(uri: Uri?, modeFlags: Int) {
        super.revokeUriPermission(uri, modeFlags)
        if (uri != null) {
            val remaining = (grantedUris[uri] ?: 0) and modeFlags.inv()
            if (remaining == 0) grantedUris.remove(uri) else grantedUris[uri] = remaining
        }
    }

    override fun checkUriPermission(uri: Uri?, pid: Int, uid: Int, modeFlags: Int): Int {
        if (uri == null) return android.content.pm.PackageManager.PERMISSION_DENIED
        val combined = buildMap<Uri, Int> {
            grantedUris.forEach { (k, v) -> put(k, v) }
            persistedUris.forEach { (k, v) -> put(k, (get(k) ?: 0) or v) }
        }
        val held = combined.entries
            .filter { (granted, _) ->
                granted == uri || (DocumentsContract.isTreeUri(granted) && uri.toString().startsWith("$granted/"))
            }
            .fold(0) { acc, (_, flags) -> acc or flags }
        return if ((held and modeFlags) == modeFlags) {
            android.content.pm.PackageManager.PERMISSION_GRANTED
        } else {
            android.content.pm.PackageManager.PERMISSION_DENIED
        }
    }
}

private class StartupGuardDocumentProvider(private val rootDirectory: File) : ContentProvider() {
    private data class DocEntry(
        val docId: String,
        val displayName: String,
        val file: File,
        val parentId: String?,
        val isDirectory: Boolean = false,
    )

    private lateinit var providerAuthority: String
    private val docs = linkedMapOf<String, DocEntry>()
    val ordinaryFailureByDocId = linkedMapOf<String, () -> Throwable>()
    val writeFailureDocIds = linkedSetOf<String>()
    var permissionChecker: ((Uri, Int) -> Boolean)? = null

    fun attach(context: Context, authority: String) {
        providerAuthority = authority
        val info = ProviderInfo().apply {
            this.authority = authority
            exported = true
            grantUriPermissions = true
        }
        attachInfo(context, info)
    }

    fun putDoc(docId: String, content: String, parentId: String? = null): Uri {
        val cleanName = docId.substringAfterLast(':').substringAfterLast('/').let {
            if ('.' in it) it else "$it.md"
        }
        val safePath = docId.replace(':', '_')
        val file = File(rootDirectory, safePath).apply {
            parentFile?.mkdirs()
            writeText(content, Charsets.UTF_8)
        }
        docs[docId] = DocEntry(docId, cleanName, file, parentId)
        return DocumentsContract.buildDocumentUri(providerAuthority, docId)
    }

    fun putDir(docId: String, displayName: String, parentId: String? = null): Uri {
        val dir = File(rootDirectory, docId.replace(':', '_')).apply { mkdirs() }
        docs[docId] = DocEntry(docId, displayName, dir, parentId, isDirectory = true)
        return DocumentsContract.buildDocumentUri(providerAuthority, docId)
    }

    fun registerExistingFile(docId: String, file: File, parentId: String? = null): Uri {
        docs[docId] = DocEntry(docId, file.name, file, parentId)
        return DocumentsContract.buildDocumentUri(providerAuthority, docId)
    }

    override fun onCreate(): Boolean = true

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor {
        permissionChecker?.let { check ->
            if (!check(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)) {
                throw SecurityException("Permission denied querying $uri")
            }
        }
        val cols = projection ?: arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            OpenableColumns.SIZE,
        )
        if ("/children" in uri.path.orEmpty()) {
            val segments = uri.pathSegments
            val idx = segments.lastIndexOf("document")
            val parentDocId = if (idx >= 0 && idx + 1 < segments.size) Uri.decode(segments[idx + 1]) else DocumentsContract.getTreeDocumentId(uri)
            return MatrixCursor(cols).apply {
                docs.values.filter { it.parentId == parentDocId }.forEach { entry ->
                    addRow(rowFor(cols, entry))
                }
            }
        }
        val docId = DocumentsContract.getDocumentId(uri)
        ordinaryFailureByDocId[docId]?.invoke()?.let { throw it }
        val entry = docs[docId] ?: throw java.io.FileNotFoundException("Missing $docId")
        return MatrixCursor(cols).apply { addRow(rowFor(cols, entry)) }
    }

    private fun rowFor(cols: Array<out String>, entry: DocEntry): Array<Any?> =
        cols.map { col ->
            when (col) {
                DocumentsContract.Document.COLUMN_DOCUMENT_ID -> entry.docId
                DocumentsContract.Document.COLUMN_DISPLAY_NAME, OpenableColumns.DISPLAY_NAME -> entry.displayName
                DocumentsContract.Document.COLUMN_MIME_TYPE -> when {
                    entry.isDirectory -> DocumentsContract.Document.MIME_TYPE_DIR
                    entry.displayName.endsWith(".smd") -> "application/vnd.supermd.smd"
                    else -> "text/markdown"
                }
                OpenableColumns.SIZE, DocumentsContract.Document.COLUMN_SIZE -> entry.file.length()
                else -> null
            }
        }.toTypedArray()

    override fun getType(uri: Uri): String {
        val docId = runCatching { DocumentsContract.getDocumentId(uri) }.getOrNull()
        val name = docs[docId]?.displayName.orEmpty()
        return if (name.endsWith(".smd", ignoreCase = true)) "application/vnd.supermd.smd" else "text/markdown"
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        val required = if (mode == "r") Intent.FLAG_GRANT_READ_URI_PERMISSION else Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        permissionChecker?.let { check ->
            if (!check(uri, required)) {
                throw SecurityException("Permission denied opening $uri (mode=$mode)")
            }
        }
        val docId = DocumentsContract.getDocumentId(uri)
        if (mode != "r" && docId in writeFailureDocIds) {
            throw SecurityException("Provider denied write probe for $uri")
        }
        ordinaryFailureByDocId[docId]?.invoke()?.let { throw it }
        val entry = docs[docId] ?: throw java.io.FileNotFoundException("Missing $docId")
        val flags = when (mode) {
            "r" -> ParcelFileDescriptor.MODE_READ_ONLY
            "rw" -> ParcelFileDescriptor.MODE_READ_WRITE
            "wt", "w" -> ParcelFileDescriptor.MODE_WRITE_ONLY or ParcelFileDescriptor.MODE_CREATE or ParcelFileDescriptor.MODE_TRUNCATE
            else -> ParcelFileDescriptor.parseMode(mode)
        }
        return ParcelFileDescriptor.open(entry.file, flags)
    }
}
