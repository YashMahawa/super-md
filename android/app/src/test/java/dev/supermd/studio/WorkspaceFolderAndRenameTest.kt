package dev.supermd.studio

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.ProviderInfo
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.Bundle
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import androidx.lifecycle.ViewModelStore
import java.io.File
import java.io.FileNotFoundException
import java.nio.file.Files
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
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowContentResolver

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class WorkspaceFolderAndRenameTest {
    private lateinit var app: android.app.Application
    private lateinit var root: File
    private lateinit var provider: TreeAndRenameDocumentsProvider
    private lateinit var authority: String
    private var previousRecent: String? = null
    private var previousPositions: String? = null
    private val workspaceKeys = mutableListOf<String>()
    private val viewModels = mutableListOf<ViewModelStore>()

    @Before
    fun setUp() {
        app = RuntimeEnvironment.getApplication()
        root = Files.createTempDirectory("workspace-folder-rename-test").toFile()
        authority = "dev.supermd.test.workspace.${System.nanoTime()}"
        provider = TreeAndRenameDocumentsProvider(root).also { it.attach(app, authority) }
        ShadowContentResolver.registerProviderInternal(authority, provider)
        val prefs = app.getSharedPreferences("studio", Context.MODE_PRIVATE)
        previousRecent = prefs.getString("recent", null)
        previousPositions = prefs.getString("readingPositions", null)
        prefs.edit().remove("recent").remove("readingPositions").commit()
    }

    @After
    fun tearDown() {
        viewModels.forEach { it.clear() }
        app.getSharedPreferences("studio", Context.MODE_PRIVATE).edit().apply {
            if (previousRecent == null) remove("recent") else putString("recent", previousRecent)
            if (previousPositions == null) remove("readingPositions") else putString("readingPositions", previousPositions)
        }.commit()
        ShadowContentResolver.reset()
        root.deleteRecursively()
        workspaceKeys.forEach { key ->
            File(app.filesDir, "workspaces/$key.json").delete()
            File(app.filesDir, "workspaces/$key").deleteRecursively()
            app.deleteSharedPreferences("studio-window-$key")
        }
    }

    @Test
    fun dottedTitlesPreserveMdSmdTxtAndExtensionlessFormats() {
        assertEquals(
            NoteRenameResult.Valid("1.2 Linear Algebra.md"),
            resolveNoteRename("1.2 Linear Algebra", "Lecture.md", portable = false, hasSavedTarget = true),
        )
        assertEquals(
            NoteRenameResult.Valid("1.2 Linear Algebra.smd"),
            resolveNoteRename("1.2 Linear Algebra", "Lecture.smd", portable = true, hasSavedTarget = true),
        )
        assertEquals(
            NoteRenameResult.Valid("1.2 Linear Algebra.fmd"),
            resolveNoteRename("1.2 Linear Algebra", "Legacy.fmd", portable = true, hasSavedTarget = true),
        )
        assertEquals(
            NoteRenameResult.Valid("1.2 Linear Algebra.txt"),
            resolveNoteRename("1.2 Linear Algebra", "Scratch.txt", portable = false, hasSavedTarget = true),
        )
        assertEquals(
            NoteRenameResult.Valid("1.2 Linear Algebra"),
            resolveNoteRename("1.2 Linear Algebra", "README", portable = false, hasSavedTarget = true),
        )
        assertEquals(
            NoteRenameResult.Valid("1.2 Linear Algebra.md"),
            resolveNoteRename("1.2 Linear Algebra.md", "Lecture.md", portable = false, hasSavedTarget = true),
        )
        assertEquals(
            NoteRenameResult.Valid("lecture.MD"),
            resolveNoteRename("lecture.MD", "Lecture.md", portable = false, hasSavedTarget = true),
        )
        assertTrue(
            resolveNoteRename("1.2 Linear Algebra.smd", "Lecture.md", portable = false, hasSavedTarget = true) is NoteRenameResult.Invalid,
        )
        assertTrue(
            resolveNoteRename("1.2 Linear Algebra.pdf", "Lecture.md", portable = false, hasSavedTarget = true) is NoteRenameResult.Invalid,
        )
        assertTrue(
            resolveNoteRename("1.2 Linear Algebra.md", "README", portable = false, hasSavedTarget = true) is NoteRenameResult.Invalid,
        )
    }

    @Test
    fun blocksEmptyStemsLeadingDotsAndIllegalCharacters() {
        val rejected = listOf(
            "",
            "   ",
            ".",
            "..",
            ".md",
            "   .md",
            ".hidden",
            ".hidden.md",
            "folder/note",
            "folder\\note",
            "bad:name",
            "bad*name",
            "bad?name",
            "bad\"name",
            "bad<name>",
            "bad|name",
            "bad\u0000name",
            "trailing.",
        )
        for (candidate in rejected) {
            val result = resolveNoteRename(candidate, if (candidate == "trailing.") "README" else "Note.md", portable = false, hasSavedTarget = true)
            assertTrue("Expected '$candidate' to be rejected, got $result", result is NoteRenameResult.Invalid)
        }
    }

    @Test
    fun folderNoteFilterIncludesTxtAndRequiresDotDelimiter() {
        assertTrue(isSupportedFolderNoteFile("notes.md"))
        assertTrue(isSupportedFolderNoteFile("bundle.smd"))
        assertTrue(isSupportedFolderNoteFile("legacy.fmd"))
        assertTrue(isSupportedFolderNoteFile("chapter.markdown"))
        assertTrue(isSupportedFolderNoteFile("1.2 Linear Algebra.txt"))
        assertTrue(isSupportedFolderNoteFile("UPPER.TXT"))

        // Dotless filenames that match extension tokens must NOT be treated as supported extensions.
        assertFalse(isSupportedFolderNoteFile("md"))
        assertFalse(isSupportedFolderNoteFile("txt"))
        assertFalse(isSupportedFolderNoteFile("smd"))
        assertFalse(isSupportedFolderNoteFile("README"))
        assertFalse(isSupportedFolderNoteFile(".hidden.md"))
        assertFalse(isSupportedFolderNoteFile(".txt"))
    }

    @Test
    fun parentFolderRelativeStepsUpOneDirectoryAtATime() {
        assertEquals("courses/math", parentFolderRelative("courses/math/algebra"))
        assertEquals("courses", parentFolderRelative("courses/math"))
        assertEquals("", parentFolderRelative("courses"))
        assertEquals("", parentFolderRelative(""))
    }

    @Test
    fun subfolderNavigationPersistsAcrossViewModelRecreationListsTxtAndStepsUpOneLevelAtATime() {
        File(root, "courses/algebra").mkdirs()
        File(root, "courses/algebra/1.2 Basis.txt").writeText("Basis notes")
        File(root, "courses/algebra/Syllabus.md").writeText("# Syllabus")
        File(root, "courses/algebra/txt").writeText("Dotless file named txt")
        File(root, "courses/algebra/.hidden.md").writeText("Hidden file")
        File(root, "courses/Overview.md").writeText("# Courses")
        File(root, "RootNote.md").writeText("# Root")

        val treeUri = DocumentsContract.buildTreeDocumentUri(authority, "root")
        app.grantUriPermission(
            app.packageName,
            treeUri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION,
        )

        val key = "subfolder-persist-${System.nanoTime()}".also(workspaceKeys::add)
        val model = newModel(key)
        model.setFolder(treeUri)
        await { model.state.value.files.map { it.name } == listOf("courses", "RootNote.md") }

        val coursesEntry = model.state.value.files.first { it.name == "courses" }
        model.listFolder(Uri.parse(coursesEntry.uri), coursesEntry.relative)
        await { model.state.value.folderRelative == "courses" && model.state.value.files.map { it.name } == listOf("algebra", "Overview.md") }

        val algebraEntry = model.state.value.files.first { it.name == "algebra" }
        model.listFolder(Uri.parse(algebraEntry.uri), algebraEntry.relative)
        await {
            model.state.value.folderRelative == "courses/algebra" &&
                model.state.value.files.map { it.name } == listOf("1.2 Basis.txt", "Syllabus.md")
        }

        // Simulate configuration change / UI reset by instantiating a new ViewModel for the same workspace.
        val recreated = newModel(key)
        assertEquals("courses/algebra", recreated.state.value.folderRelative)
        await { recreated.state.value.files.map { it.name } == listOf("1.2 Basis.txt", "Syllabus.md") }

        // Step up one level at a time: courses/algebra -> courses -> "" -> false at root.
        assertTrue(recreated.navigateFolderUp())
        await {
            recreated.state.value.folderRelative == "courses" &&
                recreated.state.value.files.map { it.name } == listOf("algebra", "Overview.md")
        }

        assertTrue(recreated.navigateFolderUp())
        await {
            recreated.state.value.folderRelative == "" &&
                recreated.state.value.files.map { it.name } == listOf("courses", "RootNote.md")
        }

        assertFalse(recreated.navigateFolderUp())
    }

    @Test
    fun renamingDottedNoteUpdatesPinnedRecentPositionsPermissionsAndFolderListAndKeepsInvalidDialogInput() {
        File(root, "courses").mkdirs()
        val initialFile = File(root, "courses/Lecture.md").apply { writeText("# Vectors\n") }

        val treeUri = DocumentsContract.buildTreeDocumentUri(authority, "root")
        val noteUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, "root/courses/Lecture.md")
        app.grantUriPermission(
            app.packageName,
            treeUri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION,
        )
        app.grantUriPermission(
            app.packageName,
            noteUri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION,
        )

        val key = "rename-sync-${System.nanoTime()}".also(workspaceKeys::add)
        val model = newModel(key)
        model.setFolder(treeUri)
        await { model.state.value.files.any { it.name == "courses" } }
        model.listFolder(treeUri, "courses")
        await { model.state.value.files.map { it.name } == listOf("Lecture.md") }

        model.open(noteUri, "courses/Lecture.md")
        await { model.state.value.tabs.any { it.uri == noteUri.toString() } }
        val noteId = model.state.value.tabs.single { it.uri == noteUri.toString() }.id

        // Pin the note in recent history and record a reading position.
        model.pinRecent(noteUri.toString())
        assertTrue(model.recent.value.single { it.uri == noteUri.toString() }.pinned)
        model.readingPosition(noteId, JSONObject().put("top", 240.0).put("offset", 8.0).put("zoom", 115.0).put("mode", "live"))
        assertNotNull(model.readingLocation(noteUri.toString()))

        // Invalid rename via dialog contract: returns failure + error message without setting global error or mutating note name.
        var invalidResult: Pair<Boolean, String?>? = null
        model.rename(noteId, ".hidden", showGlobalError = false) { ok, err -> invalidResult = ok to err }
        await { invalidResult != null }
        assertEquals(false, invalidResult!!.first)
        assertNotNull(invalidResult!!.second)
        assertNull(model.state.value.error)
        assertEquals("Lecture.md", model.state.value.tabs.single { it.id == noteId }.name)

        // Valid dotted rename: appends .md, handles new SAF documentId, preserves pin & reading position, updates folder listing.
        var validResult: Pair<Boolean, String?>? = null
        model.rename(noteId, "1.2 Linear Algebra", showGlobalError = false) { ok, err -> validResult = ok to err }
        await { validResult != null }
        assertEquals(true to null, validResult)

        val renamedTab = model.state.value.tabs.single { it.id == noteId }
        assertEquals("1.2 Linear Algebra.md", renamedTab.name)
        assertEquals("courses/1.2 Linear Algebra.md", renamedTab.relative)
        assertNotNull(renamedTab.uri)
        assertNotEquals(noteUri.toString(), renamedTab.uri)
        assertFalse(initialFile.exists())
        assertTrue(File(root, "courses/1.2 Linear Algebra.md").isFile)

        // Pinned recent entry migrated to new URI without leaving stale old URI.
        assertEquals(1, model.recent.value.size)
        val recentEntry = model.recent.value.single()
        assertEquals(renamedTab.uri, recentEntry.uri)
        assertEquals("1.2 Linear Algebra.md", recentEntry.name)
        assertEquals("courses/1.2 Linear Algebra.md", recentEntry.relative)
        assertTrue(recentEntry.pinned)

        // Reading position migrated to new URI.
        assertNull(model.readingLocation(noteUri.toString()))
        assertEquals(240.0, model.readingLocation(renamedTab.uri)?.optDouble("top"))

        // Active subfolder listing refreshed to show renamed file.
        await { model.state.value.files.map { it.name } == listOf("1.2 Linear Algebra.md") }
    }

    private fun newModel(key: String): StudioViewModel {
        val store = ViewModelStore().also(viewModels::add)
        val model = StudioViewModel(app, key)
        model.readerFlushRequester = { true }
        store.put("model-${System.nanoTime()}", model)
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

private class TreeAndRenameDocumentsProvider(private val rootDir: File) : ContentProvider() {
    private lateinit var providerAuthority: String

    fun attach(context: Context, authority: String) {
        providerAuthority = authority
        val info = ProviderInfo().apply {
            this.authority = authority
            exported = true
            grantUriPermissions = true
        }
        attachInfo(context, info)
    }

    override fun onCreate(): Boolean = true

    private fun fileForDocId(documentId: String): File {
        val relative = documentId.removePrefix("root").trimStart('/')
        return if (relative.isEmpty()) rootDir else File(rootDir, relative)
    }

    private fun docIdForFile(file: File): String {
        val rel = file.relativeTo(rootDir).invariantSeparatorsPath
        return if (rel.isEmpty()) "root" else "root/$rel"
    }

    private fun defaultColumns() = arrayOf(
        DocumentsContract.Document.COLUMN_DOCUMENT_ID,
        DocumentsContract.Document.COLUMN_DISPLAY_NAME,
        DocumentsContract.Document.COLUMN_MIME_TYPE,
        DocumentsContract.Document.COLUMN_SIZE,
        DocumentsContract.Document.COLUMN_LAST_MODIFIED,
        DocumentsContract.Document.COLUMN_FLAGS,
    )

    private fun includeRow(cursor: MatrixCursor, file: File) {
        val docId = docIdForFile(file)
        val mime = if (file.isDirectory) DocumentsContract.Document.MIME_TYPE_DIR else "text/markdown"
        val flags = DocumentsContract.Document.FLAG_SUPPORTS_RENAME or DocumentsContract.Document.FLAG_SUPPORTS_WRITE
        val cols = cursor.columnNames
        cursor.addRow(cols.map { col ->
            when (col) {
                DocumentsContract.Document.COLUMN_DOCUMENT_ID -> docId
                DocumentsContract.Document.COLUMN_DISPLAY_NAME -> if (docId == "root") rootDir.name else file.name
                DocumentsContract.Document.COLUMN_MIME_TYPE -> mime
                DocumentsContract.Document.COLUMN_SIZE -> if (file.isFile) file.length() else 0L
                DocumentsContract.Document.COLUMN_LAST_MODIFIED -> file.lastModified()
                DocumentsContract.Document.COLUMN_FLAGS, "flags" -> flags
                else -> null
            }
        }.toTypedArray<Any?>())
    }

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor {
        val cols = projection ?: defaultColumns()
        val segments = uri.pathSegments
        if (segments.lastOrNull() == "children") {
            val docIdx = segments.indexOf("document")
            val parentDocId = if (docIdx >= 0 && docIdx + 1 < segments.size) {
                segments[docIdx + 1]
            } else {
                DocumentsContract.getTreeDocumentId(uri)
            }
            val dir = fileForDocId(parentDocId)
            return MatrixCursor(cols).also { cursor ->
                dir.listFiles()?.forEach { child -> includeRow(cursor, child) }
            }
        }
        val docId = runCatching { DocumentsContract.getDocumentId(uri) }
            .getOrElse { DocumentsContract.getTreeDocumentId(uri) }
        val file = fileForDocId(docId)
        if (!file.exists()) throw FileNotFoundException(docId)
        return MatrixCursor(cols).also { includeRow(it, file) }
    }

    override fun call(method: String, arg: String?, extras: Bundle?): Bundle? {
        if (method == "android:isChildDocument") {
            return Bundle().apply { putBoolean("result", true) }
        }
        if (method == "android:renameDocument") {
            @Suppress("DEPRECATION")
            val sourceUri = extras?.getParcelable<Uri>("uri") ?: throw FileNotFoundException("Missing source uri")
            val displayName = extras.getString(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
                ?: throw IllegalArgumentException("Missing display name")
            val docId = DocumentsContract.getDocumentId(sourceUri)
            val source = fileForDocId(docId)
            if (!source.exists()) throw FileNotFoundException(docId)
            val target = File(source.parentFile, displayName)
            if (target.exists() && target != source) throw IllegalStateException("Target already exists: $target")
            if (!source.renameTo(target)) throw IllegalStateException("Could not rename $source to $target")
            val newDocId = docIdForFile(target)
            val newUri = if (DocumentsContract.isTreeUri(sourceUri)) {
                val treeUri = DocumentsContract.buildTreeDocumentUri(providerAuthority, DocumentsContract.getTreeDocumentId(sourceUri))
                DocumentsContract.buildDocumentUriUsingTree(treeUri, newDocId)
            } else {
                DocumentsContract.buildDocumentUri(providerAuthority, newDocId)
            }
            context?.let { ctx ->
                ctx.grantUriPermission(
                    ctx.packageName,
                    newUri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION,
                )
            }
            return Bundle().apply { putParcelable("uri", newUri) }
        }
        return super.call(method, arg, extras)
    }

    override fun getType(uri: Uri): String {
        val docId = runCatching { DocumentsContract.getDocumentId(uri) }
            .getOrElse { DocumentsContract.getTreeDocumentId(uri) }
        val file = fileForDocId(docId)
        return if (file.isDirectory) DocumentsContract.Document.MIME_TYPE_DIR else "text/markdown"
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        val docId = DocumentsContract.getDocumentId(uri)
        val file = fileForDocId(docId)
        if (!file.exists()) throw FileNotFoundException(docId)
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.parseMode(mode))
    }
}
