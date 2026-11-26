package dev.supermd.studio

import android.app.Application
import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
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
import java.nio.file.Files
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import org.json.JSONArray
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
class AndroidNoteDropTest {
    private lateinit var rawApp: Application
    private lateinit var app: DropPermissionTestApplication
    private lateinit var grantedUris: MutableMap<Uri, Int>
    private lateinit var publicDir: File
    private lateinit var providerRoot: File
    private lateinit var authority: String
    private lateinit var provider: NoteDropTestProvider
    private var previousAutosave: Boolean? = null
    private var previousRecent: String? = null
    private val workspaceKeys = mutableListOf<String>()
    private val viewModels = mutableListOf<ViewModelStore>()
    private val portableDirectories = mutableListOf<String>()

    companion object {
        private val VALID_PNG_BYTES = byteArrayOf(
            0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
            0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
        )
        private val VALID_SVG_BYTES =
            "<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12'><circle cx='6' cy='6' r='4'/></svg>"
                .toByteArray(Charsets.UTF_8)
        private val PDF_BYTES = "%PDF-1.7\n1 0 obj\n<<>>\nendobj\n".toByteArray(Charsets.UTF_8)
    }

    @Before
    fun setUp() {
        rawApp = RuntimeEnvironment.getApplication()
        grantedUris = ConcurrentHashMap()
        app = DropPermissionTestApplication(rawApp, grantedUris)
        publicDir = Files.createTempDirectory("supermd-note-drop-public").toFile()
        providerRoot = Files.createTempDirectory("supermd-note-drop-provider").toFile()
        authority = "dev.supermd.test.notedrop.${System.nanoTime()}"

        val media = MediaStorage(app)
        val smdFile = File(providerRoot, "Architecture.smd")
        smdFile.outputStream().use { out ->
            media.writeFmd(
                out,
                "# Architecture\n\n![diagram](assets/diagram.svg)\n",
                JSONObject().put("assets/diagram.svg", media.portableImageData("image/svg+xml", VALID_SVG_BYTES)),
            )
        }
        val fmdFile = File(providerRoot, "Legacy.fmd")
        fmdFile.outputStream().use { out ->
            media.writeFmd(out, "# Legacy Portable\n", JSONObject())
        }

        provider = NoteDropTestProvider(providerRoot).apply {
            putFile("vault/Overview.md", "Overview.md", "text/markdown", "# Overview\n\nBody.\n".toByteArray())
            putFile("vault/Guide.markdown", "Guide.markdown", "text/x-markdown", "# Guide\n".toByteArray())
            putFile("vault/Scratch.txt", "Scratch.txt", "text/plain", "Plain text scratch\n".toByteArray())
            putExistingFile("vault/Architecture.smd", "Architecture.smd", "application/vnd.supermd.smd", smdFile)
            putExistingFile("vault/Legacy.fmd", "Legacy.fmd", "application/vnd.supermd.fmd", fmdFile)
            putFile("opaque/42", "opaque_42", "text/markdown", "# Opaque Markdown\n".toByteArray())
            putFile("vault/chart.png", "chart.png", "image/png", VALID_PNG_BYTES)
            putFile("vault/diagram.svg", "diagram.svg", "text/xml", VALID_SVG_BYTES)
            putFile("vault/handout.pdf", "handout.pdf", "application/pdf", PDF_BYTES)
            putDirectory("vault/Subfolder", "Subfolder")
            attach(rawApp, authority)
        }
        ShadowContentResolver.registerProviderInternal(authority, provider)

        val prefs = app.getSharedPreferences("studio", Context.MODE_PRIVATE)
        previousAutosave = prefs.getBoolean("autosave", true)
        previousRecent = prefs.getString("recent", null)
        prefs.edit()
            .putBoolean("welcomed", true)
            .putBoolean("autosave", false)
            .commit()
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
        File(app.filesDir, "attachments").listFiles()?.forEach { it.delete() }
        workspaceKeys.forEach { File(app.filesDir, "workspaces/$it").deleteRecursively() }
        portableDirectories.forEach { File(app.filesDir, "portable-assets/$it").deleteRecursively() }
    }

    @Test
    fun grantedNoteDropsOpenInOrderViaDocumentFlowWithoutMutatingActiveNoteOrPersistingGrants() {
        val model = newModel()
        val initialTab = model.state.value.active
        model.edit(initialTab.id, "# Existing Draft\n")

        val mdUri = DocumentsContract.buildDocumentUri(authority, "vault/Overview.md")
        val markdownUri = DocumentsContract.buildDocumentUri(authority, "vault/Guide.markdown")
        val txtUri = DocumentsContract.buildDocumentUri(authority, "vault/Scratch.txt")
        val smdUri = DocumentsContract.buildDocumentUri(authority, "vault/Architecture.smd")
        val fmdUri = DocumentsContract.buildDocumentUri(authority, "vault/Legacy.fmd")
        val opaqueMdUri = DocumentsContract.buildDocumentUri(authority, "opaque/42")

        listOf(mdUri, markdownUri, txtUri, smdUri, fmdUri, opaqueMdUri).forEach { uri ->
            app.grantUriPermission(app.packageName, uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }

        val permissionReleased = AtomicBoolean(false)
        var imageInsertionPayload: JSONArray? = JSONArray().put("unexpected")

        model.handleExternalDrop(
            uris = listOf(mdUri, markdownUri, txtUri, smdUri, fmdUri, opaqueMdUri),
            activeNoteId = initialTab.id,
            dragReadPermissionGranted = true,
            onComplete = { permissionReleased.set(true) },
        ) { images ->
            imageInsertionPayload = images
        }

        await { permissionReleased.get() }
        model.state.value.tabs.mapNotNull { it.assetDirectory }.forEach(portableDirectories::add)

        // Never treated as an inline image insertion or dirtied initial tab's assets.
        assertNull(imageInsertionPayload)
        val preservedInitial = model.state.value.tabs.first { it.id == initialTab.id }
        assertEquals("# Existing Draft\n", preservedInitial.content)
        assertFalse(preservedInitial.assetsDirty)

        // All dropped notes opened in deterministic drop order, activating the last dropped note.
        val openedUris = model.state.value.tabs.drop(1).map { it.uri }
        assertEquals(
            listOf(
                mdUri.toString(),
                markdownUri.toString(),
                txtUri.toString(),
                smdUri.toString(),
                fmdUri.toString(),
                opaqueMdUri.toString(),
            ),
            openedUris,
        )
        assertEquals(opaqueMdUri.toString(), model.state.value.active.uri)
        assertEquals("# Opaque Markdown\n", model.state.value.active.content)

        val openedSmd = model.state.value.tabs.single { it.uri == smdUri.toString() }
        assertTrue(openedSmd.portable)
        assertEquals("Architecture.smd", openedSmd.name)
        assertEquals("# Architecture\n\n![diagram](assets/diagram.svg)\n", openedSmd.content)
        assertNotNull(model.media.local("assets/diagram.svg", openedSmd.assetDirectory))

        // Temporary drag grants must never be persisted.
        assertTrue(app.contentResolver.persistedUriPermissions.isEmpty())
    }

    @Test
    fun publicFileNotesOpenAndReopeningExistingNotePreservesUnsavedDraftAndPersistedTreeUri() {
        val model = newModel()
        val publicMd = File(publicDir, "FieldNotes.md").apply { writeText("# Field Notes\n") }
        val publicSmd = File(publicDir, "Bundle.smd")
        publicSmd.outputStream().use { out ->
            model.media.writeFmd(out, "# Public Bundle\n", JSONObject())
        }

        var completed = false
        model.handleExternalDrop(
            uris = listOf(Uri.fromFile(publicMd), Uri.fromFile(publicSmd)),
            activeNoteId = model.state.value.active.id,
            dragReadPermissionGranted = false, // file:// drops do not create DragAndDropPermissions
            onComplete = { completed = true },
        )
        await { completed }
        model.state.value.tabs.mapNotNull { it.assetDirectory }.forEach(portableDirectories::add)

        assertEquals(Uri.fromFile(publicSmd).toString(), model.state.value.active.uri)
        assertEquals("# Public Bundle\n", model.state.value.active.content)
        assertEquals("# Field Notes\n", model.state.value.tabs.single { it.uri == Uri.fromFile(publicMd).toString() }.content)

        // Open a SAF folder-backed note via internal workspace flow, edit it dirty, then drop its plain document URI.
        val treeUri = DocumentsContract.buildTreeDocumentUri(authority, "vault")
        val treeDocUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, "vault/Overview.md")
        val plainDocUri = DocumentsContract.buildDocumentUri(authority, "vault/Overview.md")
        val persistFlags = Intent.FLAG_GRANT_READ_URI_PERMISSION or
            Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
            Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
        app.grantUriPermission(app.packageName, treeUri, persistFlags)
        app.grantUriPermission(app.packageName, treeDocUri, persistFlags)
        app.contentResolver.takePersistableUriPermission(
            treeUri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
        )

        model.open(plainDocUri)
        await { model.state.value.tabs.any { it.uri == treeDocUri.toString() } }
        val folderTab = model.state.value.tabs.single { it.uri == treeDocUri.toString() }
        model.edit(folderTab.id, "# Unsaved Folder Draft\n")

        // Switch away, then drop plainDocUri with a temporary read grant.
        model.select(model.state.value.tabs.first().id)
        await { model.state.value.active.id == model.state.value.tabs.first().id }

        app.grantUriPermission(app.packageName, plainDocUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        completed = false
        model.handleExternalDrop(
            uris = listOf(plainDocUri),
            activeNoteId = model.state.value.active.id,
            dragReadPermissionGranted = true,
            onComplete = { completed = true },
        )
        await { completed }

        val afterDrop = model.state.value.tabs.single { it.id == folderTab.id }
        assertEquals(folderTab.id, model.state.value.active.id)
        assertEquals("# Unsaved Folder Draft\n", afterDrop.content)
        assertEquals("Stronger persisted SAF tree URI must remain intact", treeDocUri.toString(), afterDrop.uri)
    }

    @Test
    fun ungrantedPrivateShareAndRedirectedUrisAreRejectedWithoutProviderAccessOrMutatingDrafts() {
        val model = newModel()
        val initialTab = model.state.value.active
        model.edit(initialTab.id, "# Untouched Draft\n")

        val treeUri = DocumentsContract.buildTreeDocumentUri(authority, "vault")
        val treeDocUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, "vault/Overview.md")
        val plainDocUri = DocumentsContract.buildDocumentUri(authority, "vault/Overview.md")
        val persistFlags = Intent.FLAG_GRANT_READ_URI_PERMISSION or
            Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
            Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
        app.grantUriPermission(app.packageName, treeUri, persistFlags)
        app.grantUriPermission(app.packageName, treeDocUri, persistFlags)
        app.contentResolver.takePersistableUriPermission(
            treeUri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
        )

        // 1. Caller omitted drag read grant (dragReadPermissionGranted = false), even if app holds direct + tree grants.
        app.grantUriPermission(app.packageName, plainDocUri, persistFlags)
        provider.resetCounters()
        var done = false
        model.handleExternalDrop(
            uris = listOf(plainDocUri),
            activeNoteId = initialTab.id,
            dragReadPermissionGranted = false,
            onComplete = { done = true },
        )
        await { done }
        assertEquals(0, provider.openCount.get())
        assertEquals(0, provider.queryCount.get())
        assertEquals(0, provider.getTypeCount.get())
        assertEquals(1, model.state.value.tabs.size)
        assertNull(model.documentAccessRequests.value)

        // 2. Caller passed dragReadPermissionGranted = true, but plainDocUri has NO direct URI grant (only persisted tree grant).
        app.revokeUriPermission(plainDocUri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        provider.resetCounters()
        done = false
        model.handleExternalDrop(
            uris = listOf(plainDocUri),
            activeNoteId = initialTab.id,
            dragReadPermissionGranted = true,
            onComplete = { done = true },
        )
        await { done }
        assertEquals(0, provider.openCount.get())
        assertEquals(0, provider.queryCount.get())
        assertEquals(0, provider.getTypeCount.get())
        assertEquals(1, model.state.value.tabs.size)

        // 3. App-private file://, symlink to private file, and ${packageName}.share URIs are rejected.
        val privateNote = File(app.filesDir, "secret.md").apply { writeText("# Secret\n") }
        val symlinkNote = File(publicDir, "innocent.md")
        Files.createSymbolicLink(symlinkNote.toPath(), privateNote.toPath())
        val shareUri = Uri.parse("content://${app.packageName}.share/Shared.md")
        val userPrefixedShareUri = Uri.parse("content://0@${app.packageName}.share/Shared.md")
        val mixedCaseAndroidData = Uri.parse("file:///sdcard/Android/DATA/${app.packageName}/files/leak.md")

        for (forbidden in listOf(Uri.fromFile(privateNote), Uri.fromFile(symlinkNote), shareUri, userPrefixedShareUri, mixedCaseAndroidData)) {
            done = false
            model.handleExternalDrop(
                uris = listOf(forbidden),
                activeNoteId = initialTab.id,
                dragReadPermissionGranted = true,
                onComplete = { done = true },
            )
            await { done }
            assertEquals("Forbidden URI must not open a tab: $forbidden", 1, model.state.value.tabs.size)
        }

        // 4. Malicious ContentProvider redirecting ParcelFileDescriptor to an app-private file is blocked.
        val redirectAuthority = "com.attacker.dropredirect.${System.nanoTime()}"
        val redirectProvider = RedirectingDropProvider(privateNote).also { it.attach(rawApp, redirectAuthority) }
        ShadowContentResolver.registerProviderInternal(redirectAuthority, redirectProvider)
        val redirectUri = Uri.parse("content://$redirectAuthority/Note.md")
        app.grantUriPermission(app.packageName, redirectUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)

        done = false
        model.handleExternalDrop(
            uris = listOf(redirectUri),
            activeNoteId = initialTab.id,
            dragReadPermissionGranted = true,
            onComplete = { done = true },
        )
        await { done }
        assertEquals(1, model.state.value.tabs.size)
        assertEquals("# Untouched Draft\n", model.state.value.active.content)
        assertTrue(model.state.value.error?.contains("App-private paths cannot be opened externally") == true)
    }

    @Test
    fun folderDropsRemainSeparateWhileMixedNoteDropsPreserveInlineImagesAndNormalPicker() {
        val model = newModel()

        val treeUri = DocumentsContract.buildTreeDocumentUri(authority, "vault")
        val safDirDocUri = DocumentsContract.buildDocumentUri(authority, "vault/Subfolder")
        val localFolder = File(publicDir, "LocalFolder").apply { mkdirs() }
        File(localFolder, "Inside.md").writeText("# Inside\n")

        app.grantUriPermission(app.packageName, treeUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        app.grantUriPermission(app.packageName, safDirDocUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)

        // 1. Pure folder drops (tree URI, SAF directory document URI, local file:// directory) never import folders.
        for (folderUri in listOf(treeUri, safDirDocUri, Uri.fromFile(localFolder))) {
            var done = false
            model.handleExternalDrop(
                uris = listOf(folderUri),
                activeNoteId = model.state.value.active.id,
                dragReadPermissionGranted = true,
                onComplete = { done = true },
            )
            await { done }
            assertNull(model.state.value.folder)
            assertTrue(model.state.value.files.isEmpty())
            assertEquals(1, model.state.value.tabs.size)
            assertEquals(DROP_FOLDER_UNSUPPORTED_MESSAGE, model.state.value.message)
        }

        // 2. Mixed folder + note + unsupported PDF opens the note and skips the folder + PDF cleanly.
        val mdUri = DocumentsContract.buildDocumentUri(authority, "vault/Overview.md")
        val pdfUri = DocumentsContract.buildDocumentUri(authority, "vault/handout.pdf")
        app.grantUriPermission(app.packageName, mdUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        app.grantUriPermission(app.packageName, pdfUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)

        var mixedDone = false
        model.handleExternalDrop(
            uris = listOf(treeUri, mdUri, pdfUri),
            activeNoteId = model.state.value.active.id,
            dragReadPermissionGranted = true,
            onComplete = { mixedDone = true },
        )
        await { mixedDone }
        assertNull(model.state.value.folder)
        assertEquals(mdUri.toString(), model.state.value.active.uri)
        assertTrue(model.state.value.message?.contains("Skipped 1 folder") == true)
        assertTrue(model.state.value.message?.contains("Skipped 1 unsupported item") == true)

        // 3. Inline image drops onto the open note remain preserved via supermdInsertImages callback.
        val pngUri = DocumentsContract.buildDocumentUri(authority, "vault/chart.png")
        val svgUri = DocumentsContract.buildDocumentUri(authority, "vault/diagram.svg")
        app.grantUriPermission(app.packageName, pngUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        app.grantUriPermission(app.packageName, svgUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)

        var droppedImages: JSONArray? = null
        var imagesDone = false
        model.handleExternalDrop(
            uris = listOf(pngUri, pdfUri, svgUri),
            activeNoteId = model.state.value.active.id,
            dragReadPermissionGranted = true,
            onComplete = { imagesDone = true },
        ) { images ->
            droppedImages = images
        }
        await { imagesDone }
        assertNotNull(droppedImages)
        assertEquals(2, droppedImages!!.length())
        assertEquals("chart", droppedImages!!.getJSONObject(0).getString("alt"))
        assertEquals("diagram", droppedImages!!.getJSONObject(1).getString("alt"))
        assertTrue(model.state.value.active.assetsDirty)

        // 4. Normal system note picker (retainDocumentAccess + requestOpen) remains preserved.
        val pickedUri = DocumentsContract.buildDocumentUri(authority, "vault/Guide.markdown")
        val pickerFlags = Intent.FLAG_GRANT_READ_URI_PERMISSION or
            Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
            Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
        app.grantUriPermission(app.packageName, pickedUri, pickerFlags)
        model.retainDocumentAccess(pickedUri)
        model.requestOpen(pickedUri)
        await { model.state.value.active.uri == pickedUri.toString() }
        assertEquals("# Guide\n", model.state.value.active.content)
        assertTrue(app.contentResolver.persistedUriPermissions.any { it.uri == pickedUri && it.isReadPermission })
    }

    private fun newModel(): StudioViewModel {
        val store = ViewModelStore().also(viewModels::add)
        val key = "note-drop-${System.nanoTime()}".also(workspaceKeys::add)
        val model = StudioViewModel(app, key)
        model.readerFlushRequester = { true }
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

private class DropPermissionTestApplication(
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
        if (uri == null) return PackageManager.PERMISSION_DENIED
        val held = grantedUris[uri] ?: 0
        return if ((held and modeFlags) == modeFlags) PackageManager.PERMISSION_GRANTED else PackageManager.PERMISSION_DENIED
    }
}

private class NoteDropTestProvider(private val root: File) : ContentProvider() {
    data class Entry(val docId: String, val name: String, val mime: String, val file: File?, val directory: Boolean = false)

    private val entries = LinkedHashMap<String, Entry>()
    val openCount = AtomicInteger(0)
    val queryCount = AtomicInteger(0)
    val getTypeCount = AtomicInteger(0)

    fun putFile(docId: String, name: String, mime: String, bytes: ByteArray) {
        val disk = File(root, docId.replace('/', '_')).apply { writeBytes(bytes) }
        entries[docId] = Entry(docId, name, mime, disk, directory = false)
    }

    fun putExistingFile(docId: String, name: String, mime: String, file: File) {
        entries[docId] = Entry(docId, name, mime, file, directory = false)
    }

    fun putDirectory(docId: String, name: String) {
        entries[docId] = Entry(docId, name, DocumentsContract.Document.MIME_TYPE_DIR, null, directory = true)
    }

    fun resetCounters() {
        openCount.set(0)
        queryCount.set(0)
        getTypeCount.set(0)
    }

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

    private fun entryFor(uri: Uri): Entry? {
        val docId = runCatching { DocumentsContract.getDocumentId(uri) }.getOrDefault(uri.lastPathSegment.orEmpty())
        return entries[docId]
    }

    override fun getType(uri: Uri): String? {
        getTypeCount.incrementAndGet()
        return entryFor(uri)?.mime
    }

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor {
        queryCount.incrementAndGet()
        val segments = uri.pathSegments
        if (segments.lastOrNull() == "children" && segments.size >= 2) {
            val cols = projection?.toList() ?: listOf(
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_FLAGS,
            )
            return MatrixCursor(cols.toTypedArray()).apply {
                for (entry in entries.values.filter { it.docId.startsWith("vault/") }) {
                    addRow(
                        cols.map<String, Any?> { col ->
                            when (col) {
                                DocumentsContract.Document.COLUMN_DOCUMENT_ID -> entry.docId
                                OpenableColumns.DISPLAY_NAME, DocumentsContract.Document.COLUMN_DISPLAY_NAME -> entry.name
                                OpenableColumns.SIZE, DocumentsContract.Document.COLUMN_SIZE -> entry.file?.length() ?: 0L
                                DocumentsContract.Document.COLUMN_MIME_TYPE -> entry.mime
                                DocumentsContract.Document.COLUMN_FLAGS -> 0
                                else -> null
                            }
                        }.toTypedArray(),
                    )
                }
            }
        }
        val entry = entryFor(uri)
        val cols = projection?.toList() ?: listOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        return MatrixCursor(cols.toTypedArray()).apply {
            if (entry != null) {
                addRow(
                    cols.map<String, Any?> { col ->
                        when (col) {
                            DocumentsContract.Document.COLUMN_DOCUMENT_ID -> entry.docId
                            OpenableColumns.DISPLAY_NAME, DocumentsContract.Document.COLUMN_DISPLAY_NAME -> entry.name
                            OpenableColumns.SIZE, DocumentsContract.Document.COLUMN_SIZE -> entry.file?.length() ?: 0L
                            DocumentsContract.Document.COLUMN_MIME_TYPE -> entry.mime
                            else -> null
                        }
                    }.toTypedArray(),
                )
            }
        }
    }

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        openCount.incrementAndGet()
        val entry = entryFor(uri)
        val file = entry?.file ?: throw java.io.FileNotFoundException(uri.toString())
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0
}

private class RedirectingDropProvider(private val target: File) : ContentProvider() {
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
    override fun getType(uri: Uri): String = "text/markdown"

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor {
        val cols = projection?.toList() ?: listOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        return MatrixCursor(cols.toTypedArray()).apply {
            addRow(
                cols.map<String, Any?> { col ->
                    when (col) {
                        OpenableColumns.DISPLAY_NAME, DocumentsContract.Document.COLUMN_DISPLAY_NAME -> "Note.md"
                        OpenableColumns.SIZE, DocumentsContract.Document.COLUMN_SIZE -> target.length()
                        else -> null
                    }
                }.toTypedArray(),
            )
        }
    }

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor =
        ParcelFileDescriptor.open(target, ParcelFileDescriptor.MODE_READ_ONLY)

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0
}
