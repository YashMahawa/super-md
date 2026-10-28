package dev.supermd.studio

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AssetWriteSnapshotTest {
    @Test fun concurrentDraftOrTabSwitchInvalidatesAnAssetWriteSnapshot() {
        val saved = Note(id = "note", name = "Note.smd", uri = "file:///note.smd",
            content = "# saved", saved = "# saved", assetDirectory = "123e4567-e89b-12d3-a456-426614174000")
        assertTrue(matchesAssetWriteSnapshot(saved, "note", saved))

        val newerDraft = saved.copy(content = "# newer draft")
        assertTrue(newerDraft.dirty)
        assertFalse(matchesAssetWriteSnapshot(newerDraft, "note", saved))
        assertFalse(matchesAssetWriteSnapshot(saved, "another-tab", saved))
        assertFalse(matchesAssetWriteSnapshot(saved.copy(assetDirectory = "another-directory"), "note", saved))
        assertFalse(matchesAssetWriteSnapshot(saved.copy(uri = "file:///moved.smd"), "note", saved))
    }
}
