package dev.supermd.studio

import android.app.Application
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.os.ParcelFileDescriptor
import android.provider.Settings
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.webkit.WebView
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.max
import kotlin.math.min
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class FormattingAndKeyboardLayoutTest {
    @get:Rule val composeRule = createEmptyComposeRule()

    private lateinit var app: Application
    private var previousWelcomed: Boolean? = null
    private var previousStartup: String? = null
    private var previousAutosave: Boolean? = null
    private var previousMotion: Boolean? = null
    private var previousShowImeWithHardware: Int? = null
    private val workspaces = mutableListOf<String>()

    @Before fun setUp() {
        app = ApplicationProvider.getApplicationContext()
        val prefs = app.getSharedPreferences("studio", Context.MODE_PRIVATE)
        if (prefs.contains("welcomed")) previousWelcomed = prefs.getBoolean("welcomed", false)
        if (prefs.contains("startup")) previousStartup = prefs.getString("startup", "restore")
        if (prefs.contains("autosave")) previousAutosave = prefs.getBoolean("autosave", true)
        if (prefs.contains("motion")) previousMotion = prefs.getBoolean("motion", true)
        prefs.edit()
            .putBoolean("welcomed", true)
            .putString("startup", "restore")
            .putBoolean("autosave", false)
            .putBoolean("motion", false)
            .commit()

        previousShowImeWithHardware = Settings.Secure.getInt(app.contentResolver, "show_ime_with_hard_keyboard", 0)
        shellOutput("settings put secure show_ime_with_hard_keyboard 1")
        waitUntil(5_000) {
            Settings.Secure.getInt(app.contentResolver, "show_ime_with_hard_keyboard", 0) == 1
        }
    }

    @After fun tearDown() {
        previousShowImeWithHardware?.let { previous ->
            runCatching { shellOutput("settings put secure show_ime_with_hard_keyboard $previous") }
            previousShowImeWithHardware = null
        }
        val prefs = app.getSharedPreferences("studio", Context.MODE_PRIVATE)
        prefs.edit().apply {
            if (previousWelcomed == null) remove("welcomed") else putBoolean("welcomed", previousWelcomed!!)
            if (previousStartup == null) remove("startup") else putString("startup", previousStartup)
            if (previousAutosave == null) remove("autosave") else putBoolean("autosave", previousAutosave!!)
            if (previousMotion == null) remove("motion") else putBoolean("motion", previousMotion!!)
        }.commit()
        workspaces.forEach { key ->
            File(app.filesDir, "workspaces/$key.json").delete()
            File(app.filesDir, "workspaces/$key").deleteRecursively()
        }
    }

    @Test fun portraitFitsAllFormattingControlsIncludingInlineMathAndLandscapeKeyboardPreservesEditorSpaceAndBack() {
        val workspace = UUID.randomUUID().toString().also(workspaces::add)
        val initial = "# Formatting Geometry\n\nFourier transform in note."
        val afterPortraitMath = "# Formatting Geometry\n\n\$Fourier\$ transform in note."
        val afterLandscapeBold = "# Formatting Geometry\n\n\$Fourier\$ **transform** in note."

        ActivityScenario.launch<MainActivity>(
            Intent(app, MainActivity::class.java).putExtra("workspace", workspace),
        ).use { scenario ->
            try {
                awaitReaderReady(scenario)
                setOrientationAndWait(scenario, ActivityInfo.SCREEN_ORIENTATION_PORTRAIT, Configuration.ORIENTATION_PORTRAIT)

                scenario.onActivity { activity ->
                    val model = ViewModelProvider(activity)[StudioViewModel::class.java]
                    if (model.state.value.mode != "editor") model.mode("editor")
                }
                waitUntil { modelState(scenario).let { it.mode == "editor" && it.message == null } }

                scenario.onActivity { activity ->
                    val model = ViewModelProvider(activity)[StudioViewModel::class.java]
                    model.edit(model.state.value.active.id, initial)
                }
                waitUntil { isReaderSynchronized(scenario, initial) }
                javascriptUntil(scenario, "Boolean(document.querySelector('.cm-editor .cm-content'))") { it == "true" }

                // Focus Source editor and open soft keyboard in portrait
                focusSourceEditorAndSelectWord(scenario, "Fourier")
                showSoftKeyboardAndWait(scenario)
                waitUntil {
                    composeRule.onAllNodes(hasTestTag("keyboard_formatting_bar")).fetchSemanticsNodes().isNotEmpty()
                }

                // 1. Portrait visible geometry: all 8 controls including Inline math fit completely inside the window
                assertAllFormattingControlsFitVisibly(scenario, "portrait")

                // Tap Inline math directly from the visible portrait formatting bar
                composeRule.onNodeWithTag("format_inline_math").performClick()
                waitUntil { isReaderSynchronized(scenario, afterPortraitMath) }

                // 2. Rotate to landscape with editor focused and soft keyboard open
                val isCompactPhone = AtomicBoolean(true)
                scenario.onActivity { activity ->
                    isCompactPhone.set(activity.resources.configuration.smallestScreenWidthDp < 600)
                }
                setOrientationAndWait(scenario, ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE, Configuration.ORIENTATION_LANDSCAPE)
                javascriptUntil(scenario, "innerWidth > innerHeight") { it == "true" }
                focusSourceEditorAndSelectWord(scenario, "transform")
                showSoftKeyboardAndWait(scenario)
                waitUntil {
                    composeRule.onAllNodes(hasTestTag("keyboard_formatting_bar")).fetchSemanticsNodes().isNotEmpty()
                }

                assertAllFormattingControlsFitVisibly(scenario, "landscape-source")

                if (isCompactPhone.get()) {
                    // Native top chrome must collapse so it does not cover the short landscape viewport
                    waitUntil {
                        composeRule.onAllNodes(hasContentDescription("Open files")).fetchSemanticsNodes().isEmpty()
                    }
                    javascriptUntil(scenario, "document.documentElement.dataset.landscapeKeyboard") { it == "true" }

                    // Measure actual visible unoccluded Source editor height between status bar and formatting bar
                    assertUnoccludedEditorGeometryInLandscape(scenario, ".cm-editor")
                }

                // Tapping Bold in landscape applies Markdown formatting while preserving existing Inline math draft
                composeRule.onNodeWithTag("format_bold").performClick()
                waitUntil { isReaderSynchronized(scenario, afterLandscapeBold) }

                // Also verify Live mode active block geometry in landscape with soft keyboard open
                hideSoftKeyboardAndWait(scenario)
                if (isCompactPhone.get()) {
                    // Closing IME automatically restores landscape header chrome without losing draft
                    waitUntil {
                        composeRule.onAllNodes(hasContentDescription("Open files")).fetchSemanticsNodes().isNotEmpty()
                    }
                    javascriptUntil(scenario, "document.documentElement.dataset.landscapeKeyboard") { it == "false" }
                }

                scenario.onActivity { activity ->
                    val model = ViewModelProvider(activity)[StudioViewModel::class.java]
                    model.mode("live")
                }
                waitUntil { modelState(scenario).let { it.mode == "live" && it.message == null } }
                javascriptUntil(scenario, "Boolean(document.querySelector('.live-document'))") { it == "true" }

                openFirstLiveBlockForEditing(scenario)
                showSoftKeyboardAndWait(scenario)
                waitUntil {
                    composeRule.onAllNodes(hasTestTag("keyboard_formatting_bar")).fetchSemanticsNodes().isNotEmpty()
                }
                assertAllFormattingControlsFitVisibly(scenario, "landscape-live")
                if (isCompactPhone.get()) {
                    waitUntil {
                        composeRule.onAllNodes(hasContentDescription("Open files")).fetchSemanticsNodes().isEmpty()
                    }
                    assertUnoccludedEditorGeometryInLandscape(scenario, ".live-active-block textarea")
                }

                // Close IME & active Live block, return to portrait, and verify existing Back + draft behavior
                hideSoftKeyboardAndWait(scenario)
                javascriptUntil(scenario, "(() => { document.querySelector('.live-active-block textarea')?.blur(); return !document.querySelector('.live-active-block textarea'); })()") {
                    it == "true"
                }
                setOrientationAndWait(scenario, ActivityInfo.SCREEN_ORIENTATION_PORTRAIT, Configuration.ORIENTATION_PORTRAIT)
                waitUntil {
                    composeRule.onAllNodes(hasContentDescription("Open files")).fetchSemanticsNodes().isNotEmpty() &&
                        isReaderSynchronized(scenario, afterLandscapeBold)
                }

                // Verify fullscreen Back exits fullscreen while keeping draft, and next normal-mode Back exits Activity & persists recovery
                scenario.onActivity { activity ->
                    ViewModelProvider(activity)[StudioViewModel::class.java].fullscreen(true)
                }
                waitUntil { modelState(scenario).fullscreen }
                scenario.onActivity { activity ->
                    activity.onBackPressedDispatcher.onBackPressed()
                }
                waitUntil { !modelState(scenario).fullscreen && modelState(scenario).active.content == afterLandscapeBold }
                assertEquals(Lifecycle.State.RESUMED, scenario.state)

                pressSystemBackAndAwaitExit(scenario)
            } finally {
                runCatching {
                    scenario.onActivity { activity ->
                        activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                    }
                }
            }
        }

        awaitWorkspaceSnapshot(workspace, afterLandscapeBold)
        ActivityScenario.launch<MainActivity>(
            Intent(app, MainActivity::class.java).putExtra("workspace", workspace),
        ).use { reopened ->
            awaitReaderReady(reopened)
            waitUntil {
                modelState(reopened).active.content == afterLandscapeBold &&
                    isReaderSynchronized(reopened, afterLandscapeBold)
            }
        }
    }

    private fun assertAllFormattingControlsFitVisibly(scenario: ActivityScenario<MainActivity>, phase: String) {
        val windowMetrics = AtomicReference<Triple<Float, Float, Float>>()
        scenario.onActivity { activity ->
            val decor = activity.window.decorView
            val insets = ViewCompat.getRootWindowInsets(decor)
            val imeBottom = insets?.getInsets(WindowInsetsCompat.Type.ime())?.bottom ?: 0
            windowMetrics.set(
                Triple(
                    decor.width.toFloat(),
                    (decor.height - imeBottom).toFloat(),
                    activity.resources.displayMetrics.density,
                ),
            )
        }
        val (windowWidthPx, visibleWindowBottomPx, density) = requireNotNull(windowMetrics.get())
        val windowBounds = Rect(0f, 0f, windowWidthPx, visibleWindowBottomPx)

        val barBounds = composeRule.onNodeWithTag("keyboard_formatting_bar").assertIsDisplayed().fetchSemanticsNode().boundsInWindow
        val clippedBar = intersectRect(barBounds, windowBounds)
        assertTrue(
            "Formatting bar must be visible above IME in $phase (bar=$barBounds, window=$windowBounds)",
            clippedBar.width > 0f && clippedBar.height > 0f,
        )

        var previousRight = clippedBar.left - 1.0f
        MARKDOWN_FORMAT_SPECS.forEach { spec ->
            val buttonBounds = composeRule.onNodeWithTag("format_${spec.id}").assertIsDisplayed().fetchSemanticsNode().boundsInWindow
            val clipped = intersectRect(intersectRect(buttonBounds, clippedBar), windowBounds)
            val widthDp = clipped.width / density
            val heightDp = clipped.height / density
            assertTrue(
                "Control ${spec.id} in $phase must have unclipped positive visible bounds (button=$buttonBounds, clipped=$clipped, bar=$clippedBar)",
                clipped.width >= buttonBounds.width - 1.5f && clipped.height >= buttonBounds.height - 1.5f,
            )
            assertTrue(
                "Control ${spec.id} in $phase must have visible width >= 39dp and height >= 39dp, got ${widthDp}dp x ${heightDp}dp",
                widthDp >= 39f && heightDp >= 39f,
            )
            assertTrue(
                "Control ${spec.id} in $phase must be ordered without horizontal overlap (prevRight=$previousRight, left=${clipped.left})",
                clipped.left >= previousRight - 1.5f,
            )
            assertTrue(
                "Control ${spec.id} in $phase must fit inside formatting bar right edge (${clipped.right} <= ${clippedBar.right})",
                clipped.right <= clippedBar.right + 1.5f,
            )
            previousRight = clipped.right
        }
    }

    private fun assertUnoccludedEditorGeometryInLandscape(
        scenario: ActivityScenario<MainActivity>,
        selector: String,
    ) {
        val barTopPx = composeRule.onNodeWithTag("keyboard_formatting_bar").fetchSemanticsNode().boundsInWindow.top
        val nativeMetrics = AtomicReference<JSONObject>()
        scenario.onActivity { activity ->
            val decor = activity.window.decorView
            val reader = requireNotNull(findWebView(decor))
            val loc = IntArray(2)
            reader.getLocationInWindow(loc)
            val statusTopPx = ViewCompat.getRootWindowInsets(decor)
                ?.getInsets(WindowInsetsCompat.Type.statusBars())?.top ?: 0
            nativeMetrics.set(
                JSONObject()
                    .put("readerTopPx", loc[1].toDouble())
                    .put("readerBottomPx", (loc[1] + reader.height).toDouble())
                    .put("statusTopPx", statusTopPx.toDouble())
                    .put("density", activity.resources.displayMetrics.density.toDouble()),
            )
        }
        val metrics = requireNotNull(nativeMetrics.get())
        val density = metrics.getDouble("density").toFloat()
        val readerTopPx = metrics.getDouble("readerTopPx").toFloat()
        val readerBottomPx = metrics.getDouble("readerBottomPx").toFloat()
        val statusTopPx = metrics.getDouble("statusTopPx").toFloat()

        val domRaw = javascriptUntil(
            scenario,
            """(() => {
                const el = document.querySelector(${JSONObject.quote(selector)});
                if (!el) return null;
                const r = el.getBoundingClientRect();
                const inset = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--native-chrome-inset')) || 0;
                return JSON.stringify({ top: r.top, bottom: r.bottom, width: r.width, height: r.height, chromeInset: inset, innerHeight: window.innerHeight });
            })()""",
        ) { it != "null" && it.contains("chromeInset") }
        val dom = JSONObject(domRaw)
        val chromeInsetDp = dom.getDouble("chromeInset").toFloat()
        assertTrue(
            "Landscape keyboard chrome inset must collapse to safe top inset (<= 48dp), got ${chromeInsetDp}dp ($dom)",
            chromeInsetDp <= 48f,
        )

        val domTopWindowPx = readerTopPx + dom.getDouble("top").toFloat() * density
        val domBottomWindowPx = readerTopPx + dom.getDouble("bottom").toFloat() * density
        val visibleTopPx = max(max(readerTopPx, statusTopPx), domTopWindowPx)
        val visibleBottomPx = min(min(readerBottomPx, barTopPx), domBottomWindowPx)
        val visibleHeightDp = (visibleBottomPx - visibleTopPx) / density
        assertTrue(
            "Expected >= 64dp of unoccluded visible editor height for $selector in landscape with keyboard open, got ${visibleHeightDp}dp (dom=$dom, native=$metrics, barTopPx=$barTopPx)",
            visibleHeightDp >= 64f,
        )
    }

    private fun focusSourceEditorAndSelectWord(scenario: ActivityScenario<MainActivity>, word: String) {
        scenario.onActivity { activity ->
            findWebView(activity.window.decorView)?.requestFocus(View.FOCUS_DOWN)
        }
        javascriptUntil(
            scenario,
            """(() => {
                const content = document.querySelector('.cm-editor .cm-content');
                if (!content) return false;
                content.focus();
                const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
                let node;
                while ((node = walker.nextNode())) {
                    const text = node.nodeValue || '';
                    const idx = text.indexOf(${JSONObject.quote(word)});
                    if (idx >= 0) {
                        const sel = window.getSelection();
                        const range = document.createRange();
                        range.setStart(node, idx);
                        range.setEnd(node, idx + ${word.length});
                        sel.removeAllRanges();
                        sel.addRange(range);
                        return document.activeElement === content || content.contains(document.activeElement);
                    }
                }
                return false;
            })()""",
        ) { it == "true" }
        waitUntil { modelState(scenario).editorFocused }
    }

    private fun openFirstLiveBlockForEditing(scenario: ActivityScenario<MainActivity>) {
        scenario.onActivity { activity ->
            findWebView(activity.window.decorView)?.requestFocus(View.FOCUS_DOWN)
        }
        javascriptUntil(
            scenario,
            """(() => {
                const existing = document.querySelector('.live-active-block textarea');
                if (existing) { existing.focus(); return document.activeElement === existing; }
                const block = [...document.querySelectorAll('.live-block')].find(el => (el.textContent || '').includes('Fourier'));
                if (!block) return false;
                const start = Number(block.getAttribute('data-source-start') || '0');
                const end = Number(block.getAttribute('data-source-end') || '0');
                window.dispatchEvent(new CustomEvent('supermd-edit-block', { detail: { start, end } }));
                const area = document.querySelector('.live-active-block textarea');
                if (area) area.focus();
                return !!area && document.activeElement === area;
            })()""",
        ) { it == "true" }
        waitUntil { modelState(scenario).editorFocused }
    }

    private fun showSoftKeyboardAndWait(scenario: ActivityScenario<MainActivity>) {
        val deadline = System.currentTimeMillis() + 15_000
        while (System.currentTimeMillis() < deadline) {
            if (isImeVisible(scenario)) return
            scenario.onActivity { activity ->
                val decor = activity.window.decorView
                val reader = findWebView(decor) ?: decor
                reader.requestFocus(View.FOCUS_DOWN)
                val imm = activity.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
                imm.showSoftInput(reader, 0)
                WindowCompat.getInsetsController(activity.window, reader).show(WindowInsetsCompat.Type.ime())
            }
            InstrumentationRegistry.getInstrumentation().waitForIdleSync()
            if (isImeVisible(scenario)) return
            Thread.sleep(100)
        }
        assertTrue("Soft keyboard (IME) did not become visible within 15s", isImeVisible(scenario))
    }

    private fun hideSoftKeyboardAndWait(scenario: ActivityScenario<MainActivity>) {
        val deadline = System.currentTimeMillis() + 10_000
        while (System.currentTimeMillis() < deadline) {
            if (!isImeVisible(scenario)) return
            scenario.onActivity { activity ->
                val decor = activity.window.decorView
                val reader = findWebView(decor) ?: decor
                val imm = activity.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
                imm.hideSoftInputFromWindow(reader.windowToken, 0)
                WindowCompat.getInsetsController(activity.window, reader).hide(WindowInsetsCompat.Type.ime())
            }
            InstrumentationRegistry.getInstrumentation().waitForIdleSync()
            if (!isImeVisible(scenario)) return
            Thread.sleep(100)
        }
        assertFalse("Soft keyboard (IME) remained visible after 10s", isImeVisible(scenario))
    }

    private fun isImeVisible(scenario: ActivityScenario<MainActivity>): Boolean {
        val visible = AtomicBoolean(false)
        scenario.onActivity { activity ->
            val insets = ViewCompat.getRootWindowInsets(activity.window.decorView)
            val imeBottom = insets?.getInsets(WindowInsetsCompat.Type.ime())?.bottom ?: 0
            visible.set(imeBottom > 0)
        }
        return visible.get()
    }

    private fun setOrientationAndWait(
        scenario: ActivityScenario<MainActivity>,
        requested: Int,
        expectedConfigOrientation: Int,
    ) {
        scenario.onActivity { activity ->
            activity.requestedOrientation = requested
        }
        waitUntil(15_000) {
            val matched = AtomicBoolean(false)
            scenario.onActivity { activity ->
                matched.set(activity.resources.configuration.orientation == expectedConfigOrientation)
            }
            matched.get()
        }
    }

    private fun pressSystemBackAndAwaitExit(scenario: ActivityScenario<MainActivity>) {
        scenario.onActivity { activity ->
            assertFalse(
                "Studio BackHandler must be disabled in normal mode so system Back reaches Activity",
                activity.onBackPressedDispatcher.hasEnabledCallbacks(),
            )
            activity.onBackPressedDispatcher.onBackPressed()
        }
        val deadline = System.currentTimeMillis() + 10_000
        while (System.currentTimeMillis() < deadline) {
            InstrumentationRegistry.getInstrumentation().waitForIdleSync()
            if (scenario.state != Lifecycle.State.RESUMED) return
            Thread.sleep(25)
        }
        assertNotResumed(scenario)
    }

    private fun assertNotResumed(scenario: ActivityScenario<MainActivity>) {
        assertTrue(
            "Expected system Back to move MainActivity out of RESUMED, but state was ${scenario.state}",
            scenario.state != Lifecycle.State.RESUMED,
        )
    }

    private fun awaitWorkspaceSnapshot(workspace: String, expectedContent: String) {
        val snapshot = File(app.filesDir, "workspaces/$workspace.json")
        waitUntil(15_000) {
            snapshot.isFile && runCatching {
                snapshot.bufferedReader().use { reader ->
                    NoteRecovery.read(reader, StudioState()).tabs.any { it.content == expectedContent }
                }
            }.getOrDefault(false)
        }
    }

    private fun intersectRect(a: Rect, b: Rect): Rect = Rect(
        left = max(a.left, b.left),
        top = max(a.top, b.top),
        right = min(a.right, b.right),
        bottom = min(a.bottom, b.bottom),
    )

    private fun modelState(scenario: ActivityScenario<MainActivity>): StudioState {
        val ref = AtomicReference<StudioState>()
        scenario.onActivity { activity ->
            ref.set(ViewModelProvider(activity)[StudioViewModel::class.java].state.value)
        }
        return requireNotNull(ref.get())
    }

    private fun isReaderSynchronized(scenario: ActivityScenario<MainActivity>, expectedContent: String? = null): Boolean {
        val synced = AtomicBoolean(false)
        scenario.onActivity { activity ->
            val model = ViewModelProvider(activity)[StudioViewModel::class.java]
            val active = model.state.value.active
            val matchesExpected = expectedContent == null || active.content == expectedContent
            synced.set(active.id.isNotEmpty() && matchesExpected && model.readerStateIsNativeAuthoritative(active.id))
        }
        return synced.get()
    }

    private fun awaitReaderReady(scenario: ActivityScenario<MainActivity>) {
        javascriptUntil(
            scenario,
            "Boolean(window.supermdLoad && window.supermdFormat && document.readyState === 'complete' && document.documentElement.dataset.platform === 'android')",
            25_000,
        ) { it == "true" }
        waitUntil(25_000) { isReaderSynchronized(scenario) }
    }

    private fun javascriptUntil(
        scenario: ActivityScenario<MainActivity>,
        script: String,
        timeoutMs: Long = 20_000,
        predicate: (String) -> Boolean,
    ): String {
        val last = AtomicReference("null")
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            val latch = CountDownLatch(1)
            scenario.onActivity { activity ->
                val reader = findWebView(activity.window.decorView)
                if (reader == null) {
                    latch.countDown()
                } else {
                    reader.evaluateJavascript(script) { raw ->
                        val decoded = if (raw != null && raw.startsWith("\"")) {
                            runCatching { JSONArray("[$raw]").getString(0) }.getOrDefault(raw)
                        } else {
                            raw ?: "null"
                        }
                        last.set(decoded)
                        latch.countDown()
                    }
                }
            }
            latch.await(10, TimeUnit.SECONDS)
            if (predicate(last.get())) return last.get()
            Thread.sleep(25)
        }
        val finalValue = last.get()
        assertTrue("Timed out waiting for JS ($script), last=$finalValue", predicate(finalValue))
        return finalValue
    }

    private fun waitUntil(timeoutMs: Long = 20_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            InstrumentationRegistry.getInstrumentation().waitForIdleSync()
            if (condition()) return
            Thread.sleep(25)
        }
        assertTrue("Condition timed out after ${timeoutMs}ms", condition())
    }

    private fun shellOutput(command: String): String {
        val descriptor = InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(command)
        return ParcelFileDescriptor.AutoCloseInputStream(descriptor).bufferedReader().use { it.readText() }
    }

    private fun findWebView(view: View): WebView? = when (view) {
        is WebView -> view
        is ViewGroup -> (0 until view.childCount).firstNotNullOfOrNull { findWebView(view.getChildAt(it)) }
        else -> null
    }
}
