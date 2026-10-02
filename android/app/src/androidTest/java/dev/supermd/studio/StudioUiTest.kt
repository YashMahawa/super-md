package dev.supermd.studio

import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.compose.setContent
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.util.concurrent.atomic.AtomicReference

class StudioUiTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private fun web(view: View): WebView? = if (view is WebView) view else if (view is ViewGroup) (0 until view.childCount).firstNotNullOfOrNull { web(view.getChildAt(it)) } else null
    private fun javascriptUntil(script: String, accepted: (String) -> Boolean): String {
        val result = AtomicReference("")
        compose.waitUntil(60_000) {
            compose.activity.runOnUiThread { web(compose.activity.window.decorView)?.evaluateJavascript(script) { result.set(it) } }
            accepted(result.get())
        }
        return result.get()
    }
    private fun welcome() {
        repeat(2) { if (compose.onAllNodesWithText("Continue").fetchSemanticsNodes().isNotEmpty()) compose.onNodeWithText("Continue").performClick() }
        compose.onAllNodesWithText("Explore the sample").fetchSemanticsNodes().firstOrNull()?.let { compose.onNodeWithText("Explore the sample").performClick() }
    }
    @Test fun longPressReordersNativeTabsAndKeepsTheActiveDraft() {
        val first = Note(name = "First.md", content = "First unsaved draft")
        val second = Note(name = "Second.smd", content = "Second unsaved draft", assetDirectory = "images")
        val notes = mutableStateOf(listOf(first, second))
        compose.runOnIdle {
            compose.activity.setContent { androidx.compose.material3.MaterialTheme {
                NoteTabs(notes.value, second.id, true, {}, {}, { id, index -> notes.value = reorderedNotes(notes.value, id, index) }, {})
            } }
        }
        compose.waitForIdle()
        val start = compose.onNodeWithText("• Second.smd").fetchSemanticsNode().boundsInRoot.center
        val end = compose.onNodeWithText("• First.md").fetchSemanticsNode().boundsInRoot.center
        compose.onRoot().performTouchInput {
            down(start); advanceEventTime(650); moveTo(start); moveTo(end, delayMillis = 350); up()
        }
        compose.waitUntil(5000) { notes.value.first().id == second.id }
        assertSame(second, notes.value.first())
        assertEquals("Second unsaved draft", notes.value.first().content)
        assertEquals("images", notes.value.first().assetDirectory)
    }
    @Test fun newWindowHasIndependentTaskAndDraftRecovery() {
        welcome()
        val first = androidx.lifecycle.ViewModelProvider(compose.activity)[StudioViewModel::class.java]
        val initial = first.state.value.active.id
        val original = first.state.value.active.content
        compose.runOnIdle { first.edit(initial, "First window remains intact"); compose.activity.newWindow() }
        var other: MainActivity? = null
        compose.waitUntil(10_000) {
            androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().runOnMainSync {
                other = androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(androidx.test.runner.lifecycle.Stage.RESUMED).filterIsInstance<MainActivity>().firstOrNull { it !== compose.activity }
            }
            other != null
        }
        val second = androidx.lifecycle.ViewModelProvider(other!!)[StudioViewModel::class.java]
        assertNotEquals(compose.activity.taskId, other!!.taskId)
        assertNotEquals(first.workspaceKey, second.workspaceKey)
        androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().runOnMainSync {
            second.edit(second.state.value.active.id, "Second window draft")
            first.flush(); second.flush()
        }
        val files = compose.activity.filesDir
        val recovery = java.io.File(files, "workspaces/${second.workspaceKey}.json")
        compose.waitUntil(5000) { recovery.isFile && recovery.readText().contains("Second window draft") && java.io.File(files, "workspace.json").readText().contains("First window remains intact") }
        assertEquals("First window remains intact", first.state.value.active.content)
        assertEquals("Second window draft", second.state.value.active.content)
        androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().runOnMainSync { first.edit(initial, original); other!!.finishAndRemoveTask() }
    }
    @Test fun shareUsesTheSamePdfOptionsAndARestrictedSystemUri() {
        welcome()
        compose.onNodeWithContentDescription("More actions").performClick()
        compose.onNodeWithText("Share note").performClick()
        compose.onNodeWithText("Share your note").assertIsDisplayed()
        compose.onNodeWithText("Page numbers").assertExists()
        val model = androidx.lifecycle.ViewModelProvider(compose.activity)[StudioViewModel::class.java]
        val result = AtomicReference<android.content.Intent>()
        compose.runOnIdle { model.shareReady = { result.set(it) } }
        // The primary action stays visible below the scrolling options on
        // compact displays; a semantics-only click must not hide that bug.
        compose.onNodeWithText("Prepare & share").assertIsDisplayed().performClick()
        compose.waitUntil(60_000) {
            assertNull("Share failed: ${model.state.value.error}", model.state.value.error)
            result.get() != null
        }
        val intent = result.get()
        assertEquals(android.content.Intent.ACTION_SEND, intent.action)
        assertEquals("application/pdf", intent.type)
        val uri = intent.getParcelableExtra<android.net.Uri>(android.content.Intent.EXTRA_STREAM)!!
        assertEquals("content", uri.scheme)
        assertEquals("dev.supermd.studio.share", uri.authority)
        assertTrue(intent.flags and android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
        compose.activity.contentResolver.openInputStream(uri)!!.use { input -> assertEquals("%PDF", String(ByteArray(4).also { input.read(it) })) }
        assertNull(model.state.value.error)
    }
    @Test fun realReaderAndNativeControlsAreConnected() {
        repeat(2) { if (compose.onAllNodesWithText("Continue").fetchSemanticsNodes().isNotEmpty()) compose.onNodeWithText("Continue").performClick() }
        compose.onAllNodesWithText("Explore the sample").fetchSemanticsNodes().firstOrNull()?.let { compose.onNodeWithText("Explore the sample").performClick() }
        compose.onNodeWithText("Read", useUnmergedTree = true).performClick()
        val result = javascriptUntil("({math:document.querySelectorAll('.katex').length,callouts:document.querySelectorAll('.callout-tip').length,graphs:document.querySelectorAll('.interactive-chart svg').length,errors:document.querySelectorAll('.katex-error').length})") { it.contains("\"callouts\":1") && it.contains("\"graphs\":1") }
        javascriptUntil("document.querySelector('#root').getBoundingClientRect().height") { (it.toDoubleOrNull() ?: 0.0) > 100 }
        assertTrue(result.contains("\"errors\":0"))
        // Inject a real diagonal drag through Compose/native touch dispatch, not
        // just a DOM event. Document scrolling must never open the drawer.
        compose.onRoot().performTouchInput { swipe(androidx.compose.ui.geometry.Offset(30f, height * .82f), androidx.compose.ui.geometry.Offset(170f, height * .40f), 600) }
        compose.onNodeWithText("Your files").assertIsNotDisplayed()
        compose.onNodeWithContentDescription("Open files").performClick()
        compose.onNodeWithText("Your files").assertIsDisplayed()
        compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
        compose.onNodeWithText("Your files").assertIsNotDisplayed()
        javascriptUntil("(() => { document.querySelector('.android-reading').scrollTop=0; return true; })()") { it == "true" }
        // Exercise the real JS bridge, Python worker, shared preparation and JNI
        // typesetter together. Only the system destination picker is replaced
        // with a private file URI; all document/export code remains production.
        javascriptUntil("(() => { const b = [...document.querySelectorAll('.python-cell button')].find(button => button.textContent.includes('Run')); if (b) b.click(); return !!document.querySelector('.cell-output img'); })()") { it == "true" }
        val exported = java.io.File(compose.activity.cacheDir, "reader-export-test.pdf")
        exported.delete()
        val model = androidx.lifecycle.ViewModelProvider(compose.activity)[StudioViewModel::class.java]
        compose.activity.runOnUiThread { model.zoom(100f) }
        javascriptUntil("getComputedStyle(document.documentElement).getPropertyValue('--workspace-scale')") { it == "\"1\"" }
        javascriptUntil("(() => { if (window.pinchTestDone) return true; if (window.pinchTestStarted) return false; window.pinchTestStarted=true; const target=document.querySelector('.android-reading'); const touches=(x) => [new Touch({identifier:1,target,clientX:60,clientY:140}),new Touch({identifier:2,target,clientX:x,clientY:140})]; target.dispatchEvent(new TouchEvent('touchstart',{bubbles:true,touches:touches(160)})); target.dispatchEvent(new TouchEvent('touchmove',{bubbles:true,cancelable:true,touches:touches(240)})); requestAnimationFrame(() => requestAnimationFrame(() => { target.dispatchEvent(new TouchEvent('touchend',{bubbles:true,touches:[]})); window.pinchTestDone=true; })); return false; })()") { it == "true" }
        javascriptUntil("getComputedStyle(document.documentElement).getPropertyValue('--workspace-scale')") { (it.trim('"').toFloatOrNull() ?: 0f) > 1.1f }
        javascriptUntil("(() => { const native = window.SuperMD; window.SuperMD = { post: (id, command, raw) => { if (command === 'export_pdf_native') window.capturedPdfMarkdown = JSON.parse(raw).content; native.post(id, command, raw); } }; return true; })()") { it == "true" }
        compose.activity.runOnUiThread {
            model.outputUri = android.net.Uri.fromFile(exported)
            model.busy(true)
            web(compose.activity.window.decorView)?.evaluateJavascript("window.supermdExport?.(${StudioState().pdf})", null)
        }
        compose.waitUntil(60_000) { exported.isFile && exported.length() > 1000 && !model.state.value.busy }
        val captured = javascriptUntil("window.capturedPdfMarkdown") { it.startsWith("\"") }
        val markdown = org.json.JSONArray("[$captured]").getString(0)
        java.io.File(compose.activity.cacheDir, "reader-export-input.md").writeText(markdown)
        assertTrue(markdown.contains("\n\n## Local Matplotlib\n"))
        assertNull(model.state.value.error)
        android.graphics.pdf.PdfRenderer(android.os.ParcelFileDescriptor.open(exported, android.os.ParcelFileDescriptor.MODE_READ_ONLY)).use { assertTrue(it.pageCount > 0) }
        compose.runOnIdle { model.zoom(100f) }
        javascriptUntil("getComputedStyle(document.documentElement).getPropertyValue('--workspace-scale')") { it == "\"1\"" }
        val screenshot = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()!!
        java.io.File(compose.activity.cacheDir, "reader-ui-test.png").outputStream().use { screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
        val painted = mutableSetOf<Int>()
        val readerTop = AtomicReference(0)
        compose.runOnIdle { val view = web(compose.activity.window.decorView)!!; val xy = IntArray(2); view.getLocationOnScreen(xy); readerTop.set(xy[1]) }
        for (y in readerTop.get() + 30 until screenshot.height - 100 step 12) for (x in 40 until screenshot.width - 40 step 8) painted.add(screenshot.getPixel(x, y))
        assertTrue("Reader must actually paint, not just expose semantic nodes", painted.size > 40)
        val more = compose.onNodeWithContentDescription("More actions").fetchSemanticsNode().boundsInRoot.center
        val nativeIcon = screenshot.getPixel(more.x.toInt(), more.y.toInt())
        val paletteIcon = android.graphics.Color.parseColor(org.json.JSONArray("[${javascriptUntil("getComputedStyle(document.documentElement).getPropertyValue('--muted')") { it.startsWith("\"#") }}]").getString(0))
        assertTrue("Reader must not overpaint the native toolbar", kotlin.math.abs(android.graphics.Color.red(nativeIcon) - android.graphics.Color.red(paletteIcon)) < 15 && kotlin.math.abs(android.graphics.Color.green(nativeIcon) - android.graphics.Color.green(paletteIcon)) < 15 && kotlin.math.abs(android.graphics.Color.blue(nativeIcon) - android.graphics.Color.blue(paletteIcon)) < 15)
        val normalScale = javascriptUntil("getComputedStyle(document.documentElement).getPropertyValue('--workspace-scale')") { it.isNotBlank() && it != "null" && it != "\"\"" }
        compose.onNodeWithContentDescription("More actions").performClick()
        compose.onNodeWithText("Fullscreen study").performClick()
        compose.onNodeWithContentDescription("Zoom in").performClick()
        javascriptUntil("getComputedStyle(document.documentElement).getPropertyValue('--workspace-scale')") { it != normalScale && it != "null" }
        compose.onNodeWithContentDescription("Exit fullscreen").performClick()
        javascriptUntil("getComputedStyle(document.documentElement).getPropertyValue('--workspace-scale')") { it == normalScale }
        compose.onNodeWithContentDescription("New tab").performClick()
        val emptyId = model.state.value.active.id
        compose.onNodeWithContentDescription("Close Untitled.md").performClick()
        compose.runOnIdle { assertFalse("Empty unnamed notes must be discarded", model.state.value.closedTabs.any { it.id == emptyId }) }
        compose.onNodeWithContentDescription("New tab").performClick()
        compose.runOnIdle { model.edit(model.state.value.active.id, "# Recoverable draft") }
        javascriptUntil("document.querySelector('.android-reading')?.textContent || document.querySelector('.live-document')?.textContent") { it.contains("Recoverable draft") }
        compose.onNodeWithContentDescription("Close Untitled.md").performClick()
        compose.onNodeWithContentDescription("More actions").performClick()
        compose.onNodeWithText("Reopen closed tab").performClick()
        compose.onNodeWithContentDescription("Close Untitled.md").assertExists()
        compose.runOnIdle { assertEquals("# Recoverable draft", model.state.value.active.content) }
        compose.onNodeWithContentDescription("Close Untitled.md").performClick()
        if (compose.activity.resources.configuration.smallestScreenWidthDp < 600) {
            compose.runOnIdle { compose.activity.requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE }
            compose.waitUntil(10_000) { compose.activity.resources.configuration.orientation == android.content.res.Configuration.ORIENTATION_LANDSCAPE }
            compose.onNodeWithText("Split", useUnmergedTree = true).assertDoesNotExist()
            compose.onNodeWithText("Source", useUnmergedTree = true).assertExists()
            javascriptUntil("innerWidth > innerHeight && document.querySelector('#root').getBoundingClientRect().height > 50") { it == "true" }
            compose.runOnIdle { compose.activity.requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT }
            compose.waitUntil(10_000) { compose.activity.resources.configuration.orientation == android.content.res.Configuration.ORIENTATION_PORTRAIT }
        } else {
            compose.onNodeWithText("Split", useUnmergedTree = true).performClick()
            javascriptUntil("document.querySelectorAll('.mode-split > section').length") { it == "2" }
            javascriptUntil("document.querySelector('.android-source').getBoundingClientRect().right <= document.querySelector('.android-reading').getBoundingClientRect().left") { it == "true" }
            compose.onNodeWithText("Read", useUnmergedTree = true).performClick()
        }
        compose.onNodeWithContentDescription("Export").performClick()
        compose.onNodeWithText("Page numbers").assertExists()
        compose.onNodeWithText("Portable SMD", useUnmergedTree = true).performClick()
        compose.onNodeWithText("Your Markdown and images in one editable file.").assertExists()
        compose.onNodeWithText("Page numbers").assertDoesNotExist()
    }
}
