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
import java.time.Duration
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
    private lateinit var provider: TreeDocumentsProvider
    private lateinit var authority: String
    private val workspaceKeys = mutableListOf<String>()
    private val viewModels = mutableListOf<ViewModelStore>()

    @Before
    fun setUp() {
        app = RuntimeEnvironment.getApplication()
        root = Files.createTempDirectory("workspace-folder-test").toFile()
        authority = "dev.supermd.test.workspace.${System.nanoTime()}"
        provider = TreeDocumentsProvider(root).also { it.attach(app, authority) }
        ShadowContentResolver.registerProviderInternal(authority, provider)
    }

    @After
    fun tearDown() {
        viewModels.forEach { it.clear() }
        ShadowContentResolver.reset()
        root.deleteRecursively()
        workspaceKeys.forEach { key ->
            File(app.filesDir, "workspaces/$key.json").delete()
            File(app.filesDir, "workspaces/$key").deleteRecursively()
            app.deleteSharedPreferences("studio-window-$key")
        }
    }

    @Test
    fun folderNoteFilterIncludesTxtAndRequiresDotDelimiter() {
        assertTrue(isSearchableNoteName("notes.md"))
        assertTrue(isSearchableNoteName("bundle.smd"))
        assertTrue(isSearchableNoteName("legacy.fmd"))
        assertTrue(isSearchableNoteName("chapter.markdown"))
        assertTrue(isSearchableNoteName("quarto-paper.qmd"))
        assertTrue(isSearchableNoteName("QUARTO-PAPER.QMD"))
        assertTrue(isSearchableNoteName("Mixed.qMd"))
        assertTrue(isSearchableNoteName("ClinicalAnalysis.Rmd"))
        assertTrue(isSearchableNoteName("clinical.rmd"))
        assertTrue(isSearchableNoteName("CLINICAL.RMD"))
        assertTrue(isSearchableNoteName("Mixed.rMd"))
        assertTrue(isSearchableNoteName("1.2 Linear Algebra.txt"))
        assertTrue(isSearchableNoteName("UPPER.TXT"))

        // Dotless filenames that match extension tokens must NOT be treated as supported extensions.
        assertFalse(isSearchableNoteName("md"))
        assertFalse(isSearchableNoteName("qmd"))
        assertFalse(isSearchableNoteName("rmd"))
        assertFalse(isSearchableNoteName("Rmd"))
        assertFalse(isSearchableNoteName("txt"))
        assertFalse(isSearchableNoteName("smd"))
        assertFalse(isSearchableNoteName("README"))
        assertFalse(isSearchableNoteName(".hidden.md"))
        assertFalse(isSearchableNoteName(".hidden.qmd"))
        assertFalse(isSearchableNoteName(".hidden.Rmd"))
        assertFalse(isSearchableNoteName(".txt"))

        assertEquals("Rmd", noteExtension("ClinicalAnalysis.Rmd"))
        assertEquals("QMD", noteExtension("QUARTO-PAPER.QMD"))
        assertEquals("ClinicalAnalysis", noteStem("ClinicalAnalysis.Rmd"))
        assertEquals("QUARTO-PAPER", noteStem("QUARTO-PAPER.QMD"))
        assertEquals("Analysis.Rmd", validateFolderEntryName("Analysis", isDirectory = false, currentExtension = ".Rmd"))
        assertEquals("Analysis.Rmd", validateFolderEntryName("Analysis.Rmd", isDirectory = false, currentExtension = ".Rmd"))
        assertEquals("Analysis.qmd", validateFolderEntryName("Analysis", isDirectory = false, currentExtension = ".qmd"))
    }

    @Test
    fun qmdAndRmdOpenFolderListSearchAndOrdinarySavePreserveFilenameAndSource() {
        assertTrue(OPEN_NOTE_MIME_TYPES.contains("text/*"))
        assertTrue(OPEN_NOTE_MIME_TYPES.contains("application/octet-stream"))
        assertTrue(OPEN_NOTE_MIME_TYPES.contains("application/x-quarto"))
        assertTrue(OPEN_NOTE_MIME_TYPES.contains("application/x-rmarkdown"))

        val qmdSource = "---\ntitle: \"Quarto Trial\"\n---\n\n```{python}\n#| label: fig-1\nx = [1, 2, 3]\n```\n"
        val rmdSource = "---\ntitle: \"Clinical Rmd\"\n---\n\n```{r setup, include=FALSE}\nknitr::opts_chunk\$set(echo = TRUE)\n```\n"

        File(root, "biostats").mkdirs()
        val qmdFile = File(root, "quarto-study.qmd").apply { writeText(qmdSource) }
        val rmdFile = File(root, "ClinicalAnalysis.Rmd").apply { writeText(rmdSource) }
        File(root, "UPPER_REPORT.QMD").writeText("# Upper QMD\n")
        File(root, "biostats/SurvivalModel.RMD").writeText("# Survival RMD\n\nBiomarkerToken in RMD.\n")
        File(root, "biostats/mixed.qMd").writeText("# Mixed qMd\n\nBiomarkerToken in qMd.\n")
        File(root, "qmd").writeText("Dotless qmd")
        File(root, "rmd").writeText("Dotless rmd")
        File(root, ".hidden.Rmd").writeText("Hidden Rmd")

        val treeUri = DocumentsContract.buildTreeDocumentUri(authority, "root")
        app.grantUriPermission(
            app.packageName,
            treeUri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION,
        )

        val key = "qmd-rmd-workflow-${System.nanoTime()}".also(workspaceKeys::add)
        val model = newModel(key)
        model.setFolder(treeUri)
        await {
            model.state.value.files.map { it.name } ==
                listOf("biostats", "ClinicalAnalysis.Rmd", "quarto-study.qmd", "UPPER_REPORT.QMD")
        }

        // Cross-note search finds content inside .RMD and .qMd in subfolders too.
        model.openFolderSearch()
        model.updateFolderSearch("BiomarkerToken", caseSensitive = false, includeDiagrams = false)
        await {
            !model.folderSearch.value.scanning &&
                model.folderSearch.value.matches.map { it.name }.sorted() == listOf("SurvivalModel.RMD", "mixed.qMd")
        }
        model.closeFolderSearch()

        // Open .qmd, edit, and ordinary in-place save preserves exact filename and raw source.
        val qmdEntry = model.state.value.files.first { it.name == "quarto-study.qmd" }
        model.open(Uri.parse(qmdEntry.uri), qmdEntry.relative)
        await { model.state.value.active.name == "quarto-study.qmd" && !model.state.value.busy }
        assertFalse(model.state.value.active.portable)
        assertEquals(qmdSource, model.state.value.active.content)

        val qmdId = model.state.value.active.id
        val qmdEdited = "$qmdSource\nAdded Quarto discussion paragraph.\n"
        model.edit(qmdId, qmdEdited)
        var qmdSaveErr: String? = "pending"
        model.save(noteId = qmdId) { qmdSaveErr = it }
        await { qmdSaveErr != "pending" && !model.state.value.busy }
        assertEquals(null, qmdSaveErr)
        assertEquals("quarto-study.qmd", model.state.value.active.name)
        assertEquals(qmdEdited, qmdFile.readText())
        assertFalse(File(root, "quarto-study.md").exists())

        // Open .Rmd, including when single-URI display name is omitted (simulated via file:// URI),
        // edit, and ordinary in-place save preserves capital-R ClinicalAnalysis.Rmd!
        val rmdEntry = model.state.value.files.first { it.name == "ClinicalAnalysis.Rmd" }
        model.open(Uri.parse(rmdEntry.uri), rmdEntry.relative)
        await { model.state.value.active.name == "ClinicalAnalysis.Rmd" && !model.state.value.busy }
        assertFalse(model.state.value.active.portable)
        assertEquals(rmdSource, model.state.value.active.content)

        val rmdId = model.state.value.active.id
        val rmdEdited = "$rmdSource\nPrimary endpoint preserved.\n"
        model.edit(rmdId, rmdEdited)
        var rmdSaveErr: String? = "pending"
        model.save(noteId = rmdId) { rmdSaveErr = it }
        await { rmdSaveErr != "pending" && !model.state.value.busy }
        assertEquals(null, rmdSaveErr)
        assertEquals("ClinicalAnalysis.Rmd", model.state.value.active.name)
        assertEquals(rmdEdited, rmdFile.readText())
        assertFalse(File(root, "ClinicalAnalysis.md").exists())

        // Also verify file:// URI (where DocumentFile.fromSingleUri returns null display name)
        // keeps ClinicalAnalysis.Rmd on ordinary in-place save instead of rewriting Note.name to .md.
        val directRmdFile = File(root, "DirectFileUri.Rmd").apply { writeText(rmdSource) }
        model.open(Uri.fromFile(directRmdFile))
        await { model.state.value.active.name == "DirectFileUri.Rmd" && !model.state.value.busy }
        val directId = model.state.value.active.id
        val directEdited = "$rmdSource\nSaved through file URI.\n"
        model.edit(directId, directEdited)
        var directSaveErr: String? = "pending"
        model.save(noteId = directId) { directSaveErr = it }
        await { directSaveErr != "pending" && !model.state.value.busy }
        assertEquals(null, directSaveErr)
        assertEquals("DirectFileUri.Rmd", model.state.value.active.name)
        assertEquals(directEdited, directRmdFile.readText())
        assertFalse(File(root, "DirectFileUri.md").exists())
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

        // If a nested subfolder disappears externally, refreshMetadata falls back to the nearest surviving ancestor.
        File(root, "courses/algebra").deleteRecursively()
        recreated.refreshMetadata()
        await {
            recreated.state.value.folderRelative == "courses" &&
                recreated.state.value.files.map { it.name } == listOf("Overview.md")
        }

        // Step up one level at a time: courses -> "" -> false at root.
        assertTrue(recreated.navigateFolderUp())
        await {
            recreated.state.value.folderRelative == "" &&
                recreated.state.value.files.map { it.name } == listOf("courses", "RootNote.md")
        }

        assertFalse(recreated.navigateFolderUp())
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
            mainLooper.idleFor(Duration.ofMillis(50))
            if (condition()) return
            Thread.sleep(10)
        }
        mainLooper.idleFor(Duration.ofMillis(50))
        assertTrue("Condition was not met within ${timeoutMs}ms", condition())
    }
}

private class TreeDocumentsProvider(private val rootDir: File) : ContentProvider() {
    fun attach(context: Context, authority: String) {
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
        val flags = DocumentsContract.Document.FLAG_SUPPORTS_WRITE
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
