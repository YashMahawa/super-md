package dev.supermd.studio

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.ProviderInfo
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import androidx.lifecycle.ViewModelStore
import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
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
class CustomThemeUnitTest {
    private lateinit var app: android.app.Application
    private lateinit var root: File
    private lateinit var provider: ThemeDocumentProvider
    private lateinit var authority: String
    private lateinit var alphaUri: Uri
    private lateinit var betaUri: Uri
    private val workspaceKeys = mutableListOf<String>()
    private val viewModels = mutableListOf<ViewModelStore>()

    @Before fun setUp() {
        app = RuntimeEnvironment.getApplication()
        root = Files.createTempDirectory("custom-theme-test").toFile()
        authority = "dev.supermd.test.themes.${System.nanoTime()}"
        alphaUri = DocumentsContract.buildDocumentUri(authority, "themes/alpha.supermd-theme.json")
        betaUri = DocumentsContract.buildDocumentUri(authority, "themes/beta.supermd-theme.json")
        provider = ThemeDocumentProvider(root).also { it.attach(app, authority) }
        ShadowContentResolver.registerProviderInternal(authority, provider)
        app.grantUriPermission(app.packageName, alphaUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        app.grantUriPermission(app.packageName, betaUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        app.getSharedPreferences("studio", Context.MODE_PRIVATE).edit().clear().commit()
        File(app.filesDir, "themes").deleteRecursively()
    }

    @After fun tearDown() {
        viewModels.forEach { it.clear() }
        app.getSharedPreferences("studio", Context.MODE_PRIVATE).edit().clear().commit()
        File(app.filesDir, "themes").deleteRecursively()
        ShadowContentResolver.reset()
        root.deleteRecursively()
        workspaceKeys.forEach { File(app.filesDir, "workspaces/$it").deleteRecursively() }
    }

    @Test fun bundledThemeCatalogListsAllSixteenPresetsAndIsolatesOverridesAndExports() {
        val catalogFile = sequenceOf(
            "../public/themes/index.json",
            "../../public/themes/index.json",
            "public/themes/index.json",
        ).map(::File).first(File::isFile)
        val expectedCatalog = JSONArray(catalogFile.readText(Charsets.UTF_8)).let { array ->
            (0 until array.length()).map { index ->
                val item = array.getJSONObject(index)
                BundledThemePreset(item.getString("id"), item.getString("name"), item.getString("filename"))
            }
        }
        assertEquals(16, expectedCatalog.size)
        assertEquals(expectedCatalog, BUNDLED_THEMES)
        assertEquals(expectedCatalog, bundledThemes(app.assets))
        val svg = "data:image/svg+xml;base64," + android.util.Base64.encodeToString("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 10 10\"/>".toByteArray(), android.util.Base64.NO_WRAP)
        val raw = JSONObject()
            .put("format", "supermd-theme")
            .put("version", 1)
            .put("name", "Artwork isolation")
            .put("variants", JSONObject().put("dark", JSONObject()
                .put("colors", JSONObject().put("surface", "#16141f"))
                .put("artwork", JSONObject().put("reader", JSONObject().put("image", svg).put("opacity", 0.16).put("fit", "cover")))
            ))
            .toString()
        val parsed = themeDocument(raw)
        assertNotNull(parsed)

        val untouched = themeStyle(parsed, "dark", true)
        assertEquals(JSONObject.NULL, untouched.get("background"))
        assertEquals(0.16, untouched.getJSONObject("artwork").getJSONObject("reader").getDouble("opacity"), 0.001)

        val overridden = themeStyle(parsed, "dark", true, kind = "paws", opacity = 0.0f, size = 28f, spacing = 88f)
        assertEquals("paws", overridden.getJSONObject("background").getString("pattern"))
        assertEquals(0.16, overridden.getJSONObject("artwork").getJSONObject("reader").getDouble("opacity"), 0.001)

        val hidden = themeStyle(parsed, "dark", true, kind = "none", opacity = 0.25f)
        assertEquals("none", hidden.getJSONObject("background").getString("pattern"))
        assertEquals(0.16, hidden.getJSONObject("artwork").getJSONObject("reader").getDouble("opacity"), 0.001)

        val sharedTheme = JSONObject(themeForSharing(StudioState(customTheme = raw, patternKind = "paws", patternOpacity = 0.2f, patternSize = 32f, patternSpacing = 96f)))
        assertFalse(sharedTheme.getJSONObject("variants").getJSONObject("dark").has("background"))
        assertEquals(0.16, sharedTheme.getJSONObject("variants").getJSONObject("dark").getJSONObject("artwork").getJSONObject("reader").getDouble("opacity"), 0.001)

        val sharedTemplate = JSONObject(themeForSharing(StudioState(customTheme = "", patternKind = "paws", patternOpacity = 0.2f, patternSize = 32f, patternSpacing = 96f)))
        assertEquals(JSONObject(themeTemplate).toString(), sharedTemplate.toString())
    }

    @Test fun savedThemeSwitcherRetainsMultipleImportsReleasesUnusedGrantAndScopesObserver() {
        val model = newModel()
        model.readingPreference("patternKind", "paws")
        model.themeBackgroundPreference("patternOpacity", 0.12f)
        model.themeBackgroundPreference("patternSize", 32f)
        model.themeBackgroundPreference("patternSpacing", 96f)

        model.importCustomTheme(alphaUri)
        await { activeThemeName(model) == "Theme Alpha" }
        assertEquals("saved", model.state.value.activeThemeKind)
        assertEquals("", model.state.value.patternKind)
        assertEquals(-1f, model.state.value.patternOpacity, 0.001f)
        assertTrue(model.isObservingCustomTheme)
        assertTrue(hasPersistedReadGrant(alphaUri))

        model.readingPreference("patternKind", "grid")
        model.themeBackgroundPreference("patternSpacing", 64f)
        model.importCustomTheme(betaUri)
        await { activeThemeName(model) == "Theme Beta" }
        assertEquals(listOf("Theme Alpha", "Theme Beta"), model.state.value.savedThemes.map { it.name })
        assertEquals("", model.state.value.patternKind)
        assertEquals(0f, model.state.value.patternSpacing, 0.001f)
        assertTrue(model.isObservingCustomTheme)

        // Switching to a bundled preset via reader guide pauses external URI observation and clears overrides
        model.readingPreference("patternKind", "dots")
        val reply = runBlocking { model.applyBundledTheme("study-desk") }
        assertEquals("Study desk", reply.getString("name"))
        assertEquals("preset", model.state.value.activeThemeKind)
        assertEquals("study-desk", model.state.value.activeThemeId)
        assertEquals("Study desk", activeThemeName(model))
        assertEquals("", model.state.value.patternKind)
        assertFalse(model.isObservingCustomTheme)
        assertEquals("", model.state.value.customThemeSource)

        // Restarting ViewModel preserves both saved themes and switches back cleanly
        val restarted = newModel()
        assertEquals(listOf("Theme Alpha", "Theme Beta"), restarted.state.value.savedThemes.map { it.name })
        val alphaId = restarted.state.value.savedThemes.single { it.name == "Theme Alpha" }.id
        restarted.readingPreference("patternKind", "paws")
        restarted.selectSavedTheme(alphaId)
        await { activeThemeName(restarted) == "Theme Alpha" }
        assertEquals("saved", restarted.state.value.activeThemeKind)
        assertEquals(alphaUri.toString(), restarted.state.value.customThemeSource)
        assertEquals("", restarted.state.value.patternKind)
        assertTrue(restarted.isObservingCustomTheme)

        // Deleting Theme Alpha releases its persisted read grant when unreferenced and falls back to Built-in
        restarted.themeBackgroundPreference("patternOpacity", 0.09f)
        restarted.deleteSavedTheme(alphaId)
        await { restarted.state.value.activeThemeKind == "builtin" }
        assertTrue(restarted.state.value.customTheme.isBlank())
        assertEquals(listOf("Theme Beta"), restarted.state.value.savedThemes.map { it.name })
        assertEquals(-1f, restarted.state.value.patternOpacity, 0.001f)
        assertFalse(restarted.isObservingCustomTheme)
        assertFalse("Unreferenced theme URI permission must be released", hasPersistedReadGrant(alphaUri))
        assertTrue("Remaining saved theme URI permission stays intact", hasPersistedReadGrant(betaUri))
    }

    @Test fun deletingSavedThemeKeepsUriGrantWhenReferencedByAnOpenNote() {
        val model = newModel()
        model.importCustomTheme(alphaUri)
        await { activeThemeName(model) == "Theme Alpha" }
        val alphaId = model.state.value.savedThemes.single().id

        val field = StudioViewModel::class.java.getDeclaredField("mutable").apply { isAccessible = true }
        @Suppress("UNCHECKED_CAST")
        val flow = field.get(model) as kotlinx.coroutines.flow.MutableStateFlow<StudioState>
        flow.value = flow.value.copy(tabs = flow.value.tabs + Note(name = "alpha.md", content = "# Note", saved = "# Note", uri = alphaUri.toString()))

        model.deleteSavedTheme(alphaId)
        await { model.state.value.savedThemes.isEmpty() }
        assertTrue("Grant must not be revoked while an open tab still references the document", hasPersistedReadGrant(alphaUri))
    }

    private fun activeThemeName(model: StudioViewModel): String =
        themeDocument(model.state.value.customTheme)?.optString("name").orEmpty()

    private fun hasPersistedReadGrant(uri: Uri): Boolean =
        app.contentResolver.persistedUriPermissions.any { it.uri == uri && it.isReadPermission }

    private fun newModel(): StudioViewModel {
        val store = ViewModelStore().also(viewModels::add)
        val key = "custom-theme-${System.nanoTime()}".also(workspaceKeys::add)
        val model = StudioViewModel(app, key)
        model.readerFlushRequester = { true }
        model.themeValidator = { raw -> JSONObject().put("theme", JSONObject(raw)).toString() }
        model.bundledThemeReader = { preset ->
            JSONObject()
                .put("format", "supermd-theme")
                .put("version", 1)
                .put("name", preset.name)
                .put("variants", JSONObject().put("dark", JSONObject().put("colors", JSONObject().put("surface", "#181520"))))
                .toString()
        }
        store.put("model", model)
        return model
    }

    private fun await(timeoutMs: Long = 5_000, condition: () -> Boolean) {
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
}

private class ThemeDocumentProvider(private val directory: File) : ContentProvider() {
    val alphaFile = File(directory, "alpha.supermd-theme.json").apply {
        writeText(JSONObject().put("format", "supermd-theme").put("version", 1).put("name", "Theme Alpha").put("variants", JSONObject().put("dark", JSONObject().put("colors", JSONObject().put("surface", "#191524")))).toString())
    }
    val betaFile = File(directory, "beta.supermd-theme.json").apply {
        writeText(JSONObject().put("format", "supermd-theme").put("version", 1).put("name", "Theme Beta").put("variants", JSONObject().put("dark", JSONObject().put("colors", JSONObject().put("surface", "#14211d")))).toString())
    }

    fun attach(context: Context, authority: String) {
        val info = ProviderInfo().apply { this.authority = authority; exported = true; grantUriPermissions = true }
        attachInfo(context, info)
    }

    override fun onCreate() = true

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor {
        val columns = projection?.toList() ?: listOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        val file = fileFor(uri)
        return MatrixCursor(columns.toTypedArray()).apply {
            addRow(columns.map { column ->
                when (column) {
                    OpenableColumns.DISPLAY_NAME -> file.name
                    OpenableColumns.SIZE -> file.length()
                    else -> null
                }
            }.toTypedArray<Any?>())
        }
    }

    override fun getType(uri: Uri) = "application/json"
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor =
        ParcelFileDescriptor.open(fileFor(uri), ParcelFileDescriptor.MODE_READ_ONLY)

    private fun fileFor(uri: Uri): File =
        if (DocumentsContract.getDocumentId(uri).endsWith("beta.supermd-theme.json")) betaFile else alphaFile
}
