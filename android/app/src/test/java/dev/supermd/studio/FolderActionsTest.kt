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
import android.provider.DocumentsContract.Document
import android.provider.OpenableColumns
import androidx.lifecycle.ViewModelStore
import java.io.File
import java.io.FileNotFoundException
import java.nio.file.Files
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
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
class FolderActionsTest {
    private lateinit var app: android.app.Application
    private lateinit var rootDir: File
    private lateinit var provider: TreeTestDocumentsProvider
    private lateinit var authority: String
    private lateinit var treeUri: Uri
    private var previousAutosave: Boolean? = null
    private var previousRecent: String? = null
    private var previousNoteLocation: String? = null
    private var previousPositions: String? = null
    private val workspaceKeys = mutableListOf<String>()
    private val viewModels = mutableListOf<ViewModelStore>()

    @Before
    fun setUp() {
        app = RuntimeEnvironment.getApplication()
        rootDir = Files.createTempDirectory("android-folder-actions-test").toFile()
        authority = "dev.supermd.test.tree.${System.nanoTime()}"
        provider = TreeTestDocumentsProvider(rootDir).also { it.attach(app, authority) }
        ShadowContentResolver.registerProviderInternal(authority, provider)
        treeUri = DocumentsContract.buildTreeDocumentUri(authority, "root")
        app.grantUriPermission(
            app.packageName,
            treeUri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION or
                Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or
                Intent.FLAG_GRANT_PREFIX_URI_PERMISSION,
        )

        val prefs = app.getSharedPreferences("studio", Context.MODE_PRIVATE)
        previousAutosave = prefs.getBoolean("autosave", true)
        previousRecent = prefs.getString("recent", null)
        previousNoteLocation = prefs.getString("newNoteLocation", null)
        previousPositions = prefs.getString("readingPositions", null)
        prefs.edit()
            .putBoolean("autosave", false)
            .remove("recent")
            .remove("newNoteLocation")
            .remove("readingPositions")
            .commit()
    }

    @After
    fun tearDown() {
        viewModels.forEach { it.clear() }
        app.getSharedPreferences("studio", Context.MODE_PRIVATE).edit().apply {
            putBoolean("autosave", previousAutosave ?: true)
            if (previousRecent == null) remove("recent") else putString("recent", previousRecent)
            if (previousNoteLocation == null) remove("newNoteLocation") else putString("newNoteLocation", previousNoteLocation)
            if (previousPositions == null) remove("readingPositions") else putString("readingPositions", previousPositions)
        }.commit()
        ShadowContentResolver.reset()
        rootDir.deleteRecursively()
        workspaceKeys.forEach { key ->
            File(app.filesDir, "workspaces/$key.json").delete()
            File(app.filesDir, "workspaces/$key").deleteRecursively()
            File(app.filesDir, "deleted-drafts/$key").deleteRecursively()
        }
    }

    @Test
    fun untitledSaveDestinationDefaultsToOpenFolderWhenNoteLocationIsEmptyAndHonorsExplicitLocation() {
        val model = newModel()
        val markdownPicker = NoteDestination("text/markdown", model::untitledSaveLocation)

        // 1. Neither newNoteLocation nor open folder -> Downloads initial URI
        val defaultIntent = markdownPicker.createIntent(app, "Draft")
        val initialDownloads = defaultIntent.getParcelableExtra(DocumentsContract.EXTRA_INITIAL_URI, Uri::class.java)
        assertNotNull(initialDownloads)
        assertTrue(initialDownloads.toString().contains("Download"))

        // 2. Open folder set, newNoteLocation empty -> defaults to open folder tree
        model.setFolder(treeUri)
        await { model.state.value.folder == treeUri.toString() }
        assertEquals("", model.noteLocation())
        assertEquals(treeUri.toString(), model.untitledSaveLocation())
        val openFolderIntent = markdownPicker.createIntent(app, "Draft")
        val initialOpenFolder = openFolderIntent.getParcelableExtra(DocumentsContract.EXTRA_INITIAL_URI, Uri::class.java)
        assertEquals(
            DocumentsContract.buildDocumentUriUsingTree(treeUri, "root"),
            initialOpenFolder,
        )

        // 3. Explicit newNoteLocation set -> honors newNoteLocation over open folder
        val customTree = DocumentsContract.buildTreeDocumentUri(authority, "root/CustomOut")
        File(rootDir, "CustomOut").mkdirs()
        app.grantUriPermission(
            app.packageName,
            customTree,
            Intent.FLAG_GRANT_READ_URI_PERMISSION or
                Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or
                Intent.FLAG_GRANT_PREFIX_URI_PERMISSION,
        )
        model.noteLocation(customTree)
        assertEquals(customTree.toString(), model.untitledSaveLocation())
        val explicitIntent = markdownPicker.createIntent(app, "Draft")
        val initialExplicit = explicitIntent.getParcelableExtra(DocumentsContract.EXTRA_INITIAL_URI, Uri::class.java)
        assertEquals(
            DocumentsContract.buildDocumentUriUsingTree(customTree, "root/CustomOut"),
            initialExplicit,
        )

        // 4. Clearing newNoteLocation restores open folder fallback
        model.clearNoteLocation()
        assertEquals(treeUri.toString(), model.untitledSaveLocation())
    }

    @Test
    fun createMarkdownPortableAndSubfolderAutoOpensActiveTabAndExpandsParentFolder() {
        val model = newModel()
        model.setFolder(treeUri)
        await { model.state.value.folder == treeUri.toString() }

        // Create subfolder at root
        model.createSubfolder("", "Physics")
        await { model.state.value.files.any { it.name == "Physics" && it.directory } }
        assertTrue(File(rootDir, "Physics").isDirectory)

        // Create Markdown note inside subfolder -> opens active tab and expands parent folder in visible directory view
        model.createFolderNote("Physics", "Kinematics", portable = false)
        await { model.state.value.active.name == "Kinematics.md" && model.state.value.folderRelative == "Physics" }
        assertEquals("Physics/Kinematics.md", model.state.value.active.relative)
        assertFalse(model.state.value.active.portable)
        assertTrue(model.state.value.files.any { it.name == "Kinematics.md" && !it.directory })
        assertTrue(File(rootDir, "Physics/Kinematics.md").isFile)

        // Create Portable (.smd) note inside subfolder -> writes valid portable envelope and opens active tab
        model.createFolderNote("Physics", "Lab Bundle", portable = true)
        await { model.state.value.active.name == "Lab Bundle.smd" && model.state.value.active.portable }
        val smdFile = File(rootDir, "Physics/Lab Bundle.smd")
        assertTrue(smdFile.isFile)
        val opened = smdFile.inputStream().use(model.media::openFmd)
        assertEquals("", opened.markdown)
        assertNoHiddenOrVaultFiles()
    }

    @Test
    fun renameValidatesExtensionsAndSynchronizesTabsAcrossWindowsRecentsPinsAndReadingPositions() {
        // Unit validation checks
        assertEquals("Summary.md", validateFolderEntryName("Summary", isDirectory = false, currentExtension = "md"))
        assertEquals("Summary.md", validateFolderEntryName("Summary.MD", isDirectory = false, currentExtension = "md"))
        for (invalid in listOf("", "  ", ".", "..", "sub/file", "sub\\file", "bad\u0000name", ".hidden", "Summary.smd")) {
            val result = runCatching { validateFolderEntryName(invalid, isDirectory = false, currentExtension = "md") }
            assertTrue("Expected '$invalid' to fail validation", result.isFailure)
        }

        val subDir = File(rootDir, "Course").apply { mkdirs() }
        val openFile = File(subDir, "Week1.md").apply { writeText("# Week 1\n") }
        val closedFile = File(subDir, "Week2.md").apply { writeText("# Week 2\n") }

        val mainWindow = newModel()
        val secondWindow = newModel()
        mainWindow.setFolder(treeUri)
        secondWindow.setFolder(treeUri)
        await { mainWindow.state.value.folder != null && secondWindow.state.value.folder != null }

        val openUri = treeDocUri("root/Course/Week1.md")
        val closedUri = treeDocUri("root/Course/Week2.md")
        grantReadWrite(openUri)
        grantReadWrite(closedUri)

        mainWindow.open(openUri, "Course/Week1.md")
        await(debugInfo = { "mainOpen: err=${mainWindow.state.value.error}" }) {
            mainWindow.state.value.active.uri == openUri.toString()
        }
        secondWindow.open(openUri, "Course/Week1.md")
        await(debugInfo = { "secOpen: err=${secondWindow.state.value.error}" }) {
            secondWindow.state.value.active.uri == openUri.toString()
        }
        mainWindow.pinRecent(openUri.toString())
        mainWindow.readingPosition(
            mainWindow.state.value.active.id,
            JSONObject().put("top", 64.0).put("offset", 8.0).put("zoom", 100.0).put("mode", "live"),
        )
        assertNotNull(mainWindow.readingLocation(openUri.toString()))

        // Duplicate rename is rejected
        mainWindow.renameFolderEntry(closedUri, "Course/Week2.md", isDirectory = false, requested = "Week1")
        await(debugInfo = { "dup: err=${mainWindow.state.value.error}" }) {
            mainWindow.state.value.error?.contains("already exists") == true
        }
        mainWindow.dismissError()
        assertTrue(closedFile.isFile)

        // Rename closed note without supplying extension
        mainWindow.renameFolderEntry(closedUri, "Course/Week2.md", isDirectory = false, requested = "Week2 Revised")
        await(debugInfo = { "closedRename: err=${mainWindow.state.value.error}" }) {
            File(subDir, "Week2 Revised.md").isFile && !closedFile.exists()
        }

        // Rename parent folder "Course" -> "Semester" and verify open tabs in both windows, recents, pins, readingPositions
        val folderDocUri = treeDocUri("root/Course")
        mainWindow.listFolder(treeUri, "Course")
        await(debugInfo = { "listCourse: rel=${mainWindow.state.value.folderRelative} err=${mainWindow.state.value.error}" }) {
            mainWindow.state.value.folderRelative == "Course"
        }

        mainWindow.renameFolderEntry(folderDocUri, "Course", isDirectory = true, requested = "Semester")
        val expectedNewNoteUri = treeDocUri("root/Semester/Week1.md").toString()
        await(debugInfo = {
            "dirRename: mainUri=${mainWindow.state.value.active.uri} secUri=${secondWindow.state.value.active.uri} " +
                "rel=${mainWindow.state.value.folderRelative} err=${mainWindow.state.value.error}"
        }) {
            mainWindow.state.value.active.uri == expectedNewNoteUri &&
                secondWindow.state.value.active.uri == expectedNewNoteUri &&
                mainWindow.state.value.folderRelative == "Semester"
        }
        assertEquals("Semester/Week1.md", mainWindow.state.value.active.relative)
        assertEquals("Semester/Week1.md", secondWindow.state.value.active.relative)
        val pinnedRecent = mainWindow.recent.value.firstOrNull { it.uri == expectedNewNoteUri }
        assertNotNull(pinnedRecent)
        assertTrue(pinnedRecent!!.pinned)
        assertEquals("Semester/Week1.md", pinnedRecent.relative)
        assertNotNull(mainWindow.readingLocation(expectedNewNoteUri))
        assertNull(mainWindow.readingLocation(openUri.toString()))
    }

    @Test
    fun moveBlocksSelfOrDescendantAndCopiesLinkedLocalImagesLazily() {
        File(rootDir, "assets").mkdirs()
        val pngBytes = byteArrayOf(
            0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
            0x00, 0x00, 0x00, 0x0d,
        )
        File(rootDir, "assets/diagram.png").writeBytes(pngBytes)
        File(rootDir, "Paper.md").writeText("# Paper\n\n![Diagram](assets/diagram.png)\n\n```\n![Ignored](assets/fake.png)\n```\n")
        File(rootDir, "Archive/Deep/HiddenLeaf").mkdirs()

        val model = newModel()
        model.setFolder(treeUri)
        await { model.state.value.files.isNotEmpty() }

        // Verify lazy folder picker does NOT query unexpanded Archive/Deep
        provider.queriedChildDirectories.clear()
        model.loadMovePickerTargets(excludeFolderRelative = null, expandedRelatives = emptySet())
        await { model.state.value.movePickerTargets.isNotEmpty() }
        assertEquals(listOf("", "Archive", "assets"), model.state.value.movePickerTargets.map { it.relative })
        assertFalse(
            "Unexpanded nested folders must not be eagerly queried",
            provider.queriedChildDirectories.contains("root/Archive/Deep"),
        )

        // Block moving Archive into itself or Archive/Deep
        val archiveUri = treeDocUri("root/Archive")
        model.requestMoveFolderEntry(archiveUri, "Archive", isDirectory = true, targetParentRelative = "Archive/Deep")
        await { model.state.value.error?.contains("Cannot move a folder into itself") == true }
        model.dismissError()

        // Requesting move of Paper.md into Archive prompts about linked local image
        val paperUri = treeDocUri("root/Paper.md")
        grantReadWrite(paperUri)
        model.open(paperUri, "Paper.md")
        await { model.state.value.active.uri == paperUri.toString() }

        model.requestMoveFolderEntry(paperUri, "Paper.md", isDirectory = false, targetParentRelative = "Archive")
        await { model.state.value.moveImagesPrompt != null }
        val prompt = model.state.value.moveImagesPrompt!!
        assertEquals(1, prompt.imageCount)
        assertTrue(prompt.canCopy)

        // Confirming with copyImages=true copies assets/diagram.png into Archive/assets/diagram.png and moves Paper.md
        // Also test fallback path when provider throws UnsupportedOperationException on moveDocument
        provider.supportMoveDocument = false
        model.moveFolderEntry(paperUri, "Paper.md", isDirectory = false, targetParentRelative = "Archive", copyImages = true)
        val movedPaperUri = treeDocUri("root/Archive/Paper.md").toString()
        await {
            File(rootDir, "Archive/Paper.md").isFile &&
                !File(rootDir, "Paper.md").exists() &&
                model.state.value.active.uri == movedPaperUri
        }
        assertArrayEquals(pngBytes, File(rootDir, "Archive/assets/diagram.png").readBytes())
        assertEquals("Archive/Paper.md", model.state.value.active.relative)
    }

    @Test
    fun deletePreservesDirtyDraftsInClosedNoteRecoveryAndCleansWorkspaceState() {
        val folder = File(rootDir, "Scratch").apply { mkdirs() }
        File(folder, "DraftNote.md").writeText("# Baseline\n")

        val model = newModel()
        model.setFolder(treeUri)
        await { model.state.value.files.any { it.name == "Scratch" } }

        val draftUri = treeDocUri("root/Scratch/DraftNote.md")
        grantReadWrite(draftUri)
        model.open(draftUri, "Scratch/DraftNote.md")
        await { model.state.value.active.uri == draftUri.toString() }
        val draftId = model.state.value.active.id
        model.pinRecent(draftUri.toString())
        model.edit(draftId, "# Baseline\n\nUnsaved critical thoughts!\n")
        assertTrue(model.state.value.active.dirty)

        // Delete parent folder Scratch
        val scratchUri = treeDocUri("root/Scratch")
        model.deleteFolderEntry(scratchUri, "Scratch", isDirectory = true)
        await {
            !folder.exists() &&
                model.state.value.tabs.none { it.id == draftId } &&
                model.state.value.closedTabs.any { it.id == draftId }
        }
        assertTrue(model.recent.value.none { it.uri == draftUri.toString() })
        assertNoHiddenOrVaultFiles()

        // Reopen recovers the dirty draft detached from the deleted URI
        model.reopen()
        await { model.state.value.active.id == draftId }
        assertTrue(model.state.value.active.content.contains("Unsaved critical thoughts!"))
        assertNull(model.state.value.active.uri)
    }

    private fun newModel(): StudioViewModel {
        val store = ViewModelStore().also(viewModels::add)
        val key = "folder-actions-${System.nanoTime()}".also(workspaceKeys::add)
        val model = StudioViewModel(app, key)
        model.readerFlushRequester = { true }
        store.put("model", model)
        return model
    }

    private fun treeDocUri(docId: String): Uri =
        DocumentsContract.buildDocumentUriUsingTree(treeUri, docId)

    private fun grantReadWrite(uri: Uri) {
        app.grantUriPermission(
            app.packageName,
            uri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
        )
    }

    private fun assertNoHiddenOrVaultFiles() {
        rootDir.walkTopDown().forEach { file ->
            if (file != rootDir) {
                assertFalse("Unexpected hidden or trash artifact: ${file.path}", file.name.startsWith("."))
            }
        }
    }

    private fun await(debugInfo: () -> String = { "" }, predicate: () -> Boolean) {
        val deadline = System.nanoTime() + 5_000_000_000L
        while (System.nanoTime() < deadline) {
            shadowOf(Looper.getMainLooper()).idle()
            if (predicate()) return
            Thread.sleep(10)
        }
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue("Condition was not satisfied before timeout. ${debugInfo()}", predicate())
    }
}

private class TreeTestDocumentsProvider(private val rootDir: File) : ContentProvider() {
    var supportMoveDocument = true
    val queriedChildDirectories = java.util.Collections.synchronizedSet(mutableSetOf<String>())
    private var attachedAuthority: String = ""

    fun attach(context: Context, authority: String) {
        attachedAuthority = authority
        attachInfo(
            context,
            ProviderInfo().apply {
                this.authority = authority
                exported = true
                grantUriPermissions = true
            },
        )
    }

    override fun onCreate(): Boolean = true

    private fun fileForDocId(documentId: String): File {
        require(documentId == "root" || documentId.startsWith("root/")) { "Unknown documentId: $documentId" }
        val rel = documentId.removePrefix("root").trimStart('/')
        val resolved = if (rel.isEmpty()) rootDir else File(rootDir, rel)
        val canonicalRoot = rootDir.canonicalPath
        val canonicalTarget = resolved.canonicalPath
        require(canonicalTarget == canonicalRoot || canonicalTarget.startsWith(canonicalRoot + File.separator)) {
            "Outside root: $documentId"
        }
        return resolved
    }

    private fun docIdForFile(file: File): String {
        val rootPath = rootDir.canonicalPath
        val filePath = file.canonicalPath
        if (filePath == rootPath) return "root"
        val rel = filePath.removePrefix(rootPath + File.separator).replace(File.separatorChar, '/')
        return "root/$rel"
    }

    private fun treeUriForDocId(docId: String): Uri {
        val tree = DocumentsContract.buildTreeDocumentUri(attachedAuthority, "root")
        return DocumentsContract.buildDocumentUriUsingTree(tree, docId)
    }

    private fun mimeFor(file: File): String =
        if (file.isDirectory) Document.MIME_TYPE_DIR
        else safAssetMimeForName(file.name, null)

    private fun includeFile(cursor: MatrixCursor, file: File) {
        if (!file.exists()) throw FileNotFoundException(file.path)
        val flags = if (file.isDirectory) {
            Document.FLAG_DIR_SUPPORTS_CREATE or Document.FLAG_SUPPORTS_DELETE or Document.FLAG_SUPPORTS_RENAME or Document.FLAG_SUPPORTS_MOVE
        } else {
            Document.FLAG_SUPPORTS_WRITE or Document.FLAG_SUPPORTS_DELETE or Document.FLAG_SUPPORTS_RENAME or Document.FLAG_SUPPORTS_MOVE
        }
        val cols = cursor.columnNames
        val row = arrayOfNulls<Any>(cols.size)
        val displayName = if (file == rootDir) "WorkspaceNotes" else file.name
        val size = if (file.isFile) file.length() else 0L
        for (i in cols.indices) {
            row[i] = when (cols[i]) {
                Document.COLUMN_DOCUMENT_ID -> docIdForFile(file)
                Document.COLUMN_DISPLAY_NAME, OpenableColumns.DISPLAY_NAME -> displayName
                Document.COLUMN_MIME_TYPE -> mimeFor(file)
                Document.COLUMN_SIZE, OpenableColumns.SIZE -> size
                Document.COLUMN_LAST_MODIFIED -> file.lastModified()
                Document.COLUMN_FLAGS -> flags
                else -> null
            }
        }
        cursor.addRow(row)
    }

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor {
        val cols = projection ?: DEFAULT_DOC_PROJECTION
        val segments = uri.pathSegments
        if (segments.lastOrNull() == "children" && segments.size >= 2) {
            val parentDocId = Uri.decode(segments[segments.size - 2])
            queriedChildDirectories.add(parentDocId)
            val parent = fileForDocId(parentDocId)
            if (!parent.isDirectory) throw FileNotFoundException(parentDocId)
            return MatrixCursor(cols).also { cursor ->
                parent.listFiles()?.forEach { child -> includeFile(cursor, child) }
            }
        }
        val docId = DocumentsContract.getDocumentId(uri)
        val file = fileForDocId(docId)
        return MatrixCursor(cols).also { includeFile(it, file) }
    }

    override fun getType(uri: Uri): String {
        val docId = runCatching { DocumentsContract.getDocumentId(uri) }.getOrNull() ?: return Document.MIME_TYPE_DIR
        val file = runCatching { fileForDocId(docId) }.getOrNull() ?: return "application/octet-stream"
        return mimeFor(file)
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0

    override fun call(method: String, arg: String?, extras: Bundle?): Bundle {
        val inExtras = extras ?: Bundle.EMPTY
        val docUri = inExtras.getParcelable("uri", Uri::class.java)
        val out = Bundle()
        when (method) {
            "android:createDocument" -> {
                val parentId = DocumentsContract.getDocumentId(requireNotNull(docUri))
                val mimeType = inExtras.getString(Document.COLUMN_MIME_TYPE).orEmpty()
                val displayName = requireNotNull(inExtras.getString(Document.COLUMN_DISPLAY_NAME))
                val parent = fileForDocId(parentId)
                if (!parent.isDirectory) throw FileNotFoundException(parentId)
                val target = File(parent, displayName)
                if (mimeType == Document.MIME_TYPE_DIR) {
                    check(target.mkdirs() || target.isDirectory) { "Could not mkdir $target" }
                } else {
                    check(target.createNewFile()) { "Could not create $target" }
                }
                val newId = docIdForFile(target)
                val outUri = treeUriForDocId(newId)
                grantPermissions(outUri)
                out.putParcelable("uri", outUri)
            }
            "android:renameDocument" -> {
                val docId = DocumentsContract.getDocumentId(requireNotNull(docUri))
                val displayName = requireNotNull(inExtras.getString(Document.COLUMN_DISPLAY_NAME))
                val source = fileForDocId(docId)
                if (!source.exists()) throw FileNotFoundException(docId)
                val dest = File(source.parentFile, displayName)
                check(source.renameTo(dest)) { "Rename failed" }
                val newId = docIdForFile(dest)
                val outUri = treeUriForDocId(newId)
                grantPermissions(outUri)
                out.putParcelable("uri", outUri)
            }
            "android:moveDocument" -> {
                if (!supportMoveDocument) throw UnsupportedOperationException("Move unsupported by provider")
                val sourceId = DocumentsContract.getDocumentId(requireNotNull(docUri))
                val targetParentUri = requireNotNull(inExtras.getParcelable("targetUri", Uri::class.java))
                val targetParentId = DocumentsContract.getDocumentId(targetParentUri)
                val source = fileForDocId(sourceId)
                val targetParent = fileForDocId(targetParentId)
                if (!source.exists() || !targetParent.isDirectory) throw FileNotFoundException(sourceId)
                val dest = File(targetParent, source.name)
                check(source.renameTo(dest)) { "Move failed" }
                val newId = docIdForFile(dest)
                val outUri = treeUriForDocId(newId)
                grantPermissions(outUri)
                out.putParcelable("uri", outUri)
            }
            "android:deleteDocument" -> {
                val docId = DocumentsContract.getDocumentId(requireNotNull(docUri))
                val target = fileForDocId(docId)
                if (!target.exists()) throw FileNotFoundException(docId)
                check(target.deleteRecursively()) { "Delete failed" }
            }
            "android:isChildDocument" -> {
                val parentId = DocumentsContract.getDocumentId(requireNotNull(docUri)).trimEnd('/')
                val childUri = requireNotNull(inExtras.getParcelable("targetUri", Uri::class.java))
                val childId = DocumentsContract.getDocumentId(childUri)
                out.putBoolean("result", childId == parentId || childId.startsWith("$parentId/"))
            }
        }
        return out
    }

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        val docId = DocumentsContract.getDocumentId(uri)
        val file = fileForDocId(docId)
        val flags = when (mode) {
            "r" -> ParcelFileDescriptor.MODE_READ_ONLY
            "rw" -> ParcelFileDescriptor.MODE_READ_WRITE
            "wt", "w" -> ParcelFileDescriptor.MODE_WRITE_ONLY or ParcelFileDescriptor.MODE_CREATE or ParcelFileDescriptor.MODE_TRUNCATE
            else -> ParcelFileDescriptor.parseMode(mode)
        }
        if (!file.exists() && !mode.contains('w')) throw FileNotFoundException(docId)
        return ParcelFileDescriptor.open(file, flags)
    }

    private fun grantPermissions(docUri: Uri) {
        val ctx = context ?: return
        ctx.grantUriPermission(
            ctx.packageName,
            docUri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION or
                Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                Intent.FLAG_GRANT_PREFIX_URI_PERMISSION,
        )
    }

    companion object {
        private val DEFAULT_DOC_PROJECTION = arrayOf(
            Document.COLUMN_DOCUMENT_ID,
            Document.COLUMN_DISPLAY_NAME,
            Document.COLUMN_MIME_TYPE,
            Document.COLUMN_SIZE,
            Document.COLUMN_LAST_MODIFIED,
            Document.COLUMN_FLAGS,
        )
    }
}
