package dev.supermd.studio

import androidx.compose.material3.ColorScheme
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.luminance

internal fun contrast(foreground: Color, background: Color): Float {
    val a=foreground.luminance();val b=background.luminance()
    return (maxOf(a,b)+.05f)/(minOf(a,b)+.05f)
}
internal fun studyLightColors(base: ColorScheme): ColorScheme {
    // OEM wallpaper palettes can provide a dark container in light mode.
    val container=if(base.primaryContainer.luminance()<.55f)lerp(base.primaryContainer,Color.White,.78f)else base.primaryContainer
    val paper=lerp(lerp(Color.White,container,.88f),base.primary,.025f)
    val low=lerp(lerp(Color.White,container,.8f),base.primary,.065f)
    val high=lerp(lerp(Color.White,container,.8f),base.primary,.23f)
    val surfaces=listOf(paper,low,high)
    fun readable(color:Color, backgrounds:List<Color> = surfaces):Color = if(backgrounds.all {contrast(color,it)>=4.5f})color else listOf(Color(0xff111111),Color(0xfff9f9f9)).maxBy { candidate->backgrounds.minOf {contrast(candidate,it)} }
    val primary=if(contrast(base.primary,paper)>=3f)base.primary else lerp(base.primary,Color.Black,.4f)
    val secondaryContainer=lerp(paper,primary,.19f)
    val tertiaryContainer=lerp(paper,primary,.14f)
    return base.copy(primary=primary,surface=paper,background=paper,surfaceContainerLow=low,surfaceContainerHigh=high,surfaceContainerHighest=high,surfaceContainer=low,
        onSurface=readable(lerp(base.onSurface,paper,.08f)),onSurfaceVariant=readable(base.onSurfaceVariant),
        onPrimary=readable(base.onPrimary,listOf(primary)),onPrimaryContainer=readable(base.onPrimaryContainer,listOf(base.primaryContainer)),
        secondaryContainer=secondaryContainer,onSecondaryContainer=readable(base.onSecondaryContainer,listOf(secondaryContainer)),
        tertiaryContainer=tertiaryContainer,onTertiaryContainer=readable(base.onTertiaryContainer,listOf(tertiaryContainer)),
        outline=readable(base.outline),outlineVariant=lerp(base.outlineVariant,base.onSurface,.35f))
}

// Google's Material Color Utilities TONALSPOT roles, same seeds as desktop.
internal fun accentColors(base:ColorScheme,name:String,dark:Boolean):ColorScheme {
    return if(name=="system") base else manualAccent(name,dark)
}
