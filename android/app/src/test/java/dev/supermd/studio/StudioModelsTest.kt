package dev.supermd.studio

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class StudioModelsTest {
    @Test fun noteDirtyPortableAndCloseConfirmationFollowSavedAndDraftRules() {
        val unsavedEmpty = Note(uri = null, content = "", saved = "")
        assertFalse(unsavedEmpty.dirty)
        assertFalse(unsavedEmpty.portable)
        assertFalse(unsavedEmpty.requiresCloseConfirmation)

        val unsavedWhitespace = Note(uri = null, content = "   \n\t ", saved = "")
        assertTrue(unsavedWhitespace.dirty)
        assertFalse(unsavedWhitespace.requiresCloseConfirmation)

        val unsavedDraft = Note(uri = null, content = "# Draft", saved = "")
        assertTrue(unsavedDraft.dirty)
        assertTrue(unsavedDraft.requiresCloseConfirmation)

        val unsavedAssetsDirty = Note(uri = null, content = "", saved = "", assetDirectory = "bundle-1", assetsDirty = true)
        assertTrue(unsavedAssetsDirty.portable)
        assertTrue(unsavedAssetsDirty.dirty)
        assertTrue(unsavedAssetsDirty.requiresCloseConfirmation)

        val savedClean = Note(uri = "content://provider/doc/1", content = "# Note", saved = "# Note")
        assertFalse(savedClean.dirty)
        assertFalse(savedClean.requiresCloseConfirmation)

        val savedClearedToBlank = savedClean.copy(content = "")
        assertTrue(savedClearedToBlank.dirty)
        assertTrue(savedClearedToBlank.requiresCloseConfirmation)
    }

    @Test fun studioStateComputedPropertiesResolveFallbacksZoomAndConflictLookups() {
        val first = Note(id = "tab-1", name = "First.md", uri = "content://provider/doc/1")
        val second = Note(id = "tab-2", name = "Second.md", uri = "content://provider/doc/2")
        val state = StudioState(
            tabs = listOf(first, second),
            activeId = "tab-2",
            normalZoom = 115f,
            fullscreenZoom = 180f,
            conflictedTabIds = setOf("tab-2"),
            blockedWriteUris = setOf("content://provider/doc/1"),
            pendingCloseNoteId = "tab-1",
            pendingSaveConflictNoteId = "tab-2",
        )
        assertSame(second, state.active)
        assertEquals(115f, state.zoom)
        assertEquals(180f, state.copy(fullscreen = true).zoom)
        assertTrue(state.activeConflicted)
        assertFalse(state.copy(activeId = "tab-1").activeConflicted)
        assertSame(first, state.pendingCloseNote)
        assertSame(second, state.pendingSaveConflictNote)
        assertNull(state.copy(pendingCloseNoteId = "missing").pendingCloseNote)
        assertNull(state.copy(pendingSaveConflictNoteId = null).pendingSaveConflictNote)
        assertTrue(state.writeNeedsAccess("tab-1"))
        assertFalse(state.writeNeedsAccess("tab-2"))

        val fallbackFirst = state.copy(activeId = "missing")
        assertSame(first, fallbackFirst.active)

        val emptyTabs = StudioState(tabs = emptyList(), activeId = "missing", conflictedTabIds = setOf(""))
        assertEquals("", emptyTabs.active.id)
        assertEquals("Super MD", emptyTabs.active.name)
        assertFalse(emptyTabs.activeConflicted)
    }

    @Test fun orderedRecentsRenamedRelativeAndReorderedNotesPreserveOrderingInvariants() {
        val unpinned = (1..12).map { RecentNote("Note $it", "uri:$it") }
        val dupFirst = RecentNote("Duplicate 1", "uri:1", pinned = false)
        val pinnedA = RecentNote("Pinned A", "uri:pin-a", pinned = true)
        val pinnedB = RecentNote("Pinned B", "uri:pin-b", pinned = true)
        val ordered = orderedRecents(unpinned + listOf(dupFirst, pinnedA, pinnedB, pinnedA.copy(name = "Ignored dup")))
        assertEquals(10, ordered.size)
        assertEquals(listOf("uri:pin-a", "uri:pin-b"), ordered.take(2).map { it.uri })
        assertEquals(10, ordered.map { it.uri }.distinct().size)

        assertNull(renamedRelative(null, "Renamed.md"))
        assertEquals("Renamed.md", renamedRelative("Original.md", "Renamed.md"))
        assertEquals("notes/2026/Renamed.md", renamedRelative("notes/2026/Original.md", "Renamed.md"))

        val a = Note(id = "a", name = "a.md")
        val b = Note(id = "b", name = "b.md")
        val c = Note(id = "c", name = "c.md")
        val list = listOf(a, b, c)
        assertEquals(listOf(c, a, b), reorderedNotes(list, "c", 0))
        assertSame(list, reorderedNotes(list, "b", 1))
        assertSame(list, reorderedNotes(list, "unknown", 0))
        assertSame(list, reorderedNotes(list, "a", -1))
        assertSame(list, reorderedNotes(list, "a", 3))
    }

    @Test fun revisionPortableSaveAndAssetWriteSnapshotsMatchExpectedContracts() {
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", agentContentRevision(""))
        val assetsA = JSONObject().put("assets/a.png", "data:image/png;base64,AA==")
        val note = Note(id = "n1", uri = "file:///n1.smd", content = "# Draft", saved = "# Base", assetDirectory = "dir-1")
        val upperRev = agentContentRevision(note.content).uppercase()
        assertTrue(portableSaveSnapshotMatches(note, upperRev, "# Base", assetsA, JSONObject(assetsA.toString())))
        assertFalse(portableSaveSnapshotMatches(note, "0".repeat(64), "# Base", assetsA, assetsA))
        assertFalse(portableSaveSnapshotMatches(note, upperRev, "# Other", assetsA, assetsA))
        assertFalse(portableSaveSnapshotMatches(note, upperRev, "# Base", assetsA, JSONObject()))

        val orig = byteArrayOf(1, 2)
        val staged = byteArrayOf(3, 4)
        assertEquals(PortableSaveRecovery.ORIGINAL_INTACT, portableSaveRecovery(byteArrayOf(1, 2), orig, staged))
        assertEquals(PortableSaveRecovery.RESTORE_OUR_WRITE, portableSaveRecovery(byteArrayOf(3, 4), orig, staged))
        assertEquals(PortableSaveRecovery.LEAVE_CONCURRENT_BYTES, portableSaveRecovery(byteArrayOf(9, 9), orig, staged))

        assertFalse(matchesAssetWriteSnapshot(null, "n1", note))
        assertTrue(matchesAssetWriteSnapshot(note, "n1", note, requireActive = true))
        assertFalse(matchesAssetWriteSnapshot(note, "other", note, requireActive = true))
        assertTrue(matchesAssetWriteSnapshot(note, "other", note, requireActive = false))
        assertFalse(matchesAssetWriteSnapshot(note.copy(saved = "# Changed"), "n1", note))
    }
}
