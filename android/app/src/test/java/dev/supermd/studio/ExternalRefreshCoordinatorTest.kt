package dev.supermd.studio

import android.app.Application
import android.content.ContentProvider
import android.content.ContentValues
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
import java.time.Duration
import java.util.UUID
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
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
class ExternalRefreshCoordinatorTest {
    private lateinit var app: Application
    private lateinit var tempDir: File
    private lateinit var baselinePortableDirs: Set<String>
    private var previousAutosave: Boolean? = null
    private var previousRecent: String? = null
    private val stores = mutableListOf<ViewModelStore>()
    private val keys = mutableListOf<String>()
    private val authorities = mutableListOf<String>()

    @Before fun setUp() {
        app = RuntimeEnvironment.getApplication()
        tempDir = Files.createTempDirectory("ext-refresh-coord").toFile()
        baselinePortableDirs = File(app.filesDir, "portable-assets").listFiles()?.map { it.name }?.toSet().orEmpty()
        val prefs = app.getSharedPreferences("studio", 0)
        previousAutosave = prefs.getBoolean("autosave", true)
        previousRecent = prefs.getString("recent", null)
        prefs.edit().putBoolean("autosave", false).commit()
    }

    @After fun tearDown() {
        shadowOf(Looper.getMainLooper()).idle()
        stores.forEach { it.clear() }
        shadowOf(Looper.getMainLooper()).idle()
        authorities.forEach(TestAuthorityGrants::unregisterAuthority)
        ShadowContentResolver.reset()
        tempDir.deleteRecursively()
        app.getSharedPreferences("studio", 0).edit().apply {
            putBoolean("autosave", previousAutosave ?: true)
            if (previousRecent == null) remove("recent") else putString("recent", previousRecent)
        }.commit()
        keys.forEach { k ->
            File(app.filesDir, "workspaces/$k.json").delete()
            File(app.filesDir, "workspaces/$k").deleteRecursively()
            File(app.filesDir, "closed-notes/$k").deleteRecursively()
            app.deleteSharedPreferences("studio-window-$k")
        }
        File(app.filesDir, "portable-assets").listFiles()?.forEach { if (it.name !in baselinePortableDirs) it.deleteRecursively() }
    }

    private fun await(predicate: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 5_000L
        while (System.currentTimeMillis() < deadline && !predicate()) {
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(25)); Thread.sleep(10)
        }
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(25))
        assertTrue("Condition timed out", predicate())
    }

    @Test fun refreshAdoptsCleanNotesFlagsDirtyConflictAndCleansOnlyUnreferencedPortableDirs() {
        val key = "erc-${UUID.randomUUID()}".also(keys::add)
        val model = StudioViewModel(app, key).also {
            it.readerFlushRequester = { true }; ViewModelStore().also(stores::add).put("vm", it)
        }
        val closedSmd = File(tempDir, "Closed.smd").also { it.outputStream().use { s -> model.media.writeFmd(s, "# Closed\n", JSONObject().put("assets/c.svg", SVG_A)) } }
        val cleanMd = File(tempDir, "Clean.md").apply { writeText("# Clean v1\n") }
        val cleanSmd = File(tempDir, "Clean.smd").also { it.outputStream().use { s -> model.media.writeFmd(s, "# Portable v1\n", JSONObject().put("assets/p.svg", SVG_A)) } }
        val dirtyMd = File(tempDir, "Dirty.md").apply { writeText("# Dirty v1\n") }

        model.open(Uri.fromFile(closedSmd))
        await { model.state.value.tabs.any { it.uri == Uri.fromFile(closedSmd).toString() } }
        val closedTab = model.state.value.tabs.single { it.uri == Uri.fromFile(closedSmd).toString() }
        val closedDir = closedTab.assetDirectory!!
        model.close(closedTab.id)
        await { model.state.value.closedTabs.any { it.id == closedTab.id } }

        listOf(cleanMd, cleanSmd, dirtyMd).forEach { model.open(Uri.fromFile(it)) }
        await { model.state.value.tabs.count { it.uri != null } == 3 }
        val cleanMdId = model.state.value.tabs.single { it.uri == Uri.fromFile(cleanMd).toString() }.id
        val cleanSmdTab = model.state.value.tabs.single { it.uri == Uri.fromFile(cleanSmd).toString() }
        val initialSmdDir = cleanSmdTab.assetDirectory!!
        val dirtyMdId = model.state.value.tabs.single { it.uri == Uri.fromFile(dirtyMd).toString() }.id
        model.edit(dirtyMdId, "# Unsaved local draft\n")

        cleanMd.writeText("\uFEFF# Clean v2\n")
        cleanSmd.outputStream().use { model.media.writeFmd(it, "# Portable v2\n", JSONObject().put("assets/p.svg", SVG_B)) }
        dirtyMd.writeText("# Disk overwrite\n")
        model.refreshExternal(immediate = true)
        await {
            !model.isRefreshExternalActive() &&
                model.state.value.tabs.single { it.id == cleanMdId }.content == "# Clean v2\n" &&
                model.state.value.tabs.single { it.id == cleanSmdTab.id }.content == "# Portable v2\n" &&
                dirtyMdId in model.state.value.conflictedTabIds
        }

        val refreshedSmdDir = model.state.value.tabs.single { it.id == cleanSmdTab.id }.assetDirectory!!
        assertEquals("# Clean v2\n", model.state.value.tabs.single { it.id == cleanMdId }.saved)
        assertEquals("# Portable v2\n", model.state.value.tabs.single { it.id == cleanSmdTab.id }.saved)
        assertNotEquals(initialSmdDir, refreshedSmdDir)
        assertEquals(SVG_B, model.media.portableAssets(refreshedSmdDir).optString("assets/p.svg"))
        assertEquals("# Unsaved local draft\n", model.state.value.tabs.single { it.id == dirtyMdId }.content)
        assertFalse(model.isPortableDirectoryReferenced(initialSmdDir))
        assertTrue(model.isPortableDirectoryReferenced(refreshedSmdDir))
        assertTrue(model.isPortableDirectoryReferenced(closedDir))
        await { !File(app.filesDir, "portable-assets/$initialSmdDir").exists() }
        assertTrue(File(app.filesDir, "portable-assets/$refreshedSmdDir").isDirectory)
        assertTrue(File(app.filesDir, "portable-assets/$closedDir").isDirectory)
    }

    @Test fun refreshPreservesReadOnlyWriteBlockAndOrdinaryProviderErrorFallbacks() {
        val authority = "dev.supermd.test.erc.${UUID.randomUUID()}".also(authorities::add)
        val provider = RefreshFallbackProvider(tempDir).also {
            it.attachInfo(app, ProviderInfo().apply { this.authority = authority; exported = true; grantUriPermissions = true })
            ShadowContentResolver.registerProviderInternal(authority, it)
        }
        val key = "erc-guard-${UUID.randomUUID()}".also(keys::add)
        val model = StudioViewModel(app, key).also {
            it.readerFlushRequester = { true }; ViewModelStore().also(stores::add).put("vm", it)
        }
        val rw = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        val readOnlyFile = File(tempDir, "ReadOnly.md").apply { writeText("# ReadOnly v1\n") }
        val dirtyFile = File(tempDir, "Dirty.md").apply { writeText("# Dirty v1\n") }
        val smdFile = File(tempDir, "Bundle.smd").also { it.outputStream().use { s -> model.media.writeFmd(s, "# Bundle v1\n", JSONObject().put("assets/p.svg", SVG_A)) } }
        val readOnlyUri = DocumentsContract.buildDocumentUri(authority, "ReadOnly.md")
        val dirtyUri = DocumentsContract.buildDocumentUri(authority, "Dirty.md")
        val smdUri = DocumentsContract.buildDocumentUri(authority, "Bundle.smd")
        listOf(readOnlyUri, dirtyUri, smdUri).forEach { TestAuthorityGrants.grant(it, rw, persistable = true); TestAuthorityGrants.takePersistable(it, rw) }

        listOf(readOnlyUri, dirtyUri, smdUri).forEach { model.open(it); await { model.state.value.tabs.any { t -> t.uri == it.toString() } } }
        val readOnlyId = model.state.value.tabs.single { it.uri == readOnlyUri.toString() }.id
        val dirtyId = model.state.value.tabs.single { it.uri == dirtyUri.toString() }.id
        val smdId = model.state.value.tabs.single { it.uri == smdUri.toString() }.id
        val smdDir = model.state.value.tabs.single { it.id == smdId }.assetDirectory!!
        model.edit(dirtyId, "# Dirty draft\n")

        val validSmdBytes = smdFile.readBytes()
        smdFile.writeBytes("corrupt-not-smd".toByteArray())
        provider.failures["ReadOnly.md"] = { FileNotFoundException("missing replica") }
        provider.failures["Dirty.md"] = { IllegalStateException("provider busy") }
        runBlocking { model.refreshExternalTabs(model.state.value.tabs) }
        listOf(readOnlyId, dirtyId, smdId).forEach { assertFalse(model.state.value.writeNeedsAccess(it)) }
        assertTrue(model.state.value.conflictedTabIds.isEmpty())
        assertNull(model.documentAccessRequests.value)
        assertEquals("# ReadOnly v1\n", model.state.value.tabs.single { it.id == readOnlyId }.content)
        assertEquals("# Dirty draft\n", model.state.value.tabs.single { it.id == dirtyId }.content)
        assertEquals(smdDir, model.state.value.tabs.single { it.id == smdId }.assetDirectory)
        assertTrue(File(app.filesDir, "portable-assets/$smdDir").isDirectory)

        provider.failures.clear()
        smdFile.writeBytes(validSmdBytes)
        readOnlyFile.writeText("# ReadOnly v2\n")
        TestAuthorityGrants.revoke(readOnlyUri, Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        TestAuthorityGrants.revoke(dirtyUri)
        model.refreshExternal(immediate = true)
        await { !model.isRefreshExternalActive() && model.state.value.writeNeedsAccess(readOnlyId) && model.state.value.writeNeedsAccess(dirtyId) }
        assertEquals("# ReadOnly v2\n", model.state.value.tabs.single { it.id == readOnlyId }.content)
        assertEquals("# Dirty draft\n", model.state.value.tabs.single { it.id == dirtyId }.content)
        assertFalse(dirtyId in model.state.value.conflictedTabIds)
        assertFalse(model.state.value.writeNeedsAccess(smdId))
        assertNull(model.documentAccessRequests.value)

        TestAuthorityGrants.grant(readOnlyUri, rw, persistable = true); TestAuthorityGrants.takePersistable(readOnlyUri, rw)
        model.refreshExternal(readOnlyUri, immediate = true)
        await { !model.isRefreshExternalActive() }
        assertTrue(model.state.value.writeNeedsAccess(readOnlyId))
    }

    companion object {
        private const val SVG_A = "data:image/svg+xml;base64,PHN2ZyBpZD0iYSIvPg=="
        private const val SVG_B = "data:image/svg+xml;base64,PHN2ZyBpZD0iYiIvPg=="
    }
}

private class RefreshFallbackProvider(private val dir: File) : ContentProvider() {
    val failures = mutableMapOf<String, () -> Throwable>()
    override fun onCreate(): Boolean = true
    override fun getType(uri: Uri): String = if (DocumentsContract.getDocumentId(uri).endsWith(".smd")) "application/vnd.supermd.smd" else "text/markdown"
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor {
        if (TestAuthorityGrants.check(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) == false) throw SecurityException("denied $uri")
        val id = DocumentsContract.getDocumentId(uri).also { failures[it]?.invoke()?.let { err -> throw err } }
        val file = File(dir, id).takeIf(File::exists) ?: throw FileNotFoundException(id)
        val cols = projection ?: arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME, OpenableColumns.SIZE)
        return MatrixCursor(cols).apply {
            addRow(cols.map { if (it == DocumentsContract.Document.COLUMN_DOCUMENT_ID) id else if (it == OpenableColumns.SIZE || it == DocumentsContract.Document.COLUMN_SIZE) file.length() else file.name }.toTypedArray())
        }
    }
    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        val req = if (mode == "r") Intent.FLAG_GRANT_READ_URI_PERMISSION else Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        if (TestAuthorityGrants.check(uri, req) == false) throw SecurityException("denied $uri ($mode)")
        val id = DocumentsContract.getDocumentId(uri).also { failures[it]?.invoke()?.let { err -> throw err } }
        val file = File(dir, id).takeIf(File::exists) ?: throw FileNotFoundException(id)
        return ParcelFileDescriptor.open(file, if (mode == "r") ParcelFileDescriptor.MODE_READ_ONLY else ParcelFileDescriptor.MODE_READ_WRITE)
    }
}
