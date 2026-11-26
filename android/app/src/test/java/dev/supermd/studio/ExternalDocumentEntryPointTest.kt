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
import androidx.core.content.FileProvider
import androidx.lifecycle.ViewModelStore
import java.io.File
import java.nio.file.Files
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
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowContentResolver

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ExternalDocumentEntryPointTest {
    private lateinit var rawApp: Application
    private lateinit var app: EnforcingTestApplication
    private lateinit var grantedUris: MutableMap<Uri, Int>
    private lateinit var publicDir: File
    private lateinit var providerRoot: File
    private lateinit var authority: String
    private lateinit var provider: EntryPointDocumentProvider
    private lateinit var plainNoteUri: Uri
    private lateinit var secondNoteUri: Uri
    private lateinit var portableNoteUri: Uri
    private lateinit var treeUri: Uri
    private lateinit var treeContainedNoteUri: Uri
    private var previousAutosave: Boolean? = null
    private var previousRecent: String? = null
    private val workspaceKeys = mutableListOf<String>()
    private val viewModels = mutableListOf<ViewModelStore>()
    private val portableDirectories = mutableListOf<String>()

    @Before
    fun setUp() {
        rawApp = RuntimeEnvironment.getApplication()
        grantedUris = mutableMapOf()
        app = EnforcingTestApplication(rawApp, grantedUris)
        publicDir = Files.createTempDirectory("supermd-external-public").toFile()
        providerRoot = Files.createTempDirectory("supermd-entry-provider").toFile()
        authority = "dev.supermd.test.entry.${System.nanoTime()}"
        plainNoteUri = DocumentsContract.buildDocumentUri(authority, "vault/Note.md")
        secondNoteUri = DocumentsContract.buildDocumentUri(authority, "vault/Second.md")
        portableNoteUri = DocumentsContract.buildDocumentUri(authority, "vault/Archive.smd")
        treeUri = DocumentsContract.buildTreeDocumentUri(authority, "vault")
        treeContainedNoteUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, "vault/Note.md")

        val media = MediaStorage(app)
        val svgBytes = "<svg xmlns='http://www.w3.org/2000/svg'><circle r='4'/></svg>".toByteArray()
        val portableFile = File(providerRoot, "Archive.smd")
        portableFile.outputStream().use { out ->
            media.writeFmd(
                out,
                "# Portable external note\n\n![diagram](assets/diagram.svg)\n",
                JSONObject().put("assets/diagram.svg", media.portableImageData("image/svg+xml", svgBytes)),
            )
        }

        provider = EntryPointDocumentProvider(providerRoot, portableFile).also { it.attach(rawApp, authority) }
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
        publicDir.deleteRecursively()
        providerRoot.deleteRecursively()
        workspaceKeys.forEach { File(app.filesDir, "workspaces/$it").deleteRecursively() }
        portableDirectories.forEach { File(app.filesDir, "portable-assets/$it").deleteRecursively() }
    }

    @Test
    fun ordinaryGrantedContentNotesOpenViaInitialAndFollowUpExternalIntentsWithoutPersistingTemporaryGrants() {
        val model = newModel(attachOpenHandler = false)
        app.grantUriPermission(app.packageName, plainNoteUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        app.grantUriPermission(app.packageName, portableNoteUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)

        val initialIntent = Intent(Intent.ACTION_VIEW, plainNoteUri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        ExternalDocumentEntryGuard.dispatchIncomingIntent(
            context = app,
            incoming = initialIntent,
            savedInstanceState = null,
            initial = true,
            targetModel = model,
        )

        // Attach the reader handler just like Compose does once WebView is ready.
        attachModelOpenHandler(model)
        await { model.state.value.active.uri == plainNoteUri.toString() }

        assertEquals("# First external note\n", model.state.value.active.content)
        assertEquals("Note.md", model.state.value.active.name)
        assertNull(model.state.value.error)
        assertTrue(
            "Temporary ACTION_VIEW read grants without FLAG_GRANT_PERSISTABLE_URI_PERMISSION must not persist",
            app.contentResolver.persistedUriPermissions.none { it.uri == plainNoteUri },
        )

        val newIntent = Intent(Intent.ACTION_VIEW, portableNoteUri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        ExternalDocumentEntryGuard.dispatchIncomingIntent(
            context = app,
            incoming = newIntent,
            savedInstanceState = null,
            initial = false,
            targetModel = model,
        )
        await { model.state.value.active.uri == portableNoteUri.toString() }

        val openedPortable = model.state.value.active
        openedPortable.assetDirectory?.let(portableDirectories::add)
        assertTrue(openedPortable.portable)
        assertEquals("# Portable external note\n\n![diagram](assets/diagram.svg)\n", openedPortable.content)
        assertEquals("Archive.smd", openedPortable.name)
        assertNull(model.state.value.error)
    }

    @Test
    fun externalIntentOfferingPersistableGrantPersistsOnlyLiveGrantedModes() {
        // ShadowContentResolver has persistable READ+WRITE available, while live checkUriPermission only grants READ.
        rawApp.grantUriPermission(
            rawApp.packageName,
            plainNoteUri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION or
                Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION,
        )
        grantedUris[plainNoteUri] = Intent.FLAG_GRANT_READ_URI_PERMISSION
        val incoming = Intent(Intent.ACTION_EDIT, plainNoteUri).addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION or
                Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION,
        )

        val model = newModel(attachOpenHandler = true)
        ExternalDocumentEntryGuard.dispatchIncomingIntent(app, incoming, savedInstanceState = null, initial = true, targetModel = model)
        await { model.state.value.active.uri == plainNoteUri.toString() }

        val persisted = app.contentResolver.persistedUriPermissions.firstOrNull { it.uri == plainNoteUri }
        assertNotNull(persisted)
        assertTrue(persisted!!.isReadPermission)
        assertFalse(persisted.isWritePermission)
    }

    @Test
    fun normalSystemPickerAndExistingFolderBackedNoteRestoresRemainPreserved() {
        val model = newModel(attachOpenHandler = true)

        // 1. Normal system picker (OpenDocument) calls retainDocumentAccess + requestOpen.
        val pickerGrant = Intent.FLAG_GRANT_READ_URI_PERMISSION or
            Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
            Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
        app.grantUriPermission(app.packageName, secondNoteUri, pickerGrant)
        model.retainDocumentAccess(secondNoteUri)
        model.requestOpen(secondNoteUri)
        await { model.state.value.active.uri == secondNoteUri.toString() }
        assertEquals("# Second note\n", model.state.value.active.content)
        assertTrue(app.contentResolver.persistedUriPermissions.any { it.uri == secondNoteUri && it.isReadPermission })

        // 2. Existing note restore via internal model.open(plainNoteUri) still resolves through a
        //    persisted containing SAF folder grant when the individual document grant has expired.
        app.grantUriPermission(app.packageName, treeUri, pickerGrant)
        app.grantUriPermission(app.packageName, treeContainedNoteUri, pickerGrant)
        app.contentResolver.takePersistableUriPermission(
            treeUri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
        )
        // Note: plainNoteUri itself has NO direct grant; only the containing tree grant is active.
        model.open(plainNoteUri)
        await { model.state.value.tabs.any { it.uri == treeContainedNoteUri.toString() } }
        val restoredNote = model.state.value.tabs.single { it.uri == treeContainedNoteUri.toString() }
        assertEquals("# First external note\n", restoredNote.content)

        // 3. RestoreDocumentAccess flow preserves unsaved drafts when user re-picks the file.
        val unsavedDraft = "# Edited locally while grant lapsed\n"
        model.edit(restoredNote.id, unsavedDraft)
        provider.failRead = true
        model.open(plainNoteUri)
        await { model.documentAccessRequests.value != null }
        val request = model.documentAccessRequests.value!!
        assertEquals(restoredNote.id, request.noteId)

        provider.failRead = false
        app.grantUriPermission(app.packageName, plainNoteUri, pickerGrant)
        model.restoreDocumentAccess(request, plainNoteUri)
        await { model.documentAccessRequests.value == null }
        val afterRestore = model.state.value.tabs.single { it.id == restoredNote.id }
        assertEquals(unsavedDraft, afterRestore.content)
        assertNull(model.state.value.error)
    }

    @Test
    fun externalContentIntentWithoutCallerReadGrantFlagIsRejectedEvenWhenAppAlreadyHoldsFolderOrDirectGrant() {
        val model = newModel(attachOpenHandler = true)
        val grantFlags = Intent.FLAG_GRANT_READ_URI_PERMISSION or
            Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
            Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
        app.grantUriPermission(app.packageName, plainNoteUri, grantFlags)
        app.grantUriPermission(app.packageName, treeUri, grantFlags)
        app.grantUriPermission(app.packageName, treeContainedNoteUri, grantFlags)
        app.contentResolver.takePersistableUriPermission(
            treeUri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
        )
        val initialActiveId = model.state.value.active.id
        provider.openCount = 0

        // Caller sends ACTION_VIEW without FLAG_GRANT_READ_URI_PERMISSION.
        val ungrantedIntent = Intent(Intent.ACTION_VIEW, plainNoteUri)
        val decision = ExternalDocumentEntryGuard.validateIncomingIntent(app, ungrantedIntent)
        assertTrue(decision is ExternalDocumentDecision.Rejected)

        ExternalDocumentEntryGuard.dispatchIncomingIntent(app, ungrantedIntent, savedInstanceState = null, initial = false, targetModel = model)
        shadowOf(Looper.getMainLooper()).idle()

        assertEquals(0, provider.openCount)
        assertEquals(initialActiveId, model.state.value.active.id)
        assertFalse(model.state.value.tabs.any { it.uri == plainNoteUri.toString() || it.uri == treeContainedNoteUri.toString() })
        assertTrue(model.state.value.error?.contains("not granted", ignoreCase = true) == true)
    }

    @Test
    fun expiredExternalGrantNeverManufacturesTreeAccessAndSurfacesPickerRecoveryWithoutLosingDrafts() {
        val model = newModel(attachOpenHandler = true)
        val folderFlags = Intent.FLAG_GRANT_READ_URI_PERMISSION or
            Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
            Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
        // App holds a persisted SAF folder grant covering vault/Note.md, while plainNoteUri has NO live grant.
        app.grantUriPermission(app.packageName, treeUri, folderFlags)
        app.grantUriPermission(app.packageName, treeContainedNoteUri, folderFlags)
        app.contentResolver.takePersistableUriPermission(
            treeUri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
        )

        // Pre-open the note internally and create an unsaved draft to verify expired external intents never clobber it.
        app.grantUriPermission(app.packageName, plainNoteUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        model.open(plainNoteUri)
        await { sameDocument(Uri.parse(model.state.value.active.uri ?: "about:blank"), plainNoteUri) }
        val noteId = model.state.value.active.id
        val draft = "# Precious unsaved draft\n"
        model.edit(noteId, draft)
        app.revokeUriPermission(plainNoteUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        provider.openCount = 0

        // Case 1: Grant already expired when external Intent arrives at MainActivity.
        val expiredAtEntry = Intent(Intent.ACTION_VIEW, plainNoteUri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        val entryDecision = ExternalDocumentEntryGuard.validateIncomingIntent(app, expiredAtEntry)
        assertEquals(ExternalDocumentDecision.ExpiredGrant(plainNoteUri), entryDecision)

        ExternalDocumentEntryGuard.dispatchIncomingIntent(app, expiredAtEntry, savedInstanceState = null, initial = false, targetModel = model)
        await { model.documentAccessRequests.value != null }

        assertEquals(0, provider.openCount)
        val request = model.documentAccessRequests.value!!
        assertEquals(plainNoteUri.toString(), request.uri)
        assertEquals(noteId, request.noteId)
        assertFalse(request.writing)
        assertEquals(draft, model.state.value.tabs.single { it.id == noteId }.content)
        model.dismissDocumentAccess()

        // Case 2: Grant is live when queued in onCreate, then expires before WebView attaches open handler.
        val delayedModel = newModel(attachOpenHandler = false)
        app.grantUriPermission(app.packageName, secondNoteUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        val queuedIntent = Intent(Intent.ACTION_VIEW, secondNoteUri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        ExternalDocumentEntryGuard.dispatchIncomingIntent(app, queuedIntent, savedInstanceState = null, initial = true, targetModel = delayedModel)
        app.revokeUriPermission(secondNoteUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        provider.openCount = 0

        attachModelOpenHandler(delayedModel)
        await { delayedModel.documentAccessRequests.value != null }

        assertEquals(0, provider.openCount)
        assertEquals(secondNoteUri.toString(), delayedModel.documentAccessRequests.value!!.uri)
        assertFalse(delayedModel.state.value.tabs.any { it.uri == secondNoteUri.toString() })
    }

    @Test
    fun externalFileIntentAllowsNonPrivateFileAndRejectsAppPrivatePathsAndSymlinks() {
        val model = newModel(attachOpenHandler = true)

        // 1. Ordinary external non-private file:// note opens cleanly.
        val externalFile = File(publicDir, "PublicNote.md").apply { writeText("# Public file note\n") }
        val allowedIntent = Intent(Intent.ACTION_VIEW, Uri.fromFile(externalFile))
        assertTrue(ExternalDocumentEntryGuard.validateIncomingIntent(app, allowedIntent) is ExternalDocumentDecision.Allowed)
        ExternalDocumentEntryGuard.dispatchIncomingIntent(app, allowedIntent, savedInstanceState = null, initial = false, targetModel = model)
        await { model.state.value.active.uri == Uri.fromFile(externalFile).toString() }
        assertEquals("# Public file note\n", model.state.value.active.content)
        assertNull(model.state.value.error)

        // 2. Direct app-private & restricted system paths are rejected before reading any bytes.
        val privateSecret = File(app.filesDir, "workspaces/secret-workspace.json").apply {
            parentFile?.mkdirs()
            writeText("{\"secret\":true}")
        }
        val cacheSecret = File(app.cacheDir, "autosave-secret.md").apply { writeText("# Cached draft\n") }
        val prefsSecret = File(app.dataDir, "shared_prefs/studio.xml").apply {
            parentFile?.mkdirs()
            writeText("<map><string name=\"token\">secret</string></map>")
        }
        val symlinkToPrivate = File(publicDir, "innocent-link.md")
        Files.createSymbolicLink(symlinkToPrivate.toPath(), privateSecret.toPath())

        val forbiddenUris = listOf(
            Uri.fromFile(privateSecret),
            Uri.fromFile(cacheSecret),
            Uri.fromFile(prefsSecret),
            Uri.fromFile(symlinkToPrivate),
            Uri.parse("file:///data/data/${app.packageName}/files/workspaces/secret-workspace.json"),
            Uri.parse("file:///proc/self/cmdline"),
        )

        for (forbidden in forbiddenUris) {
            val intent = Intent(Intent.ACTION_VIEW, forbidden)
            val decision = ExternalDocumentEntryGuard.validateIncomingIntent(app, intent)
            assertTrue("Expected $forbidden to be rejected, got $decision", decision is ExternalDocumentDecision.Rejected)

            ExternalDocumentEntryGuard.dispatchIncomingIntent(app, intent, savedInstanceState = null, initial = false, targetModel = model)
            shadowOf(Looper.getMainLooper()).idle()
            assertFalse("Forbidden URI must never open as a tab: $forbidden", model.state.value.tabs.any { it.uri == forbidden.toString() })
            assertNotNull(model.state.value.error)
        }
    }

    @Test
    fun maliciousContentProviderRedirectingDescriptorToAppPrivateFileIsRejectedWhileGrantedShareUriWorks() {
        val model = newModel(attachOpenHandler = true)
        val privateTarget = File(app.filesDir, "workspaces/hijack.json").apply {
            parentFile?.mkdirs()
            writeText("# Secret private workspace state\n")
        }
        val evilAuthority = "com.attacker.redirect.${System.nanoTime()}"
        val evilProvider = PrivateFileRedirectProvider(privateTarget).also { it.attach(rawApp, evilAuthority) }
        ShadowContentResolver.registerProviderInternal(evilAuthority, evilProvider)
        val evilUri = Uri.parse("content://$evilAuthority/public-looking-note.md")
        app.grantUriPermission(app.packageName, evilUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)

        val evilIntent = Intent(Intent.ACTION_VIEW, evilUri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        ExternalDocumentEntryGuard.dispatchIncomingIntent(app, evilIntent, savedInstanceState = null, initial = false, targetModel = model)
        await { model.state.value.error != null }

        assertFalse(model.state.value.tabs.any { it.uri == evilUri.toString() })
        assertTrue(model.state.value.error!!.contains("App-private paths cannot be opened externally"))

        // Verify legitimate FileProvider share export inside cacheDir/share/:
        // On real Android OS, UriGrantsManagerService does not insert a dynamic UriPermission for
        // our own UID on ${packageName}.share. Authorized callers must open cleanly, while ungranted
        // external callers attempting confused-deputy access must fail.
        val shareAuthority = "${app.packageName}.share"
        val fileProvider = FileProvider()
        fileProvider.attachInfo(
            rawApp,
            ProviderInfo().apply {
                authority = shareAuthority
                exported = false
                grantUriPermissions = true
                metaData = android.os.Bundle().apply {
                    putInt("android.support.FILE_PROVIDER_PATHS", R.xml.share_paths)
                }
            },
        )
        ShadowContentResolver.registerProviderInternal(shareAuthority, fileProvider)
        val sharedNote = File(File(app.cacheDir, "share").apply { mkdirs() }, "SharedNote.md").apply {
            writeText("# Shared note via FileProvider\n")
        }
        val shareUri = FileProvider.getUriForFile(app, shareAuthority, sharedNote)
        val sameAppCaller = ExternalIntentCaller(uid = android.os.Process.myUid(), callerGrantedOwnShareUri = false)
        val untrustedExternalCaller = ExternalIntentCaller(uid = android.os.Process.myUid() + 1000, callerGrantedOwnShareUri = false)

        // 1. Without FLAG_GRANT_READ_URI_PERMISSION -> rejected even for same-app caller!
        val ungrantedShare = Intent(Intent.ACTION_VIEW, shareUri)
        assertTrue(ExternalDocumentEntryGuard.validateIncomingIntent(app, ungrantedShare, sameAppCaller) is ExternalDocumentDecision.Rejected)

        // 2. With FLAG_GRANT_READ_URI_PERMISSION, an ungranted external caller is denied (no confused deputy)!
        val grantedShare = Intent(Intent.ACTION_VIEW, shareUri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        assertEquals(
            ExternalDocumentDecision.ExpiredGrant(shareUri),
            ExternalDocumentEntryGuard.validateIncomingIntent(app, grantedShare, untrustedExternalCaller),
        )

        // 3. With FLAG_GRANT_READ_URI_PERMISSION and authorized caller, opens cleanly without needing a self-UID UriPermission entry!
        ExternalDocumentEntryGuard.dispatchIncomingIntent(
            context = app,
            incoming = grantedShare,
            savedInstanceState = null,
            initial = false,
            targetModel = model,
            caller = sameAppCaller,
        )
        await { model.state.value.active.uri == shareUri.toString() }
        assertEquals("# Shared note via FileProvider\n", model.state.value.active.content)
    }

    private fun newModel(attachOpenHandler: Boolean): StudioViewModel {
        val store = ViewModelStore().also(viewModels::add)
        val key = "entry-guard-${System.nanoTime()}".also(workspaceKeys::add)
        val model = StudioViewModel(app, key)
        model.readerFlushRequester = { true }
        if (attachOpenHandler) {
            attachModelOpenHandler(model)
        }
        store.put("model", model)
        return model
    }

    private fun attachModelOpenHandler(model: StudioViewModel) {
        model.attachReaderOpenHandler(
            OpenIntentDispatcher.Handler { target, relative ->
                model.openDocument(
                    target.uri,
                    relative,
                    externalIntentFlags = target.externalIntentFlags,
                    externalCaller = target.externalCaller,
                )
            },
        )
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

private class EnforcingTestApplication(
    base: Application,
    private val grantedUris: MutableMap<Uri, Int>,
) : Application() {
    init {
        attachBaseContext(base)
    }

    override fun grantUriPermission(toPackage: String?, uri: Uri?, modeFlags: Int) {
        super.grantUriPermission(toPackage, uri, modeFlags)
        if (uri != null) {
            val accessFlags = modeFlags and (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            grantedUris[uri] = (grantedUris[uri] ?: 0) or accessFlags
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
        val held = grantedUris.entries
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

private class EntryPointDocumentProvider(
    directory: File,
    private val portableFile: File,
) : ContentProvider() {
    private val firstFile = File(directory, "Note.md").apply { writeText("# First external note\n") }
    private val secondFile = File(directory, "Second.md").apply { writeText("# Second note\n") }
    var failRead = false
    var openCount = 0

    fun attach(context: Context, authority: String) {
        attachInfo(
            context,
            ProviderInfo().apply {
                this.authority = authority
                exported = true
                grantUriPermissions = true
            },
        )
    }

    override fun onCreate(): Boolean = true

    private fun fileFor(uri: Uri): File {
        val docId = runCatching { DocumentsContract.getDocumentId(uri) }.getOrDefault(uri.lastPathSegment.orEmpty())
        return when (docId.substringAfterLast('/')) {
            "Second.md" -> secondFile
            "Archive.smd" -> portableFile
            else -> firstFile
        }
    }

    private fun docEntries(): List<Pair<String, File>> = listOf(
        "vault/Note.md" to firstFile,
        "vault/Second.md" to secondFile,
        "vault/Archive.smd" to portableFile,
    )

    private fun rowValues(cols: List<String>, docId: String, file: File): Array<Any?> =
        cols.map { col ->
            when (col) {
                DocumentsContract.Document.COLUMN_DOCUMENT_ID -> docId
                OpenableColumns.DISPLAY_NAME, DocumentsContract.Document.COLUMN_DISPLAY_NAME -> file.name
                OpenableColumns.SIZE, DocumentsContract.Document.COLUMN_SIZE -> file.length()
                DocumentsContract.Document.COLUMN_MIME_TYPE -> if (file.name.endsWith(".smd")) "application/vnd.supermd.smd" else "text/markdown"
                DocumentsContract.Document.COLUMN_FLAGS -> 0
                else -> null
            }
        }.toTypedArray<Any?>()

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor {
        if (uri.pathSegments.lastOrNull() == "children") {
            val cols = projection?.toList() ?: listOf(
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_FLAGS,
            )
            val parentId = runCatching { DocumentsContract.getDocumentId(uri) }.getOrNull()
            return MatrixCursor(cols.toTypedArray()).apply {
                if (parentId == "vault") {
                    for ((docId, childFile) in docEntries()) {
                        addRow(rowValues(cols, docId, childFile))
                    }
                }
            }
        }
        val docId = runCatching { DocumentsContract.getDocumentId(uri) }.getOrDefault("vault/${fileFor(uri).name}")
        val file = fileFor(uri)
        val cols = projection?.toList() ?: listOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        return MatrixCursor(cols.toTypedArray()).apply {
            addRow(rowValues(cols, docId, file))
        }
    }

    override fun getType(uri: Uri): String =
        if (fileFor(uri).name.endsWith(".smd")) "application/vnd.supermd.smd" else "text/markdown"

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        openCount++
        if (mode == "r" && failRead) throw SecurityException("Simulated provider read failure")
        return ParcelFileDescriptor.open(fileFor(uri), ParcelFileDescriptor.MODE_READ_ONLY)
    }
}

private class PrivateFileRedirectProvider(private val target: File) : ContentProvider() {
    fun attach(context: Context, authority: String) {
        attachInfo(
            context,
            ProviderInfo().apply {
                this.authority = authority
                exported = true
                grantUriPermissions = true
            },
        )
    }

    override fun onCreate(): Boolean = true

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor {
        val cols = projection?.toList() ?: listOf(OpenableColumns.DISPLAY_NAME)
        return MatrixCursor(cols.toTypedArray()).apply {
            addRow(cols.map { "innocent.md" }.toTypedArray<Any?>())
        }
    }

    override fun getType(uri: Uri): String = "text/markdown"
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor =
        ParcelFileDescriptor.open(target, ParcelFileDescriptor.MODE_READ_ONLY)
}
