package dev.supermd.studio

import android.app.Application
import android.content.ClipData
import android.content.ClipDescription
import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.pm.ProviderInfo
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import java.io.File
import java.nio.file.Files
import java.util.concurrent.ConcurrentHashMap
import org.json.JSONArray
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

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class DropSafetyTest {
    private lateinit var rawApp: Application
    private lateinit var app: EnforcingDropTestApplication
    private lateinit var grantedUris: MutableMap<Uri, Int>
    private lateinit var tempDir: File
    private lateinit var provider: FakeDropProvider

    class FakeDropProvider : ContentProvider() {
        data class Entry(val name: String, val mime: String?, val bytes: ByteArray, val backingFile: File? = null)
        @Volatile var openGate: java.util.concurrent.CountDownLatch? = null
        @Volatile var queryCount = 0
        @Volatile var getTypeCount = 0
        @Volatile var openCount = 0
        val entries = ConcurrentHashMap<String, Entry>()

        private fun keyFor(uri: Uri): String? =
            runCatching { android.provider.DocumentsContract.getDocumentId(uri) }
                .getOrNull()
                ?.substringAfterLast('/')
                ?: uri.lastPathSegment

        override fun onCreate(): Boolean = true

        override fun getType(uri: Uri): String? {
            getTypeCount++
            return entries[keyFor(uri)]?.mime
        }

        override fun query(
            uri: Uri,
            projection: Array<out String>?,
            selection: String?,
            selectionArgs: Array<out String>?,
            sortOrder: String?,
        ): Cursor {
            queryCount++
            val entry = entries[keyFor(uri)]
            val cols = projection ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
            val cursor = MatrixCursor(cols)
            if (entry != null) {
                cursor.addRow(cols.map<String, Any?> { col ->
                    when (col) {
                        OpenableColumns.DISPLAY_NAME, android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME -> entry.name
                        OpenableColumns.SIZE, android.provider.DocumentsContract.Document.COLUMN_SIZE -> entry.bytes.size.toLong()
                        android.provider.DocumentsContract.Document.COLUMN_MIME_TYPE -> entry.mime
                        else -> null
                    }
                }.toTypedArray())
            }
            return cursor
        }

        override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
            openCount++
            openGate?.await(3, java.util.concurrent.TimeUnit.SECONDS)
            val entry = entries[keyFor(uri)] ?: throw java.io.FileNotFoundException(uri.toString())
            val target = entry.backingFile ?: File.createTempFile("drop-entry-", ".bin").apply {
                writeBytes(entry.bytes)
                deleteOnExit()
            }
            return ParcelFileDescriptor.open(target, ParcelFileDescriptor.MODE_READ_ONLY)
        }

        override fun insert(uri: Uri, values: ContentValues?): Uri? = null
        override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
        override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0
    }

    class EnforcingDropTestApplication(
        base: Application,
        private val grantedUris: MutableMap<Uri, Int>,
    ) : Application() {
        init {
            attachBaseContext(base)
        }

        override fun grantUriPermission(toPackage: String?, uri: Uri?, modeFlags: Int) {
            super.grantUriPermission(toPackage, uri, modeFlags)
            if (uri != null) {
                val accessFlags = modeFlags and (
                    android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION or
                        android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                    )
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
                    granted == uri ||
                        (android.provider.DocumentsContract.isTreeUri(granted) && uri.toString().startsWith("$granted/"))
                }
                .fold(0) { acc, (_, flags) -> acc or flags }
            return if ((held and modeFlags) == modeFlags) {
                android.content.pm.PackageManager.PERMISSION_GRANTED
            } else {
                android.content.pm.PackageManager.PERMISSION_DENIED
            }
        }
    }

    companion object {
        private const val AUTHORITY = "dev.supermd.studio.test.drops"
        private val VALID_PNG_BYTES = byteArrayOf(
            0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
            0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
        )
        private val VALID_SVG_BYTES = """<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="6"/></svg>""".toByteArray(Charsets.UTF_8)
        private val PDF_BYTES = "%PDF-1.7\n1 0 obj\n<<>>\nendobj\n".toByteArray(Charsets.UTF_8)
    }

    @Before fun setUp() {
        rawApp = RuntimeEnvironment.getApplication()
        grantedUris = mutableMapOf()
        app = EnforcingDropTestApplication(rawApp, grantedUris)
        tempDir = Files.createTempDirectory("drop-safety-test").toFile()
        val info = ProviderInfo().apply {
            authority = AUTHORITY
            exported = true
            grantUriPermissions = true
        }
        provider = Robolectric.buildContentProvider(FakeDropProvider::class.java).create(info).get()
        app.getSharedPreferences("studio", Context.MODE_PRIVATE).edit()
            .putBoolean("welcomed", true)
            .putBoolean("autosave", false)
            .commit()
    }

    private fun grantRead(vararg uris: Uri) {
        for (uri in uris) {
            app.grantUriPermission(app.packageName, uri, android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
    }

    @After fun tearDown() {
        tempDir.deleteRecursively()
        File(app.filesDir, "attachments").listFiles()?.forEach { it.delete() }
    }

    private fun drainMain(until: (() -> Boolean)? = null) {
        val deadline = System.nanoTime() + 5_000_000_000L
        do {
            Thread.sleep(15)
            shadowOf(Looper.getMainLooper()).idle()
            if (until != null && until()) break
        } while (until != null && System.nanoTime() < deadline)
        for (i in 0 until 4) {
            Thread.sleep(10)
            shadowOf(Looper.getMainLooper()).idle()
        }
    }

    @Test fun dragFilterPreservesInternalAndPlainTextDragsWhileInterceptingExternalFileAndUriDrags() {
        val imageDesc = ClipDescription("photo", arrayOf("image/png"))
        assertFalse(shouldAcceptExternalDrag(localState = Any(), description = imageDesc))

        val plainDesc = ClipDescription("selection", arrayOf("text/plain", "text/html", "chromium/x-webkit-paste"))
        assertFalse(shouldAcceptExternalDrag(localState = null, description = plainDesc))
        assertFalse(shouldAcceptExternalDrag(localState = null, description = ClipDescription("webview-link", arrayOf("text/plain", "text/uri-list", "chromium/x-bookmark-entries"))))
        assertFalse(shouldAcceptExternalDrag(localState = null, description = ClipDescription("webview-img", arrayOf("image/png", "chromium/x-webkit-paste"))))

        assertTrue(shouldAcceptExternalDrag(localState = null, description = imageDesc))
        assertTrue(shouldAcceptExternalDrag(localState = null, description = ClipDescription("pdf", arrayOf("application/pdf"))))
        assertTrue(shouldAcceptExternalDrag(localState = null, description = ClipDescription("zip", arrayOf("application/zip"))))
        assertTrue(shouldAcceptExternalDrag(localState = null, description = ClipDescription("link", arrayOf("text/plain", "text/uri-list"))))

        var externalDrops = 0
        val controller = ExternalDropDragController { externalDrops++ }
        val dropEvent = org.robolectric.shadow.api.Shadow.newInstanceOf(android.view.DragEvent::class.java).also {
            org.robolectric.util.ReflectionHelpers.setField(it, "mAction", android.view.DragEvent.ACTION_DROP)
        }

        // Plain-text / internal WebView drags must return false across the entire lifecycle so View.dispatchDragEvent
        // delegates LOCATION, DROP, and ENDED to WebView.onDragEvent without swallowing drops.
        assertFalse(controller.onDragAction(android.view.DragEvent.ACTION_DRAG_STARTED, null, plainDesc))
        assertFalse(controller.onDragAction(android.view.DragEvent.ACTION_DRAG_ENTERED, null, plainDesc))
        assertFalse(controller.onDragAction(android.view.DragEvent.ACTION_DRAG_LOCATION, null, plainDesc))
        assertFalse(controller.onDrag(null, dropEvent))
        assertFalse(controller.onDragAction(android.view.DragEvent.ACTION_DRAG_ENDED, null, null))
        assertEquals(0, externalDrops)

        // Accepted external file drags own the full session, invoke onExternalDrop on DROP, and reset on ENDED.
        assertTrue(controller.onDragAction(android.view.DragEvent.ACTION_DRAG_STARTED, null, imageDesc))
        assertTrue(controller.onDragAction(android.view.DragEvent.ACTION_DRAG_LOCATION, null, imageDesc))
        assertTrue(controller.onDrag(null, dropEvent))
        assertEquals(1, externalDrops)
        assertTrue(controller.onDragAction(android.view.DragEvent.ACTION_DRAG_ENDED, null, null))

        // Subsequent internal drags after an external session ends still fall through cleanly.
        assertFalse(controller.onDragAction(android.view.DragEvent.ACTION_DRAG_STARTED, Any(), imageDesc))
        assertFalse(controller.onDrag(null, dropEvent))
        assertEquals(1, externalDrops)
    }

    @Test fun nativeDropGuardsOverlaysModalsAndExtractsOnlyContentOrFileUris() {
        val baseState = StudioState(
            tabs = listOf(Note(id = "n1", name = "Note.md", content = "# Note", saved = "# Note")),
            activeId = "n1",
            welcomed = true,
        )
        assertFalse(shouldBlockNativeDrop(baseState))
        assertTrue(shouldBlockNativeDrop(baseState.copy(welcomed = false)))
        assertTrue(shouldBlockNativeDrop(baseState.copy(readerOverlay = true)))
        assertTrue(shouldBlockNativeDrop(baseState.copy(busy = true)))
        assertTrue(shouldBlockNativeDrop(baseState, folderSearchVisible = true))
        assertTrue(shouldBlockNativeDrop(baseState, accessRequestOpen = true))
        assertTrue(shouldBlockNativeDrop(baseState.copy(pendingCloseNoteId = "n1")))
        assertTrue(shouldBlockNativeDrop(baseState.copy(pendingSaveConflictNoteId = "n1")))
        assertTrue(shouldBlockNativeDrop(baseState, settingsOpen = true))
        assertTrue(shouldBlockNativeDrop(baseState, exporting = true))
        assertTrue(shouldBlockNativeDrop(baseState, renaming = true))
        assertTrue(shouldBlockNativeDrop(baseState, folderDialogOpen = true))
        assertTrue(shouldBlockNativeDrop(baseState.copy(error = "Save failed")))
        assertTrue(shouldBlockNativeDrop(baseState, contentsShown = true))
        assertTrue(shouldBlockNativeDrop(baseState, drawerOpen = true))

        val contentUri = Uri.parse("content://$AUTHORITY/diagram")
        val fileUri = Uri.fromFile(File(tempDir, "local.png"))
        val webUri = Uri.parse("https://example.com/article")
        val clip = ClipData("drop", arrayOf("text/uri-list"), ClipData.Item(contentUri)).apply {
            addItem(ClipData.Item(webUri))
            addItem(ClipData.Item(fileUri))
            addItem(ClipData.Item("inline text without uri"))
        }
        assertEquals(listOf(contentUri, fileUri), extractDroppedFileUris(clip))
    }

    @Test fun nonImageSpoofedAndPrivateFileDropsAreRejectedWithoutDirtyingAssetsOrMutatingNotes() {
        provider.entries["pdf"] = FakeDropProvider.Entry("lecture.pdf", "application/pdf", PDF_BYTES)
        provider.entries["bmp"] = FakeDropProvider.Entry("legacy.bmp", "image/bmp", "BM123456".toByteArray())
        provider.entries["spoofed"] = FakeDropProvider.Entry("fake.png", "application/octet-stream", PDF_BYTES)
        val pdfUri = Uri.parse("content://$AUTHORITY/pdf")
        val bmpUri = Uri.parse("content://$AUTHORITY/bmp")
        val spoofedUri = Uri.parse("content://$AUTHORITY/spoofed")
        grantRead(pdfUri, bmpUri, spoofedUri)

        val secretFile = File(app.filesDir, "secret.png").apply { writeBytes(VALID_PNG_BYTES) }
        val nonImageUris = listOf(
            pdfUri,
            bmpUri,
            spoofedUri,
            Uri.parse("https://example.com/not-a-local-image.png"),
            Uri.parse("content://${app.packageName}.share/secret.png"),
            Uri.fromFile(secretFile),
        )

        val model = StudioViewModel(app)
        drainMain()
        val initialNote = model.state.value.active
        var callbackImages: JSONArray? = JSONArray().put("sentinel")
        var callbackInvoked = false

        model.importDropped(nonImageUris, initialNote.id) { images ->
            callbackImages = images
            callbackInvoked = true
        }
        drainMain { callbackInvoked }

        assertTrue(callbackInvoked)
        assertNull(callbackImages)
        val after = model.state.value.active
        assertEquals(initialNote.content, after.content)
        assertFalse(after.assetsDirty)
        assertEquals(MediaStorage.UNSUPPORTED_DROP_IMAGE_MESSAGE, model.state.value.message)
        secretFile.delete()
    }

    @Test fun mixedDropImportsSupportedImagesWhileSkippingNonImagesCleanly() {
        provider.entries["png"] = FakeDropProvider.Entry("chart.png", "image/png", VALID_PNG_BYTES)
        provider.entries["svg"] = FakeDropProvider.Entry("diagram.svg", "text/xml", VALID_SVG_BYTES)
        provider.entries["pdf"] = FakeDropProvider.Entry("handout.pdf", "application/pdf", PDF_BYTES)
        val pngUri = Uri.parse("content://$AUTHORITY/png")
        val pdfUri = Uri.parse("content://$AUTHORITY/pdf")
        val svgUri = Uri.parse("content://$AUTHORITY/svg")
        grantRead(pngUri, pdfUri, svgUri)

        val model = StudioViewModel(app)
        drainMain()
        val activeId = model.state.value.active.id
        var imported: JSONArray? = null

        model.importDropped(
            listOf(pngUri, pdfUri, svgUri),
            activeId,
        ) { images -> imported = images }
        drainMain { imported != null }

        assertNotNull(imported)
        assertEquals(2, imported!!.length())
        assertEquals("chart", imported!!.getJSONObject(0).getString("alt"))
        assertEquals("diagram", imported!!.getJSONObject(1).getString("alt"))
        assertTrue(model.state.value.active.assetsDirty)
        assertEquals(
            "Skipped 1 unsupported file; only PNG, JPEG, GIF, WebP, AVIF, and SVG images were imported.",
            model.state.value.message,
        )
    }

    @Test fun delayedDropCancelsCleanlyWhenUserSwitchesTabsBeforeImportCompletes() {
        provider.entries["png"] = FakeDropProvider.Entry("delayed.png", "image/png", VALID_PNG_BYTES)
        val pngUri = Uri.parse("content://$AUTHORITY/png")
        grantRead(pngUri)
        val gate = java.util.concurrent.CountDownLatch(1)
        provider.openGate = gate

        try {
            val model = StudioViewModel(app)
            drainMain()
            val firstTab = model.state.value.active
            val firstContent = firstTab.content
            val existingAttachments = File(app.filesDir, "attachments").listFiles()?.map { it.name }?.toSet().orEmpty()

            var callbackImages: JSONArray? = JSONArray().put("sentinel")
            var callbackDone = false
            model.importDropped(listOf(pngUri), firstTab.id) { images ->
                callbackImages = images
                callbackDone = true
            }

            // Switch to a new second tab while importDroppedUris is still awaiting I/O.
            model.newNote()
            drainMain { model.state.value.tabs.size == 2 && model.state.value.active.id != firstTab.id }
            val secondTab = model.state.value.active
            model.edit(secondTab.id, "# Second note stays clean")

            gate.countDown()
            drainMain { callbackDone }

            assertTrue(callbackDone)
            assertNull(callbackImages)
            assertEquals(MediaStorage.SWITCHED_NOTE_IMPORT_MESSAGE, model.state.value.message)

            val updatedFirst = model.state.value.tabs.first { it.id == firstTab.id }
            val updatedSecond = model.state.value.tabs.first { it.id == secondTab.id }
            assertEquals(firstContent, updatedFirst.content)
            assertFalse(updatedFirst.assetsDirty)
            assertEquals("# Second note stays clean", updatedSecond.content)
            assertFalse(updatedSecond.assetsDirty)

            val afterAttachments = File(app.filesDir, "attachments").listFiles()?.map { it.name }?.toSet().orEmpty()
            assertEquals(existingAttachments, afterAttachments)
        } finally {
            provider.openGate = null
            gate.countDown()
        }
    }

    @Test fun grantedExternalContentAndPublicFileDropsAndUserGrantedPickerImportsSucceed() {
        provider.entries["drop.png"] = FakeDropProvider.Entry("drop.png", "image/png", VALID_PNG_BYTES)
        provider.entries["picked.svg"] = FakeDropProvider.Entry("picked.svg", "image/svg+xml", VALID_SVG_BYTES)
        provider.entries["exported-picker.png"] = FakeDropProvider.Entry("exported-picker.png", "image/png", VALID_PNG_BYTES)
        provider.entries["spoofed-picker.png"] = FakeDropProvider.Entry("spoofed-picker.png", "image/png", PDF_BYTES)
        val grantedDropUri = android.provider.DocumentsContract.buildDocumentUri(AUTHORITY, "vault/drop.png")
        val treeUri = android.provider.DocumentsContract.buildTreeDocumentUri(AUTHORITY, "vault")
        val treePickedUri = android.provider.DocumentsContract.buildDocumentUriUsingTree(treeUri, "vault/picked.svg")
        val exportedPickerUri = Uri.parse("content://$AUTHORITY/exported-picker.png")
        val spoofedPickerUri = android.provider.DocumentsContract.buildDocumentUri(AUTHORITY, "vault/spoofed-picker.png")
        val publicFile = File(tempDir, "ordinary-external.png").apply { writeBytes(VALID_PNG_BYTES) }
        val publicFileUri = Uri.fromFile(publicFile)

        grantRead(grantedDropUri, treePickedUri, spoofedPickerUri)

        val model = StudioViewModel(app)
        drainMain()
        val activeId = model.state.value.active.id

        // 1. Ordinary granted external content:// and public file:// drops succeed without persisting temporary grants.
        var droppedImages: JSONArray? = null
        model.importDropped(
            uris = listOf(grantedDropUri, publicFileUri),
            id = activeId,
            dragReadPermissionGranted = true,
        ) { images -> droppedImages = images }
        drainMain { droppedImages != null }

        assertEquals(2, droppedImages!!.length())
        assertEquals("drop", droppedImages!!.getJSONObject(0).getString("alt"))
        assertEquals("ordinary-external", droppedImages!!.getJSONObject(1).getString("alt"))
        assertTrue(app.contentResolver.persistedUriPermissions.none { it.uri == grantedDropUri })

        // 2. User-granted system picker (OpenMultipleDocuments) imports granted SAF documents (including tree-backed picker URIs)
        //    as well as readable exported picker URIs that do not insert a dynamic checkUriPermission record.
        var pickedImages: JSONArray? = null
        model.importPickedImages(listOf(treePickedUri, exportedPickerUri), activeId) { images -> pickedImages = images }
        drainMain { pickedImages != null }
        assertEquals(2, pickedImages!!.length())
        assertEquals("picked", pickedImages!!.getJSONObject(0).getString("alt"))
        assertEquals("exported-picker", pickedImages!!.getJSONObject(1).getString("alt"))

        // Verify the same ungranted exported URI is still rejected on untrusted external drag-and-drop before opening bytes.
        val openBeforeDrop = provider.openCount
        var ungrantedExportedDone = false
        var ungrantedExportedResult: JSONArray? = JSONArray().put("sentinel")
        model.importDropped(
            uris = listOf(exportedPickerUri),
            id = activeId,
            dragReadPermissionGranted = true,
        ) { images ->
            ungrantedExportedResult = images
            ungrantedExportedDone = true
        }
        drainMain { ungrantedExportedDone }
        assertNull(ungrantedExportedResult)
        assertEquals(openBeforeDrop, provider.openCount)
        assertEquals(MediaStorage.UNGRANTED_DROP_IMAGE_MESSAGE, model.state.value.message)

        // 3. Signature validation guards user-granted picker imports against spoofed image bytes and rolls back staged batch items.
        val attachmentsBeforeFailedBatch = File(app.filesDir, "attachments").listFiles()?.map { it.name }?.toSet().orEmpty()
        var spoofedCallbackDone = false
        var spoofedPicked: JSONArray? = JSONArray().put("sentinel")
        model.importPickedImages(listOf(grantedDropUri, spoofedPickerUri), activeId) { images ->
            spoofedPicked = images
            spoofedCallbackDone = true
        }
        drainMain { spoofedCallbackDone }
        assertNull(spoofedPicked)
        assertTrue(model.state.value.error?.contains("PNG signature is invalid") == true)
        val attachmentsAfterFailedBatch = File(app.filesDir, "attachments").listFiles()?.map { it.name }?.toSet().orEmpty()
        assertEquals(attachmentsBeforeFailedBatch, attachmentsAfterFailedBatch)
    }

    @Test fun missingDragGrantOrMissingUriPermissionDropsAreRejectedBeforeOpeningBytesEvenWithExistingAppGrants() {
        provider.entries["secret.png"] = FakeDropProvider.Entry("secret.png", "image/png", VALID_PNG_BYTES)
        provider.entries["ungranted.png"] = FakeDropProvider.Entry("ungranted.png", "image/png", VALID_PNG_BYTES)
        provider.entries["allowed.png"] = FakeDropProvider.Entry("allowed.png", "image/png", VALID_PNG_BYTES)

        val secretDocUri = android.provider.DocumentsContract.buildDocumentUri(AUTHORITY, "vault/secret.png")
        val treeUri = android.provider.DocumentsContract.buildTreeDocumentUri(AUTHORITY, "vault")
        val treeContainedSecretUri = android.provider.DocumentsContract.buildDocumentUriUsingTree(treeUri, "vault/secret.png")
        val ungrantedUri = android.provider.DocumentsContract.buildDocumentUri(AUTHORITY, "vault/ungranted.png")
        val allowedUri = android.provider.DocumentsContract.buildDocumentUri(AUTHORITY, "vault/allowed.png")

        // App already holds BOTH a direct grant on secretDocUri AND a persisted SAF folder grant on treeUri.
        val folderFlags = android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION or
            android.content.Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
        app.grantUriPermission(app.packageName, secretDocUri, folderFlags)
        app.grantUriPermission(app.packageName, treeUri, folderFlags)
        app.contentResolver.takePersistableUriPermission(treeUri, android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
        grantRead(allowedUri)

        val model = StudioViewModel(app)
        drainMain()
        val noteId = model.state.value.active.id
        val initialContent = model.state.value.active.content

        // 1. Missing caller drag grant (requestDragAndDropPermissions == null) rejects before querying or opening bytes.
        provider.queryCount = 0
        provider.getTypeCount = 0
        provider.openCount = 0
        var done1 = false
        var res1: JSONArray? = JSONArray().put("sentinel")
        model.importDropped(
            uris = listOf(secretDocUri),
            id = noteId,
            dragReadPermissionGranted = false,
        ) { images -> res1 = images; done1 = true }
        drainMain { done1 }

        assertNull(res1)
        assertEquals(0, provider.queryCount)
        assertEquals(0, provider.getTypeCount)
        assertEquals(0, provider.openCount)
        assertFalse(model.state.value.active.assetsDirty)
        assertEquals(initialContent, model.state.value.active.content)
        assertEquals(MediaStorage.UNGRANTED_DROP_IMAGE_MESSAGE, model.state.value.message)

        // 2. Missing live URI read grant on an individual URI (even when dragReadPermissionGranted = true and
        //    the containing SAF folder grant is persisted) never manufactures tree access or opens bytes.
        var done2 = false
        var res2: JSONArray? = JSONArray().put("sentinel")
        model.importDropped(
            uris = listOf(ungrantedUri),
            id = noteId,
            dragReadPermissionGranted = true,
        ) { images -> res2 = images; done2 = true }
        drainMain { done2 }

        assertNull(res2)
        assertEquals(0, provider.queryCount)
        assertEquals(0, provider.getTypeCount)
        assertEquals(0, provider.openCount)
        assertFalse(model.state.value.active.assetsDirty)
        assertEquals(MediaStorage.UNGRANTED_DROP_IMAGE_MESSAGE, model.state.value.message)

        // 3. Tree-contained URI attempting to ride on a persisted SAF folder grant via a decoy drag grant is rejected before opening.
        var done3 = false
        var res3: JSONArray? = JSONArray().put("sentinel")
        model.importDropped(
            uris = listOf(treeContainedSecretUri),
            id = noteId,
            dragReadPermissionGranted = true,
        ) { images -> res3 = images; done3 = true }
        drainMain { done3 }

        assertNull(res3)
        assertEquals(0, provider.queryCount)
        assertEquals(0, provider.getTypeCount)
        assertEquals(0, provider.openCount)
        assertFalse(model.state.value.active.assetsDirty)
        assertEquals(MediaStorage.UNSUPPORTED_DROP_IMAGE_MESSAGE, model.state.value.message)

        // 4. Mixed batch with one granted URI and one ungranted URI imports only the granted URI without touching the ungranted one.
        var res4: JSONArray? = null
        model.importDropped(
            uris = listOf(allowedUri, ungrantedUri),
            id = noteId,
            dragReadPermissionGranted = true,
        ) { images -> res4 = images }
        drainMain { res4 != null }

        assertEquals(1, res4!!.length())
        assertEquals("allowed", res4!!.getJSONObject(0).getString("alt"))
        assertEquals(1, provider.openCount)
        assertEquals("Skipped 1 image without read permission.", model.state.value.message)
    }

    @Test fun privateStorageFilesSymlinksAndRedirectedProviderDescriptorsAreRejectedOnDrop() {
        val privateFilesImg = File(app.filesDir, "private-attachment.png").apply { writeBytes(VALID_PNG_BYTES) }
        val privateCacheImg = File(app.cacheDir, "cached-preview.png").apply { writeBytes(VALID_PNG_BYTES) }
        val privatePrefsImg = File(app.dataDir, "shared_prefs/secret.png").apply {
            parentFile?.mkdirs()
            writeBytes(VALID_PNG_BYTES)
        }
        val publicSymlinkToPrivate = File(tempDir, "innocent-symlink.png")
        Files.createSymbolicLink(publicSymlinkToPrivate.toPath(), privateFilesImg.toPath())
        val publicDirectory = File(tempDir, "folder.png").apply { mkdirs() }

        // Malicious external ContentProvider that grants read access to its own URI, but redirects openFile()
        // to return a ParcelFileDescriptor pointing inside Super MD's app-private filesDir.
        provider.entries["redirected.png"] = FakeDropProvider.Entry(
            name = "redirected.png",
            mime = "image/png",
            bytes = VALID_PNG_BYTES,
            backingFile = privateFilesImg,
        )
        val redirectedUri = Uri.parse("content://$AUTHORITY/redirected.png")
        val userPrefixedShareUri = Uri.parse("content://0@${app.packageName}.share/secret.png")
        grantRead(redirectedUri)

        val model = StudioViewModel(app)
        drainMain()
        val noteId = model.state.value.active.id
        val initialContent = model.state.value.active.content
        val beforeAttachments = File(app.filesDir, "attachments").listFiles()?.map { it.name }?.toSet().orEmpty()

        val forbiddenDropUris = listOf(
            Uri.fromFile(privateFilesImg),
            Uri.fromFile(privateCacheImg),
            Uri.fromFile(privatePrefsImg),
            Uri.fromFile(publicSymlinkToPrivate),
            Uri.fromFile(publicDirectory),
            Uri.parse("file:///data/data/${app.packageName}/files/private-attachment.png"),
            Uri.parse("file:///sdcard/android/DATA/${app.packageName}/files/private-attachment.png"),
            Uri.parse("file:///proc/self/cmdline"),
            userPrefixedShareUri,
            redirectedUri,
        )

        var done = false
        var imported: JSONArray? = JSONArray().put("sentinel")
        model.importDropped(
            uris = forbiddenDropUris,
            id = noteId,
            dragReadPermissionGranted = true,
        ) { images ->
            imported = images
            done = true
        }
        drainMain { done }

        assertNull(imported)
        assertEquals(initialContent, model.state.value.active.content)
        assertFalse(model.state.value.active.assetsDirty)
        assertEquals(MediaStorage.UNSUPPORTED_DROP_IMAGE_MESSAGE, model.state.value.message)
        val afterAttachments = File(app.filesDir, "attachments").listFiles()?.map { it.name }?.toSet().orEmpty()
        assertEquals(beforeAttachments, afterAttachments)

        // Descriptor redirection and user-prefixed share URIs are also blocked on the picker path.
        for (forbiddenPickerUri in listOf(redirectedUri, userPrefixedShareUri)) {
            var pickerDone = false
            var pickerResult: JSONArray? = JSONArray().put("sentinel")
            model.importPickedImages(listOf(forbiddenPickerUri), noteId) { images ->
                pickerResult = images
                pickerDone = true
            }
            drainMain { pickerDone }
            assertNull(pickerResult)
            assertNotNull(model.state.value.error)
        }

        privateFilesImg.delete()
        privateCacheImg.delete()
        privatePrefsImg.delete()
    }
}
