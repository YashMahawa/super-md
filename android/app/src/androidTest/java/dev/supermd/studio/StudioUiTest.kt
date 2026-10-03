package dev.supermd.studio

import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.compose.setContent
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.toArgb
import org.junit.Assert.*
import org.junit.After
import org.junit.Rule
import org.junit.Test
import java.util.concurrent.atomic.AtomicReference

class StudioUiTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private var temporaryNoteState: StudioState? = null
    @After fun restoreTemporaryNoteAndRecovery() {
        val before = temporaryNoteState ?: return
        val model = androidx.lifecycle.ViewModelProvider(compose.activity)[StudioViewModel::class.java]
        // The real app persists recovery between instrumentation methods. A
        // temporary gesture/repair fixture must not replace the welcome note
        // used by the existing end-to-end rendering/Python/PDF checks.
        compose.runOnIdle {
            model.edit(before.active.id, before.active.content)
            model.mode(before.mode)
            model.zoom(before.normalZoom)
            model.flush()
            assertEquals(before.active.content, model.state.value.active.content)
        }
        val snapshot = java.io.File(compose.activity.filesDir,
            if (model.workspaceKey == "main") "workspace.json" else "workspaces/${model.workspaceKey}.json")
        compose.waitUntil(5000) {
            runCatching {
                val notes = org.json.JSONObject(snapshot.readText()).getJSONArray("tabs")
                (0 until notes.length()).any { index ->
                    val note = notes.getJSONObject(index)
                    note.getString("id") == before.active.id && note.getString("content") == before.active.content
                }
            }.getOrDefault(false)
        }
    }
    private fun web(view: View): WebView? = if (view is WebView) view else if (view is ViewGroup) (0 until view.childCount).firstNotNullOfOrNull { web(view.getChildAt(it)) } else null
    private fun javascriptUntil(script: String, accepted: (String) -> Boolean): String {
        val result = AtomicReference("")
        val inFlight=java.util.concurrent.atomic.AtomicBoolean(false)
        compose.waitUntil(60_000) {
            // Mutating checks (dismiss, click, navigate) must never enqueue a
            // second evaluation before observing the first successful reply.
            if(accepted(result.get()))return@waitUntil true
            if(inFlight.compareAndSet(false,true))compose.activity.runOnUiThread { val reader=web(compose.activity.window.decorView);if(reader==null)inFlight.set(false) else reader.evaluateJavascript(script) { result.set(it);inFlight.set(false) } }
            accepted(result.get())
        }
        return result.get()
    }
    private fun welcome() {
        repeat(2) { if (compose.onAllNodesWithText("Continue").fetchSemanticsNodes().isNotEmpty()) compose.onNodeWithText("Continue").performClick() }
        compose.onAllNodesWithText("Explore the sample").fetchSemanticsNodes().firstOrNull()?.let { compose.onNodeWithText("Explore the sample").performClick() }
    }
    @Test fun manualDarkAccentPaintsNativeIconsAndReaderWithoutOemColorLeaks() {
        welcome()
        val model=androidx.lifecycle.ViewModelProvider(compose.activity)[StudioViewModel::class.java]
        val before=model.state.value
        try {
            compose.runOnIdle {model.appearance(accent="blue",theme="dark")}
            val colors=manualAccent("blue",true)
            val primary="#"+Integer.toHexString(colors.primary.toArgb()).substring(2)
            javascriptUntil("getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()") {it.trim('"')==primary}
            compose.waitForIdle()
            val icon=compose.onNodeWithContentDescription("New tab").captureToImage().asAndroidBitmap()
            val allowed=listOf(colors.onSurface,colors.onSurfaceVariant).map {it.toArgb() and 0xffffff}
            var visible=0
            for(y in 0 until icon.height)for(x in 0 until icon.width){if(icon.getPixel(x,y) and 0xffffff in allowed)visible++}
            assertTrue("The native plus must paint a high-contrast manual-scheme foreground, not the default black ambient",visible>5)
            java.io.File(compose.activity.getExternalFilesDir(null),"manual-blue-dark.png").outputStream().use {compose.onRoot().captureToImage().asAndroidBitmap().compress(android.graphics.Bitmap.CompressFormat.PNG,100,it)}
        } finally {compose.runOnIdle {model.appearance(accent=before.accent,theme=before.theme)}}
    }
    @Test fun nativeMenuIsDeduplicatedAndReaderZoomIsNotEchoedAsANewCommand() {
        welcome()
        val model=androidx.lifecycle.ViewModelProvider(compose.activity)[StudioViewModel::class.java]
        compose.onAllNodesWithContentDescription("New tab").assertCountEquals(1)
        compose.onNodeWithContentDescription("More actions").performClick()
        compose.onNodeWithText("Open note").assertIsNotDisplayed() // closed drawer, not an overflow item
        for(removed in listOf("New tab","New note","Reopen closed tab"))compose.onAllNodesWithText(removed).assertCountEquals(0)
        compose.onNodeWithText("New window").assertExists()
        androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK)
        compose.waitForIdle()
        compose.onNodeWithContentDescription("Open files").performClick()
        compose.onAllNodesWithText("New window").assertCountEquals(0)
        compose.onAllNodesWithText("New note").assertCountEquals(0)
        compose.runOnIdle {compose.activity.onBackPressedDispatcher.onBackPressed()}
        temporaryNoteState=model.state.value
        compose.runOnIdle {model.mode("reader");model.zoom(100f)}
        javascriptUntil("document.querySelector('.document-page')?.dataset.scale") {it=="\"1\""}
        val command=model.state.value.zoomCommand
        javascriptUntil("(()=>{if(window.zoomFeedbackStarted)return window.zoomFeedbackDone||false;window.zoomFeedbackStarted=true;let count=0;function tick(){window.supermdZoomBy?.(1.035,{x:180,y:220});if(++count<24)setTimeout(tick,45);else window.zoomFeedbackDone=true;}tick();return false;})()") {it=="true"}
        val expected=Math.pow(1.035,24.0).toFloat()
        javascriptUntil("document.querySelector('.document-page')?.dataset.scale") {kotlin.math.abs((it.trim('"').toFloatOrNull()?:0f)-expected)<.01f}
        compose.waitUntil(5000){kotlin.math.abs(model.state.value.zoom/100f-expected)<.01f}
        compose.runOnIdle {assertEquals("A reader acknowledgement must not echo a native zoom command",command,model.state.value.zoomCommand)}
    }
    @Test fun largeNoteKeepsOffscreenMathUnmountedAndHeadingSearchAvailable() {
        welcome()
        val model=androidx.lifecycle.ViewModelProvider(compose.activity)[StudioViewModel::class.java]
        temporaryNoteState=model.state.value
        val content=(0 until 600).joinToString("\n") { index ->
            "## Chapter $index\n\nUnique-$index ${"Readable **study text**. ".repeat(6)} \$x_$index=\\frac{a+b}{c+d}\$\n\n\$\$\\int_0^1 x^2 dx=\\frac13\$\$\n"
        }
        compose.runOnIdle {model.edit(model.state.value.active.id,content);model.mode("reader");model.zoom(100f)}
        javascriptUntil("document.querySelectorAll('[data-windowed-mounted=true]').length") {(it.toIntOrNull()?:0)>0}
        val math=javascriptUntil("document.querySelectorAll('.katex').length") {(it.toIntOrNull()?:0)>0}.toInt()
        assertTrue("Large notes must not keep every equation mounted",math<80)
        javascriptUntil("(()=>{window.supermdHeading?.('chapter-599');const h=document.querySelector('h2#chapter-599');if(!h)return false;const r=h.getBoundingClientRect();return r.top>=0&&r.top<innerHeight;})()") {it=="true"}
        assertTrue(javascriptUntil("document.querySelectorAll('.katex').length") {it.toIntOrNull()!=null}.toInt()<80)
        javascriptUntil("(()=>{window.supermdFind?.();const input=document.querySelector('.reading-search input');if(!input)return false;const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(input,'Unique-300');input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()") {it=="true"}
        javascriptUntil("document.querySelector('.reading-search output')?.textContent") {it=="\"0 / 1\""}
        javascriptUntil("(()=>{const b=document.querySelector('button[aria-label=\"Next match\"]');if(b&&!b.disabled)b.click();return document.querySelector('.reading-search output')?.textContent;})()") {it=="\"1 / 1\""}
        javascriptUntil("window.supermdDismiss?.()") {it=="true"}
    }
    @Test fun nativeSelectionAndHeadingLinksUseMagnifiedPageCoordinates() {
        welcome()
        val model=androidx.lifecycle.ViewModelProvider(compose.activity)[StudioViewModel::class.java]
        temporaryNoteState=model.state.value
        val content="# Selection\n\nAlpha Bravo Charlie Delta\n\n[Go to distant chapter](#chapter-599)\n\n"+(0 until 600).joinToString("\n"){"## Chapter $it\n\n${"Readable study paragraph. ".repeat(8)}\n"}
        compose.runOnIdle{model.edit(model.state.value.active.id,content);model.mode("reader");model.zoom(175f)}
        javascriptUntil("document.querySelector('.document-page')?.dataset.selectionScale"){it=="\"1.75\""}
        // Focal zoom deliberately preserves the previous viewport location.
        // Wait for the fixture, then bring the measured word onto the screen.
        javascriptUntil("(()=>{const p=document.querySelector('.markdown-body p');if(!p?.textContent.includes('Alpha Bravo Charlie Delta'))return false;document.querySelector('.android-reading').scrollTop=0;const r=p.getBoundingClientRect();return r.top>=0&&r.bottom<innerHeight;})()") {it=="true"}
        val raw=javascriptUntil("(()=>{const el=document.querySelector('.markdown-body p');if(!el)return null;const r=document.createRange();r.setStart(el.firstChild,6);r.setEnd(el.firstChild,11);const b=r.getBoundingClientRect();const caret=document.caretRangeFromPoint(b.left+b.width/2,b.top+b.height/2);return {x:b.left+b.width/2,y:b.top+b.height/2,width:innerWidth,word:caret?.startContainer.textContent,offset:caret?.startOffset};})()"){it.contains("Alpha Bravo Charlie Delta")}
        val point=org.json.JSONObject(raw)
        assertTrue(point.getInt("offset") in 6..11)
        val nativePoint=AtomicReference(androidx.compose.ui.geometry.Offset.Zero)
        compose.runOnIdle {val reader=web(compose.activity.window.decorView)!!;val xy=IntArray(2);reader.getLocationOnScreen(xy);val scale=reader.width.toFloat()/point.getDouble("width").toFloat();nativePoint.set(androidx.compose.ui.geometry.Offset(xy[0]+point.getDouble("x").toFloat()*scale,xy[1]+point.getDouble("y").toFloat()*scale))}
        val instrument=androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()
        val time=android.os.SystemClock.uptimeMillis();val position=nativePoint.get()
        instrument.sendPointerSync(android.view.MotionEvent.obtain(time,time,android.view.MotionEvent.ACTION_DOWN,position.x,position.y,0))
        android.os.SystemClock.sleep(750)
        instrument.sendPointerSync(android.view.MotionEvent.obtain(time,android.os.SystemClock.uptimeMillis(),android.view.MotionEvent.ACTION_UP,position.x,position.y,0))
        javascriptUntil("window.getSelection()?.toString()"){it=="\"Bravo\""}
        javascriptUntil("(()=>{window.getSelection()?.removeAllRanges();document.querySelector('a[href=\"#chapter-599\"]')?.click();const h=document.querySelector('h2#chapter-599');if(!h)return false;const host=document.querySelector('.android-reading');return Math.abs(h.getBoundingClientRect().top-host.getBoundingClientRect().top-16)<3;})()"){it=="true"}
    }
    @Test fun graphNativeTwoFingerPanAndPinchDoesNotZoomTheNote() {
        welcome()
        val model=androidx.lifecycle.ViewModelProvider(compose.activity)[StudioViewModel::class.java]
        temporaryNoteState = model.state.value
        val content="""# A graph

```smd-chart
{"series":[{"expression":"sin(x)"}],"x":{"min":-2,"max":2,"steps":12},"y":{"min":-2,"max":2}}
```
"""
        compose.runOnIdle {model.edit(model.state.value.active.id,content);model.mode("reader");model.zoom(100f)}
        javascriptUntil("document.querySelectorAll('.interactive-chart svg').length") {it=="1"}
        val raw=javascriptUntil("JSON.stringify((()=>{const s=document.querySelector('.interactive-chart svg');s.scrollIntoView({block:'center',behavior:'instant'});const r=s.getBoundingClientRect();return {x:r.left+r.width*.5,y:r.top+r.height*.5,d:devicePixelRatio};})())") {it.contains("\\\"d\\\"")}
        val rect=org.json.JSONObject(org.json.JSONArray("[$raw]").getString(0))
        val native=AtomicReference(IntArray(2))
        compose.runOnIdle {val xy=IntArray(2);web(compose.activity.window.decorView)!!.getLocationOnScreen(xy);native.set(xy)}
        val density=rect.getDouble("d").toFloat()
        val x=native.get()[0]+rect.getDouble("x").toFloat()*density
        val y=native.get()[1]+rect.getDouble("y").toFloat()*density
        compose.onRoot().performTouchInput {
            down(0,androidx.compose.ui.geometry.Offset(x-25*density,y));down(1,androidx.compose.ui.geometry.Offset(x+25*density,y));advanceEventTime(50)
            moveTo(0,androidx.compose.ui.geometry.Offset(x-15*density,y+10*density));moveTo(1,androidx.compose.ui.geometry.Offset(x+35*density,y+10*density));advanceEventTime(50)
            moveTo(0,androidx.compose.ui.geometry.Offset(x-35*density,y+10*density));moveTo(1,androidx.compose.ui.geometry.Offset(x+55*density,y+10*density));advanceEventTime(50);up(0);up(1)
        }
        javascriptUntil("Number(document.querySelector('.interactive-chart')?.dataset.plotZoom)") {(it.toDoubleOrNull()?:0.0)>1.3}
        assertTrue(javascriptUntil("Number(document.querySelector('.interactive-chart').dataset.centerX)"){it.toDoubleOrNull()!=null}.toDouble()!=0.0)
        assertEquals("\"1\"",javascriptUntil("document.querySelector('.document-page').dataset.scale"){it=="\"1\""})
    }
    @Test fun matplotlib3DFiguresStillRenderAndExportToPdf() {
        welcome()
        val model=androidx.lifecycle.ViewModelProvider(compose.activity)[StudioViewModel::class.java]
        temporaryNoteState=model.state.value
        val content="""# Matplotlib 3D

```python
import numpy as np
import matplotlib.pyplot as plt
x, y = np.meshgrid(np.linspace(-2, 2, 12), np.linspace(-2, 2, 12))
fig = plt.figure()
ax = fig.add_subplot(111, projection="3d")
ax.plot_surface(x, y, x*x + y*y, cmap="viridis")
ax.set_title("Matplotlib 3D figure")
```
"""
        compose.runOnIdle {model.edit(model.state.value.active.id,content);model.mode("reader");model.zoom(100f)}
        javascriptUntil("(() => { const b = [...document.querySelectorAll('.python-cell button')].find(button => button.textContent.includes('Run')); if (b && !b.disabled) b.click(); return !!document.querySelector('.cell-output img'); })()") {it=="true"}
        javascriptUntil("document.querySelector('.cell-output img')?.naturalWidth") {(it.toIntOrNull()?:0)>100}
        assertEquals("0",javascriptUntil("document.querySelectorAll('.surface-chart').length"){it=="0"})
        val exported=java.io.File(compose.activity.cacheDir,"matplotlib-3d-test.pdf")
        exported.delete()
        compose.runOnIdle {
            model.outputUri=android.net.Uri.fromFile(exported)
            model.busy(true)
            web(compose.activity.window.decorView)?.evaluateJavascript("window.supermdExport?.(${StudioState().pdf})",null)
        }
        compose.waitUntil(60_000) {exported.isFile && exported.length()>1000 && !model.state.value.busy}
        assertNull(model.state.value.error)
        assertTrue(exported.inputStream().use {input->ByteArray(4).also {input.read(it)}.contentEquals("%PDF".toByteArray())})
        val renderer=android.graphics.pdf.PdfRenderer(android.os.ParcelFileDescriptor.open(exported,android.os.ParcelFileDescriptor.MODE_READ_ONLY))
        renderer.use {assertTrue(it.pageCount>0)}
    }
    @Test fun offlineWritingChecksWorkInsideTheRealAndroidWebView() {
        welcome()
        val model=androidx.lifecycle.ViewModelProvider(compose.activity)[StudioViewModel::class.java]
        temporaryNoteState=model.state.value
        val previousSpell=model.state.value.spellCheck;val previousGrammar=model.state.value.grammarCheck
        try {
            compose.runOnIdle {model.writing(spellCheck=true,grammarCheck=true);model.edit(model.state.value.active.id,"# Writing\n\nThis sentnce has a apple and the the word.\n\n```python\nsentnce = 'a apple the the'\n```");model.mode("editor")}
            javascriptUntil("document.querySelectorAll('.cm-lintRange-info').length") {it=="3"}
            compose.runOnIdle {model.writing(spellCheck=false,grammarCheck=false)}
            javascriptUntil("document.querySelectorAll('.cm-lintRange-info').length") {it=="0"}
        } finally {compose.runOnIdle {model.writing(spellCheck=previousSpell,grammarCheck=previousGrammar)}}
    }
    @Test fun visibleHistoryButtonsUndoAndRedoAReviewedMathRepair() {
        welcome()
        val model=androidx.lifecycle.ViewModelProvider(compose.activity)[StudioViewModel::class.java]
        temporaryNoteState = model.state.value
        val original="Given \\frac{a}{b} = c, continue."
        compose.runOnIdle {model.edit(model.state.value.active.id,original);model.mode("reader")}
        javascriptUntil("document.querySelector('.markdown-body')?.textContent") {it.contains("Given")}
        compose.onNodeWithContentDescription("More actions").performClick();compose.onNodeWithText("Fix LaTeX").performClick()
        javascriptUntil("(()=>{const b=document.querySelector('.math-repair-panel footer button');if(b&&!b.disabled)b.click();return document.querySelectorAll('.katex').length;})()") {it=="1"}
        compose.onNodeWithContentDescription("Undo (Ctrl+Z)").assertIsDisplayed().performClick()
        javascriptUntil("document.querySelectorAll('.katex').length") {it=="0"}
        compose.runOnIdle {assertEquals(original,model.state.value.active.content)}
        compose.onNodeWithContentDescription("Redo (Ctrl+Y)").assertIsDisplayed().performClick()
        javascriptUntil("document.querySelectorAll('.katex').length") {it=="1"}
        compose.runOnIdle {assertTrue(model.state.value.active.content.contains("$\\frac{a}{b} = c$"))}
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
        // WebView's post-gesture JS callback is asynchronous to Compose's idler.
        compose.waitUntil(5000) {compose.onAllNodesWithContentDescription("Open files").fetchSemanticsNodes().isEmpty()}
        compose.onNodeWithContentDescription("Show contents").assertDoesNotExist()
        compose.onNodeWithContentDescription("Fullscreen study").assertDoesNotExist()
        compose.waitUntil(5000) {androidx.core.view.ViewCompat.getRootWindowInsets(compose.activity.window.decorView)?.isVisible(androidx.core.view.WindowInsetsCompat.Type.statusBars())==false}
        // Reveal controls with an upward document traversal, not the removed
        // down-arrow overlay. The viewport must not resize during the gesture.
        compose.onRoot().performTouchInput { swipe(androidx.compose.ui.geometry.Offset(width*.65f,height*.45f),androidx.compose.ui.geometry.Offset(width*.65f,height*.75f),500) }
        compose.waitUntil(5000) {compose.onAllNodesWithContentDescription("Open files").fetchSemanticsNodes().isNotEmpty()}
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
        javascriptUntil("document.querySelector('.document-page')?.dataset.scale") { it == "\"1\"" }
        javascriptUntil("(() => { if (window.pinchTestDone) return true; if (window.pinchTestStarted) return false; window.pinchTestStarted=true; const target=document.querySelector('.android-reading'); const touches=(x) => [new Touch({identifier:1,target,clientX:60,clientY:140}),new Touch({identifier:2,target,clientX:x,clientY:140})]; target.dispatchEvent(new TouchEvent('touchstart',{bubbles:true,touches:touches(160)})); target.dispatchEvent(new TouchEvent('touchmove',{bubbles:true,cancelable:true,touches:touches(240)})); requestAnimationFrame(() => requestAnimationFrame(() => { target.dispatchEvent(new TouchEvent('touchend',{bubbles:true,touches:[]})); window.pinchTestDone=true; })); return false; })()") { it == "true" }
        javascriptUntil("document.querySelector('.document-page')?.dataset.scale") { (it.trim('"').toFloatOrNull() ?: 0f) > 1.1f }
        javascriptUntil("getComputedStyle(document.documentElement).getPropertyValue('--workspace-scale')") { it == "\"1\"" }
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
        javascriptUntil("document.querySelector('.document-page')?.dataset.scale") { it == "\"1\"" }
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
        val normalScale = javascriptUntil("document.querySelector('.document-page')?.dataset.scale") { it.isNotBlank() && it != "null" && it != "\"\"" }
        compose.onNodeWithContentDescription("Show contents").assertDoesNotExist()
        compose.onNodeWithContentDescription("Fullscreen study").performClick()
        javascriptUntil("document.documentElement.dataset.fullscreen") { it == "\"true\"" }
        javascriptUntil("document.querySelector('.document-page')?.dataset.scale") { it == normalScale }
        compose.waitUntil(5000) {compose.onAllNodesWithContentDescription("Exit fullscreen").fetchSemanticsNodes().isEmpty()}
        // A native upward traversal reveals a compact toolbar, never floating
        // circles which remain over the document while chrome is hidden.
        compose.onRoot().performTouchInput { swipe(androidx.compose.ui.geometry.Offset(width*.75f,height*.45f),androidx.compose.ui.geometry.Offset(width*.75f,height*.75f),500) }
        compose.waitUntil(5000) {compose.onAllNodesWithContentDescription("Exit fullscreen").fetchSemanticsNodes().isNotEmpty()}
        // Earlier tests/repeated runs deliberately persist fullscreen zoom.
        // Start below the upper limit so this check can require a real increase.
        compose.runOnIdle { model.zoom(100f) }
        javascriptUntil("document.querySelector('.document-page')?.dataset.scale") { it == "\"1\"" }
        val fullBaseline=javascriptUntil("document.querySelector('.document-page')?.dataset.scale") {(it.trim('"').toFloatOrNull() ?: 0f)>0}.trim('"').toFloat()
        val contentsBounds=compose.onNodeWithContentDescription("Show contents").fetchSemanticsNode().boundsInRoot
        val exitBounds=compose.onNodeWithContentDescription("Exit fullscreen").fetchSemanticsNode().boundsInRoot
        assertTrue("Contents belongs at the left, separate from fullscreen exit",contentsBounds.right<exitBounds.left)
        // Fullscreen intentionally has no zoom buttons. Exercise the same
        // focal pinch path as normal reading instead of restoring stale UI.
        javascriptUntil("(() => { if (window.fullPinchDone) return true; if (window.fullPinchStarted) return false; window.fullPinchStarted=true; const target=document.querySelector('.android-reading'); const touches=(x) => [new Touch({identifier:1,target,clientX:60,clientY:140}),new Touch({identifier:2,target,clientX:x,clientY:140})]; target.dispatchEvent(new TouchEvent('touchstart',{bubbles:true,touches:touches(160)})); target.dispatchEvent(new TouchEvent('touchmove',{bubbles:true,cancelable:true,touches:touches(240)})); requestAnimationFrame(() => requestAnimationFrame(() => { target.dispatchEvent(new TouchEvent('touchend',{bubbles:true,touches:[]})); window.fullPinchDone=true; })); return false; })()") { it == "true" }
        javascriptUntil("document.querySelector('.document-page')?.dataset.scale") { (it.trim('"').toFloatOrNull() ?: 0f)>fullBaseline*1.1f }
        compose.onNodeWithContentDescription("Exit fullscreen").performClick()
        javascriptUntil("document.querySelector('.document-page')?.dataset.scale") { it == normalScale }
        compose.onNodeWithContentDescription("New tab").performClick()
        val emptyId = model.state.value.active.id
        compose.onNodeWithContentDescription("Close Untitled.md").performClick()
        compose.runOnIdle { assertFalse("Empty unnamed notes must be discarded", model.state.value.closedTabs.any { it.id == emptyId }) }
        compose.onNodeWithContentDescription("New tab").performClick()
        compose.runOnIdle { model.edit(model.state.value.active.id, "# Recoverable draft") }
        javascriptUntil("document.querySelector('.android-reading')?.textContent || document.querySelector('.live-document')?.textContent") { it.contains("Recoverable draft") }
        compose.waitUntil(10_000) { model.state.value.active.name == "Recoverable draft.md" }
        compose.onNodeWithContentDescription("Close Recoverable draft.md").performClick()
        compose.runOnIdle {
            val down=android.view.KeyEvent(0,0,android.view.KeyEvent.ACTION_DOWN,android.view.KeyEvent.KEYCODE_T,0,android.view.KeyEvent.META_CTRL_ON or android.view.KeyEvent.META_SHIFT_ON)
            assertTrue(compose.activity.handleShortcut(down))
        }
        compose.onNodeWithContentDescription("Close Recoverable draft.md").assertExists()
        compose.runOnIdle { assertEquals("# Recoverable draft", model.state.value.active.content) }
        compose.onNodeWithContentDescription("Close Recoverable draft.md").performClick()
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
    @Test fun openWithRegistrationCoversOpaqueProvidersAndAllNoteExtensions() {
        val manager=compose.activity.packageManager
        fun registered(uri:String,mime:String?) {
            val intent=android.content.Intent(android.content.Intent.ACTION_VIEW).apply {
                setDataAndType(android.net.Uri.parse(uri),mime)
                addCategory(android.content.Intent.CATEGORY_DEFAULT)
            }
            assertTrue("Super MD must resolve $uri ($mime)",manager.queryIntentActivities(intent,android.content.pm.PackageManager.MATCH_DEFAULT_ONLY).any {it.activityInfo.packageName==compose.activity.packageName})
        }
        for(mime in listOf("text/plain","text/markdown","text/x-markdown","application/vnd.supermd.smd","application/vnd.supermd.fmd","application/octet-stream"))registered("content://com.android.providers.downloads.documents/document/123",mime)
        for(extension in listOf("md","txt","smd","fmd"))registered("file:///storage/emulated/0/Download/Study.$extension",null)
    }
    @Test fun readingTapImmersionAndFullscreenPreserveWidthInLandscape() {
        welcome()
        val model=androidx.lifecycle.ViewModelProvider(compose.activity)[StudioViewModel::class.java]
        temporaryNoteState=model.state.value
        compose.runOnIdle {
            model.edit(model.state.value.active.id,"# Immersive reading\n\n"+("A paragraph to scroll and read comfortably. ".repeat(12)+"\n\n").repeat(80))
            model.mode("reader");model.zoom(170f)
            compose.activity.requestedOrientation=android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
        }
        try {
            compose.waitUntil(10000) {compose.activity.resources.configuration.orientation==android.content.res.Configuration.ORIENTATION_LANDSCAPE}
            javascriptUntil("document.querySelector('.document-page')?.dataset.scale") {it=="\"1.7\""}
            javascriptUntil("window.getSelection()?.removeAllRanges();true") {it=="true"}
            val width=javascriptUntil("getComputedStyle(document.querySelector('.document-page')).width") {it.contains("px")}
            val textWidth=javascriptUntil("getComputedStyle(document.querySelector('.markdown-body')).width") {it.contains("px")}
            val viewport=javascriptUntil("JSON.stringify([innerWidth,innerHeight])") {it.contains(",")}
            javascriptUntil("document.querySelector('h1').getBoundingClientRect().top>=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--native-chrome-inset'))") {it=="true"}
            // A margin tap has no text/link/edit action and toggles reading UI.
            compose.onRoot().performTouchInput {click(androidx.compose.ui.geometry.Offset(this.width*.98f,height*.60f))}
            compose.waitUntil(5000) {compose.onAllNodesWithContentDescription("Open files").fetchSemanticsNodes().isEmpty()}
            compose.onNodeWithContentDescription("Fullscreen study").assertDoesNotExist()
            assertEquals("Hiding normal chrome must not resize the reading viewport",viewport,javascriptUntil("JSON.stringify([innerWidth,innerHeight])") {it.contains(",")})
            compose.waitUntil(5000) {androidx.core.view.ViewCompat.getRootWindowInsets(compose.activity.window.decorView)?.isVisible(androidx.core.view.WindowInsetsCompat.Type.statusBars())==false}
            val nativeWidth=AtomicReference(0)
            compose.runOnIdle {nativeWidth.set(web(compose.activity.window.decorView)!!.width)}
            assertEquals("Landscape document must extend into the cutout region",compose.activity.window.decorView.width,nativeWidth.get())
            compose.onRoot().performTouchInput {click(androidx.compose.ui.geometry.Offset(this.width*.98f,height*.60f))}
            compose.waitUntil(5000) {compose.onAllNodesWithContentDescription("Open files").fetchSemanticsNodes().isNotEmpty()}
            compose.onNodeWithContentDescription("Fullscreen study").performClick()
            javascriptUntil("document.documentElement.dataset.fullscreen") {it=="\"true\""}
            javascriptUntil("document.querySelector('.document-page')?.dataset.scale") {it=="\"1.7\""}
            assertEquals(width,javascriptUntil("getComputedStyle(document.querySelector('.document-page')).width") {it.contains("px")})
            assertEquals("The actual text column, not just its outer page, must retain its width",textWidth,javascriptUntil("getComputedStyle(document.querySelector('.markdown-body')).width") {it.contains("px")})
            assertEquals("Fullscreen must not resize the reading viewport",viewport,javascriptUntil("JSON.stringify([innerWidth,innerHeight])") {it.contains(",")})
            compose.waitUntil(5000) {compose.onAllNodesWithContentDescription("Exit fullscreen").fetchSemanticsNodes().isEmpty()}
            compose.onRoot().performTouchInput {click(androidx.compose.ui.geometry.Offset(this.width*.98f,height*.60f))}
            compose.waitUntil(5000) {compose.onAllNodesWithContentDescription("Exit fullscreen").fetchSemanticsNodes().isNotEmpty()}
            compose.onNodeWithContentDescription("Show contents").assertIsDisplayed()
            assertEquals("Showing compact chrome must not resize the reading viewport",viewport,javascriptUntil("JSON.stringify([innerWidth,innerHeight])") {it.contains(",")})
            compose.onNodeWithContentDescription("Exit fullscreen").performClick()
        } finally {
            compose.runOnIdle {model.fullscreen(false);compose.activity.requestedOrientation=android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT}
            compose.waitUntil(10000) {compose.activity.resources.configuration.orientation==android.content.res.Configuration.ORIENTATION_PORTRAIT}
        }
    }
}
