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
    val high=lerp(lerp(Color.White,container,.8f),base.primary,.15f)
    val surfaces=listOf(paper,low,high)
    fun readable(color:Color, backgrounds:List<Color> = surfaces):Color = if(backgrounds.all {contrast(color,it)>=4.5f})color else listOf(Color(0xff111111),Color(0xfff9f9f9)).maxBy { candidate->backgrounds.minOf {contrast(candidate,it)} }
    return base.copy(surface=paper,background=paper,surfaceContainerLow=low,surfaceContainerHigh=high,surfaceContainer=low,
        onSurface=readable(lerp(base.onSurface,paper,.08f)),onSurfaceVariant=readable(base.onSurfaceVariant),
        onPrimary=readable(base.onPrimary,listOf(base.primary)),onPrimaryContainer=readable(base.onPrimaryContainer,listOf(base.primaryContainer)),
        outlineVariant=lerp(base.outlineVariant,base.onSurface,.24f))
}

// Google's Material Color Utilities TONALSPOT roles, same seeds as desktop.
internal fun accentColors(base:ColorScheme,name:String,dark:Boolean):ColorScheme {
    val roles=when(name){
        "green"->if(dark)listOf(0xff8ad6b7,0xff003828,0xff00513c,0xffa6f2d2)else listOf(0xff1a6b52,0xffffffff,0xffa6f2d2,0xff00513c)
        "violet"->if(dark)listOf(0xffd4bbfc,0xff39255c,0xff503c74,0xffebdcff)else listOf(0xff69548d,0xffffffff,0xffebdcff,0xff503c74)
        "rose"->if(dark)listOf(0xffffb0c9,0xff541d33,0xff6f3349,0xffffd9e2)else listOf(0xff8b4a61,0xffffffff,0xffffd9e2,0xff6f3349)
        "amber"->if(dark)listOf(0xfff6bc6f,0xff462b00,0xff643f00,0xffffddb5)else listOf(0xff815611,0xffffffff,0xffffddb5,0xff643f00)
        "blue"->if(dark)listOf(0xffa8c8ff,0xff05305f,0xff254777,0xffd5e3ff)else listOf(0xff3f5f90,0xffffffff,0xffd5e3ff,0xff254777)
        else->return base
    }.map {Color(it)}
    return base.copy(primary=roles[0],onPrimary=roles[1],primaryContainer=roles[2],onPrimaryContainer=roles[3])
}
