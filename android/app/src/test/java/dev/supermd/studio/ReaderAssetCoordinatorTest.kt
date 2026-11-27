package dev.supermd.studio

import android.app.Application
import android.content.*
import android.content.pm.ProviderInfo
import android.database.*
import android.net.Uri
import android.os.*
import android.provider.DocumentsContract
import androidx.lifecycle.ViewModelStore
import java.io.File
import java.nio.charset.MalformedInputException
import java.nio.file.Files
import kotlinx.coroutines.runBlocking
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import org.robolectric.*
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowContentResolver

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ReaderAssetCoordinatorTest {
    private lateinit var app: Application
    private lateinit var tempDir: File
    private var prevPrefs: Map<String, *>? = null
    private val stores = mutableListOf<ViewModelStore>()
    private val cleanups = mutableListOf<File>()

    @Before fun setUp() {
        app = RuntimeEnvironment.getApplication()
        tempDir = Files.createTempDirectory("reader-coordinator-test").toFile().also(cleanups::add)
        val prefs = app.getSharedPreferences("studio", Context.MODE_PRIVATE)
        prevPrefs = HashMap(prefs.all)
        prefs.edit().putBoolean("autosave", false).remove("linkedAssetGrants").commit()
    }

    @After fun tearDown() {
        stores.forEach { it.clear() }; shadowOf(Looper.getMainLooper()).idle()
        app.getSharedPreferences("studio", Context.MODE_PRIVATE).edit().apply {
            clear()
            prevPrefs?.forEach { (k, v) -> when (v) { is Boolean -> putBoolean(k, v); is String -> putString(k, v); is Int -> putInt(k, v); is Long -> putLong(k, v); is Float -> putFloat(k, v) } }
        }.commit()
        ShadowContentResolver.reset()
        cleanups.forEach { it.deleteRecursively() }
    }

    @Test fun capabilityLifecycleInvalidationAndTargetMatchingRoundTrip() {
        val model = newModel()
        val note = model.state.value.active
        val attached = ReaderAssetCapabilities().also(model::attachReaderCapabilities)
        val detached = ReaderAssetCapabilities().also(model::attachReaderCapabilities).also(model::detachReaderCapabilities)
        attached.register(note.id, "assets/a.png", "image/png", "rev-1")
        detached.register(note.id, "assets/a.png", "image/png", "rev-1")

        assertTrue(model.matchesReaderAssetNote(note.id))
        assertFalse(model.matchesReaderAssetNote("missing-note"))
        val matching = ReaderAssetTarget.LocalFile(tempDir, File(tempDir, "a.png"), note.uri, note.relative, note.assetDirectory)
        assertTrue(model.matchesReaderAssetNote(note.id, matching))
        assertFalse(model.matchesReaderAssetNote(note.id, matching.copy(noteUri = "content://other/doc")))
        assertFalse(model.matchesReaderAssetNote(note.id, matching.copy(noteRelative = "Moved.md")))

        model.invalidateNoteAssets(note.id)
        assertEquals(0, attached.size())
        assertEquals(1, detached.size())
        attached.register(note.id, "assets/b.png", "image/png", "rev-2")
        model.invalidateAllNoteAssets()
        assertEquals(0, attached.size())
    }

    @Test fun textAssetLoadsGrantedMermaidSourcesAndRejectsNonMermaidOrMalformedUtf8() {
        val authority = "dev.supermd.test.mermaid.${System.nanoTime()}"
        val provider = SimpleAssetProvider(tempDir).also { it.attach(app, authority) }
        ShadowContentResolver.registerProviderInternal(authority, provider)
        val model = newModel()
        val note = model.state.value.active
        grantLinkedAsset(model, note, "diagrams/flow.mmd", "flow.mmd", provider.put("flow.mmd", "flowchart LR\n  A --> B\n".toByteArray()))
        grantLinkedAsset(model, note, "diagrams/seq.mermaid?v=1#top", "seq.mermaid", provider.put("seq.mermaid", "sequenceDiagram\n  A->>B: ok".toByteArray()))
        grantLinkedAsset(model, note, "diagrams/bad.mmd", "bad.mmd", provider.put("bad.mmd", byteArrayOf(0xC3.toByte(), 0x28)))

        assertEquals("flowchart LR\n  A --> B\n", runBlocking { model.textAsset(note.id, "diagrams/flow.mmd") }.getString("text"))
        assertEquals("sequenceDiagram\n  A->>B: ok", runBlocking { model.textAsset(note.id, "diagrams/seq.mermaid?v=1#top") }.getString("text"))
        assertThrows(IllegalArgumentException::class.java) { runBlocking { model.textAsset(note.id, "diagrams/readme.txt") } }
        assertThrows(MalformedInputException::class.java) { runBlocking { model.textAsset(note.id, "diagrams/bad.mmd") } }
    }

    @Test fun portableLocalAssetFastPathAndCapabilityRevalidationEnforceFreshOpenTarget() {
        val model = newModel()
        var created: Note? = null
        model.newNote(titleHint = "Portable", format = "smd") { created = it }
        idleUntil { created != null && model.state.value.activeId == created!!.id }
        val note = model.state.value.tabs.single { it.id == created!!.id }
        val png = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3)
        val file = File(File(app.filesDir, "portable-assets/${note.assetDirectory}").also(cleanups::add), "plot.png").apply { parentFile!!.mkdirs(); writeBytes(png) }

        assertTrue(runBlocking { model.asset(note.id, "assets/plot.png") }.startsWith("data:image/png;base64,"))
        val (_, resolved) = model.resolveReaderAsset(note.id, "assets/plot.png")
        val cap = ReaderAssetCapabilities().register(note.id, "assets/plot.png", resolved.mime, resolved.fingerprint, resolved.target)!!
        assertArrayEquals(png, model.openReaderAsset(cap).stream.use { it.readBytes() })
        assertArrayEquals(png, model.openReaderAsset(note.id, "assets/plot.png", resolved.fingerprint).stream.use { it.readBytes() })

        assertThrows(IllegalArgumentException::class.java) {
            model.openReaderAsset(cap.copy(target = (resolved.target as ReaderAssetTarget.LocalFile).copy(noteRelative = "Other.smd")))
        }
        file.writeBytes(png + byteArrayOf(9)); file.setLastModified(file.lastModified() + 5_000L); model.media.invalidateLocalAsset(file)
        assertThrows(IllegalArgumentException::class.java) { model.openReaderAsset(cap) }
        model.close(note.id, discardChanges = true)
        idleUntil { model.state.value.tabs.none { it.id == note.id } }
        assertThrows(IllegalStateException::class.java) { model.openReaderAsset(cap) }
    }

    private fun grantLinkedAsset(model: StudioViewModel, note: Note, source: String, name: String, uri: Uri) {
        var done = false
        model.assetAccessRestored = { _, restored -> if (restored == source) done = true }
        app.grantUriPermission(app.packageName, uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        model.restoreDocumentAccess(DocumentAccessRequest(note.uri ?: note.id, name, note.id, false, assetSource = source), uri)
        idleUntil { done && model.documentAccessRequests.value == null }
    }

    private fun newModel() = StudioViewModel(app, "coord-${System.nanoTime()}".also { cleanups += File(app.filesDir, "workspaces/$it") }).also {
        it.readerFlushRequester = { true }; ViewModelStore().also(stores::add).put("m", it)
    }

    private fun idleUntil(condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 5_000
        while (System.currentTimeMillis() < deadline) { shadowOf(Looper.getMainLooper()).idle(); if (condition()) return; Thread.sleep(10) }
        assertTrue(condition())
    }
}

private class SimpleAssetProvider(private val dir: File) : ContentProvider() {
    private val files = mutableMapOf<String, Pair<String, File>>()
    private lateinit var auth: String
    fun attach(ctx: Context, authority: String) { auth = authority; attachInfo(ctx, ProviderInfo().apply { this.authority = authority; exported = true; grantUriPermissions = true }) }
    fun put(name: String, bytes: ByteArray): Uri = DocumentsContract.buildDocumentUri(auth, name).also { files[name] = name to File(dir, "${files.size}-$name").apply { writeBytes(bytes) } }
    override fun onCreate() = true
    override fun getType(uri: Uri) = "text/plain"
    override fun query(uri: Uri, proj: Array<out String>?, sel: String?, args: Array<out String>?, sort: String?): Cursor {
        val (name, file) = files[DocumentsContract.getDocumentId(uri)] ?: return MatrixCursor(emptyArray())
        val cols = proj ?: arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE)
        return MatrixCursor(cols).apply { addRow(cols.map<String, Any?> { when (it) { DocumentsContract.Document.COLUMN_DISPLAY_NAME -> name; DocumentsContract.Document.COLUMN_MIME_TYPE -> "text/plain"; DocumentsContract.Document.COLUMN_SIZE -> file.length(); DocumentsContract.Document.COLUMN_LAST_MODIFIED -> file.lastModified(); else -> null } }.toTypedArray()) }
    }
    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor = ParcelFileDescriptor.open(files[DocumentsContract.getDocumentId(uri)]!!.second, ParcelFileDescriptor.MODE_READ_ONLY)
    override fun insert(uri: Uri, v: ContentValues?): Uri? = null
    override fun delete(uri: Uri, s: String?, a: Array<out String>?) = 0
    override fun update(uri: Uri, v: ContentValues?, s: String?, a: Array<out String>?) = 0
}
