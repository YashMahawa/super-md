package dev.supermd.studio

import android.content.Context
import android.util.Base64
import android.util.JsonReader
import android.util.JsonToken
import android.util.JsonWriter
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FilterInputStream
import java.io.FilterOutputStream
import java.io.FilterReader
import java.io.InputStream
import java.io.OutputStream
import java.io.Reader
import java.io.SequenceInputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import java.util.UUID
import java.util.zip.GZIPOutputStream

internal const val PORTABLE_GZIP_LEVEL = 3
private const val MAX_PORTABLE_STREAM_BYTES = 120_000_000L
private const val MAX_PORTABLE_TOKEN_CHARS = 34_000_000
private const val MAX_PORTABLE_MARKDOWN_BYTES = 20_000_000
private const val MAX_PORTABLE_ASSET_BYTES = 25_000_000
private const val MAX_PORTABLE_TOTAL_ASSET_BYTES = 75_000_000L
private const val MAX_PORTABLE_ASSET_COUNT = 512
private val PORTABLE_FORMATS = setOf("supermd-smd", "supermd-fmd")
private val BUNDLE_DIR_REGEX = Regex("[a-f0-9-]{36}")
private val PORTABLE_DATA_HEADER_REGEX = Regex("data:image/(png|jpeg|gif|webp|avif|svg\\+xml);base64")

internal fun parsePortableDataHeader(data: String): Pair<String, Int> {
    require(data.length <= MAX_PORTABLE_TOKEN_CHARS) { "Image exceeds 25 MB" }
    val comma = data.indexOf(',')
    require(comma > 0) { "Unsupported image data" }
    val header = data.substring(0, comma)
    require(PORTABLE_DATA_HEADER_REGEX.matches(header)) { "Unsupported image data" }
    return header.removePrefix("data:").removeSuffix(";base64") to (comma + 1)
}

internal fun requireValidBase64Payload(data: String, start: Int): Boolean {
    var nonWsCount = 0
    var paddingCount = 0
    var sawWhitespace = false
    for (index in start until data.length) {
        when (data[index]) {
            ' ', '\n', '\r', '\t' -> sawWhitespace = true
            '=' -> {
                nonWsCount++
                require(++paddingCount <= 2) { "Invalid base64 image data" }
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

private class BoundedInputStream(
    input: InputStream,
    private val maxBytes: Long = MAX_PORTABLE_STREAM_BYTES,
) : FilterInputStream(input) {
    private var bytesRead = 0L
    override fun read(): Int {
        val value = `in`.read()
        if (value >= 0) require(++bytesRead <= maxBytes) { "FMD exceeds 120 MB" }
        return value
    }
    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        val size = `in`.read(buffer, offset, length)
        if (size > 0) {
            bytesRead += size
            require(bytesRead <= maxBytes) { "FMD exceeds 120 MB" }
        }
        return size
    }
}

private class BoundedJsonTokenReader(
    reader: Reader,
    private val maxTokenChars: Int = MAX_PORTABLE_TOKEN_CHARS,
) : FilterReader(reader) {
    private var quoted = false
    private var escaped = false
    private var tokenLength = 0

    private fun inspectChar(c: Char) {
        if (quoted) {
            require(++tokenLength <= maxTokenChars) { "FMD token is too large" }
            if (escaped) escaped = false else if (c == '\\') escaped = true else if (c == '"') quoted = false
        } else if (c == '"') {
            quoted = true
            escaped = false
            tokenLength = 0
        }
    }

    override fun read(): Int = `in`.read().also { if (it >= 0) inspectChar(it.toChar()) }
    override fun read(buffer: CharArray, offset: Int, size: Int): Int {
        val count = `in`.read(buffer, offset, size)
        for (i in offset until offset + maxOf(count, 0)) inspectChar(buffer[i])
        return count
    }
}

internal class BoundedOutputStream(
    out: OutputStream,
    private val maxBytes: Long = MAX_PORTABLE_STREAM_BYTES,
    private val errorMessage: String = "FMD exceeds 120 MB",
) : FilterOutputStream(out) {
    var bytes: Long = 0L
        private set

    override fun write(value: Int) {
        require(bytes + 1 <= maxBytes) { errorMessage }
        out.write(value)
        bytes += 1
    }

    override fun write(buffer: ByteArray, offset: Int, length: Int) {
        if (offset < 0 || length < 0 || length > buffer.size - offset) throw IndexOutOfBoundsException()
        if (length == 0) return
        require(bytes + length <= maxBytes) { errorMessage }
        out.write(buffer, offset, length)
        bytes += length
    }
}

private class PortableGzipOutputStream(output: OutputStream) : GZIPOutputStream(output, 8192) {
    init { def.setLevel(PORTABLE_GZIP_LEVEL) }
    override fun close() {
        try { super.close() } finally { def.end() }
    }
}

internal fun <T> withBoundedPortableJsonReader(
    input: InputStream,
    maxBytes: Long = MAX_PORTABLE_STREAM_BYTES,
    maxTokenChars: Int = MAX_PORTABLE_TOKEN_CHARS,
    block: (JsonReader) -> T,
): T {
    val sniff = if (input.markSupported()) input else BufferedInputStream(input)
    sniff.mark(2)
    val header = ByteArray(2)
    var headerLen = 0
    while (headerLen < header.size) {
        val count = sniff.read(header, headerLen, header.size - headerLen)
        if (count < 0) break
        if (count == 0) {
            val single = sniff.read()
            if (single < 0) break
            header[headerLen++] = single.toByte()
        } else {
            headerLen += count
        }
    }
    sniff.reset()
    val content = if (headerLen == 2 && portableGzipHeader(header)) StrictGzipInputStream(sniff) else sniff
    val bounded = BoundedInputStream(content, maxBytes)
    // Limit individual JSON tokens while streaming before JsonReader allocates heap strings.
    val limitedText = BoundedJsonTokenReader(bounded.reader(Charsets.UTF_8), maxTokenChars)
    return JsonReader(limitedText.buffered()).use(block)
}

private fun withBoundedPortableJsonWriter(output: OutputStream, block: (JsonWriter) -> Unit) {
    val boundedCompressed = BoundedOutputStream(output, MAX_PORTABLE_STREAM_BYTES, "FMD exceeds 120 MB")
    val compressed = PortableGzipOutputStream(boundedCompressed)
    val boundedJson = BoundedOutputStream(compressed, MAX_PORTABLE_STREAM_BYTES, "FMD JSON exceeds 120 MB")
    JsonWriter(boundedJson.writer(Charsets.UTF_8)).use(block)
}

internal class PortableEnvelopeCodec(
    private val context: Context,
    private val bundles: File,
    private val media: MediaStorage,
) {
    fun createEmptyPortableDirectory(): String {
        val id = UUID.randomUUID().toString()
        check(File(bundles, id).mkdirs()) { "Could not prepare the portable note's local asset directory" }
        return id
    }

    private fun requireBundleRoot(directory: String): File {
        require(BUNDLE_DIR_REGEX.matches(directory)) { "Portable asset directory is invalid" }
        val root = File(bundles, directory).canonicalFile
        require(root.parentFile == bundles.canonicalFile && root.isDirectory) { "Portable assets are unavailable" }
        return root
    }

    private fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    fun portableAssets(directory: String?): JSONObject {
        val result = JSONObject()
        if (directory == null) return result
        val root = requireBundleRoot(directory)
        root.listFiles()?.sortedBy { it.name }?.forEach { file ->
            if (!file.isFile) return@forEach
            val source = "assets/${file.name}"
            if (!media.validKey(source)) return@forEach
            val value = media.data(file)
            val (type, byteSize) = media.validateAssetMeta(value)
            require(media.assetMime(source) == type) { "Portable image extension does not match its type" }
            require(byteSize <= MAX_PORTABLE_ASSET_BYTES) { "Portable image exceeds 25 MB" }
            result.put(source, value)
        }
        return result
    }

    fun portableAssetPage(directory: String?, offset: Int, limit: Int): JSONObject {
        require(offset in 0..MAX_PORTABLE_ASSET_COUNT && limit in 1..50) { "Invalid asset page" }
        if (directory == null) return JSONObject().put("assets", JSONArray()).put("total", 0).put("nextOffset", JSONObject.NULL)
        val root = requireBundleRoot(directory)
        val files = root.listFiles()?.filter { it.isFile && media.validKey("assets/${it.name}") }?.sortedBy { it.name }.orEmpty()
        val page = JSONArray()
        files.drop(offset).take(limit).forEach { file ->
            val source = "assets/${file.name}"
            val digest = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input ->
                val buffer = ByteArray(8192)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    digest.update(buffer, 0, count)
                }
            }
            page.put(JSONObject().put("id", sha256Hex(source.toByteArray(Charsets.UTF_8)))
                .put("name", source).put("mimeType", media.assetMime(source)).put("bytes", file.length())
                .put("sha256", digest.digest().joinToString("") { "%02x".format(it) }))
        }
        val next = (offset + page.length()).takeIf { it < files.size }
        return JSONObject().put("assets", page).put("total", files.size).put("nextOffset", next ?: JSONObject.NULL)
    }

    fun portableAssetBytes(directory: String?, source: String, maxBytes: Int): Pair<String, ByteArray> {
        val file = media.local(source, directory) ?: error("Asset is not present in the current note")
        require(file.length() in 1..maxBytes.toLong()) { "Original asset retrieval is limited to ${maxBytes / 1_000_000} MB" }
        return media.assetMime(source) to file.readBytes()
    }

    fun resolvePortableAssetName(directory: String?, requested: String): String? {
        if (directory == null || !BUNDLE_DIR_REGEX.matches(directory)) return null
        val root = File(bundles, directory).canonicalFile
        if (root.parentFile != bundles.canonicalFile || !root.isDirectory) return null
        val simple = if (requested.startsWith("assets/")) requested.substringAfter('/') else requested
        val files = root.listFiles()?.filter { it.isFile && media.validKey("assets/${it.name}") }.orEmpty()
        files.firstOrNull { it.name == simple }?.let { return "assets/${it.name}" }
        return files.firstOrNull { sha256Hex("assets/${it.name}".toByteArray(Charsets.UTF_8)) == requested }?.let { "assets/${it.name}" }
    }

    fun openFmd(input: InputStream): MediaStorage.Opened {
        val directory = UUID.randomUUID().toString()
        val root = File(bundles, directory).apply { mkdirs() }
        try {
            var format = ""; var version = 0; var markdown: String? = null; var total = 0L; var assetCount = 0
            withBoundedPortableJsonReader(input) { reader ->
                reader.beginObject()
                while (reader.hasNext()) when (reader.nextName()) {
                    "format" -> format = reader.nextString()
                    "version" -> version = reader.nextInt()
                    "markdown" -> {
                        val source = reader.nextString()
                        require(source.toByteArray(Charsets.UTF_8).size <= MAX_PORTABLE_MARKDOWN_BYTES) { "FMD Markdown exceeds 20 MB" }
                        markdown = source
                    }
                    "assets" -> {
                        reader.beginObject()
                        while (reader.hasNext()) {
                            val source = reader.nextName()
                            require(media.validKey(source)) { "Invalid FMD asset name" }
                            require(++assetCount <= MAX_PORTABLE_ASSET_COUNT) { "FMD contains more than 512 images" }
                            val rawValue = reader.nextString()
                            val (type, bytes) = media.decodePortableImage(rawValue)
                            require(media.assetMime(source) == type) { "Image extension does not match its type" }
                            total += bytes.size
                            require(total <= MAX_PORTABLE_TOTAL_ASSET_BYTES) { "FMD assets exceed 75 MB" }
                            val targetFile = File(root, source.substringAfter('/'))
                            targetFile.writeBytes(bytes)
                            media.portableAssetExtractions.incrementAndGet()
                            val expectedLen = "data:$type;base64,".length + ((bytes.size + 2) / 3) * 4
                            val canonicalUrl = if (rawValue.length == expectedLen && media.lookupValidatedMeta(rawValue) != null) rawValue
                            else "data:$type;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
                            media.cacheWrittenLocalAsset(targetFile, type, bytes.size, canonicalUrl)
                        }
                        reader.endObject()
                    }
                    else -> error("Unknown portable-file field")
                }
                reader.endObject()
                require(reader.peek() == JsonToken.END_DOCUMENT) { "Unexpected data after the FMD envelope" }
            }
            require(format in PORTABLE_FORMATS && version == 1 && markdown != null) { "Unsupported portable SMD file" }
            return MediaStorage.Opened(markdown!!, directory)
        } catch (error: Exception) {
            media.invalidateLocalAsset(root)
            root.deleteRecursively()
            throw error
        }
    }

    fun writeFmd(output: OutputStream, markdown: String, assets: JSONObject, validatedAssets: JSONObject? = null) {
        require(markdown.toByteArray(Charsets.UTF_8).size <= MAX_PORTABLE_MARKDOWN_BYTES && assets.length() <= MAX_PORTABLE_ASSET_COUNT)
        var total = 0L
        assets.keys().forEach { source ->
            require(media.validKey(source)) { "Invalid FMD asset name" }
            val rawValue = assets.getString(source)
            val known = validatedAssets?.optString(source)?.takeIf { it.isNotEmpty() }
            val (type, byteSize) = media.validateAssetMeta(rawValue, known)
            require(media.assetMime(source) == type) { "Image extension does not match its type" }
            total += byteSize
            require(total <= MAX_PORTABLE_TOTAL_ASSET_BYTES) { "FMD assets exceed 75 MB" }
        }
        withBoundedPortableJsonWriter(output) { writer ->
            writer.beginObject().name("format").value("supermd-smd").name("version").value(1)
                .name("markdown").value(markdown).name("assets").beginObject()
            assets.keys().forEach { source -> writer.name(source).value(assets.getString(source)) }
            writer.endObject().endObject()
        }
    }

    fun portableEnvelopeMatches(input: InputStream, expectedMarkdown: String, expectedAssets: JSONObject): Boolean {
        var format = ""; var version = 0; var markdown: String? = null; var total = 0L; var assetCount = 0; var allAssetsMatched = true
        val seenSources = HashSet<String>()
        withBoundedPortableJsonReader(input) { reader ->
            reader.beginObject()
            while (reader.hasNext()) when (reader.nextName()) {
                "format" -> format = reader.nextString()
                "version" -> version = reader.nextInt()
                "markdown" -> {
                    val source = reader.nextString()
                    require(source.toByteArray(Charsets.UTF_8).size <= MAX_PORTABLE_MARKDOWN_BYTES) { "FMD Markdown exceeds 20 MB" }
                    markdown = source
                }
                "assets" -> {
                    reader.beginObject()
                    while (reader.hasNext()) {
                        val source = reader.nextName()
                        require(media.validKey(source)) { "Invalid FMD asset name" }
                        require((if (seenSources.add(source)) ++assetCount else assetCount) <= MAX_PORTABLE_ASSET_COUNT) { "FMD contains more than 512 images" }
                        val rawValue = reader.nextString()
                        val expectedValue = if (expectedAssets.has(source)) expectedAssets.getString(source) else null
                        if (expectedValue != null && rawValue == expectedValue) {
                            val (type, byteSize) = media.validateAssetMeta(rawValue, expectedValue)
                            require(media.assetMime(source) == type) { "Image extension does not match its type" }
                            total += byteSize
                            require(total <= MAX_PORTABLE_TOTAL_ASSET_BYTES) { "FMD assets exceed 75 MB" }
                        } else {
                            val (type, bytes) = media.decodePortableImage(rawValue)
                            require(media.assetMime(source) == type) { "Image extension does not match its type" }
                            total += bytes.size
                            require(total <= MAX_PORTABLE_TOTAL_ASSET_BYTES) { "FMD assets exceed 75 MB" }
                            val canonical = "data:$type;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
                            if (expectedValue == null || canonical != expectedValue) allAssetsMatched = false
                        }
                    }
                    reader.endObject()
                }
                else -> error("Unknown portable-file field")
            }
            reader.endObject()
            require(reader.peek() == JsonToken.END_DOCUMENT) { "Unexpected data after the FMD envelope" }
        }
        require(format in PORTABLE_FORMATS && version == 1 && markdown != null) { "Unsupported portable SMD file" }
        return markdown == expectedMarkdown && allAssetsMatched && seenSources.size == expectedAssets.length()
    }

    fun hasExactLocalPortableAssets(directory: String?, assets: JSONObject): Boolean {
        if (directory == null || !BUNDLE_DIR_REGEX.matches(directory)) return false
        val expectedBundlesRoot = runCatching {
            context.filesDir.canonicalFile.toPath().resolve(bundles.name).normalize().toFile()
        }.getOrNull() ?: return false
        val root = runCatching { File(bundles, directory).canonicalFile }.getOrNull() ?: return false
        val bundlesRoot = runCatching { bundles.canonicalFile }.getOrNull() ?: return false
        if (bundlesRoot != expectedBundlesRoot || root.parentFile != bundlesRoot || !root.isDirectory) return false
        val entries = root.listFiles() ?: return false
        if (entries.any { !it.isFile || !media.validKey("assets/${it.name}") } || entries.size != assets.length()) return false
        return entries.all { file ->
            val source = "assets/${file.name}"
            assets.has(source) && runCatching { media.data(file) }.getOrNull() == assets.getString(source)
        }
    }

    fun materializePortableDirectory(
        assets: JSONObject,
        reuseFromDirectory: String? = null,
        predecodedBytes: Map<String, Pair<String, ByteArray>> = emptyMap(),
    ): String {
        require(assets.length() <= MAX_PORTABLE_ASSET_COUNT) { "FMD contains more than 512 images" }
        val directory = UUID.randomUUID().toString()
        val root = File(bundles, directory).apply { mkdirs() }
        try {
            var total = 0L
            assets.keys().forEach { source ->
                require(media.validKey(source)) { "Invalid FMD asset name" }
                val rawValue = assets.getString(source)
                val destFile = File(root, source.substringAfter('/'))
                val reusableFile = if (reuseFromDirectory != null) media.local(source, reuseFromDirectory) else null
                val reusableData = reusableFile?.let { runCatching { media.data(it) }.getOrNull() }
                val predecoded = predecodedBytes[source]
                if (reusableFile != null && reusableData != null && reusableData == rawValue) {
                    val (type, byteSize) = media.validateAssetMeta(rawValue, reusableData)
                    require(media.assetMime(source) == type) { "Image extension does not match its type" }
                    total += byteSize; require(total <= MAX_PORTABLE_TOTAL_ASSET_BYTES) { "FMD assets exceed 75 MB" }
                    reusableFile.copyTo(destFile, overwrite = true)
                    media.cacheWrittenLocalAsset(destFile, type, byteSize, reusableData)
                } else if (predecoded != null) {
                    val (type, bytes) = predecoded
                    require(bytes.size <= MAX_PORTABLE_ASSET_BYTES) { "Image exceeds 25 MB" }
                    require(media.assetMime(source) == type) { "Image extension does not match its type" }
                    total += bytes.size; require(total <= MAX_PORTABLE_TOTAL_ASSET_BYTES) { "FMD assets exceed 75 MB" }
                    destFile.writeBytes(bytes)
                    media.portableAssetExtractions.incrementAndGet()
                    media.cacheWrittenLocalAsset(destFile, type, bytes.size, rawValue)
                } else {
                    val (type, bytes) = media.decodePortableImage(rawValue)
                    require(media.assetMime(source) == type) { "Image extension does not match its type" }
                    total += bytes.size; require(total <= MAX_PORTABLE_TOTAL_ASSET_BYTES) { "FMD assets exceed 75 MB" }
                    destFile.writeBytes(bytes)
                    media.portableAssetExtractions.incrementAndGet()
                    val canonicalUrl = "data:$type;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
                    media.cacheWrittenLocalAsset(destFile, type, bytes.size, canonicalUrl)
                }
            }
            return directory
        } catch (error: Exception) {
            media.invalidateLocalAsset(root)
            root.deleteRecursively()
            throw error
        }
    }

    fun portableMarkdown(input: InputStream, stopAfterMarkdown: Boolean = false, maxMarkdownBytes: Int = MAX_PORTABLE_MARKDOWN_BYTES): String {
        var format: String? = null; var version: Int? = null; var markdown: String? = null
        withBoundedPortableJsonReader(input) { reader ->
            reader.beginObject()
            while (reader.hasNext()) {
                when (reader.nextName()) {
                    "format" -> { format = reader.nextString(); require(!stopAfterMarkdown || format in PORTABLE_FORMATS) }
                    "version" -> { version = reader.nextInt(); require(!stopAfterMarkdown || version == 1) }
                    "markdown" -> { val source = reader.nextString(); require(source.toByteArray(Charsets.UTF_8).size <= maxMarkdownBytes); markdown = source }
                    else -> reader.skipValue()
                }
                if (stopAfterMarkdown && format in PORTABLE_FORMATS && version == 1 && markdown != null) return@withBoundedPortableJsonReader
            }
            reader.endObject()
            if (!stopAfterMarkdown) require(reader.peek() == JsonToken.END_DOCUMENT) { "Unexpected data after the portable envelope" }
        }
        if (stopAfterMarkdown) require(format in PORTABLE_FORMATS && version == 1)
        return markdown ?: error("Portable source is unavailable")
    }

    fun readSearchableNote(input: InputStream, maxPlainBytes: Int = 5_000_000, maxPortableMarkdownBytes: Int = MAX_PORTABLE_MARKDOWN_BYTES): String? {
        val initial = ByteArray(8_192)
        var initialLen = 0
        while (initialLen < initial.size) {
            val count = input.read(initial, initialLen, initial.size - initialLen)
            if (count <= 0) break
            initialLen += count
        }
        if (initialLen == 0) return ""
        val isGzip = initialLen >= 2 && initial[0] == 0x1f.toByte() && initial[1] == 0x8b.toByte()
        var nonWsIdx = if (initialLen >= 3 && initial[0] == 0xef.toByte() && initial[1] == 0xbb.toByte() && initial[2] == 0xbf.toByte()) 3 else 0
        val hasUtf8Bom = nonWsIdx == 3
        while (nonWsIdx < initialLen) {
            val b = initial[nonWsIdx].toInt() and 0xff
            if (b != 0x20 && b != 0x09 && b != 0x0a && b != 0x0d) break
            nonWsIdx++
        }
        val mightBeJson = !isGzip && (nonWsIdx >= initialLen || initial[nonWsIdx] == '{'.code.toByte())
        if (!isGzip && !mightBeJson) {
            for (i in 0 until initialLen) {
                if (initial[i] == 0.toByte()) return null
            }
            val nextByte = if (initialLen == initial.size) input.read() else -1
            if (nextByte < 0) {
                if (initialLen > maxPlainBytes) return null
                return runCatching {
                    val offset = if (hasUtf8Bom) 3 else 0
                    Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
                        .decode(ByteBuffer.wrap(initial, offset, initialLen - offset)).toString()
                }.getOrNull()
            }
            return runCatching {
                val out = ByteArrayOutputStream(minOf(maxPlainBytes, 32_768))
                out.write(initial, 0, initialLen)
                if (nextByte == 0) return null
                out.write(nextByte)
                require(out.size() <= maxPlainBytes)
                val buf = ByteArray(16_384)
                while (true) {
                    val count = input.read(buf)
                    if (count <= 0) break
                    for (i in 0 until count) {
                        if (buf[i] == 0.toByte()) return null
                    }
                    require(out.size() + count <= maxPlainBytes)
                    out.write(buf, 0, count)
                }
                val raw = out.toByteArray()
                val offset = if (hasUtf8Bom) 3 else 0
                Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(raw, offset, raw.size - offset)).toString()
            }.getOrNull()
        }

        val combined = SequenceInputStream(ByteArrayInputStream(initial, 0, initialLen), input)
        val buffered = BufferedInputStream(combined, 65_536)
        buffered.mark(65_536)
        val prefix = ByteArray(32_768)
        var prefixLen = 0
        while (prefixLen < prefix.size) {
            val count = buffered.read(prefix, prefixLen, prefix.size - prefixLen)
            if (count <= 0) break
            prefixLen += count
        }
        buffered.reset()
        val headBytes = prefix.copyOfRange(0, prefixLen)
        val headerPreview = if (!isGzip) runCatching { String(headBytes, Charsets.UTF_8).trimStart('\uFEFF', ' ', '\n', '\r', '\t') }.getOrDefault("") else ""
        if (isGzip || portableEnvelopeHeader(headerPreview)) {
            return runCatching { portableMarkdown(buffered, stopAfterMarkdown = true, maxMarkdownBytes = maxPortableMarkdownBytes) }.getOrNull()
        }
        if (headBytes.any { it == 0.toByte() }) return null
        return runCatching {
            val raw = readLimited(buffered, maxPlainBytes)
            if (raw.any { it == 0.toByte() }) return null
            Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(raw)).toString().removePrefix("\uFEFF")
        }.getOrNull()
    }

    fun writeLocalPortable(output: OutputStream, markdown: String, directory: String?) {
        val sources = JSONArray(markdownImageSourcesJson(markdown))
        val files = (0 until sources.length()).map { sources.getString(it) }.distinct().filter { it.startsWith("assets/") }
            .map { source -> source to (media.local(source, directory) ?: error("Save manually to resolve a new image: $source")) }
        require(files.size <= MAX_PORTABLE_ASSET_COUNT && files.sumOf { it.second.length() } <= MAX_PORTABLE_TOTAL_ASSET_BYTES && markdown.toByteArray(Charsets.UTF_8).size <= MAX_PORTABLE_MARKDOWN_BYTES)
        withBoundedPortableJsonWriter(output) { writer ->
            writer.beginObject().name("format").value("supermd-smd").name("version").value(1)
                .name("markdown").value(markdown).name("assets").beginObject()
            files.forEach { (source, file) -> writer.name(source).value(media.data(file)) }
            writer.endObject().endObject()
        }
    }
}
