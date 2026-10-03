package dev.supermd.studio
import androidx.compose.material3.lightColorScheme
import androidx.compose.ui.graphics.Color
import org.junit.Assert.*
import org.junit.Test
class StudyPaletteTest {
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
            assertTrue(StudioState().pdf.contains("Manrope"))
        }
    }
}
