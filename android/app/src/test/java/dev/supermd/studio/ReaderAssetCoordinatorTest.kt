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

    @Test fun linkedReaderAssetsEnforceSharedPermissionAndDescriptorValidationWhilePreservingStreams() {
        val grantedUris = mutableMapOf<Uri, Int>()
        val enforcingApp = object : Application() {
            init {
                attachBaseContext(app)
            }
            override fun grantUriPermission(toPackage: String?, uri: Uri?, modeFlags: Int) {
                super.grantUriPermission(toPackage, uri, modeFlags)
                if (uri != null) grantedUris[uri] = (grantedUris[uri] ?: 0) or modeFlags
            }
            override fun revokeUriPermission(uri: Uri?, modeFlags: Int) {
                super.revokeUriPermission(uri, modeFlags)
                if (uri != null) {
                    val rem = (grantedUris[uri] ?: 0) and modeFlags.inv()
                    if (rem == 0) grantedUris.remove(uri) else grantedUris[uri] = rem
                }
            }
            override fun checkUriPermission(uri: Uri?, pid: Int, uid: Int, modeFlags: Int): Int {
                val held = if (uri != null) grantedUris[uri] ?: 0 else 0
                return if ((held and modeFlags) == modeFlags) {
                    android.content.pm.PackageManager.PERMISSION_GRANTED
                } else {
                    android.content.pm.PackageManager.PERMISSION_DENIED
                }
            }
        }

        val authority = "dev.supermd.test.reader.guard.${System.nanoTime()}"
        val provider = SimpleAssetProvider(tempDir).also { it.attach(app, authority) }
        ShadowContentResolver.registerProviderInternal(authority, provider)

        val model = StudioViewModel(enforcingApp, "coord-guard-${System.nanoTime()}".also { cleanups += File(app.filesDir, "workspaces/$it") }).also {
            it.readerFlushRequester = { true }
            ViewModelStore().also(stores::add).put("m", it)
        }
        val note = model.state.value.active

        val pngBytes = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3)
        val ungrantedDiagramUri = provider.put("flow.mmd", "flowchart LR\n  A --> B\n".toByteArray())
        val privateSecret = File(app.filesDir, "private-linked-secret.mmd").apply { writeText("flowchart LR\n  Secret --> Leak\n") }
        val redirectedAssetUri = provider.putWithBackingFile("secret.mmd", privateSecret)

        // 1. restoreDocumentAccess for a linked asset rejects ungranted SAF URIs before query or openFile.
        provider.queryCount = 0
        provider.openCount = 0
        val ungrantedReq = DocumentAccessRequest(note.uri ?: note.id, "flow.mmd", note.id, false, assetSource = "diagrams/flow.mmd")
        model.restoreDocumentAccess(ungrantedReq, ungrantedDiagramUri)
        idleUntil { model.documentAccessRequests.value?.detail != null }
        assertEquals(0, provider.queryCount)
        assertEquals(0, provider.openCount)
        model.dismissDocumentAccess()

        // 2. restoreDocumentAccess rejects redirected app-private descriptors BEFORE querying display name.
        enforcingApp.grantUriPermission(app.packageName, redirectedAssetUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        provider.queryCount = 0
        provider.openCount = 0
        val redirectReq = DocumentAccessRequest(note.uri ?: note.id, "secret.mmd", note.id, false, assetSource = "diagrams/secret.mmd")
        model.restoreDocumentAccess(redirectReq, redirectedAssetUri)
        idleUntil { model.documentAccessRequests.value?.detail != null }
        assertEquals(1, provider.openCount)
        assertEquals(0, provider.queryCount)
        assertTrue(model.documentAccessRequests.value!!.detail!!.contains("App-private paths cannot be opened externally"))
        model.dismissDocumentAccess()

        // 3. Revoked grant on a remembered linked asset fails permission check before query/open and prompts access recovery.
        val imageUri = provider.put("chart.png", pngBytes, mimeType = "image/png")
        enforcingApp.grantUriPermission(app.packageName, imageUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        var linkedDone = false
        model.assetAccessRestored = { _, restored -> if (restored == "images/chart.png") linkedDone = true }
        model.restoreDocumentAccess(DocumentAccessRequest(note.uri ?: note.id, "chart.png", note.id, false, assetSource = "images/chart.png"), imageUri)
        idleUntil { linkedDone && model.documentAccessRequests.value == null }

        enforcingApp.revokeUriPermission(imageUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        provider.queryCount = 0
        provider.openCount = 0
        val revokedError = assertThrows(SecurityException::class.java) {
            runBlocking { model.asset(note.id, "images/chart.png") }
        }
        assertEquals(0, provider.queryCount)
        assertEquals(0, provider.openCount)
        assertTrue(model.reportLinkedAssetFailure(note.id, "images/chart.png", revokedError))
        assertNotNull(model.documentAccessRequests.value)
        model.dismissDocumentAccess()

        // 4. Granted pipe-streamed (S_ISFIFO) linked assets remain working and bounded.
        val pipeUri = provider.putPipe("stream.mmd", "flowchart TD\n  Start --> Stop\n".toByteArray(), mimeType = "text/plain")
        enforcingApp.grantUriPermission(app.packageName, pipeUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        var streamLinked = false
        model.assetAccessRestored = { _, restored -> if (restored == "diagrams/stream.mmd") streamLinked = true }
        model.restoreDocumentAccess(DocumentAccessRequest(note.uri ?: note.id, "stream.mmd", note.id, false, assetSource = "diagrams/stream.mmd"), pipeUri)
        idleUntil { streamLinked && model.documentAccessRequests.value == null }
        assertEquals("flowchart TD\n  Start --> Stop\n", runBlocking { model.textAsset(note.id, "diagrams/stream.mmd") }.getString("text"))

        privateSecret.delete()
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
    private data class Entry(val name: String, val file: File?, val mime: String, val pipeBytes: ByteArray? = null)
    private val files = mutableMapOf<String, Entry>()
    private lateinit var auth: String
    var queryCount = 0
    var openCount = 0
    fun attach(ctx: Context, authority: String) { auth = authority; attachInfo(ctx, ProviderInfo().apply { this.authority = authority; exported = true; grantUriPermissions = true }) }
    fun put(name: String, bytes: ByteArray, mimeType: String = "text/plain"): Uri =
        DocumentsContract.buildDocumentUri(auth, name).also {
            files[name] = Entry(name, File(dir, "${files.size}-$name").apply { writeBytes(bytes) }, mimeType)
        }
    fun putWithBackingFile(name: String, backing: File, mimeType: String = "text/plain"): Uri =
        DocumentsContract.buildDocumentUri(auth, name).also {
            files[name] = Entry(name, backing, mimeType)
        }
    fun putPipe(name: String, bytes: ByteArray, mimeType: String = "text/plain"): Uri =
        DocumentsContract.buildDocumentUri(auth, name).also {
            files[name] = Entry(name, null, mimeType, pipeBytes = bytes)
        }
    override fun onCreate() = true
    override fun getType(uri: Uri) = files[DocumentsContract.getDocumentId(uri)]?.mime ?: "text/plain"
    override fun query(uri: Uri, proj: Array<out String>?, sel: String?, args: Array<out String>?, sort: String?): Cursor {
        queryCount++
        val entry = files[DocumentsContract.getDocumentId(uri)] ?: return MatrixCursor(emptyArray())
        val cols = proj ?: arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE)
        val length = entry.file?.length() ?: entry.pipeBytes?.size?.toLong() ?: -1L
        val mtime = entry.file?.lastModified() ?: 1_000L
        return MatrixCursor(cols).apply { addRow(cols.map<String, Any?> { when (it) { DocumentsContract.Document.COLUMN_DISPLAY_NAME -> entry.name; DocumentsContract.Document.COLUMN_MIME_TYPE -> entry.mime; DocumentsContract.Document.COLUMN_SIZE -> length; DocumentsContract.Document.COLUMN_LAST_MODIFIED -> mtime; else -> null } }.toTypedArray()) }
    }
    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        openCount++
        val entry = files[DocumentsContract.getDocumentId(uri)]!!
        if (entry.pipeBytes != null) {
            val pipe = ParcelFileDescriptor.createPipe()
            ParcelFileDescriptor.AutoCloseOutputStream(pipe[1]).use { out ->
                out.write(entry.pipeBytes)
                out.flush()
            }
            return pipe[0]
        }
        return ParcelFileDescriptor.open(entry.file!!, ParcelFileDescriptor.MODE_READ_ONLY)
    }
    override fun insert(uri: Uri, v: ContentValues?): Uri? = null
    override fun delete(uri: Uri, s: String?, a: Array<out String>?) = 0
    override fun update(uri: Uri, v: ContentValues?, s: String?, a: Array<out String>?) = 0
}
