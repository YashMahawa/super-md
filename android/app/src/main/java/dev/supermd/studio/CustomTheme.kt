package dev.supermd.studio

import androidx.compose.material3.ColorScheme
import androidx.compose.ui.graphics.Color
import org.json.JSONObject

internal const val MAX_THEME_BYTES=2*1024*1024
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
internal fun themeStyle(theme:JSONObject?,mode:String,dark:Boolean,kind:String="",opacity:Float=-1f,size:Float=0f,spacing:Float=0f,resolveAssets:Boolean=true):JSONObject {
    val selected=themeVariant(theme,mode,dark)
    val source=selected?.optJSONObject("background")
    val background=if(theme==null)null else source?.let {JSONObject(it.toString())}?:JSONObject().put("pattern","none").put("color",selected?.optJSONObject("colors")?.optString("primary","#82708e")?:"#82708e")
    background?.apply {
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
    if(opacity>=0f)artwork.optJSONObject("reader")?.put("opacity",opacity.toDouble())
    return JSONObject().put("colors",selected?.optJSONObject("colors")?:JSONObject()).put("background",background?:JSONObject.NULL).put("artwork",artwork).put("metrics",theme?.optJSONObject("metrics")?:JSONObject())
}
internal fun themeForSharing(state:StudioState):String {
    val theme=JSONObject(state.customTheme.ifBlank {themeTemplate})
    val variants=theme.optJSONObject("variants")?:return theme.toString()
    for(mode in listOf("light","dark","black"))variants.optJSONObject(mode)?.apply {
        val style=themeStyle(theme,mode,mode!="light",state.patternKind,state.patternOpacity,state.patternSize,state.patternSpacing,resolveAssets=false)
        put("background",style.opt("background"));if(style.getJSONObject("artwork").length()>0)put("artwork",style.getJSONObject("artwork"))
    }
    return theme.toString()
}
internal fun customThemeColors(base:ColorScheme,theme:JSONObject?,mode:String,dark:Boolean):ColorScheme {
    val roles=themeVariant(theme,mode,dark)?.optJSONObject("colors")?:return base
    if(listOf("primary","on-primary","primary-container","on-primary-container","surface","surface-low","surface-high","text","muted","outline").none {roles.has(it)})return base
    fun color(key:String,fallback:Color):Color=runCatching {val value=roles.getString(key);require(Regex("#[0-9a-fA-F]{6}").matches(value));Color(android.graphics.Color.parseColor(value))}.getOrDefault(fallback)
    val surface=color("surface",base.surface);var low=color("surface-low",base.surfaceContainerLow);var high=color("surface-high",base.surfaceContainerHigh)
    var surfaces=listOf(surface,low,high)
    if(listOf(Color(0xff111111),Color(0xfff9f9f9)).maxOf {c->surfaces.minOf {contrast(c,it)}}<4.5f){low=surface;high=surface;surfaces=listOf(surface)}
    fun readable(value:Color,backgrounds:List<Color> = surfaces)=if(backgrounds.all {contrast(value,it)>=4.5f})value else listOf(Color(0xff111111),Color(0xfff9f9f9)).maxBy {c->backgrounds.minOf {contrast(c,it)}}
    val intended=color("primary",base.primary)
    val primary=if(contrast(intended,surface)>=4.5f&&surfaces.all {contrast(intended,it)>=3f})intended else readable(intended)
    val container=color("primary-container",base.primaryContainer)
    val text=readable(color("text",base.onSurface))
    return base.copy(primary=primary,onPrimary=readable(color("on-primary",base.onPrimary),listOf(primary)),primaryContainer=container,onPrimaryContainer=readable(color("on-primary-container",base.onPrimaryContainer),listOf(container)),
        surface=surface,background=surface,onSurface=text,onBackground=text,onSurfaceVariant=readable(color("muted",base.onSurfaceVariant)),outlineVariant=color("outline",base.outlineVariant),
        surfaceContainerLow=low,surfaceContainer=low,surfaceContainerHigh=high,surfaceContainerHighest=high)
}

internal const val themeTemplate="""{"format":"supermd-theme","version":1,"name":"My theme","accent":"violet","variants":{"light":{"colors":{},"background":{"pattern":"dots","color":"#7255a5","opacity":0.05,"spacing":24}},"dark":{"colors":{},"background":{"pattern":"dots","color":"#d4bbfc","opacity":0.04,"spacing":24}}},"metrics":{"controlRadius":22,"contentRadius":16,"paragraphSpacing":1.2,"codePadding":18,"headingWeight":700,"headingTracking":-0.02,"textTracking":0,"tableBorderWidth":1}}"""
