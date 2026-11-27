package dev.supermd.studio

import android.content.Context
import android.content.Intent
import android.content.pm.ProviderInfo
import android.net.Uri
import android.os.Bundle
import android.os.Looper
import androidx.core.content.FileProvider
import androidx.lifecycle.ViewModelStore
import java.io.File
import java.nio.file.Files
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowContentResolver

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ThemeLibraryControllerTest {
    private lateinit var app: android.app.Application
    private val stores = mutableListOf<ViewModelStore>()
    private val tempDirs = mutableListOf<File>()
    private val workspaceKeys = mutableListOf<String>()

    @Before fun setUp() {
        app = RuntimeEnvironment.getApplication()
        val shareAuthority = "${app.packageName}.share"
        val fileProvider = FileProvider().also {
            it.attachInfo(app, ProviderInfo().apply {
                authority = shareAuthority
                exported = false
                grantUriPermissions = true
                metaData = Bundle().apply { putInt("android.support.FILE_PROVIDER_PATHS", R.xml.share_paths) }
            })
        }
        ShadowContentResolver.registerProviderInternal(shareAuthority, fileProvider)
        app.getSharedPreferences("studio", Context.MODE_PRIVATE).edit().clear().commit()
        File(app.filesDir, "themes").deleteRecursively()
    }

    @After fun tearDown() {
        stores.forEach { it.clear() }
        app.getSharedPreferences("studio", Context.MODE_PRIVATE).edit().clear().commit()
        File(app.filesDir, "themes").deleteRecursively()
        ShadowContentResolver.reset()
        tempDirs.forEach { it.deleteRecursively() }
        workspaceKeys.forEach { File(app.filesDir, "workspaces/$it").deleteRecursively() }
    }

    @Test fun restoreMigratesLegacyThemeExportsSharesAndUnregistersObserverOnClear() {
        val legacySource = Uri.fromFile(File(Files.createTempDirectory("theme-src").toFile().also(tempDirs::add), "legacy.json").apply {
            writeText(JSONObject().put("format", "supermd-theme").put("version", 1).put("name", "Legacy Ink").toString())
        })
        app.getSharedPreferences("studio", Context.MODE_PRIVATE).edit()
            .putString("customTheme", legacySource.path!!.let(::File).readText())
            .putString("customThemeSource", legacySource.toString())
            .commit()

        val store = ViewModelStore().also(stores::add)
        val key = "theme-ctrl-${System.nanoTime()}".also(workspaceKeys::add)
        val model = StudioViewModel(app, key).also { store.put("model", it) }

        assertEquals("saved", model.state.value.activeThemeKind)
        assertEquals(listOf("Legacy Ink"), model.state.value.savedThemes.map { it.name })
        assertEquals(legacySource.toString(), model.state.value.customThemeSource)
        assertTrue(model.isObservingCustomTheme)

        val exportedFile = File(Files.createTempDirectory("theme-out").toFile().also(tempDirs::add), "exported.json")
        val exportJob = model.exportCustomTheme(Uri.fromFile(exportedFile))
        var sharedIntent: Intent? = null
        val shareJob = model.shareCustomTheme { sharedIntent = it }
        await { exportJob.isCompleted && shareJob.isCompleted && exportedFile.isFile && sharedIntent != null }
        assertEquals("Legacy Ink", JSONObject(exportedFile.readText()).getString("name"))
        assertNotNull(sharedIntent!!.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java))

        model.resetCustomTheme()
        assertEquals("builtin", model.state.value.activeThemeKind)
        assertFalse(model.isObservingCustomTheme)

        model.themeValidator = { raw -> JSONObject().put("theme", JSONObject(raw)).toString() }
        model.selectSavedTheme(model.state.value.savedThemes.single().id)
        await { model.isObservingCustomTheme && model.state.value.activeThemeKind == "saved" }
        store.clear()
        assertFalse("Clearing ViewModel must unregister theme ContentObserver", model.isObservingCustomTheme)
    }

    private fun await(condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 5_000
        val mainLooper = shadowOf(Looper.getMainLooper())
        while (System.currentTimeMillis() < deadline) {
            mainLooper.idle()
            if (condition()) return
            Thread.sleep(10)
        }
        mainLooper.idle()
        assertTrue(condition())
    }
}
