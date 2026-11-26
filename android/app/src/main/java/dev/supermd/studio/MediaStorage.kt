package dev.supermd.studio

import android.content.Context
import android.net.Uri
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.lang.ref.WeakReference
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.URL
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.attribute.BasicFileAttributes
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

private const val MAX_VALIDATED_ASSETS = 512
private const val MAX_CACHED_LOCAL_ASSETS = 256
private const val MAX_CACHED_LOCAL_CHARS = 48_000_000L

/** Attachments live outside Markdown and recovery snapshots. FMD is the shareable envelope. */
class MediaStorage(private val context: Context) {
    companion object {
        const val UNSUPPORTED_DROP_IMAGE_MESSAGE = "Only supported images (PNG, JPEG, GIF, WebP, AVIF, or SVG) can be dropped into a note."
        private val SUPPORTED_IMAGE_MIMES = setOf("image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/svg+xml")

        internal fun resolveDroppedImageMime(name: String?, providerMime: String?): String? {
            val extMime = when (name?.substringAfterLast('.', "")?.lowercase()) {
                "png" -> "image/png"
                "jpg", "jpeg" -> "image/jpeg"
                "gif" -> "image/gif"
                "webp" -> "image/webp"
                "avif" -> "image/avif"
                "svg" -> "image/svg+xml"
                else -> null
            }
            val normalized = providerMime?.substringBefore(';')?.trim()?.lowercase()?.takeIf { it.isNotEmpty() }
            if (normalized != null) {
                if (normalized in SUPPORTED_IMAGE_MIMES) return normalized
                if (normalized.startsWith("image/")) return null
                if (normalized == "application/octet-stream") return extMime
                if ((normalized == "text/xml" || normalized == "application/xml") && extMime == "image/svg+xml") return extMime
                return null
            }
            return extMime
        }
    }
    data class DroppedImageBatch(val images: JSONArray, val skippedCount: Int)
    private val publisher = AgentDownloadPublisher(context)
    private val attachments = File(context.filesDir, "attachments").apply { mkdirs() }
    private val bundles = File(context.filesDir, "portable-assets").apply { mkdirs() }

    internal val portableBase64Decodes = AtomicInteger(0)
    internal val portableBase64Encodes = AtomicInteger(0)
    internal val portableAssetExtractions = AtomicInteger(0)

    internal fun resetPortableCounters() {
        portableBase64Decodes.set(0)
        portableBase64Encodes.set(0)
        portableAssetExtractions.set(0)
    }

    private data class ValidatedAssetMeta(
        val ref: WeakReference<String>,
        val mime: String,
        val decodedSize: Int,
    )

    private data class LocalFileStamp(
        val canonicalPath: String,
        val length: Long,
        val lastModifiedNanos: Long,
        val creationTimeNanos: Long,
        val fileKey: Any?,
    )

    private data class CachedLocalAsset(
        val mime: String,
        val decodedSize: Int,
        val dataUrl: String,
    )

    private val cacheLock = Any()
    private val validatedAssetMeta = LinkedHashMap<Int, MutableList<ValidatedAssetMeta>>(128, 0.75f, true)
    private val localFileCache = LinkedHashMap<LocalFileStamp, CachedLocalAsset>(64, 0.75f, true)
    private var cachedLocalChars = 0L
    private var invalidationEpoch = 0L

    internal var localFileBytesReader: (File) -> ByteArray = { it.readBytes() }

    internal fun cachedLocalAssetCount(): Int = synchronized(cacheLock) { localFileCache.size }

    private fun cacheableAppAssetFile(file: File): File? {
        if (runCatching { Files.isSymbolicLink(file.toPath()) }.getOrDefault(true)) return null
        return containedFile(bundles, file) ?: containedFile(attachments, file)
    }

    private fun localFileStampOrNull(canonical: File): LocalFileStamp? {
        val attrs = runCatching {
            Files.readAttributes(canonical.toPath(), BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
        }.getOrNull() ?: return null
        if (!attrs.isRegularFile) return null
        return LocalFileStamp(
            canonicalPath = canonical.path,
            length = attrs.size(),
            lastModifiedNanos = attrs.lastModifiedTime().to(TimeUnit.NANOSECONDS),
            creationTimeNanos = attrs.creationTime().to(TimeUnit.NANOSECONDS),
            fileKey = attrs.fileKey(),
        )
    }

    internal fun invalidateLocalAsset(file: File) {
        val targetPath = runCatching { file.canonicalPath }.getOrDefault(file.absolutePath)
        val targetPrefix = targetPath + File.separator
        synchronized(cacheLock) {
            invalidationEpoch++
            val iterator = localFileCache.entries.iterator()
            while (iterator.hasNext()) {
                val entry = iterator.next()
                if (entry.key.canonicalPath == targetPath || entry.key.canonicalPath.startsWith(targetPrefix)) {
                    cachedLocalChars -= entry.value.dataUrl.length
                    iterator.remove()
                }
            }
        }
    }

    private fun cacheValidatedDataUrl(data: String, mime: String, decodedSize: Int) {
        if (data.length > 34_000_000) return
        val hash = System.identityHashCode(data)
        synchronized(cacheLock) {
            val bucket = validatedAssetMeta.getOrPut(hash) { mutableListOf() }
            bucket.removeAll { it.ref.get() == null || it.ref.get() === data }
            bucket.add(ValidatedAssetMeta(WeakReference(data), mime, decodedSize))
            while (validatedAssetMeta.size > MAX_VALIDATED_ASSETS) {
                val eldestKey = validatedAssetMeta.entries.firstOrNull()?.key ?: break
                validatedAssetMeta.remove(eldestKey)
            }
        }
    }

    internal fun lookupValidatedMeta(data: String): Pair<String, Int>? {
        val hash = System.identityHashCode(data)
        synchronized(cacheLock) {
            val bucket = validatedAssetMeta[hash] ?: return null
            val iterator = bucket.iterator()
            while (iterator.hasNext()) {
                val entry = iterator.next()
                val target = entry.ref.get()
                if (target == null) {
                    iterator.remove()
                } else if (target === data) {
                    return entry.mime to entry.decodedSize
                }
            }
            if (bucket.isEmpty()) validatedAssetMeta.remove(hash)
        }
        return null
    }

    private fun putCachedLocalAssetLocked(stamp: LocalFileStamp, mime: String, decodedSize: Int, dataUrl: String) {
        localFileCache.remove(stamp)?.let { cachedLocalChars -= it.dataUrl.length }
        localFileCache[stamp] = CachedLocalAsset(mime, decodedSize, dataUrl)
        cachedLocalChars += dataUrl.length
        while (localFileCache.size > MAX_CACHED_LOCAL_ASSETS || cachedLocalChars > MAX_CACHED_LOCAL_CHARS) {
            val eldest = localFileCache.entries.firstOrNull() ?: break
            cachedLocalChars -= eldest.value.dataUrl.length
            localFileCache.remove(eldest.key)
        }
    }

    private fun cacheStableLocalAsset(
        canonical: File,
        expectedStamp: LocalFileStamp,
        expectedEpoch: Long,
        mime: String,
        decodedSize: Int,
        dataUrl: String,
    ) {
        cacheValidatedDataUrl(dataUrl, mime, decodedSize)
        if (dataUrl.length.toLong() > MAX_CACHED_LOCAL_CHARS) return
        synchronized(cacheLock) {
            if (invalidationEpoch != expectedEpoch) return
            val currentStamp = localFileStampOrNull(canonical) ?: return
            if (currentStamp != expectedStamp) return
            putCachedLocalAssetLocked(expectedStamp, mime, decodedSize, dataUrl)
        }
    }

    internal fun cacheWrittenLocalAsset(file: File, mime: String, decodedSize: Int, dataUrl: String) {
        cacheValidatedDataUrl(dataUrl, mime, decodedSize)
        if (dataUrl.length.toLong() > MAX_CACHED_LOCAL_CHARS) return
        val canonical = cacheableAppAssetFile(file) ?: return
        val beforeEpoch = synchronized(cacheLock) { invalidationEpoch }
        val beforeStamp = localFileStampOrNull(canonical) ?: return
        if (beforeStamp.length != decodedSize.toLong()) return
        synchronized(cacheLock) {
            if (invalidationEpoch != beforeEpoch) return
            val afterStamp = localFileStampOrNull(canonical) ?: return
            if (afterStamp != beforeStamp) return
            putCachedLocalAssetLocked(beforeStamp, mime, decodedSize, dataUrl)
        }
    }

    internal fun validateAssetMeta(data: String, knownValidated: String? = null): Pair<String, Int> {
        lookupValidatedMeta(data)?.let { return it }
        if (knownValidated != null && knownValidated.length == data.length && knownValidated == data) {
            lookupValidatedMeta(knownValidated)?.let { meta ->
                cacheValidatedDataUrl(data, meta.first, meta.second)
                return meta
            }
        }
        val localMatch = synchronized(cacheLock) {
            localFileCache.values.firstOrNull { it.dataUrl.length == data.length && it.dataUrl == data }
        }
        if (localMatch != null) {
            cacheValidatedDataUrl(data, localMatch.mime, localMatch.decodedSize)
            return localMatch.mime to localMatch.decodedSize
        }
        val (type, bytes) = decode(data)
        return type to bytes.size
    }

    private val codec = PortableEnvelopeCodec(context, bundles, this)
    fun createEmptyPortableDirectory(): String = codec.createEmptyPortableDirectory()
    private val key = Regex("assets/[a-zA-Z0-9_.-]{1,150}")
    fun validKey(source: String) = key.matches(source) && source.substringAfter('/') !in listOf(".", "..")
    private fun mime(name: String) = when(name.substringAfterLast('.').lowercase()) {
        "png" -> "image/png"; "jpg", "jpeg" -> "image/jpeg"; "gif" -> "image/gif"; "webp" -> "image/webp"; "avif" -> "image/avif"; "svg" -> "image/svg+xml"; else -> error("Choose a supported image (PNG, JPEG, GIF, WebP, AVIF or SVG)")
    }
    private fun decode(data: String): Pair<String, ByteArray> {
        val (mimeType, payloadStart) = parsePortableDataHeader(data)
        val canonicalNoWhitespace = requireValidBase64Payload(data, payloadStart)
        portableBase64Decodes.incrementAndGet()
        val bytes = Base64.decode(data.substring(payloadStart), Base64.DEFAULT)
        require(bytes.size <= 25_000_000) { "Image exceeds 25 MB" }
        if (canonicalNoWhitespace) {
            cacheValidatedDataUrl(data, mimeType, bytes.size)
        }
        return mimeType to bytes
    }
    fun data(file: File): String {
        require(file.length() <= 25_000_000)
        val expectedMime = mime(file.name)
        val cacheableCanonical = cacheableAppAssetFile(file)
        val beforeEpoch = synchronized(cacheLock) { invalidationEpoch }
        val beforeStamp = cacheableCanonical?.let(::localFileStampOrNull)
        if (beforeStamp != null) {
            synchronized(cacheLock) {
                if (invalidationEpoch == beforeEpoch) {
                    localFileCache[beforeStamp]?.takeIf { it.mime == expectedMime }
                } else {
                    null
                }
            }?.let { return it.dataUrl }
        }
        val readTarget = cacheableCanonical ?: file
        val bytes = localFileBytesReader(readTarget)
        require(bytes.size <= 25_000_000)
        portableBase64Encodes.incrementAndGet()
        val encoded = "data:$expectedMime;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
        if (cacheableCanonical != null && beforeStamp != null && bytes.size.toLong() == beforeStamp.length) {
            val afterStamp = localFileStampOrNull(cacheableCanonical)
            if (afterStamp != null && afterStamp == beforeStamp) {
                cacheStableLocalAsset(cacheableCanonical, beforeStamp, beforeEpoch, expectedMime, bytes.size, encoded)
            }
        }
        return encoded
    }
    private fun store(name: String, type: String, bytes: ByteArray): JSONObject {
        val extension = when(type.substringBefore(';')) { "image/png" -> "png"; "image/jpeg" -> "jpg"; "image/gif" -> "gif"; "image/webp" -> "webp"; "image/avif" -> "avif"; "image/svg+xml" -> "svg"; else -> error("Unsupported image type") }
        require(bytes.size <= 25_000_000)
        val file = File(attachments, "import-${UUID.randomUUID()}.$extension")
        file.outputStream().use { it.write(bytes); it.fd.sync() }
        return JSONObject().put("source", "assets/${file.name}").put("alt", name.substringBeforeLast('.').take(160))
    }

    /** Canonical image data URL for a relay-supplied portable asset. */
    fun portableImageData(type: String, bytes: ByteArray): String {
        val mime = type.substringBefore(';').lowercase()
        require(mime in setOf("image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/svg+xml")) { "Unsupported image type" }
        require(bytes.size in 1..1_048_576) { "Relay supplied assets are limited to 1 MiB" }
        requireMediaSignature(mime, bytes)
        val encoded = "data:$mime;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
        cacheValidatedDataUrl(encoded, mime, bytes.size)
        return encoded
    }

    /** Return every extracted asset in a portable note, including currently unlinked originals. */
    fun portableAssets(directory: String?): JSONObject = codec.portableAssets(directory)

    fun portableAssetPage(directory: String?, offset: Int, limit: Int): JSONObject =
        codec.portableAssetPage(directory, offset, limit)

    fun portableAssetBytes(directory: String?, source: String, maxBytes: Int): Pair<String, ByteArray> =
        codec.portableAssetBytes(directory, source, maxBytes)

    fun resolvePortableAssetName(directory: String?, requested: String): String? =
        codec.resolvePortableAssetName(directory, requested)

    fun assetMime(name: String): String = mime(name)

    fun decodePortableImage(data: String): Pair<String, ByteArray> = decode(data)

    fun requirePortableImage(type: String, bytes: ByteArray) = requireMediaSignature(type.substringBefore(';').lowercase(), bytes)

    fun importJson(images: JSONArray): JSONArray {
        require(images.length() in 1..32)
        var total = 0L; val result = JSONArray()
        for (i in 0 until images.length()) { val image = images.getJSONObject(i); val (type, bytes) = decode(image.getString("data")); total += bytes.size; require(total <= 75_000_000) { "Insert at most 75 MB at a time" }; result.put(store(image.optString("name", "Image"), type, bytes)) }
        return result
    }
    private fun resolveUriDisplayName(uri: Uri): String? =
        androidx.documentfile.provider.DocumentFile.fromSingleUri(context, uri)?.name
            ?.takeIf { it.isNotBlank() }
            ?: uri.lastPathSegment?.substringAfterLast('/')?.takeIf { it.isNotBlank() }

    private fun isSafeExternalUri(uri: Uri): Boolean {
        return when (uri.scheme?.lowercase()) {
            "content" -> {
                val authority = uri.authority?.lowercase().orEmpty()
                authority.isNotEmpty() && authority != "${context.packageName.lowercase()}.share"
            }
            "file" -> {
                val rawPath = uri.path ?: return false
                val canonical = runCatching { File(rawPath).canonicalPath }.getOrNull() ?: return false
                val privateRoot = runCatching { context.filesDir.parentFile?.canonicalPath }.getOrNull()
                privateRoot == null || (canonical != privateRoot && !canonical.startsWith(privateRoot + File.separator))
            }
            else -> false
        }
    }

    fun importUris(uris: List<Uri>): JSONArray {
        require(uris.size in 1..32)
        var total = 0L; val result = JSONArray()
        for (uri in uris) {
            require(isSafeExternalUri(uri)) { "Unsupported image URI" }
            val name = resolveUriDisplayName(uri) ?: "Image"
            val type = imageMime(name, context.contentResolver.getType(uri))
            val bytes = context.contentResolver.openInputStream(uri)?.use { readLimited(it, 25_000_000) } ?: error("Image permission is unavailable")
            requireMediaSignature(type, bytes)
            total += bytes.size; require(total <= 75_000_000) { "Insert at most 75 MB at a time" }
            result.put(store(name, type, bytes))
        }
        return result
    }

    fun importDroppedUris(uris: List<Uri>): DroppedImageBatch {
        if (uris.isEmpty()) return DroppedImageBatch(JSONArray(), 0)
        var total = 0L
        var skipped = 0
        val result = JSONArray()
        for (uri in uris) {
            if (!isSafeExternalUri(uri)) {
                skipped++
                continue
            }
            val name = resolveUriDisplayName(uri)
            val providerMime = runCatching { context.contentResolver.getType(uri) }.getOrNull()
            val resolvedMime = resolveDroppedImageMime(name, providerMime)
            if (resolvedMime == null) {
                skipped++
                continue
            }
            require(result.length() < 32) { "Insert at most 32 images at a time" }
            val bytes = context.contentResolver.openInputStream(uri)?.use { readLimited(it, 25_000_000) } ?: error("Image permission is unavailable")
            val validSignature = runCatching { requireMediaSignature(resolvedMime, bytes) }.isSuccess
            if (!validSignature) {
                skipped++
                continue
            }
            total += bytes.size
            require(total <= 75_000_000) { "Insert at most 75 MB at a time" }
            result.put(store(name ?: "Image", resolvedMime, bytes))
        }
        return DroppedImageBatch(result, skipped)
    }

    /** Save a requested browser image/diagram into Downloads or the user's configured note folder. */
    fun saveAgentMedia(args: JSONObject, configuredLocation: String?): JSONObject =
        publisher.saveAgentMedia(args, configuredLocation)

    /** Create a new document in the configured SAF folder or the app's Downloads collection. */
    fun writeAgentDocument(filename: String, mimeType: String, configuredLocation: String?, writer: (Uri, java.io.OutputStream) -> Unit): Pair<Uri, String> =
        publisher.writeAgentDocument(filename, mimeType, configuredLocation, writer)

    fun deleteAgentDocument(uri: Uri) = publisher.deleteAgentDocument(uri)
    fun local(source: String, directory: String?): File? {
        if (!validKey(source)) return null
        if (directory != null && Regex("[a-f0-9-]{36}").matches(directory)) containedFile(bundles, File(bundles, "$directory/${source.substringAfter('/')}")).let { if (it != null) return it }
        if (source.startsWith("assets/import-")) return containedFile(attachments, File(attachments, source.substringAfter('/')))
        return null
    }

    internal fun localTarget(
        source: String,
        directory: String?,
        noteUri: String? = null,
        noteRelative: String? = null,
    ): ReaderAssetTarget.LocalFile? {
        if (!validKey(source)) return null
        val name = source.substringAfter('/')
        if (directory != null && Regex("[a-f0-9-]{36}").matches(directory)) {
            val candidate = File(bundles, "$directory/$name")
            val resolved = containedFile(bundles, candidate)
            if (resolved != null) {
                return ReaderAssetTarget.LocalFile(bundles, resolved, noteUri, noteRelative, directory)
            }
            require(!java.nio.file.Files.exists(candidate.toPath(), java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
                "Image escapes app storage"
            }
        }
        if (source.startsWith("assets/import-")) {
            val candidate = File(attachments, name)
            val resolved = containedFile(attachments, candidate)
            if (resolved != null) {
                return ReaderAssetTarget.LocalFile(attachments, resolved, noteUri, noteRelative, directory)
            }
            require(!java.nio.file.Files.exists(candidate.toPath(), java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
                "Image escapes app storage"
            }
        }
        return null
    }

    internal fun readerAsset(file: File): ReaderAssetSource {
        val canonical = file.canonicalFile
        require(canonical.isFile) { "Image not found" }
        val size = canonical.length()
        require(size <= BoundedAssetInputStream.MAX_READER_ASSET_BYTES) { "Image exceeds 25 MB" }
        val mime = imageMime(canonical.name, null)
        val open = { canonical.inputStream() }
        return ReaderAssetSource(mime, readerAssetFingerprint(canonical.path, size, canonical.lastModified(), open), size, open)
    }

    internal fun readerAsset(target: ReaderAssetTarget.LocalFile): ReaderAssetSource {
        val canonical = containedFile(target.root, target.file) ?: error("Image not found")
        require(canonical.path == target.file.path && canonical.isFile) { "Image not found" }
        val size = canonical.length()
        require(size <= BoundedAssetInputStream.MAX_READER_ASSET_BYTES) { "Image exceeds 25 MB" }
        val mime = imageMime(canonical.name, null)
        val open = { canonical.inputStream() }
        val fingerprint = readerAssetFingerprint(canonical.path, size, canonical.lastModified(), open)
        return ReaderAssetSource(mime, fingerprint, size, open, target)
    }

    internal fun imageMime(name: String, providerMime: String?): String {
        val supported = setOf("image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/svg+xml")
        val normalized = providerMime?.substringBefore(';')?.lowercase()
        if (normalized != null && normalized.startsWith("image/")) {
            require(normalized in supported) { "Unsupported image type" }
            return normalized
        }
        return mime(name)
    }

    private fun containedFile(root: File, candidate: File): File? = runCatching {
        val expectedRoot = context.filesDir.canonicalFile.toPath().resolve(root.name).normalize()
        val target = candidate.canonicalFile
        // filesDir may be exposed through a non-canonical alias (for example
        // /data/data/... vs /data/user/0/... on Android). Compare canonical
        // roots so valid portable assets resolve on every API level.
        if (root.canonicalFile.toPath().normalize() != expectedRoot) return@runCatching null
        val canonicalRoot = root.canonicalPath + File.separator
        target.takeIf { it.isFile && it.canonicalPath.startsWith(canonicalRoot) }
    }.getOrNull()
    data class Opened(val markdown: String, val directory: String)
    fun openFmd(input: InputStream): Opened = codec.openFmd(input)
    fun writeFmd(output: java.io.OutputStream, markdown: String, assets: JSONObject) =
        codec.writeFmd(output, markdown, assets, null)
    internal fun writeFmd(output: java.io.OutputStream, markdown: String, assets: JSONObject, validatedAssets: JSONObject?) =
        codec.writeFmd(output, markdown, assets, validatedAssets)

    /** Stream-validate an on-disk portable archive against an expected baseline without extracting unchanged assets. */
    internal fun portableEnvelopeMatches(input: InputStream, expectedMarkdown: String, expectedAssets: JSONObject): Boolean =
        codec.portableEnvelopeMatches(input, expectedMarkdown, expectedAssets)

    internal fun hasExactLocalPortableAssets(directory: String?, assets: JSONObject): Boolean =
        codec.hasExactLocalPortableAssets(directory, assets)

    internal fun materializePortableDirectory(
        assets: JSONObject,
        reuseFromDirectory: String? = null,
        predecodedBytes: Map<String, Pair<String, ByteArray>> = emptyMap(),
    ): String = codec.materializePortableDirectory(assets, reuseFromDirectory, predecodedBytes)

    fun portableMarkdown(input: InputStream, stopAfterMarkdown: Boolean = false, maxMarkdownBytes: Int = 20_000_000): String =
        codec.portableMarkdown(input, stopAfterMarkdown, maxMarkdownBytes)

    internal fun readSearchableNote(
        input: InputStream,
        maxPlainBytes: Int = 5_000_000,
        maxPortableMarkdownBytes: Int = 20_000_000,
    ): String? = codec.readSearchableNote(input, maxPlainBytes, maxPortableMarkdownBytes)

    fun writeLocalPortable(output: java.io.OutputStream, markdown: String, directory: String?) =
        codec.writeLocalPortable(output, markdown, directory)
    fun fetch(address: String, image: Boolean): String {
        var url = URL(address)
        repeat(5) {
            require(url.protocol == "https" && (url.port == -1 || url.port == 443) && url.userInfo == null) { "Use a public HTTPS address" }
            val addresses = InetAddress.getAllByName(url.host)
            require(addresses.isNotEmpty() && addresses.all { publicAddress(it) }) { "Local/private network addresses are not allowed" }
            val connection = url.openConnection() as HttpURLConnection
            connection.instanceFollowRedirects = false; connection.connectTimeout = 15_000; connection.readTimeout = 15_000
            connection.setRequestProperty("User-Agent", "SuperMD/0.3")
            try {
                val status = connection.responseCode
                if (status in 300..399) { url = URL(url, connection.getHeaderField("Location") ?: error("Invalid redirect")); return@repeat }
                require(status in 200..299) { "Server returned HTTP $status" }
                val bytes = connection.inputStream.use { readLimited(it, if (image) 25_000_000 else 1_000_000) }
                if (!image) return bytes.toString(Charsets.UTF_8)
                val type = connection.contentType?.substringBefore(';')?.lowercase() ?: error("Server omitted image type")
                val data = "data:$type;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP); decode(data); return data
            } finally { connection.disconnect() }
        }
        error("Too many redirects")
    }
    private fun publicAddress(ip: InetAddress): Boolean {
        if (ip.isAnyLocalAddress || ip.isLoopbackAddress || ip.isLinkLocalAddress || ip.isSiteLocalAddress || ip.isMulticastAddress) return false
        val b = ip.address.map { it.toInt() and 255 }
        if (b.size == 4) return b[0] !in listOf(0, 127, 10, 255) && !(b[0] == 100 && b[1] in 64..127) && !(b[0] == 192 && b[1] == 168) && !(b[0] == 172 && b[1] in 16..31)
        return b[0] and 0xfe != 0xfc
    }
}

internal fun requireMediaSignature(mime: String, bytes: ByteArray) {
    fun starts(vararg values: Int) = bytes.size >= values.size && values.indices.all { (bytes[it].toInt() and 0xff) == values[it] }
    when (mime) {
        "image/png" -> require(starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) { "PNG signature is invalid" }
        "image/jpeg" -> require(starts(0xff, 0xd8, 0xff)) { "JPEG signature is invalid" }
        "image/gif" -> require(bytes.size >= 6 && String(bytes, 0, 6, Charsets.US_ASCII) in listOf("GIF87a", "GIF89a")) { "GIF signature is invalid" }
        "image/webp" -> require(bytes.size >= 12 && String(bytes, 0, 4, Charsets.US_ASCII) == "RIFF" && String(bytes, 8, 4, Charsets.US_ASCII) == "WEBP") { "WebP signature is invalid" }
        "image/avif" -> require(bytes.size >= 12 && String(bytes, 4, 4, Charsets.US_ASCII) == "ftyp" && String(bytes, 8, 4, Charsets.US_ASCII) in setOf("avif", "avis")) { "AVIF signature is invalid" }
        "image/svg+xml" -> require(String(bytes, 0, minOf(bytes.size, 4096), Charsets.UTF_8).contains(Regex("<svg(?:\\s|>|/)", RegexOption.IGNORE_CASE))) { "SVG document is invalid" }
        "text/plain" -> require(bytes.none { it == 0.toByte() }) { "Text media contains binary data" }
    }
}

internal fun readLimited(input: InputStream, limit: Int): ByteArray {
    val output = java.io.ByteArrayOutputStream(); val buffer = ByteArray(8192)
    while (true) { val count = input.read(buffer); if (count < 0) break; require(output.size() + count <= limit) { "File exceeds the ${limit / 1_000_000} MB limit" }; output.write(buffer, 0, count) }
    return output.toByteArray()
}
