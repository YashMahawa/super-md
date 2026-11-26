package dev.supermd.studio

import android.content.res.AssetManager
import androidx.compose.material3.ColorScheme
import androidx.compose.ui.graphics.Color
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.UUID

internal const val MAX_THEME_BYTES=2*1024*1024

data class BundledThemePreset(
    val id: String,
    val name: String,
    val filename: String = "$id.supermd-theme.json",
) {
    val assetPath: String get() = "web/themes/$filename"
}

data class SavedThemeEntry(
    val id: String,
    val name: String,
    val sourceUri: String = "",
)

internal val BUNDLED_THEMES: List<BundledThemePreset> = listOf(
    BundledThemePreset("apricot-glow", "Apricot glow"),
    BundledThemePreset("avengers-assembly", "Avengers Assembly"),
    BundledThemePreset("avengers-ink", "Avengers Ink"),
    BundledThemePreset("blueprint", "Blueprint"),
    BundledThemePreset("catnap-paws", "Catnap paws"),
    BundledThemePreset("copper-grid", "Copper grid"),
    BundledThemePreset("doctor-doom", "Doctor Doom"),
    BundledThemePreset("gotham-midnight", "Gotham Midnight"),
    BundledThemePreset("ink-dots", "Ink dots"),
    BundledThemePreset("iron-man-reactor", "Iron Man Reactor"),
    BundledThemePreset("lazy-sunday-cats", "Lazy Sunday cats"),
    BundledThemePreset("midnight-paws", "Midnight paws"),
    BundledThemePreset("plum-linen", "Plum linen"),
    BundledThemePreset("rose-paper", "Rose paper"),
    BundledThemePreset("spider-city", "Spider City"),
    BundledThemePreset("study-desk", "Study desk"),
)

private val PRESET_ID_REGEX = Regex("^[a-z0-9-]+$")
private val SAVED_ID_REGEX = Regex("^[0-9a-f]{8,64}$")

internal fun bundledThemes(assets: AssetManager? = null): List<BundledThemePreset> {
    val files = runCatching { assets?.list("web/themes")?.toSet() }.getOrNull().orEmpty()
    if (files.isEmpty()) return BUNDLED_THEMES
    val known = BUNDLED_THEMES.associateBy { it.filename }
    val matched = BUNDLED_THEMES.filter { it.filename in files }.toMutableList()
    for (filename in files.sorted()) {
        if (!filename.endsWith(".supermd-theme.json") || filename in known) continue
        val id = filename.removeSuffix(".supermd-theme.json")
        if (!PRESET_ID_REGEX.matches(id)) continue
        val label = runCatching {
            val raw = assets!!.open("web/themes/$filename").use(::readBoundedThemeStream)
            JSONObject(raw).optString("name").takeIf { it.isNotBlank() }
        }.getOrNull() ?: id.replace('-', ' ').replaceFirstChar(Char::uppercase)
        matched += BundledThemePreset(id, label, filename)
    }
    return matched.ifEmpty { BUNDLED_THEMES }
}

internal fun readBoundedThemeStream(input: InputStream): String {
    val output = ByteArrayOutputStream()
    val buffer = ByteArray(4096)
    while (output.size() <= MAX_THEME_BYTES) {
        val count = input.read(buffer, 0, minOf(buffer.size, MAX_THEME_BYTES + 1 - output.size()))
        if (count < 0) break
        if (count == 0) error("Theme provider returned no data")
        output.write(buffer, 0, count)
    }
    val bytes = output.toByteArray()
    require(bytes.size <= MAX_THEME_BYTES) { "Theme exceeds 2 MB" }
    return Charsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(bytes))
        .toString()
        .removePrefix("\uFEFF")
}

internal fun validateThemeRaw(raw: String, validator: (String) -> String = PdfEngine::validateTheme): String {
    require(raw.toByteArray(Charsets.UTF_8).size <= MAX_THEME_BYTES) { "Theme exceeds 2 MB" }
    val response = JSONObject(validator(raw))
    require(!response.has("error")) { response.optString("error") }
    return response.getJSONObject("theme").toString()
}

internal fun parseSavedThemes(raw: String?, themesDir: File): List<SavedThemeEntry> {
    if (raw.isNullOrBlank()) return emptyList()
    val array = runCatching { JSONArray(raw) }.getOrNull() ?: return emptyList()
    val result = ArrayList<SavedThemeEntry>(minOf(array.length(), 128))
    for (index in 0 until minOf(array.length(), 128)) {
        val item = array.optJSONObject(index) ?: continue
        val id = item.optString("id")
        val name = item.optString("name")
        val sourceUri = item.optString("sourceUri")
        if (SAVED_ID_REGEX.matches(id) && name.isNotBlank() && File(themesDir, "$id.json").isFile) {
            result += SavedThemeEntry(id, name, sourceUri)
        }
    }
    return result
}

internal fun encodeSavedThemes(entries: List<SavedThemeEntry>): String = JSONArray().apply {
    entries.forEach { entry ->
        put(JSONObject().put("id", entry.id).put("name", entry.name).put("sourceUri", entry.sourceUri))
    }
}.toString()

internal fun writeSavedThemeFile(themesDir: File, id: String, canonicalJson: String) {
    require(SAVED_ID_REGEX.matches(id)) { "Invalid saved theme identifier" }
    check(themesDir.isDirectory || themesDir.mkdirs()) { "Could not prepare saved themes directory" }
    val target = File(themesDir, "$id.json")
    val temp = File(themesDir, "$id.${UUID.randomUUID()}.tmp")
    try {
        temp.writeText(canonicalJson, Charsets.UTF_8)
        if (target.exists() && !temp.renameTo(target)) {
            target.delete()
            check(temp.renameTo(target)) { "Could not save theme file" }
        } else if (!target.exists()) {
            check(temp.renameTo(target)) { "Could not save theme file" }
        }
    } finally {
        temp.delete()
    }
}

// Parsed documents are read-only; callers clone before modifying controls or
// exporting. Keep one active theme, not a parsed copy on every recomposition.
private var cachedThemeRaw=""
private var cachedTheme:JSONObject?=null
@Synchronized internal fun themeDocument(raw:String):JSONObject? {
    if(raw!=cachedThemeRaw){cachedThemeRaw=raw;cachedTheme=if(raw.length<=MAX_THEME_BYTES)runCatching {JSONObject(raw)}.getOrNull()else null}
    return cachedTheme
}
internal fun artworkImage(theme:JSONObject?,art:JSONObject?):String {
    val image=art?.optString("image").orEmpty()
    return if(image.startsWith("asset:"))theme?.optJSONObject("assets")?.optString(image.removePrefix("asset:")).orEmpty()else image
}
internal fun themeVariant(theme:JSONObject?,mode:String,dark:Boolean):JSONObject?=theme?.optJSONObject("variants")?.optJSONObject(if(mode=="black")"black" else if(dark)"dark" else "light")
internal fun hasBackgroundOverride(kind:String,opacity:Float,size:Float,spacing:Float):Boolean=kind.isNotEmpty()||opacity>=0f||size>0f||spacing>0f
internal fun themeStyle(theme:JSONObject?,mode:String,dark:Boolean,kind:String="",opacity:Float=-1f,size:Float=0f,spacing:Float=0f,resolveAssets:Boolean=true):JSONObject {
    val selected=themeVariant(theme,mode,dark)
    val source=selected?.optJSONObject("background")
    val hasOverride=hasBackgroundOverride(kind,opacity,size,spacing)
    val background=if(theme==null)null
        else source?.let {JSONObject(it.toString())}
        ?:if(hasOverride)JSONObject().put("pattern","none").put("color",selected?.optJSONObject("colors")?.optString("primary","#82708e")?:"#82708e")
        else null
    if(hasOverride)background?.apply {
        if(kind.isNotEmpty())put("pattern",kind)
        if(opacity>=0f)put("opacity",opacity.toDouble())
        if(size>0f)put("size",size.toDouble())
        if(spacing>0f)put("spacing",spacing.toDouble())
    }
    val artwork=selected?.optJSONObject("artwork")?.let {JSONObject(it.toString())}?:JSONObject()
    if(resolveAssets){
        // Chrome artwork is painted natively. Do not send its potentially large
        // image strings across the WebView bridge a second/third time.
        artwork.remove("sidebar");artwork.remove("toolbar")
        artwork.optJSONObject("reader")?.let {it.put("image",artworkImage(theme,it))}
    }
    return JSONObject().put("colors",selected?.optJSONObject("colors")?:JSONObject()).put("background",background?:JSONObject.NULL).put("artwork",artwork).put("metrics",theme?.optJSONObject("metrics")?:JSONObject())
}
internal fun themeForSharing(state:StudioState):String = JSONObject(state.customTheme.ifBlank {themeTemplate}).toString()
internal fun customThemeColors(base:ColorScheme,theme:JSONObject?,mode:String,dark:Boolean):ColorScheme {
    val roles=themeVariant(theme,mode,dark)?.optJSONObject("colors")?:return base
    if(listOf("primary","on-primary","primary-container","on-primary-container","surface","surface-low","surface-high","text","muted","outline").none {roles.has(it)})return base
    fun color(key:String,fallback:Color):Color=runCatching {val value=roles.getString(key);require(Regex("#[0-9a-fA-F]{6}").matches(value));Color(android.graphics.Color.parseColor(value))}.getOrDefault(fallback)
    val surface=color("surface",base.surface);var low=color("surface-low",base.surfaceContainerLow);var high=color("surface-high",base.surfaceContainerHigh)
    var surfaces=listOf(surface,low,high)
    if(!hasReadableInk(surfaces)){low=surface;high=surface;surfaces=listOf(surface)}
    val intended=color("primary",base.primary)
    val primary=if(contrast(intended,surface)>=4.5f&&surfaces.all {contrast(intended,it)>=3f})intended else bestReadableInk(surfaces)
    val container=color("primary-container",base.primaryContainer)
    val text=readableColor(color("text",base.onSurface),surfaces)
    return base.copy(primary=primary,onPrimary=readableColor(color("on-primary",base.onPrimary),listOf(primary)),primaryContainer=container,onPrimaryContainer=readableColor(color("on-primary-container",base.onPrimaryContainer),listOf(container)),
        surface=surface,background=surface,onSurface=text,onBackground=text,onSurfaceVariant=readableColor(color("muted",base.onSurfaceVariant),surfaces),outlineVariant=color("outline",base.outlineVariant),
        surfaceContainerLow=low,surfaceContainer=low,surfaceContainerHigh=high,surfaceContainerHighest=high)
}

internal const val themeTemplate="""{"format":"supermd-theme","version":1,"name":"My theme","accent":"violet","variants":{"light":{"colors":{},"background":{"pattern":"dots","color":"#7255a5","opacity":0.05,"spacing":24}},"dark":{"colors":{},"background":{"pattern":"dots","color":"#d4bbfc","opacity":0.04,"spacing":24}}},"metrics":{"controlRadius":22,"contentRadius":16,"paragraphSpacing":1.2,"codePadding":18,"headingWeight":700,"headingTracking":-0.02,"textTracking":0,"tableBorderWidth":1}}"""
