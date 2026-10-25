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
import kotlin.math.abs

class StudioUiTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private var temporaryNoteState: StudioState? = null
    private var temporaryRestorePosition: Boolean? = null
    @After fun restoreTemporaryNoteAndRecovery() {
        try {
            val before = temporaryNoteState ?: return
            val model = androidx.lifecycle.ViewModelProvider(compose.activity)[StudioViewModel::class.java]
            // The real app persists recovery between instrumentation methods. A
            // temporary gesture/repair fixture must not replace the welcome note
            // used by the existing end-to-end rendering/Python/PDF checks.
            compose.runOnIdle {
                model.edit(before.active.id, before.active.content)
                model.mode(before.mode)
                model.zoom(before.normalZoom)
                model.centerLock(before.centerLock)
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
        } finally {
            temporaryRestorePosition?.let { previous ->
                val model = androidx.lifecycle.ViewModelProvider(compose.activity)[StudioViewModel::class.java]
                compose.runOnIdle { model.restorePosition(previous) }
            }
            temporaryRestorePosition = null
            temporaryNoteState = null
        }
    }
    private fun web(view: View): WebView? = if (view is WebView) view else if (view is ViewGroup) (0 until view.childCount).firstNotNullOfOrNull { web(view.getChildAt(it)) } else null
    /** Resolve touch input to this resumed activity, never an instrumentation helper root. */
    private fun activityRoot(): SemanticsNodeInteraction {
        compose.waitForIdle()
        val metrics = AtomicReference<Triple<Int, Int, Boolean>>()
        androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().runOnMainSync {
            val activity = compose.activity
            val decor = activity.window.decorView
            val resumed = androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry.getInstance()
                .getActivitiesInStage(androidx.test.runner.lifecycle.Stage.RESUMED).any { it === activity }
            metrics.set(Triple(decor.width, decor.height, resumed && decor.isAttachedToWindow && decor.isShown))
        }
        val (width, height, displayed) = metrics.get()
        assertTrue("The tested MainActivity must be resumed and displayed before injecting touch", displayed)
        assertTrue("The tested activity must have measured bounds", width > 0 && height > 0)
        val roots = compose.onAllNodes(isRoot(), useUnmergedTree = true).fetchSemanticsNodes()
        val matching = roots.filter { node ->
            abs(node.boundsInRoot.width - width) <= 1f && abs(node.boundsInRoot.height - height) <= 1f
        }
        assertEquals(
            "Expected exactly one semantics root matching the resumed MainActivity bounds ${width}x${height}; found ${matching.size}",
            1,
            matching.size,
        )
        return compose.onNode(
            isRoot() and SemanticsMatcher("root matching resumed MainActivity bounds ${width}x${height}") { node ->
                abs(node.boundsInRoot.width - width) <= 1f && abs(node.boundsInRoot.height - height) <= 1f
            },
            useUnmergedTree = true,
        )
    }
    private fun javascriptUntil(script: String, accepted: (String) -> Boolean): String {
        val result = AtomicReference("")
        val inFlight=java.util.concurrent.atomic.AtomicBoolean(false)
        try {
            compose.waitUntil(60_000) {
                // Mutating checks (dismiss, click, navigate) must never enqueue a
                // second evaluation before observing the first successful reply.
                if(accepted(result.get()))return@waitUntil true
                if(inFlight.compareAndSet(false,true))compose.activity.runOnUiThread { val reader=web(compose.activity.window.decorView);if(reader==null)inFlight.set(false) else reader.evaluateJavascript(script) { result.set(it);inFlight.set(false) } }
                accepted(result.get())
            }
        } catch (timeout: androidx.compose.ui.test.ComposeTimeoutException) {
            val boundedScript = script.replace('\n', ' ').take(240)
            val boundedReply = result.get().replace('\n', ' ').take(320)
            throw AssertionError("JavaScript condition timed out; script=$boundedScript; lastReply=$boundedReply; evaluationInFlight=${inFlight.get()}", timeout)
        }
        return result.get()
    }
    private fun welcome() {
        repeat(2) { if (compose.onAllNodesWithText("Continue").fetchSemanticsNodes().isNotEmpty()) compose.onNodeWithText("Continue").performClick() }
        compose.onAllNodesWithText("Explore the sample").fetchSemanticsNodes().firstOrNull()?.let { compose.onNodeWithText("Explore the sample").performClick() }
        // First-use-only Welcome is product behavior. Tests that exercise the
        // sample must provide their own fixture on subsequent Activity starts.
        val model=androidx.lifecycle.ViewModelProvider(compose.activity)[StudioViewModel::class.java]
        compose.runOnIdle {if(model.state.value.active.content.isBlank())model.edit(model.state.value.active.id,sample)}
        // Native controls intentionally stay disabled until reader_ready; test
        // setup must await that bridge handshake rather than race first render.
        compose.waitUntil(15_000) {
            compose.onAllNodes(hasContentDescription("Export") and isEnabled()).fetchSemanticsNodes().isNotEmpty()
        }
    }
    @Test fun themeGuideOpensOfflineCopiesAndPasteAutofixIsOptIn() {
        welcome()
        val model=androidx.lifecycle.ViewModelProvider(compose.activity)[StudioViewModel::class.java]
        temporaryNoteState=model.state.value
        val original=model.state.value.active.content
        val oldAutofix=model.state.value.latexAutofix
        val prefs=compose.activity.getSharedPreferences("studio",0)
        try {
            assertFalse(StudioState().latexAutofix)
            compose.runOnIdle {model.latexAutofix(false);model.mode("editor");model.edit(model.state.value.active.id,"Start here.")}
            javascriptUntil("document.querySelector('.cm-content')?.textContent==='Start here.'",{it=="true"})
            compose.onNodeWithContentDescription("Settings").performClick()
            compose.onNodeWithText("Theme authoring guide").performScrollTo().performClick()
            javascriptUntil("!!document.querySelector('.theme-guide-dialog .markdown-body h1')",{it=="true"})
            javascriptUntil("(()=>{const b=[...document.querySelectorAll('.theme-guide-dialog button')].find(b=>b.textContent==='Copy guide');if(b)b.click();return true})()",{it=="true"})
            javascriptUntil("document.querySelector('.theme-guide-dialog')?.textContent.includes('Copied')",{it=="true"})
            val copied=AtomicReference("")
            compose.runOnIdle {copied.set(compose.activity.getSystemService(android.content.ClipboardManager::class.java).primaryClip?.getItemAt(0)?.text?.toString()?:"")}
            assertTrue(copied.get().startsWith("# Custom themes"));assertTrue(copied.get().contains("pythonSourceMaxHeight"))
            assertEquals("Start here.",model.state.value.active.content)
            javascriptUntil("window.supermdDismiss()",{it=="true"})
            javascriptUntil("!document.querySelector('.theme-guide-dialog')",{it=="true"})
            compose.runOnIdle {model.latexAutofix(true)}
            assertTrue(prefs.getBoolean("latexAutofix",false))
            // Exercise the native payload and real CodeMirror paste handler,
            // then verify the edit travelled back through the Android bridge.
            javascriptUntil("(()=>{const c=document.querySelector('.cm-content');if(!c)return false;c.focus();const r=document.createRange();r.selectNodeContents(c);getSelection().removeAllRanges();getSelection().addRange(r);return true})()",{it=="true"})
            javascriptUntil("(()=>{const c=document.querySelector('.cm-content');const d=new DataTransfer();d.setData('text/plain',String.raw`\\[\\frac{a}{b}\\]`);c.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:d}));return true})()",{it=="true"})
            compose.waitUntil(10_000){model.state.value.active.content.contains("$$\n\\frac{a}{b}\n$$")}
        } finally {
            compose.runOnIdle {model.latexAutofix(oldAutofix);model.edit(model.state.value.active.id,original)}
        }
    }
    @Test fun externalOpenActivatesNewAndAlreadyOpenFileTabs() {
        val context = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().targetContext
        val workspace = java.util.UUID.randomUUID().toString()
        val prefs = context.getSharedPreferences("studio", 0)
        val oldWelcomed = prefs.getBoolean("welcomed", false)
        val oldRecent = prefs.getString("recent", null)
        val shareDir = java.io.File(context.cacheDir, "share").apply { mkdirs() }
        val firstFile = java.io.File(shareDir, "$workspace-first.md").apply { writeText("# First External Open\n\nFirst body.\n") }
        val secondFile = java.io.File(shareDir, "$workspace-second.md").apply { writeText("# Second External Open\n\nSecond body.\n") }
        val authority = "${context.packageName}.share"
        val firstUri = androidx.core.content.FileProvider.getUriForFile(context, authority, firstFile)
        val secondUri = androidx.core.content.FileProvider.getUriForFile(context, authority, secondFile)
        var scenario: androidx.test.core.app.ActivityScenario<MainActivity>? = null
        try {
            val launch = android.content.Intent(android.content.Intent.ACTION_VIEW, firstUri)
                .setClass(context, MainActivity::class.java)
                .putExtra("workspace", workspace)
            scenario = androidx.test.core.app.ActivityScenario.launch(launch)
            val openedModel = AtomicReference<StudioViewModel>()
            scenario.onActivity { activity ->
                val model = androidx.lifecycle.ViewModelProvider(activity)[StudioViewModel::class.java]
                openedModel.set(model)
                model.welcomeDone()
            }
            val model = openedModel.get()
            compose.waitUntil(30_000) { model.state.value.active.uri == firstUri.toString() }
            val firstId = model.state.value.active.id
            scenario.onActivity { it.requestOpen(secondUri) }
            compose.waitUntil(30_000) {
                val state = model.state.value
                state.active.uri == secondUri.toString() && state.tabs.any { it.uri == firstUri.toString() }
            }
            val secondId = model.state.value.active.id
            scenarioJavascriptUntil(scenario, "document.querySelector('.android-document h1')?.textContent?.trim()==='Second External Open'", "true")

            scenario.onActivity { model.select(firstId) }
            compose.waitUntil(15_000) { model.state.value.active.id == firstId }
            scenarioJavascriptUntil(scenario, "document.querySelector('.android-document h1')?.textContent?.trim()==='First External Open'", "true")
            scenario.onActivity { it.requestOpen(secondUri) }
            compose.waitUntil(15_000) { model.state.value.active.id == secondId }
            assertEquals(1, model.state.value.tabs.count { it.uri == secondUri.toString() })
            scenarioJavascriptUntil(scenario, "document.querySelector('.android-document h1')?.textContent?.trim()==='Second External Open'", "true")
        } finally {
            scenario?.close()
            // This test owns a UUID workspace and these two cache files only.
            java.io.File(context.filesDir, "workspaces/$workspace.json").delete()
            firstFile.delete()
            secondFile.delete()
            if (shareDir.list()?.isEmpty() == true) shareDir.delete()
            prefs.edit().also { editor ->
                if (oldWelcomed) editor.putBoolean("welcomed", true) else editor.remove("welcomed")
                if (oldRecent == null) editor.remove("recent") else editor.putString("recent", oldRecent)
            }.apply()
        }
    }
    private fun scenarioJavascriptUntil(
        scenario: androidx.test.core.app.ActivityScenario<MainActivity>,
        script: String,
        expected: String,
    ) {
        val result = AtomicReference<String?>(null)
        val inFlight = java.util.concurrent.atomic.AtomicBoolean(false)
        compose.waitUntil(15_000) {
            if (result.get() == expected) return@waitUntil true
            if (inFlight.compareAndSet(false, true)) scenario.onActivity { activity ->
                val reader = web(activity.window.decorView)
                if (reader == null) inFlight.set(false)
                else reader.evaluateJavascript(script) { value -> result.set(value); inFlight.set(false) }
            }
            result.get() == expected
        }
    }
    @Test fun importedThemePaintsNativeControlsAndReaderAndInvalidEditsKeepIt() {
        welcome()
        val model=androidx.lifecycle.ViewModelProvider(compose.activity)[StudioViewModel::class.java]
        val before=model.state.value;val prefs=compose.activity.getSharedPreferences("studio",0)
        val previousTheme=prefs.getString("customTheme",null);val previousSource=prefs.getString("customThemeSource",null)
        val file=java.io.File(compose.activity.cacheDir,"instrumented-theme.json")
        val theme=org.json.JSONObject(themeTemplate)
        theme.getJSONObject("variants").getJSONObject("light").put("colors",org.json.JSONObject().put("primary","#63351f").put("surface","#e4d4c9").put("surface-low","#d9c4b4").put("surface-high","#ceb09a").put("text","#30221b"))
        theme.getJSONObject("metrics").put("headingWeight",800)
        try {
            compose.runOnIdle {model.appearance(theme="light",motion=false);model.fullscreen(false);model.mode("reader");model.zoom(140f)}
            file.writeText(theme.toString())
            compose.runOnIdle {model.importCustomTheme(android.net.Uri.fromFile(file))}
            compose.waitUntil(10_000){model.state.value.customTheme.isNotBlank()}
            javascriptUntil("(()=>{const root=document.documentElement;return root.dataset.customTheme==='true'&&root.style.getPropertyValue('--custom-heading-weight')==='800'&&getComputedStyle(document.querySelector('.android-reading')).backgroundImage.includes('radial-gradient');})()") {it=="true"}
            javascriptUntil("document.querySelector('.document-page').dataset.scale") {it=="\"1.4\""}
            val bitmap=compose.onRoot().captureToImage().asAndroidBitmap();var colored=0
            for(y in 0 until bitmap.height step 4)for(x in 0 until bitmap.width step 4)if(bitmap.getPixel(x,y) and 0xffffff==0x63351f)colored++
            assertTrue("The selected native control must paint the imported accent",colored>10)
            val accepted=model.state.value.customTheme
            file.writeText(theme.put("css","@import url(https://example.com)").toString())
            compose.runOnIdle {model.reloadCustomTheme()}
            compose.waitUntil(10_000){model.state.value.message?.contains("Theme not applied")==true}
            assertEquals(accepted,model.state.value.customTheme);assertEquals(before.active.content,model.state.value.active.content)
            compose.runOnIdle {model.dismissError();model.resetCustomTheme()}
            javascriptUntil("document.documentElement.dataset.customTheme==='false'") {it=="true"}
        } finally {
            compose.runOnIdle {model.dismissError();model.resetCustomTheme();prefs.edit().apply {if(previousTheme!=null)putString("customTheme",previousTheme);if(previousSource!=null)putString("customThemeSource",previousSource)}.apply();model.appearance(theme=before.theme,motion=before.motion);model.fullscreen(before.fullscreen);model.mode(before.mode);model.zoom(before.normalZoom)}
            file.delete()
        }
    }
    @Test fun viewingAndDraggingSvgNeverMutatesTheNativeNote() {
        welcome()
        val model=androidx.lifecycle.ViewModelProvider(compose.activity)[StudioViewModel::class.java]
        temporaryNoteState=model.state.value
        val content="# Image safety\n\n```svg\n<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"200\" height=\"100\"><rect width=\"200\" height=\"100\" fill=\"#6486b2\"/></svg>\n```\n\nLast paragraph."
        compose.runOnIdle {model.edit(model.state.value.active.id,content);model.mode("reader");model.zoom(100f)}
        javascriptUntil("(()=>{const img=document.querySelector('.svg-diagram');if(!img)return false;img.click();return !!document.querySelector('.image-viewer');})()") {it=="true"}
        javascriptUntil("(()=>{document.querySelector('button[aria-label=\"Close image viewer\"]')?.click();return !document.querySelector('.image-viewer');})()") {it=="true"}
        javascriptUntil("(()=>{const img=document.querySelector('.svg-diagram');return !!img && !img.draggable && !img.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:new DataTransfer()}));})()") {it=="true"}
        compose.runOnIdle {assertEquals("Viewing must not import a second asset or append a broken block",content,model.state.value.active.content)}
        javascriptUntil("document.querySelectorAll('.image-error,.render-error').length") {it=="0"}
    }
    @Test fun fullDocumentAccessibilityPreferencePersistsAndRendersLargeNotesWithoutWindowing() {
        welcome()
        val model=androidx.lifecycle.ViewModelProvider(compose.activity)[StudioViewModel::class.java]
        val before=model.state.value;temporaryNoteState=before
        val prefs=compose.activity.getSharedPreferences("studio",0)
        val previous=prefs.getBoolean("fullDocumentAccessibility",false)
        val body="Accessible full-document fixture. ".repeat(2_700).trimEnd()
        val content="# Full document accessibility\n\n$body"
        try {
            compose.runOnIdle {model.edit(before.active.id,content);model.mode("reader");model.zoom(100f);model.fullDocumentAccessibility(true)}
            compose.waitUntil(5_000){model.state.value.fullDocumentAccessibility&&prefs.getBoolean("fullDocumentAccessibility",false)}
            val expectedLength=body.length
            javascriptUntil("(()=>{const root=document.querySelector('.android-reading'),paragraph=document.querySelector('.markdown-body p');return root?.dataset.fullDocumentAccessibility==='true'&&!document.querySelector('[data-windowed-block]')&&paragraph?.textContent?.length===$expectedLength;})()") {it=="true"}
            assertTrue("The opt-in preference is saved",prefs.getBoolean("fullDocumentAccessibility",false))
        } finally {
            compose.runOnIdle {model.fullDocumentAccessibility(previous);model.edit(before.active.id,before.active.content);model.mode(before.mode);model.zoom(before.normalZoom)}
            // This fixture disables virtualization and can leave a large DOM
            // pending after the test method returns. Let both preference state
            // and the replacement document reach the reader before the next
            // instrumentation method starts.
            compose.waitUntil(15_000) {
                model.state.value.fullDocumentAccessibility == previous &&
                    model.state.value.active.content == before.active.content &&
                    model.state.value.mode == before.mode
            }
            javascriptUntil("document.querySelector('.android-reading')?.dataset.fullDocumentAccessibility") {
                if (previous) it == "\"true\"" else it == "null"
            }
        }
    }
    @Test fun mediaUsesAccentPixelsAndCenterLockIsARealPersistentControl() {
        welcome()
        val model=androidx.lifecycle.ViewModelProvider(compose.activity)[StudioViewModel::class.java]
        val before=model.state.value;temporaryNoteState=before
        val content="# Accent media\n\n```svg\n<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"160\" height=\"100\"><rect width=\"160\" height=\"100\" fill=\"black\"/></svg>\n```"
        try {
            compose.runOnIdle {model.fullscreen(false);model.appearance(accent="blue",theme="dark",motion=false);model.centerLock(true);model.readingPreference("svgAppearance","auto");model.edit(model.state.value.active.id,content);model.zoom(100f)}
            compose.waitUntil(15_000) { model.state.value.active.content == content }
            compose.runOnIdle { model.mode("reader") }
            compose.waitUntil(15_000) { model.state.value.mode == "reader" }
            javascriptUntil("document.querySelector('h1#accent-media')!==null") {it=="true"}
            javascriptUntil("document.querySelector('.android-reading')?.dataset.centerLocked") {it=="\"true\""}
            compose.onNodeWithContentDescription("Centre locked · unlock horizontal movement").performClick()
            compose.waitUntil(5000){!model.state.value.centerLock}
            javascriptUntil("document.querySelector('.android-reading')?.dataset.centerLocked") {it=="\"false\""}
            compose.onNodeWithContentDescription("Lock document to centre").performClick()
            compose.waitUntil(5000){model.state.value.centerLock}
            fun painted(expected:Int) {
                val raw=javascriptUntil("(()=>{const i=document.querySelector('.svg-diagram');if(!i?.complete)return null;const r=i.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,width:innerWidth};})()") {it.contains("\"width\"")}
                val point=org.json.JSONObject(raw);val xy=AtomicReference(IntArray(2));val scale=AtomicReference(1f)
                compose.runOnIdle {val reader=web(compose.activity.window.decorView)!!;val location=IntArray(2);reader.getLocationOnScreen(location);xy.set(location);scale.set(reader.width.toFloat()/point.getDouble("width").toFloat())}
                var observed=0
                compose.waitUntil(15_000) {
                    val bitmap=androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
                    try {if(bitmap==null)false else {
                        observed=bitmap.getPixel(xy.get()[0]+(point.getDouble("x")*scale.get()).toInt(),xy.get()[1]+(point.getDouble("y")*scale.get()).toInt())
                        listOf(16,8,0).all {shift->kotlin.math.abs((observed shr shift and 255)-(expected shr shift and 255))<=2}
                    }} finally {bitmap?.recycle()}
                }
                assertTrue("Actual image pixels must follow the theme, observed #${Integer.toHexString(observed)}",listOf(16,8,0).all {shift->kotlin.math.abs((observed shr shift and 255)-(expected shr shift and 255))<=2})
            }
            fun ink():Int {
                val raw=javascriptUntil("document.documentElement.style.getPropertyValue('--media-edge')") {it.startsWith("\"#")}
                return android.graphics.Color.parseColor(org.json.JSONArray("[$raw]").getString(0))
            }
            val blue=ink();painted(blue)
            compose.runOnIdle {model.appearance(accent="rose")}
            javascriptUntil("document.documentElement.style.getPropertyValue('--media-edge')!==${org.json.JSONObject.quote(String.format("#%06x",blue and 0xffffff))}") {it=="true"}
            val rose=ink();assertNotEquals(blue,rose);painted(rose)
            compose.runOnIdle {model.readingPreference("svgAppearance","contrast")}
            javascriptUntil("document.documentElement.dataset.svgAppearance") {it=="\"contrast\""}
            painted(android.graphics.Color.BLACK)
            compose.runOnIdle {assertEquals(content,model.state.value.active.content)}
        } finally {
            compose.runOnIdle {model.appearance(accent=before.accent,theme=before.theme,motion=before.motion);model.readingPreference("svgAppearance",before.svgAppearance);model.centerLock(before.centerLock);model.fullscreen(before.fullscreen)}
        }
    }
    @Test fun mermaidSharesDiagramAppearanceWithoutChangingTheNoteOrPhotoSetting() {
        welcome()
        val model=androidx.lifecycle.ViewModelProvider(compose.activity)[StudioViewModel::class.java]
        val before=model.state.value;temporaryNoteState=before
        val content="# Diagram appearance\n\n```mermaid\nflowchart LR\n A[Read] --> B[Understand]\n```"
        try {
            compose.runOnIdle {model.fullscreen(false);model.appearance(accent="rose",theme="dark",motion=false);model.readingPreference("imageAppearance","original");model.readingPreference("svgAppearance","auto");model.edit(model.state.value.active.id,content);model.mode("reader");model.zoom(100f)}
            javascriptUntil("(()=>{const i=document.querySelector('.mermaid img');return !!i?.complete&&i.naturalWidth>0&&i.dataset.mediaKind==='svg'&&i.dataset.mediaAdapted==='true'&&getComputedStyle(i).filter==='none'&&document.documentElement.dataset.imageAppearance==='original';})()") {it=="true"}
            javascriptUntil("(()=>{const i=document.querySelector('.mermaid img');if(!i)return false;const svg=decodeURIComponent(i.src.split(',').slice(1).join(','));return svg.includes('data-diagram-engine=\"pele\"')&&!svg.includes('var(');})()") {it=="true"}
            for(mode in listOf("monochrome","contrast","invert-dark","original")) {
                compose.runOnIdle {model.readingPreference("svgAppearance",mode)}
                javascriptUntil("(()=>{const i=document.querySelector('.mermaid img');return document.documentElement.dataset.svgAppearance==='$mode'&&!!i?.complete&&i.naturalWidth>0;})()") {it=="true"}
                javascriptUntil("document.querySelectorAll('.image-error,.render-error').length") {it=="0"}
                compose.runOnIdle {assertEquals(content,model.state.value.active.content);assertEquals("original",model.state.value.imageAppearance)}
            }
            javascriptUntil("(()=>{document.querySelector('.mermaid img').click();return !!document.querySelector('.image-viewer');})()") {it=="true"}
            javascriptUntil("(()=>{document.querySelector('button[aria-label=\"Close image viewer\"]')?.click();return !document.querySelector('.image-viewer');})()") {it=="true"}
        } finally {
            compose.runOnIdle {model.appearance(accent=before.accent,theme=before.theme,motion=before.motion);model.readingPreference("imageAppearance",before.imageAppearance);model.readingPreference("svgAppearance",before.svgAppearance);model.fullscreen(before.fullscreen)}
        }
    }
    @Test fun checkingTasksKeepsNativeReadingPositionThroughUndoAndRedo() {
        welcome()
        val model=androidx.lifecycle.ViewModelProvider(compose.activity)[StudioViewModel::class.java]
        temporaryNoteState=model.state.value
        temporaryRestorePosition=model.state.value.restorePosition
        // This fixture deliberately pans to a left-edge checkbox at 180%.
        // Free horizontal navigation is an explicit user choice with the lock.
        compose.runOnIdle {model.centerLock(false)}
        val content=(0 until 65).joinToString("\n\n") { index ->
            "## Task section $index\n\n" +
                (if(index==42) "- [ ] Keep my place\n- [ ] Another task\n\n" else "") +
                "Long study paragraph with useful context and stable line wrapping. ".repeat(32)
        }
        val rectScript="""(()=>{const task=document.querySelector('input[type=checkbox]');if(!task)return null;const r=task.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,top:r.top,width:innerWidth,scale:document.querySelector('.document-page').dataset.scale};})()"""
        fun rect():org.json.JSONObject {
            val raw=javascriptUntil(rectScript) {it!="null"&&it.isNotEmpty()}
            println("TASK RECT RAW: $raw")
            return org.json.JSONObject(raw)
        }
        compose.runOnIdle { model.restorePosition(false); model.edit(model.state.value.active.id, content) }
        compose.waitUntil(15_000) { model.state.value.active.content == content }
        // Native edit replaces this same note id, so its prior position can
        // otherwise leave the new fixture's first checkbox outside the
        // virtualized reader window. Establish an explicit test-owned start
        // position before requiring later headings to mount.
        javascriptUntil("window.supermdNativeWheel?.(0,0,{x:-1,y:-1},false);const root=document.querySelector('.android-reading');if(root)root.scrollTop=0;true") {it=="true"}
        // Offscreen virtualized blocks keep heading anchors but intentionally
        // omit their rendered text. Confirm the fixture was parsed without
        // requiring section 42 to mount before the test navigates to it.
        javascriptUntil("document.querySelector('[data-heading-key][id=task-section-42]')!==null") { it == "true" }
        for(mode in listOf("reader","live"))for(zoom in listOf(100f,180f)) {
            compose.runOnIdle {model.mode(mode);model.zoom(zoom)}
            compose.waitUntil(15_000) {
                model.state.value.active.content == content &&
                    (model.state.value.mode == mode || model.state.value.message?.contains("reader could not confirm") == true)
            }
            assertEquals("Mode change must wait for the exact reader flush; native status: ${model.state.value.message}", mode, model.state.value.mode)
            // The bridge is asynchronous: an old Reader page may already have
            // the requested scale and heading while Live has not mounted yet.
            javascriptUntil("document.querySelector('.android-document.mode-$mode .android-reading')?.dataset.measured") {it=="\"true\""}
            javascriptUntil("document.querySelector('.document-page')?.dataset.scale") {
                kotlin.math.abs((it.trim('"').toFloatOrNull()?:0f)-zoom/100f)<.001f
            }
            // A real scroll cancels the mode's delayed source-anchor restore.
            // Dispatch a zero-delta input before our deliberate test positioning
            // so its later timers cannot relocate the checkbox behind the tap.
            javascriptUntil("document.querySelector('.android-reading').dispatchEvent(new WheelEvent('wheel',{bubbles:true}));true") {it=="true"}
            javascriptUntil("document.querySelector('[data-heading-key][id=task-section-42]')!==null") {it=="true"}
            javascriptUntil("window.supermdHeading?.('task-section-42');true") {it=="true"}
            javascriptUntil("!document.querySelector('.android-reading')?.dataset.navigating") {it=="true"}
            // Align the TAP below the real native overlay, not merely inside
            // the WebView's edge-to-edge bounds. A settling heading jump must
            // not later move that tap target back underneath the toolbar.
            javascriptUntil("""(()=>{const host=document.querySelector('.android-reading'),task=host?.querySelector('input[type=checkbox]');if(!task)return false;const r=task.getBoundingClientRect(),b=host.getBoundingClientRect();if(r.width<=0||r.height<=0)return false;window.supermdNativeWheel?.(0,0,{x:innerWidth/2,y:innerHeight*.75},false);const inset=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--native-chrome-inset'))||0;host.scrollTop+=r.top-(inset+innerHeight)/2;host.scrollLeft+=r.left-b.left-32;const after=task.getBoundingClientRect();return after.left>=0&&after.right<innerWidth&&after.top>inset+24&&after.bottom<innerHeight;})()""") {it=="true"}
            android.os.SystemClock.sleep(400)
            val before=rect()
            println("TASK BEFORE $mode/$zoom: $before")
            javascriptUntil("(()=>{const task=document.querySelector('input[type=checkbox]'),r=task.getBoundingClientRect();return document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===task;})()") {it=="true"}
            val point=AtomicReference(androidx.compose.ui.geometry.Offset.Zero)
            compose.runOnIdle {
                val reader=web(compose.activity.window.decorView)!!
                val xy=IntArray(2);reader.getLocationOnScreen(xy)
                val scale=reader.width.toFloat()/before.getDouble("width").toFloat()
                point.set(androidx.compose.ui.geometry.Offset(xy[0]+before.getDouble("x").toFloat()*scale,xy[1]+before.getDouble("y").toFloat()*scale))
            }
            val instrument=androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()
            val time=android.os.SystemClock.uptimeMillis();val position=point.get()
            instrument.sendPointerSync(android.view.MotionEvent.obtain(time,time,android.view.MotionEvent.ACTION_DOWN,position.x,position.y,0))
            android.os.SystemClock.sleep(60)
            instrument.sendPointerSync(android.view.MotionEvent.obtain(time,android.os.SystemClock.uptimeMillis(),android.view.MotionEvent.ACTION_UP,position.x,position.y,0))
            val checked=content.replaceFirst("- [ ] Keep my place","- [x] Keep my place")
            compose.waitUntil(15_000) {model.state.value.active.content==checked}
            fun assertPosition(action:String) {
                android.os.SystemClock.sleep(400)
                val after=rect()
                assertEquals("$mode/$zoom $action must retain magnification",before.getString("scale"),after.getString("scale"))
                assertEquals("$mode/$zoom $action must not scroll away",before.getDouble("top"),after.getDouble("top"),3.0)
            }
            assertPosition("checking")
            javascriptUntil("window.supermdHistory?.('undo');true") {it=="true"}
            compose.waitUntil(15_000) {model.state.value.active.content==content}
            assertPosition("undo")
            javascriptUntil("window.supermdHistory?.('redo');true") {it=="true"}
            compose.waitUntil(15_000) {model.state.value.active.content==checked}
            assertPosition("redo")
            // Start the next mode/zoom pass from the same unchecked baseline;
            // the following tap must exercise checking, not unchecking.
            javascriptUntil("window.supermdHistory?.('undo');true") {it=="true"}
            compose.waitUntil(15_000) {model.state.value.active.content==content}
            assertPosition("reset after redo")
        }
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
            // The selected tab can push the add-tab item beyond the LazyRow
            // viewport; scroll the real control into view before sampling its
            // pixels instead of capturing an empty clipped rectangle.
            compose.onNodeWithContentDescription("New tab").performScrollTo()
            compose.waitUntil(5_000) {
                val bounds = compose.onNodeWithContentDescription("New tab").fetchSemanticsNode().boundsInRoot
                bounds.width > 0f && bounds.height > 0f
            }
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
        compose.onNodeWithContentDescription("Save note").assertExists()
        compose.onNodeWithContentDescription("More actions").performClick()
        compose.onNodeWithText("Open note").assertIsNotDisplayed() // closed drawer, not an overflow item
        for(removed in listOf("New tab","New note","Reopen closed tab","Save as Markdown"))compose.onAllNodesWithText(removed).assertCountEquals(0)
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
        temporaryRestorePosition=model.state.value.restorePosition
        val content="# Selection\n\nThis short introduction places the selectable sample below the native reading controls.\n\nThe test taps only visible document text, never the Compose toolbar layered above the WebView.\n\nAlpha Bravo Charlie Delta\n\n[Go to distant chapter](#chapter-550)\n\n"+(0 until 600).joinToString("\n"){"## Chapter $it\n\n${"Readable study paragraph. ".repeat(8)}\n"}
        // Native selection at a magnified line start exercises unlocked pan;
        // the centre-lock test separately checks the new locked geometry.
        compose.runOnIdle {model.centerLock(false)}
        compose.runOnIdle {model.restorePosition(false)}
        compose.waitUntil(5_000) {!model.state.value.restorePosition}
        compose.runOnIdle {model.edit(model.state.value.active.id,content)}
        compose.waitUntil(5_000) {model.state.value.active.content==content}
        compose.runOnIdle {model.mode("reader");model.zoom(175f)}
        javascriptUntil("document.querySelector('.document-page')?.dataset.selectionScale"){it=="\"1.75\""}
        // Reset navigation only to mount the target; then align its measured
        // range below native controls inside the usable viewport.
        javascriptUntil("(()=>{window.supermdNativeWheel?.(0,0,{x:-1,y:-1},false);const host=document.querySelector('.android-reading');if(!host)return false;host.scrollTop=0;window.__selectionTargetAlign=0;return true;})()") {it=="true"}
        javascriptUntil("[...document.querySelectorAll('.markdown-body p')].some(p=>p.textContent.includes('Alpha Bravo Charlie Delta'))") {it=="true"}
        javascriptUntil("(()=>{const host=document.querySelector('.android-reading'),el=[...document.querySelectorAll('.markdown-body p')].find(p=>p.textContent.includes('Alpha Bravo Charlie Delta'));if(!host||!el)return false;const inset=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--native-chrome-inset'))||0,targetY=(inset+innerHeight)/2;if(window.__selectionTargetAlign===0){const range=document.createRange();range.setStart(el.firstChild,6);range.setEnd(el.firstChild,11);const b=range.getBoundingClientRect();host.scrollTop+=b.top+b.height/2-targetY;window.__selectionTargetAlign=1;requestAnimationFrame(()=>requestAnimationFrame(()=>window.__selectionTargetAlign=2));return false;}if(window.__selectionTargetAlign!==2)return false;const r=document.createRange();r.setStart(el.firstChild,6);r.setEnd(el.firstChild,11);const b=r.getBoundingClientRect();return Math.abs(b.top+b.height/2-targetY)<2;})()") {it=="true"}
        val raw=javascriptUntil("(()=>{const el=[...document.querySelectorAll('.markdown-body p')].find(p=>p.textContent.includes('Alpha Bravo Charlie Delta'));if(!el)return null;try{const r=document.createRange();r.setStart(el.firstChild,6);r.setEnd(el.firstChild,11);const b=r.getBoundingClientRect();const caret=document.caretRangeFromPoint(b.left+b.width/2,b.top+b.height/2);return {target:el.textContent,x:b.left+b.width/2,y:b.top+b.height/2,width:innerWidth,word:caret?.startContainer.textContent,offset:caret?.startOffset,chromeInset:parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--native-chrome-inset'))||0};}catch(e){return {target:el.textContent,error:String(e),child:el.firstChild?.textContent,childType:el.firstChild?.nodeType};}})()"){it.contains("Alpha Bravo Charlie Delta")}
        val point=org.json.JSONObject(raw)
        assertFalse("Could not measure selection target: $point",point.has("error"))
        assertTrue("Caret geometry must resolve inside the intended text: $point",point.optString("word").contains("Alpha Bravo Charlie Delta"))
        assertTrue(point.getInt("offset") in 6..11)
        assertTrue("Selection target must be below the native toolbar overlay: point=$point",point.getDouble("y")>point.getDouble("chromeInset")+8)
        val nativeControlsBottom=listOf("Save note","Export","More actions","Undo (Ctrl+Z)","Redo (Ctrl+Y)")
            .maxOf { compose.onNodeWithContentDescription(it).fetchSemanticsNode().boundsInRoot.bottom }
        val nativePoint=AtomicReference(androidx.compose.ui.geometry.Offset.Zero)
        val nativeGeometry=AtomicReference("")
        val nativeScale=AtomicReference(1f)
        val nativeWebTop=AtomicReference(0f)
        compose.runOnIdle {val reader=web(compose.activity.window.decorView)!!;val xy=IntArray(2);reader.getLocationOnScreen(xy);val scale=reader.width.toFloat()/point.getDouble("width").toFloat();nativeScale.set(scale);nativeWebTop.set(xy[1].toFloat());nativePoint.set(androidx.compose.ui.geometry.Offset(xy[0]+point.getDouble("x").toFloat()*scale,xy[1]+point.getDouble("y").toFloat()*scale));nativeGeometry.set("web=${reader.width}x${reader.height} at=${xy.contentToString()} scale=$scale decor=${compose.activity.window.decorView.width}x${compose.activity.window.decorView.height} density=${compose.activity.resources.displayMetrics.density}")}
        assertTrue("Selection point must be below the bottom edge of visible native controls: point=${nativePoint.get()}, controlsBottom=$nativeControlsBottom, $nativeGeometry",nativePoint.get().y>nativeControlsBottom+8)
        println("SELECTION GEOMETRY: point=$point native=${nativePoint.get()} controlsBottom=$nativeControlsBottom ${nativeGeometry.get()}")
        val instrument=androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()
        javascriptUntil("(()=>{window.__selectionInput=[];for(const type of ['pointerdown','pointerup','touchstart','touchend','contextmenu','selectionchange'])document.addEventListener(type,e=>window.__selectionInput.push({type,target:e.target?.textContent?.slice?.(0,40),client:[e.clientX,e.clientY],buttons:e.buttons,selection:window.getSelection()?.toString()}),true);return true;})()") {it=="true"}
        val time=android.os.SystemClock.uptimeMillis();val position=nativePoint.get()
        fun pointer(action:Int,eventTime:Long):android.view.MotionEvent {
            val properties=android.view.MotionEvent.PointerProperties().apply {id=0;toolType=android.view.MotionEvent.TOOL_TYPE_FINGER}
            val coordinates=android.view.MotionEvent.PointerCoords().apply {x=position.x;y=position.y;pressure=1f;size=1f}
            return android.view.MotionEvent.obtain(time,eventTime,action,1,arrayOf(properties),arrayOf(coordinates),0,0,1f,1f,0,0,android.view.InputDevice.SOURCE_TOUCHSCREEN,0)
        }
        val down=pointer(android.view.MotionEvent.ACTION_DOWN,time)
        println("SELECTION INPUT DOWN: (${down.x},${down.y}) source=${down.source} tool=${down.getToolType(0)} longPressTimeout=${android.view.ViewConfiguration.getLongPressTimeout()}")
        var up:android.view.MotionEvent?=null
        try {
            instrument.sendPointerSync(down)
            android.os.SystemClock.sleep(750)
            up=pointer(android.view.MotionEvent.ACTION_UP,android.os.SystemClock.uptimeMillis())
            instrument.sendPointerSync(up)
        } finally {
            down.recycle()
            up?.recycle()
        }
        println("SELECTION AFTER POINTER: "+javascriptUntil("JSON.stringify({events:window.__selectionInput,selection:window.getSelection()?.toString(),range:(()=>{const p=[...document.querySelectorAll('.markdown-body p')].find(p=>p.textContent.includes('Alpha Bravo Charlie Delta'));const r=document.createRange();r.setStart(p.firstChild,6);r.setEnd(p.firstChild,11);const b=r.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2,viewport:[innerWidth,innerHeight]}})()})") {it.contains("selection")})
        javascriptUntil("window.getSelection()?.toString()"){it=="\"Bravo\""}
        // Inspect the real OS toolbar, including its overflow, without invoking
        // an external search or submitting any synthetic text to a provider.
        val automation=instrument.uiAutomation
        val originalFlags=automation.serviceInfo.flags
        automation.serviceInfo=automation.serviceInfo.apply {flags=flags or android.accessibilityservice.AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS}
        try {
            fun toolbarNodes():List<android.view.accessibility.AccessibilityNodeInfo> {
                val result=mutableListOf<android.view.accessibility.AccessibilityNodeInfo>()
                fun visit(node:android.view.accessibility.AccessibilityNodeInfo?) {
                    if(node==null)return
                    result.add(node)
                    for(index in 0 until node.childCount)visit(node.getChild(index))
                }
                automation.windows.forEach {visit(it.root)}
                return result
            }
            val ask="Ask ${SelectionActions.label(model.state.value.selectionAssistant)}…"
            val seen=mutableSetOf<String>()
            fun record(nodes:List<android.view.accessibility.AccessibilityNodeInfo>){seen.addAll(nodes.filter {it.isVisibleToUser}.mapNotNull {it.text?.toString()?.takeIf(String::isNotBlank)})}
            fun complete()=seen.contains("Search Google")&&seen.contains(ask)
            var nodes=toolbarNodes();record(nodes)
            val deadline=android.os.SystemClock.uptimeMillis()+6_000
            while(!complete()&&nodes.none {it.contentDescription?.toString()=="More options"}&&android.os.SystemClock.uptimeMillis()<deadline){android.os.SystemClock.sleep(50);nodes=toolbarNodes();record(nodes)}
            // Expanding overflow can hide main-row actions, so retain the
            // visible labels from both presentations instead of requiring all
            // actions to occupy the same row on every device/OS version.
            if(!complete())nodes.firstOrNull {it.contentDescription?.toString()=="More options"}?.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK)
            while(!complete()&&android.os.SystemClock.uptimeMillis()<deadline){android.os.SystemClock.sleep(50);nodes=toolbarNodes();record(nodes)}
            assertTrue("Native selection toolbar is missing Search Google: ${seen.take(12)}",seen.contains("Search Google"))
            assertTrue("Native selection toolbar is missing $ask: ${seen.take(12)}",seen.contains(ask))
        } finally {automation.serviceInfo=automation.serviceInfo.apply {flags=originalFlags}}
        val headingNavigationProbe="""(()=>{const host=document.querySelector('.android-reading'),style=getComputedStyle(document.documentElement);if(!host)return false;if(!window.__headingNavigationFrames){window.getSelection()?.removeAllRanges();document.querySelector('a[href="#chapter-550"]')?.click();window.__headingNavigationFrames=0;const tick=()=>{window.__headingNavigationFrames++;if(window.__headingNavigationFrames<8)requestAnimationFrame(tick);};requestAnimationFrame(tick);return false;}if(window.__headingNavigationFrames<8)return false;const h=document.querySelector('h2#chapter-550');if(!h)return false;const r=h.getBoundingClientRect();return {headingTop:r.top,hostTop:host.getBoundingClientRect().top,scrollTop:host.scrollTop,maxScroll:host.scrollHeight-host.clientHeight,chromeInset:parseFloat(style.getPropertyValue('--native-chrome-inset'))||0,visibleInset:parseFloat(style.getPropertyValue('--native-visible-chrome-inset'))||0,viewportHeight:innerHeight};})()"""
        val headingLayout=org.json.JSONObject(javascriptUntil(headingNavigationProbe) {it.contains("headingTop")})
        val headingScreenY=nativeWebTop.get()+headingLayout.getDouble("headingTop")*nativeScale.get()
        println("SELECTION HEADING GEOMETRY: $headingLayout screenY=$headingScreenY nativeControlsBottom=$nativeControlsBottom scale=${nativeScale.get()}")
        val headingGap=16+headingLayout.getDouble("visibleInset")
        assertEquals("The interior heading should align below visible native controls",headingGap,headingLayout.getDouble("headingTop")-headingLayout.getDouble("hostTop"),3.0)
        assertTrue("The heading must be below the displayed Compose controls: layout=$headingLayout screenY=$headingScreenY controlsBottom=$nativeControlsBottom",headingScreenY>nativeControlsBottom+8)
        val finalHeadingLayout=org.json.JSONObject(javascriptUntil("""(()=>{const host=document.querySelector('.android-reading'),style=getComputedStyle(document.documentElement);if(!host)return false;if(!window.__finalHeadingNavigationFrames){window.supermdHeading?.('chapter-599');window.__finalHeadingNavigationFrames=0;const tick=()=>{window.__finalHeadingNavigationFrames++;if(window.__finalHeadingNavigationFrames<8)requestAnimationFrame(tick);};requestAnimationFrame(tick);return false;}if(window.__finalHeadingNavigationFrames<8)return false;const h=document.querySelector('h2#chapter-599');if(!h)return false;const r=h.getBoundingClientRect();return {headingTop:r.top,hostTop:host.getBoundingClientRect().top,scrollTop:host.scrollTop,maxScroll:host.scrollHeight-host.clientHeight,chromeInset:parseFloat(style.getPropertyValue('--native-chrome-inset'))||0,visibleInset:parseFloat(style.getPropertyValue('--native-visible-chrome-inset'))||0,viewportHeight:innerHeight};})()""") {it.contains("headingTop")})
        val finalHeadingTop=finalHeadingLayout.getDouble("headingTop")-finalHeadingLayout.getDouble("hostTop")
        val finalHeadingGap=16+finalHeadingLayout.getDouble("visibleInset")
        val finalHeadingClamped=finalHeadingLayout.getDouble("scrollTop")>=finalHeadingLayout.getDouble("maxScroll")-2
        val finalHeadingScreenY=nativeWebTop.get()+finalHeadingLayout.getDouble("headingTop")*nativeScale.get()
        println("SELECTION FINAL HEADING GEOMETRY: $finalHeadingLayout clamped=$finalHeadingClamped screenY=$finalHeadingScreenY controlsBottom=$nativeControlsBottom")
        assertTrue("The final heading must not overlap visible native controls: layout=$finalHeadingLayout screenY=$finalHeadingScreenY controlsBottom=$nativeControlsBottom",finalHeadingTop>=finalHeadingGap-3&&finalHeadingTop+30<=finalHeadingLayout.getDouble("viewportHeight")&&finalHeadingScreenY>nativeControlsBottom+8)
        assertTrue("The final heading should align normally or be prevented only by the confirmed scroll-range clamp: layout=$finalHeadingLayout gap=$finalHeadingGap",abs(finalHeadingTop-finalHeadingGap)<3||finalHeadingClamped)
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
        // The welcome note also contains one graph. Wait for THIS fixture and
        // its settled native scale, otherwise a slow bridge can replace the
        // welcome graph after we measure it but before the two-finger gesture.
        javascriptUntil("document.querySelector('.android-document.mode-reader h1#a-graph')!==null") {it=="true"}
        javascriptUntil("document.querySelector('.document-page')?.dataset.selectionScale") {it=="\"1\""}
        javascriptUntil("document.querySelector('.android-reading').dispatchEvent(new WheelEvent('wheel',{bubbles:true}));true") {it=="true"}
        javascriptUntil("document.querySelectorAll('.interactive-chart svg').length") {it=="1"}
        val raw=javascriptUntil("JSON.stringify((()=>{const s=document.querySelector('.interactive-chart svg');s.scrollIntoView({block:'center',behavior:'instant'});const r=s.getBoundingClientRect();return {x:r.left+r.width*.5,y:r.top+r.height*.5,d:devicePixelRatio};})())") {it.contains("\\\"d\\\"")}
        val rect=org.json.JSONObject(org.json.JSONArray("[$raw]").getString(0))
        println("NATIVE GRAPH GESTURE RECT: $rect")
        javascriptUntil("(()=>{const r=document.querySelector('.interactive-chart svg').getBoundingClientRect();return !!document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest('.interactive-chart svg');})()") {it=="true"}
        val native=AtomicReference(IntArray(2))
        compose.runOnIdle {val xy=IntArray(2);web(compose.activity.window.decorView)!!.getLocationOnScreen(xy);native.set(xy)}
        val density=rect.getDouble("d").toFloat()
        val x=native.get()[0]+rect.getDouble("x").toFloat()*density
        val y=native.get()[1]+rect.getDouble("y").toFloat()*density
        activityRoot().performTouchInput {
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
        val noteId=model.state.value.active.id
        val fixture="# Writing\n\nThis sentnce has a apple and the the word.\n\n```python\nsentnce = 'a apple the the'\n```"
        try {
            // Let the actual WebView render the fixture in its current mode
            // before switching modes; this avoids asking the reader flush
            // barrier to acknowledge a native edit that has not reached it yet.
            compose.runOnIdle {model.edit(noteId,fixture)}
            compose.waitUntil(5_000) { model.state.value.tabs.find { it.id==noteId }?.content==fixture }
            javascriptUntil("document.querySelector('.android-document')?.textContent.includes('This sentnce has a apple and the the word.')") {it=="true"}
            compose.runOnIdle {model.mode("editor")}
            javascriptUntil("(()=>{const lines=[...document.querySelectorAll('.cm-content .cm-line')].map(line=>line.textContent).join('\\n');return lines.includes('This sentnce has a apple and the the word.')&&lines.includes(\"sentnce = 'a apple the the'\")})()") {it=="true"}
            compose.runOnIdle {model.writing(spellCheck=true,grammarCheck=true)}
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
        compose.waitUntil(15_000) { model.state.value.active.content.contains("$\\frac{a}{b} = c$") }
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
        try {
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
        } finally {
            androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().runOnMainSync {
                first.edit(initial, original)
                first.flush()
                other?.let { if (!it.isFinishing && !it.isDestroyed) it.finishAndRemoveTask() }
            }
            val mainRecovery = java.io.File(compose.activity.filesDir, "workspace.json")
            compose.waitUntil(5000) {
                runCatching {
                    val notes = org.json.JSONObject(mainRecovery.readText()).getJSONArray("tabs")
                    (0 until notes.length()).any { index ->
                        val note = notes.getJSONObject(index)
                        note.getString("id") == initial && note.getString("content") == original
                    }
                }.getOrDefault(false)
            }
        }
    }
    @Test fun rendererExitRecreatesReaderFromNativeState() {
        welcome()
        val model = androidx.lifecycle.ViewModelProvider(compose.activity)[StudioViewModel::class.java]
        temporaryNoteState = model.state.value
        val content = "# Renderer recovery\n\nAcknowledged draft survives.\n\n```python\nprint('must not auto-run')\n```"
        compose.runOnIdle { model.edit(model.state.value.active.id, content); model.mode("reader") }
        compose.waitUntil(15_000) { compose.onAllNodes(hasContentDescription("Export") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }

        val originalReader = AtomicReference<WebView>()
        compose.runOnIdle {
            originalReader.set(web(compose.activity.window.decorView)!!)
            // Android's documented renderer-crash test hook. This test runs
            // only in the disposable instrumentation app process.
            originalReader.get().loadUrl("chrome://crash")
        }
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("The reader restarted. Changes already received by Super MD were restored; an edit still in transit may be missing.").fetchSemanticsNodes().isNotEmpty()
        }
        compose.waitUntil(30_000) {
            val currentReader = AtomicReference<WebView>()
            androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().runOnMainSync {
                currentReader.set(web(compose.activity.window.decorView))
            }
            currentReader.get() != null && currentReader.get() !== originalReader.get() &&
                compose.onAllNodes(hasContentDescription("Export") and isEnabled()).fetchSemanticsNodes().isNotEmpty()
        }
        assertEquals(content, model.state.value.active.content)
        javascriptUntil("document.querySelector('.android-reading')?.innerText.includes('Acknowledged draft survives') && !document.querySelector('.python-cell .cell-output')") { it == "true" }
    }
    @Test fun shareUsesTheSamePdfOptionsAndARestrictedSystemUri() {
        welcome()
        // The real share/export actions intentionally stay disabled until the
        // asynchronous WebView bridge is ready. Compose idleness alone cannot
        // establish that readiness on a cold emulator.
        compose.waitUntil(15_000) {compose.onAllNodes(hasContentDescription("Export") and isEnabled()).fetchSemanticsNodes().isNotEmpty()}
        compose.onNodeWithContentDescription("More actions").performClick()
        compose.onNodeWithText("Share note").assertIsDisplayed().assertIsEnabled().performClick()
        compose.waitUntil(15_000) {compose.onNodeWithText("Share your note").isDisplayed()}
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
    @Test fun nativeShareSwitchingKeepsUnicodeNamesMimesAndFileHeaders() {
        welcome()
        val model=androidx.lifecycle.ViewModelProvider(compose.activity)[StudioViewModel::class.java]
        temporaryNoteState=model.state.value
        val id=model.state.value.active.id
        val originalName=model.state.value.active.name
        val noteName="Révision 📚 — [draft] + 50%.md"
        val content="# Unicode share\n\nRésumé λ, emoji 📚, punctuation [x] + 50%.\n"
        val intents=mutableListOf<android.content.Intent>()
        val previousShareReady=model.shareReady
        try {
            compose.runOnIdle { model.rename(id,noteName) }
            compose.waitUntil(5_000) { model.state.value.tabs.find { it.id==id }?.name==noteName }
            compose.runOnIdle { model.edit(id,content);model.shareReady={intents.add(it)} }
            compose.waitUntil(5_000) { model.state.value.tabs.find { it.id==id }?.content==content }
            val formats=listOf("md","smd","pdf","md")
            for(format in formats) {
                compose.runOnIdle { assertTrue("Could not prepare $format share",model.prepareShare(format)) }
                when(format) {
                    "md" -> kotlinx.coroutines.runBlocking { model.shareMarkdown(content) }
                    "smd" -> kotlinx.coroutines.runBlocking { model.writePortable(id,content,org.json.JSONObject(),save=false,originalContent=content) }
                    "pdf" -> kotlinx.coroutines.runBlocking { model.export(content,model.state.value.pdf,org.json.JSONObject()) }
                }
                val intent=intents.last()
                val expected=ExportFilename.suggestedName(noteName,NativeExportFormat.fromShareFormat(format))
                assertEquals(expected,intent.clipData?.description?.label?.toString())
                assertEquals(NativeExportFormat.fromShareFormat(format).mimeType,intent.type)
                assertTrue(intent.flags and android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION!=0)
                val uri=intent.getParcelableExtra<android.net.Uri>(android.content.Intent.EXTRA_STREAM)!!
                val bytes=compose.activity.contentResolver.openInputStream(uri)!!.use { it.readBytes() }
                when(format) {
                    "md" -> assertEquals(content,String(bytes,Charsets.UTF_8))
                    "smd" -> assertTrue(String(bytes,Charsets.UTF_8).startsWith("{\"format\":\"supermd-smd\""))
                    "pdf" -> assertTrue(bytes.copyOfRange(0,5).contentEquals("%PDF-".toByteArray(Charsets.US_ASCII)))
                }
            }
            assertEquals(formats.size,intents.size)
        } finally {
            compose.runOnIdle { model.rename(id,originalName);model.shareReady=previousShareReady }
            compose.waitUntil(5_000) { model.state.value.tabs.find { it.id==id }?.name==originalName }
        }
    }
    @Test fun realReaderAndNativeControlsAreConnected() {
        welcome()
        compose.onNodeWithText("Read", useUnmergedTree = true).performClick()
        val model = androidx.lifecycle.ViewModelProvider(compose.activity)[StudioViewModel::class.java]
        compose.waitUntil(15_000) { model.state.value.mode == "reader" }
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
        // Fullscreen scrolls must never reveal chrome. A deliberate margin
        // tap reveals the compact toolbar, not floating controls.
        compose.onRoot().performTouchInput { swipe(androidx.compose.ui.geometry.Offset(width*.75f,height*.45f),androidx.compose.ui.geometry.Offset(width*.75f,height*.75f),500) }
        javascriptUntil("true") {it=="true"}
        compose.onNodeWithContentDescription("Exit fullscreen").assertDoesNotExist()
        compose.onRoot().performTouchInput {click(androidx.compose.ui.geometry.Offset(width*.98f,height*.6f))}
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
        val recoverableId = model.state.value.active.id
        compose.onNodeWithContentDescription("Close Recoverable draft.md").performClick()
        // Close commits the recoverable snapshot/index asynchronously after
        // the reader flush barrier. Do not race the reopen shortcut against it.
        compose.waitUntil(15_000) {
            model.state.value.tabs.none { it.id == recoverableId } &&
                model.state.value.closedTabs.any { it.id == recoverableId }
        }
        compose.runOnIdle {
            val down=android.view.KeyEvent(0,0,android.view.KeyEvent.ACTION_DOWN,android.view.KeyEvent.KEYCODE_T,0,android.view.KeyEvent.META_CTRL_ON or android.view.KeyEvent.META_SHIFT_ON)
            assertTrue(compose.activity.handleShortcut(down))
        }
        compose.waitUntil(15_000) {
            model.state.value.active.id == recoverableId &&
                model.state.value.active.content == "# Recoverable draft"
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
        fun currentVisibleChromeInset():Float = javascriptUntil("parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--native-visible-chrome-inset'))||0") {it.trim('"').toFloatOrNull()!=null}.trim('"').toFloat()
        compose.runOnIdle {
            model.edit(model.state.value.active.id,"# Immersive reading\n\n"+("A paragraph to scroll and read comfortably. ".repeat(12)+"\n\n").repeat(80))
            model.mode("reader");model.zoom(170f)
            compose.activity.requestedOrientation=android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
        }
        try {
            compose.waitUntil(10000) {compose.activity.resources.configuration.orientation==android.content.res.Configuration.ORIENTATION_LANDSCAPE}
            javascriptUntil("document.querySelector('.document-page')?.dataset.scale") {it=="\"1.7\""}
            assertTrue("Visible normal reading controls must report their occlusion",currentVisibleChromeInset()>0f)
            javascriptUntil("window.getSelection()?.removeAllRanges();true") {it=="true"}
            // Layout zoom can serialize the same width with 0.002 px rounding
            // differences. Compare actual CSS-pixel layout widths instead.
            val width=javascriptUntil("document.querySelector('.document-page').clientWidth") {it.toIntOrNull()!=null}
            val textWidth=javascriptUntil("document.querySelector('.markdown-body').clientWidth") {it.toIntOrNull()!=null}
            val viewport=javascriptUntil("JSON.stringify([innerWidth,innerHeight])") {it.contains(",")}
            println("Overlay before start alignment: "+javascriptUntil("JSON.stringify({top:document.querySelector('h1').getBoundingClientRect().top,scroll:document.querySelector('.android-reading').scrollTop,inset:getComputedStyle(document.documentElement).getPropertyValue('--native-chrome-inset')})") {it.contains("inset")})
            // Orientation/mode restoration may correctly retain a reading
            // anchor below the title. Test title clearance at the note's start,
            // not while intentionally scrolled into the document.
            // Announce an actual user navigation before the start alignment.
            // A bare programmatic scrollTop write is not a gesture and can be
            // superseded by pending mode/reading-position restoration.
            javascriptUntil("window.supermdNativeWheel?.(0,0,{x:innerWidth/2,y:innerHeight*.75},false);document.querySelector('.android-reading').scrollTop=0;true") {it=="true"}
            javascriptUntil("document.querySelector('h1').getBoundingClientRect().top>=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--native-chrome-inset'))") {it=="true"}
            // A margin tap has no text/link/edit action and toggles reading UI.
            activityRoot().performTouchInput {click(androidx.compose.ui.geometry.Offset(this.width*.98f,height*.60f))}
            compose.waitUntil(5000) {compose.onAllNodesWithContentDescription("Open files").fetchSemanticsNodes().isEmpty()}
            assertEquals("Hidden normal controls must clear the navigation occlusion without resizing the viewport",0f,currentVisibleChromeInset(),.1f)
            compose.onNodeWithContentDescription("Fullscreen study").assertDoesNotExist()
            assertEquals("Hiding normal chrome must not resize the reading viewport",viewport,javascriptUntil("JSON.stringify([innerWidth,innerHeight])") {it.contains(",")})
            compose.waitUntil(5000) {androidx.core.view.ViewCompat.getRootWindowInsets(compose.activity.window.decorView)?.isVisible(androidx.core.view.WindowInsetsCompat.Type.statusBars())==false}
            val nativeWidth=AtomicReference(0)
            compose.runOnIdle {nativeWidth.set(web(compose.activity.window.decorView)!!.width)}
            assertEquals("Landscape document must extend into the cutout region",compose.activity.window.decorView.width,nativeWidth.get())
            activityRoot().performTouchInput {click(androidx.compose.ui.geometry.Offset(this.width*.98f,height*.60f))}
            compose.waitUntil(5000) {compose.onAllNodesWithContentDescription("Open files").fetchSemanticsNodes().isNotEmpty()}
            assertTrue("Revealed normal reading controls must report their occlusion",currentVisibleChromeInset()>0f)
            compose.onNodeWithContentDescription("Fullscreen study").performClick()
            javascriptUntil("document.documentElement.dataset.fullscreen") {it=="\"true\""}
            javascriptUntil("document.querySelector('.document-page')?.dataset.scale") {it=="\"1.7\""}
            assertEquals(width,javascriptUntil("document.querySelector('.document-page').clientWidth") {it.toIntOrNull()!=null})
            assertEquals("The actual text column, not just its outer page, must retain its width",textWidth,javascriptUntil("document.querySelector('.markdown-body').clientWidth") {it.toIntOrNull()!=null})
            assertEquals("Fullscreen must not resize the reading viewport",viewport,javascriptUntil("JSON.stringify([innerWidth,innerHeight])") {it.contains(",")})
            compose.waitUntil(5000) {compose.onAllNodesWithContentDescription("Exit fullscreen").fetchSemanticsNodes().isEmpty()}
            assertEquals("Immersive fullscreen controls must clear the navigation occlusion",0f,currentVisibleChromeInset(),.1f)
            activityRoot().performTouchInput {click(androidx.compose.ui.geometry.Offset(this.width*.98f,height*.60f))}
            compose.waitUntil(5000) {compose.onAllNodesWithContentDescription("Exit fullscreen").fetchSemanticsNodes().isNotEmpty()}
            compose.onNodeWithContentDescription("Show contents").assertIsDisplayed()
            assertTrue("Revealed fullscreen controls must report their occlusion",currentVisibleChromeInset()>0f)
            assertEquals("Showing compact chrome must not resize the reading viewport",viewport,javascriptUntil("JSON.stringify([innerWidth,innerHeight])") {it.contains(",")})
            compose.onNodeWithContentDescription("Exit fullscreen").performClick()
        } finally {
            compose.runOnIdle {model.fullscreen(false);compose.activity.requestedOrientation=android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT}
            compose.waitUntil(10000) {compose.activity.resources.configuration.orientation==android.content.res.Configuration.ORIENTATION_PORTRAIT}
        }
    }
}
