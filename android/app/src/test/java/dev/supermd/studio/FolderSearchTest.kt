package dev.supermd.studio

import android.net.Uri
import android.os.Looper
import android.util.Base64
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class FolderSearchTest {
    @get:Rule val composeRule = createComposeRule()

    @Test
    fun portableBundlesDetectedByContentWithoutDecodingOrExtractingImages() = runBlocking {
        val app = RuntimeEnvironment.getApplication()
        val media = MediaStorage(app)
        val portableDirsRoot = File(app.filesDir, "portable-assets")
        val beforePortableDirs = portableDirsRoot.list()?.toSet().orEmpty()

        val tempRoot = Files.createTempDirectory("supermd-android-search-").toFile()
        try {
            val svgBytes = "<svg xmlns='http://www.w3.org/2000/svg'><circle r='4'/></svg>".toByteArray()
            val validAssets = JSONObject().put(
                "assets/diagram.svg",
                "data:image/svg+xml;base64," + Base64.encodeToString(svgBytes, Base64.NO_WRAP),
            )
            val smdOut = ByteArrayOutputStream()
            media.writeFmd(smdOut, "# Experiment\n\nObserved MuonLifetime clearly.\n", validAssets)

            val smdFile = File(tempRoot, "experiment.smd").apply { writeBytes(smdOut.toByteArray()) }
            // Gzipped portable bundle disguised with a .txt extension must still be detected by content.
            File(tempRoot, "disguised-bundle.txt").writeBytes(smdFile.readBytes())
            // Plain JSON portable envelope whose asset payload would fail Base64/image validation if decoded.
            File(tempRoot, "legacy.fmd").writeText(
                JSONObject()
                    .put("format", "supermd-fmd")
                    .put("version", 1)
                    .put("markdown", "# Legacy\n\nObserved MuonLifetime in legacy envelope.\n")
                    .put("assets", JSONObject().put("assets/broken.png", "data:image/png;base64,NOT_DECODED!!!"))
                    .toString(),
                Charsets.UTF_8,
            )

            val rootNode = resolveSearchRoot(app, Uri.fromFile(tempRoot))
            val result = streamTextSearch(
                query = "MuonLifetime",
                tabs = emptyList(),
                recents = emptyList(),
                folderRoot = rootNode,
                media = media,
                openUriStream = { uri -> File(uri.path!!).inputStream() },
            )

            val afterPortableDirs = portableDirsRoot.list()?.toSet().orEmpty()
            assertEquals("Portable search must never extract image directories to disk", beforePortableDirs, afterPortableDirs)
            assertEquals(
                mapOf(
                    "disguised-bundle.txt" to 3,
                    "experiment.smd" to 3,
                    "legacy.fmd" to 3,
                ),
                result.matches.associate { it.name to it.line },
            )
        } finally {
            tempRoot.deleteRecursively()
        }
    }

    @Test
    fun liveDirtyTabOverridesDiskAndDiagramsAreSkippedByDefault() = runBlocking {
        val app = RuntimeEnvironment.getApplication()
        val media = MediaStorage(app)
        val tempRoot = Files.createTempDirectory("supermd-android-live-").toFile()
        try {
            val diskNote = File(tempRoot, "draft.md").apply {
                writeText("# Disk\n\nStaleDiskOnlyPhrase\n", Charsets.UTF_8)
            }
            val liveContent = listOf(
                "# Live Draft",
                "Inline <svg width='12' height='12'><text>LiveToken</text></svg> prose.",
                "```mermaid",
                "graph TD",
                "  A[LiveToken] --> B",
                "```",
                "```smd-chart",
                "{\"title\":\"LiveToken\",\"series\":[]}",
                "```",
                "Real prose LiveToken on line 10.",
            ).joinToString("\n")

            val openTab = Note(
                id = "tab-live",
                name = "draft.md",
                uri = Uri.fromFile(diskNote).toString(),
                content = liveContent,
                saved = "# Disk\n\nStaleDiskOnlyPhrase\n",
                relative = "draft.md",
            )
            val rootNode = resolveSearchRoot(app, Uri.fromFile(tempRoot))

            val staleSearch = streamTextSearch(
                query = "StaleDiskOnlyPhrase",
                tabs = listOf(openTab),
                recents = emptyList(),
                folderRoot = rootNode,
                media = media,
                openUriStream = { uri -> File(uri.path!!).inputStream() },
            )
            assertTrue("Live open tab must shadow older disk bytes", staleSearch.matches.isEmpty())

            val proseOnly = streamTextSearch(
                query = "LiveToken",
                tabs = listOf(openTab),
                recents = emptyList(),
                folderRoot = rootNode,
                media = media,
                openUriStream = { uri -> File(uri.path!!).inputStream() },
                excludeDiagrams = true,
            )
            assertEquals(listOf(10), proseOnly.matches.map { it.line })
            assertTrue(proseOnly.matches.single().dirty)

            val withDiagrams = streamTextSearch(
                query = "LiveToken",
                tabs = listOf(openTab),
                recents = emptyList(),
                folderRoot = rootNode,
                media = media,
                openUriStream = { uri -> File(uri.path!!).inputStream() },
                excludeDiagrams = false,
            )
            assertEquals(listOf(2, 5, 8, 10), withDiagrams.matches.map { it.line })
        } finally {
            tempRoot.deleteRecursively()
        }
    }

    @Test
    fun quickSwitcherWorksWithZeroOpenTabsShowsPinnedRecentFirstAndFuzzyRanksInThreeKeys() = runBlocking {
        val app = RuntimeEnvironment.getApplication()
        assertEquals("", StudioState(tabs = emptyList()).active.id)

        val tempRoot = Files.createTempDirectory("supermd-android-qs-").toFile()
        try {
            val nestedDir = File(tempRoot, "courses/spring").apply { mkdirs() }
            val pinnedFile = File(tempRoot, "pinned.md").apply { writeText("# Pinned\n") }
            val recentFile = File(tempRoot, "recent.md").apply { writeText("# Recent\n") }
            val lectureFile = File(nestedDir, "QuantumMechanicsLecture.smd").apply { writeText("# QML\n") }

            val recents = listOf(
                RecentNote("recent.md", Uri.fromFile(recentFile).toString(), "recent.md", pinned = false),
                RecentNote("pinned.md", Uri.fromFile(pinnedFile).toString(), "pinned.md", pinned = true),
            )
            val rootNode = resolveSearchRoot(app, Uri.fromFile(tempRoot))

            val emptyQuery = rankQuickSwitcher("", emptyList(), recents, rootNode)
            assertEquals(listOf("pinned.md", "recent.md", "QuantumMechanicsLecture.smd"), emptyQuery.map { it.name })
            assertTrue(emptyQuery.first().pinned)

            val fuzzy = rankQuickSwitcher("qml", emptyList(), recents, rootNode)
            assertTrue(fuzzy.isNotEmpty())
            assertEquals("QuantumMechanicsLecture.smd", fuzzy.first().name)
            assertEquals("courses/spring/QuantumMechanicsLecture.smd", fuzzy.first().relative)
        } finally {
            tempRoot.deleteRecursively()
        }
    }

    @Test
    fun recursiveDrawerFilterSkipsDotfilesSymlinksEmptyFoldersAndWritesZeroDiskIndex() = runBlocking {
        val app = RuntimeEnvironment.getApplication()
        val tempRoot = Files.createTempDirectory("supermd-android-filter-").toFile()
        val externalDir = Files.createTempDirectory("supermd-android-ext-").toFile()
        try {
            File(tempRoot, "empty_a/empty_b").mkdirs()
            File(tempRoot, "unmatched").apply { mkdirs(); File(this, "other.md").writeText("# Other") }
            File(tempRoot, ".hidden").apply { mkdirs(); File(this, "relativity-secret.md").writeText("# Hidden") }
            File(tempRoot, ".relativity-dotfile.md").writeText("# Hidden dotfile")
            val externalTarget = File(externalDir, "relativity-symlink.md").apply { writeText("# External") }
            Files.createSymbolicLink(File(tempRoot, "relativity-symlink.md").toPath(), externalTarget.toPath())

            val deepDir = File(tempRoot, "physics/modern").apply { mkdirs() }
            File(deepDir, "relativity-summary.txt").writeText("Special relativity notes")

            val snapshotBefore = tempRoot.walkTopDown().map { it.relativeTo(tempRoot).path }.sorted().toList()
            val rootNode = resolveSearchRoot(app, Uri.fromFile(tempRoot))
            val filtered = filterFolderEntries(rootNode, "relativity")
            val snapshotAfter = tempRoot.walkTopDown().map { it.relativeTo(tempRoot).path }.sorted().toList()

            assertEquals("Search/filter must write zero cached index files", snapshotBefore, snapshotAfter)
            assertEquals(1, filtered.size)
            assertFalse("Filtered results must contain zero directory rows", filtered.any { it.directory })
            assertEquals("relativity-summary.txt", filtered.single().name)
            assertEquals("physics/modern/relativity-summary.txt", filtered.single().relative)
        } finally {
            tempRoot.deleteRecursively()
            externalDir.deleteRecursively()
        }
    }

    @Test
    fun parentRelativePathStepsUpOneLevelAlongsideFolderRoot() {
        assertEquals("courses/spring", parentRelativePath("courses/spring/week1"))
        assertEquals("courses", parentRelativePath("courses/spring"))
        assertEquals("", parentRelativePath("courses"))
        assertEquals("", parentRelativePath(""))
    }

    @Test
    fun noFolderFallbackAndImmediateCoroutineCancellation() = runBlocking {
        val app = RuntimeEnvironment.getApplication()
        val media = MediaStorage(app)
        val tempRoot = Files.createTempDirectory("supermd-android-cancel-").toFile()
        try {
            val recentNote = File(tempRoot, "recent-note.md").apply {
                writeText("# Recent\n\nNoFolderNeedle inside recent note.\n")
            }
            val noFolderRes = streamTextSearch(
                query = "NoFolderNeedle",
                tabs = listOf(Note(id = "t1", name = "Draft.md", content = "NoFolderNeedle in draft", saved = "")),
                recents = listOf(
                    RecentNote("recent-note.md", Uri.fromFile(recentNote).toString(), pinned = true),
                    RecentNote("inaccessible.md", "content://missing.authority/doc/1", pinned = false),
                ),
                folderRoot = null,
                media = media,
                openUriStream = { uri ->
                    if (uri.scheme == "file") File(uri.path!!).inputStream()
                    else throw SecurityException("No SAF grant")
                },
            )
            assertEquals(setOf("Draft.md", "recent-note.md"), noFolderRes.matches.map { it.name }.toSet())

            // Populate 60 files and cancel the coroutine as soon as the first streamed batch arrives.
            for (i in 0 until 60) {
                File(tempRoot, "batch_%03d.md".format(i)).writeText("Line $i CancelTarget\n")
            }
            val firstBatchSeen = CompletableDeferred<Int>()
            var scannedAtCancel = 60
            val job = launch(Dispatchers.Default) {
                try {
                    streamTextSearch(
                        query = "CancelTarget",
                        tabs = emptyList(),
                        recents = emptyList(),
                        folderRoot = resolveSearchRoot(app, Uri.fromFile(tempRoot)),
                        media = media,
                        openUriStream = { uri -> File(uri.path!!).inputStream() },
                        onBatch = { batch, scanned, _, _ ->
                            scannedAtCancel = scanned
                            if (batch.isNotEmpty() && !firstBatchSeen.isCompleted) {
                                firstBatchSeen.complete(batch.size)
                                delay(250)
                            }
                        },
                    )
                } catch (cancelled: CancellationException) {
                    throw cancelled
                }
            }
            assertTrue(firstBatchSeen.await() > 0)
            job.cancelAndJoin()
            assertTrue("Cancellation must stop scan before reading all 60 files (scanned $scannedAtCancel)", scannedAtCancel < 60)
        } finally {
            tempRoot.deleteRecursively()
        }
    }

    @Test
    fun viewModelSearchMatchSeedsFindAndOpensNote() = runBlocking {
        val app = RuntimeEnvironment.getApplication()
        val tempRoot = Files.createTempDirectory("supermd-android-vm-").toFile()
        val vm = StudioViewModel(app, "search-vm-test")
        try {
            val sub = File(tempRoot, "notes/sub").apply { mkdirs() }
            val noteFile = File(sub, "target.md").apply {
                writeText("# Target\n\nUniqueSeedPhrase appears here.\n")
            }
            vm.setFolder(Uri.fromFile(tempRoot))

            val deadline = System.currentTimeMillis() + 5_000
            while (vm.state.value.files.isEmpty() && System.currentTimeMillis() < deadline) {
                shadowOf(Looper.getMainLooper()).idle()
                delay(20)
            }
            assertEquals("notes", vm.state.value.files.single().name)

            vm.openFolderSearch("UniqueSeedPhrase")
            while ((vm.folderSearch.value.scanning || vm.folderSearch.value.matches.isEmpty()) && System.currentTimeMillis() < deadline) {
                shadowOf(Looper.getMainLooper()).idle()
                delay(20)
            }
            assertEquals(1, vm.folderSearch.value.matches.size)
            val match = vm.folderSearch.value.matches.single()
            assertEquals(3, match.line)

            vm.openSearchMatch(match)
            while (vm.state.value.active.name != "target.md" && System.currentTimeMillis() < deadline) {
                shadowOf(Looper.getMainLooper()).idle()
                delay(20)
            }
            assertFalse(vm.folderSearch.value.visible)
            assertEquals("target.md", vm.state.value.active.name)
            val seed = vm.seededFind.value
            assertNotNull(seed)
            assertEquals("UniqueSeedPhrase", seed!!.query)
            assertTrue(vm.activeMatchesSeedTarget(vm.state.value.active, seed))
        } finally {
            vm.cancelWorkspaceSearch()
            tempRoot.deleteRecursively()
        }
    }

    @Test
    fun composeChromeAndDrawerExposeQuickSwitcherFolderSearchFilterAndParentNavigation() {
        var menuOpen by mutableStateOf(false)
        var quickSwitcherClicks = 0
        var folderSearchClicks = 0
        var parentClicks = 0
        var rootClicks = 0
        var filterText by mutableStateOf("")
        val filtered = listOf(
            FileEntry("relativity-summary.md", "content://folder/rel", directory = false, relative = "physics/modern/relativity-summary.md"),
        )
        val state = StudioState(
            folder = "content://folder/root",
            files = listOf(FileEntry("modern", "content://folder/modern", directory = true, relative = "physics/modern")),
        )

        composeRule.setContent {
            MaterialTheme {
                Surface(Modifier.width(360.dp).height(800.dp)) {
                    Column {
                        StudioTopBar(
                            noteName = "Notes.md",
                            statusLabel = "Saved",
                            fullscreen = false,
                            wide = false,
                            actualMode = "reader",
                            centerLock = true,
                            readerReady = true,
                            busy = false,
                            menuExpanded = menuOpen,
                            onMenuExpandedChange = { menuOpen = it },
                            onNavigateIcon = {},
                            onQuickSwitcher = { quickSwitcherClicks++ },
                            onFolderSearch = { folderSearchClicks++ },
                            onFind = {},
                            onSave = {},
                            onExport = {},
                            onToggleFullscreen = {},
                            onToggleCenterLock = {},
                            onNewWindow = {},
                            onShare = {},
                            onInsertMedia = {},
                            onFixLatex = {},
                            onRename = {},
                            onSettings = {},
                        )
                        FilesDrawerContent(
                            state = state,
                            recent = emptyList(),
                            folderRelative = "physics/modern",
                            drawerFilter = filterText,
                            onDrawerFilterChange = { filterText = it },
                            filteredFiles = filtered,
                            drawerFiltering = false,
                            onOpenNote = {},
                            onOpenFolder = {},
                            onCloseFolder = {},
                            onParentFolder = { parentClicks++ },
                            onFolderRoot = { rootClicks++ },
                            onQuickSwitcher = { quickSwitcherClicks++ },
                            onFolderSearch = { folderSearchClicks++ },
                            onActivateEntry = {},
                            onClearRecent = {},
                            onOpenRecent = {},
                            onPinRecent = {},
                        )
                    }
                }
            }
        }

        // TopBar overflow menu includes Quick switcher and Search across notes
        composeRule.onNodeWithContentDescription("More actions").performClick()
        composeRule.onNodeWithText("Quick switcher").assertIsDisplayed().performClick()
        assertEquals(1, quickSwitcherClicks)
        composeRule.onNodeWithContentDescription("More actions").performClick()
        composeRule.onNodeWithText("Search across notes").assertIsDisplayed().performClick()
        assertEquals(1, folderSearchClicks)

        // FilesDrawerContent exposes Switch, Search, Parent folder, and Folder root >= 48dp
        composeRule.onNode(hasText("Switch") and hasClickAction()).assertIsDisplayed().assertHeightIsAtLeast(48.dp).performClick()
        assertEquals(2, quickSwitcherClicks)
        composeRule.onNode(hasText("Search") and hasClickAction()).assertIsDisplayed().assertHeightIsAtLeast(48.dp).performClick()
        assertEquals(2, folderSearchClicks)
        composeRule.onNode(hasText("Parent folder") and hasClickAction()).assertIsDisplayed().assertHeightIsAtLeast(48.dp).performClick()
        assertEquals(1, parentClicks)
        composeRule.onNode(hasText("Folder root") and hasClickAction()).assertIsDisplayed().assertHeightIsAtLeast(48.dp).performClick()
        assertEquals(1, rootClicks)

        // Filtering swaps directory listing for nested matching files with relative path subtitle
        composeRule.runOnIdle { filterText = "relativity" }
        composeRule.onNodeWithText("relativity-summary.md").assertIsDisplayed().assertHeightIsAtLeast(48.dp)
        composeRule.onNodeWithText("physics/modern/relativity-summary.md").assertIsDisplayed()
        composeRule.onAllNodes(hasText("Parent folder")).also { assertEquals(0, it.fetchSemanticsNodes().size) }
    }
}
