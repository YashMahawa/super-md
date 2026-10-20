package dev.supermd.studio

import android.net.Uri
import android.webkit.WebResourceResponse
import androidx.webkit.WebViewAssetLoader
import java.io.FilterInputStream
import java.io.InputStream
import java.security.MessageDigest
import java.util.LinkedHashMap
import java.util.UUID
import java.util.concurrent.Semaphore

internal data class ReaderAssetCapability(
    val token: String,
    val noteId: String,
    val source: String,
    val mime: String,
    val fingerprint: String,
)

/** A bounded, per-WebView capability table. It never stores or exposes filesystem paths. */
internal class ReaderAssetCapabilities(private val capacity: Int = 128) {
    private data class Key(val noteId: String, val source: String, val fingerprint: String)
    private val byToken = LinkedHashMap<String, ReaderAssetCapability>(16, .75f, true)
    private val byKey = mutableMapOf<Key, String>()

    @Synchronized
    fun register(noteId: String, source: String, mime: String, fingerprint: String): ReaderAssetCapability? {
        val key = Key(noteId, source, fingerprint)
        byKey[key]?.let { token -> byToken[token]?.let { return it } }
        // Never evict a capability that may still back a visible image URL.
        // A null result asks the caller to use its legacy bounded data loader.
        if (byToken.size >= capacity) return null
        val entry = ReaderAssetCapability(UUID.randomUUID().toString().replace("-", ""), noteId, source, mime, fingerprint)
        byToken[entry.token] = entry
        byKey[key] = entry.token
        return entry
    }

    @Synchronized
    fun lookup(token: String, noteIsOpen: (String) -> Boolean): ReaderAssetCapability? {
        if (!token.matches(Regex("[a-f0-9]{32}"))) return null
        val entry = byToken[token] ?: return null
        if (!noteIsOpen(entry.noteId)) {
            byToken.remove(token)
            byKey.remove(Key(entry.noteId, entry.source, entry.fingerprint))
            return null
        }
        return entry
    }

    @Synchronized
    fun clear() { byToken.clear(); byKey.clear() }

    @Synchronized
    internal fun size(): Int = byToken.size
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
)

internal fun readerAssetFingerprint(identity: String, size: Long, modified: Long): String {
    val bytes = "$identity\u0000$size\u0000$modified".toByteArray(Charsets.UTF_8)
    return MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
}

internal fun readerAssetFingerprint(identity: String, size: Long, modified: Long, open: () -> InputStream): String {
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

/** Resolve a note-relative path without allowing encoded separators or tree-root escape. */
internal fun readerAssetPathParts(parent: String, source: String): List<String> {
    require(source.isNotBlank() && !source.startsWith('/') && !source.startsWith('\\') && !source.contains('\u0000')) { "Invalid image path" }
    require(!Regex("(?i)%2f|%5c").containsMatchIn(source)) { "Encoded path separators are not allowed" }
    val decoded = Uri.decode(source)
    require(!decoded.contains('\u0000')) { "Invalid image path" }
    val stack = ArrayDeque<String>()
    (if (parent.isEmpty()) "" else "$parent/").plus(decoded).replace('\\', '/').split('/').forEach { part ->
        when (part) {
            "", "." -> Unit
            ".." -> if (stack.isEmpty()) error("Image escapes the selected folder") else stack.removeLast()
            else -> stack.addLast(part)
        }
    }
    return stack.toList()
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
    private val open: (noteId: String, source: String, expectedFingerprint: String) -> OpenReaderAsset,
    private val noteIsOpen: (String) -> Boolean,
) : WebViewAssetLoader.PathHandler {
    private val concurrentStreams = Semaphore(4)

    override fun handle(path: String): WebResourceResponse {
        val token = path.substringBefore('?')
        val capability = capabilities.lookup(token, noteIsOpen) ?: return notFound()
        if (!concurrentStreams.tryAcquire()) return response(503, "Reader asset capacity reached", null)
        var stream: InputStream? = null
        var rawStream: InputStream? = null
        var permitHeld = true
        fun releasePermit() { if (permitHeld) { permitHeld = false; concurrentStreams.release() } }
        try {
            val asset = open(capability.noteId, capability.source, capability.fingerprint)
            rawStream = asset.stream
            if (asset.fingerprint != capability.fingerprint || asset.mime != capability.mime) {
                rawStream.close()
                rawStream = null
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
            releasePermit()
            return notFound()
        }
    }

    private fun notFound() = WebResourceResponse(
        "text/plain", "UTF-8", 404, "Not Found", NO_STORE_HEADERS,
        java.io.ByteArrayInputStream(ByteArray(0)),
    )
    private fun response(status: Int, reason: String, stream: InputStream?) = WebResourceResponse(
        "text/plain", "UTF-8", status, reason, NO_STORE_HEADERS, stream,
    )

    companion object {
        val NO_STORE_HEADERS = mapOf("Cache-Control" to "no-store", "X-Content-Type-Options" to "nosniff")
        const val URL_PREFIX = "https://appassets.androidplatform.net/reader-assets/"
    }
}
