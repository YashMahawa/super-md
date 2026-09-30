package dev.supermd.studio
import org.junit.Assert.*
import org.junit.Test
class NoteTest {
    @Test fun savedRevisionDoesNotHideNewerEdits() {
        val note = Note(content = "newer mathematics: α + β", saved = "older")
        assertTrue(note.dirty)
        assertFalse(note.copy(saved = note.content).dirty)
    }
    @Test fun sourceAndFullscreenZoomAreIndependent() {
        val state = StudioState(normalZoom = 110f, fullscreenZoom = 220f)
        assertEquals(110f, state.zoom)
        assertEquals(220f, state.copy(fullscreen = true).zoom)
        assertEquals(110f, state.copy(fullscreen = true).copy(fullscreen = false).zoom)
    }
}
