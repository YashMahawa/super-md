@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.material3.ExperimentalMaterial3ExpressiveApi::class)

package dev.supermd.studio

import android.app.Application
import android.graphics.Bitmap
import android.graphics.Canvas
import android.net.Uri
import android.os.Looper
import android.util.Base64
import android.view.View
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import java.time.Duration
import java.util.UUID
import javax.imageio.ImageIO
import kotlin.math.abs
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w360dp-h640dp-xxhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ConflictPresentationUiTest {
    @get:Rule val composeRule = createComposeRule()

    private fun SemanticsNode.leftDp(): Float = boundsInRoot.left / layoutInfo.density.density
    private fun SemanticsNode.rightDp(): Float = boundsInRoot.right / layoutInfo.density.density
    private fun SemanticsNode.topDp(): Float = boundsInRoot.top / layoutInfo.density.density
    private fun SemanticsNode.bottomDp(): Float = boundsInRoot.bottom / layoutInfo.density.density
    private fun SemanticsNode.widthDp(): Float = boundsInRoot.width / layoutInfo.density.density
    private fun SemanticsNode.heightDp(): Float = boundsInRoot.height / layoutInfo.density.density
    private fun SemanticsNode.touchHeightDp(): Float = touchBoundsInRoot.height / layoutInfo.density.density

    private fun makePngDataUrl(rgb: Int): String {
        val image = BufferedImage(2, 2, BufferedImage.TYPE_INT_ARGB).apply {
            setRGB(0, 0, rgb)
            setRGB(1, 1, rgb)
        }
        val bytes = ByteArrayOutputStream().also { ImageIO.write(image, "png", it) }.toByteArray()
        return "data:image/png;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
    }

    private fun waitUntil(timeoutMs: Long = 5_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        val mainLooper = shadowOf(Looper.getMainLooper())
        while (System.currentTimeMillis() < deadline) {
            mainLooper.idleFor(Duration.ofMillis(50))
            composeRule.waitForIdle()
            if (condition()) return
            Thread.sleep(15)
        }
        mainLooper.idleFor(Duration.ofMillis(50))
        composeRule.waitForIdle()
        assertTrue("Timed out waiting for condition", condition())
    }

    @Suppress("UNCHECKED_CAST")
    private fun capturePortraitScreenshotIfRequested() {
        val outputPath = System.getProperty("supermd.conflict.android.screenshot")
            ?: System.getenv("SUPERMD_CONFLICT_ANDROID_SCREENSHOT")
            ?: return
        val views = runCatching {
            val wmClass = Class.forName("android.view.WindowManagerGlobal")
            val instance = wmClass.getMethod("getInstance").invoke(null)
            val viewsField = wmClass.getDeclaredField("mViews").apply { isAccessible = true }
            (viewsField.get(instance) as? List<View>).orEmpty()
        }.getOrDefault(emptyList())
        if (views.isEmpty()) return
        val density = RuntimeEnvironment.getApplication().resources.displayMetrics.density
        val targetW = (360f * density).toInt()
        val targetH = (640f * density).toInt()
        val primary = views.first()
        val bitmap = Bitmap.createBitmap(
            primary.width.coerceAtLeast(1).coerceAtMost(targetW),
            primary.height.coerceAtLeast(1).coerceAtMost(targetH),
            Bitmap.Config.ARGB_8888,
        )
        val canvas = Canvas(bitmap)
        views.forEach { view ->
            val loc = IntArray(2)
            view.getLocationOnScreen(loc)
            canvas.save()
            canvas.translate(loc[0].toFloat(), loc[1].toFloat())
            view.draw(canvas)
            canvas.restore()
        }
        val outFile = File(outputPath).apply { parentFile?.mkdirs() }
        outFile.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun withWorkspace(block: (Application, File, StudioViewModel) -> Unit) {
        val app = RuntimeEnvironment.getApplication()
        val temp = Files.createTempDirectory("conflict-ui-360x640").toFile()
        val key = "conflict-ui-${UUID.randomUUID()}"
        val store = ViewModelStore()
        val factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T = StudioViewModel(app, workspaceKey = key) as T
        }
        val model = ViewModelProvider(store, factory)[StudioViewModel::class.java]
        try {
            model.reading(autosave = false)
            block(app, temp, model)
        } finally {
            store.clear()
            File(app.filesDir, "workspaces/$key.json").deleteRecursively()
            File(app.filesDir, "workspaces/$key").deleteRecursively()
            temp.deleteRecursively()
        }
    }

    @Test
    fun portrait360x640ConflictBannerDisplaysWarningAllThreeActionsAndPreservesRecovery() = withWorkspace { _, temp, model ->
        val initialUntitledId = model.state.value.active.id
        val mdFile = File(temp, "Theorem.md").apply {
            writeText("# Spectral Theorem\n\nBase disk proof.\n", Charsets.UTF_8)
        }
        val smdFile = File(temp, "Cholesky.smd")
        val draftAsset = makePngDataUrl(0xFFCC4422.toInt())
        val externalAsset = makePngDataUrl(0xFF22AA55.toInt())
        smdFile.outputStream().use { out ->
            model.media.writeFmd(out, "# Cholesky\n\n![](assets/plot.png)\n", JSONObject().put("assets/plot.png", draftAsset))
        }

        model.open(Uri.fromFile(mdFile))
        waitUntil { !model.state.value.busy && model.state.value.active.name == "Theorem.md" }
        val mdTabId = model.state.value.active.id
        model.requestClose(initialUntitledId)
        waitUntil { model.state.value.tabs.none { it.id == initialUntitledId } }
        model.edit(mdTabId, "# Spectral Theorem\n\nUnsaved local corollary draft.\n")

        model.open(Uri.fromFile(smdFile))
        waitUntil { !model.state.value.busy && model.state.value.active.name == "Cholesky.smd" }
        val smdTabId = model.state.value.active.id
        model.edit(smdTabId, "# Cholesky\n\nUnsaved portable draft.\n")
        model.markAssetsDirty(smdTabId)
        waitUntil { model.state.value.active.assetsDirty }

        // Switch back to Theorem.md so Cholesky.smd is a background tab visible alongside it on 360dp portrait, then modify BOTH files on disk.
        model.select(mdTabId)
        waitUntil { model.state.value.active.id == mdTabId }

        Thread.sleep(20)
        mdFile.writeText("# Spectral Theorem\n\nExternal disk revision v2.\n", Charsets.UTF_8)
        mdFile.setLastModified(System.currentTimeMillis() + 5_000)
        smdFile.outputStream().use { out ->
            model.media.writeFmd(out, "# Cholesky\n\nExternal portable v2.\n", JSONObject().put("assets/plot.png", externalAsset))
        }
        smdFile.setLastModified(System.currentTimeMillis() + 5_000)

        model.refreshExternal()
        waitUntil {
            model.state.value.conflictedTabIds.containsAll(setOf(mdTabId, smdTabId)) &&
                model.state.value.activeConflicted
        }

        var menuOpen by mutableStateOf(false)
        composeRule.setContent {
            val state by model.state.collectAsState()
            MaterialTheme(colorScheme = darkColorScheme()) {
                Surface(
                    modifier = Modifier.width(360.dp).height(640.dp).testTag("portraitRoot"),
                    color = MaterialTheme.colorScheme.surface,
                ) {
                    Column(Modifier.fillMaxSize()) {
                        StudioTopBar(
                            noteName = state.active.name,
                            statusLabel = if (state.activeConflicted) "Changed on disk · autosave paused" else "Saved",
                            fullscreen = false,
                            wide = false,
                            actualMode = state.mode,
                            centerLock = state.centerLock,
                            readerReady = true,
                            busy = state.busy,
                            menuExpanded = menuOpen,
                            onMenuExpandedChange = { menuOpen = it },
                            onNavigateIcon = {},
                            onFind = {},
                            onSave = { model.saveManual() },
                            onExport = {},
                            onToggleFullscreen = {},
                            onToggleCenterLock = {},
                            canReopenClosedTab = state.closedTabs.isNotEmpty(),
                            onReopenClosedTab = model::reopen,
                            onSaveAs = model::beginSaveAs,
                            onNewWindow = {},
                            onShare = {},
                            onInsertMedia = {},
                            onFixLatex = {},
                            onRename = {},
                            onSettings = {},
                        )
                        NoteTabs(
                            notes = state.tabs,
                            active = state.active.id,
                            motion = false,
                            select = model::select,
                            close = model::requestClose,
                            reorder = model::reorder,
                            newNote = model::newNote,
                            conflictedIds = state.conflictedTabIds,
                        )
                        StudioModeBar(
                            wide = false,
                            actualMode = state.mode,
                            centerLock = state.centerLock,
                            readerReady = true,
                            onShowContents = {},
                            onSelectMode = model::mode,
                            onUndo = {},
                            onRedo = {},
                            onEnterFullscreen = {},
                            onToggleCenterLock = {},
                        )
                        if (state.activeConflicted) {
                            ConflictBanner(
                                busy = state.busy,
                                onSaveAs = { model.beginSaveAs() },
                                onReload = { model.reloadFromDisk() },
                                onOverwrite = { model.saveManual(forceOverwrite = true) },
                                dirty = state.active.dirty,
                            )
                        }
                        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.55f))
                        Box(
                            Modifier
                                .weight(1f)
                                .fillMaxWidth()
                                .background(MaterialTheme.colorScheme.surface)
                                .padding(horizontal = 20.dp, vertical = 16.dp)
                                .testTag("documentViewport"),
                        ) {
                            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                Text("Spectral Theorem", style = MaterialTheme.typography.headlineSmall)
                                Text(
                                    state.active.content.trim(),
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                }
            }
        }
        composeRule.waitForIdle()
        capturePortraitScreenshotIfRequested()

        // 1. Verify visible warning and all three actions fit cleanly inside 360 x 640 dp portrait.
        val bannerNode = composeRule.onNodeWithTag("conflictBanner").assertIsDisplayed().fetchSemanticsNode()
        assertTrue("Banner must stay within 360dp width: right=${bannerNode.rightDp()}", bannerNode.leftDp() >= 0f && bannerNode.rightDp() <= 360.5f)

        val titleNode = composeRule.onNodeWithText("Changed on disk").assertIsDisplayed().fetchSemanticsNode()
        val bodyNode = composeRule
            .onNodeWithText("Modified outside Super MD · autosave paused. Reloading keeps your draft in closed tabs.")
            .assertIsDisplayed()
            .fetchSemanticsNode()
        assertTrue("Warning title must have readable width: ${titleNode.widthDp()}", titleNode.widthDp() >= 90f)
        assertTrue("Warning body must have full compact width: ${bodyNode.widthDp()}", bodyNode.widthDp() >= 250f)

        val saveAsNode = composeRule.onNodeWithText("Save as")
            .assertIsDisplayed()
            .assertIsEnabled()
            .assertHeightIsAtLeast(36.dp)
            .fetchSemanticsNode()
        val reloadNode = composeRule.onNodeWithText("Reload from disk")
            .assertIsDisplayed()
            .assertIsEnabled()
            .assertHeightIsAtLeast(36.dp)
            .fetchSemanticsNode()
        val overwriteNode = composeRule.onNodeWithText("Overwrite")
            .assertIsDisplayed()
            .assertIsEnabled()
            .assertHeightIsAtLeast(36.dp)
            .fetchSemanticsNode()

        val actionNodes = listOf("Save as" to saveAsNode, "Reload from disk" to reloadNode, "Overwrite" to overwriteNode)
        actionNodes.forEach { (label, node) ->
            assertTrue("$label must preserve >= 48dp touch target height: ${node.touchHeightDp()}", node.touchHeightDp() >= 47.5f)
            assertTrue("$label must fit horizontally in 360dp: [${node.leftDp()}, ${node.rightDp()}]", node.leftDp() >= 0f && node.rightDp() <= 360.5f)
            assertTrue("$label must sit below warning text: ${node.topDp()} vs ${bodyNode.bottomDp()}", node.topDp() >= bodyNode.bottomDp() - 1f)
        }
        // All three actions fit on a single compact button row at 360dp portrait width without overlapping.
        assertTrue(
            "All three actions should align on one row at 360dp: tops=${actionNodes.map { it.second.topDp() }}",
            abs(saveAsNode.topDp() - reloadNode.topDp()) <= 2f && abs(reloadNode.topDp() - overwriteNode.topDp()) <= 2f,
        )
        assertTrue("Save as and Reload must not overlap", saveAsNode.rightDp() <= reloadNode.leftDp() + 0.5f)
        assertTrue("Reload and Overwrite must not overlap", reloadNode.rightDp() <= overwriteNode.leftDp() + 0.5f)

        val viewportNode = composeRule.onNodeWithTag("documentViewport").assertIsDisplayed().fetchSemanticsNode()
        assertTrue(
            "360x640dp portrait must preserve >= 260dp for document viewport, got ${viewportNode.heightDp()}dp",
            viewportNode.heightDp() >= 260f,
        )

        // 2. Both active tab and background conflicted tab expose visible conflict indicators.
        composeRule.onNodeWithContentDescription("Theorem.md changed on disk").assertIsDisplayed()
        composeRule.onNodeWithContentDescription("Cholesky.smd changed on disk").assertIsDisplayed()

        // 3. Verify Save as button triggers Save As request for the conflicted active note.
        var saveAsTarget: Note? = null
        model.requestSaveAs = { saveAsTarget = it }
        composeRule.onNodeWithText("Save as").performClick()
        composeRule.waitForIdle()
        assertEquals(mdTabId, saveAsTarget?.id)

        // 4. Verify Overwrite works on active conflicted Markdown note and clears only its conflict.
        composeRule.onNodeWithText("Overwrite").performClick()
        waitUntil { !model.state.value.busy && !model.state.value.activeConflicted }
        assertEquals("# Spectral Theorem\n\nUnsaved local corollary draft.\n", mdFile.readText(Charsets.UTF_8))
        assertEquals(setOf(smdTabId), model.state.value.conflictedTabIds)
        assertEquals(0, composeRule.onAllNodesWithTag("conflictBanner").fetchSemanticsNodes().size)
        // Background tab indicator on Cholesky.smd remains visible!
        composeRule.onNodeWithContentDescription("Cholesky.smd changed on disk").assertIsDisplayed()

        // 5. Tap the conflicted background tab to reveal it and verify Reload from disk preserves #122 draft + asset recovery!
        composeRule.onNodeWithContentDescription("Cholesky.smd changed on disk").performClick()
        waitUntil { model.state.value.active.id == smdTabId && model.state.value.activeConflicted }
        composeRule.onNodeWithTag("conflictBanner").assertIsDisplayed()

        composeRule.onNodeWithText("Reload from disk").performClick()
        waitUntil { !model.state.value.busy && !model.state.value.activeConflicted }
        assertEquals("# Cholesky\n\nExternal portable v2.\n", model.state.value.active.content)
        assertTrue(model.state.value.conflictedTabIds.isEmpty())

        // Reopen closed tab restores the archived dirty portable draft and its image asset (#122).
        model.reopen()
        waitUntil { model.state.value.active.content == "# Cholesky\n\nUnsaved portable draft.\n" }
        val reopenedAssets = model.media.portableAssets(model.state.value.active.assetDirectory)
        assertEquals(draftAsset, reopenedAssets.getString("assets/plot.png"))
    }

    @Test
    fun noteTabs360DpRevealsActiveTabAcrossOverflowAndBackgroundConflicts() {
        val initialNotes = (1..5).map { idx ->
            Note(
                id = "tab-$idx",
                name = "0${idx}_Linear_Operators_Part_$idx.md",
                uri = "file:///tmp/part_$idx.md",
                content = "# Part $idx",
                saved = "# Part $idx",
            )
        }
        var notes by mutableStateOf(initialNotes)
        var activeId by mutableStateOf("tab-1")
        var conflicted by mutableStateOf(emptySet<String>())

        composeRule.setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                Surface(Modifier.width(360.dp)) {
                    NoteTabs(
                        notes = notes,
                        active = activeId,
                        motion = false,
                        select = { activeId = it },
                        close = {},
                        reorder = { _, _ -> },
                        newNote = {},
                        conflictedIds = conflicted,
                    )
                }
            }
        }
        composeRule.waitForIdle()

        fun assertActiveTabFullyRevealed(context: String) {
            val row = composeRule.onNodeWithTag("noteTabsRow").fetchSemanticsNode()
            val tab = composeRule.onNodeWithTag("noteTab_$activeId").assertIsDisplayed().fetchSemanticsNode()
            assertTrue(
                "Active tab $activeId clipped on left ($context): tabLeft=${tab.leftDp()}, rowLeft=${row.leftDp()}",
                tab.leftDp() >= row.leftDp() - 0.5f,
            )
            assertTrue(
                "Active tab $activeId clipped on right ($context): tabRight=${tab.rightDp()}, rowRight=${row.rightDp()}",
                tab.rightDp() <= row.rightDp() + 0.5f,
            )
        }

        assertActiveTabFullyRevealed("initial tab-1")

        // Switch to rightmost overflowing tab (tab-5) and confirm its full pill is revealed inside 360dp.
        activeId = "tab-5"
        composeRule.waitForIdle()
        assertActiveTabFullyRevealed("overflowing tab-5")

        // Switch back to tab-1, then select tab-2 and flag conflict on tab-1 + tab-2 so both widen; active tab-2 must stay fully inside row.
        activeId = "tab-1"
        composeRule.waitForIdle()
        assertActiveTabFullyRevealed("returned to tab-1")

        activeId = "tab-2"
        composeRule.waitForIdle()
        conflicted = setOf("tab-1", "tab-2", "tab-5")
        composeRule.waitForIdle()
        assertActiveTabFullyRevealed("tab-2 after tab-1 and tab-2 gain conflict badges")
        composeRule.onNodeWithTag("conflictTabIndicator_tab-2", useUnmergedTree = true).assertIsDisplayed()

        // Selecting conflicted tab-5 reveals both its pill and conflict indicator.
        activeId = "tab-5"
        composeRule.waitForIdle()
        assertActiveTabFullyRevealed("conflicted tab-5")
        composeRule.onNodeWithTag("conflictTabIndicator_tab-5", useUnmergedTree = true).assertIsDisplayed()
    }
}
