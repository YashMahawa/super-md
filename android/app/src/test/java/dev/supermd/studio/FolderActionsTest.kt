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
import java.time.Duration
import java.util.UUID
import org.json.JSONObject
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
class FolderActionsTest {
    private lateinit var app: android.app.Application
    private lateinit var rootDir: File
    private lateinit var provider: TreeTestDocumentsProvider
    private lateinit var authority: String
    private lateinit var treeUri: Uri
    private var previousAutosave: Boolean? = null
    private var previousRecent: String? = null
    private var previousPositions: String? = null
    private val workspaceKeys = mutableListOf<String>()
    private val viewModels = mutableListOf<ViewModelStore>()

    @Before
    fun setUp() {
        app = RuntimeEnvironment.getApplication()
        rootDir = Files.createTempDirectory("android-folder-actions-test").toFile()
        authority = "dev.supermd.test.tree.${UUID.randomUUID()}"
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
        previousPositions = prefs.getString("readingPositions", null)
        prefs.edit()
            .putBoolean("autosave", false)
            .remove("recent")
            .remove("readingPositions")
            .commit()
    }

    @After
    fun tearDown() {
        viewModels.forEach { it.clear() }
        app.getSharedPreferences("studio", Context.MODE_PRIVATE).edit().apply {
            putBoolean("autosave", previousAutosave ?: true)
            if (previousRecent == null) remove("recent") else putString("recent", previousRecent)
            if (previousPositions == null) remove("readingPositions") else putString("readingPositions", previousPositions)
        }.commit()
        ShadowContentResolver.reset()
        rootDir.deleteRecursively()
        workspaceKeys.forEach { key ->
            File(app.filesDir, "workspaces/$key.json").delete()
            File(app.filesDir, "workspaces/$key").deleteRecursively()
            File(app.filesDir, "deleted-drafts/$key").deleteRecursively()
            app.deleteSharedPreferences("studio-window-$key")
        }
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
    fun renameValidatesExtensionsSynchronizesWindowsAndPreservesStreamingSearchAndSeededFind() {
        // Unit validation & noteStem checks
        assertEquals("1.2 Linear Algebra", noteStem("1.2 Linear Algebra.md"))
        assertEquals("Study", noteStem("Study.smd"))
        assertTrue(isSupportedFolderNoteFile("1.2 Linear Algebra.md"))
        assertFalse(isSupportedFolderNoteFile(".hidden.md"))
        assertFalse(isSupportedFolderNoteFile("README"))
        assertEquals("Summary.md", validateFolderEntryName("Summary", isDirectory = false, currentExtension = "md"))
        assertEquals("Summary.md", validateFolderEntryName("Summary.MD", isDirectory = false, currentExtension = "md"))
        assertEquals("README", validateFolderEntryName("README", isDirectory = false, currentExtension = "", hasSavedTarget = true))
        for (invalid in listOf("", "  ", ".", "..", "sub/file", "sub\\file", "bad\u0000name", ".hidden", "bad:name", "trailing.", "Summary.smd")) {
            val result = runCatching { validateFolderEntryName(invalid, isDirectory = false, currentExtension = "md") }
            assertTrue("Expected '$invalid' to fail validation", result.isFailure)
        }

        val subDir = File(rootDir, "Course").apply { mkdirs() }
        File(subDir, "Week1.md").writeText("# Week 1\n\nSeededNeedle appears in week one.\n")
        val closedFile = File(subDir, "Week2.md").apply { writeText("# Week 2\n\nClosedNeedle appears in week two.\n") }

        val mainWindow = newModel()
        val secondWindow = newModel()
        mainWindow.setFolder(treeUri)
        secondWindow.setFolder(treeUri)
        await(debugInfo = { "setFolder: main=${mainWindow.state.value.folder}/${mainWindow.state.value.error} sec=${secondWindow.state.value.folder}/${secondWindow.state.value.error}" }) {
            mainWindow.state.value.folder != null && secondWindow.state.value.folder != null
        }

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

        // Seed reader navigation from #56 streaming search before renaming
        mainWindow.openFolderSearch("SeededNeedle")
        await(debugInfo = { "initialSearch: matches=${mainWindow.folderSearch.value.matches.size}" }) {
            !mainWindow.folderSearch.value.scanning && mainWindow.folderSearch.value.matches.size == 1
        }
        mainWindow.openSearchMatch(mainWindow.folderSearch.value.matches.single())
        await { mainWindow.seededFind.value != null }
        assertEquals(openUri.toString(), mainWindow.seededFind.value?.targetUri)

        // Keep an active streaming search open for ClosedNeedle in secondWindow to verify live rescan on rename
        secondWindow.openFolderSearch("ClosedNeedle")
        await(debugInfo = { "secondSearch: matches=${secondWindow.folderSearch.value.matches}" }) {
            !secondWindow.folderSearch.value.scanning &&
                secondWindow.folderSearch.value.matches.any { it.relative == "Course/Week2.md" }
        }

        // Duplicate rename is rejected both globally and via inline dialog callback
        var inlineOutcome: Pair<Boolean, String?>? = null
        mainWindow.renameFolderEntry(closedUri, "Course/Week2.md", isDirectory = false, requested = "Week1", showGlobalError = false) { ok, err ->
            inlineOutcome = ok to err
        }
        await { inlineOutcome != null }
        assertEquals(false, inlineOutcome?.first)
        assertTrue(inlineOutcome?.second?.contains("already exists") == true)
        assertNull(mainWindow.state.value.error)

        mainWindow.renameFolderEntry(closedUri, "Course/Week2.md", isDirectory = false, requested = "Week1")
        await(debugInfo = { "dup: err=${mainWindow.state.value.error}" }) {
            mainWindow.state.value.error?.contains("already exists") == true
        }
        mainWindow.dismissError()
        assertTrue(closedFile.isFile)

        // Rename closed note without supplying extension -> updates active streaming search in secondWindow
        mainWindow.renameFolderEntry(closedUri, "Course/Week2.md", isDirectory = false, requested = "Week2 Revised")
        await(debugInfo = {
            "closedRename: err=${mainWindow.state.value.error} matches=${secondWindow.folderSearch.value.matches.map { it.relative }}"
        }) {
            File(subDir, "Week2 Revised.md").isFile &&
                !closedFile.exists() &&
                !secondWindow.folderSearch.value.scanning &&
                secondWindow.folderSearch.value.matches.any { it.relative == "Course/Week2 Revised.md" }
        }

        // Rename parent folder "Course" -> "Semester" and verify open tabs, recents, pins, readingPositions, seededFind, and active search
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
                mainWindow.state.value.folderRelative == "Semester" &&
                !secondWindow.folderSearch.value.scanning &&
                secondWindow.folderSearch.value.matches.any { it.relative == "Semester/Week2 Revised.md" }
        }
        assertEquals("Semester/Week1.md", mainWindow.state.value.active.relative)
        assertEquals("Semester/Week1.md", secondWindow.state.value.active.relative)
        assertEquals(expectedNewNoteUri, mainWindow.seededFind.value?.targetUri)
        assertTrue(mainWindow.activeMatchesSeedTarget(mainWindow.state.value.active, mainWindow.seededFind.value!!))
        val pinnedRecent = mainWindow.recent.value.firstOrNull { it.uri == expectedNewNoteUri }
        assertNotNull(pinnedRecent)
        assertTrue(pinnedRecent!!.pinned)
        assertEquals("Semester/Week1.md", pinnedRecent.relative)
        assertNotNull(mainWindow.readingLocation(expectedNewNoteUri))
        assertNull(mainWindow.readingLocation(openUri.toString()))
    }

    @Test
    fun folderRelativePersistsAcrossWorkspaceRestoreAndNavigatesUpCleanly() {
        File(rootDir, "Sem1/Unit2").mkdirs()
        File(rootDir, "Sem1/Unit2/Notes.md").writeText("# Unit 2\n")
        val key = "folder-persist-${UUID.randomUUID()}".also(workspaceKeys::add)
        val first = newModel(key)
        first.setFolder(treeUri)
        await { first.state.value.folder == treeUri.toString() }
        first.listFolder(treeUri, "Sem1/Unit2")
        await { first.state.value.folderRelative == "Sem1/Unit2" && first.state.value.files.any { it.name == "Notes.md" } }

        val restored = newModel(key)
        await { restored.state.value.folderRelative == "Sem1/Unit2" && restored.state.value.files.any { it.name == "Notes.md" } }
        assertTrue(restored.navigateFolderUp())
        await { restored.state.value.folderRelative == "Sem1" }
        assertTrue(restored.navigateFolderUp())
        await { restored.state.value.folderRelative == "" }
        assertFalse(restored.navigateFolderUp())
    }

    @Test
    fun existingExtensionsAndDottedNoteTitlesPreservedAcrossFolderAndTabRename() {
        val cases = listOf(
            Triple("1.2 Linear Algebra.md", "md", "1.2 Linear Algebra"),
            Triple("2.4 Eigenvalues.markdown", "markdown", "2.4 Eigenvalues"),
            Triple("3.1 Bundle.smd", "smd", "3.1 Bundle"),
            Triple("3.2 Legacy.fmd", "fmd", "3.2 Legacy"),
            Triple("4.1 Plain Notes.txt", "txt", "4.1 Plain Notes"),
            Triple("4.2 UPPER.TXT", "TXT", "4.2 UPPER"),
            Triple("5.1 Outline.org", "org", "5.1 Outline"),
            Triple("README", "", "README"),
            Triple("Section 1.2", "", "Section 1.2"),
            Triple("1.2 Linear Algebra", "", "1.2 Linear Algebra"),
        )
        for ((filename, expectedExt, expectedStem) in cases) {
            assertEquals("ext for $filename", expectedExt, noteExtension(filename))
            assertEquals("stem for $filename", expectedStem, noteStem(filename))
        }

        File(rootDir, "1.2 Linear Algebra.txt").writeText("Linear algebra text\n")
        File(rootDir, "2.4 Eigenvalues.markdown").writeText("# Eigenvalues\n")
        File(rootDir, "3.1 Legacy.fmd").writeText("# Legacy\n")
        File(rootDir, "4.0 Notes.TXT").writeText("Uppercase extension\n")
        File(rootDir, "Section 1.2").writeText("Extensionless dotted note\n")

        val model = newModel()
        model.setFolder(treeUri)
        await { model.state.value.files.any { it.name == "1.2 Linear Algebra.txt" } }

        // Open .txt dotted note and rename via tab rename without supplying extension
        val txtUri = treeDocUri("root/1.2 Linear Algebra.txt").also(::grantReadWrite)
        model.open(txtUri, "1.2 Linear Algebra.txt")
        await { model.state.value.active.uri == txtUri.toString() }
        model.rename(model.state.value.active.id, "1.3 Vector Spaces")
        await(debugInfo = { "txtRename: err=${model.state.value.error} active=${model.state.value.active.name}" }) {
            File(rootDir, "1.3 Vector Spaces.txt").isFile && model.state.value.active.name == "1.3 Vector Spaces.txt"
        }

        // Rename .markdown, .fmd, and .TXT entries via folder drawer rename to new dotted titles
        val mdUri = treeDocUri("root/2.4 Eigenvalues.markdown").also(::grantReadWrite)
        model.renameFolderEntry(mdUri, "2.4 Eigenvalues.markdown", isDirectory = false, requested = "2.5 Eigenvectors")
        await(debugInfo = { "markdownRename: err=${model.state.value.error}" }) {
            File(rootDir, "2.5 Eigenvectors.markdown").isFile &&
                model.state.value.files.any { it.name == "2.5 Eigenvectors.markdown" }
        }

        val fmdUri = treeDocUri("root/3.1 Legacy.fmd").also(::grantReadWrite)
        model.renameFolderEntry(fmdUri, "3.1 Legacy.fmd", isDirectory = false, requested = "3.2 Archive")
        await(debugInfo = { "fmdRename: err=${model.state.value.error}" }) {
            File(rootDir, "3.2 Archive.fmd").isFile &&
                model.state.value.files.any { it.name == "3.2 Archive.fmd" }
        }

        val upperTxtUri = treeDocUri("root/4.0 Notes.TXT").also(::grantReadWrite)
        model.renameFolderEntry(upperTxtUri, "4.0 Notes.TXT", isDirectory = false, requested = "4.1 Summary")
        await(debugInfo = { "upperTxtRename: err=${model.state.value.error}" }) {
            File(rootDir, "4.1 Summary.TXT").isFile &&
                model.state.value.files.any { it.name == "4.1 Summary.TXT" }
        }

        // Open extensionless dotted note and rename without appending a bogus '.2' suffix
        val extlessUri = treeDocUri("root/Section 1.2").also(::grantReadWrite)
        model.open(extlessUri, "Section 1.2")
        await { model.state.value.active.uri == extlessUri.toString() }
        model.rename(model.state.value.active.id, "Section 1.3")
        await(debugInfo = { "extlessRename: err=${model.state.value.error} active=${model.state.value.active.name}" }) {
            File(rootDir, "Section 1.3").isFile && model.state.value.active.name == "Section 1.3"
        }
    }

    @Test
    fun restoredSubfolderParentNavigationAndExternalRefreshSyncWithCreateAndRename() {
        val algebraDir = File(rootDir, "Sem1/Math/Algebra").apply { mkdirs() }
        val basisFile = File(algebraDir, "1.2 Basis.txt").apply { writeText("Initial basis\n") }

        val key = "refresh-parent-nav-${UUID.randomUUID()}".also(workspaceKeys::add)
        val initial = newModel(key)
        initial.setFolder(treeUri)
        await { initial.state.value.folder == treeUri.toString() }
        initial.listFolder(treeUri, "Sem1/Math/Algebra")
        await { initial.state.value.folderRelative == "Sem1/Math/Algebra" && initial.state.value.files.any { it.name == "1.2 Basis.txt" } }

        val restored = newModel(key)
        await { restored.state.value.folderRelative == "Sem1/Math/Algebra" && restored.state.value.files.any { it.name == "1.2 Basis.txt" } }

        val basisUri = treeDocUri("root/Sem1/Math/Algebra/1.2 Basis.txt").also(::grantReadWrite)
        restored.open(basisUri, "Sem1/Math/Algebra/1.2 Basis.txt")
        await { restored.state.value.active.uri == basisUri.toString() }

        // External file update + external sibling creation sync cleanly while preserving nested folderRelative
        basisFile.writeText("Externally updated basis\n")
        File(algebraDir, "1.3 Dimension.markdown").writeText("# Dimension\n")
        restored.refreshExternal()
        restored.refreshMetadata()
        await(debugInfo = { "refreshSync: content=${restored.state.value.active.content} files=${restored.state.value.files.map { it.name }}" }) {
            restored.state.value.active.content == "Externally updated basis\n" &&
                restored.state.value.folderRelative == "Sem1/Math/Algebra" &&
                restored.state.value.files.any { it.name == "1.3 Dimension.markdown" }
        }

        // Rename ancestor folder Sem1/Math -> Sem1/PureMath while inside Sem1/Math/Algebra, then navigate up step-by-step
        val mathUri = treeDocUri("root/Sem1/Math").also(::grantReadWrite)
        restored.renameFolderEntry(mathUri, "Sem1/Math", isDirectory = true, requested = "PureMath")
        await(debugInfo = { "ancestorRename: rel=${restored.state.value.folderRelative} err=${restored.state.value.error}" }) {
            restored.state.value.folderRelative == "Sem1/PureMath/Algebra" &&
                restored.state.value.active.relative == "Sem1/PureMath/Algebra/1.2 Basis.txt"
        }

        assertTrue(restored.navigateFolderUp())
        await { restored.state.value.folderRelative == "Sem1/PureMath" }
        assertTrue(restored.navigateFolderUp())
        await { restored.state.value.folderRelative == "Sem1" }
        assertTrue(restored.navigateFolderUp())
        await { restored.state.value.folderRelative == "" }
        assertFalse(restored.navigateFolderUp())
    }

    @Test
    fun opaqueSafIdsSupportCreateRenameAndGrantedFolderRecoveryWithoutPathSplitting() {
        val opaqueRoot = Files.createTempDirectory("android-opaque-folder-test").toFile()
        val outsideDir = Files.createTempDirectory("android-opaque-outside-test").toFile()
        try {
            val outsideSecret = File(outsideDir, "outside-secret.md").apply { writeText("# Outside\n") }
            val opaqueAuthority = "dev.supermd.test.opaque.${UUID.randomUUID()}"
            val opaqueProvider = OpaqueFolderDocumentsProvider(app, opaqueRoot, outsideSecret).also {
                it.attach(app, opaqueAuthority)
            }
            ShadowContentResolver.registerProviderInternal(opaqueAuthority, opaqueProvider)
            val opaqueTreeUri = DocumentsContract.buildTreeDocumentUri(opaqueAuthority, OpaqueFolderDocumentsProvider.ROOT_ID)
            app.grantUriPermission(
                app.packageName,
                opaqueTreeUri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION or
                    Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                    Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or
                    Intent.FLAG_GRANT_PREFIX_URI_PERMISSION,
            )

            val model = newModel()
            model.setFolder(opaqueTreeUri)
            await { model.state.value.folder == opaqueTreeUri.toString() }

            // Create nested folders Sem1/Math and notes using non-hierarchical opaque document IDs
            model.createSubfolder("", "Sem1")
            await { model.state.value.files.any { it.directory && it.name == "Sem1" } }
            val sem1Entry = model.state.value.files.single { it.directory && it.name == "Sem1" }
            assertFalse("Expected opaque ID without path hierarchy, got ${sem1Entry.uri}", DocumentsContract.getDocumentId(Uri.parse(sem1Entry.uri)).contains('/'))

            model.listFolder(opaqueTreeUri, "Sem1")
            await { model.state.value.folderRelative == "Sem1" }
            model.createSubfolder("Sem1", "Math")
            await { model.state.value.files.any { it.directory && it.name == "Math" } }
            model.listFolder(opaqueTreeUri, "Sem1/Math")
            await { model.state.value.folderRelative == "Sem1/Math" }

            model.createFolderNote("Sem1/Math", "Lecture 1", portable = false)
            await {
                model.state.value.active.name == "Lecture 1.md" &&
                    model.state.value.active.relative == "Sem1/Math/Lecture 1.md"
            }
            val lectureTreeUri = Uri.parse(model.state.value.active.uri!!)
            val lectureDocId = DocumentsContract.getDocumentId(lectureTreeUri)
            assertFalse("Expected opaque note ID without path slashes: $lectureDocId", lectureDocId.contains('/'))
            val lectureNoteId = model.state.value.active.id
            model.edit(lectureNoteId, "# Lecture 1\n\nOpaque SAF baseline\n")
            model.save(noteId = lectureNoteId)
            await { !model.state.value.active.dirty }
            model.pinRecent(lectureTreeUri.toString())
            model.readingPosition(
                lectureNoteId,
                JSONObject().put("top", 55.0).put("offset", 4.0).put("zoom", 100.0).put("mode", "live"),
            )

            model.createFolderNote("Sem1/Math", "Workbook", portable = true)
            await {
                model.state.value.active.name == "Workbook.smd" &&
                    model.state.value.active.relative == "Sem1/Math/Workbook.smd"
            }

            // #95 granted-folder recovery: plain document URI loses direct grant, then recovers via setFolder(opaqueTreeUri)
            app.contentResolver.releasePersistableUriPermission(
                opaqueTreeUri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
            )
            val grantedUris = mutableMapOf<Uri, Int>()
            val enforcingApp = object : android.app.Application() {
                init {
                    attachBaseContext(app)
                }

                override fun getApplicationContext(): Context = this

                override fun checkUriPermission(uri: Uri?, pid: Int, uid: Int, modeFlags: Int): Int {
                    if (uri == null) return android.content.pm.PackageManager.PERMISSION_DENIED
                    val held = grantedUris.entries
                        .filter { (granted, _) ->
                            granted == uri || (DocumentsContract.isTreeUri(granted) && uri.toString().startsWith(granted.toString() + "/"))
                        }
                        .fold(0) { acc, (_, flags) -> acc or flags }
                    return if ((held and modeFlags) == modeFlags) {
                        android.content.pm.PackageManager.PERMISSION_GRANTED
                    } else {
                        android.content.pm.PackageManager.PERMISSION_DENIED
                    }
                }
            }
            val rwFlags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            val plainLectureUri = DocumentsContract.buildDocumentUri(opaqueAuthority, lectureDocId)
            grantedUris[plainLectureUri] = rwFlags
            val recoveryStore = ViewModelStore().also(viewModels::add)
            val recoveryKey = "folder-actions-recovery-${UUID.randomUUID()}".also(workspaceKeys::add)
            val recoveryModel = StudioViewModel(enforcingApp, recoveryKey).also {
                it.readerFlushRequester = { true }
                recoveryStore.put("recovery", it)
            }
            recoveryModel.open(plainLectureUri)
            await {
                recoveryModel.state.value.active.uri == plainLectureUri.toString() &&
                    recoveryModel.state.value.active.content.contains("Opaque SAF baseline")
            }
            val recoveryNoteId = recoveryModel.state.value.active.id
            val updatedDraft = "# Lecture 1\n\nRecovered through granted opaque folder\n"
            recoveryModel.edit(recoveryNoteId, updatedDraft)
            grantedUris.remove(plainLectureUri)
            opaqueProvider.rejectPlainDocumentUris = true
            recoveryModel.save(noteId = recoveryNoteId)
            await {
                recoveryModel.documentAccessRequests.value != null &&
                    recoveryModel.documentWriteNeedsAccess(recoveryNoteId)
            }
            recoveryModel.dismissDocumentAccess()

            // Grant the containing tree; unlisted document whose opaque ID happens to share a string prefix with root must NEVER resolve into tree
            grantedUris[opaqueTreeUri] = rwFlags
            val trickyOutsidePlainUri = DocumentsContract.buildDocumentUri(
                opaqueAuthority,
                OpaqueFolderDocumentsProvider.UNLISTED_PREFIXED_ID,
            )
            val checkAccess = DocumentAccess(
                context = enforcingApp,
                activeFolderUriProvider = { opaqueTreeUri },
            )
            assertEquals(
                "Unlisted path-prefixed opaque ID must not manufacture tree access",
                trickyOutsidePlainUri,
                checkAccess.resolve(trickyOutsidePlainUri, writing = false),
            )

            recoveryModel.setFolder(opaqueTreeUri)
            await(debugInfo = {
                "unblock: folder=${recoveryModel.state.value.folder} blocked=${recoveryModel.documentWriteNeedsAccess(recoveryNoteId)} err=${recoveryModel.state.value.error}"
            }) {
                recoveryModel.state.value.folder == opaqueTreeUri.toString() &&
                    !recoveryModel.documentWriteNeedsAccess(recoveryNoteId)
            }
            recoveryModel.save(noteId = recoveryNoteId)
            await(debugInfo = {
                "recoverySave: uri=${recoveryModel.state.value.active.uri} rel=${recoveryModel.state.value.active.relative} dirty=${recoveryModel.state.value.active.dirty} err=${recoveryModel.state.value.error}"
            }) {
                recoveryModel.state.value.active.uri == lectureTreeUri.toString() &&
                    recoveryModel.state.value.active.relative == "Sem1/Math/Lecture 1.md" &&
                    !recoveryModel.state.value.active.dirty &&
                    recoveryModel.documentAccessRequests.value == null
            }
            assertEquals(updatedDraft, File(opaqueRoot, "Sem1/Math/Lecture 1.md").readText())

            // Sibling note rename + directory rename where provider rotates child opaque IDs
            model.refreshExternal()
            model.refreshMetadata()
            await { model.state.value.files.any { it.name == "Lecture 1.md" } }
            model.renameFolderEntry(lectureTreeUri, "Sem1/Math/Lecture 1.md", isDirectory = false, requested = "1.1 Intro")
            await(debugInfo = { "noteRename: tabs=${model.state.value.tabs.map { it.name to it.relative }} err=${model.state.value.error}" }) {
                model.state.value.tabs.any { it.name == "1.1 Intro.md" && it.relative == "Sem1/Math/1.1 Intro.md" }
            }

            model.listFolder(opaqueTreeUri, "Sem1")
            await { model.state.value.folderRelative == "Sem1" && model.state.value.files.any { it.directory && it.name == "Math" } }
            val mathEntry = model.state.value.files.single { it.directory && it.name == "Math" }
            val mathUri = Uri.parse(mathEntry.uri)
            model.listFolder(opaqueTreeUri, "Sem1/Math")
            await { model.state.value.folderRelative == "Sem1/Math" && model.state.value.files.any { it.name == "1.1 Intro.md" } }

            model.renameFolderEntry(mathUri, "Sem1/Math", isDirectory = true, requested = "PureMath")
            await(debugInfo = {
                "dirRename: folderRel=${model.state.value.folderRelative} tabs=${model.state.value.tabs.map { it.name to it.relative }} err=${model.state.value.error}"
            }) {
                model.state.value.folderRelative == "Sem1/PureMath" &&
                    model.state.value.tabs.any { it.name == "1.1 Intro.md" && it.relative == "Sem1/PureMath/1.1 Intro.md" } &&
                    model.state.value.tabs.any { it.name == "Workbook.smd" && it.relative == "Sem1/PureMath/Workbook.smd" }
            }

            val introTab = model.state.value.tabs.single { it.name == "1.1 Intro.md" }
            val introNewUri = introTab.uri!!
            assertTrue(model.recent.value.any { it.uri == introNewUri && it.pinned })
            assertNotNull(model.readingLocation(introNewUri))
            assertNull(model.readingLocation(lectureTreeUri.toString()))
            assertEquals("Expected zero guessed/unknown documentId queries", emptyList<String>(), opaqueProvider.unknownIdQueries)
        } finally {
            opaqueRoot.deleteRecursively()
            outsideDir.deleteRecursively()
        }
    }

    private fun newModel(explicitKey: String? = null): StudioViewModel {
        val store = ViewModelStore().also(viewModels::add)
        val key = explicitKey ?: "folder-actions-${UUID.randomUUID()}".also(workspaceKeys::add)
        val model = StudioViewModel(app, key)
        model.readerFlushRequester = { true }
        store.put("model-${UUID.randomUUID()}", model)
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
                assertFalse("Unexpected hidden artifact: ${file.path}", file.name.startsWith("."))
            }
        }
    }

    private fun await(debugInfo: () -> String = { "" }, predicate: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 5_000L
        while (System.currentTimeMillis() < deadline) {
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(20))
            if (predicate()) return
            Thread.sleep(10)
        }
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(20))
        assertTrue("Condition was not satisfied before timeout. ${debugInfo()}", predicate())
    }
}

private class TreeTestDocumentsProvider(private val rootDir: File) : ContentProvider() {
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
        else when (file.extension.lowercase()) {
            "smd" -> "application/vnd.supermd.smd"
            "fmd" -> "application/vnd.supermd.fmd"
            "md", "markdown" -> "text/markdown"
            "txt" -> "text/plain"
            else -> "application/octet-stream"
        }

    private fun includeFile(cursor: MatrixCursor, file: File) {
        if (!file.exists()) throw FileNotFoundException(file.path)
        val flags = if (file.isDirectory) {
            Document.FLAG_DIR_SUPPORTS_CREATE or Document.FLAG_SUPPORTS_RENAME
        } else {
            Document.FLAG_SUPPORTS_WRITE or Document.FLAG_SUPPORTS_RENAME
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

private class OpaqueFolderDocumentsProvider(
    private val appContext: Context,
    private val rootDir: File,
    outsideFile: File,
) : ContentProvider() {
    private var attachedAuthority: String = ""
    private var nextSeq = 1
    private val idToPath = linkedMapOf<String, String>()
    private val pathToId = linkedMapOf<String, String>()
    val unknownIdQueries = mutableListOf<String>()
    var rejectPlainDocumentUris: Boolean = false

    init {
        idToPath[ROOT_ID] = rootDir.canonicalPath
        pathToId[rootDir.canonicalPath] = ROOT_ID
        idToPath[UNLISTED_PREFIXED_ID] = outsideFile.canonicalPath
        pathToId[outsideFile.canonicalPath] = UNLISTED_PREFIXED_ID
    }

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

    @Synchronized
    private fun idForFile(file: File): String {
        val canonical = file.canonicalPath
        return pathToId.getOrPut(canonical) {
            "opaque:node-${nextSeq++}".also { id -> idToPath[id] = canonical }
        }
    }

    @Synchronized
    private fun fileForId(documentId: String): File {
        val path = idToPath[documentId] ?: run {
            unknownIdQueries += documentId
            throw FileNotFoundException("Unknown opaque documentId: $documentId")
        }
        return File(path)
    }

    @Synchronized
    private fun rotateSubtreeIds(oldCanonicalRoot: String, newRoot: File) {
        val newCanonicalRoot = newRoot.canonicalPath
        val affected = idToPath.entries.filter { (_, path) ->
            path == oldCanonicalRoot || path.startsWith(oldCanonicalRoot + File.separator)
        }
        for ((oldId, _) in affected) {
            idToPath.remove(oldId)
        }
        val stalePaths = pathToId.keys.filter { path ->
            path == oldCanonicalRoot || path.startsWith(oldCanonicalRoot + File.separator)
        }
        stalePaths.forEach(pathToId::remove)
        if (newRoot.exists()) {
            newRoot.walkTopDown().forEach { f ->
                val freshId = "opaque:rotated-${nextSeq++}"
                val canonical = f.canonicalPath
                idToPath[freshId] = canonical
                pathToId[canonical] = freshId
                grantPermissions(treeUriForDocId(freshId))
            }
        } else {
            val freshId = "opaque:rotated-${nextSeq++}"
            idToPath[freshId] = newCanonicalRoot
            pathToId[newCanonicalRoot] = freshId
            grantPermissions(treeUriForDocId(freshId))
        }
    }

    private fun enforceGrantMode(uri: Uri) {
        if (rejectPlainDocumentUris && !DocumentsContract.isTreeUri(uri)) {
            throw SecurityException("Direct grant expired for plain document URI: $uri")
        }
    }

    private fun treeUriForDocId(docId: String): Uri {
        val tree = DocumentsContract.buildTreeDocumentUri(attachedAuthority, ROOT_ID)
        return DocumentsContract.buildDocumentUriUsingTree(tree, docId)
    }

    private fun mimeFor(file: File): String =
        if (file.isDirectory) Document.MIME_TYPE_DIR
        else when (file.extension.lowercase()) {
            "smd" -> "application/vnd.supermd.smd"
            "fmd" -> "application/vnd.supermd.fmd"
            "md", "markdown" -> "text/markdown"
            "txt" -> "text/plain"
            else -> "application/octet-stream"
        }

    private fun includeFile(cursor: MatrixCursor, file: File) {
        if (!file.exists()) throw FileNotFoundException(file.path)
        val flags = if (file.isDirectory) {
            Document.FLAG_DIR_SUPPORTS_CREATE or Document.FLAG_SUPPORTS_RENAME
        } else {
            Document.FLAG_SUPPORTS_WRITE or Document.FLAG_SUPPORTS_RENAME
        }
        val docId = idForFile(file)
        val cols = cursor.columnNames
        val row = arrayOfNulls<Any>(cols.size)
        val displayName = if (file.canonicalPath == rootDir.canonicalPath) "OpaqueWorkspace" else file.name
        val size = if (file.isFile) file.length() else 0L
        for (i in cols.indices) {
            row[i] = when (cols[i]) {
                Document.COLUMN_DOCUMENT_ID -> docId
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
        enforceGrantMode(uri)
        val cols = projection ?: DEFAULT_DOC_PROJECTION
        val segments = uri.pathSegments
        if (segments.lastOrNull() == "children" && segments.size >= 2) {
            val parentDocId = Uri.decode(segments[segments.size - 2])
            val parent = fileForId(parentDocId)
            if (!parent.isDirectory) throw FileNotFoundException(parentDocId)
            return MatrixCursor(cols).also { cursor ->
                parent.listFiles()?.forEach { child -> includeFile(cursor, child) }
            }
        }
        val docId = DocumentsContract.getDocumentId(uri)
        val file = fileForId(docId)
        return MatrixCursor(cols).also { includeFile(it, file) }
    }

    override fun getType(uri: Uri): String {
        enforceGrantMode(uri)
        val docId = runCatching { DocumentsContract.getDocumentId(uri) }.getOrNull() ?: return Document.MIME_TYPE_DIR
        val file = runCatching { fileForId(docId) }.getOrNull() ?: return "application/octet-stream"
        return mimeFor(file)
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0

    override fun call(method: String, arg: String?, extras: Bundle?): Bundle {
        val inExtras = extras ?: Bundle.EMPTY
        val docUri = inExtras.getParcelable("uri", Uri::class.java)
        if (docUri != null) enforceGrantMode(docUri)
        val out = Bundle()
        when (method) {
            "android:createDocument" -> {
                val parentId = DocumentsContract.getDocumentId(requireNotNull(docUri))
                val mimeType = inExtras.getString(Document.COLUMN_MIME_TYPE).orEmpty()
                val displayName = requireNotNull(inExtras.getString(Document.COLUMN_DISPLAY_NAME))
                val parent = fileForId(parentId)
                if (!parent.isDirectory) throw FileNotFoundException(parentId)
                val target = File(parent, displayName)
                if (mimeType == Document.MIME_TYPE_DIR) {
                    check(target.mkdirs() || target.isDirectory) { "Could not mkdir $target" }
                } else {
                    check(target.createNewFile()) { "Could not create $target" }
                }
                val newId = idForFile(target)
                val outUri = treeUriForDocId(newId)
                grantPermissions(outUri)
                out.putParcelable("uri", outUri)
            }
            "android:renameDocument" -> {
                val docId = DocumentsContract.getDocumentId(requireNotNull(docUri))
                val displayName = requireNotNull(inExtras.getString(Document.COLUMN_DISPLAY_NAME))
                val source = fileForId(docId)
                if (!source.exists()) throw FileNotFoundException(docId)
                val oldCanonical = source.canonicalPath
                val wasDir = source.isDirectory
                val dest = File(source.parentFile, displayName)
                check(source.renameTo(dest)) { "Rename failed" }
                val newId = if (wasDir) {
                    rotateSubtreeIds(oldCanonical, dest)
                    idForFile(dest)
                } else {
                    synchronized(this) {
                        idToPath.remove(docId)
                        pathToId.remove(oldCanonical)
                        idForFile(dest)
                    }
                }
                val outUri = treeUriForDocId(newId)
                grantPermissions(outUri)
                out.putParcelable("uri", outUri)
            }
            "android:deleteDocument" -> {
                val docId = DocumentsContract.getDocumentId(requireNotNull(docUri))
                val target = fileForId(docId)
                val oldCanonical = target.canonicalPath
                if (target.exists()) {
                    target.deleteRecursively()
                }
                synchronized(this) {
                    idToPath.remove(docId)
                    pathToId.remove(oldCanonical)
                }
            }
        }
        return out
    }

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        enforceGrantMode(uri)
        val docId = DocumentsContract.getDocumentId(uri)
        val file = fileForId(docId)
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
        appContext.grantUriPermission(
            appContext.packageName,
            docUri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION or
                Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                Intent.FLAG_GRANT_PREFIX_URI_PERMISSION,
        )
    }

    companion object {
        const val ROOT_ID = "opaque:root-0"
        const val UNLISTED_PREFIXED_ID = "opaque:root-0/outside-secret.md"
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
