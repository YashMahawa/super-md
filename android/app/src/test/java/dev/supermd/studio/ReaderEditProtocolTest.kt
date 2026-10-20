package dev.supermd.studio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ReaderEditProtocolTest {
    private fun synced(protocol: ReaderEditProtocol, note: String = "note", content: String = "base") =
        protocol.sync(note, "epoch-1", 0, content, content)

    @Test fun syncVerifiesAuthoritativeContentAndRejectsClosedIdsWithoutChangingState() {
        val protocol = ReaderEditProtocol()
        assertFalse(protocol.sync("note", "epoch", 0, "reader text", "native text").accepted)
        assertNull(protocol.revision("note"))
        assertFalse(protocol.sync("note", "epoch", 1, "base", "base").accepted)
        assertFalse(protocol.sync("closed", "epoch", 0, "draft", null).accepted)
        assertNull(protocol.revision("closed"))
        assertEquals(ReaderEditProtocol.Ack.accepted(0), synced(protocol))
    }

    @Test fun originalUtf16OffsetsPreserveEmojiCombiningMarksAndCrLf() {
        val protocol = ReaderEditProtocol()
        var native = "a😀b"
        synced(protocol, content = native)
        val emojiAdjacent = listOf(ReaderEditChange(0, 1, "A"), ReaderEditChange(3, 4, "B"))
        assertEquals(ReaderEditProtocol.Ack.accepted(1), protocol.patch("note", "epoch-1", 0, 1, emojiAdjacent, native) { native = it })
        assertEquals("A😀B", native)

        val unicode = "e\u0301\r\nx"
        native = unicode
        assertEquals(ReaderEditProtocol.Ack.accepted(0), protocol.sync("note", "epoch-2", 0, unicode, native))
        assertEquals(ReaderEditProtocol.Ack.accepted(1), protocol.patch(
            "note", "epoch-2", 0, 1, listOf(ReaderEditChange(0, 1, "E")), unicode,
        ) { native = it })
        assertEquals("E\u0301\r\nx", native)
        assertEquals(ReaderEditProtocol.Ack.accepted(2), protocol.patch(
            "note", "epoch-2", 1, 2, listOf(ReaderEditChange(2, 4, "")), native,
        ) { native = it })
        assertEquals("E\u0301x", native)
    }

    @Test fun surrogatePairCannotBeSplitByPatchBoundary() {
        val protocol = ReaderEditProtocol()
        val native = "a😀b"
        synced(protocol, content = native)
        var commits = 0
        val result = protocol.patch("note", "epoch-1", 0, 1, listOf(ReaderEditChange(2, 3, "")), native) { commits++ }

        assertFalse(result.accepted)
        assertEquals(0, commits)
        assertEquals(0L, protocol.revision("note"))
    }

    @Test fun invalidRangesOverlapOrderingAndChangeCountAreAtomic() {
        val protocol = ReaderEditProtocol(maxChanges = 2)
        val native = "abcdef"
        synced(protocol, content = native)
        val malformed = listOf(
            listOf(ReaderEditChange(2, 4, ""), ReaderEditChange(1, 2, "")), // unsorted/overlap
            listOf(ReaderEditChange(0, 3, ""), ReaderEditChange(2, 4, "")),
            listOf(ReaderEditChange(-1, 0, "")),
            listOf(ReaderEditChange(0, 7, "")),
            listOf(ReaderEditChange(1, 1, "x"), ReaderEditChange(1, 1, "y")),
            listOf(ReaderEditChange(0, 0, "a"), ReaderEditChange(2, 2, "b"), ReaderEditChange(4, 4, "c")),
        )
        malformed.forEach { changes ->
            var commits = 0
            assertFalse(protocol.patch("note", "epoch-1", 0, 1, changes, native) { commits++ }.accepted)
            assertEquals(0, commits)
            assertEquals(0L, protocol.revision("note"))
        }
    }

    @Test fun exactDuplicatePatchReacksWithoutReapplyingButReorderedPayloadConflicts() {
        val protocol = ReaderEditProtocol()
        var native = "abc"
        synced(protocol, content = native)
        var commits = 0
        val exact = listOf(ReaderEditChange(1, 2, "B"))
        val accepted = protocol.patch("note", "epoch-1", 0, 1, exact, native) { native = it; commits++ }
        assertEquals(ReaderEditProtocol.Ack.accepted(1), accepted)
        assertEquals("aBc", native)

        assertEquals(accepted, protocol.patch("note", "epoch-1", 0, 1, exact, native) { commits++ })
        assertFalse(protocol.patch("note", "epoch-1", 0, 1, exact, "external divergence") { commits++ }.accepted)
        assertEquals(ReaderEditProtocol.Ack.accepted(2), protocol.patch("note", "epoch-1", 1, 2, listOf(ReaderEditChange(0, 1, "x")), native) { native = it; commits++ })
        assertEquals(2, commits)
        assertEquals(2L, protocol.revision("note"))
        assertFalse(protocol.patch("note", "epoch-1", 0, 1, exact, native) { commits++ }.accepted)
        assertEquals(2, commits)
    }

    @Test fun largePasteKeepsOnlyCompactProofAndDuplicateStillRequiresNativeAgreement() {
        val protocol = ReaderEditProtocol()
        var native = "x"
        synced(protocol, content = native)
        val paste = "p".repeat(1_000_000)
        val changes = listOf(ReaderEditChange(0, 1, paste))
        var commits = 0

        val accepted = protocol.patch("note", "epoch-1", 0, 1, changes, native) {
            native = it
            commits++
        }
        assertEquals(ReaderEditProtocol.Ack.accepted(1), accepted)
        assertEquals(1, commits)
        assertTrue(requireNotNull(protocol.retainedPatchProofBytes("note")) < 128)

        assertEquals(accepted, protocol.patch("note", "epoch-1", 0, 1, changes, native) { commits++ })
        assertEquals(1, commits)
        assertFalse(protocol.patch("note", "epoch-1", 0, 1, changes, "external divergence") { commits++ }.accepted)
        assertEquals(1, commits)
    }

    @Test fun patchProofHashesExactUtf16CodeUnitsIncludingUnpairedSurrogates() {
        val protocol = ReaderEditProtocol()
        var native = "x"
        synced(protocol, content = native)
        val original = listOf(ReaderEditChange(0, 1, "\uD800"))

        assertEquals(ReaderEditProtocol.Ack.accepted(1), protocol.patch("note", "epoch-1", 0, 1, original, native) { native = it })
        assertEquals(ReaderEditProtocol.Ack.accepted(1), protocol.patch("note", "epoch-1", 0, 1, original, native) {})
        val replacementCharacter = listOf(ReaderEditChange(0, 1, "\uFFFD"))
        assertFalse(protocol.patch("note", "epoch-1", 0, 1, replacementCharacter, native) {}.accepted)
    }

    @Test fun epochRevisionAndNativeDivergenceRejectWithoutPartialMutation() {
        val protocol = ReaderEditProtocol()
        val native = "base"
        synced(protocol, content = native)
        val change = listOf(ReaderEditChange(0, 1, "B"))
        assertFalse(protocol.patch("note", "wrong-epoch", 0, 1, change, native) {}.accepted)
        assertFalse(protocol.patch("note", "epoch-1", 1, 2, change, native) {}.accepted)
        assertFalse(protocol.patch("note", "epoch-1", 0, 2, change, native) {}.accepted)
        assertFalse(protocol.patch("note", "epoch-1", 0, 1, change, "external edit") {}.accepted)
        assertEquals(0L, protocol.revision("note"))
    }

    @Test fun failedCommitDoesNotAdvanceProtocolOrReapplyNativeMutation() {
        val protocol = ReaderEditProtocol()
        var native = "base"
        synced(protocol, content = native)
        val patch = listOf(ReaderEditChange(0, 1, "B"))

        val failed = protocol.patch("note", "epoch-1", 0, 1, patch, native) { throw IllegalStateException("commit failed") }
        assertFalse(failed.accepted)
        assertEquals("base", native)
        assertEquals(0L, protocol.revision("note"))
        assertEquals(ReaderEditProtocol.Ack.accepted(1), protocol.patch("note", "epoch-1", 0, 1, patch, native) { native = it })
        assertEquals("Base", native)
    }

    @Test fun resyncAcceptsOnlyOneOfTwoExactBasesAndStartsNewEpochAtZero() {
        val protocol = ReaderEditProtocol()
        val current = "last acknowledged"
        synced(protocol, content = current)
        var native = current
        val bases = listOf(current, "in-flight edit")
        assertEquals(ReaderEditProtocol.Ack.accepted(0), protocol.resync("note", "epoch-2", 0, bases, "latest UI edit", native) { native = it })
        assertEquals("latest UI edit", native)
        assertEquals(0L, protocol.revision("note"))
        assertFalse(protocol.patch("note", "epoch-1", 0, 1, listOf(ReaderEditChange(0, 0, "x")), native) { native = it }.accepted)
    }

    @Test fun resyncConflictOrMalformedBasesNeverCommitsAndClosedIdsCannotResync() {
        val protocol = ReaderEditProtocol()
        val native = "native"
        synced(protocol, content = native)
        var commits = 0
        assertFalse(protocol.resync("note", "epoch-2", 0, listOf("old", "other"), "draft", native) { commits++ }.accepted)
        assertFalse(protocol.resync("note", "epoch-2", 0, listOf("native", "other", "third"), "draft", native) { commits++ }.accepted)
        assertFalse(protocol.resync("closed", "epoch-2", 0, listOf("native"), "draft", null) { commits++ }.accepted)
        assertEquals(0, commits)
        assertEquals(0L, protocol.revision("note"))
    }

    @Test fun conflictDraftLimitAccountsForCharactersAndUtf8Bytes() {
        assertTrue(readerConflictDraftWithinLimits("A😀", maxChars = 3, maxUtf8Bytes = 5))
        assertFalse(readerConflictDraftWithinLimits("A😀", maxChars = 2, maxUtf8Bytes = 5))
        assertFalse(readerConflictDraftWithinLimits("A😀", maxChars = 3, maxUtf8Bytes = 4))
    }

    @Test fun clearRevokesClosedNoteSessionAndSessionTableRemainsBounded() {
        val protocol = ReaderEditProtocol(maxSessions = 2)
        synced(protocol, "one", "1")
        synced(protocol, "two", "2")
        protocol.clear("one")
        assertFalse(protocol.patch("one", "epoch-1", 0, 1, emptyList(), "1") {}.accepted)
        synced(protocol, "two", "2")
        protocol.sync("three", "epoch-3", 0, "3", "3")
        assertEquals(2, protocol.size())
    }

    @Test fun nativeAuthorityCheckAllowsOnlyLastAcknowledgedContentWhenSessionExists() {
        val protocol = ReaderEditProtocol()
        assertTrue(protocol.matchesNative("note", "initial")) // No live reader session yet.
        synced(protocol, content = "initial")
        assertTrue(protocol.matchesNative("note", "initial"))
        assertFalse(protocol.matchesNative("note", "newer unacknowledged content"))
        protocol.clear("note")
        assertTrue(protocol.matchesNative("note", "initial"))
    }
}
