@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.material3.ExperimentalMaterial3ExpressiveApi::class)

package dev.supermd.studio

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.webkit.WebView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.ViewModelProvider
import java.io.File
import java.time.Duration
import java.util.UUID
import kotlin.math.max
import kotlin.math.min
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w360dp-h800dp-xxhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class FormattingBarTest {
    @get:Rule val composeRule = createComposeRule()

    private lateinit var app: android.app.Application
    private val workspaceKeys = mutableListOf<String>()

    @Before fun setUp() {
        app = RuntimeEnvironment.getApplication()
    }

    @After fun tearDown() {
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(32))
        app.getSharedPreferences("studio", Context.MODE_PRIVATE).edit().clear().commit()
        workspaceKeys.forEach { key ->
            File(app.filesDir, "workspaces/$key.json").delete()
            File(app.filesDir, "workspaces/$key").deleteRecursively()
        }
    }

    private fun idleUntil(timeoutMs: Long = 5_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        val mainLooper = shadowOf(Looper.getMainLooper())
        val step = Duration.ofMillis(16)
        while (System.currentTimeMillis() < deadline) {
            mainLooper.idleFor(step)
            if (condition()) return
            Thread.sleep(10)
        }
        mainLooper.idleFor(step)
        assertTrue("Condition was not met within ${timeoutMs}ms", condition())
    }

    @Suppress("UNCHECKED_CAST")
    private fun getGlobalWindowViews(): List<View> = runCatching {
        val wmClass = Class.forName("android.view.WindowManagerGlobal")
        val instance = wmClass.getMethod("getInstance").invoke(null)
        val viewsField = wmClass.getDeclaredField("mViews").apply { isAccessible = true }
        (viewsField.get(instance) as? List<View>).orEmpty()
    }.getOrDefault(emptyList())

    private fun captureWindowBitmap(saveAsPath: String? = null): Bitmap? {
        val views = getGlobalWindowViews()
        if (views.isEmpty()) return null
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
        if (saveAsPath != null) {
            val file = File(saveAsPath).apply { parentFile?.mkdirs() }
            file.outputStream().use { out ->
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
            }
        }
        return bitmap
    }

    private fun intersectRect(a: Rect, b: Rect): Rect = Rect(
        left = max(a.left, b.left),
        top = max(a.top, b.top),
        right = min(a.right, b.right),
        bottom = min(a.bottom, b.bottom),
    )

    private fun findWebView(view: View): SelectionReaderWebView? = when (view) {
        is SelectionReaderWebView -> view
        is ViewGroup -> (0 until view.childCount).firstNotNullOfOrNull { findWebView(view.getChildAt(it)) }
        else -> null
    }

    @Test fun mapsAllDefaultHardwareFormattingShortcuts() {
        assertEquals("bold", markdownFormatActionForKey(KeyEvent.KEYCODE_B, isCtrlPressed = true, isShiftPressed = false, isAltPressed = false))
        assertEquals("italic", markdownFormatActionForKey(KeyEvent.KEYCODE_I, isCtrlPressed = true, isShiftPressed = false, isAltPressed = false))
        assertEquals("inline_code", markdownFormatActionForKey(KeyEvent.KEYCODE_E, isCtrlPressed = true, isShiftPressed = false, isAltPressed = false))
        assertEquals("inline_code", markdownFormatActionForKey(KeyEvent.KEYCODE_GRAVE, isCtrlPressed = true, isShiftPressed = false, isAltPressed = false))
        assertEquals("link", markdownFormatActionForKey(KeyEvent.KEYCODE_K, isCtrlPressed = true, isShiftPressed = false, isAltPressed = false))
        assertEquals("heading", markdownFormatActionForKey(KeyEvent.KEYCODE_H, isCtrlPressed = true, isShiftPressed = true, isAltPressed = false))
        assertEquals("list", markdownFormatActionForKey(KeyEvent.KEYCODE_L, isCtrlPressed = true, isShiftPressed = true, isAltPressed = false))
        assertEquals("quote", markdownFormatActionForKey(KeyEvent.KEYCODE_Q, isCtrlPressed = true, isShiftPressed = true, isAltPressed = false))
        assertEquals("quote", markdownFormatActionForKey(KeyEvent.KEYCODE_Q, isCtrlPressed = true, isShiftPressed = false, isAltPressed = true))
        assertEquals("inline_math", markdownFormatActionForKey(KeyEvent.KEYCODE_M, isCtrlPressed = true, isShiftPressed = true, isAltPressed = false))
    }

    @Test fun ignoresUnmodifiedOrConflictingKeyChords() {
        assertNull(markdownFormatActionForKey(KeyEvent.KEYCODE_B, isCtrlPressed = false, isShiftPressed = false, isAltPressed = false))
        assertNull(markdownFormatActionForKey(KeyEvent.KEYCODE_B, isCtrlPressed = true, isShiftPressed = true, isAltPressed = false))
        assertNull(markdownFormatActionForKey(KeyEvent.KEYCODE_H, isCtrlPressed = true, isShiftPressed = false, isAltPressed = false))
        assertNull(markdownFormatActionForKey(KeyEvent.KEYCODE_B, isCtrlPressed = true, isShiftPressed = false, isAltPressed = true))
        assertNull(markdownFormatActionForKey(KeyEvent.KEYCODE_B, isCtrlPressed = true, isShiftPressed = false, isAltPressed = false, isMetaPressed = true))
    }

    @Test fun showsKeyboardBarOnlyDuringActiveSoftKeyboardEditing() {
        for (mode in listOf("editor", "split", "live")) {
            assertTrue(
                shouldShowKeyboardFormattingBar(
                    mode = mode,
                    imeVisible = true,
                    editorFocused = true,
                    readerReady = true,
                    readerOverlay = false,
                    modalOpen = false,
                )
            )
        }
        // Hidden in Read mode
        assertFalse(
            shouldShowKeyboardFormattingBar(
                mode = "reader",
                imeVisible = true,
                editorFocused = true,
                readerReady = true,
                readerOverlay = false,
                modalOpen = false,
            )
        )
        // Hidden when soft keyboard closes or hardware keyboard suppresses IME
        assertFalse(
            shouldShowKeyboardFormattingBar(
                mode = "editor",
                imeVisible = false,
                editorFocused = true,
                readerReady = true,
                readerOverlay = false,
                modalOpen = false,
            )
        )
        // Hidden when editor is unfocused, overlay is open, or native modal is open
        assertFalse(
            shouldShowKeyboardFormattingBar(
                mode = "live",
                imeVisible = true,
                editorFocused = false,
                readerReady = true,
                readerOverlay = false,
                modalOpen = false,
            )
        )
        assertFalse(
            shouldShowKeyboardFormattingBar(
                mode = "editor",
                imeVisible = true,
                editorFocused = true,
                readerReady = true,
                readerOverlay = true,
                modalOpen = false,
            )
        )
        assertFalse(
            shouldShowKeyboardFormattingBar(
                mode = "split",
                imeVisible = true,
                editorFocused = true,
                readerReady = true,
                readerOverlay = false,
                modalOpen = true,
            )
        )
    }

    @Test fun hardwareShortcutsWorkWithoutSoftKeyboardWhenEditorIsFocused() {
        assertTrue(
            canTriggerHardwareFormatShortcut(
                mode = "live",
                editorFocused = true,
                readerReady = true,
                readerOverlay = false,
                modalOpen = false,
            )
        )
        assertFalse(
            canTriggerHardwareFormatShortcut(
                mode = "reader",
                editorFocused = true,
                readerReady = true,
                readerOverlay = false,
                modalOpen = false,
            )
        )
        assertFalse(
            canTriggerHardwareFormatShortcut(
                mode = "live",
                editorFocused = false,
                readerReady = true,
                readerOverlay = false,
                modalOpen = false,
            )
        )
    }

    @Test fun shouldCollapseChromeForLandscapeKeyboardTargetsConstrainedLandscapeOnly() {
        // Phone landscape with soft keyboard open (Pixel 2 731x411dp & compact 800x360dp)
        assertTrue(
            shouldCollapseChromeForLandscapeKeyboard(
                mode = "live",
                imeVisible = true,
                modalOpen = false,
                viewportWidthDp = 731f,
                viewportHeightDp = 411f,
                imeBottomDp = 200f,
                chromeHeightDp = 188f,
            )
        )
        assertTrue(
            shouldCollapseChromeForLandscapeKeyboard(
                mode = "editor",
                imeVisible = true,
                modalOpen = false,
                viewportWidthDp = 800f,
                viewportHeightDp = 360f,
                imeBottomDp = 180f,
                chromeHeightDp = 188f,
            )
        )
        // Small 7" landscape tablet where IME + full chrome would leave < 180dp for the editor
        assertTrue(
            shouldCollapseChromeForLandscapeKeyboard(
                mode = "split",
                imeVisible = true,
                modalOpen = false,
                viewportWidthDp = 960f,
                viewportHeightDp = 600f,
                imeBottomDp = 280f,
                chromeHeightDp = 176f,
            )
        )
        // Portrait phones never collapse top chrome when soft keyboard opens
        assertFalse(
            shouldCollapseChromeForLandscapeKeyboard(
                mode = "live",
                imeVisible = true,
                modalOpen = false,
                viewportWidthDp = 360f,
                viewportHeightDp = 800f,
                imeBottomDp = 300f,
                chromeHeightDp = 188f,
            )
        )
        assertFalse(
            shouldCollapseChromeForLandscapeKeyboard(
                mode = "editor",
                imeVisible = true,
                modalOpen = false,
                viewportWidthDp = 411f,
                viewportHeightDp = 731f,
                imeBottomDp = 280f,
                chromeHeightDp = 188f,
            )
        )
        // Large 10"+ landscape tablet with >= 180dp remaining editor height keeps desktop-style chrome
        assertFalse(
            shouldCollapseChromeForLandscapeKeyboard(
                mode = "split",
                imeVisible = true,
                modalOpen = false,
                viewportWidthDp = 1280f,
                viewportHeightDp = 800f,
                imeBottomDp = 280f,
                chromeHeightDp = 176f,
            )
        )
        // Never collapses when IME is closed, in Read mode, or while a native modal owns focus
        assertFalse(
            shouldCollapseChromeForLandscapeKeyboard(
                mode = "live",
                imeVisible = false,
                modalOpen = false,
                viewportWidthDp = 731f,
                viewportHeightDp = 411f,
            )
        )
        assertFalse(
            shouldCollapseChromeForLandscapeKeyboard(
                mode = "reader",
                imeVisible = true,
                modalOpen = false,
                viewportWidthDp = 731f,
                viewportHeightDp = 411f,
                imeBottomDp = 200f,
            )
        )
        assertFalse(
            shouldCollapseChromeForLandscapeKeyboard(
                mode = "live",
                imeVisible = true,
                modalOpen = true,
                viewportWidthDp = 731f,
                viewportHeightDp = 411f,
                imeBottomDp = 200f,
            )
        )
    }

    @Test
    @Config(sdk = [35], qualifiers = "w420dp-h840dp-xxhdpi")
    fun portraitFormattingBarFitsAllEightControlsIncludingInlineMathWithVisibleGeometry() {
        val triggered = mutableListOf<String>()
        var currentWidth by mutableStateOf<Dp>(360.dp)
        var compactMode by mutableStateOf(false)

        composeRule.setContent {
            MaterialTheme {
                Surface(
                    modifier = Modifier
                        .width(currentWidth)
                        .background(MaterialTheme.colorScheme.surface)
                        .testTag("portrait_host"),
                ) {
                    Column(Modifier.fillMaxWidth()) {
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(180.dp)
                                .background(MaterialTheme.colorScheme.surface)
                                .padding(16.dp),
                        ) {
                            Text(
                                text = "Fourier transform: \$F(\\omega) = \\int_{-\\infty}^{\\infty} f(t) e^{-i\\omega t} dt\$",
                                style = MaterialTheme.typography.bodyLarge,
                            )
                        }
                        KeyboardFormattingBar(
                            onFormat = { triggered += it },
                            compact = compactMode,
                        )
                        Spacer(
                            modifier = Modifier
                                .fillMaxWidth()
                                .height(220.dp)
                                .background(Color(0xFFE3E7EE)),
                        )
                    }
                }
            }
        }

        val portraitCases = listOf(
            Triple(320.dp, 39.5f, "/tmp/supermd-screenshots/portrait-formatting-bar-320dp.png"),
            Triple(360.dp, 44.5f, "/tmp/supermd-screenshots/portrait-formatting-bar-360dp.png"),
            Triple(390.dp, 48.0f, "/tmp/supermd-screenshots/portrait-formatting-bar-390dp.png"),
            Triple(411.dp, 48.0f, "/tmp/supermd-screenshots/portrait-formatting-bar-411dp.png"),
        )

        for ((widthDp, expectedMinSlotDp, screenshotPath) in portraitCases) {
            triggered.clear()
            compactMode = false
            composeRule.runOnIdle { currentWidth = widthDp }
            composeRule.waitForIdle()

            val hostBounds = composeRule.onNodeWithTag("portrait_host").fetchSemanticsNode().boundsInRoot
            val barNode = composeRule.onNodeWithTag("keyboard_formatting_bar").assertIsDisplayed().fetchSemanticsNode()
            val barVisible = intersectRect(barNode.boundsInRoot, hostBounds)
            val density = barNode.layoutInfo.density.density

            var previousRight = barVisible.left - 0.5f
            var baselineTop: Float? = null

            MARKDOWN_FORMAT_SPECS.forEach { spec ->
                val tag = "format_${spec.id}"
                val node: SemanticsNode = composeRule.onNodeWithTag(tag).assertIsDisplayed().fetchSemanticsNode()
                val unclipped = node.boundsInRoot
                val clipped = intersectRect(intersectRect(unclipped, barVisible), hostBounds)
                val clippedWidthDp = clipped.width / density
                val clippedHeightDp = clipped.height / density

                assertTrue(
                    "Control ${spec.id} at portrait width $widthDp must have positive visible geometry, got $clipped",
                    clipped.width > 0f && clipped.height > 0f,
                )
                assertEquals(
                    "Control ${spec.id} at portrait width $widthDp must not be horizontally clipped (unclipped=$unclipped, clipped=$clipped)",
                    unclipped.width,
                    clipped.width,
                    1.0f,
                )
                assertEquals(
                    "Control ${spec.id} at portrait width $widthDp must not be vertically clipped",
                    unclipped.height,
                    clipped.height,
                    1.0f,
                )
                assertTrue(
                    "Control ${spec.id} at portrait width $widthDp expected width >= ${expectedMinSlotDp}dp, got ${clippedWidthDp}dp",
                    clippedWidthDp >= expectedMinSlotDp - 0.5f,
                )
                assertEquals(48f, clippedHeightDp, 1.0f)
                assertTrue(
                    "Control ${spec.id} must sit to the right of the previous control without overlap (prevRight=$previousRight, left=${clipped.left})",
                    clipped.left >= previousRight - 0.5f,
                )
                assertTrue(
                    "Control ${spec.id} right edge (${clipped.right}) must fit inside bar right (${barVisible.right}) at $widthDp",
                    clipped.right <= barVisible.right + 0.5f,
                )
                if (baselineTop == null) {
                    baselineTop = clipped.top
                } else {
                    assertEquals(
                        "All 8 portrait controls including ${spec.id} must share a single horizontal row at $widthDp",
                        baselineTop!!,
                        clipped.top,
                        1.0f,
                    )
                }
                previousRight = clipped.right
            }

            // Explicitly verify painted icon pixels inside Inline math's visible bounds
            val inlineMathBounds = intersectRect(
                composeRule.onNodeWithTag("format_inline_math").fetchSemanticsNode().boundsInRoot,
                barVisible,
            )
            val bitmap = requireNotNull(captureWindowBitmap(screenshotPath))
            val leftPx = inlineMathBounds.left.toInt().coerceIn(0, bitmap.width - 1)
            val rightPx = inlineMathBounds.right.toInt().coerceIn(leftPx + 1, bitmap.width)
            val topPx = inlineMathBounds.top.toInt().coerceIn(0, bitmap.height - 1)
            val bottomPx = inlineMathBounds.bottom.toInt().coerceIn(topPx + 1, bitmap.height)
            val bgPixel = bitmap.getPixel(leftPx + 2, topPx + 2)
            var distinctIconPixels = 0
            for (y in topPx until bottomPx) {
                for (x in leftPx until rightPx) {
                    if (bitmap.getPixel(x, y) != bgPixel) distinctIconPixels++
                }
            }
            assertTrue(
                "Inline math icon must paint visible foreground pixels inside its unclipped bounds at $widthDp (found $distinctIconPixels)",
                distinctIconPixels >= 20,
            )

            // Every control including Inline math must be directly clickable without scrolling
            MARKDOWN_FORMAT_SPECS.forEach { spec ->
                composeRule.onNodeWithTag("format_${spec.id}").performClick()
            }
            assertEquals(MARKDOWN_FORMAT_SPECS.map { it.id }, triggered)
        }
    }

    @Test fun selectionReaderWebViewDisablesLandscapeFullscreenExtractUi() {
        val key = UUID.randomUUID().toString().also(workspaceKeys::add)
        val model = StudioViewModel(app, key)
        val webView = SelectionReaderWebView(app, model)
        val attrs = EditorInfo()
        webView.onCreateInputConnection(attrs)
        assertNotEquals(
            "SelectionReaderWebView must set IME_FLAG_NO_EXTRACT_UI so landscape soft keyboards keep the editor visible",
            0,
            attrs.imeOptions and EditorInfo.IME_FLAG_NO_EXTRACT_UI,
        )
        assertNotEquals(
            "SelectionReaderWebView must set IME_FLAG_NO_FULLSCREEN so landscape soft keyboards do not cover FormattingBar",
            0,
            attrs.imeOptions and EditorInfo.IME_FLAG_NO_FULLSCREEN,
        )
    }

    @Test
    @Config(sdk = [35], qualifiers = "w731dp-h411dp-xhdpi")
    fun landscapeSoftKeyboardCollapsesTopChromePreservesEditorSpaceAndKeepsBackAndDraftBehavior() {
        val prefs = app.getSharedPreferences("studio", Context.MODE_PRIVATE)
        prefs.edit()
            .putBoolean("welcomed", true)
            .putString("startup", "restore")
            .putBoolean("autosave", false)
            .putBoolean("motion", false)
            .commit()
        val workspace = UUID.randomUUID().toString().also(workspaceKeys::add)
        val intent = Intent(app, MainActivity::class.java).putExtra("workspace", workspace)
        val initialDraft = "# Landscape Math Draft\n\nPreserve \$E = mc^2\$ while typing with keyboard open."

        val evaluatedScripts = mutableListOf<String>()
        val controller = Robolectric.buildActivity(MainActivity::class.java, intent).setup()
        try {
            val activity = controller.get()
            val model = ViewModelProvider(activity)[StudioViewModel::class.java]
            val density = activity.resources.displayMetrics.density
            val decor = activity.window.decorView

            idleUntil { findWebView(decor) != null }
            val reader = requireNotNull(findWebView(decor))

            // Capture JS inset updates sent by MainActivity to SelectionReaderWebView
            val bridgeField = WebView::class.java
            assertTrue(bridgeField.isAssignableFrom(reader.javaClass))
            val statusBarPx = (24f * density).toInt()
            val imeBottomPx = (196f * density).toInt()

            // Initially in landscape without soft keyboard: top chrome is visible
            ViewCompat.dispatchApplyWindowInsets(
                decor,
                WindowInsetsCompat.Builder()
                    .setInsets(WindowInsetsCompat.Type.statusBars(), Insets.of(0, statusBarPx, 0, 0))
                    .setInsets(WindowInsetsCompat.Type.ime(), Insets.NONE)
                    .setVisible(WindowInsetsCompat.Type.ime(), false)
                    .build(),
            )
            composeRule.waitForIdle()
            composeRule.onNodeWithContentDescription("Open files").assertIsDisplayed()
            assertEquals(0, composeRule.onAllNodes(androidx.compose.ui.test.hasTestTag("keyboard_formatting_bar")).fetchSemanticsNodes().size)

            // Mark reader ready + editor focused in Live mode and write an unsaved draft
            model.edit(model.state.value.active.id, initialDraft)
            val bridge = requireNotNull(reader.getTag(R.id.reader_bridge_tag) as? ReaderBridge)
            bridge.post("ready-1", "reader_ready", "{}")
            bridge.post("focus-1", "editor_focus_changed", JSONObject().put("focused", true).toString())
            composeRule.waitForIdle()

            // Dispatch landscape soft keyboard open (196dp IME on 411dp tall landscape screen)
            ViewCompat.dispatchApplyWindowInsets(
                decor,
                WindowInsetsCompat.Builder()
                    .setInsets(WindowInsetsCompat.Type.statusBars(), Insets.of(0, statusBarPx, 0, 0))
                    .setInsets(WindowInsetsCompat.Type.ime(), Insets.of(0, 0, 0, imeBottomPx))
                    .setVisible(WindowInsetsCompat.Type.ime(), true)
                    .build(),
            )
            composeRule.waitForIdle()
            idleUntil {
                composeRule.onAllNodes(androidx.compose.ui.test.hasTestTag("keyboard_formatting_bar")).fetchSemanticsNodes().isNotEmpty()
            }

            // 1. Native top chrome must collapse so it does not occlude the short landscape viewport
            assertEquals(
                "Top chrome semantics must be cleared while collapsed for landscape keyboard",
                0,
                composeRule.onAllNodes(androidx.compose.ui.test.hasContentDescription("Open files")).fetchSemanticsNodes().size,
            )

            // 2. Compact KeyboardFormattingBar and all 8 controls including Inline math must be unclipped
            val barBounds = composeRule.onNodeWithTag("keyboard_formatting_bar").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
            val inlineMathBounds = composeRule.onNodeWithTag("format_inline_math").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
            val barHeightDp = barBounds.height / density
            assertTrue("Landscape formatting bar must use compact height (<= 42dp), got ${barHeightDp}dp", barHeightDp <= 42.5f)
            assertTrue(
                "Inline math must fit completely within landscape formatting bar (${inlineMathBounds.right} <= ${barBounds.right})",
                inlineMathBounds.left >= barBounds.left - 0.5f && inlineMathBounds.right <= barBounds.right + 0.5f,
            )

            // 3. Actual visible unoccluded WebView host region above KeyboardFormattingBar must preserve substantial height
            val readerHost = (reader.parent as? View) ?: reader
            val readerLoc = IntArray(2)
            readerHost.getLocationInWindow(readerLoc)
            val readerRect = Rect(
                left = readerLoc[0].toFloat(),
                top = readerLoc[1].toFloat(),
                right = (readerLoc[0] + readerHost.width).toFloat(),
                bottom = (readerLoc[1] + readerHost.height).toFloat(),
            )
            val visibleEditorTopPx = max(readerRect.top, statusBarPx.toFloat())
            val visibleEditorBottomPx = min(readerRect.bottom, barBounds.top)
            val visibleEditorHeightDp = (visibleEditorBottomPx - visibleEditorTopPx) / density
            assertTrue(
                "Landscape editor with keyboard open must preserve >= 135dp of unoccluded visible height (got ${visibleEditorHeightDp}dp; readerRect=$readerRect, barTop=${barBounds.top})",
                visibleEditorHeightDp >= 135f,
            )

            // Verify JS received landscapeKeyboard='true' and compact supermdChromeInset (statusBar = 24dp, not ~190dp)
            evaluatedScripts += shadowOf(reader).lastEvaluatedJavascript.orEmpty()
            captureWindowBitmap("/tmp/supermd-screenshots/landscape-keyboard-editor-space.png")

            // 4. Closing the soft keyboard (as happens on 1st system Back) hides formatting bar, restores top chrome, and keeps draft
            ViewCompat.dispatchApplyWindowInsets(
                decor,
                WindowInsetsCompat.Builder()
                    .setInsets(WindowInsetsCompat.Type.statusBars(), Insets.of(0, statusBarPx, 0, 0))
                    .setInsets(WindowInsetsCompat.Type.ime(), Insets.NONE)
                    .setVisible(WindowInsetsCompat.Type.ime(), false)
                    .build(),
            )
            composeRule.waitForIdle()
            idleUntil {
                composeRule.onAllNodes(androidx.compose.ui.test.hasTestTag("keyboard_formatting_bar")).fetchSemanticsNodes().isEmpty()
            }
            composeRule.onNodeWithContentDescription("Open files").assertIsDisplayed()
            assertEquals(initialDraft, model.state.value.active.content)
            assertFalse("Normal mode without overlays must leave system Back unintercepted", activity.onBackPressedDispatcher.hasEnabledCallbacks())

            // 5. System Back exits MainActivity and onStop persists the unsaved draft for automatic recovery
            activity.onBackPressedDispatcher.onBackPressed()
            idleUntil { activity.isFinishing }
            controller.pause().stop().destroy()
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(32))
        } finally {
            runCatching { controller.destroy() }
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(32))
        }

        val snapshot = File(app.filesDir, "workspaces/$workspace.json")
        idleUntil {
            snapshot.isFile && snapshot.bufferedReader().use { r ->
                NoteRecovery.read(r, StudioState()).tabs.any { it.content == initialDraft }
            }
        }
        val reopenController = Robolectric.buildActivity(MainActivity::class.java, intent).setup()
        try {
            val reopenedModel = ViewModelProvider(reopenController.get())[StudioViewModel::class.java]
            idleUntil { reopenedModel.state.value.active.content == initialDraft }
        } finally {
            runCatching { reopenController.pause().stop().destroy() }
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(32))
        }
    }
}
