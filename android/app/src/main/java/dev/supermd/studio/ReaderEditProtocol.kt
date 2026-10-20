package dev.supermd.studio

import java.util.LinkedHashMap
import java.security.MessageDigest

/** UTF-16, original-coordinate edit operation as produced by JavaScript strings. */
internal data class ReaderEditChange(val from: Int, val to: Int, val insert: String)

internal fun readerConflictDraftWithinLimits(content: String, maxChars: Int = 20_000_000, maxUtf8Bytes: Int = 20_000_000): Boolean =
    content.length <= maxChars && content.toByteArray(Charsets.UTF_8).size <= maxUtf8Bytes

/**
 * Pure acknowledgement state for the Android reader's incremental edit stream.
 * Native document contents remain authoritative; this class never persists them.
 */
internal class ReaderEditProtocol(
    private val maxSessions: Int = 128,
    private val maxChanges: Int = MAX_CHANGES,
) {
    init { require(maxSessions > 0 && maxChanges >= 0) }
    internal data class Ack(val accepted: Boolean, val revision: Long? = null) {
        companion object {
            val CONFLICT = Ack(accepted = false)
            fun accepted(revision: Long) = Ack(accepted = true, revision = revision)
        }
    }

    private class PatchProof(
        val epoch: String,
        val baseRevision: Long,
        val revision: Long,
        val changeCount: Int,
        private val digest: ByteArray,
    ) {
        fun matches(other: PatchProof): Boolean = epoch == other.epoch &&
            baseRevision == other.baseRevision && revision == other.revision &&
            changeCount == other.changeCount && MessageDigest.isEqual(digest, other.digest)

        val retainedBytes: Int get() = digest.size + epoch.length * 2 + 20
    }

    private data class Session(
        val epoch: String,
        val revision: Long,
        val content: String,
        val lastPatch: PatchProof? = null,
        val lastAck: Long? = null,
    )

    private val sessions = LinkedHashMap<String, Session>(16, .75f, true)

    @Synchronized
    fun sync(noteId: String, epoch: String, revision: Long, content: String, authoritative: String?): Ack {
        if (!validIdentity(noteId, epoch) || revision != 0L || authoritative == null || content != authoritative) {
            return Ack.CONFLICT
        }
        sessions[noteId] = Session(epoch, 0, content)
        trimSessions()
        return Ack.accepted(0)
    }

    /**
     * Validates and applies a complete patch before advancing its acknowledgement.
     * [commit] is called exactly once for a new valid patch and never for a duplicate.
     */
    @Synchronized
    fun patch(
        noteId: String,
        epoch: String,
        baseRevision: Long,
        revision: Long,
        changes: List<ReaderEditChange>,
        authoritative: String?,
        commit: (String) -> Unit,
    ): Ack {
        if (authoritative == null || noteId.isBlank()) return Ack.CONFLICT
        val session = sessions[noteId] ?: return Ack.CONFLICT
        if (changes.size > maxChanges) return Ack.CONFLICT
        val changesSnapshot = changes.toList()
        val proof = patchProof(epoch, baseRevision, revision, changesSnapshot) ?: return Ack.CONFLICT

        // A reply may have been lost after native accepted this exact payload.
        // Verify the native document still matches the last acknowledgement
        // before repeating the ACK; never bless a stream after divergence.
        if (session.lastPatch?.matches(proof) == true && session.lastAck != null) {
            if (authoritative != session.content) return Ack.CONFLICT
            return Ack.accepted(session.lastAck)
        }

        if (!validIdentity(noteId, epoch) || epoch != session.epoch ||
            baseRevision != session.revision || baseRevision == Long.MAX_VALUE ||
            revision != baseRevision + 1 || authoritative != session.content ||
            !validChanges(session.content, changesSnapshot)
        ) return Ack.CONFLICT

        val updated = try { applyChanges(session.content, changesSnapshot) } catch (_: RuntimeException) { return Ack.CONFLICT }
        try {
            commit(updated)
        } catch (_: Exception) {
            return Ack.CONFLICT
        }
        sessions[noteId] = Session(epoch, revision, updated, proof, revision)
        return Ack.accepted(revision)
    }
    /** Resets the stream only when native still matches one of the reader's last two bases. */
    @Synchronized
    fun resync(
        noteId: String,
        epoch: String,
        revision: Long,
        bases: List<String>,
        content: String,
        authoritative: String?,
        commit: (String) -> Unit,
    ): Ack {
        if (!validIdentity(noteId, epoch) || revision != 0L || authoritative == null ||
            bases.isEmpty() || bases.size > 2 || authoritative !in bases
        ) return Ack.CONFLICT
        try {
            commit(content)
        } catch (_: Exception) {
            return Ack.CONFLICT
        }
        sessions[noteId] = Session(epoch, 0, content)
        trimSessions()
        return Ack.accepted(0)
    }

    @Synchronized
    fun clear(noteId: String) { sessions.remove(noteId) }

    @Synchronized
    internal fun revision(noteId: String): Long? = sessions[noteId]?.revision

    @Synchronized
    internal fun matchesNative(noteId: String, content: String): Boolean = sessions[noteId]?.content?.let { it == content } ?: true

    @Synchronized
    internal fun size(): Int = sessions.size

    @Synchronized
    internal fun retainedPatchProofBytes(noteId: String): Int? = sessions[noteId]?.lastPatch?.retainedBytes

    /** Hashes a canonical field stream without JSON serialization or retaining insert strings. */
    private fun patchProof(
        epoch: String,
        baseRevision: Long,
        revision: Long,
        changes: List<ReaderEditChange>,
    ): PatchProof? {
        var units = epoch.length.toLong()
        changes.forEach { change ->
            units += change.insert.length.toLong()
            if (units > MAX_PATCH_HASH_CODE_UNITS) return null
        }
        val writer = Utf16DigestWriter()
        writer.putString("android-reader-patch-v1")
        writer.putString(epoch)
        writer.putLong(baseRevision)
        writer.putLong(revision)
        writer.putInt(changes.size)
        changes.forEach { change ->
            writer.putInt(change.from)
            writer.putInt(change.to)
            writer.putString(change.insert)
        }
        return PatchProof(epoch, baseRevision, revision, changes.size, writer.finish())
    }

    /** Fixed-size buffer; writes exact UTF-16 code units, including unpaired surrogates. */
    private class Utf16DigestWriter {
        private val digest = MessageDigest.getInstance("SHA-256")
        private val buffer = ByteArray(DIGEST_BUFFER_BYTES)
        private var used = 0

        fun putInt(value: Int) {
            putByte((value ushr 24).toByte())
            putByte((value ushr 16).toByte())
            putByte((value ushr 8).toByte())
            putByte(value.toByte())
        }

        fun putLong(value: Long) {
            for (shift in 56 downTo 0 step 8) putByte((value ushr shift).toByte())
        }

        fun putString(value: String) {
            putInt(value.length)
            value.forEach { unit ->
                putByte((unit.code ushr 8).toByte())
                putByte(unit.code.toByte())
            }
        }

        fun finish(): ByteArray {
            flush()
            return digest.digest()
        }

        private fun putByte(value: Byte) {
            buffer[used++] = value
            if (used == buffer.size) flush()
        }

        private fun flush() {
            if (used == 0) return
            digest.update(buffer, 0, used)
            used = 0
        }
    }

    private fun validIdentity(noteId: String, epoch: String): Boolean =
        noteId.isNotBlank() && epoch.isNotBlank() && epoch.length <= MAX_EPOCH_LENGTH &&
            epoch.none { it.isISOControl() }

    private fun validChanges(content: String, changes: List<ReaderEditChange>): Boolean {
        if (changes.size > maxChanges) return false
        var previousFrom = -1
        var previousTo = 0
        for (change in changes) {
            if (change.from < previousTo || change.from <= previousFrom || change.to < change.from || change.to > content.length) return false
            if (splitsSurrogatePair(content, change.from) || splitsSurrogatePair(content, change.to)) return false
            previousFrom = change.from
            previousTo = change.to
        }
        return true
    }

    private fun splitsSurrogatePair(content: String, index: Int): Boolean =
        index in 1 until content.length && content[index - 1].isHighSurrogate() && content[index].isLowSurrogate()

    /** Apply descending offsets so every range remains in the original coordinate space. */
    private fun applyChanges(content: String, changes: List<ReaderEditChange>): String {
        val result = StringBuilder(content)
        changes.asReversed().forEach { change ->
            result.replace(change.from, change.to, change.insert)
        }
        return result.toString()
    }

    private fun trimSessions() {
        while (sessions.size > maxSessions) sessions.remove(sessions.entries.iterator().next().key)
    }

    companion object {
        const val MAX_EPOCH_LENGTH = 128
        const val MAX_CHANGES = 16_384
        const val MAX_PATCH_HASH_CODE_UNITS = 40_000_000L
        private const val DIGEST_BUFFER_BYTES = 8_192
    }
}
