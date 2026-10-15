package dev.supermd.studio

import androidx.compose.material3.ColorScheme
import androidx.compose.ui.graphics.Color
import org.json.JSONObject

internal fun themeDocument(raw:String):JSONObject?=runCatching {JSONObject(raw)}.getOrNull()
internal fun themeVariant(theme:JSONObject?,mode:String,dark:Boolean):JSONObject?=theme?.optJSONObject("variants")?.optJSONObject(if(mode=="black")"black" else if(dark)"dark" else "light")
internal fun themeStyle(theme:JSONObject?,mode:String,dark:Boolean)=JSONObject().put("colors",themeVariant(theme,mode,dark)?.optJSONObject("colors")?:JSONObject()).put("background",themeVariant(theme,mode,dark)?.optJSONObject("background")?:JSONObject.NULL).put("metrics",theme?.optJSONObject("metrics")?:JSONObject())
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
