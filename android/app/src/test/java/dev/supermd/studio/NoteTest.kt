package dev.supermd.studio
import org.junit.Assert.*
import org.junit.Test
class NoteTest {
    @Test fun reorderingKeepsDraftAndEmbeddedImagesOnTheSameNote() {
        val a = Note(name = "a.md")
        val b = Note(name = "b.smd", content = "![image](smd-asset:x)", assetDirectory = "assets/b", saved = "older")
        val notes = reorderedNotes(listOf(a, b), b.id, 0)
        assertSame(b, notes.first())
        assertTrue(notes.first().dirty)
        assertEquals("assets/b", notes.first().assetDirectory)
        assertEquals(listOf(a, b), reorderedNotes(listOf(a, b), "missing", 0))
        assertEquals(listOf(a, b), reorderedNotes(listOf(a, b), b.id, -1))
    }
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
