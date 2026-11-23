package dev.supermd.studio

import android.content.Context
import android.os.Looper
import android.webkit.WebView
import androidx.lifecycle.ViewModelStore
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class TypewriterScrollTest {
    private lateinit var app: android.app.Application
    private var previousTypewriter: Boolean? = null
    private val workspaceKeys = mutableListOf<String>()
    private val viewModels = mutableListOf<String>()
    private val stores = mutableListOf<ViewModelStore>()
    private val scopes = mutableListOf<CoroutineScope>()

    @Before fun setUp() {
        app = RuntimeEnvironment.getApplication()
        val prefs = app.getSharedPreferences("studio", Context.MODE_PRIVATE)
        if (prefs.contains("typewriterScroll")) {
            previousTypewriter = prefs.getBoolean("typewriterScroll", false)
        }
        prefs.edit().remove("typewriterScroll").commit()
    }

    @After fun tearDown() {
        scopes.forEach { it.cancel() }
        stores.forEach { it.clear() }
        val prefs = app.getSharedPreferences("studio", Context.MODE_PRIVATE)
        prefs.edit().apply {
            if (previousTypewriter == null) remove("typewriterScroll")
            else putBoolean("typewriterScroll", previousTypewriter!!)
        }.commit()
        workspaceKeys.forEach { File(app.filesDir, "workspaces/$it").deleteRecursively() }
    }

    private fun newModel(): StudioViewModel {
        val store = ViewModelStore().also(stores::add)
        val key = "typewriter-${System.nanoTime()}".also(workspaceKeys::add)
        val model = StudioViewModel(app, key)
        model.readerFlushRequester = { true }
        store.put("model-${viewModels.size}".also(viewModels::add), model)
        return model
    }

    private fun idleUntil(timeoutMs: Long = 5_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        val mainLooper = shadowOf(Looper.getMainLooper())
        while (System.currentTimeMillis() < deadline) {
            mainLooper.idle()
            if (condition()) return
            Thread.sleep(10)
        }
        mainLooper.idle()
        assertTrue("Condition was not met within ${timeoutMs}ms", condition())
    }

    @Test fun typewriterScrollDefaultsOffAndPersistsAcrossModelRestore() {
        assertFalse(StudioState().typewriterScroll)
        val first = newModel()
        assertFalse(first.state.value.typewriterScroll)

        first.typewriterScroll(true)
        assertTrue(first.state.value.typewriterScroll)
        assertTrue(app.getSharedPreferences("studio", Context.MODE_PRIVATE).getBoolean("typewriterScroll", false))

        val restored = newModel()
        assertTrue(restored.state.value.typewriterScroll)

        restored.typewriterScroll(false)
        assertFalse(restored.state.value.typewriterScroll)
        idleUntil { !first.state.value.typewriterScroll }
    }

    @Test fun readerBridgeSyncsValidBooleanAndRejectsNonBooleanPayloads() {
        val model = newModel()
        val scripts = mutableListOf<String>()
        val web = object : WebView(app) {
            override fun post(action: Runnable?): Boolean =
                action?.let { android.os.Handler(Looper.getMainLooper()).post(it) } ?: false

            override fun evaluateJavascript(script: String, resultCallback: android.webkit.ValueCallback<String>?) {
                scripts += script
                resultCallback?.onReceiveValue("null")
            }
        }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate).also(scopes::add)
        val bridge = ReaderBridge(web, model, scope, ready = {}, assetCapabilities = ReaderAssetCapabilities())

        bridge.post("tw-enable", "typewriter_scroll", """{"enabled":true}""")
        idleUntil { scripts.any { it.contains("\"tw-enable\"") } }
        assertTrue(model.state.value.typewriterScroll)
        assertTrue(scripts.last().contains("true,null"))

        for (invalid in listOf("""{"enabled":"true"}""", """{"enabled":1}""", """{}""")) {
            val beforeCount = scripts.size
            bridge.post("tw-invalid-$beforeCount", "typewriter_scroll", invalid)
            idleUntil { scripts.size > beforeCount }
            assertTrue("Expected error reply for $invalid, got ${scripts.last()}", scripts.last().contains("Invalid typewriter scroll value"))
            assertTrue("Invalid payload must not mutate state", model.state.value.typewriterScroll)
        }

        bridge.post("tw-disable", "typewriter_scroll", """{"enabled":false}""")
        idleUntil { scripts.any { it.contains("\"tw-disable\"") } }
        assertFalse(model.state.value.typewriterScroll)
    }
}
