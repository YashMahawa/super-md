package dev.supermd.studio
import androidx.compose.material3.lightColorScheme
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class StudyPaletteTest {
    @Test fun manualAccentsReplaceEveryOemRoleInBothModes() {
        for(dark in listOf(false,true)) for(name in listOf("blue","green","violet","rose","amber")) {
            val first=accentColors(lightColorScheme(primary=Color.Red,secondary=Color.Green),name,dark)
            val second=accentColors(lightColorScheme(primary=Color.Yellow,secondary=Color.Magenta),name,dark)
            assertEquals(first.toString(),second.toString())
            for(pair in listOf(first.onPrimary to first.primary,first.onSecondary to first.secondary,first.onTertiary to first.tertiary,first.onPrimaryContainer to first.primaryContainer,first.onSecondaryContainer to first.secondaryContainer,first.onTertiaryContainer to first.tertiaryContainer,first.onSurface to first.surface,first.onSurface to first.surfaceContainerHigh)) assertTrue("$name dark=$dark contrast",contrast(pair.first,pair.second)>=4.5f)
        }
    }
    @Test fun darkOemContainerCannotMakeLightReadingDark() {
        val colors=studyLightColors(lightColorScheme(primary=Color(0xff42669e),primaryContainer=Color(0xff15283b)))
        assertTrue(colors.surface.luminance() > .6f)
        assertTrue(contrast(colors.onSurface,colors.surface)>=4.5f)
    }
    @Test fun presetColorsAndOutlineHierarchyAreDeterministic() {
        val base=lightColorScheme()
        assertEquals(base,accentColors(base,"system",false))
        assertNotEquals(accentColors(base,"blue",false).primary,accentColors(base,"rose",false).primary)
        for(dark in listOf(false,true)) {
            val green=accentColors(base,"green",dark)
            for(other in listOf("blue","violet","rose","amber")) {
                assertNotEquals("green distinct from $other dark=$dark",accentColors(base,other,dark).primary,green.primary)
            }
        }
        val entries=listOf(OutlineHeading("a","Root",2,0),OutlineHeading("b","Child",3,10),OutlineHeading("c","Nested",4,20),OutlineHeading("d","Root2",2,30))
        assertEquals(listOf("a","d"),outlineRows(entries,emptySet()).map{it.heading.id})
        assertEquals(listOf("a","b","d"),outlineRows(entries,setOf("a")).map{it.heading.id})
        assertEquals(listOf(0,1,2,0),outlineRows(entries,setOf("a","b")).map{it.depth})
    }
    @Test fun tintedPaperKeepsReadableControls() {
        for(accent in listOf(Color(0xff42669e),Color(0xff9b481b),Color(0xff226a48))) {
            val base=lightColorScheme(primary=accent,primaryContainer=Color(0xffffdcc7))
            val colors=studyLightColors(base)
            assertNotEquals(base.surface,colors.surface)
            assertNotEquals(colors.surface,colors.surfaceContainerHigh)
            for(bg in listOf(colors.surface,colors.surfaceContainerLow,colors.surfaceContainerHigh)) {
                assertTrue(contrast(colors.onSurface,bg)>=4.5f)
                assertTrue(contrast(colors.onSurfaceVariant,bg)>=4.5f)
            }
            assertEquals("Manrope",StudioState().font)
            assertEquals(15f,StudioState().size)
            assertTrue(contrast(colors.onPrimary,colors.primary)>=4.5f)
            assertTrue(contrast(colors.onSecondaryContainer,colors.secondaryContainer)>=4.5f)
            assertTrue(contrast(colors.onTertiaryContainer,colors.tertiaryContainer)>=4.5f)
            assertTrue(StudioState().pdf.contains("Manrope"))
        }
    }
    @Test fun sharedContrastHelpersMatchCustomThemeColorsClamping() {
        val lightSurfaces=listOf(Color(0xfff5fbf6),Color(0xffedf4ef),Color(0xffdce8e0))
        val darkSurfaces=listOf(Color(0xff141816),Color(0xff1c221f),Color(0xff262e2a))
        assertTrue(hasReadableInk(lightSurfaces))
        assertTrue(hasReadableInk(darkSurfaces))
        assertFalse(hasReadableInk(listOf(Color.White,Color(0xff111111))))
        assertEquals(Color(0xff1a6b52),readableColor(Color(0xff1a6b52),lightSurfaces))
        assertEquals(Color(0xff111111),readableColor(Color(0xffcbd8d1),lightSurfaces))
        assertEquals(Color(0xfff9f9f9),readableColor(Color(0xff2c3330),darkSurfaces))

        val base=accentColors(lightColorScheme(),"green",true)
        val clamped=customThemeColors(base,JSONObject().put("variants",JSONObject().put("dark",JSONObject().put("colors",JSONObject()
            .put("surface","#222222").put("surface-low","#222222").put("surface-high","#222222")
            .put("text","#222222").put("muted","#222222").put("primary","#222222").put("on-primary","#eeeeee")
            .put("primary-container","#eeeeee").put("on-primary-container","#eeeeee")))),"dark",true)
        assertEquals(readableColor(Color(0xff222222),listOf(Color(0xff222222))),clamped.onSurface)
        assertEquals(Color(0xfff9f9f9),clamped.primary)
        assertEquals(Color(0xff111111),clamped.onPrimary)
        assertEquals(Color(0xff111111),clamped.onPrimaryContainer)

        val conflicting=customThemeColors(base,JSONObject().put("variants",JSONObject().put("light",JSONObject().put("colors",JSONObject()
            .put("surface","#ffffff").put("surface-low","#111111").put("surface-high","#eeeeee").put("text","#dddddd")))),"light",false)
        assertEquals(Color.White,conflicting.surfaceContainerLow)
        assertEquals(Color.White,conflicting.surfaceContainerHigh)
        assertEquals(readableColor(Color(0xffdddddd),listOf(Color.White)),conflicting.onSurface)
    }
}
