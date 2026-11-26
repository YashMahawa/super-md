package dev.supermd.studio

import android.app.Application
import android.content.ClipData
import android.content.Intent
import android.content.SharedPreferences
import android.database.ContentObserver
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.core.content.FileProvider
import java.io.File
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

internal class ThemeLibraryController(
    private val app: Application,
    private val prefs: SharedPreferences,
    private val scope: CoroutineScope,
    private val readState: () -> StudioState,
    private val updateState: (StudioState) -> Unit,
    private val readRecent: () -> List<RecentNote>,
    private val applyReadingPreferences: (StudioState) -> StudioState,
    private val sameDocumentUri: (String, String) -> Boolean,
    private val onFail: (String) -> Unit,
) {
    private val themesDir = File(app.filesDir, "themes")
    private val resolver get() = app.contentResolver
    var themeValidator: (String) -> String = { PdfEngine.validateTheme(it) }
    var bundledThemeReader: ((BundledThemePreset) -> String)? = null
    var isObservingCustomTheme: Boolean = false
        private set
    private var themeJob: Job? = null
    private var themeReloadPending = false
    private val themeObserver = object : ContentObserver(Handler(Looper.getMainLooper())) {
        override fun onChange(selfChange: Boolean) { reloadCustomTheme() }
    }
    private fun SharedPreferences.Editor.clearBackgroundOverrides(): SharedPreferences.Editor =
        remove("patternKind").remove("patternOpacity").remove("patternSize").remove("patternSpacing")
    fun migrateLegacyCustomTheme() {
        if (prefs.getBoolean("themeLibraryMigrated", false)) return
        val legacyRaw = prefs.getString("customTheme", "") ?: ""
        val legacySource = prefs.getString("customThemeSource", "") ?: ""
        if (legacyRaw.isNotBlank() && parseSavedThemes(prefs.getString("savedThemes", null), themesDir).isEmpty()) {
            val name = themeDocument(legacyRaw)?.optString("name")?.takeIf { it.isNotBlank() } ?: "Imported theme"
            val id = UUID.randomUUID().toString().replace("-", "")
            runCatching { writeSavedThemeFile(themesDir, id, legacyRaw) }.onSuccess {
                val saved = listOf(SavedThemeEntry(id, name, legacySource))
                prefs.edit()
                    .putBoolean("themeLibraryMigrated", true)
                    .putString("savedThemes", encodeSavedThemes(saved))
                    .putString("activeThemeKind", "saved")
                    .putString("activeThemeId", id)
                    .apply()
                return
            }
        }
        prefs.edit().putBoolean("themeLibraryMigrated", true).apply()
    }
    fun themePreferences(s: StudioState): StudioState {
        val saved = parseSavedThemes(prefs.getString("savedThemes", null), themesDir)
        val rawTheme = prefs.getString("customTheme", "") ?: ""
        val rawKind = prefs.getString("activeThemeKind", null)
        val rawId = prefs.getString("activeThemeId", "") ?: ""
        val rawSource = prefs.getString("customThemeSource", "") ?: ""
        val (kind, id, source) = when {
            rawTheme.isBlank() -> Triple("builtin", "", "")
            rawKind == "preset" && rawId.isNotBlank() -> Triple("preset", rawId, "")
            rawKind == "saved" && saved.any { it.id == rawId } -> {
                val entry = saved.first { it.id == rawId }
                Triple("saved", entry.id, entry.sourceUri)
            }
            else -> Triple(rawKind ?: "saved", rawId, if (rawKind == "preset") "" else rawSource)
        }
        return s.copy(
            customTheme = rawTheme,
            activeThemeKind = kind,
            activeThemeId = id,
            customThemeSource = source,
            savedThemes = saved,
        )
    }
    private fun openBundledThemeRaw(preset: BundledThemePreset): String {
        bundledThemeReader?.let { return it(preset) }
        return runCatching {
            app.assets.open(preset.assetPath).use(::readBoundedThemeStream)
        }.getOrElse { error ->
            for (candidate in listOf(
                File("../public/themes/${preset.filename}"),
                File("../../public/themes/${preset.filename}"),
                File("public/themes/${preset.filename}"),
            )) {
                if (candidate.isFile) return candidate.inputStream().use(::readBoundedThemeStream)
            }
            throw error
        }
    }
    private fun linkedAssetGrantUris(): List<String> = runCatching {
        val grants = JSONArray(prefs.getString("linkedAssetGrants", "[]"))
        (0 until minOf(grants.length(), 256)).mapNotNull { grants.optJSONObject(it)?.optString("uri")?.takeIf(String::isNotBlank) }
    }.getOrDefault(emptyList())
    private fun isUriStillReferenced(targetUri: String, remainingThemes: List<SavedThemeEntry>): Boolean {
        if (remainingThemes.any { it.sourceUri.isNotBlank() && sameDocumentUri(it.sourceUri, targetUri) }) return true
        val state = readState()
        if (state.tabs.any { it.uri != null && sameDocumentUri(it.uri, targetUri) }) return true
        if (state.closedTabs.any { it.uri != null && sameDocumentUri(it.uri, targetUri) }) return true
        if (readRecent().any { sameDocumentUri(it.uri, targetUri) }) return true
        if (state.folder?.let { sameDocumentUri(it, targetUri) } == true) return true
        if (linkedAssetGrantUris().any { sameDocumentUri(it, targetUri) }) return true
        return false
    }
    fun observeCustomTheme() {
        resolver.unregisterContentObserver(themeObserver)
        isObservingCustomTheme = false
        val kind = prefs.getString("activeThemeKind", "builtin")
        val source = prefs.getString("customThemeSource", null)?.takeIf { it.isNotBlank() }
        if (kind != "preset" && source != null) {
            runCatching {
                resolver.registerContentObserver(Uri.parse(source), true, themeObserver)
                isObservingCustomTheme = true
            }
        }
    }
    fun unregisterObserver() {
        resolver.unregisterContentObserver(themeObserver)
        isObservingCustomTheme = false
    }
    fun handlePreferenceChanged(key: String?) {
        if (key in setOf("customTheme", "customThemeSource", "savedThemes", "activeThemeKind", "activeThemeId")) {
            updateState(themePreferences(readState()))
            if (key in setOf("customThemeSource", "activeThemeKind")) observeCustomTheme()
        }
    }
    fun reloadCustomTheme() {
        if (prefs.getString("activeThemeKind", "builtin") == "preset") return
        val source = prefs.getString("customThemeSource", null)?.takeIf { it.isNotBlank() } ?: return
        if (themeJob?.isActive == true) { themeReloadPending = true; return }
        importCustomTheme(Uri.parse(source), false)
    }
    fun resetCustomTheme() {
        themeReloadPending = false
        themeJob?.cancel()
        prefs.edit()
            .remove("customTheme")
            .remove("customThemeSource")
            .putString("activeThemeKind", "builtin")
            .remove("activeThemeId")
            .clearBackgroundOverrides()
            .apply()
        observeCustomTheme()
        updateState(themePreferences(applyReadingPreferences(readState())))
    }
    suspend fun applyBundledTheme(presetId: String): JSONObject {
        if (presetId == "builtin") {
            resetCustomTheme()
            return JSONObject().put("id", "builtin").put("name", "Built-in appearance")
        }
        val preset = bundledThemes(app.assets).firstOrNull { it.id == presetId }
            ?: error("Unknown bundled theme")
        themeReloadPending = false
        themeJob?.cancel()
        val canonical = withContext(Dispatchers.IO) {
            validateThemeRaw(openBundledThemeRaw(preset), themeValidator)
        }
        val name = JSONObject(canonical).getString("name")
        prefs.edit()
            .putBoolean("themeLibraryMigrated", true)
            .putString("customTheme", canonical)
            .remove("customThemeSource")
            .putString("activeThemeKind", "preset")
            .putString("activeThemeId", preset.id)
            .clearBackgroundOverrides()
            .apply()
        observeCustomTheme()
        updateState(themePreferences(applyReadingPreferences(readState())).copy(message = "Applied $name"))
        return JSONObject().put("id", preset.id).put("name", name)
    }
    fun selectBundledTheme(presetId: String) {
        themeReloadPending = false
        themeJob?.cancel()
        themeJob = scope.launch {
            try {
                applyBundledTheme(presetId)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                onFail("Theme not applied; previous appearance kept. ${error.message}")
            }
        }
    }
    fun selectSavedTheme(entryId: String) {
        themeReloadPending = false
        themeJob?.cancel()
        themeJob = scope.launch {
            try {
                val entry = parseSavedThemes(prefs.getString("savedThemes", null), themesDir).firstOrNull { it.id == entryId }
                    ?: error("Saved theme is unavailable")
                val canonical = withContext(Dispatchers.IO) {
                    val file = File(themesDir, "${entry.id}.json")
                    require(file.isFile) { "Saved theme file is missing" }
                    validateThemeRaw(file.inputStream().use(::readBoundedThemeStream), themeValidator)
                }
                val name = JSONObject(canonical).getString("name")
                prefs.edit()
                    .putString("customTheme", canonical)
                    .apply {
                        if (entry.sourceUri.isNotBlank()) putString("customThemeSource", entry.sourceUri)
                        else remove("customThemeSource")
                    }
                    .putString("activeThemeKind", "saved")
                    .putString("activeThemeId", entry.id)
                    .clearBackgroundOverrides()
                    .apply()
                observeCustomTheme()
                updateState(themePreferences(applyReadingPreferences(readState())).copy(message = "Applied $name"))
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                onFail("Theme not applied; previous appearance kept. ${error.message}")
            }
        }
    }
    fun deleteSavedTheme(entryId: String) {
        val saved = parseSavedThemes(prefs.getString("savedThemes", null), themesDir)
        val removed = saved.firstOrNull { it.id == entryId } ?: return
        val remaining = saved.filterNot { it.id == entryId }
        File(themesDir, "${removed.id}.json").delete()
        val wasActive = prefs.getString("activeThemeKind", null) == "saved" && prefs.getString("activeThemeId", null) == entryId
        if (wasActive) {
            themeReloadPending = false
            themeJob?.cancel()
        }
        prefs.edit()
            .putString("savedThemes", encodeSavedThemes(remaining))
            .apply {
                if (wasActive) {
                    remove("customTheme")
                    remove("customThemeSource")
                    putString("activeThemeKind", "builtin")
                    remove("activeThemeId")
                    clearBackgroundOverrides()
                }
            }
            .apply()
        if (wasActive) observeCustomTheme()
        if (removed.sourceUri.isNotBlank() && !isUriStillReferenced(removed.sourceUri, remaining)) {
            runCatching { resolver.releasePersistableUriPermission(Uri.parse(removed.sourceUri), Intent.FLAG_GRANT_READ_URI_PERMISSION) }
        }
        updateState(themePreferences(applyReadingPreferences(readState())).copy(message = "Removed ${removed.name}"))
    }
    fun importCustomTheme(uri: Uri, remember: Boolean = true) {
        themeJob?.cancel()
        themeJob = scope.launch {
            if (!remember) delay(250)
            try {
                val canonical = withContext(Dispatchers.IO) {
                    val raw = resolver.openInputStream(uri)?.use(::readBoundedThemeStream) ?: error("Cannot read theme")
                    validateThemeRaw(raw, themeValidator)
                }
                val name = JSONObject(canonical).getString("name")
                if (remember) {
                    runCatching { resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
                    val saved = parseSavedThemes(prefs.getString("savedThemes", null), themesDir)
                    val existing = saved.firstOrNull { it.sourceUri.isNotBlank() && sameDocumentUri(it.sourceUri, uri.toString()) }
                    val entryId = existing?.id ?: UUID.randomUUID().toString().replace("-", "")
                    withContext(Dispatchers.IO) { writeSavedThemeFile(themesDir, entryId, canonical) }
                    val updatedSaved = if (existing != null) {
                        saved.map { if (it.id == entryId) SavedThemeEntry(entryId, name, uri.toString()) else it }
                    } else {
                        saved + SavedThemeEntry(entryId, name, uri.toString())
                    }
                    prefs.edit()
                        .putBoolean("themeLibraryMigrated", true)
                        .putString("savedThemes", encodeSavedThemes(updatedSaved))
                        .putString("activeThemeKind", "saved")
                        .putString("activeThemeId", entryId)
                        .putString("customTheme", canonical)
                        .putString("customThemeSource", uri.toString())
                        .clearBackgroundOverrides()
                        .apply()
                    observeCustomTheme()
                    updateState(themePreferences(applyReadingPreferences(readState())).copy(message = "Applied $name"))
                } else {
                    val changed = canonical != readState().customTheme
                    val activeId = prefs.getString("activeThemeId", "") ?: ""
                    val saved = parseSavedThemes(prefs.getString("savedThemes", null), themesDir)
                    val updatedSaved = if (activeId.isNotBlank() && saved.any { it.id == activeId }) {
                        withContext(Dispatchers.IO) { writeSavedThemeFile(themesDir, activeId, canonical) }
                        saved.map { if (it.id == activeId) it.copy(name = name) else it }
                    } else saved
                    prefs.edit()
                        .putString("customTheme", canonical)
                        .apply { if (updatedSaved != saved) putString("savedThemes", encodeSavedThemes(updatedSaved)) }
                        .clearBackgroundOverrides()
                        .apply()
                    val next = themePreferences(applyReadingPreferences(readState()))
                    updateState(if (changed) next.copy(message = "Applied $name") else next)
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                val message = "Theme not applied; previous appearance kept. ${error.message}"
                if (remember) onFail(message) else updateState(readState().copy(message = message))
            }
        }
        themeJob?.invokeOnCompletion { scope.launch { if (themeReloadPending) { themeReloadPending = false; reloadCustomTheme() } } }
    }
    fun exportCustomTheme(uri: Uri): Job = scope.launch {
        val raw = themeForSharing(readState())
        try {
            withContext(Dispatchers.IO) { resolver.openOutputStream(uri, "wt")?.use { it.write(raw.toByteArray(Charsets.UTF_8)) } ?: error("Cannot write theme") }
            updateState(readState().copy(message = "Theme exported. Edit the JSON and import it to apply."))
        } catch (error: Exception) { onFail("Could not export theme: ${error.message}") }
    }
    fun shareCustomTheme(ready: (Intent) -> Unit): Job = scope.launch {
        try {
            val raw = themeForSharing(readState())
            val file = withContext(Dispatchers.IO) {
                val folder = File(app.cacheDir, "share/${UUID.randomUUID()}").apply { mkdirs() }
                File(folder, "Super MD theme.supermd-theme.json").apply { writeText(raw, Charsets.UTF_8) }
            }
            val uri = FileProvider.getUriForFile(app, "${app.packageName}.share", file)
            ready(Intent(Intent.ACTION_SEND).setType("application/json").putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION).apply { clipData = ClipData.newUri(resolver, file.name, uri) })
        } catch (error: Exception) { onFail("Could not share theme: ${error.message}") }
    }
}
