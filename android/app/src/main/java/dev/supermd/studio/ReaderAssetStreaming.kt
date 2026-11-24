package dev.supermd.studio

import android.content.ContentResolver
import android.net.Uri
import android.provider.DocumentsContract
import android.webkit.WebResourceResponse
import androidx.webkit.WebViewAssetLoader
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FilterInputStream
import java.io.InputStream
import java.security.MessageDigest
import java.util.LinkedHashMap
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit

internal val RASTER_ASSET_MIMES = setOf(
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
)

internal sealed interface ReaderAssetTarget {
    val noteUri: String?
    val noteRelative: String?
    val assetDirectory: String?

    data class LocalFile(
        val root: File,
        val file: File,
        override val noteUri: String? = null,
        override val noteRelative: String? = null,
        override val assetDirectory: String? = null,
    ) : ReaderAssetTarget

    data class SafDocument(
        val uri: Uri,
        val identity: String,
        override val noteUri: String?,
        override val noteRelative: String?,
        override val assetDirectory: String? = null,
    ) : ReaderAssetTarget
}

internal data class ReaderAssetCapability(
    val token: String,
    val noteId: String,
    val source: String,
    val mime: String,
    val fingerprint: String,
    val target: ReaderAssetTarget? = null,
)

/** A bounded, per-WebView capability table whose URLs never expose filesystem paths. */
internal class ReaderAssetCapabilities(private val capacity: Int = 128) {
    private data class Key(val noteId: String, val source: String, val fingerprint: String)
    private val byToken = LinkedHashMap<String, ReaderAssetCapability>(16, .75f, true)
    private val byKey = mutableMapOf<Key, String>()

    @Synchronized
    fun register(
        noteId: String,
        source: String,
        mime: String,
        fingerprint: String,
        target: ReaderAssetTarget? = null,
    ): ReaderAssetCapability? {
        val key = Key(noteId, source, fingerprint)
        byKey[key]?.let { token ->
            byToken[token]?.let { existing ->
                if (target != null && existing.target != target) {
                    val updated = existing.copy(target = target)
                    byToken[token] = updated
                    return updated
                }
                return existing
            }
            byKey.remove(key)
        }
        // Never evict a capability that may still back a visible image URL.
        // A null result asks the caller to use its legacy bounded data loader.
        if (byToken.size >= capacity) return null
        val entry = ReaderAssetCapability(
            UUID.randomUUID().toString().replace("-", ""),
            noteId,
            source,
            mime,
            fingerprint,
            target,
        )
        byToken[entry.token] = entry
        byKey[key] = entry.token
        return entry
    }

    @Synchronized
    fun lookup(token: String, noteIsOpen: (String) -> Boolean): ReaderAssetCapability? {
        if (!TOKEN_PATTERN.matches(token)) return null
        val entry = byToken[token] ?: return null
        if (!noteIsOpen(entry.noteId)) {
            removeEntry(token, entry)
            return null
        }
        return entry
    }

    @Synchronized
    fun revoke(token: String) {
        val entry = byToken[token] ?: return
        removeEntry(token, entry)
    }

    @Synchronized
    fun clearNote(noteId: String) {
        val matching = byToken.values.filter { it.noteId == noteId }
        matching.forEach { entry -> removeEntry(entry.token, entry) }
    }

    @Synchronized
    fun clear() { byToken.clear(); byKey.clear() }

    @Synchronized
    internal fun size(): Int = byToken.size

    private fun removeEntry(token: String, entry: ReaderAssetCapability) {
        byToken.remove(token)
        val key = Key(entry.noteId, entry.source, entry.fingerprint)
        if (byKey[key] == token) byKey.remove(key)
    }

    private companion object {
        val TOKEN_PATTERN = Regex("[a-f0-9]{32}")
    }
}

internal data class OpenReaderAsset(
    val mime: String,
    val fingerprint: String,
    val stream: InputStream,
)

internal data class ReaderAssetSource(
    val mime: String,
    val fingerprint: String,
    val size: Long,
    val open: () -> InputStream,
    val target: ReaderAssetTarget? = null,
)

internal fun readerAssetFingerprint(identity: String, size: Long, modified: Long): String {
    val bytes = "$identity\u0000$size\u0000$modified".toByteArray(Charsets.UTF_8)
    return MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
}

internal fun readerAssetFingerprint(identity: String, size: Long, modified: Long, open: () -> InputStream): String {
    if (size >= 0L) {
        require(size <= BoundedAssetInputStream.MAX_READER_ASSET_BYTES) { "Image exceeds 25 MB" }
    }
    if (modified > 0L && size >= 0L) {
        return readerAssetFingerprint(identity, size, modified)
    }
    val digest = MessageDigest.getInstance("SHA-256")
    digest.update(identity.toByteArray(Charsets.UTF_8))
    var consumed = 0L
    open().use { stream ->
        val buffer = ByteArray(8192)
        while (true) {
            val count = stream.read(buffer)
            if (count < 0) break
            consumed += count
            require(consumed <= BoundedAssetInputStream.MAX_READER_ASSET_BYTES) { "Image exceeds 25 MB" }
            digest.update(buffer, 0, count)
        }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
}

private val URI_SCHEME_PREFIX = Regex("^[a-zA-Z][a-zA-Z0-9+.-]*:")
private val ENCODED_SEPARATOR_PATTERN = Regex("(?i)%2f|%5c")

internal fun validateRelativeAssetSource(source: String): String {
    require(
        source.isNotBlank() &&
            source.length <= 4096 &&
            !source.startsWith('/') &&
            !source.startsWith('\\') &&
            !source.startsWith("//") &&
            !source.contains('\u0000') &&
            !URI_SCHEME_PREFIX.containsMatchIn(source),
    ) { "Invalid image path" }
    require(!ENCODED_SEPARATOR_PATTERN.containsMatchIn(source)) { "Encoded path separators are not allowed" }
    val decoded = Uri.decode(source)
    require(
        decoded.isNotBlank() &&
            !decoded.startsWith('/') &&
            !decoded.startsWith('\\') &&
            !decoded.contains('\u0000') &&
            !URI_SCHEME_PREFIX.containsMatchIn(decoded),
    ) { "Invalid image path" }
    return decoded
}

/** Resolve a note-relative path without allowing encoded separators or tree-root escape. */
internal fun readerAssetPathParts(parent: String, source: String): List<String> {
    val decoded = validateRelativeAssetSource(source)
    val stack = ArrayDeque<String>()
    (if (parent.isEmpty()) "" else "$parent/").plus(decoded).replace('\\', '/').split('/').forEach { part ->
        when (part) {
            "", "." -> Unit
            ".." -> if (stack.isEmpty()) error("Image escapes the selected folder") else stack.removeLast()
            else -> stack.addLast(part)
        }
    }
    require(stack.isNotEmpty()) { "Invalid image path" }
    return stack.toList()
}

internal data class IndexedFolderEntry(
    val documentId: String,
    val uri: Uri,
    val displayName: String,
    val mimeType: String?,
) {
    val isDirectory: Boolean get() = mimeType == DocumentsContract.Document.MIME_TYPE_DIR
    val isFile: Boolean get() = !isDirectory
}

internal data class SafAssetMetadata(
    val displayName: String?,
    val mimeType: String?,
    val size: Long,
    val lastModified: Long,
)

internal fun querySafAssetMetadata(
    resolver: ContentResolver,
    uri: Uri,
    missingError: () -> Throwable = { LinkedAssetAccessRequiredException() },
): SafAssetMetadata {
    val cursor = resolver.query(uri, SAF_ASSET_METADATA_PROJECTION, null, null, null) ?: throw missingError()
    cursor.use {
        if (!it.moveToFirst()) throw missingError()
        val nameIndex = it.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
        val mimeIndex = it.getColumnIndex(DocumentsContract.Document.COLUMN_MIME_TYPE)
        val sizeIndex = it.getColumnIndex(DocumentsContract.Document.COLUMN_SIZE)
        val modifiedIndex = it.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED)
        val displayName = if (nameIndex >= 0 && !it.isNull(nameIndex)) it.getString(nameIndex)?.takeIf(String::isNotBlank) else null
        val cursorMime = if (mimeIndex >= 0 && !it.isNull(mimeIndex)) it.getString(mimeIndex)?.takeIf(String::isNotBlank) else null
        val mimeType = cursorMime ?: resolver.getType(uri)
        require(mimeType != DocumentsContract.Document.MIME_TYPE_DIR) { "Linked file is not a regular file" }
        val size = if (sizeIndex >= 0 && !it.isNull(sizeIndex)) it.getLong(sizeIndex) else -1L
        val lastModified = if (modifiedIndex >= 0 && !it.isNull(modifiedIndex)) it.getLong(modifiedIndex) else 0L
        return SafAssetMetadata(displayName, mimeType, size, lastModified)
    }
}

private val SAF_ASSET_METADATA_PROJECTION = arrayOf(
    DocumentsContract.Document.COLUMN_DISPLAY_NAME,
    DocumentsContract.Document.COLUMN_MIME_TYPE,
    DocumentsContract.Document.COLUMN_SIZE,
    DocumentsContract.Document.COLUMN_LAST_MODIFIED,
)

private val SAF_DIRECTORY_PROJECTION = arrayOf(
    DocumentsContract.Document.COLUMN_DOCUMENT_ID,
    DocumentsContract.Document.COLUMN_DISPLAY_NAME,
    DocumentsContract.Document.COLUMN_MIME_TYPE,
)

/** Per-tab SAF directory entry index coalescing concurrent lookups per folder level. */
internal class ReaderFolderIndex(private val maxCachedFolders: Int = 256) {
    private data class Key(val noteId: String, val treeUri: String, val parentDocumentId: String)

    private class InFlight {
        val latch = CountDownLatch(1)
        @Volatile var entries: Map<String, IndexedFolderEntry>? = null
        @Volatile var failure: Throwable? = null
    }

    private val lock = Any()
    private val cached = LinkedHashMap<Key, Map<String, IndexedFolderEntry>>(16, .75f, true)
    private val inFlight = mutableMapOf<Key, InFlight>()
    private var globalGeneration = 0L
    private val noteGenerations = mutableMapOf<String, Long>()

    fun resolve(
        resolver: ContentResolver,
        noteId: String,
        treeUri: Uri,
        rootDocumentId: String,
        parts: List<String>,
    ): IndexedFolderEntry {
        require(parts.isNotEmpty()) { "Invalid image path" }
        var currentDocumentId = rootDocumentId
        for ((index, part) in parts.withIndex()) {
            val children = listChildren(resolver, noteId, treeUri, currentDocumentId)
            val entry = children[part] ?: throw LinkedAssetAccessRequiredException()
            if (index < parts.lastIndex) {
                if (!entry.isDirectory) throw LinkedAssetAccessRequiredException()
                currentDocumentId = entry.documentId
            } else {
                require(entry.isFile) { "Linked file is not a regular file" }
                return entry
            }
        }
        throw LinkedAssetAccessRequiredException()
    }

    private fun listChildren(
        resolver: ContentResolver,
        noteId: String,
        treeUri: Uri,
        parentDocumentId: String,
    ): Map<String, IndexedFolderEntry> {
        val key = Key(noteId, treeUri.toString(), parentDocumentId)
        val pending: InFlight
        val owner: Boolean
        val startGlobalGeneration: Long
        val startNoteGeneration: Long
        synchronized(lock) {
            cached[key]?.let { return it }
            val existing = inFlight[key]
            if (existing != null) {
                pending = existing
                owner = false
                startGlobalGeneration = 0L
                startNoteGeneration = 0L
            } else {
                pending = InFlight()
                inFlight[key] = pending
                owner = true
                startGlobalGeneration = globalGeneration
                startNoteGeneration = noteGenerations[noteId] ?: 0L
            }
        }
        if (!owner) {
            pending.latch.await()
            pending.failure?.let { throw it }
            return pending.entries ?: throw LinkedAssetAccessRequiredException()
        }
        try {
            val loaded = queryChildren(resolver, treeUri, parentDocumentId)
            synchronized(lock) {
                inFlight.remove(key)
                if (globalGeneration == startGlobalGeneration && (noteGenerations[noteId] ?: 0L) == startNoteGeneration) {
                    cached[key] = loaded
                    while (cached.size > maxCachedFolders) {
                        val oldest = cached.keys.firstOrNull() ?: break
                        cached.remove(oldest)
                    }
                }
                pending.entries = loaded
            }
            pending.latch.countDown()
            return loaded
        } catch (error: Throwable) {
            synchronized(lock) {
                inFlight.remove(key)
                pending.failure = error
            }
            pending.latch.countDown()
            throw error
        }
    }

    private fun queryChildren(
        resolver: ContentResolver,
        treeUri: Uri,
        parentDocumentId: String,
    ): Map<String, IndexedFolderEntry> {
        val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentDocumentId)
        val cursor = resolver.query(childrenUri, SAF_DIRECTORY_PROJECTION, null, null, null)
            ?: throw LinkedAssetAccessRequiredException()
        cursor.use {
            val idIndex = it.getColumnIndex(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
            val nameIndex = it.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
            val mimeIndex = it.getColumnIndex(DocumentsContract.Document.COLUMN_MIME_TYPE)
            val entries = LinkedHashMap<String, IndexedFolderEntry>()
            while (it.moveToNext()) {
                val docId = if (idIndex >= 0 && !it.isNull(idIndex)) it.getString(idIndex) else null
                if (docId.isNullOrEmpty()) continue
                val childUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId)
                val name = if (nameIndex >= 0 && !it.isNull(nameIndex)) it.getString(nameIndex)
                    else querySingleColumn(resolver, childUri, DocumentsContract.Document.COLUMN_DISPLAY_NAME)
                if (name.isNullOrEmpty()) continue
                val mime = if (mimeIndex >= 0 && !it.isNull(mimeIndex)) it.getString(mimeIndex)
                    else querySingleColumn(resolver, childUri, DocumentsContract.Document.COLUMN_MIME_TYPE)
                entries.putIfAbsent(name, IndexedFolderEntry(docId, childUri, name, mime))
            }
            return entries
        }
    }

    private fun querySingleColumn(resolver: ContentResolver, uri: Uri, column: String): String? =
        runCatching {
            resolver.query(uri, arrayOf(column), null, null, null)?.use { cursor ->
                val index = cursor.getColumnIndex(column)
                if (index >= 0 && cursor.moveToFirst() && !cursor.isNull(index)) cursor.getString(index) else null
            }
        }.getOrNull()

    fun clearNote(noteId: String) {
        synchronized(lock) {
            noteGenerations[noteId] = (noteGenerations[noteId] ?: 0L) + 1L
            val iterator = cached.keys.iterator()
            while (iterator.hasNext()) {
                if (iterator.next().noteId == noteId) iterator.remove()
            }
        }
    }

    fun clear() {
        synchronized(lock) {
            globalGeneration++
            noteGenerations.clear()
            cached.clear()
        }
    }

    internal fun cachedFolderCount(): Int = synchronized(lock) { cached.size }

    internal fun hasNoteEntries(noteId: String): Boolean = synchronized(lock) {
        cached.keys.any { it.noteId == noteId }
    }
}

/** Enforces the byte ceiling even when a content provider cannot report a size. */
internal class BoundedAssetInputStream(
    input: InputStream,
    private val limit: Long = MAX_READER_ASSET_BYTES,
    private val onClose: () -> Unit = {},
) : FilterInputStream(input) {
    private var consumed = 0L
    private var closed = false

    override fun read(): Int {
        return try {
            val value = super.read()
            if (value >= 0 && ++consumed > limit) failOversize()
            value
        } catch (failure: Exception) { closeAfterFailure(failure) }
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        return try {
            // Do not consume a byte past the limit when satisfying an otherwise
            // valid read. A later read at the boundary probes one byte and
            // reports overflow only if the provider really has more data.
            val count = super.read(buffer, offset, minOf(length.toLong(), (limit - consumed).coerceAtLeast(1)).toInt())
            if (count > 0) {
                consumed += count
                if (consumed > limit) failOversize()
            }
            count
        } catch (failure: Exception) { closeAfterFailure(failure) }
    }

    private fun failOversize(): Nothing = throw IllegalArgumentException("Image exceeds 25 MB")

    private fun closeAfterFailure(failure: Exception): Nothing {
        runCatching { close() }
        throw failure
    }

    override fun close() {
        if (closed) return
        closed = true
        try { super.close() } finally { onClose() }
    }

    companion object { const val MAX_READER_ASSET_BYTES = 25_000_000L }
}

/** WebViewAssetLoader handler scoped to one reader and one capability table. */
internal class ReaderAssetPathHandler(
    private val capabilities: ReaderAssetCapabilities,
    private val openCapability: (ReaderAssetCapability) -> OpenReaderAsset,
    private val noteIsOpen: (String) -> Boolean,
    private val acquireTimeoutMillis: Long = DEFAULT_STREAM_WAIT_MILLIS,
) : WebViewAssetLoader.PathHandler {
    constructor(
        capabilities: ReaderAssetCapabilities,
        open: (noteId: String, source: String, expectedFingerprint: String) -> OpenReaderAsset,
        noteIsOpen: (String) -> Boolean,
    ) : this(
        capabilities = capabilities,
        openCapability = { capability -> open(capability.noteId, capability.source, capability.fingerprint) },
        noteIsOpen = noteIsOpen,
    )

    private val concurrentStreams = Semaphore(MAX_CONCURRENT_STREAMS, true)

    override fun handle(path: String): WebResourceResponse {
        val token = path.substringBefore('?')
        if (capabilities.lookup(token, noteIsOpen) == null) return notFound()
        val acquired = try {
            concurrentStreams.tryAcquire(acquireTimeoutMillis, TimeUnit.MILLISECONDS)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            false
        }
        if (!acquired) return response(503, "Reader asset capacity reached", ByteArrayInputStream(ByteArray(0)))
        var stream: InputStream? = null
        var rawStream: InputStream? = null
        var permitHeld = true
        fun releasePermit() { if (permitHeld) { permitHeld = false; concurrentStreams.release() } }
        val capability = capabilities.lookup(token, noteIsOpen)
        if (capability == null) {
            releasePermit()
            return notFound()
        }
        try {
            val asset = openCapability(capability)
            rawStream = asset.stream
            if (asset.fingerprint != capability.fingerprint || asset.mime != capability.mime || asset.mime !in RASTER_ASSET_MIMES) {
                rawStream.close()
                rawStream = null
                capabilities.revoke(capability.token)
                releasePermit()
                return notFound()
            }
            stream = BoundedAssetInputStream(asset.stream, onClose = ::releasePermit)
            rawStream = null
            val response = WebResourceResponse(asset.mime, null, 200, "OK", NO_STORE_HEADERS, stream)
            stream = null // WebView owns and closes the response stream.
            return response
        } catch (_: Exception) {
            runCatching { stream?.close() }
            runCatching { rawStream?.close() }
            capabilities.revoke(capability.token)
            releasePermit()
            return notFound()
        }
    }

    private fun notFound() = WebResourceResponse(
        "text/plain", "UTF-8", 404, "Not Found", NO_STORE_HEADERS,
        ByteArrayInputStream(ByteArray(0)),
    )
    private fun response(status: Int, reason: String, stream: InputStream?) = WebResourceResponse(
        "text/plain", "UTF-8", status, reason, NO_STORE_HEADERS, stream,
    )

    companion object {
        const val MAX_CONCURRENT_STREAMS = 4
        const val DEFAULT_STREAM_WAIT_MILLIS = 10_000L
        val NO_STORE_HEADERS = mapOf("Cache-Control" to "no-store", "X-Content-Type-Options" to "nosniff")
        const val URL_PREFIX = "https://appassets.androidplatform.net/reader-assets/"
    }
}
