package dev.supermd.studio

import android.app.Application
import android.content.Context
import android.content.Intent
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
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
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AndroidBackHandlingTest {
    private lateinit var app: Application
    private var previousWelcomed: Boolean? = null
    private var previousStartup: String? = null
    private var previousAutosave: Boolean? = null
    private val workspaces = mutableListOf<String>()

    @Before fun setUp() {
        app = ApplicationProvider.getApplicationContext()
        val prefs = app.getSharedPreferences("studio", Context.MODE_PRIVATE)
        if (prefs.contains("welcomed")) {
            previousWelcomed = prefs.getBoolean("welcomed", false)
        }
        if (prefs.contains("startup")) {
            previousStartup = prefs.getString("startup", "restore")
        }
        if (prefs.contains("autosave")) {
            previousAutosave = prefs.getBoolean("autosave", true)
        }
        prefs.edit()
            .putBoolean("welcomed", true)
            .putString("startup", "restore")
            .putBoolean("autosave", false)
            .commit()
    }

    @After fun tearDown() {
        val prefs = app.getSharedPreferences("studio", Context.MODE_PRIVATE)
        prefs.edit().apply {
            if (previousWelcomed == null) remove("welcomed") else putBoolean("welcomed", previousWelcomed!!)
            if (previousStartup == null) remove("startup") else putString("startup", previousStartup)
            if (previousAutosave == null) remove("autosave") else putBoolean("autosave", previousAutosave!!)
        }.commit()
        workspaces.forEach { key ->
            File(app.filesDir, "workspaces/$key.json").delete()
            File(app.filesDir, "workspaces/$key").deleteRecursively()
        }
    }

    @Test fun liveActiveEditBackDismissesBlockKeepingDraftAndPreservesSecondBack() {
        val workspace = UUID.randomUUID().toString().also(workspaces::add)
        val initial = "# Live Back Test\n\nOriginal live paragraph."
        val fullscreenDraft = "Edited live draft kept across Back."
        val normalDraft = "Edited live draft kept across Back. Second pass in normal mode."

        ActivityScenario.launch<MainActivity>(
            Intent(app, MainActivity::class.java).putExtra("workspace", workspace),
        ).use { scenario ->
            awaitReaderReady(scenario)
            // Switch mode/fullscreen first while the initial reader snapshot is acknowledged,
            // then edit content separately so edit() never races mode()'s reader flush barrier.
            scenario.onActivity { activity ->
                val model = ViewModelProvider(activity)[StudioViewModel::class.java]
                if (model.state.value.mode != "live") model.mode("live")
                model.fullscreen(true)
            }
            waitUntil {
                modelState(scenario).let { it.mode == "live" && it.fullscreen && it.message == null }
            }
            scenario.onActivity { activity ->
                val model = ViewModelProvider(activity)[StudioViewModel::class.java]
                model.edit(model.state.value.active.id, initial)
            }
            waitUntil { isReaderSynchronized(scenario, initial) }
            javascriptUntil(scenario, "document.querySelector('.live-document')?.textContent?.includes('Original live paragraph.')") {
                it == "true"
            }

            // Enter active Live block edit in fullscreen and write draft + uncommitted textarea tail.
            openLiveBlockAndEdit(
                scenario = scenario,
                blockSnippet = "Original live paragraph.",
                committedDraft = "Edited live draft",
                finalTextareaValue = fullscreenDraft,
            )
            waitUntil {
                modelState(scenario).readerDismissible && hasEnabledBackCallbacks(scenario)
            }

            // 1st Back in fullscreen: dismisses active Live edit, flushes & keeps draft text, stays in fullscreen.
            pressActivityBack(scenario)
            javascriptUntil(scenario, "!document.querySelector('.live-active-block textarea')") { it == "true" }
            javascriptUntil(
                scenario,
                "document.querySelector('.live-document')?.textContent?.includes(${JSONObject.quote(fullscreenDraft)})",
            ) { it == "true" }
            val expectedFullscreenMarkdown = "# Live Back Test\n\n$fullscreenDraft"
            waitUntil {
                val s = modelState(scenario)
                !s.readerDismissible && s.fullscreen && isReaderSynchronized(scenario, expectedFullscreenMarkdown)
            }
            assertEquals(Lifecycle.State.RESUMED, scenario.state)

            // 2nd Back in fullscreen: exits fullscreen while keeping draft text and Activity RESUMED.
            pressActivityBack(scenario)
            waitUntil {
                val s = modelState(scenario)
                !s.fullscreen && !s.readerDismissible && s.active.content == expectedFullscreenMarkdown
            }
            assertEquals(Lifecycle.State.RESUMED, scenario.state)

            // Re-open active Live edit in normal (non-fullscreen) mode and update uncommitted draft text.
            openLiveBlockAndEdit(
                scenario = scenario,
                blockSnippet = "Edited live draft",
                committedDraft = null,
                finalTextareaValue = normalDraft,
            )
            waitUntil {
                val s = modelState(scenario)
                s.readerDismissible && !s.readerOverlay && hasEnabledBackCallbacks(scenario)
            }

            // 1st Back in normal mode: dismisses active Live edit, keeps draft text, and disables Studio BackHandler.
            pressActivityBack(scenario)
            javascriptUntil(scenario, "!document.querySelector('.live-active-block textarea')") { it == "true" }
            val expectedNormalMarkdown = "# Live Back Test\n\n$normalDraft"
            waitUntil {
                val s = modelState(scenario)
                !s.readerDismissible && !s.readerOverlay && !s.fullscreen &&
                    isReaderSynchronized(scenario, expectedNormalMarkdown) &&
                    !hasEnabledBackCallbacks(scenario)
            }
            assertEquals(Lifecycle.State.RESUMED, scenario.state)

            // 2nd Back in normal mode: falls through to system Back, leaving RESUMED while persisting draft recovery.
            pressSystemBackAndAwaitExit(scenario)
        }

        // Wait for async recovery snapshot IO flush to finish before reopening the isolated workspace.
        val expectedRecovered = "# Live Back Test\n\n$normalDraft"
        awaitWorkspaceSnapshot(workspace, expectedRecovered)
        ActivityScenario.launch<MainActivity>(
            Intent(app, MainActivity::class.java).putExtra("workspace", workspace),
        ).use { reopened ->
            awaitReaderReady(reopened)
            waitUntil {
                val s = modelState(reopened)
                assertNull(s.error)
                s.active.content == expectedRecovered
            }
        }
    }

    @Test fun sourceSearchBackDismissesNativeFindAndCodeMirrorSearchKeepingDraftAndPreservesSecondBack() {
        val workspace = UUID.randomUUID().toString().also(workspaces::add)
        val initial = "# Source Back Test\n\nAlpha needle in source mode."
        val editedFirst = "# Source Back Test\n\nAlpha needle in source mode.\nDraft kept after Find in note."
        val editedSecond = "$editedFirst\nDraft kept after CodeMirror search and system Back."

        ActivityScenario.launch<MainActivity>(
            Intent(app, MainActivity::class.java).putExtra("workspace", workspace),
        ).use { scenario ->
            awaitReaderReady(scenario)
            // Switch to Source ("editor") mode BEFORE calling edit() so mode()'s reader flush barrier
            // validates the already-acknowledged initial snapshot rather than racing an unsent edit.
            scenario.onActivity { activity ->
                val model = ViewModelProvider(activity)[StudioViewModel::class.java]
                model.mode("editor")
                model.fullscreen(true)
            }
            waitUntil {
                modelState(scenario).let { it.mode == "editor" && it.fullscreen && it.message == null }
            }
            javascriptUntil(scenario, "!!document.querySelector('.android-source .cm-content')") { it == "true" }

            scenario.onActivity { activity ->
                val model = ViewModelProvider(activity)[StudioViewModel::class.java]
                model.edit(model.state.value.active.id, initial)
            }
            waitUntil { isReaderSynchronized(scenario, initial) }
            javascriptUntil(
                scenario,
                "document.querySelector('.android-source .cm-content')?.textContent?.includes('Alpha needle in source mode.')",
            ) { it == "true" }

            // Edit Source draft directly inside CodeMirror and open native Source Find (ReadingSearch).
            focusReaderWebView(scenario)
            appendCodeMirrorText(scenario, "\nDraft kept after Find in note.")
            waitUntil { isReaderSynchronized(scenario, editedFirst) }
            javascriptUntil(
                scenario,
                """(() => {
                    if (!document.querySelector('.reading-search input')) {
                        window.supermdFind?.('needle');
                    }
                    const input = document.querySelector('.reading-search input');
                    return Boolean(input && input.value === 'needle');
                })()""",
            ) { it == "true" }
            waitUntil {
                modelState(scenario).readerOverlay && hasEnabledBackCallbacks(scenario)
            }

            // 1st Back in fullscreen: dismisses Source Find (.reading-search), keeps draft and fullscreen.
            pressActivityBack(scenario)
            javascriptUntil(scenario, "!document.querySelector('.reading-search')") { it == "true" }
            waitUntil {
                val s = modelState(scenario)
                !s.readerOverlay && s.fullscreen && s.active.content == editedFirst
            }
            assertEquals(Lifecycle.State.RESUMED, scenario.state)

            // 2nd Back in fullscreen: exits fullscreen while keeping edited Source draft and Activity RESUMED.
            pressActivityBack(scenario)
            waitUntil {
                val s = modelState(scenario)
                !s.fullscreen && !s.readerOverlay && s.active.content == editedFirst
            }
            assertEquals(Lifecycle.State.RESUMED, scenario.state)

            // Open CodeMirror's inline .cm-search in normal Source mode, edit draft further, and blur focus outside .cm-search.
            focusReaderWebView(scenario)
            javascriptUntil(
                scenario,
                """(() => {
                    if (!document.querySelector('.cm-search')) {
                        window.dispatchEvent(new Event('supermd-find'));
                    }
                    const input = document.querySelector('.cm-search input');
                    if (!input) return false;
                    if (input.value !== 'Alpha') {
                        input.value = 'Alpha';
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                    return Boolean(document.querySelector('.cm-search'));
                })()""",
            ) { it == "true" }
            appendCodeMirrorText(scenario, "\nDraft kept after CodeMirror search and system Back.")
            waitUntil { isReaderSynchronized(scenario, editedSecond) }
            javascriptUntil(
                scenario,
                "(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); return Boolean(document.querySelector('.cm-search')); })()",
            ) { it == "true" }
            waitUntil {
                val s = modelState(scenario)
                s.readerDismissible && !s.readerOverlay && s.active.content == editedSecond && hasEnabledBackCallbacks(scenario)
            }

            // 1st Back in normal mode: dismisses .cm-search despite outside focus, keeps draft, releases BackHandler.
            pressActivityBack(scenario)
            javascriptUntil(scenario, "!document.querySelector('.cm-search')") { it == "true" }
            javascriptUntil(
                scenario,
                "document.querySelector('.cm-content')?.textContent?.includes('Draft kept after CodeMirror search and system Back.')",
            ) { it == "true" }
            waitUntil {
                val s = modelState(scenario)
                !s.readerDismissible && !s.readerOverlay && !s.fullscreen &&
                    isReaderSynchronized(scenario, editedSecond) &&
                    !hasEnabledBackCallbacks(scenario)
            }
            assertEquals(Lifecycle.State.RESUMED, scenario.state)

            // 2nd Back in normal mode: invokes system Back, leaving RESUMED while persisting the Source draft.
            pressSystemBackAndAwaitExit(scenario)
        }

        // Wait for async recovery snapshot IO flush to finish before reopening the isolated workspace.
        awaitWorkspaceSnapshot(workspace, editedSecond)
        ActivityScenario.launch<MainActivity>(
            Intent(app, MainActivity::class.java).putExtra("workspace", workspace),
        ).use { reopened ->
            awaitReaderReady(reopened)
            waitUntil {
                val s = modelState(reopened)
                assertNull(s.error)
                s.active.content == editedSecond
            }
        }
    }

    private fun openLiveBlockAndEdit(
        scenario: ActivityScenario<MainActivity>,
        blockSnippet: String,
        committedDraft: String?,
        finalTextareaValue: String,
    ) {
        focusReaderWebView(scenario)
        javascriptUntil(
            scenario,
            """(() => {
                if (document.querySelector('.live-active-block textarea')) return true;
                const block = [...document.querySelectorAll('.live-block')].find(el => el.textContent.includes(${JSONObject.quote(blockSnippet)}));
                if (!block) return false;
                block.dispatchEvent(new CustomEvent('supermd-edit-block', { bubbles: true }));
                return Boolean(document.querySelector('.live-active-block textarea'));
            })()""",
        ) { it == "true" }
        val commitStep = if (committedDraft != null) {
            """
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
            setter.call(area, ${JSONObject.quote(committedDraft)});
            area.dispatchEvent(new Event('input', { bubbles: true }));
            """.trimIndent()
        } else {
            ""
        }
        javascriptUntil(
            scenario,
            """(() => {
                const area = document.querySelector('.live-active-block textarea');
                if (!area) return false;
                area.focus({ preventScroll: true });
                $commitStep
                area.value = ${JSONObject.quote(finalTextareaValue)};
                area.setSelectionRange(area.value.length, area.value.length);
                return area.value === ${JSONObject.quote(finalTextareaValue)};
            })()""",
        ) { it == "true" }
    }

    private fun appendCodeMirrorText(scenario: ActivityScenario<MainActivity>, suffix: String) {
        val marker = suffix.trim()
        javascriptUntil(
            scenario,
            """(() => {
                const content = document.querySelector('.android-source .cm-content');
                if (!content) return false;
                if (!content.textContent.includes(${JSONObject.quote(marker)})) {
                    window.dispatchEvent(new CustomEvent('supermd-goto-offset', { detail: 1000000 }));
                    window.dispatchEvent(new CustomEvent('supermd-format', { detail: { block: true, prefix: ${JSONObject.quote(suffix)} } }));
                }
                return content.textContent.includes(${JSONObject.quote(marker)});
            })()""",
        ) { it == "true" }
    }

    private fun focusReaderWebView(scenario: ActivityScenario<MainActivity>) {
        scenario.onActivity { activity ->
            findWebView(activity.window.decorView)?.requestFocus(View.FOCUS_DOWN)
        }
        InstrumentationRegistry.getInstrumentation().waitForIdleSync()
    }

    private fun pressActivityBack(scenario: ActivityScenario<MainActivity>) {
        scenario.onActivity { activity ->
            activity.onBackPressedDispatcher.onBackPressed()
        }
        InstrumentationRegistry.getInstrumentation().waitForIdleSync()
    }

    private fun pressSystemBackAndAwaitExit(scenario: ActivityScenario<MainActivity>) {
        val finishing = AtomicBoolean(false)
        scenario.onActivity { activity ->
            assertFalse("Studio BackHandler must be disabled before second Back", activity.onBackPressedDispatcher.hasEnabledCallbacks())
            activity.onBackPressedDispatcher.onBackPressed()
            if (activity.isFinishing) finishing.set(true)
        }
        val deadline = System.currentTimeMillis() + 15_000
        while (System.currentTimeMillis() < deadline) {
            if (finishing.get() || scenario.state != Lifecycle.State.RESUMED) return
            runCatching {
                scenario.onActivity { activity ->
                    if (activity.isFinishing) finishing.set(true)
                }
            }.onFailure {
                // ActivityScenario throws when the Activity has already reached DESTROYED.
                return
            }
            Thread.sleep(25)
        }
        assertTrue(
            "Second Back must reach system Back and finish or stop MainActivity (state=${scenario.state})",
            finishing.get() || scenario.state != Lifecycle.State.RESUMED,
        )
    }

    private fun awaitWorkspaceSnapshot(workspace: String, expectedContent: String) {
        val snapshot = File(app.filesDir, "workspaces/$workspace.json")
        waitUntil(15_000) {
            runCatching {
                snapshot.isFile && snapshot.bufferedReader().use { reader ->
                    NoteRecovery.read(reader, StudioState())
                }.tabs.any { it.content == expectedContent }
            }.getOrDefault(false)
        }
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

    private fun modelState(scenario: ActivityScenario<MainActivity>): StudioState {
        val ref = AtomicReference<StudioState>()
        scenario.onActivity { activity ->
            ref.set(ViewModelProvider(activity)[StudioViewModel::class.java].state.value)
        }
        return requireNotNull(ref.get())
    }

    private fun hasEnabledBackCallbacks(scenario: ActivityScenario<MainActivity>): Boolean {
        val enabled = AtomicBoolean(false)
        scenario.onActivity { activity ->
            enabled.set(activity.onBackPressedDispatcher.hasEnabledCallbacks())
        }
        return enabled.get()
    }

    private fun awaitReaderReady(scenario: ActivityScenario<MainActivity>) {
        javascriptUntil(
            scenario,
            "Boolean(window.supermdLoad && window.supermdDismiss && document.readyState === 'complete' && document.documentElement.dataset.platform === 'android')",
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

    private fun findWebView(view: View): WebView? = when (view) {
        is WebView -> view
        is ViewGroup -> (0 until view.childCount).firstNotNullOfOrNull { findWebView(view.getChildAt(it)) }
        else -> null
    }
}
