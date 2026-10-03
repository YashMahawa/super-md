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
    val paper=lerp(lerp(base.surface,base.primaryContainer,.9f),base.primary,.035f)
    val low=lerp(lerp(base.surfaceContainerLow,base.primaryContainer,.75f),base.primary,.07f)
    val high=lerp(lerp(base.surfaceContainerHigh,base.primaryContainer,.7f),base.primary,.16f)
    val surfaces=listOf(paper,low,high)
    fun readable(color:Color, backgrounds:List<Color> = surfaces):Color = if(backgrounds.all {contrast(color,it)>=4.5f})color else listOf(Color(0xff111111),Color(0xfff9f9f9)).maxBy { candidate->backgrounds.minOf {contrast(candidate,it)} }
    return base.copy(surface=paper,background=paper,surfaceContainerLow=low,surfaceContainerHigh=high,surfaceContainer=low,
        onSurface=readable(lerp(base.onSurface,paper,.08f)),onSurfaceVariant=readable(base.onSurfaceVariant),
        onPrimary=readable(base.onPrimary,listOf(base.primary)),onPrimaryContainer=readable(base.onPrimaryContainer,listOf(base.primaryContainer)),
        outlineVariant=lerp(base.outlineVariant,base.onSurface,.24f))
}
