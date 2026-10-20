package dev.supermd.studio

import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.util.UUID

/** Immutable private snapshots; the reopen index is small and bounded, files aren't auto-deleted. */
internal data class ClosedNoteReference(
    val id: String,
    val name: String,
    val uri: String?,
    val relative: String?,
    val assetDirectory: String?,
    val snapshot: String,
) {
    fun placeholder() = Note(id = id, name = name, uri = uri, relative = relative,
        assetDirectory = assetDirectory)
}

/**
 * Rebuilds the visible reopen list. If the private index is corrupt, its saved
 * entries remain untouched and empty placeholders are withheld rather than
 * reopening as apparent blank notes.
 */
internal fun closedNotesForRestore(
    references: List<ClosedNoteReference>,
    persisted: List<Note>,
    activeIds: Set<String>,
    indexValid: Boolean,
): List<Note> {
    val availableReferences = references.filterNot { it.id in activeIds }.take(ClosedNoteStore.LIMIT)
    val indexedIds = availableReferences.map { it.id }.toSet()
    val legacy = persisted.filter { it.id !in activeIds && it.id !in indexedIds }
    val safeLegacy = if (indexValid) legacy else legacy.filter {
        it.content.isNotEmpty() || it.saved.isNotEmpty() || it.assetDirectory != null
    }
    return (availableReferences.map { it.placeholder() } + safeLegacy).take(ClosedNoteStore.LIMIT)
}

internal class ClosedNoteStore(
    private val root: File,
    private val newSnapshotToken: () -> String = { UUID.randomUUID().toString().replace("-", "") },
    private val promote: (File, File) -> Boolean = { staged, target -> staged.renameTo(target) },
) {
    companion object {
        const val LIMIT = 12
        private const val SNAPSHOT_MAGIC = 0x534D4443 // SMDC
        private const val INDEX_MAGIC = 0x534D4449 // SMDI
        private const val VERSION = 1
        private const val MAX_FIELD_BYTES = 120_000_000
    }

    private fun snapshotFile(token: String): File {
        require(token.matches(Regex("[a-f0-9]{32}"))) { "Invalid closed-note snapshot reference" }
        return File(root, "snapshot-$token.bin")
    }

    fun save(note: Note): ClosedNoteReference {
        require(note.id.isNotBlank()) { "Invalid closed note" }
        root.mkdirs()
        val token = newSnapshotToken()
        val target = snapshotFile(token)
        val staged = File.createTempFile("closed-note-", ".tmp", root)
        try {
            FileOutputStream(staged).use { raw ->
                DataOutputStream(BufferedOutputStream(raw)).use { out ->
                    out.writeInt(SNAPSHOT_MAGIC); out.writeInt(VERSION)
                    writeString(out, note.id); writeString(out, note.name); writeNullable(out, note.uri)
                    writeString(out, note.content); writeString(out, note.saved)
                    writeNullable(out, note.relative); writeNullable(out, note.assetDirectory)
                    out.flush(); raw.fd.sync()
                }
            }
            check(promote(staged, target)) { "Could not preserve closed note" }
        } finally { staged.delete() }
        return ClosedNoteReference(note.id, note.name, note.uri, note.relative, note.assetDirectory, token)
    }

    fun load(reference: ClosedNoteReference): Note {
        val file = snapshotFile(reference.snapshot)
        require(file.isFile) { "The closed-note snapshot is unavailable" }
        return DataInputStream(BufferedInputStream(FileInputStream(file))).use { input ->
            require(input.readInt() == SNAPSHOT_MAGIC && input.readInt() == VERSION) { "Invalid closed-note snapshot" }
            val note = Note(
                id = readString(input), name = readString(input), uri = readNullable(input),
                content = readString(input), saved = readString(input),
                relative = readNullable(input), assetDirectory = readNullable(input),
            )
            require(note.id == reference.id) { "Closed-note snapshot identity mismatch" }
            note
        }
    }

    fun loadForRecovery(reference: ClosedNoteReference, recovered: Note): Note =
        runCatching { load(reference) }.getOrDefault(recovered)

    fun saveIndex(references: List<ClosedNoteReference>) {
        require(references.size <= LIMIT) { "Too many closed-note references" }
        root.mkdirs()
        val target = File(root, "index.bin")
        val staged = File.createTempFile("closed-index-", ".tmp", root)
        try {
            FileOutputStream(staged).use { raw ->
                DataOutputStream(BufferedOutputStream(raw)).use { out ->
                    out.writeInt(INDEX_MAGIC); out.writeInt(VERSION); out.writeInt(references.size)
                    references.forEach { ref ->
                        writeString(out, ref.id); writeString(out, ref.name); writeNullable(out, ref.uri)
                        writeNullable(out, ref.relative); writeNullable(out, ref.assetDirectory); writeString(out, ref.snapshot)
                    }
                    out.flush(); raw.fd.sync()
                }
            }
            check(promote(staged, target)) { "Could not update closed-note index" }
        } finally { staged.delete() }
    }

    fun loadIndex(): List<ClosedNoteReference> {
        return runCatching { loadIndexStrict() }.getOrDefault(emptyList())
    }

    fun loadIndexStrict(): List<ClosedNoteReference> {
        val file = File(root, "index.bin")
        if (!file.isFile) return emptyList()
        return DataInputStream(BufferedInputStream(FileInputStream(file))).use { input ->
            require(input.readInt() == INDEX_MAGIC && input.readInt() == VERSION) { "Invalid closed-note index" }
            val count = input.readInt(); require(count in 0..LIMIT) { "Invalid closed-note index size" }
            val references=List(count) {
                val ref = ClosedNoteReference(readString(input), readString(input), readNullable(input),
                    readNullable(input), readNullable(input), readString(input))
                snapshotFile(ref.snapshot)
                ref
            }
            require(references.all {snapshotFile(it.snapshot).isFile}) { "A closed-note snapshot is unavailable" }
            references
        }
    }

    private fun writeString(out: DataOutputStream, value: String) {
        val bytes = value.toByteArray(Charsets.UTF_8)
        require(bytes.size <= MAX_FIELD_BYTES) { "Closed note is too large" }
        out.writeInt(bytes.size); out.write(bytes)
    }
    private fun writeNullable(out: DataOutputStream, value: String?) {
        out.writeBoolean(value != null); if (value != null) writeString(out, value)
    }
    private fun readString(input: DataInputStream): String {
        val size = input.readInt(); require(size in 0..MAX_FIELD_BYTES) { "Closed note is too large" }
        val bytes = ByteArray(size); input.readFully(bytes); return String(bytes, Charsets.UTF_8)
    }
    private fun readNullable(input: DataInputStream): String? = if (input.readBoolean()) readString(input) else null
}
