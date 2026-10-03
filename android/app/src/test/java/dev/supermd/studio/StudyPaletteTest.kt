package dev.supermd.studio
import androidx.compose.material3.lightColorScheme
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import org.junit.Assert.*
import org.junit.Test
class StudyPaletteTest {
    @Test fun manualAccentsReplaceEveryOemRoleInBothModes() {
        for(dark in listOf(false,true)) for(name in listOf("blue","violet","rose","amber")) {
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
}
