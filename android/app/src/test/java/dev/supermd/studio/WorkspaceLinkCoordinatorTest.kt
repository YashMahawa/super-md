package dev.supermd.studio

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Intent
import android.content.pm.ProviderInfo
import android.database.MatrixCursor
import android.net.Uri
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import androidx.lifecycle.ViewModelStore
import java.io.File
import java.nio.file.Files
import java.time.Duration
import kotlinx.coroutines.runBlocking
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
class WorkspaceLinkCoordinatorTest {
    private val app = RuntimeEnvironment.getApplication()
    private lateinit var root: File
    private lateinit var authority: String
    private val stores = mutableListOf<ViewModelStore>()
    private val keys = mutableListOf<String>()

    @Before fun setUp() {
        root = Files.createTempDirectory("workspace-link-coord").toFile()
        authority = "dev.supermd.test.coord.${System.nanoTime()}"
        File(root, "Index.md").writeText("# Index\n")
        File(root, "Topic.md").writeText("# Topic\n\n## Intro\nBody\n")
        File(root, "sub").mkdirs()
        File(root, "sub/Ref.md").writeText("# Ref\n\n## Details\nBody\n")
        val auth = authority
        val provider = StandaloneNoteProvider(root)
        provider.attachInfo(app, ProviderInfo().apply { authority = auth; exported = true; grantUriPermissions = true })
        ShadowContentResolver.registerProviderInternal(authority, provider)
    }

    @After fun tearDown() {
        stores.forEach { it.clear() }
        ShadowContentResolver.reset()
        root.deleteRecursively()
        app.getSharedPreferences("studio", 0).edit().clear().commit()
        keys.forEach { k ->
            File(app.filesDir, "workspaces/$k.json").delete()
            File(app.filesDir, "workspaces/$k").deleteRecursively()
            app.deleteSharedPreferences("studio-window-$k")
        }
    }

    private fun newModel(): StudioViewModel = StudioViewModel(app, "coord-${System.nanoTime()}".also(keys::add)).also {
        it.readerFlushRequester = { true }
        ViewModelStore().also(stores::add).put("m", it)
    }

    private fun waitUntil(check: () -> Boolean) {
        val looper = shadowOf(Looper.getMainLooper())
        repeat(200) {
            looper.idleFor(Duration.ofMillis(25))
            if (check()) return
            Thread.sleep(10)
        }
        assertTrue(check())
    }

    @Test fun resolvesWikilinkAndRelativeMarkdownLinksWithPendingHeadingAndAutosaveHandoff() {
        val model = newModel()
        model.reading(autosave = true)
        val indexUri = Uri.fromFile(File(root, "Index.md"))
        model.openDocument(indexUri)
        waitUntil { model.state.value.active.uri == indexUri.toString() }
        model.edit(model.state.value.active.id, "# Updated Index\n")

        val wikiRes = runBlocking { model.openWorkspaceLink(indexUri.toString(), "Topic", "Intro", wikilink = true) }
        assertTrue(wikiRes.getBoolean("opened"))
        assertEquals("Intro", model.state.value.pendingHeading?.heading)
        assertEquals(model.state.value.active.id, model.state.value.pendingHeading?.noteId)
        waitUntil { File(root, "Index.md").readText() == "# Updated Index\n" }

        val relRes = runBlocking { model.openRelativeNote(model.state.value.active.uri!!, "sub/Ref.md", "Details") }
        assertTrue(relRes.getBoolean("opened"))
        assertEquals(Uri.fromFile(File(root, "sub/Ref.md")).toString(), model.state.value.active.uri)
        assertEquals("Details", model.state.value.pendingHeading?.heading)
    }

    @Test fun rejectsUnsavedDraftMissingTargetAndFolderTraversalWithExpectedMessages() {
        val model = newModel()
        val unsaved = runBlocking { model.openWorkspaceLink(model.state.value.active.id, "Topic.md", "", wikilink = false) }
        assertFalse(unsaved.getBoolean("opened"))
        assertEquals("Save this note before opening linked notes.", unsaved.getString("message"))

        val indexUri = Uri.fromFile(File(root, "Index.md"))
        model.openDocument(indexUri)
        waitUntil { model.state.value.active.uri == indexUri.toString() }

        val missing = runBlocking { model.openWorkspaceLink(indexUri.toString(), "Missing.md", "", wikilink = false) }
        assertFalse(missing.getBoolean("opened"))
        assertEquals("Linked note not found: Missing.md", missing.getString("message"))

        val traversal = runBlocking { model.openWorkspaceLink(indexUri.toString(), "../Escape.md", "", wikilink = false) }
        assertFalse(traversal.getBoolean("opened"))
        assertEquals("Linked note is outside the authorized folder.", traversal.getString("message"))
    }

    @Test fun standaloneNotePopulatesOrSuppressesFolderAccessPromptByFlag() {
        val model = newModel()
        val standaloneUri = DocumentsContract.buildDocumentUri(authority, "vault/Index.md")
        app.grantUriPermission(app.packageName, standaloneUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        model.open(standaloneUri)
        waitUntil { model.state.value.active.uri == standaloneUri.toString() }

        val prompted = runBlocking {
            model.openWorkspaceLink(standaloneUri.toString(), "Nested Note", "Sec", wikilink = true, allowFolderPrompt = true)
        }
        assertFalse(prompted.getBoolean("opened"))
        assertTrue(prompted.getBoolean("promptedFolderAccess"))
        assertNotNull(model.state.value.folderAccessPrompt)

        val suppressed = runBlocking {
            model.openWorkspaceLink(standaloneUri.toString(), "Nested Note", "Sec", wikilink = true, allowFolderPrompt = false)
        }
        assertFalse(suppressed.getBoolean("opened"))
        assertFalse(suppressed.getBoolean("promptedFolderAccess"))
        assertNull(model.state.value.folderAccessPrompt)
    }
}

private class StandaloneNoteProvider(private val root: File) : ContentProvider() {
    override fun onCreate() = true
    private fun resolve(uri: Uri) = File(root, DocumentsContract.getDocumentId(uri).removePrefix("vault/"))
    override fun query(uri: Uri, p: Array<out String>?, s: String?, a: Array<out String>?, o: String?) =
        MatrixCursor(arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)).apply {
            val f = resolve(uri); if (f.isFile) addRow(arrayOf<Any>(f.name, f.length()))
        }
    override fun getType(uri: Uri) = "text/markdown"
    override fun insert(uri: Uri, v: ContentValues?): Uri? = null
    override fun delete(uri: Uri, s: String?, a: Array<out String>?) = 0
    override fun update(uri: Uri, v: ContentValues?, s: String?, a: Array<out String>?) = 0
    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor =
        ParcelFileDescriptor.open(resolve(uri), ParcelFileDescriptor.MODE_READ_ONLY)
}
