package dev.supermd.studio

import android.util.JsonReader
import android.util.JsonToken
import java.io.File
import java.io.FilterInputStream
import java.io.IOException
import java.io.InputStream
import java.io.InputStreamReader
import java.nio.charset.CodingErrorAction
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.BasicFileAttributes
import java.nio.file.attribute.FileTime
import java.security.DigestInputStream
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.TimeUnit

internal data class ReaderConflictCandidate(
    val fileName: String,
    val note: Note,
    val lastModifiedMillis: Long,
    internal val lastModifiedNanos: Long,
    internal val size: Long,
    internal val fileKey: Any?,
)

/**
 * Bounded, symlink-safe recovery reader for private `reader-conflicts/` JSON
 * copies. Valid entries become detached Markdown drafts with their exact
 * original content, and accepted entries are retired in-place (`*.recovered`)
 * so original recovery bytes remain preserved on disk.
 */
internal class ReaderConflictDraftStore(
    private val filesDir: File,
    private val directoryName: String = "reader-conflicts",
) {
    init {
        require(
            directoryName.isNotEmpty() &&
                '/' !in directoryName &&
                '\\' !in directoryName &&
                directoryName != "." &&
                directoryName != "..",
        ) { "Invalid reader-conflict directory name" }
    }

    private data class RawEntry(
        val path: Path,
        val file: File,
        val fileName: String,
        val lastModifiedTime: FileTime,
        val lastModifiedMillis: Long,
        val lastModifiedNanos: Long,
        val size: Long,
        val fileKey: Any?,
    )

    fun latestCandidate(excluding: Set<String> = emptySet()): ReaderConflictCandidate? {
        val (_, expectedRoot, rootPath) = verifiedRoot() ?: return null
        val entries = mutableListOf<RawEntry>()
        val collected = runCatching {
            Files.newDirectoryStream(rootPath).use { stream ->
                var scanned = 0
                val iterator = stream.iterator()
                while (iterator.hasNext() && scanned < StorageInspector.MAX_ENTRIES_PER_CATEGORY) {
                    val child = iterator.next()
                    scanned++
                    val fileName = child.fileName?.toString() ?: continue
                    if (!fileName.endsWith(".json") || fileName.length <= 5) continue
                    if (Files.isSymbolicLink(child)) continue
                    val attrs = runCatching {
                        Files.readAttributes(child, BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
                    }.getOrNull() ?: continue
                    if (!attrs.isRegularFile || attrs.isSymbolicLink) continue
                    val size = attrs.size()
                    if (size !in 1L..MAX_RAW_CONFLICT_FILE_BYTES) continue
                    val childFile = child.toFile()
                    val canonicalChild = runCatching { childFile.canonicalFile.toPath().normalize() }.getOrNull() ?: continue
                    if (canonicalChild.parent != expectedRoot) continue
                    val modifiedTime = attrs.lastModifiedTime()
                    entries += RawEntry(
                        path = child,
                        file = childFile,
                        fileName = fileName,
                        lastModifiedTime = modifiedTime,
                        lastModifiedMillis = modifiedTime.toMillis(),
                        lastModifiedNanos = modifiedTime.to(TimeUnit.NANOSECONDS),
                        size = size,
                        fileKey = attrs.fileKey(),
                    )
                }
            }
        }
        if (collected.isFailure || entries.isEmpty()) return null

        val sorted = entries.sortedWith(
            compareByDescending<RawEntry> { it.lastModifiedTime }
                .thenByDescending { it.fileName },
        )
        for (entry in sorted) {
            val candidate = parseEntry(entry, expectedRoot) ?: continue
            if (candidate.note.id !in excluding) return candidate
        }
        return null
    }

    fun retire(candidate: ReaderConflictCandidate): Boolean = runCatching {
        val (_, expectedRoot, rootPath) = verifiedRoot() ?: return@runCatching false
        val sourcePath = rootPath.resolve(candidate.fileName).normalize()
        if (sourcePath.parent != expectedRoot || Files.isSymbolicLink(sourcePath)) return@runCatching false
        val currentAttrs = Files.readAttributes(sourcePath, BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
        if (!currentAttrs.isRegularFile || currentAttrs.isSymbolicLink) return@runCatching false
        if (sourcePath.toFile().canonicalFile.toPath().normalize().parent != expectedRoot) return@runCatching false
        if (
            currentAttrs.size() != candidate.size ||
            currentAttrs.lastModifiedTime().to(TimeUnit.NANOSECONDS) != candidate.lastModifiedNanos ||
            (candidate.fileKey != null && currentAttrs.fileKey() != null && candidate.fileKey != currentAttrs.fileKey())
        ) {
            return@runCatching false
        }
        val defaultTarget = rootPath.resolve("${candidate.fileName}.recovered").normalize()
        val targetPath = if (!Files.exists(defaultTarget, LinkOption.NOFOLLOW_LINKS) && !Files.isSymbolicLink(defaultTarget)) {
            defaultTarget
        } else {
            rootPath.resolve("${candidate.fileName}.${UUID.randomUUID()}.recovered").normalize()
        }
        if (targetPath.parent != expectedRoot || Files.isSymbolicLink(targetPath)) return@runCatching false
        try {
            Files.move(sourcePath, targetPath, StandardCopyOption.ATOMIC_MOVE)
        } catch (_: AtomicMoveNotSupportedException) {
            Files.move(sourcePath, targetPath)
        }
        Files.exists(targetPath, LinkOption.NOFOLLOW_LINKS)
    }.getOrDefault(false)

    private fun verifiedRoot(): Triple<File, Path, Path>? = runCatching {
        if (!filesDir.exists()) return@runCatching null
        val expectedRoot = filesDir.canonicalFile.toPath().resolve(directoryName).normalize()
        val root = File(filesDir, directoryName)
        val rootPath = root.toPath()
        if (Files.isSymbolicLink(rootPath)) return@runCatching null
        if (!Files.exists(rootPath, LinkOption.NOFOLLOW_LINKS)) return@runCatching null
        if (!Files.isDirectory(rootPath, LinkOption.NOFOLLOW_LINKS)) return@runCatching null
        if (root.canonicalFile.toPath().normalize() != expectedRoot) return@runCatching null
        Triple(root, expectedRoot, rootPath)
    }.getOrNull()

    private fun parseEntry(entry: RawEntry, expectedRoot: Path): ReaderConflictCandidate? = runCatching {
        if (Files.isSymbolicLink(entry.path)) return@runCatching null
        if (entry.file.canonicalFile.toPath().normalize().parent != expectedRoot) return@runCatching null
        val digest = MessageDigest.getInstance("SHA-256")
        var rawName = ""
        var content = ""
        var bytesConsumed = 0L
        Files.newInputStream(entry.path, LinkOption.NOFOLLOW_LINKS).use { rawStream ->
            val bounded = BoundedConflictInputStream(rawStream, MAX_RAW_CONFLICT_FILE_BYTES)
            val digestStream = DigestInputStream(bounded, digest)
            val decoder = Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
            JsonReader(InputStreamReader(digestStream, decoder)).use { json ->
                require(json.peek() == JsonToken.BEGIN_OBJECT) { "Expected conflict JSON object" }
                json.beginObject()
                var seenId = false
                var seenName = false
                var seenContent = false
                while (json.hasNext()) {
                    val key = json.nextName()
                    require(json.peek() == JsonToken.STRING) { "Expected string value for $key" }
                    when (key) {
                        "id" -> {
                            require(!seenId) { "Duplicate id" }
                            val id = json.nextString()
                            require(id.length <= MAX_METADATA_CHARS && '\u0000' !in id) { "Invalid conflict id" }
                            seenId = true
                        }
                        "name" -> {
                            require(!seenName) { "Duplicate name" }
                            rawName = json.nextString()
                            require(rawName.isNotBlank() && rawName.length <= MAX_METADATA_CHARS && '\u0000' !in rawName) { "Invalid conflict name" }
                            seenName = true
                        }
                        "content" -> {
                            require(!seenContent) { "Duplicate content" }
                            content = json.nextString()
                            require(readerConflictDraftWithinLimits(content)) { "Conflict draft exceeds size limit" }
                            seenContent = true
                        }
                        else -> error("Unexpected conflict key")
                    }
                }
                json.endObject()
                require(seenId && seenName && seenContent) { "Incomplete conflict payload" }
                require(json.peek() == JsonToken.END_DOCUMENT && digestStream.read() == -1) { "Trailing conflict data" }
                bytesConsumed = bounded.bytesRead
            }
        }
        val postAttrs = Files.readAttributes(entry.path, BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
        require(postAttrs.isRegularFile && !postAttrs.isSymbolicLink && postAttrs.size() == bytesConsumed) {
            "Conflict entry changed while reading"
        }
        val digestHex = digest.digest().joinToString("") { "%02x".format(it) }
        val noteId = UUID.nameUUIDFromBytes(
            "supermd-reader-conflict:${entry.fileName}:$digestHex".toByteArray(Charsets.UTF_8),
        ).toString()
        val prefixed = if (rawName.startsWith("Recovered ")) rawName else "Recovered $rawName"
        val displayName = ExportFilename.suggestedName(prefixed, NativeExportFormat.MARKDOWN)
        val note = Note(
            id = noteId,
            name = displayName,
            uri = null,
            content = content,
            saved = "",
            relative = null,
            assetDirectory = null,
            assetsDirty = false,
        )
        ReaderConflictCandidate(
            fileName = entry.fileName,
            note = note,
            lastModifiedMillis = postAttrs.lastModifiedTime().toMillis(),
            lastModifiedNanos = postAttrs.lastModifiedTime().to(TimeUnit.NANOSECONDS),
            size = postAttrs.size(),
            fileKey = postAttrs.fileKey(),
        )
    }.getOrNull()

    private class BoundedConflictInputStream(
        input: InputStream,
        private val maxBytes: Long,
    ) : FilterInputStream(input) {
        var bytesRead: Long = 0L
            private set

        override fun read(): Int {
            val value = super.read()
            if (value >= 0 && ++bytesRead > maxBytes) throw IOException("Conflict file exceeds limit")
            return value
        }

        override fun read(buffer: ByteArray, offset: Int, count: Int): Int {
            val readCount = super.read(buffer, offset, count)
            if (readCount > 0) {
                bytesRead += readCount
                if (bytesRead > maxBytes) throw IOException("Conflict file exceeds limit")
            }
            return readCount
        }
    }

    companion object {
        internal val recoveryMutex = kotlinx.coroutines.sync.Mutex()
        internal const val MAX_METADATA_CHARS = 1_024
        // Worst-case valid 20M-char conflict draft (`\uXXXX` escaping) plus JSON envelope.
        internal const val MAX_RAW_CONFLICT_FILE_BYTES = 120_016_384L
    }
}
