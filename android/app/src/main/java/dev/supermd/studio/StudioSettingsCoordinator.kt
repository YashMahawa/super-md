package dev.supermd.studio

import android.app.Application
import android.content.Intent
import android.content.SharedPreferences
import android.net.Uri
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

internal class StudioSettingsCoordinator(
    private val app: Application,
    private val prefs: SharedPreferences,
    private val scope: CoroutineScope,
    private val readState: () -> StudioState,
    private val writeState: (StudioState) -> Unit,
    private val changeState: ((StudioState) -> StudioState) -> Unit,
    private val performReaderBarrier: suspend (String, () -> Unit) -> Boolean,
    private val readerBarrierFailed: () -> Unit,
    private val setImageOverlay: (Boolean) -> Unit,
) {
    fun inspectStorage() {
        val initial = readState()
        if (initial.storageScanning) return
        writeState(initial.copy(storageScanning = true))
        scope.launch {
            val report = withContext(Dispatchers.IO) {
                runCatching {
                    StorageInspector.inspect(app.filesDir, app.cacheDir)
                }.getOrElse { StorageInspector.unavailableReport() }
            }
            writeState(readState().copy(storageReport = report, storageScanning = false))
        }
    }

    fun clearPythonStorage() {
        val initial = readState()
        if (initial.storageScanning) return
        writeState(initial.copy(storageScanning = true))
        scope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    val cleared = StorageInspector.clearPythonResults(app.filesDir, app.cacheDir)
                    cleared to StorageInspector.inspect(app.filesDir, app.cacheDir)
                }
            }
            val value = result.getOrNull()
            val latest = readState()
            writeState(
                latest.copy(
                    storageScanning = false,
                    storageReport = value?.second ?: latest.storageReport,
                    message = if (value != null) "Cleared ${value.first} temporary Python result files. Notes and recovery data were preserved." else latest.message,
                    error = if (value == null) "Could not safely clear temporary results: ${result.exceptionOrNull()?.message.orEmpty()}" else null,
                ),
            )
        }
    }

    /** Reads only [prefs] and [s]; safe to call during [StudioViewModel] cold restore before [readState] is initialized. */
    fun readingPreferences(s: StudioState): StudioState = s.copy(
        patternKind = prefs.getString("patternKind", "") ?: "",
        patternOpacity = prefs.getFloat("patternOpacity", -1f),
        patternSize = prefs.getFloat("patternSize", 0f),
        patternSpacing = prefs.getFloat("patternSpacing", 0f),
        centerLock = prefs.getBoolean("centerLock", true),
        restorePosition = prefs.getBoolean("restorePosition", true),
        fullDocumentAccessibility = prefs.getBoolean("fullDocumentAccessibility", false),
        startup = prefs.getString("startup", "restore") ?: "restore",
        imageAppearance = prefs.getString("imageAppearance", "original") ?: "original",
        svgAppearance = prefs.getString("svgAppearance", "original") ?: "original",
        imageContrast = prefs.getFloat("imageContrast", 1.25f),
    )

    fun readingPreference(key: String, value: String) {
        if (key == "patternKind" && value in listOf("", "none", "paws", "dots", "grid", "diagonal", "gradient")) prefs.edit().putString(key, value).apply()
        if (key in listOf("imageAppearance", "svgAppearance") && value in listOf("original", "invert-dark", "auto", "monochrome", "contrast") || key == "startup" && value in listOf("restore", "new")) prefs.edit().putString(key, value).apply()
    }

    fun themeBackgroundPreference(key: String, value: Float) {
        val range = when (key) { "patternOpacity" -> 0f..0.25f; "patternSize" -> 8f..64f; "patternSpacing" -> 12f..192f; else -> return }
        if (value.isFinite() && value in range) prefs.edit().putFloat(key, value).apply()
    }

    fun resetThemeBackground() {
        prefs.edit().remove("patternKind").remove("patternOpacity").remove("patternSize").remove("patternSpacing").apply()
    }

    fun restorePosition(value: Boolean) { prefs.edit().putBoolean("restorePosition", value).apply() }
    fun fullDocumentAccessibility(value: Boolean) { prefs.edit().putBoolean("fullDocumentAccessibility", value).apply() }
    fun centerLock(value: Boolean) { prefs.edit().putBoolean("centerLock", value).apply() }
    fun imageContrast(value: Float) { if (value.isFinite()) prefs.edit().putFloat("imageContrast", value.coerceIn(1f, 2f)).apply() }

    fun readingLocation(uri: String?): JSONObject? =
        if (uri == null) null else runCatching { JSONObject(prefs.getString("readingPositions", "{}")!!).optJSONObject(uri) }.getOrNull()

    fun readingPosition(id: String, location: JSONObject) {
        val state = readState()
        val note = state.tabs.find { it.id == id } ?: return
        val uri = note.uri ?: return
        if (!state.restorePosition) return
        if (listOf("top", "offset", "zoom").any { val v = location.optDouble(it, Double.NaN); !v.isFinite() || v < 0 } || location.optString("mode") !in listOf("reader", "live", "editor", "split")) return
        val old = runCatching { JSONObject(prefs.getString("readingPositions", "{}")!!) }.getOrDefault(JSONObject())
        old.remove(uri)
        old.put(uri, JSONObject().put("top", location.getDouble("top")).put("offset", location.getDouble("offset")).put("zoom", location.getDouble("zoom")).put("mode", location.getString("mode")))
        while (old.length() > 200) old.remove(old.keys().next())
        prefs.edit().putString("readingPositions", old.toString()).apply()
    }

    fun mode(value: String) {
        val expectedActiveId = readState().active.id
        scope.launch {
            val accepted = performReaderBarrier(expectedActiveId) {
                changeState { it.copy(mode = value, editorFocused = if (value == "reader") false else it.editorFocused) }
            }
            if (!accepted) readerBarrierFailed()
        }
    }

    fun fullscreen(value: Boolean) = changeState { s ->
        if (value == s.fullscreen) s else s.copy(
            fullscreen = value,
            // Fullscreen is a chrome change, not a request to load an old scale.
            fullscreenZoom = if (value) s.normalZoom else s.fullscreenZoom,
        )
    }

    // Reader gestures are acknowledgements, not a second command back to WebView.
    // Only an explicit native control/shortcut advances the command generation.
    fun zoom(value: Float) = changeState { s ->
        val command = maxOf(System.currentTimeMillis(), s.zoomCommand + 1)
        if (s.fullscreen) s.copy(fullscreenZoom = value.coerceIn(40f, 300f), zoomCommand = command)
        else s.copy(normalZoom = value.coerceIn(40f, 300f), zoomCommand = command)
    }

    fun readerZoom(value: Float, fullscreen: Boolean) = changeState { s ->
        if (fullscreen) s.copy(fullscreenZoom = value.coerceIn(40f, 300f))
        else s.copy(normalZoom = value.coerceIn(40f, 300f))
    }

    fun appearance(accent: String? = null, theme: String? = null, fullTheme: String? = null, motion: Boolean? = null, font: String? = null, size: Float? = null) {
        if (size != null && (!size.isFinite() || size !in 6f..32f)) return
        changeState { it.copy(accent = accent ?: it.accent, theme = theme ?: it.theme, fullscreenTheme = fullTheme ?: it.fullscreenTheme, motion = motion ?: it.motion, font = font ?: it.font, size = size ?: it.size) }
        prefs.edit().apply { accent?.let { putString("accent", it) }; theme?.let { putString("theme", it) }; fullTheme?.let { putString("fullTheme", it) }; motion?.let { putBoolean("motion", it) }; font?.let { putString("font", it) }; size?.let { putFloat("size", it) } }.apply()
    }

    fun pdf(value: String) { changeState { it.copy(pdf = value) }; prefs.edit().putString("pdf", value).apply() }
    fun noteLocation(): String = prefs.getString("newNoteLocation", "") ?: ""

    fun noteLocation(uri: Uri) {
        app.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        prefs.edit().putString("newNoteLocation", uri.toString()).apply()
    }

    fun reading(widthPercent: Float? = null, lineHeight: Float? = null, autosave: Boolean? = null) {
        val width = widthPercent?.takeIf { it.isFinite() }?.coerceIn(50f, 150f)
        val leading = lineHeight?.takeIf { it.isFinite() }?.coerceIn(1.15f, 2.2f)
        changeState { it.copy(widthPercent = width ?: it.widthPercent, lineHeight = leading ?: it.lineHeight, autosave = autosave ?: it.autosave) }
        prefs.edit().apply { width?.let { putFloat("widthPercent", it) }; leading?.let { putFloat("lineHeight", it) }; autosave?.let { putBoolean("autosave", it) } }.apply()
    }

    fun writing(spellCheck: Boolean? = null, grammarCheck: Boolean? = null) {
        changeState { it.copy(spellCheck = spellCheck ?: it.spellCheck, grammarCheck = grammarCheck ?: it.grammarCheck) }
        prefs.edit().apply { spellCheck?.let { putBoolean("spellCheck", it) }; grammarCheck?.let { putBoolean("grammarCheck", it) } }.apply()
    }

    fun selectionAssistant(value: String) {
        if (SelectionActions.assistants.none { it.first == value }) return
        changeState { it.copy(selectionAssistant = value) }
        prefs.edit().putString("selectionAssistant", value).apply()
    }

    fun latexAutofix(enabled: Boolean) { changeState { it.copy(latexAutofix = enabled) }; prefs.edit().putBoolean("latexAutofix", enabled).apply() }
    fun typewriterScroll(enabled: Boolean) { changeState { it.copy(typewriterScroll = enabled) }; prefs.edit().putBoolean("typewriterScroll", enabled).apply() }
    fun overlay(open: Boolean, image: Boolean = false) { writeState(readState().copy(readerOverlay = open)); setImageOverlay(image) }
    fun editorFocus(focused: Boolean) { val s = readState(); if (s.editorFocused != focused) writeState(s.copy(editorFocused = focused)) }
}
