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
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
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
class ExternalRefreshTest {
    private lateinit var app: android.app.Application
    private lateinit var root: File
    private lateinit var provider: RefreshTestDocumentProvider
    private lateinit var authority: String
    private lateinit var media: MediaStorage
    private var previousAutosave: Boolean? = null
    private var previousRecent: String? = null
    private val workspaceKeys = mutableListOf<String>()
    private val viewModels = mutableListOf<ViewModelStore>()

    @Before fun setUp() {
        app = RuntimeEnvironment.getApplication()
        root = Files.createTempDirectory("external-refresh-test").toFile()
        authority = "dev.supermd.test.refresh.${System.nanoTime()}"
        provider = RefreshTestDocumentProvider(root).also { it.attach(app, authority) }
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
        workspaceKeys.forEach {
            File(app.filesDir, "workspaces/$it").deleteRecursively()
            File(app.filesDir, "workspaces/$it.json").delete()
        }
        File(app.filesDir, "portable-assets").deleteRecursively()
    }

    @Test fun observerNotificationRefreshesCleanInactiveMarkdownAndPortableTabsWithoutStealingFocus() {
        val model = newModel()
        val inactiveSmd = createSmd("Inactive.smd", "# Portable one\n", JSONObject().put("assets/diagram.svg", SVG_A))
        val inactiveMd = createDoc("Inactive.md", "# Background one\n")
        val dirtyMd = createDoc("Dirty.md", "# Clean start\n")
        val activeMd = createDoc("Active.md", "# Active one\n")

        model.open(inactiveSmd)
        await { model.state.value.tabs.any { it.uri == inactiveSmd.toString() } }
        val inactiveSmdId = model.state.value.tabs.single { it.uri == inactiveSmd.toString() }.id
        val firstPortableDir = model.state.value.tabs.single { it.id == inactiveSmdId }.assetDirectory!!
        assertTrue(portableDir(firstPortableDir).exists())

        model.open(inactiveMd)
        await { model.state.value.tabs.any { it.uri == inactiveMd.toString() } }
        val inactiveMdId = model.state.value.tabs.single { it.uri == inactiveMd.toString() }.id

        model.open(dirtyMd)
        await { model.state.value.tabs.any { it.uri == dirtyMd.toString() } }
        val dirtyId = model.state.value.tabs.single { it.uri == dirtyMd.toString() }.id
        model.edit(dirtyId, "# Unsaved local changes\n")

        model.open(activeMd)
        await { model.state.value.tabs.any { it.uri == activeMd.toString() } }
        val activeId = model.state.value.tabs.single { it.uri == activeMd.toString() }.id
        assertEquals(activeId, model.state.value.activeId)

        writeSmdFile(provider.fileFor(inactiveSmd), "# Portable two\n", JSONObject().put("assets/diagram.svg", SVG_B))
        provider.fileFor(inactiveMd).writeText("# Background two\n")
        provider.fileFor(dirtyMd).writeText("# External edit must not clobber dirty tab\n")
        app.contentResolver.notifyChange(inactiveSmd, null)
        app.contentResolver.notifyChange(inactiveMd, null)
        app.contentResolver.notifyChange(dirtyMd, null)

        await {
            model.state.value.tabs.single { it.id == inactiveSmdId }.content == "# Portable two\n" &&
                model.state.value.tabs.single { it.id == inactiveMdId }.content == "# Background two\n" &&
                dirtyId in model.state.value.conflictedTabIds &&
                !portableDir(firstPortableDir).exists()
        }
        val refreshedSmd = model.state.value.tabs.single { it.id == inactiveSmdId }
        val refreshedMd = model.state.value.tabs.single { it.id == inactiveMdId }
        assertEquals(activeId, model.state.value.activeId)
        assertEquals("# Portable two\n", refreshedSmd.saved)
        assertFalse(refreshedSmd.dirty)
        assertNotEquals(firstPortableDir, refreshedSmd.assetDirectory)
        assertFalse("Replaced portable-assets directory must be deleted", portableDir(firstPortableDir).exists())
        assertEquals(SVG_B, media.portableAssets(refreshedSmd.assetDirectory).optString("assets/diagram.svg"))
        assertEquals("# Background two\n", refreshedMd.saved)
        assertFalse(refreshedMd.dirty)
        assertEquals("# Unsaved local changes\n", model.state.value.tabs.single { it.id == dirtyId }.content)
    }

    @Test fun resumeRefreshUpdatesAssetOnlyPortableNotesWithoutLeakingDirectoriesAndPreservesClosedNoteAssets() {
        val model = newModel()
        val smdUri = createSmd("Visuals.smd", "# Stable body\n", JSONObject().put("assets/diagram.svg", SVG_A))
        val archivedSmd = createSmd("Archived.smd", "# Archived body\n", JSONObject().put("assets/diagram.svg", SVG_A))
        val activeMd = createDoc("Active.md", "# Active one\n")

        model.open(archivedSmd)
        await { model.state.value.tabs.any { it.uri == archivedSmd.toString() } }
        val archivedTab = model.state.value.tabs.single { it.uri == archivedSmd.toString() }
        val archivedDir = archivedTab.assetDirectory!!
        model.close(archivedTab.id)
        await { model.state.value.closedTabs.any { it.id == archivedTab.id } }
        assertTrue(portableDir(archivedDir).exists())

        model.open(smdUri)
        await { model.state.value.tabs.any { it.uri == smdUri.toString() } }
        val smdId = model.state.value.tabs.single { it.uri == smdUri.toString() }.id
        val firstSmdDir = model.state.value.tabs.single { it.id == smdId }.assetDirectory!!

        model.open(activeMd)
        await { model.state.value.tabs.any { it.uri == activeMd.toString() } }
        val activeId = model.state.value.tabs.single { it.uri == activeMd.toString() }.id

        // Asset-only .smd update alongside a Markdown text update on Active.md.
        provider.fileFor(activeMd).writeText("# Active two\n")
        writeSmdFile(provider.fileFor(smdUri), "# Stable body\n", JSONObject().put("assets/diagram.svg", SVG_B))
        model.refreshExternal()

        await {
            model.state.value.tabs.single { it.id == activeId }.content == "# Active two\n" &&
                model.state.value.tabs.single { it.id == smdId }.assetDirectory != firstSmdDir &&
                !portableDir(firstSmdDir).exists()
        }
        val updatedSmd = model.state.value.tabs.single { it.id == smdId }
        val secondSmdDir = updatedSmd.assetDirectory!!
        assertEquals("# Stable body\n", updatedSmd.content)
        assertEquals(SVG_B, media.portableAssets(secondSmdDir).optString("assets/diagram.svg"))
        assertTrue("Closed-note portable-assets directory must remain intact", portableDir(archivedDir).exists())

        // Re-running refreshExternal when nothing changed must not leak temporary extraction folders.
        model.refreshExternal(immediate = true)
        Thread.sleep(80)
        shadowOf(Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(250))
        val liveDirs = File(app.filesDir, "portable-assets").listFiles()?.map { it.name }?.toSet().orEmpty()
        assertEquals(setOf(archivedDir, secondSmdDir), liveDirs)
    }

    @Test fun tabSelectionRefreshesCleanTabImmediatelyAndCoalescesPendingFullWorkspaceRefresh() {
        val model = newModel()
        val backgroundSmd = createSmd("Background.smd", "# Portable v1\n", JSONObject().put("assets/diagram.svg", SVG_A))
        val targetMd = createDoc("Target.md", "# Target v1\n")
        val dirtyMd = createDoc("Dirty.md", "# Dirty baseline\n")

        model.open(backgroundSmd)
        await { model.state.value.tabs.any { it.uri == backgroundSmd.toString() } }
        val backgroundSmdId = model.state.value.tabs.single { it.uri == backgroundSmd.toString() }.id
        val firstPortableDir = model.state.value.tabs.single { it.id == backgroundSmdId }.assetDirectory!!

        model.open(targetMd)
        await { model.state.value.tabs.any { it.uri == targetMd.toString() } }
        val targetMdId = model.state.value.tabs.single { it.uri == targetMd.toString() }.id

        model.open(dirtyMd)
        await { model.state.value.tabs.any { it.uri == dirtyMd.toString() } }
        val dirtyMdId = model.state.value.tabs.single { it.uri == dirtyMd.toString() }.id
        model.edit(dirtyMdId, "# Local dirty draft\n")

        // Queue a debounced full-workspace refresh (as in onResume), then immediately switch to Target.md.
        writeSmdFile(provider.fileFor(backgroundSmd), "# Portable v2\n", JSONObject().put("assets/diagram.svg", SVG_B))
        provider.fileFor(targetMd).writeText("# Target v2\n")
        provider.fileFor(dirtyMd).writeText("# Disk edit while dirty\n")
        model.refreshExternal()
        model.select(targetMdId)

        await {
            model.state.value.activeId == targetMdId &&
                model.state.value.tabs.single { it.id == targetMdId }.content == "# Target v2\n" &&
                model.state.value.tabs.single { it.id == backgroundSmdId }.content == "# Portable v2\n" &&
                !portableDir(firstPortableDir).exists()
        }

        // Selecting a clean portable tab later also refreshes it immediately on tab switch.
        val secondPortableDir = model.state.value.tabs.single { it.id == backgroundSmdId }.assetDirectory!!
        writeSmdFile(provider.fileFor(backgroundSmd), "# Portable v3 on select\n", JSONObject().put("assets/diagram.svg", SVG_A))
        model.select(backgroundSmdId)
        await {
            model.state.value.activeId == backgroundSmdId &&
                model.state.value.tabs.single { it.id == backgroundSmdId }.content == "# Portable v3 on select\n" &&
                !portableDir(secondPortableDir).exists()
        }

        // Selecting a dirty tab must preserve its unsaved local draft while surfacing conflict state.
        model.select(dirtyMdId)
        await { model.state.value.activeId == dirtyMdId && model.state.value.activeConflicted }
        assertEquals("# Local dirty draft\n", model.state.value.tabs.single { it.id == dirtyMdId }.content)
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
        val key = "external-refresh-${System.nanoTime()}".also(workspaceKeys::add)
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

private class RefreshTestDocumentProvider(private val directory: File) : ContentProvider() {
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
