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
class DocumentAccessCoordinatorTest {
    private lateinit var app: android.app.Application
    private lateinit var root: File
    private lateinit var authority: String
    private val stores = mutableListOf<ViewModelStore>()
    private val workspaces = mutableListOf<String>()

    @Before fun setUp() {
        app = RuntimeEnvironment.getApplication()
        root = Files.createTempDirectory("doc-access-coord").toFile()
        authority = "dev.supermd.test.coord.${System.nanoTime()}"
        ShadowContentResolver.registerProviderInternal(authority, TestDocProvider(root).also { it.attach(app, authority) })
        app.getSharedPreferences("studio", Context.MODE_PRIVATE).edit().putBoolean("autosave", false).commit()
    }

    @After fun tearDown() {
        stores.forEach { it.clear() }
        ShadowContentResolver.reset()
        root.deleteRecursively()
        workspaces.forEach { File(app.filesDir, "workspaces/$it").deleteRecursively() }
    }

    private fun await(done: () -> Boolean) {
        repeat(200) {
            shadowOf(Looper.getMainLooper()).idle()
            if (done()) return
            Thread.sleep(5)
        }
        assertTrue("Timed out awaiting condition", done())
    }

    private fun docUri(id: String, text: String): Uri {
        File(root, id.replace('/', '_')).writeText(text, Charsets.UTF_8)
        return DocumentsContract.buildDocumentUri(authority, id).also { uri ->
            app.grantUriPermission(app.packageName, uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        }
    }

    @Test fun coordinatorSynchronizesBlockedWritesLiveDocumentAccessAndLinkedAssets() {
        val noteUri = docUri("folder/Note.md", "# Baseline\n")
        val wrongAssetUri = docUri("folder/wrong.png", "wrong")
        val rightAssetUri = docUri("folder/diagram.png", "right")
        val ws = "coord-${System.nanoTime()}".also(workspaces::add)
        val model = StudioViewModel(app, ws).also { it.readerFlushRequester = { true }; ViewModelStore().also(stores::add).put("m", it) }

        model.open(noteUri)
        await { model.state.value.tabs.any { it.uri == noteUri.toString() } }
        val id = model.state.value.tabs.single { it.uri == noteUri.toString() }.id
        val draft = "# Baseline\nUnsaved draft line\n"
        model.edit(id, draft)

        assertEquals(DOCUMENT_ACCESS_MESSAGE, model.reportDocumentSaveFailure(id, SecurityException("denied"), "fallback"))
        assertTrue(model.documentWriteNeedsAccess(id))
        assertTrue(noteUri.toString() in model.state.value.blockedWriteUris)
        assertEquals(id, model.documentAccessRequests.value?.noteId)
        assertTrue(model.documentAccessRequests.value?.writing == true)

        model.dismissDocumentAccess()
        assertTrue(model.requestWriteAccessIfBlocked(id, explicit = false))
        assertNull(model.documentAccessRequests.value)
        assertTrue(model.requestWriteAccessIfBlocked(id, explicit = true))
        val writeRequest = model.documentAccessRequests.value!!

        var liveResolveObserved = false
        val base = model.documentAccess
        model.documentAccess = object : DocumentAccess(
            app, base.activeFolderUriProvider, base.relativeHintProvider, base.isConfirmedTreeChildProvider, base.onConfirmedTreeKeys,
        ) {
            override fun resolve(uri: Uri, writing: Boolean): Uri {
                liveResolveObserved = true
                return super.resolve(uri, writing)
            }
        }
        model.restoreDocumentAccess(writeRequest, noteUri)
        await { model.documentAccessRequests.value == null }
        assertTrue(liveResolveObserved)
        assertFalse(model.documentWriteNeedsAccess(id))
        assertTrue(model.state.value.blockedWriteUris.isEmpty())
        assertEquals(draft, model.state.value.tabs.single { it.id == id }.content)

        var restoredAsset: Pair<String, String>? = null
        model.assetAccessRestored = { doc, src -> restoredAsset = doc to src }
        assertTrue(model.reportLinkedAssetFailure(id, "assets/diagram.png", SecurityException("asset denied")))
        val assetRequest = model.documentAccessRequests.value!!
        model.restoreDocumentAccess(assetRequest, wrongAssetUri)
        await { model.documentAccessRequests.value?.detail != null }
        assertTrue(model.documentAccessRequests.value?.detail.orEmpty().contains("Choose diagram.png"))
        assertNull(restoredAsset)

        model.restoreDocumentAccess(model.documentAccessRequests.value!!, rightAssetUri)
        await { model.documentAccessRequests.value == null }
        assertEquals(noteUri.toString() to "assets/diagram.png", restoredAsset)
    }
}

private class TestDocProvider(private val root: File) : ContentProvider() {
    fun attach(context: Context, authority: String) =
        attachInfo(context, ProviderInfo().apply { this.authority = authority; exported = true; grantUriPermissions = true })
    override fun onCreate() = true
    override fun getType(uri: Uri) = "text/markdown"
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0
    override fun query(uri: Uri, projection: Array<out String>?, s: String?, a: Array<out String>?, o: String?): Cursor {
        val docId = DocumentsContract.getDocumentId(uri)
        val name = docId.substringAfterLast('/')
        val cols = projection ?: arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, OpenableColumns.DISPLAY_NAME)
        return MatrixCursor(cols).apply { addRow(cols.map { if (it == OpenableColumns.DISPLAY_NAME || it == DocumentsContract.Document.COLUMN_DISPLAY_NAME) name else docId }.toTypedArray()) }
    }
    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor =
        ParcelFileDescriptor.open(File(root, DocumentsContract.getDocumentId(uri).replace('/', '_')), if (mode == "r") ParcelFileDescriptor.MODE_READ_ONLY else ParcelFileDescriptor.MODE_READ_WRITE)
}
