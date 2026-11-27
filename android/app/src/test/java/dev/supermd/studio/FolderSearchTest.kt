package dev.supermd.studio

import android.net.Uri
import android.os.Looper
import android.provider.DocumentsContract
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
            assertNotNull(seed.sourceStart)
            assertNotNull(seed.sourceEnd)
            assertEquals("UniqueSeedPhrase", vm.state.value.active.content.substring(seed.sourceStart!!, seed.sourceEnd!!))
            assertTrue(vm.activeMatchesSeedTarget(vm.state.value.active, seed))
        } finally {
            vm.cancelWorkspaceSearch()
            tempRoot.deleteRecursively()
        }
    }

    @Test
    fun repeatedMatchesAndUnicodeOffsetsPreservedThroughAndroidHandoff() = runBlocking {
        val app = RuntimeEnvironment.getApplication()
        val media = MediaStorage(app)
        val tempRoot = Files.createTempDirectory("supermd-android-occurrence-").toFile()
        val crlfContent = listOf(
            "# İstanbul \uD83D\uDCD3 Lab",
            "First AuroraSignal and second \uD83D\uDCD3 AuroraSignal on same CRLF line.",
            "Straße precedes [hidden](https://example.com/AuroraSignal) and fourth AURORASIGNAL.",
        ).joinToString("\r\n")
        val targetFile = File(tempRoot, "unicode-repeats.md").apply {
            writeBytes(crlfContent.toByteArray(Charsets.UTF_8))
        }
        app.getSharedPreferences("studio-window-search-occurrence-test", 0)
            .edit()
            .putBoolean("folderMigrated", true)
            .putString("folder", Uri.fromFile(tempRoot).toString())
            .commit()
        val vm = StudioViewModel(app, "search-occurrence-test")
        try {
            val direct = streamTextSearch(
                query = "aurorasignal",
                tabs = emptyList(),
                recents = emptyList(),
                folderRoot = resolveSearchRoot(app, Uri.fromFile(tempRoot)),
                media = media,
                openUriStream = { uri -> File(uri.path!!).inputStream() },
                caseSensitive = false,
            )
            assertEquals(4, direct.matches.size)
            assertEquals(
                listOf("AuroraSignal", "AuroraSignal", "AuroraSignal", "AURORASIGNAL"),
                direct.matches.map { crlfContent.substring(it.sourceStart, it.sourceEnd) },
            )
            assertEquals(
                listOf("AuroraSignal", "AuroraSignal", "AuroraSignal", "AURORASIGNAL"),
                direct.matches.map { it.matchText },
            )
            assertTrue(direct.matches.zipWithNext().all { (a, b) -> a.sourceEnd <= b.sourceStart })

            // Case-insensitive "strasse" folds "Straße" while preserving exact UTF-16 offsets in source.
            val strasseHits = streamTextSearch(
                query = "strasse",
                tabs = emptyList(),
                recents = emptyList(),
                folderRoot = resolveSearchRoot(app, Uri.fromFile(tempRoot)),
                media = media,
                openUriStream = { uri -> File(uri.path!!).inputStream() },
                caseSensitive = false,
            )
            assertEquals(1, strasseHits.matches.size)
            val strasseMatch = strasseHits.matches.single()
            assertEquals("Straße", crlfContent.substring(strasseMatch.sourceStart, strasseMatch.sourceEnd))
            assertEquals("Straße", strasseMatch.matchText)

            // Handoff of the 2nd repeated match preserves its exact occurrence offsets and matchText on seededFind.
            val deadline = System.currentTimeMillis() + 5_000
            vm.openFolderSearch("AuroraSignal")
            while ((vm.folderSearch.value.scanning || vm.folderSearch.value.matches.size < 4) && System.currentTimeMillis() < deadline) {
                shadowOf(Looper.getMainLooper()).idle()
                delay(20)
            }
            assertEquals(4, vm.folderSearch.value.matches.size)
            val secondMatch = vm.folderSearch.value.matches[1]
            vm.openSearchMatch(secondMatch)
            while (vm.state.value.active.name != targetFile.name && System.currentTimeMillis() < deadline) {
                shadowOf(Looper.getMainLooper()).idle()
                delay(20)
            }
            val seed = vm.seededFind.value
            assertNotNull(seed)
            assertEquals(secondMatch.sourceStart, seed!!.sourceStart)
            assertEquals(secondMatch.sourceEnd, seed.sourceEnd)
            assertEquals("AuroraSignal", seed.matchText)
            assertTrue(seed.sourceStart!! > direct.matches[0].sourceEnd)
            assertEquals("AuroraSignal", vm.state.value.active.content.substring(seed.sourceStart!!, seed.sourceEnd!!))
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

        composeRule.onNodeWithContentDescription("More actions").performClick()
        composeRule.onNode(hasText("Search across notes") and hasAnyAncestor(isPopup())).assertIsDisplayed().performClick()
        assertEquals(2, folderSearchClicks)
    }

    @Test
    fun safDeduplicationAndOrderPreservingBenchmarkMaintainExactOrderAndStatelessFreshness() = runBlocking {
        val app = RuntimeEnvironment.getApplication()
        val media = MediaStorage(app)
        val authority = "dev.supermd.test.saf.documents"
        val treeUri = DocumentsContract.buildTreeDocumentUri(authority, "primary:Notes")

        val treeDocUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, "primary:Notes/topic_00/note_07.md")
        val plainDocUri = DocumentsContract.buildDocumentUri(authority, "primary:Notes/topic_00/note_07.md")
        val otherDocUri = DocumentsContract.buildDocumentUri(authority, "primary:Notes/topic_00/note_08.md")
        val otherAuthUri = DocumentsContract.buildDocumentUri("com.example.documents", "primary:Notes/topic_00/note_07.md")
        val nonDocContentUri = Uri.parse("content://com.example.custom/items/42")

        assertTrue(sameDocument(treeDocUri, plainDocUri))
        assertEquals(canonicalDocumentKey(treeDocUri), canonicalDocumentKey(plainDocUri))
        assertNotEquals(canonicalDocumentKey(treeDocUri), canonicalDocumentKey(otherDocUri))
        assertNotEquals(canonicalDocumentKey(treeDocUri), canonicalDocumentKey(otherAuthUri))
        assertNotEquals(canonicalDocumentKey(treeDocUri), canonicalDocumentKey(nonDocContentUri))
        assertEquals("uri:content://com.example.custom/items/42", canonicalDocumentKey(nonDocContentUri))

        data class SafRow(val docId: String, val name: String, val mime: String, val flags: Int = 0)

        val childrenByParent = HashMap<String, List<SafRow>>()
        val payloads = java.util.concurrent.ConcurrentHashMap<String, ByteArray>()
        val svgBytes = "<svg xmlns='http://www.w3.org/2000/svg'><circle r='3'/></svg>".toByteArray()
        val portableAssets = JSONObject().put(
            "assets/diagram.svg",
            "data:image/svg+xml;base64," + Base64.encodeToString(svgBytes, Base64.NO_WRAP),
        )

        val rootChildren = ArrayList<SafRow>(16)
        for (d in 0 until 15) {
            val dirRel = "topic_%02d".format(d)
            val dirDocId = "primary:Notes/$dirRel"
            rootChildren.add(SafRow(dirDocId, dirRel, DocumentsContract.Document.MIME_TYPE_DIR))
            val fileRows = ArrayList<SafRow>(42)
            for (f in 0 until 40) {
                val idx = d * 40 + f
                val hasMatch = (idx % 25 == 7)
                val ext = if (idx == 57) "smd" else "md"
                val fileName = "note_%02d.%s".format(f, ext)
                val docId = "$dirDocId/$fileName"
                val markdown = buildString {
                    append("# Research Note %03d — İstanbul & Straße\n\n".format(idx))
                    append("```mermaid\ngraph TD\n  A[Node$idx] --> B[QuantumEigenstate]\n```\n\n")
                    for (p in 0 until 24) {
                        if (hasMatch && (p == 6 || p == 18)) {
                            append("Paragraph $p: QuantumEigenstate observation #$idx-$p in prose.\n")
                        } else {
                            append("Paragraph $p: Standard Hamiltonian formulation with linear operators $idx-$p.\n")
                        }
                    }
                }
                val bytes = if (ext == "smd") {
                    ByteArrayOutputStream().also { media.writeFmd(it, markdown, portableAssets) }.toByteArray()
                } else {
                    markdown.toByteArray(Charsets.UTF_8)
                }
                payloads[docId] = bytes
                fileRows.add(SafRow(docId, fileName, "text/markdown"))
            }
            // Include a dotfile and a virtual document to verify SafFastNode skips both.
            fileRows.add(SafRow("$dirDocId/.hidden.md", ".hidden.md", "text/markdown"))
            fileRows.add(
                SafRow(
                    "$dirDocId/virtual.md",
                    "virtual.md",
                    "text/markdown",
                    DocumentsContract.Document.FLAG_VIRTUAL_DOCUMENT,
                ),
            )
            payloads["$dirDocId/.hidden.md"] = "QuantumEigenstate hidden".toByteArray(Charsets.UTF_8)
            payloads["$dirDocId/virtual.md"] = "QuantumEigenstate virtual".toByteArray(Charsets.UTF_8)
            childrenByParent[dirDocId] = fileRows
        }
        childrenByParent["primary:Notes"] = rootChildren

        val safProvider = object : android.content.ContentProvider() {
            override fun onCreate(): Boolean = true
            override fun query(
                uri: Uri,
                projection: Array<out String>?,
                selection: String?,
                selectionArgs: Array<out String>?,
                sortOrder: String?,
            ): android.database.Cursor {
                Thread.sleep(2L)
                val cols = projection ?: arrayOf(
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                    DocumentsContract.Document.COLUMN_MIME_TYPE,
                    DocumentsContract.Document.COLUMN_FLAGS,
                )
                val cursor = android.database.MatrixCursor(cols)
                val segs = uri.pathSegments
                val parentDocId = if (segs.size >= 5 && segs[0] == "tree" && segs[2] == "document" && segs[4] == "children") {
                    segs[3]
                } else {
                    ""
                }
                for (row in childrenByParent[parentDocId].orEmpty()) {
                    cursor.addRow(
                        cols.map { col ->
                            when (col) {
                                DocumentsContract.Document.COLUMN_DOCUMENT_ID -> row.docId
                                DocumentsContract.Document.COLUMN_DISPLAY_NAME -> row.name
                                DocumentsContract.Document.COLUMN_MIME_TYPE -> row.mime
                                DocumentsContract.Document.COLUMN_FLAGS -> row.flags
                                else -> null
                            }
                        }.toTypedArray<Any?>(),
                    )
                }
                return cursor
            }
            override fun getType(uri: Uri): String? = null
            override fun insert(uri: Uri, values: android.content.ContentValues?): Uri? = null
            override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
            override fun update(uri: Uri, values: android.content.ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0
        }
        org.robolectric.shadows.ShadowContentResolver.registerProviderInternal(authority, safProvider)
        val safRoot = resolveSearchRoot(app, treeUri)
        assertNotNull(safRoot)

        // Open dirty tab uses a PLAIN document URI while SAF tree walk emits tree-built document URIs!
        val shadowedDocId = "primary:Notes/topic_00/note_07.md"
        val openDirtyTab = Note(
            id = "tab-open-saf",
            name = "note_07.md",
            uri = DocumentsContract.buildDocumentUri(authority, shadowedDocId).toString(),
            content = "# Edited Open Tab\n\nQuantumEigenstate live override line.\n",
            saved = "# Old Saved\n",
            relative = "topic_00/note_07.md",
        )

        fun openSafStream(
            uri: Uri,
            jitterEarly: Boolean,
            counter: java.util.concurrent.ConcurrentHashMap<String, java.util.concurrent.atomic.AtomicInteger>? = null,
        ): java.io.InputStream? {
            val docId = DocumentsContract.getDocumentId(uri)
            counter?.computeIfAbsent(docId) { java.util.concurrent.atomic.AtomicInteger(0) }?.incrementAndGet()
            if (jitterEarly) {
                if (docId.contains("topic_00") || docId.contains("topic_01") || docId.contains("topic_02")) {
                    Thread.sleep(1L)
                }
            } else {
                Thread.sleep(1L)
            }
            return payloads[docId]?.inputStream()
        }

        // Reference baseline: sequential DFS walk + legacy O(N^2) sameDocument deduplication + sequential scan.
        val legacyStartNs = System.nanoTime()
        val legacySeen = ArrayList<Uri>()
        fun legacyMarkSeen(uriStr: String?): Uri? {
            if (uriStr.isNullOrBlank()) return null
            val parsed = Uri.parse(uriStr)
            if (legacySeen.any { sameDocument(it, parsed) }) return null
            legacySeen.add(parsed)
            return parsed
        }
        val expectedMatches = ArrayList<FolderSearchMatch>()
        legacyMarkSeen(openDirtyTab.uri)
        val tabSingle = streamTextSearch(
            query = "quantumeigenstate",
            tabs = listOf(openDirtyTab),
            recents = emptyList(),
            folderRoot = null,
            media = media,
            openUriStream = { null },
            activeTabId = openDirtyTab.id,
        )
        expectedMatches.addAll(tabSingle.matches)
        for (dirRow in rootChildren.sortedBy { it.name.lowercase(java.util.Locale.ROOT) }) {
            Thread.sleep(2L)
            val fileRows = childrenByParent[dirRow.docId].orEmpty()
                .filter { !it.name.startsWith('.') && (it.flags and DocumentsContract.Document.FLAG_VIRTUAL_DOCUMENT) == 0 }
                .sortedBy { it.name.lowercase(java.util.Locale.ROOT) }
            for (fileRow in fileRows) {
                val treeChildUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, fileRow.docId).toString()
                val parsed = legacyMarkSeen(treeChildUri) ?: continue
                val single = streamTextSearch(
                    query = "quantumeigenstate",
                    tabs = emptyList(),
                    recents = listOf(RecentNote(fileRow.name, parsed.toString(), relative = "${dirRow.name}/${fileRow.name}")),
                    folderRoot = null,
                    media = media,
                    openUriStream = { u -> openSafStream(u, jitterEarly = false) },
                )
                expectedMatches.addAll(single.matches)
            }
        }
        val legacyMs = (System.nanoTime() - legacyStartNs) / 1_000_000.0

        // Optimized run with inverted read jitter on early directories to stress out-of-order worker completion.
        val openCounts = java.util.concurrent.ConcurrentHashMap<String, java.util.concurrent.atomic.AtomicInteger>()
        val streamedBatches = ArrayList<FolderSearchMatch>()
        val optStartNs = System.nanoTime()
        val optimizedRes = streamTextSearch(
            query = "quantumeigenstate",
            tabs = listOf(openDirtyTab),
            recents = emptyList(),
            folderRoot = safRoot,
            media = media,
            openUriStream = { u -> openSafStream(u, jitterEarly = true, counter = openCounts) },
            activeTabId = openDirtyTab.id,
            onBatch = { batch, _, _, _ -> streamedBatches.addAll(batch) },
        )
        val optimizedMs = (System.nanoTime() - optStartNs) / 1_000_000.0
        println(
            "BENCHMARK_ANDROID_600_SAF: legacyMs=%.2f optimizedMs=%.2f speedup=%.2fx matches=%d scanned=%d".format(
                java.util.Locale.ROOT,
                legacyMs,
                optimizedMs,
                legacyMs / optimizedMs.coerceAtLeast(0.01),
                optimizedRes.matches.size,
                optimizedRes.scannedFiles,
            ),
        )

        assertEquals("Concurrent stateless search must preserve exact sequential match order", expectedMatches, optimizedRes.matches)
        assertEquals("Streaming batches must preserve exact sequential match order", expectedMatches, streamedBatches)
        assertEquals(600, optimizedRes.scannedFiles)
        assertFalse(optimizedRes.truncated)
        assertNull("Shadowed SAF tree URI for open plain-URI tab must never open an input stream", openCounts[shadowedDocId])

        // Truncation must slice at the exact deterministic prefix boundary.
        val truncatedRes = streamTextSearch(
            query = "quantumeigenstate",
            tabs = listOf(openDirtyTab),
            recents = emptyList(),
            folderRoot = safRoot,
            media = media,
            openUriStream = { u -> openSafStream(u, jitterEarly = true) },
            activeTabId = openDirtyTab.id,
            maxMatches = 19,
        )
        assertTrue(truncatedRes.truncated)
        assertEquals(expectedMatches.take(19), truncatedRes.matches)

        // Duplicate recents mixing plain document URI and tree-built document URI must open stream once.
        val dupDocId = "primary:Notes/topic_02/note_01.md"
        val dupCounts = java.util.concurrent.ConcurrentHashMap<String, java.util.concurrent.atomic.AtomicInteger>()
        val dupRes = streamTextSearch(
            query = "Paragraph 0",
            tabs = emptyList(),
            recents = listOf(
                RecentNote("note_01.md", DocumentsContract.buildDocumentUri(authority, dupDocId).toString(), pinned = true),
                RecentNote("note_01.md", DocumentsContract.buildDocumentUriUsingTree(treeUri, dupDocId).toString(), pinned = false),
            ),
            folderRoot = null,
            media = media,
            openUriStream = { u -> openSafStream(u, jitterEarly = false, counter = dupCounts) },
        )
        assertEquals(1, dupRes.scannedFiles)
        assertEquals(1, dupCounts[dupDocId]?.get())

        // Stateless freshness: updating SAF document bytes immediately updates next search without stale caches.
        val mutatedDocId = "primary:Notes/topic_04/note_02.md"
        payloads[mutatedDocId] = "# Freshly Mutated\n\nImmediateStatelessSafUpdate appears right away.\n".toByteArray(Charsets.UTF_8)
        val freshRes = streamTextSearch(
            query = "ImmediateStatelessSafUpdate",
            tabs = listOf(openDirtyTab),
            recents = emptyList(),
            folderRoot = safRoot,
            media = media,
            openUriStream = { u -> payloads[DocumentsContract.getDocumentId(u)]?.inputStream() },
            activeTabId = openDirtyTab.id,
        )
        assertEquals(listOf("topic_04/note_02.md" to 3), freshRes.matches.map { it.relative to it.line })
    }
}
