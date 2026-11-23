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
import android.view.KeyEvent
import androidx.lifecycle.ViewModelStore
import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
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
import org.robolectric.shadows.ShadowContentResolver

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class SaveConflictAndRefreshTest {
    private lateinit var app: android.app.Application
    private lateinit var root: File
    private lateinit var provider: EditableDocumentProvider
    private lateinit var authority: String
    private lateinit var media: MediaStorage
    private var previousAutosave: Boolean? = null
    private var previousRecent: String? = null
    private val workspaceKeys = mutableListOf<String>()
    private val viewModels = mutableListOf<ViewModelStore>()

    @Before fun setUp() {
        app = RuntimeEnvironment.getApplication()
        root = Files.createTempDirectory("save-conflict-refresh-test").toFile()
        authority = "dev.supermd.test.conflicts.${System.nanoTime()}"
        provider = EditableDocumentProvider(root).also { it.attach(app, authority) }
        ShadowContentResolver.registerProviderInternal(authority, provider)
        media = MediaStorage(app)
        val prefs = app.getSharedPreferences("studio", Context.MODE_PRIVATE)
        previousAutosave = prefs.getBoolean("autosave", true)
        previousRecent = prefs.getString("recent", null)
        prefs.edit().putBoolean("autosave", false).commit()
    }

    @After fun tearDown() {
        shadowOf(Looper.getMainLooper()).idle()
        viewModels.forEach { it.clear() }
        shadowOf(Looper.getMainLooper()).idle()
        app.getSharedPreferences("studio", Context.MODE_PRIVATE).edit().apply {
            putBoolean("autosave", previousAutosave ?: true)
            if (previousRecent == null) remove("recent") else putString("recent", previousRecent)
        }.commit()
        ShadowContentResolver.reset()
        root.deleteRecursively()
        workspaceKeys.forEach { File(app.filesDir, "workspaces/$it").deleteRecursively() }
        File(app.filesDir, "portable-assets").deleteRecursively()
    }

    @Test fun handleShortcutBindsCtrlSAndCtrlShiftS() {
        val activity = Robolectric.buildActivity(MainActivity::class.java).get()
        var saves = 0
        var saveAsCalls = 0
        activity.saveNote = { saves++ }
        activity.saveNoteAs = { saveAsCalls++ }

        val ctrlS = KeyEvent(0L, 0L, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_S, 0, KeyEvent.META_CTRL_ON)
        val ctrlShiftS = KeyEvent(0L, 0L, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_S, 0, KeyEvent.META_CTRL_ON or KeyEvent.META_SHIFT_ON)

        val method = MainActivity::class.java.getDeclaredMethod("handleShortcut", KeyEvent::class.java).apply { isAccessible = true }
        assertTrue(method.invoke(activity, ctrlS) as Boolean)
        assertEquals(1, saves)
        assertEquals(0, saveAsCalls)

        assertTrue(method.invoke(activity, ctrlShiftS) as Boolean)
        assertEquals(1, saves)
        assertEquals(1, saveAsCalls)
    }

    @Test fun saveAsFlushesReaderAndRebindsMarkdownAndPortableNotesCleaningUpOldAssets() {
        val model = newModel()
        val firstMd = createDoc("First.md", "# Initial\n")
        val secondMd = createDoc("Second.md", "")
        val initialSmd = createSmd("Initial.smd", "# Portable v1\n", JSONObject().put("assets/diagram.svg", SVG_A))
        val reboundSmd = createSmd("Rebound.smd", "", JSONObject())

        model.open(firstMd)
        await { model.state.value.tabs.any { it.uri == firstMd.toString() } }
        val mdId = model.state.value.tabs.single { it.uri == firstMd.toString() }.id

        var barrierRan = false
        model.readerFlushRequester = {
            barrierRan = true
            model.edit(mdId, "# Flushed from reader\n")
            true
        }
        var preparedNote: Note? = null
        model.prepareSaveAs(mdId) { preparedNote = it }
        await { preparedNote != null }
        assertTrue(barrierRan)
        assertEquals("# Flushed from reader\n", preparedNote!!.content)

        model.readerFlushRequester = { true }
        model.save(secondMd, noteId = mdId)
        await { model.state.value.tabs.single { it.id == mdId }.uri == secondMd.toString() && !model.state.value.busy }
        val reboundMd = model.state.value.tabs.single { it.id == mdId }
        assertEquals("Second.md", reboundMd.name)
        assertEquals("# Flushed from reader\n", reboundMd.saved)
        assertFalse(reboundMd.dirty)
        assertEquals("# Initial\n", provider.fileFor(firstMd).readText())
        assertEquals("# Flushed from reader\n", provider.fileFor(secondMd).readText())

        model.open(initialSmd)
        await { model.state.value.tabs.any { it.uri == initialSmd.toString() } }
        val smdTab = model.state.value.tabs.single { it.uri == initialSmd.toString() }
        val oldAssetDir = smdTab.assetDirectory!!
        assertTrue(portableDir(oldAssetDir).exists())

        model.beginPortableSaveAs(smdTab.id)
        model.setPortableDestination(reboundSmd)
        CoroutineScope(Dispatchers.IO).launch {
            model.writePortable(smdTab.id, "# Portable v2\n", JSONObject().put("assets/diagram.svg", SVG_B), save = false, originalContent = smdTab.content)
        }
        await { model.state.value.tabs.single { it.id == smdTab.id }.uri == reboundSmd.toString() && !model.state.value.busy }

        val updatedSmd = model.state.value.tabs.single { it.id == smdTab.id }
        assertEquals("Rebound.smd", updatedSmd.name)
        assertEquals("# Portable v2\n", updatedSmd.saved)
        assertFalse(updatedSmd.dirty)
        assertNotNull(updatedSmd.assetDirectory)
        assertNotEquals(oldAssetDir, updatedSmd.assetDirectory)
        assertFalse("Old portable-assets directory should be cleaned up after Save as rebind", portableDir(oldAssetDir).exists())
        assertTrue(portableDir(updatedSmd.assetDirectory!!).exists())

        val diskCheck = provider.fileFor(reboundSmd).inputStream().use(media::openFmd)
        try {
            assertEquals("# Portable v2\n", diskCheck.markdown)
            assertEquals(SVG_B, media.portableAssets(diskCheck.directory).optString("assets/diagram.svg"))
        } finally {
            portableDir(diskCheck.directory).deleteRecursively()
        }
    }

    @Test fun manualMarkdownAndPortableSavesHaltOnExternalEditsAndResolveAllThreeConflictChoices() {
        val model = newModel()
        val mdUri = createDoc("Notes.md", "# Baseline\n")
        val copyUri = createDoc("Notes copy.md", "")

        model.open(mdUri)
        await { model.state.value.tabs.any { it.uri == mdUri.toString() } }
        val mdId = model.state.value.tabs.single { it.uri == mdUri.toString() }.id

        // 1. Markdown conflict -> Reload (archives local draft to recovery, loads disk text).
        model.edit(mdId, "# Local unsaved draft\n")
        provider.fileFor(mdUri).writeText("# External edit\n")
        model.save()
        await { model.saveConflict.value != null && !model.state.value.busy }
        assertEquals("# External edit\n", provider.fileFor(mdUri).readText())
        assertEquals(mdId, model.saveConflict.value!!.noteId)
        assertFalse(model.saveConflict.value!!.portable)

        model.resolveConflictReload()
        await { model.saveConflict.value == null && !model.state.value.busy && model.state.value.tabs.single { it.id == mdId }.content == "# External edit\n" }
        val reloaded = model.state.value.tabs.single { it.id == mdId }
        assertEquals("# External edit\n", reloaded.saved)
        assertFalse(reloaded.dirty)
        assertTrue("Local draft should be archived in closed notes", model.state.value.closedTabs.isNotEmpty())

        val mdTabsBeforeReopen = model.state.value.tabs.map { it.id }.toSet()
        model.reopen()
        await { model.state.value.tabs.size == mdTabsBeforeReopen.size + 1 }
        val recovered = model.state.value.tabs.single { it.id !in mdTabsBeforeReopen }
        assertNull(recovered.uri)
        assertEquals("# Local unsaved draft\n", recovered.content)
        assertTrue(recovered.dirty)

        // 2. Markdown conflict -> Save a copy (keeps original untouched, rebinds tab to copy).
        model.select(mdId)
        await { model.state.value.activeId == mdId }
        model.edit(mdId, "# Draft for copy\n")
        provider.fileFor(mdUri).writeText("# Second external edit\n")
        model.save()
        await { model.saveConflict.value != null && !model.state.value.busy }
        var saveCopyTarget: Note? = null
        model.resolveConflictSaveCopy { saveCopyTarget = it }
        await { saveCopyTarget != null && model.saveConflict.value == null }
        model.save(copyUri, noteId = saveCopyTarget!!.id)
        await { model.state.value.tabs.single { it.id == mdId }.uri == copyUri.toString() && !model.state.value.busy }
        assertEquals("# Second external edit\n", provider.fileFor(mdUri).readText())
        assertEquals("# Draft for copy\n", provider.fileFor(copyUri).readText())

        // 3. Portable .smd asset-only conflict -> Reload with portable-assets recovery, and Overwrite.
        val smdUri = createSmd("Bundle.smd", "# Shared body\n", JSONObject().put("assets/diagram.svg", SVG_A))
        model.open(smdUri)
        await { model.state.value.tabs.any { it.uri == smdUri.toString() } }
        val smdId = model.state.value.tabs.single { it.uri == smdUri.toString() }.id
        val initialSmdDir = model.state.value.tabs.single { it.id == smdId }.assetDirectory!!

        // External writer modifies embedded asset on disk while local draft edits markdown.
        writeSmdFile(provider.fileFor(smdUri), "# Shared body\n", JSONObject().put("assets/diagram.svg", SVG_B))
        model.edit(smdId, "# Local portable draft\n")
        CoroutineScope(Dispatchers.IO).launch {
            model.writePortable(smdId, "# Local portable draft\n", JSONObject().put("assets/diagram.svg", SVG_A), save = true, originalContent = "# Local portable draft\n")
        }
        await { model.saveConflict.value != null && !model.state.value.busy }
        assertTrue(model.saveConflict.value!!.portable)

        // Verify external disk archive was not overwritten.
        provider.fileFor(smdUri).inputStream().use(media::openFmd).let { check ->
            try {
                assertEquals("# Shared body\n", check.markdown)
                assertEquals(SVG_B, media.portableAssets(check.directory).optString("assets/diagram.svg"))
            } finally {
                portableDir(check.directory).deleteRecursively()
            }
        }

        // Resolve portable conflict via Reload -> archives local portable draft + copy of assets, loads SVG_B.
        model.resolveConflictReload()
        await { model.saveConflict.value == null && !model.state.value.busy && model.state.value.tabs.single { it.id == smdId }.content == "# Shared body\n" }
        val reloadedSmd = model.state.value.tabs.single { it.id == smdId }
        assertNotEquals(initialSmdDir, reloadedSmd.assetDirectory)
        assertFalse("Old live portable-assets directory should be cleaned up after Reload", portableDir(initialSmdDir).exists())
        assertEquals(SVG_B, media.portableAssets(reloadedSmd.assetDirectory).optString("assets/diagram.svg"))

        val tabsBeforeReopen = model.state.value.tabs.map { it.id }.toSet()
        model.reopen()
        await { model.state.value.tabs.size == tabsBeforeReopen.size + 1 }
        val recoveredSmd = model.state.value.tabs.single { it.id !in tabsBeforeReopen }
        assertEquals("# Local portable draft\n", recoveredSmd.content)
        assertEquals(SVG_A, media.portableAssets(recoveredSmd.assetDirectory).optString("assets/diagram.svg"))

        // Resolve portable conflict via Overwrite -> writes staged draft over external .smd.
        model.select(smdId)
        await { model.state.value.activeId == smdId }
        writeSmdFile(provider.fileFor(smdUri), "# Concurrent portable edit\n", JSONObject().put("assets/diagram.svg", SVG_A))
        model.edit(smdId, "# Overwriting portable draft\n")
        CoroutineScope(Dispatchers.IO).launch {
            model.writePortable(smdId, "# Overwriting portable draft\n", JSONObject().put("assets/diagram.svg", SVG_B), save = true, originalContent = "# Overwriting portable draft\n")
        }
        await { model.saveConflict.value != null && !model.state.value.busy }

        model.resolveConflictOverwrite()
        await { model.saveConflict.value == null && !model.state.value.busy && model.state.value.tabs.single { it.id == smdId }.saved == "# Overwriting portable draft\n" }
        provider.fileFor(smdUri).inputStream().use(media::openFmd).let { check ->
            try {
                assertEquals("# Overwriting portable draft\n", check.markdown)
                assertEquals(SVG_B, media.portableAssets(check.directory).optString("assets/diagram.svg"))
            } finally {
                portableDir(check.directory).deleteRecursively()
            }
        }
    }

    @Test fun androidExternalRefreshUpdatesCleanActiveAndInactiveMarkdownAndPortableTabsAndCleansAssets() {
        val model = newModel()
        val inactiveSmd = createSmd("Inactive.smd", "# Portable one\n", JSONObject().put("assets/diagram.svg", SVG_A))
        val dirtyMd = createDoc("Dirty.md", "# Clean start\n")
        val activeMd = createDoc("Active.md", "# Active one\n")

        model.open(inactiveSmd)
        await { model.state.value.tabs.any { it.uri == inactiveSmd.toString() } }
        val inactiveSmdId = model.state.value.tabs.single { it.uri == inactiveSmd.toString() }.id
        val firstPortableDir = model.state.value.tabs.single { it.id == inactiveSmdId }.assetDirectory!!
        assertTrue(portableDir(firstPortableDir).exists())

        model.open(dirtyMd)
        await { model.state.value.tabs.any { it.uri == dirtyMd.toString() } }
        val dirtyId = model.state.value.tabs.single { it.uri == dirtyMd.toString() }.id
        model.edit(dirtyId, "# Unsaved local changes\n")

        model.open(activeMd)
        await { model.state.value.tabs.any { it.uri == activeMd.toString() } }
        val activeId = model.state.value.tabs.single { it.uri == activeMd.toString() }.id
        assertEquals(activeId, model.state.value.activeId)

        // 1. Observer notification on inactive .smd tab updates it without changing activeId and cleans up old portable-assets.
        writeSmdFile(provider.fileFor(inactiveSmd), "# Portable two\n", JSONObject().put("assets/diagram.svg", SVG_B))
        provider.fileFor(dirtyMd).writeText("# External edit must not clobber dirty tab\n")
        app.contentResolver.notifyChange(inactiveSmd, null)

        await {
            model.state.value.tabs.single { it.id == inactiveSmdId }.content == "# Portable two\n" &&
                !portableDir(firstPortableDir).exists()
        }
        val refreshedInactive = model.state.value.tabs.single { it.id == inactiveSmdId }
        assertEquals(activeId, model.state.value.activeId)
        assertEquals("# Portable two\n", refreshedInactive.saved)
        assertFalse(refreshedInactive.dirty)
        assertNotEquals(firstPortableDir, refreshedInactive.assetDirectory)
        assertFalse("Replaced portable-assets directory must be deleted", portableDir(firstPortableDir).exists())
        assertEquals(SVG_B, media.portableAssets(refreshedInactive.assetDirectory).optString("assets/diagram.svg"))

        // 2. Resume-style refreshExternal() refreshes all clean tabs while preserving dirty drafts and cleaning temporary directories.
        val secondPortableDir = refreshedInactive.assetDirectory!!
        provider.fileFor(activeMd).writeText("# Active two\n")
        // Asset-only update on inactive .smd!
        writeSmdFile(provider.fileFor(inactiveSmd), "# Portable two\n", JSONObject().put("assets/diagram.svg", SVG_A))
        model.refreshExternal()

        await {
            model.state.value.tabs.single { it.id == activeId }.content == "# Active two\n" &&
                model.state.value.tabs.single { it.id == inactiveSmdId }.assetDirectory != secondPortableDir &&
                !portableDir(secondPortableDir).exists()
        }
        val afterResumeSmd = model.state.value.tabs.single { it.id == inactiveSmdId }
        assertFalse(portableDir(secondPortableDir).exists())
        assertEquals(SVG_A, media.portableAssets(afterResumeSmd.assetDirectory).optString("assets/diagram.svg"))
        assertEquals("# Unsaved local changes\n", model.state.value.tabs.single { it.id == dirtyId }.content)

        // Verify no orphan portable-assets directories leaked from unchanged refreshes.
        val thirdPortableDir = afterResumeSmd.assetDirectory!!
        model.refreshExternal(immediate = true)
        Thread.sleep(80)
        shadowOf(Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(250))
        val liveDirs = File(app.filesDir, "portable-assets").listFiles()?.map { it.name }?.toSet().orEmpty()
        assertEquals(setOf(thirdPortableDir), liveDirs)

        // 3. Tab selection triggers immediate external refresh for the selected clean tab.
        writeSmdFile(provider.fileFor(inactiveSmd), "# Portable three on select\n", JSONObject().put("assets/diagram.svg", SVG_B))
        model.select(inactiveSmdId)
        await {
            model.state.value.activeId == inactiveSmdId &&
                model.state.value.tabs.single { it.id == inactiveSmdId }.content == "# Portable three on select\n" &&
                !portableDir(thirdPortableDir).exists()
        }
        assertFalse(portableDir(thirdPortableDir).exists())
    }

    private fun portableDir(name: String): File = File(app.filesDir, "portable-assets/$name")

    private fun createDoc(name: String, content: String): Uri {
        val uri = DocumentsContract.buildDocumentUri(authority, "folder/$name")
        provider.register(name, content.toByteArray(Charsets.UTF_8))
        app.grantUriPermission(app.packageName, uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        return uri
    }

    private fun createSmd(name: String, markdown: String, assets: JSONObject): Uri {
        val uri = DocumentsContract.buildDocumentUri(authority, "folder/$name")
        val file = provider.register(name, ByteArray(0))
        writeSmdFile(file, markdown, assets)
        app.grantUriPermission(app.packageName, uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        return uri
    }

    private fun writeSmdFile(target: File, markdown: String, assets: JSONObject) {
        target.outputStream().use { media.writeFmd(it, markdown, assets) }
    }

    private fun newModel(): StudioViewModel {
        val store = ViewModelStore().also(viewModels::add)
        val key = "conflict-refresh-${System.nanoTime()}".also(workspaceKeys::add)
        val model = StudioViewModel(app, key)
        model.readerFlushRequester = { true }
        store.put("model", model)
        return model
    }

    private fun await(timeoutMs: Long = 5_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        val mainLooper = shadowOf(Looper.getMainLooper())
        while (System.currentTimeMillis() < deadline) {
            mainLooper.idleFor(java.time.Duration.ofMillis(25))
            if (condition()) return
            Thread.sleep(10)
        }
        mainLooper.idleFor(java.time.Duration.ofMillis(25))
        assertTrue("Condition was not met within ${timeoutMs}ms", condition())
    }

    companion object {
        private const val SVG_A = "data:image/svg+xml;base64,PHN2ZyBpZD0iYSIvPg=="
        private const val SVG_B = "data:image/svg+xml;base64,PHN2ZyBpZD0iYiIvPg=="
    }
}

private class EditableDocumentProvider(private val directory: File) : ContentProvider() {
    private val files = linkedMapOf<String, File>()

    fun attach(context: Context, authority: String) {
        val info = ProviderInfo().apply { this.authority = authority; exported = true; grantUriPermissions = true }
        attachInfo(context, info)
    }

    fun register(name: String, initialBytes: ByteArray): File {
        val file = File(directory, name).apply { writeBytes(initialBytes) }
        files[name] = file
        return file
    }

    fun fileFor(uri: Uri): File {
        val name = DocumentsContract.getDocumentId(uri).substringAfterLast('/')
        return files[name] ?: File(directory, name).also { files[name] = it }
    }

    override fun onCreate() = true

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor {
        val columns = projection?.toList() ?: listOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        val file = fileFor(uri)
        return MatrixCursor(columns.toTypedArray()).apply {
            addRow(columns.map { column ->
                when (column) {
                    OpenableColumns.DISPLAY_NAME -> file.name
                    OpenableColumns.SIZE -> file.length()
                    else -> null
                }
            }.toTypedArray<Any?>())
        }
    }

    override fun getType(uri: Uri): String =
        if (fileFor(uri).name.endsWith(".smd", ignoreCase = true)) "application/vnd.supermd.smd" else "text/markdown"

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        val file = fileFor(uri)
        val flags = when (mode) {
            "r" -> ParcelFileDescriptor.MODE_READ_ONLY
            "rw" -> ParcelFileDescriptor.MODE_READ_WRITE
            "wt", "w" -> ParcelFileDescriptor.MODE_WRITE_ONLY or ParcelFileDescriptor.MODE_CREATE or ParcelFileDescriptor.MODE_TRUNCATE
            else -> throw java.io.FileNotFoundException("Unsupported test mode: $mode")
        }
        return ParcelFileDescriptor.open(file, flags)
    }
}
