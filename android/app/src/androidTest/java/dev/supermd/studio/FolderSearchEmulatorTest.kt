package dev.supermd.studio

import android.app.Application
import android.content.Context
import android.content.Intent
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

@RunWith(AndroidJUnit4::class)
class FolderSearchEmulatorTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val app: Application get() = ApplicationProvider.getApplicationContext()
    private val workspaceKeys = mutableListOf<String>()
    private var savedPrefs: Map<String, Any?> = emptyMap()

    @Before fun setUp() {
        RevocableTestDocumentsProvider.reset(app)
        val prefs = app.getSharedPreferences("studio", Context.MODE_PRIVATE)
        savedPrefs = HashMap(prefs.all)
        prefs.edit().putBoolean("welcomed", true).putString("startup", "restore").putBoolean("autosave", false).commit()
    }

    @After fun tearDown() {
        TestAuthorityGrants.unregisterAuthority(RevocableTestDocumentsProvider.authority(app))
        workspaceKeys.forEach { key ->
            listOf("workspaces/$key", "workspaces/$key.json", "deleted-drafts/$key").forEach { File(app.filesDir, it).deleteRecursively() }
            listOf("studio-$key", "studio-window-$key").forEach { app.getSharedPreferences(it, Context.MODE_PRIVATE).edit().clear().commit(); app.deleteSharedPreferences(it) }
        }
        val editor = app.getSharedPreferences("studio", Context.MODE_PRIVATE).edit().clear()
        for ((k, v) in savedPrefs) when (v) {
            is Boolean -> editor.putBoolean(k, v); is Float -> editor.putFloat(k, v); is Int -> editor.putInt(k, v)
            is Long -> editor.putLong(k, v); is String -> editor.putString(k, v)
            is Set<*> -> @Suppress("UNCHECKED_CAST") editor.putStringSet(k, v as Set<String>)
        }
        editor.commit()
        RevocableTestDocumentsProvider.reset(app)
        TestAuthorityGrants.clear()
    }

    private fun web(view: View): WebView? =
        if (view is WebView) view else if (view is ViewGroup) (0 until view.childCount).firstNotNullOfOrNull { web(view.getChildAt(it)) } else null

    private fun jsUntil(scenario: ActivityScenario<MainActivity>, script: String, accepted: (String) -> Boolean): String {
        val result = AtomicReference("")
        val inFlight = AtomicBoolean(false)
        compose.waitUntil(20_000) {
            if (accepted(result.get())) return@waitUntil true
            if (inFlight.compareAndSet(false, true)) scenario.onActivity { activity ->
                val reader = web(activity.window.decorView)
                if (reader == null) inFlight.set(false) else reader.evaluateJavascript(script) { result.set(it ?: "null"); inFlight.set(false) }
            }
            accepted(result.get())
        }
        return result.get()
    }

    @Test fun textToFilesAndFilesToTextTransitionsFlushAndSeedCorrectlyOnEmulator() {
        val workspace = UUID.randomUUID().toString().also(workspaceKeys::add)
        val treeUri = RevocableTestDocumentsProvider.treeUri(app, "vault")
        val alphaUri = RevocableTestDocumentsProvider.putMarkdown(app, "vault/alpha.md", "# Alpha\n\nSharedProseHit first and SharedProseHit second.\n")
        val quantumUri = RevocableTestDocumentsProvider.putMarkdown(app, "vault/research/quantum-notes.md", "# Quantum\n\nBodyOnlyToken in nested note.\n")
        listOf(treeUri, alphaUri, quantumUri).forEach(RevocableTestDocumentsProvider::grantReadWrite)

        ActivityScenario.launch<MainActivity>(Intent(app, MainActivity::class.java).putExtra("workspace", workspace)).use { scenario ->
            lateinit var model: StudioViewModel
            scenario.onActivity { model = ViewModelProvider(it)[StudioViewModel::class.java].apply { setFolder(treeUri) } }
            compose.waitUntil(20_000) { model.state.value.files.isNotEmpty() }
            jsUntil(scenario, "!!document.querySelector('.android-document')") { it == "true" }

            scenario.onActivity { model.openFolderSearch() }
            compose.onNodeWithText("Search across notes").assertIsDisplayed()
            compose.onNodeWithText("Diagrams").assertIsEnabled()
            compose.onNode(hasSetTextAction()).performTextReplacement("SharedProseHit")
            compose.waitUntil(15_000) { !model.folderSearch.value.scanning && model.folderSearch.value.matches.size == 2 }
            assertEquals(2, compose.onAllNodesWithText("L3").fetchSemanticsNodes().size)

            compose.onNodeWithText("Files").performClick()
            compose.waitUntil(15_000) { model.folderSearch.value.mode == FolderSearchMode.FILES && !model.folderSearch.value.scanning }
            compose.onNodeWithText("Diagrams").assertIsNotEnabled()
            compose.onNodeWithText("No matching file names found.").assertIsDisplayed()
            compose.onNode(hasSetTextAction()).performTextReplacement("research/quantum")
            compose.waitUntil(15_000) { !model.folderSearch.value.scanning && model.folderSearch.value.matches.size == 1 }
            assertEquals(0, compose.onAllNodesWithText("L1").fetchSemanticsNodes().size)
            compose.onNodeWithText("quantum-notes.md").performClick()
            compose.waitUntil(15_000) { model.state.value.active.name == "quantum-notes.md" && !model.folderSearch.value.visible }
            assertNull(model.seededFind.value)
            jsUntil(scenario, "document.querySelector('.android-document h1')?.textContent?.trim()==='Quantum'&&!document.querySelector('.reading-search')") { it == "true" }

            scenario.onActivity { model.mode("editor") }
            compose.waitUntil(15_000) { model.state.value.mode == "editor" }
            jsUntil(scenario, "(()=>{const c=document.querySelector('.cm-content');if(!c)return false;if(!window.__liveTokenPasted){window.__liveTokenPasted=true;c.focus();const d=new DataTransfer();d.setData('text/plain',' LiveUnsavedToken ');c.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:d}));}return c.textContent.includes('LiveUnsavedToken');})()") { it == "true" }

            scenario.onActivity { model.openFolderSearch("") }
            compose.waitUntil(10_000) { model.folderSearch.value.visible && model.folderSearch.value.mode == FolderSearchMode.FILES }
            compose.onNodeWithText("Text").performClick()
            compose.onNodeWithText("Diagrams").assertIsEnabled()
            compose.onNode(hasSetTextAction()).performTextReplacement("LiveUnsavedToken")
            compose.waitUntil(15_000) { !model.folderSearch.value.scanning && model.folderSearch.value.matches.size == 1 }
            assertEquals("quantum-notes.md", model.folderSearch.value.matches.single().name)

            compose.onNode(hasSetTextAction()).performTextReplacement("SharedProseHit")
            compose.waitUntil(15_000) { !model.folderSearch.value.scanning && model.folderSearch.value.matches.size == 2 }
            val secondOccurrence = model.folderSearch.value.matches[1]
            assertTrue(secondOccurrence.sourceStart > model.folderSearch.value.matches[0].sourceStart)
            scenario.onActivity { model.openSearchMatch(secondOccurrence) }
            compose.waitUntil(15_000) { model.state.value.active.name == "alpha.md" }
            jsUntil(scenario, "document.querySelector('.reading-search output')?.textContent") { it == "\"2 / 2\"" }

            scenario.onActivity { model.openFolderSearch("alpha", FolderSearchMode.TEXT) }
            compose.waitUntil(15_000) { model.folderSearch.value.visible && !model.folderSearch.value.scanning }
            compose.onNodeWithText("Files").performClick()
            compose.waitUntil(15_000) { model.folderSearch.value.mode == FolderSearchMode.FILES && !model.folderSearch.value.scanning && model.folderSearch.value.matches.size == 1 }
            compose.onNodeWithText("alpha.md").performClick()
            compose.waitUntil(15_000) { !model.folderSearch.value.visible && model.state.value.active.name == "alpha.md" }
            assertNull(model.seededFind.value)
            jsUntil(scenario, "!document.querySelector('.reading-search')") { it == "true" }
        }
    }
}
