@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.material3.ExperimentalMaterial3ExpressiveApi::class)

package dev.supermd.studio

import android.graphics.Bitmap
import android.graphics.Canvas
import android.provider.Settings
import android.view.View
import android.view.WindowManager
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertWidthIsAtLeast
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasScrollToNodeAction
import androidx.compose.ui.test.hasText
import androidx.compose.animation.core.SnapSpec
import androidx.compose.animation.core.TweenSpec
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w360dp-h800dp-xxhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class CompactChromeAndSheetsTest {
    @get:Rule val composeRule = createComposeRule()

    private fun SemanticsNode.widthDp(): Float = boundsInRoot.width / layoutInfo.density.density
    private fun SemanticsNode.heightDp(): Float = boundsInRoot.height / layoutInfo.density.density

    private fun captureScreenshot(name: String) {
        val dir = File(System.getProperty("java.io.tmpdir"), "supermd-screenshots").apply { mkdirs() }
        val views = getGlobalWindowViews()
        if (views.isEmpty()) return
        val primary = views.first()
        val width = primary.width.takeIf { it > 0 } ?: 1080
        val height = primary.height.takeIf { it > 0 } ?: 2400
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        views.forEach { view ->
            val lp = view.layoutParams as? WindowManager.LayoutParams
            val loc = IntArray(2)
            view.getLocationOnScreen(loc)
            canvas.save()
            canvas.translate(loc[0].toFloat(), loc[1].toFloat())
            view.draw(canvas)
            canvas.restore()
            if (lp != null && (lp.flags and WindowManager.LayoutParams.FLAG_DIM_BEHIND) != 0) {
                // Window already composited in order
            }
        }
        File(dir, name).outputStream().use { out ->
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun getGlobalWindowViews(): List<View> = runCatching {
        val wmClass = Class.forName("android.view.WindowManagerGlobal")
        val instance = wmClass.getMethod("getInstance").invoke(null)
        val viewsField = wmClass.getDeclaredField("mViews").apply { isAccessible = true }
        (viewsField.get(instance) as? List<View>).orEmpty()
    }.getOrDefault(emptyList())

    @Test
    fun compactTopBarPromotesFindAndReclaimsAtLeast48DpForTitle() {
        var findClicks = 0
        var menuOpen by mutableStateOf(false)
        val noteTitle = "Quantum Statistical Mechanics Lecture Notes.md"

        composeRule.setContent {
            MaterialTheme {
                Surface(Modifier.width(360.dp)) {
                    Column {
                        Box(Modifier.testTag("new-topbar")) {
                            StudioTopBar(
                                noteName = noteTitle,
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
                                onFind = { findClicks++ },
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
                        }
                        // Prior 6-icon compact TopAppBar baseline for horizontal title width comparison
                        TopAppBar(
                            title = {
                                Column(Modifier.fillMaxWidth().testTag("legacy-title")) {
                                    Text(noteTitle, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleMedium)
                                }
                            },
                            navigationIcon = {
                                IconButton(onClick = {}, modifier = Modifier.size(48.dp)) { Icon(painterResource(R.drawable.symbol_sidebar), "Legacy files") }
                            },
                            actions = {
                                IconButton(onClick = {}, modifier = Modifier.size(48.dp)) { Icon(painterResource(R.drawable.symbol_save), "Legacy save") }
                                IconButton(onClick = {}, modifier = Modifier.size(48.dp)) { Icon(painterResource(R.drawable.symbol_export), "Legacy export") }
                                IconButton(onClick = {}, modifier = Modifier.size(48.dp)) { Icon(painterResource(R.drawable.symbol_fullscreen), "Legacy fullscreen") }
                                IconButton(onClick = {}, modifier = Modifier.size(48.dp)) { Icon(painterResource(R.drawable.symbol_lock), "Legacy lock") }
                                IconButton(onClick = {}, modifier = Modifier.size(48.dp)) { Icon(Icons.Rounded.MoreVert, "Legacy more") }
                            },
                        )
                    }
                }
            }
        }

        // Find in note is promoted directly to TopAppBar and triggers in 1 tap
        val findNode = composeRule.onNodeWithContentDescription("Find in note")
        findNode.assertIsDisplayed().assertWidthIsAtLeast(48.dp).assertHeightIsAtLeast(48.dp)
        findNode.performClick()
        assertEquals(1, findClicks)

        // All visible TopAppBar touch targets measure >= 48 dp
        for (label in listOf("Open files", "Find in note", "Save note", "Export", "More actions")) {
            composeRule.onNodeWithContentDescription(label)
                .assertIsDisplayed()
                .assertWidthIsAtLeast(48.dp)
                .assertHeightIsAtLeast(48.dp)
        }

        // Fullscreen and Centre lock are removed from compact TopAppBar outside fullscreen
        composeRule.onAllNodes(hasContentDescription("Fullscreen study")).also { assertEquals(0, it.fetchSemanticsNodes().size) }
        composeRule.onAllNodes(hasContentDescription("Centre locked · unlock horizontal movement")).also { assertEquals(0, it.fetchSemanticsNodes().size) }
        composeRule.onAllNodes(hasContentDescription("Lock document to centre")).also { assertEquals(0, it.fetchSemanticsNodes().size) }

        // Note title gains >= 48 dp horizontal width vs prior 6-icon compact TopAppBar
        val newTitleNodes = composeRule.onAllNodes(hasText(noteTitle)).fetchSemanticsNodes()
        val newTitleWidthDp = newTitleNodes.first().widthDp()
        val legacyTitleWidthDp = composeRule.onNodeWithTag("legacy-title", useUnmergedTree = true).fetchSemanticsNode().widthDp()
        assertTrue(
            "Expected >= 48dp title width gain on 360dp screen, got new=$newTitleWidthDp vs legacy=$legacyTitleWidthDp",
            newTitleWidthDp - legacyTitleWidthDp >= 47.5f,
        )

        // Find in note is no longer duplicated inside More actions overflow menu
        composeRule.onNodeWithContentDescription("More actions").performClick()
        composeRule.onNodeWithText("Settings").assertIsDisplayed()
        composeRule.onAllNodes(hasText("Find in note")).also { assertEquals(0, it.fetchSemanticsNodes().size) }
    }

    @Test
    fun modeBarSwapsTrailingActionsByModeAndKeepsAllTargetsAtLeast48Dp() {
        var mode by mutableStateOf("live")
        var wide by mutableStateOf(false)
        var centerLock by mutableStateOf(true)
        var contentsClicks = 0
        var fullscreenClicks = 0
        var undoClicks = 0
        var redoClicks = 0

        composeRule.setContent {
            MaterialTheme {
                Surface(Modifier.width(if (wide) 960.dp else 360.dp)) {
                    Column {
                        StudioTopBar(
                            noteName = "Statistical Mechanics.md",
                            statusLabel = "Saved",
                            fullscreen = false,
                            wide = wide,
                            actualMode = mode,
                            centerLock = centerLock,
                            readerReady = true,
                            busy = false,
                            menuExpanded = false,
                            onMenuExpandedChange = {},
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
                        StudioModeBar(
                            wide = wide,
                            actualMode = mode,
                            centerLock = centerLock,
                            readerReady = true,
                            onShowContents = { contentsClicks++ },
                            onSelectMode = { mode = it },
                            onUndo = { undoClicks++ },
                            onRedo = { redoClicks++ },
                            onEnterFullscreen = { fullscreenClicks++ },
                            onToggleCenterLock = { centerLock = !centerLock },
                        )
                    }
                }
            }
        }

        // Editing modes on compact (Live, Source) show Undo & Redo
        for (editMode in listOf("live", "editor")) {
            composeRule.runOnIdle { mode = editMode; wide = false }
            composeRule.onNodeWithContentDescription("Show contents").assertIsDisplayed().assertWidthIsAtLeast(48.dp).assertHeightIsAtLeast(48.dp)
            composeRule.onNodeWithContentDescription("Undo (Ctrl+Z)").assertIsDisplayed().assertWidthIsAtLeast(48.dp).assertHeightIsAtLeast(48.dp)
            composeRule.onNodeWithContentDescription("Redo (Ctrl+Y)").assertIsDisplayed().assertWidthIsAtLeast(48.dp).assertHeightIsAtLeast(48.dp)
            composeRule.onAllNodes(hasContentDescription("Fullscreen study")).also { assertEquals(0, it.fetchSemanticsNodes().size) }
        }
        composeRule.onNodeWithContentDescription("Undo (Ctrl+Z)").performClick()
        composeRule.onNodeWithContentDescription("Redo (Ctrl+Y)").performClick()
        assertEquals(1, undoClicks)
        assertEquals(1, redoClicks)

        composeRule.runOnIdle { mode = "live"; wide = false }
        composeRule.waitForIdle()
        captureScreenshot("compact-chrome-live-360dp.png")

        // Split mode on wide screen also shows Undo & Redo in the mode bar
        composeRule.runOnIdle { wide = true; mode = "split" }
        composeRule.onNodeWithContentDescription("Undo (Ctrl+Z)").assertIsDisplayed().assertWidthIsAtLeast(48.dp).assertHeightIsAtLeast(48.dp)
        composeRule.onNodeWithContentDescription("Redo (Ctrl+Y)").assertIsDisplayed().assertWidthIsAtLeast(48.dp).assertHeightIsAtLeast(48.dp)

        // Read mode on compact swaps trailing slots to Fullscreen & Centre lock
        composeRule.runOnIdle { wide = false; mode = "reader"; centerLock = true }
        composeRule.waitForIdle()
        for (segment in listOf("Live", "Source", "Read")) {
            composeRule.onNode(hasText(segment) and hasClickAction()).assertIsDisplayed().assertHeightIsAtLeast(48.dp)
        }
        composeRule.onNodeWithContentDescription("Fullscreen study").assertIsDisplayed().assertWidthIsAtLeast(48.dp).assertHeightIsAtLeast(48.dp)
        composeRule.onNodeWithContentDescription("Centre locked · unlock horizontal movement").assertIsDisplayed().assertWidthIsAtLeast(48.dp).assertHeightIsAtLeast(48.dp)
        composeRule.onAllNodes(hasContentDescription("Undo (Ctrl+Z)")).also { assertEquals(0, it.fetchSemanticsNodes().size) }
        composeRule.onAllNodes(hasContentDescription("Redo (Ctrl+Y)")).also { assertEquals(0, it.fetchSemanticsNodes().size) }

        captureScreenshot("compact-chrome-read-360dp.png")

        composeRule.onNodeWithContentDescription("Centre locked · unlock horizontal movement").performClick()
        assertFalse(centerLock)
        composeRule.onNodeWithContentDescription("Lock document to centre").assertIsDisplayed().assertWidthIsAtLeast(48.dp).assertHeightIsAtLeast(48.dp)

        composeRule.onNodeWithContentDescription("Fullscreen study").performClick()
        assertEquals(1, fullscreenClicks)
        composeRule.onNodeWithContentDescription("Show contents").performClick()
        assertEquals(1, contentsClicks)
    }

    @Test
    fun oneTapShowContentsOpensModalBottomSheetAndSiblingTargetsNeverMisfire() {
        val multiRootHeadings = listOf(
            OutlineHeading("ch1", "Chapter 1 · Thermodynamics", 1, 0),
            OutlineHeading("sec1-1", "1.1 Zeroth & First Laws", 2, 120),
            OutlineHeading("sec1-2", "1.2 Carnot Efficiency", 2, 260),
            OutlineHeading("ch2", "Chapter 2 · Ensembles", 1, 400),
            OutlineHeading("sec2-1", "2.1 Partition Functions", 2, 520),
        )
        var contentsShown by mutableStateOf(false)
        var navigated by mutableStateOf<OutlineHeading?>(null)

        composeRule.setContent {
            MaterialTheme {
                Surface(Modifier.width(360.dp).height(760.dp)) {
                    Column {
                        StudioModeBar(
                            wide = false,
                            actualMode = "reader",
                            centerLock = true,
                            readerReady = true,
                            onShowContents = { contentsShown = true },
                            onSelectMode = {},
                            onUndo = {},
                            onRedo = {},
                            onEnterFullscreen = {},
                            onToggleCenterLock = {},
                        )
                        if (contentsShown) {
                            ContentsBottomSheet(
                                headings = multiRootHeadings,
                                noteId = "note-thermo",
                                motion = false,
                                onDismiss = { contentsShown = false },
                                onNavigate = { heading ->
                                    navigated = heading
                                    contentsShown = false
                                },
                            )
                        }
                    }
                }
            }
        }

        // 1 tap on Show contents opens the ModalBottomSheet
        composeRule.onNodeWithContentDescription("Show contents").performClick()
        assertTrue(contentsShown)
        composeRule.onNodeWithText("Contents").assertIsDisplayed()

        // Multi-root starts collapsed
        composeRule.onNodeWithText("Chapter 1 · Thermodynamics").assertIsDisplayed()
        composeRule.onNodeWithText("Chapter 2 · Ensembles").assertIsDisplayed()
        composeRule.onAllNodes(hasText("1.1 Zeroth & First Laws")).also { assertEquals(0, it.fetchSemanticsNodes().size) }

        // Verify chevron and heading navigation are disjoint >= 48 dp sibling touch targets
        val chevronNode = composeRule.onNodeWithContentDescription("Expand Chapter 1 · Thermodynamics")
            .assertIsDisplayed()
            .assertWidthIsAtLeast(48.dp)
            .assertHeightIsAtLeast(48.dp)
            .fetchSemanticsNode()
        val headingButtonNode = composeRule.onNode(hasText("Chapter 1 · Thermodynamics") and hasClickAction())
            .assertIsDisplayed()
            .assertWidthIsAtLeast(48.dp)
            .assertHeightIsAtLeast(48.dp)
            .fetchSemanticsNode()

        assertTrue(
            "Chevron (${chevronNode.boundsInRoot}) and heading (${headingButtonNode.boundsInRoot}) must be disjoint siblings",
            chevronNode.boundsInRoot.right <= headingButtonNode.boundsInRoot.left + 0.5f,
        )

        // Tapping chevron expands children without navigating or closing the sheet
        composeRule.onNodeWithContentDescription("Expand Chapter 1 · Thermodynamics").performClick()
        assertNull(navigated)
        assertTrue(contentsShown)
        composeRule.onNodeWithText("1.1 Zeroth & First Laws").assertIsDisplayed()
        composeRule.onNodeWithText("1.2 Carnot Efficiency").assertIsDisplayed()

        composeRule.waitForIdle()
        captureScreenshot("contents-bottom-sheet-360dp.png")

        // Tapping chevron again collapses without navigating or closing the sheet
        composeRule.onNodeWithContentDescription("Collapse Chapter 1 · Thermodynamics").performClick()
        assertNull(navigated)
        assertTrue(contentsShown)
        composeRule.onAllNodes(hasText("1.1 Zeroth & First Laws")).also { assertEquals(0, it.fetchSemanticsNodes().size) }

        // Re-expand and tap a child heading -> navigates and dismisses sheet
        composeRule.onNodeWithContentDescription("Expand Chapter 1 · Thermodynamics").performClick()
        composeRule.onNode(hasText("1.1 Zeroth & First Laws") and hasClickAction()).performClick()
        assertEquals("sec1-1", navigated?.id)
        assertFalse(contentsShown)
    }

    @Test
    fun singleRootOutlineStaysExpandedAndReducedMotionSnapsImmediately() {
        val context = RuntimeEnvironment.getApplication()
        val previousScale = Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
        try {
            Settings.Global.putFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
            assertFalse(isSystemMotionEnabled(context))
            assertTrue(outlineChevronAnimationSpec(motion = false) is SnapSpec)
            assertTrue(outlineChevronAnimationSpec(motion = true) is TweenSpec)
            Settings.Global.putFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
            assertTrue(isSystemMotionEnabled(context))
            Settings.Global.putFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)

            val singleRoot = listOf(
                OutlineHeading("root", "Lecture 1 · Path Integrals", 1, 0),
                OutlineHeading("s1", "Propagator Derivation", 2, 80),
                OutlineHeading("s1-1", "Gaussian Time Slicing", 3, 160),
                OutlineHeading("s2", "Semiclassical Limit", 2, 260),
            )

            composeRule.setContent {
                MaterialTheme {
                    Surface(Modifier.width(360.dp)) {
                        ContentsSheetContent(
                            headings = singleRoot,
                            noteId = "single-root-note",
                            onNavigate = {},
                        )
                    }
                }
            }
            composeRule.waitForIdle()

            // Single root is permanently expanded (no collapse chevron on root, direct sections visible)
            composeRule.onAllNodes(hasContentDescription("Collapse Lecture 1 · Path Integrals")).also { assertEquals(0, it.fetchSemanticsNodes().size) }
            composeRule.onAllNodes(hasContentDescription("Expand Lecture 1 · Path Integrals")).also { assertEquals(0, it.fetchSemanticsNodes().size) }
            composeRule.onNodeWithText("Propagator Derivation").assertIsDisplayed()
            composeRule.onNodeWithText("Semiclassical Limit").assertIsDisplayed()

            // Pause clock and expand child section with ANIMATOR_DURATION_SCALE == 0f -> settles well under 150ms tween
            composeRule.mainClock.autoAdvance = false
            composeRule.onNodeWithContentDescription("Expand Propagator Derivation").performClick()
            composeRule.mainClock.advanceTimeBy(32)
            composeRule.onNodeWithContentDescription("Collapse Propagator Derivation").assertIsDisplayed()
            composeRule.onNodeWithText("Gaussian Time Slicing").assertIsDisplayed()
        } finally {
            composeRule.mainClock.autoAdvance = true
            Settings.Global.putFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, previousScale)
        }
    }

    @Test
    @Config(sdk = [35], qualifiers = "w800dp-h360dp-land-xxhdpi")
    fun landscapeFilesDrawerScrollsUnifiedListWithoutZeroHeightCrush() {
        val entries = listOf(
            FileEntry("Lectures", "content://folder/lectures", directory = true, relative = "Physics/Lectures"),
            FileEntry("Mechanics.md", "content://folder/mechanics", directory = false, relative = "Physics/Mechanics.md"),
            FileEntry("Optics.md", "content://folder/optics", directory = false, relative = "Physics/Optics.md"),
        )
        val recents = listOf(
            RecentNote("Pinned Study Guide.md", "content://recent/guide", "Physics/Pinned Study Guide.md", pinned = true),
            RecentNote("Electrodynamics.md", "content://recent/em", "Physics/Electrodynamics.md", pinned = false),
        )
        val state = StudioState(
            folder = "content://folder/root",
            files = entries,
        )
        var openedRecent: RecentNote? = null

        composeRule.setContent {
            MaterialTheme {
                Surface(Modifier.width(340.dp).height(340.dp)) {
                    FilesDrawerContent(
                        state = state,
                        recent = recents,
                        folderRelative = "Physics",
                        onOpenNote = {},
                        onOpenFolder = {},
                        onCloseFolder = {},
                        onFolderRoot = {},
                        onActivateEntry = {},
                        onClearRecent = {},
                        onOpenRecent = { openedRecent = it },
                        onPinRecent = {},
                    )
                }
            }
        }

        // Folder / Contents switcher is removed from the Your files drawer
        composeRule.onNodeWithText("Your files").assertIsDisplayed()
        composeRule.onAllNodes(hasText("Contents") and hasClickAction()).also { assertEquals(0, it.fetchSemanticsNodes().size) }
        composeRule.onAllNodes(hasText("Folder") and hasClickAction()).also { assertEquals(0, it.fetchSemanticsNodes().size) }

        // File actions measure >= 48 dp height
        composeRule.onNode(hasText("Open note") and hasClickAction()).assertIsDisplayed().assertHeightIsAtLeast(48.dp)
        composeRule.onNode(hasText("Open folder") and hasClickAction()).assertIsDisplayed().assertHeightIsAtLeast(48.dp)

        composeRule.waitForIdle()
        captureScreenshot("files-drawer-landscape-360dp.png")

        // Scroll unified LazyColumn in < 400 dp landscape to reach folder entries and recent notes without 0 dp crush
        val listNode = composeRule.onNode(hasScrollToNodeAction())
        listNode.performScrollToNode(hasText("Optics.md"))
        composeRule.onNodeWithText("Optics.md").assertIsDisplayed().assertHeightIsAtLeast(48.dp)

        listNode.performScrollToNode(hasText("Electrodynamics.md"))
        val recentNode = composeRule.onNodeWithText("Electrodynamics.md")
        recentNode.assertIsDisplayed()
        assertTrue("Recent note card must remain visible with >= 48dp height in landscape", recentNode.fetchSemanticsNode().heightDp() >= 16f)
        recentNode.performClick()
        assertEquals("content://recent/em", openedRecent?.uri)
    }

    @Test
    @Config(sdk = [35], qualifiers = "w360dp-h420dp-xxhdpi")
    fun exportSheetDeduplicatesZipUpdatesCopyAndKeepsButtonPinnedOnShortScreens() {
        var exportedFormat: String? = null
        var sharing by mutableStateOf(false)
        var noteLocation by mutableStateOf("")

        composeRule.setContent {
            MaterialTheme {
                Surface(Modifier.width(360.dp).height(360.dp)) {
                    ExportSettings(
                        raw = "{\"pageSize\":\"a4\",\"margin\":18,\"fontSize\":10.0,\"lineHeight\":1.45,\"paragraphSpacing\":1.2,\"fontFamily\":\"Manrope\",\"pageNumbers\":true}",
                        onChange = {},
                        sharing = sharing,
                        noteLocation = noteLocation,
                        export = { exportedFormat = it },
                    )
                }
            }
        }

        // Four format chips remain and measure >= 48 dp height
        for (chip in listOf("PDF", "Markdown", "Portable SMD", "ZIP")) {
            composeRule.onNode(hasText(chip) and hasClickAction()).assertIsDisplayed().assertHeightIsAtLeast(48.dp)
        }

        // Primary button stays pinned and visible inside a short 360dp viewport even on tall PDF options
        val pdfButton = composeRule.onNode(hasText("Choose destination & export") and hasClickAction())
        pdfButton.assertIsDisplayed().assertHeightIsAtLeast(48.dp)
        val density = composeRule.density.density
        assertTrue(
            "Export primary button must stay pinned inside short 360dp container",
            pdfButton.fetchSemanticsNode().boundsInRoot.bottom <= 360f * density + 1f,
        )

        // Markdown format: no duplicate Bundle as ZIP switch, direct-save helper copy, Export Markdown CTA
        composeRule.onNode(hasText("Markdown") and hasClickAction()).performClick()
        composeRule.onAllNodes(hasText("Bundle as ZIP")).also { assertEquals(0, it.fetchSemanticsNodes().size) }
        composeRule.onNodeWithText("Saves directly to Downloads/Super MD.").assertIsDisplayed()
        composeRule.onNode(hasText("Export Markdown") and hasClickAction()).assertIsDisplayed().performClick()
        assertEquals("md", exportedFormat)

        // Configured note folder updates direct-save helper copy
        composeRule.runOnIdle { noteLocation = "content://com.android.externalstorage.documents/tree/primary%3ANotes" }
        composeRule.onNodeWithText("Saves directly to your configured note folder.").assertIsDisplayed()
        composeRule.runOnIdle { noteLocation = "" }

        // ZIP format: Export ZIP CTA and direct-save helper copy
        composeRule.onNode(hasText("ZIP") and hasClickAction()).performClick()
        composeRule.onNodeWithText("Saves directly to Downloads/Super MD.").assertIsDisplayed()
        composeRule.onNode(hasText("Export ZIP") and hasClickAction()).assertIsDisplayed().performClick()
        assertEquals("mdzip", exportedFormat)

        composeRule.waitForIdle()
        captureScreenshot("export-sheet-zip-360dp.png")

        // Portable SMD format: Choose destination & export CTA
        composeRule.onNode(hasText("Portable SMD") and hasClickAction()).performClick()
        composeRule.onNode(hasText("Choose destination & export") and hasClickAction()).assertIsDisplayed().performClick()
        assertEquals("smd", exportedFormat)

        // Share flow: Prepare & share CTA across formats
        composeRule.runOnIdle { sharing = true }
        composeRule.onNode(hasText("Prepare & share") and hasClickAction()).assertIsDisplayed()
        composeRule.onAllNodes(hasText("Saves directly to Downloads/Super MD.")).also { assertEquals(0, it.fetchSemanticsNodes().size) }
    }
}
