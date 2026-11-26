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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isPopup
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
    fun unicodeCaseNormalizationAndSurrogateUtf16OffsetsHighlightExactSourceSpans() = runBlocking {
        val app = RuntimeEnvironment.getApplication()
        val media = MediaStorage(app)

        val folded = foldWithOffsets("İstanbul: note")
        assertEquals("i\u0307stanbul: note", folded.text)
        assertEquals(0, folded.starts[0])
        assertEquals(0, folded.starts[1])
        assertEquals(1, folded.ends[1])

        val longPrefix = "İstanbul 📓 ".repeat(8)
        val content = listOf(
            "İstanbul: note",
            "📓 note",
            "İstanbul 📓: NOTE",
            "Straße: note",
            "${longPrefix}target NOTE after unicode prefix " + "x".repeat(90),
        ).joinToString("\n")

        val openTab = Note(
            id = "tab-unicode",
            name = "unicode.md",
            content = content,
            saved = content,
        )
        val result = streamTextSearch(
            query = "note",
            tabs = listOf(openTab),
            recents = emptyList(),
            folderRoot = null,
            media = media,
            openUriStream = { null },
            caseSensitive = false,
        )
        assertEquals(listOf(1, 2, 3, 4, 5), result.matches.map { it.line })

        val (istanbul, emoji, both, strasse, longMatch) = result.matches
        assertEquals("İstanbul: note", istanbul.snippet)
        assertEquals(10, istanbul.matchStart)
        assertEquals(14, istanbul.matchEnd)
        assertEquals("note", istanbul.snippet.substring(istanbul.matchStart, istanbul.matchEnd))

        assertEquals("📓 note", emoji.snippet)
        assertEquals(3, emoji.matchStart)
        assertEquals(7, emoji.matchEnd)
        assertEquals("note", emoji.snippet.substring(emoji.matchStart, emoji.matchEnd))

        assertEquals("İstanbul 📓: NOTE", both.snippet)
        assertEquals(13, both.matchStart)
        assertEquals(17, both.matchEnd)
        assertEquals("NOTE", both.snippet.substring(both.matchStart, both.matchEnd))

        assertEquals("Straße: note", strasse.snippet)
        assertEquals(8, strasse.matchStart)
        assertEquals(12, strasse.matchEnd)
        assertEquals("note", strasse.snippet.substring(strasse.matchStart, strasse.matchEnd))

        assertEquals("NOTE", longMatch.snippet.substring(longMatch.matchStart, longMatch.matchEnd))
        for (m in result.matches) {
            val annotated = buildHighlightedSnippet(m.snippet, m.matchStart, m.matchEnd, Color.Blue)
            assertEquals(1, annotated.spanStyles.size)
            val span = annotated.spanStyles.single()
            assertEquals(
                m.snippet.substring(m.matchStart, m.matchEnd).lowercase(),
                annotated.text.substring(span.start, span.end).lowercase(),
            )
        }

        val caseSensitiveRes = streamTextSearch(
            query = "note",
            tabs = listOf(openTab),
            recents = emptyList(),
            folderRoot = null,
            media = media,
            openUriStream = { null },
            caseSensitive = true,
        )
        assertEquals(listOf(1, 2, 4), caseSensitiveRes.matches.map { it.line })
        assertEquals(10 to 14, caseSensitiveRes.matches[0].let { it.matchStart to it.matchEnd })
        assertEquals(3 to 7, caseSensitiveRes.matches[1].let { it.matchStart to it.matchEnd })

        val emojiQueryRes = streamTextSearch(
            query = "📓",
            tabs = listOf(openTab),
            recents = emptyList(),
            folderRoot = null,
            media = media,
            openUriStream = { null },
            caseSensitive = false,
        )
        assertEquals("📓", emojiQueryRes.matches.first().let { it.snippet.substring(it.matchStart, it.matchEnd) })
    }

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
            File(tempRoot, "disguised-bundle.txt").writeBytes(smdFile.readBytes())
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
    fun dotfilesSymlinksSkippedNoFolderFallbackAndImmediateCoroutineCancellation() = runBlocking {
        val app = RuntimeEnvironment.getApplication()
        val media = MediaStorage(app)
        val tempRoot = Files.createTempDirectory("supermd-android-cancel-").toFile()
        val externalDir = Files.createTempDirectory("supermd-android-ext-").toFile()
        try {
            File(tempRoot, ".hidden").apply { mkdirs(); File(this, "secret.md").writeText("HiddenSecret") }
            File(tempRoot, ".dotnote.md").writeText("HiddenSecret")
            val externalTarget = File(externalDir, "symlink.md").apply { writeText("HiddenSecret") }
            Files.createSymbolicLink(File(tempRoot, "linked.md").toPath(), externalTarget.toPath())

            val snapshotBefore = tempRoot.walkTopDown().map { it.relativeTo(tempRoot).path }.sorted().toList()
            val hiddenRes = streamTextSearch(
                query = "HiddenSecret",
                tabs = emptyList(),
                recents = emptyList(),
                folderRoot = resolveSearchRoot(app, Uri.fromFile(tempRoot)),
                media = media,
                openUriStream = { uri -> File(uri.path!!).inputStream() },
            )
            val snapshotAfter = tempRoot.walkTopDown().map { it.relativeTo(tempRoot).path }.sorted().toList()
            assertTrue(hiddenRes.matches.isEmpty())
            assertEquals("Search must write zero cached index files", snapshotBefore, snapshotAfter)

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
            externalDir.deleteRecursively()
        }
    }

    @Test
    fun viewModelSearchMatchSeedsFindAndOpensNote() = runBlocking {
        val app = RuntimeEnvironment.getApplication()
        val tempRoot = Files.createTempDirectory("supermd-android-vm-").toFile()
        val sub = File(tempRoot, "notes/sub").apply { mkdirs() }
        File(sub, "target.md").apply {
            writeText("# Target\n\nUniqueSeedPhrase appears here.\n")
        }
        app.getSharedPreferences("studio-window-search-vm-test", 0)
            .edit()
            .putBoolean("folderMigrated", true)
            .putString("folder", Uri.fromFile(tempRoot).toString())
            .commit()
        val vm = StudioViewModel(app, "search-vm-test")
        try {
            val deadline = System.currentTimeMillis() + 5_000
            assertEquals(Uri.fromFile(tempRoot).toString(), vm.state.value.folder)

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
    fun composeChromeDrawerAndFolderSearchModalRenderHighlightedMatches() {
        var menuOpen by mutableStateOf(false)
        var modalOpen by mutableStateOf(true)
        var folderSearchClicks = 0
        var selectedMatch: FolderSearchMatch? = null
        val state = StudioState(
            folder = "content://folder/root",
            files = listOf(FileEntry("modern", "content://folder/modern", directory = true, relative = "physics/modern")),
        )
        val searchState = FolderSearchState(
            visible = true,
            query = "note",
            matches = listOf(
                FolderSearchMatch(
                    key = "u1",
                    tabId = "t1",
                    uri = null,
                    name = "unicode.md",
                    relative = "unicode.md",
                    line = 1,
                    column = 11,
                    snippet = "İstanbul: note",
                    matchStart = 10,
                    matchEnd = 14,
                    dirty = true,
                    isOpen = true,
                ),
                FolderSearchMatch(
                    key = "u2",
                    tabId = "t1",
                    uri = null,
                    name = "unicode.md",
                    relative = "unicode.md",
                    line = 2,
                    column = 4,
                    snippet = "📓 note",
                    matchStart = 3,
                    matchEnd = 7,
                    dirty = false,
                    isOpen = true,
                ),
            ),
            scannedFiles = 1,
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
                            onOpenNote = {},
                            onOpenFolder = {},
                            onCloseFolder = {},
                            onFolderRoot = {},
                            onFolderSearch = { folderSearchClicks++ },
                            onActivateEntry = {},
                            onClearRecent = {},
                            onOpenRecent = {},
                            onPinRecent = {},
                        )
                    }
                    if (modalOpen) {
                        FolderSearchModal(
                            state = searchState,
                            hasFolder = true,
                            onUpdate = { _, _, _ -> },
                            onSelect = { selectedMatch = it },
                            onDismiss = { modalOpen = false },
                        )
                    }
                }
            }
        }

        composeRule.onNodeWithText("İstanbul: note").assertIsDisplayed()
        composeRule.onNodeWithText("📓 note").performClick()
        assertEquals("u2", selectedMatch?.key)
        composeRule.onNodeWithText("Close").performClick()
        assertFalse(modalOpen)

        composeRule.onNode(hasText("Search across notes") and hasClickAction()).assertIsDisplayed().assertHeightIsAtLeast(48.dp).performClick()
        assertEquals(1, folderSearchClicks)

        // Search across notes is not duplicated inside StudioTopBar or More actions overflow menu
        composeRule.onNodeWithContentDescription("More actions").performClick()
        composeRule.onNodeWithText("Settings").assertIsDisplayed()
        assertEquals(0, composeRule.onAllNodes(hasText("Search across notes") and hasAnyAncestor(isPopup())).fetchSemanticsNodes().size)
    }
}
