package dev.supermd.studio

import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class PortableAgentSaveSafetyTest {
    private val originalAssets = JSONObject().put("assets/figure.png", "data:image/png;base64,AA==")
    private val note = Note(
        id = "portable-note",
        name = "Research.smd",
        uri = "content://provider/document/1",
        content = "# Current draft\n",
        saved = "# Saved on disk\n",
        assetDirectory = "00000000-0000-0000-0000-000000000001",
    )

    @Test fun portableSaveRequiresCurrentRevisionSourceAndEveryAssetToMatch() {
        val revision = agentContentRevision(note.content)
        assertTrue(portableSaveSnapshotMatches(note, revision, note.saved, originalAssets, JSONObject(originalAssets.toString())))
        assertFalse(portableSaveSnapshotMatches(note, "0".repeat(64), note.saved, originalAssets, JSONObject(originalAssets.toString())))
        assertFalse(portableSaveSnapshotMatches(note, revision, "# Externally changed\n", originalAssets, JSONObject(originalAssets.toString())))
        assertFalse(portableSaveSnapshotMatches(note, revision, note.saved, originalAssets, JSONObject().put("assets/figure.png", "data:image/png;base64,BB==")))
        assertFalse(portableSaveSnapshotMatches(note, revision, note.saved, originalAssets, JSONObject()))
    }

    @Test fun recoveryRestoresOnlyBytesThatStillMatchThisSaveAttempt() {
        val backup = "original portable bytes".toByteArray()
        val staged = "our staged portable bytes".toByteArray()
        val concurrent = "newer bytes from another writer".toByteArray()
        val concurrentBefore = concurrent.copyOf()

        assertEquals(PortableSaveRecovery.ORIGINAL_INTACT, portableSaveRecovery(backup, backup, staged))
        assertEquals(PortableSaveRecovery.RESTORE_OUR_WRITE, portableSaveRecovery(staged, backup, staged))
        assertEquals(PortableSaveRecovery.LEAVE_CONCURRENT_BYTES, portableSaveRecovery(concurrent, backup, staged))
        assertArrayEquals("The external writer's bytes are not altered by the recovery decision", concurrentBefore, concurrent)
    }
}
