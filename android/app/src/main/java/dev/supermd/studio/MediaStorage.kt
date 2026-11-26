package dev.supermd.studio

import android.content.Context
import android.content.ContentValues
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.provider.DocumentsContract
import android.util.Base64
import android.util.JsonReader
import android.util.JsonWriter
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.io.BufferedInputStream
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
import java.util.zip.Deflater
import java.util.zip.GZIPOutputStream

internal const val PORTABLE_GZIP_LEVEL = 3
private const val MAX_VALIDATED_ASSETS = 512
private const val MAX_CACHED_LOCAL_ASSETS = 256
private const val MAX_CACHED_LOCAL_CHARS = 48_000_000L

/** Attachments live outside Markdown and recovery snapshots. FMD is the shareable envelope. */
class MediaStorage(private val context: Context) {
    companion object {
        const val UNSUPPORTED_DROP_IMAGE_MESSAGE = "Only supported images (PNG, JPEG, GIF, WebP, AVIF, or SVG) can be dropped into a note."
        const val UNGRANTED_DROP_IMAGE_MESSAGE = "Dropped image read access was not granted; choose the image with Insert image instead."
        const val SWITCHED_NOTE_IMPORT_MESSAGE = "Image import cancelled because you switched notes before it finished."
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
    data class DroppedImageBatch(val images: JSONArray, val skippedCount: Int, val missingGrantCount: Int = 0)
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

    private fun lookupValidatedMeta(data: String): Pair<String, Int>? {
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

    private fun cacheWrittenLocalAsset(file: File, mime: String, decodedSize: Int, dataUrl: String) {
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

    private fun parsePortableDataHeader(data: String): Pair<String, Int> {
        require(data.length <= 34_000_000) { "Image exceeds 25 MB" }
        val comma = data.indexOf(',')
        require(comma > 0) { "Unsupported image data" }
        val header = data.substring(0, comma)
        require(header.matches(Regex("data:image/(png|jpeg|gif|webp|avif|svg\\+xml);base64"))) { "Unsupported image data" }
        return header.removePrefix("data:").removeSuffix(";base64") to (comma + 1)
    }

    private fun requireValidBase64Payload(data: String, start: Int): Boolean {
        var nonWsCount = 0
        var paddingCount = 0
        var sawWhitespace = false
        for (index in start until data.length) {
            when (val ch = data[index]) {
                ' ', '\n', '\r', '\t' -> sawWhitespace = true
                '=' -> {
                    nonWsCount++
                    paddingCount++
                    require(paddingCount <= 2) { "Invalid base64 image data" }
                }
                in 'A'..'Z', in 'a'..'z', in '0'..'9', '+', '/' -> {
                    require(paddingCount == 0) { "Invalid base64 image data" }
                    nonWsCount++
                }
                else -> throw IllegalArgumentException("Invalid base64 image data")
            }
        }
        require(nonWsCount % 4 == 0) { "Invalid base64 image data" }
        return !sawWhitespace
    }

    private fun validateAssetMeta(data: String, knownValidated: String? = null): Pair<String, Int> {
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

    fun createEmptyPortableDirectory(): String {
        val id = UUID.randomUUID().toString()
        check(File(bundles, id).mkdirs()) { "Could not prepare the portable note's local asset directory" }
        return id
    }
    private val key = Regex("assets/[a-zA-Z0-9_.-]{1,150}")
    private fun gzip(output: java.io.OutputStream) = object : GZIPOutputStream(output, 8192) {
        init { def.setLevel(PORTABLE_GZIP_LEVEL) }
    }
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
    fun portableAssets(directory: String?): JSONObject {
        val result = JSONObject()
        if (directory == null) return result
        require(Regex("[a-f0-9-]{36}").matches(directory)) { "Portable asset directory is invalid" }
        val root = File(bundles, directory).canonicalFile
        require(root.parentFile == bundles.canonicalFile && root.isDirectory) { "Portable assets are unavailable" }
        root.listFiles()?.sortedBy { it.name }?.forEach { file ->
            if (!file.isFile) return@forEach
            val source = "assets/${file.name}"
            if (!validKey(source)) return@forEach
            val value = data(file)
            val (type, byteSize) = validateAssetMeta(value)
            require(mime(source) == type) { "Portable image extension does not match its type" }
            require(byteSize <= 25_000_000) { "Portable image exceeds 25 MB" }
            result.put(source, value)
        }
        return result
    }

    fun portableAssetPage(directory: String?, offset: Int, limit: Int): JSONObject {
        require(offset in 0..512 && limit in 1..50) { "Invalid asset page" }
        if (directory == null) return JSONObject().put("assets", JSONArray()).put("total", 0).put("nextOffset", JSONObject.NULL)
        require(Regex("[a-f0-9-]{36}").matches(directory)) { "Portable asset directory is invalid" }
        val root = File(bundles, directory).canonicalFile
        require(root.parentFile == bundles.canonicalFile && root.isDirectory) { "Portable assets are unavailable" }
        val files = root.listFiles()?.filter { it.isFile && validKey("assets/${it.name}") }?.sortedBy { it.name }.orEmpty()
        val page = JSONArray()
        files.drop(offset).take(limit).forEach { file ->
            val source = "assets/${file.name}"
            val type = mime(source)
            val digest = java.security.MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input ->
                val buffer = ByteArray(8192)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    digest.update(buffer, 0, count)
                }
            }
            page.put(JSONObject().put("id", java.security.MessageDigest.getInstance("SHA-256").digest(source.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) })
                .put("name", source).put("mimeType", type).put("bytes", file.length())
                .put("sha256", digest.digest().joinToString("") { "%02x".format(it) }))
        }
        val next = (offset + page.length()).takeIf { it < files.size }
        return JSONObject().put("assets", page).put("total", files.size).put("nextOffset", next ?: JSONObject.NULL)
    }

    fun portableAssetBytes(directory: String?, source: String, maxBytes: Int): Pair<String, ByteArray> {
        val file = local(source, directory) ?: error("Asset is not present in the current note")
        require(file.length() in 1..maxBytes.toLong()) { "Original asset retrieval is limited to ${maxBytes / 1_000_000} MB" }
        return mime(source) to file.readBytes()
    }

    fun resolvePortableAssetName(directory: String?, requested: String): String? {
        if (directory == null || !Regex("[a-f0-9-]{36}").matches(directory)) return null
        val root = File(bundles, directory).canonicalFile
        if (root.parentFile != bundles.canonicalFile || !root.isDirectory) return null
        val simple = if (requested.startsWith("assets/")) requested.substringAfter('/') else requested
        val files = root.listFiles()?.filter { it.isFile && validKey("assets/${it.name}") }.orEmpty()
        val exact = files.firstOrNull { it.name == simple }
        if (exact != null) return "assets/${exact.name}"
        return files.firstOrNull { file ->
            java.security.MessageDigest.getInstance("SHA-256").digest("assets/${file.name}".toByteArray(Charsets.UTF_8))
                .joinToString("") { "%02x".format(it) } == requested
        }?.let { "assets/${it.name}" }
    }

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
        runCatching { androidx.documentfile.provider.DocumentFile.fromSingleUri(context, uri)?.name }
            .getOrNull()
            ?.takeIf { it.isNotBlank() }
            ?: uri.lastPathSegment?.substringAfterLast('/')?.takeIf { it.isNotBlank() }

    fun importUris(uris: List<Uri>): JSONArray {
        require(uris.size in 1..32)
        var total = 0L
        val result = JSONArray()
        try {
            for (uri in uris) {
                ExternalDocumentEntryGuard.validatePickedMediaUri(context, uri)
                val name = resolveUriDisplayName(uri) ?: "Image"
                val providerMime = runCatching { context.contentResolver.getType(uri) }.getOrNull()
                val type = imageMime(name, providerMime)
                val bytes = ExternalDocumentEntryGuard.openVerifiedPickedMediaInputStream(
                    context = context,
                    resolver = context.contentResolver,
                    uri = uri,
                ).use { readLimited(it, 25_000_000) }
                requireMediaSignature(type, bytes)
                total += bytes.size
                require(total <= 75_000_000) { "Insert at most 75 MB at a time" }
                result.put(store(name, type, bytes))
            }
            return result
        } catch (error: Throwable) {
            discardImportedImages(result)
            throw error
        }
    }

    fun importDroppedUris(
        uris: List<Uri>,
        dragReadPermissionGranted: Boolean = true,
    ): DroppedImageBatch {
        if (uris.isEmpty()) return DroppedImageBatch(JSONArray(), 0, 0)
        var total = 0L
        var skipped = 0
        var missingGrants = 0
        val result = JSONArray()
        try {
            for (uri in uris) {
                when (ExternalDocumentEntryGuard.validateDroppedUri(context, uri, dragReadPermissionGranted)) {
                    is ExternalDropUriDecision.MissingGrant -> {
                        missingGrants++
                        continue
                    }
                    is ExternalDropUriDecision.Rejected -> {
                        skipped++
                        continue
                    }
                    is ExternalDropUriDecision.Allowed -> Unit
                }
                val name = resolveUriDisplayName(uri)
                val providerMime = runCatching { context.contentResolver.getType(uri) }.getOrNull()
                val resolvedMime = resolveDroppedImageMime(name, providerMime)
                if (resolvedMime == null) {
                    skipped++
                    continue
                }
                require(result.length() < 32) { "Insert at most 32 images at a time" }
                val stream = try {
                    ExternalDocumentEntryGuard.openVerifiedDroppedInputStream(
                        context = context,
                        resolver = context.contentResolver,
                        uri = uri,
                        dragReadPermissionGranted = dragReadPermissionGranted,
                    )
                } catch (_: SecurityException) {
                    missingGrants++
                    continue
                } catch (_: Exception) {
                    skipped++
                    continue
                }
                val bytes = stream.use { readLimited(it, 25_000_000) }
                val validSignature = runCatching { requireMediaSignature(resolvedMime, bytes) }.isSuccess
                if (!validSignature) {
                    skipped++
                    continue
                }
                total += bytes.size
                require(total <= 75_000_000) { "Insert at most 75 MB at a time" }
                result.put(store(name ?: "Image", resolvedMime, bytes))
            }
            return DroppedImageBatch(
                images = result,
                skippedCount = skipped + missingGrants,
                missingGrantCount = missingGrants,
            )
        } catch (error: Throwable) {
            discardImportedImages(result)
            throw error
        }
    }

    internal fun discardImportedImages(images: JSONArray) {
        for (i in 0 until images.length()) {
            val source = images.optJSONObject(i)?.optString("source").orEmpty()
            if (source.startsWith("assets/import-")) {
                local(source, null)?.let { file ->
                    invalidateLocalAsset(file)
                    file.delete()
                }
            }
        }
    }

    /** Save a requested browser image/diagram into Downloads or the user's configured note folder. */
    fun saveAgentMedia(args: JSONObject, configuredLocation: String?): JSONObject {
        val encoded = args.getString("body")
        require(encoded.length <= 34_000_000) { "Media export exceeds 25 MB" }
        val bytes = Base64.decode(encoded, Base64.DEFAULT)
        require(bytes.size in 1..25_000_000) { "Media export must be at most 25 MB" }
        val mime = args.getString("mimeType").substringBefore(';').lowercase()
        val extension = when (mime) {
            "image/png" -> "png"
            "image/svg+xml" -> "svg"
            "image/jpeg" -> "jpg"
            "image/webp" -> "webp"
            "image/gif" -> "gif"
            "image/avif" -> "avif"
            "text/plain" -> "mmd"
            else -> error("Unsupported media type")
        }
        requireMediaSignature(mime, bytes)
        val rawName = args.optString("filename", "Super MD export")
            .substringAfterLast('/').substringAfterLast('\\')
            .replace(Regex("[\\u0000-\\u001f\\u007f]"), "").trim().take(120)
        val stem = rawName.substringBeforeLast('.', rawName).trim().take(100).ifBlank { "Super MD export" }
        val requestedName = "$stem.$extension"
        val folder = configuredLocation?.takeIf(String::isNotBlank)?.let(Uri::parse)
        if (folder != null && DocumentsContract.isTreeUri(folder)) {
            val parent = androidx.documentfile.provider.DocumentFile.fromTreeUri(context, folder)
                ?: error("Open the configured folder again to restore access")
            val name = uniqueName(requestedName) { parent.findFile(it) != null }
            val file = parent.createFile(mime, name) ?: error("The selected folder cannot create files")
            try {
                context.contentResolver.openOutputStream(file.uri, "w")?.use { it.write(bytes); it.flush() }
                    ?: error("The selected folder cannot write files")
            } catch (error: Exception) { runCatching { file.delete() }; throw error }
            return JSONObject().put("filename", file.name ?: name).put("bytes", bytes.size)
                .put("mimeType", mime).put("uri", file.uri.toString())
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            error("Choose a folder in Settings → New note location before saving media on this Android version")
        }
        val relativePath = Environment.DIRECTORY_DOWNLOADS + "/Super MD"
        val resolver = context.contentResolver
        val name = uniqueName(requestedName) { candidate ->
            resolver.query(MediaStore.Downloads.EXTERNAL_CONTENT_URI, arrayOf(MediaStore.Downloads._ID),
                "${MediaStore.Downloads.DISPLAY_NAME}=? AND ${MediaStore.Downloads.RELATIVE_PATH}=?",
                arrayOf(candidate, "$relativePath/"), null)?.use { it.moveToFirst() } == true
        }
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE, mime)
            put(MediaStore.Downloads.RELATIVE_PATH, "$relativePath/")
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: error("Android could not create a Downloads entry")
        try {
            resolver.openOutputStream(uri, "w")?.use { it.write(bytes); it.flush() }
                ?: error("Android could not write the Downloads entry")
            resolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
        } catch (error: Exception) { runCatching { resolver.delete(uri, null, null) }; throw error }
        return JSONObject().put("filename", name).put("bytes", bytes.size).put("mimeType", mime).put("uri", uri.toString())
    }

    /** Create a new document in the configured SAF folder or the app's Downloads collection. */
    fun writeAgentDocument(filename: String, mimeType: String, configuredLocation: String?, writer: (Uri, java.io.OutputStream) -> Unit): Pair<Uri, String> {
        require(filename.isNotBlank() && filename.length <= 240 && filename == filename.substringAfterLast('/').substringAfterLast('\\') &&
            !filename.contains(Regex("[\\u0000-\\u001f\\u007f]"))) { "Invalid save-as filename" }
        val mime = mimeType.substringBefore(';').lowercase()
        require(mime in setOf("text/markdown", "application/vnd.supermd.smd", "application/pdf", "application/zip")) { "Unsupported document format" }
        val folder = configuredLocation?.takeIf(String::isNotBlank)?.let(Uri::parse)
        if (folder != null) {
            require(DocumentsContract.isTreeUri(folder)) { "The configured note location is not a folder; choose it again in Super MD settings" }
            val parent = androidx.documentfile.provider.DocumentFile.fromTreeUri(context, folder)
                ?: error("Open the configured folder again to restore access")
            val name = uniqueName(filename) { parent.findFile(it) != null }
            val file = parent.createFile(mime, name) ?: error("The configured folder cannot create files")
            try {
                context.contentResolver.openOutputStream(file.uri, "w")?.use { writer(file.uri, it) } ?: error("The configured folder cannot write files")
            } catch (error: Exception) {
                runCatching { file.delete() }
                throw error
            }
            return file.uri to (file.name ?: name)
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            error("Choose a folder in Settings → New note location before saving to Downloads on this Android version")
        }
        val relativePath = Environment.DIRECTORY_DOWNLOADS + "/Super MD"
        val resolver = context.contentResolver
        val name = uniqueName(filename) { candidate ->
            resolver.query(MediaStore.Downloads.EXTERNAL_CONTENT_URI, arrayOf(MediaStore.Downloads._ID),
                "${MediaStore.Downloads.DISPLAY_NAME}=? AND ${MediaStore.Downloads.RELATIVE_PATH}=?",
                arrayOf(candidate, "$relativePath/"), null)?.use { it.moveToFirst() } == true
        }
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE, mime)
            put(MediaStore.Downloads.RELATIVE_PATH, "$relativePath/")
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: error("Android could not create a Downloads entry")
        try {
            resolver.openOutputStream(uri, "w")?.use { writer(uri, it) } ?: error("Android could not write the Downloads entry")
            require(resolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null) > 0) { "Android could not publish the Downloads entry" }
        } catch (error: Exception) {
            runCatching { resolver.delete(uri, null, null) }
            throw error
        }
        return uri to name
    }

    fun deleteAgentDocument(uri: Uri) {
        if (uri.authority == MediaStore.AUTHORITY) context.contentResolver.delete(uri, null, null)
        else androidx.documentfile.provider.DocumentFile.fromSingleUri(context, uri)?.delete()
    }

    private fun uniqueName(requested: String, exists: (String) -> Boolean): String {
        val stem = requested.substringBeforeLast('.')
        val ext = requested.substringAfterLast('.', "")
        var index = 1
        var candidate = requested
        while (exists(candidate)) { index++; candidate = "$stem ($index).$ext" }
        return candidate
    }

    private fun requireMediaSignature(mime: String, bytes: ByteArray) {
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
    fun openFmd(input: InputStream): Opened {
        val directory = UUID.randomUUID().toString(); val root = File(bundles, directory).apply { mkdirs() }
        try {
            val sniff = if (input.markSupported()) input else BufferedInputStream(input)
            sniff.mark(2)
            val gzip = sniff.read() == 0x1f && sniff.read() == 0x8b
            sniff.reset()
            val content = if (gzip) StrictGzipInputStream(sniff) else sniff
            var format = ""; var version = 0; var markdown: String? = null; var total = 0L; var assetCount = 0
            val bounded = object : java.io.FilterInputStream(content) {
                // Keep this distinct from assetCount: lexical capture must never
                // turn bytes consumed into the number of embedded images.
                var bytesRead = 0L
                override fun read(): Int { val value = super.read(); if (value >= 0) require(++this.bytesRead <= 120_000_000) { "FMD exceeds 120 MB" }; return value }
                override fun read(buffer: ByteArray, offset: Int, length: Int): Int { val size = super.read(buffer, offset, length); if (size > 0) { this.bytesRead += size; require(this.bytesRead <= 120_000_000) { "FMD exceeds 120 MB" } }; return size }
            }
            // Limit individual JSON tokens while streaming, before JsonReader
            // allocates an attacker-sized string on a mobile heap.
            val limitedText = object : java.io.FilterReader(bounded.reader()) {
                var quoted = false; var escaped = false; var length = 0
                override fun read(buffer: CharArray, offset: Int, size: Int): Int {
                    val count = super.read(buffer, offset, size)
                    for (i in offset until offset + maxOf(count, 0)) {
                        val c = buffer[i]
                        if (quoted) { require(++length <= 34_000_000) { "FMD token is too large" }; if (escaped) escaped = false else if (c == '\\') escaped = true else if (c == '"') quoted = false }
                        else if (c == '"') { quoted = true; length = 0 }
                    }
                    return count
                }
            }
            JsonReader(limitedText.buffered()).use { reader ->
                reader.beginObject()
                while (reader.hasNext()) when(reader.nextName()) {
                    "format" -> format = reader.nextString()
                    "version" -> version = reader.nextInt()
                    "markdown" -> { markdown = reader.nextString(); require(markdown!!.toByteArray().size <= 20_000_000) { "FMD Markdown exceeds 20 MB" } }
                    "assets" -> { reader.beginObject(); while(reader.hasNext()) {
                        val source = reader.nextName(); require(validKey(source)) { "Invalid FMD asset name" }; require(++assetCount <= 512) { "FMD contains more than 512 images" }
                        val rawValue = reader.nextString()
                        val (type, bytes) = decode(rawValue); require(mime(source) == type) { "Image extension does not match its type" }; total += bytes.size; require(total <= 75_000_000) { "FMD assets exceed 75 MB" }
                        val targetFile = File(root, source.substringAfter('/'))
                        targetFile.writeBytes(bytes)
                        portableAssetExtractions.incrementAndGet()
                        val expectedLen = ("data:$type;base64,".length) + ((bytes.size + 2) / 3) * 4
                        val canonicalUrl = if (rawValue.length == expectedLen && lookupValidatedMeta(rawValue) != null) {
                            rawValue
                        } else {
                            "data:$type;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
                        }
                        cacheWrittenLocalAsset(targetFile, type, bytes.size, canonicalUrl)
                    }; reader.endObject() }
                    else -> error("Unknown portable-file field")
                }
                reader.endObject(); require(reader.peek() == android.util.JsonToken.END_DOCUMENT) { "Unexpected data after the FMD envelope" }
            }
            require(format in listOf("supermd-smd", "supermd-fmd") && version == 1 && markdown != null) { "Unsupported portable SMD file" }
            return Opened(markdown!!, directory)
        } catch (error: Exception) { invalidateLocalAsset(root); root.deleteRecursively(); throw error }
    }
    fun writeFmd(output: java.io.OutputStream, markdown: String, assets: JSONObject) {
        writeFmd(output, markdown, assets, null)
    }
    internal fun writeFmd(output: java.io.OutputStream, markdown: String, assets: JSONObject, validatedAssets: JSONObject?) {
        require(markdown.toByteArray(Charsets.UTF_8).size <= 20_000_000 && assets.length() <= 512)
        // Validate everything before the destination stream is written, reusing already-validated unchanged assets.
        var total = 0L
        assets.keys().forEach { source ->
            require(validKey(source)) { "Invalid FMD asset name" }
            val rawValue = assets.getString(source)
            val known = validatedAssets?.optString(source)?.takeIf { it.isNotEmpty() }
            val (type, byteSize) = validateAssetMeta(rawValue, known)
            require(mime(source) == type) { "Image extension does not match its type" }
            total += byteSize
            require(total <= 75_000_000) { "FMD assets exceed 75 MB" }
        }
        val boundedCompressed = object : java.io.FilterOutputStream(output) {
            var bytes = 0L
            override fun write(value: Int) { require(++bytes <= 120_000_000) { "FMD exceeds 120 MB" }; out.write(value) }
            override fun write(buffer: ByteArray, offset: Int, length: Int) { require(bytes + length <= 120_000_000) { "FMD exceeds 120 MB" }; out.write(buffer, offset, length); bytes += length }
        }
        val compressed = gzip(boundedCompressed)
        val boundedJson = object : java.io.FilterOutputStream(compressed) {
            var bytes = 0L
            override fun write(value: Int) { require(++bytes <= 120_000_000) { "FMD JSON exceeds 120 MB" }; out.write(value) }
            override fun write(buffer: ByteArray, offset: Int, length: Int) { require(bytes + length <= 120_000_000) { "FMD JSON exceeds 120 MB" }; out.write(buffer, offset, length); bytes += length }
        }
        JsonWriter(boundedJson.writer(Charsets.UTF_8)).use { writer ->
            writer.beginObject().name("format").value("supermd-smd").name("version").value(1).name("markdown").value(markdown).name("assets").beginObject()
            assets.keys().forEach { source -> writer.name(source).value(assets.getString(source)) }
            writer.endObject().endObject()
        }
    }

    /** Stream-validate an on-disk portable archive against an expected baseline without extracting unchanged assets. */
    internal fun portableEnvelopeMatches(input: InputStream, expectedMarkdown: String, expectedAssets: JSONObject): Boolean {
        val sniff = if (input.markSupported()) input else BufferedInputStream(input)
        sniff.mark(2)
        val gzip = sniff.read() == 0x1f && sniff.read() == 0x8b
        sniff.reset()
        val content = if (gzip) StrictGzipInputStream(sniff) else sniff
        var format = ""
        var version = 0
        var markdown: String? = null
        var total = 0L
        var assetCount = 0
        var allAssetsMatched = true
        val seenSources = HashSet<String>()
        val bounded = object : java.io.FilterInputStream(content) {
            var bytesRead = 0L
            override fun read(): Int {
                val value = super.read()
                if (value >= 0) require(++this.bytesRead <= 120_000_000) { "FMD exceeds 120 MB" }
                return value
            }
            override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
                val size = super.read(buffer, offset, length)
                if (size > 0) {
                    this.bytesRead += size
                    require(this.bytesRead <= 120_000_000) { "FMD exceeds 120 MB" }
                }
                return size
            }
        }
        val limitedText = object : java.io.FilterReader(bounded.reader(Charsets.UTF_8)) {
            var quoted = false
            var escaped = false
            var length = 0
            override fun read(buffer: CharArray, offset: Int, size: Int): Int {
                val count = super.read(buffer, offset, size)
                for (i in offset until offset + maxOf(count, 0)) {
                    val c = buffer[i]
                    if (quoted) {
                        require(++length <= 34_000_000) { "FMD token is too large" }
                        if (escaped) escaped = false else if (c == '\\') escaped = true else if (c == '"') quoted = false
                    } else if (c == '"') {
                        quoted = true
                        length = 0
                    }
                }
                return count
            }
        }
        JsonReader(limitedText.buffered()).use { reader ->
            reader.beginObject()
            while (reader.hasNext()) {
                when (reader.nextName()) {
                    "format" -> format = reader.nextString()
                    "version" -> version = reader.nextInt()
                    "markdown" -> {
                        markdown = reader.nextString()
                        require(markdown!!.toByteArray(Charsets.UTF_8).size <= 20_000_000) { "FMD Markdown exceeds 20 MB" }
                    }
                    "assets" -> {
                        reader.beginObject()
                        while (reader.hasNext()) {
                            val source = reader.nextName()
                            require(validKey(source)) { "Invalid FMD asset name" }
                            if (seenSources.add(source)) {
                                require(++assetCount <= 512) { "FMD contains more than 512 images" }
                            } else {
                                require(assetCount <= 512) { "FMD contains more than 512 images" }
                            }
                            val rawValue = reader.nextString()
                            val expectedValue = if (expectedAssets.has(source)) expectedAssets.getString(source) else null
                            if (expectedValue != null && rawValue == expectedValue) {
                                val (type, byteSize) = validateAssetMeta(rawValue, expectedValue)
                                require(mime(source) == type) { "Image extension does not match its type" }
                                total += byteSize
                                require(total <= 75_000_000) { "FMD assets exceed 75 MB" }
                            } else {
                                val (type, bytes) = decode(rawValue)
                                require(mime(source) == type) { "Image extension does not match its type" }
                                total += bytes.size
                                require(total <= 75_000_000) { "FMD assets exceed 75 MB" }
                                val canonical = "data:$type;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
                                if (expectedValue == null || canonical != expectedValue) {
                                    allAssetsMatched = false
                                }
                            }
                        }
                        reader.endObject()
                    }
                    else -> error("Unknown portable-file field")
                }
            }
            reader.endObject()
            require(reader.peek() == android.util.JsonToken.END_DOCUMENT) { "Unexpected data after the FMD envelope" }
        }
        require(format in listOf("supermd-smd", "supermd-fmd") && version == 1 && markdown != null) { "Unsupported portable SMD file" }
        return markdown == expectedMarkdown && allAssetsMatched && seenSources.size == expectedAssets.length()
    }

    internal fun hasExactLocalPortableAssets(directory: String?, assets: JSONObject): Boolean {
        if (directory == null || !Regex("[a-f0-9-]{36}").matches(directory)) return false
        val expectedBundlesRoot = runCatching {
            context.filesDir.canonicalFile.toPath().resolve(bundles.name).normalize().toFile()
        }.getOrNull() ?: return false
        val root = runCatching { File(bundles, directory).canonicalFile }.getOrNull() ?: return false
        val bundlesRoot = runCatching { bundles.canonicalFile }.getOrNull() ?: return false
        if (bundlesRoot != expectedBundlesRoot || root.parentFile != bundlesRoot || !root.isDirectory) return false
        val entries = root.listFiles() ?: return false
        if (entries.any { !it.isFile || !validKey("assets/${it.name}") }) return false
        if (entries.size != assets.length()) return false
        for (file in entries) {
            val source = "assets/${file.name}"
            if (!assets.has(source)) return false
            val expected = assets.getString(source)
            val actual = runCatching { data(file) }.getOrNull() ?: return false
            if (actual != expected) return false
        }
        return true
    }

    internal fun materializePortableDirectory(
        assets: JSONObject,
        reuseFromDirectory: String? = null,
        predecodedBytes: Map<String, Pair<String, ByteArray>> = emptyMap(),
    ): String {
        require(assets.length() <= 512) { "FMD contains more than 512 images" }
        val directory = UUID.randomUUID().toString()
        val root = File(bundles, directory).apply { mkdirs() }
        try {
            var total = 0L
            assets.keys().forEach { source ->
                require(validKey(source)) { "Invalid FMD asset name" }
                val rawValue = assets.getString(source)
                val destFile = File(root, source.substringAfter('/'))
                val reusableFile = if (reuseFromDirectory != null) local(source, reuseFromDirectory) else null
                val reusableData = reusableFile?.let { runCatching { data(it) }.getOrNull() }
                val predecoded = predecodedBytes[source]
                if (reusableFile != null && reusableData != null && reusableData == rawValue) {
                    val (type, byteSize) = validateAssetMeta(rawValue, reusableData)
                    require(mime(source) == type) { "Image extension does not match its type" }
                    total += byteSize
                    require(total <= 75_000_000) { "FMD assets exceed 75 MB" }
                    reusableFile.copyTo(destFile, overwrite = true)
                    cacheWrittenLocalAsset(destFile, type, byteSize, reusableData)
                } else if (predecoded != null) {
                    val (type, bytes) = predecoded
                    require(bytes.size <= 25_000_000) { "Image exceeds 25 MB" }
                    require(mime(source) == type) { "Image extension does not match its type" }
                    total += bytes.size
                    require(total <= 75_000_000) { "FMD assets exceed 75 MB" }
                    destFile.writeBytes(bytes)
                    portableAssetExtractions.incrementAndGet()
                    cacheWrittenLocalAsset(destFile, type, bytes.size, rawValue)
                } else {
                    val (type, bytes) = decode(rawValue)
                    require(mime(source) == type) { "Image extension does not match its type" }
                    total += bytes.size
                    require(total <= 75_000_000) { "FMD assets exceed 75 MB" }
                    destFile.writeBytes(bytes)
                    portableAssetExtractions.incrementAndGet()
                    val canonicalUrl = "data:$type;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
                    cacheWrittenLocalAsset(destFile, type, bytes.size, canonicalUrl)
                }
            }
            return directory
        } catch (error: Exception) {
            invalidateLocalAsset(root)
            root.deleteRecursively()
            throw error
        }
    }
    fun portableMarkdown(input: InputStream, stopAfterMarkdown: Boolean = false, maxMarkdownBytes: Int = 20_000_000): String {
        // Our envelope puts source before assets. Never load image bytes merely
        // to check whether a portable note's source changed externally.
        val sniff=if(input.markSupported())input else BufferedInputStream(input)
        sniff.mark(2);val gzip=sniff.read()==0x1f&&sniff.read()==0x8b;sniff.reset()
        val content=if(gzip)StrictGzipInputStream(sniff) else sniff
        val bounded=object:java.io.FilterInputStream(content){var consumed=0L;override fun read():Int {val value=super.read();if(value>=0)require(++consumed<=120_000_000);return value};override fun read(buffer:ByteArray,offset:Int,length:Int):Int {val size=super.read(buffer,offset,length);if(size>0){consumed+=size;require(consumed<=120_000_000)};return size}}
        val limitedText=object:java.io.FilterReader(bounded.reader(Charsets.UTF_8)){var quoted=false;var escaped=false;var tokenLength=0;override fun read(buffer:CharArray,offset:Int,size:Int):Int{val count=super.read(buffer,offset,size);for(i in offset until offset+maxOf(count,0)){val c=buffer[i];if(quoted){require(++tokenLength<=34_000_000){"Portable token is too large"};if(escaped)escaped=false else if(c=='\\')escaped=true else if(c=='\"')quoted=false}else if(c=='\"'){quoted=true;tokenLength=0}};return count}}
        var format: String? = null
        var version: Int? = null
        var markdown: String? = null
        JsonReader(limitedText.buffered()).use { reader ->
            reader.beginObject()
            while (reader.hasNext()) {
                when (reader.nextName()) {
                    "format" -> { format = reader.nextString(); require(!stopAfterMarkdown || format in setOf("supermd-smd", "supermd-fmd")) }
                    "version" -> { version = reader.nextInt(); require(!stopAfterMarkdown || version == 1) }
                    "markdown" -> { val source = reader.nextString(); require(source.toByteArray(Charsets.UTF_8).size <= maxMarkdownBytes); markdown = source }
                    else -> reader.skipValue()
                }
                if (stopAfterMarkdown && format in setOf("supermd-smd", "supermd-fmd") && version == 1 && markdown != null) {
                    return markdown!!
                }
            }
            reader.endObject()
            if (!stopAfterMarkdown) {
                require(reader.peek() == android.util.JsonToken.END_DOCUMENT) { "Unexpected data after the portable envelope" }
            }
        }
        if (stopAfterMarkdown) require(format in setOf("supermd-smd", "supermd-fmd") && version == 1)
        return markdown ?: error("Portable source is unavailable")
    }

    internal fun readSearchableNote(
        input: InputStream,
        maxPlainBytes: Int = 5_000_000,
        maxPortableMarkdownBytes: Int = 20_000_000,
    ): String? {
        val buffered = if (input.markSupported()) input else BufferedInputStream(input, 65_536)
        buffered.mark(65_536)
        val prefix = ByteArray(32_768)
        var prefixLen = 0
        while (prefixLen < prefix.size) {
            val count = buffered.read(prefix, prefixLen, prefix.size - prefixLen)
            if (count <= 0) break
            prefixLen += count
        }
        buffered.reset()
        if (prefixLen == 0) return ""
        val headBytes = prefix.copyOfRange(0, prefixLen)
        val isGzip = portableGzipHeader(headBytes)
        val headerPreview = if (!isGzip) {
            runCatching { String(headBytes, Charsets.UTF_8).trimStart('\uFEFF', ' ', '\n', '\r', '\t') }.getOrDefault("")
        } else ""
        if (isGzip || portableEnvelopeHeader(headerPreview)) {
            return runCatching { portableMarkdown(buffered, stopAfterMarkdown = true, maxMarkdownBytes = maxPortableMarkdownBytes) }.getOrNull()
        }
        if (headBytes.any { it == 0.toByte() }) return null
        return runCatching {
            val raw = readLimited(buffered, maxPlainBytes)
            if (raw.any { it == 0.toByte() }) return null
            Charsets.UTF_8.newDecoder()
                .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
                .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
                .decode(java.nio.ByteBuffer.wrap(raw))
                .toString()
                .removePrefix("\uFEFF")
        }.getOrNull()
    }
    fun writeLocalPortable(output: java.io.OutputStream, markdown: String, directory: String?) {
        val sources=JSONArray(markdownImageSourcesJson(markdown))
        val files=(0 until sources.length()).map {sources.getString(it)}.distinct().filter {it.startsWith("assets/")}.map {source->source to (local(source,directory) ?: error("Save manually to resolve a new image: $source"))}
        require(files.size<=512 && files.sumOf {it.second.length()}<=75_000_000 && markdown.toByteArray().size<=20_000_000)
        val boundedCompressed=object:java.io.FilterOutputStream(output){var bytes=0L;override fun write(value:Int){require(++bytes<=120_000_000);out.write(value)};override fun write(buffer:ByteArray,offset:Int,length:Int){require(bytes+length<=120_000_000);out.write(buffer,offset,length);bytes+=length}}
        val compressed=gzip(boundedCompressed)
        val boundedJson=object:java.io.FilterOutputStream(compressed){var bytes=0L;override fun write(value:Int){require(++bytes<=120_000_000);out.write(value)};override fun write(buffer:ByteArray,offset:Int,length:Int){require(bytes+length<=120_000_000);out.write(buffer,offset,length);bytes+=length}}
        JsonWriter(boundedJson.writer()).use {writer->writer.beginObject().name("format").value("supermd-smd").name("version").value(1).name("markdown").value(markdown).name("assets").beginObject();files.forEach {(source,file)->writer.name(source).value(data(file))};writer.endObject().endObject()}
    }
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

internal fun readLimited(input: InputStream, limit: Int): ByteArray {
    val output = java.io.ByteArrayOutputStream(); val buffer = ByteArray(8192)
    while (true) { val count = input.read(buffer); if (count < 0) break; require(output.size() + count <= limit) { "File exceeds the ${limit / 1_000_000} MB limit" }; output.write(buffer, 0, count) }
    return output.toByteArray()
}
