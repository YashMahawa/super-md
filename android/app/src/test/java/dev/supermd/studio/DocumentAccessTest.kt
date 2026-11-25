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
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
        grantedUris[opaqueTree] = Intent.FLAG_GRANT_READ_URI_PERMISSION
        grantedUris[colonTree] = Intent.FLAG_GRANT_READ_URI_PERMISSION
        app.contentResolver.takePersistableUriPermission(opaqueTree, Intent.FLAG_GRANT_READ_URI_PERMISSION)

        val opaquePathLikeChild = DocumentsContract.buildDocumentUriUsingTree(opaqueTree, "archive/2026/doc_path")
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

        val confirmedSet = setOf("archive/2026/doc_path", "root_opaque-child", "opaque_child")
        val confirmFn: (Uri, String) -> Boolean = { _, id -> id in confirmedSet }
        assertTrue(access.resolveReadAccess(opaquePathLikeChild, isConfirmedTreeChild = confirmFn) is SafReadAccess.InGrantedTree)
        assertTrue(access.resolveReadAccess(opaquePrefixLikeChild, isConfirmedTreeChild = confirmFn) is SafReadAccess.InGrantedTree)
        assertTrue(access.resolveReadAccess(opaqueColonRootChild, isConfirmedTreeChild = confirmFn) is SafReadAccess.InGrantedTree)
        assertTrue(access.hasReadGrant(opaquePathLikeChild, isConfirmedTreeChild = confirmFn))

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

        // Out-of-tree plain URI on the same provider must NOT upgrade to vaultTree.
        assertEquals(plainOutside, access.resolve(plainOutside, writing = false))
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
