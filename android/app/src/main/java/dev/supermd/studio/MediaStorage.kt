package dev.supermd.studio

import android.content.Context
import android.net.Uri
import android.util.Base64
import android.util.JsonReader
import android.util.JsonWriter
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.URL
import java.util.UUID

/** Attachments live outside Markdown and recovery snapshots. FMD is the shareable envelope. */
class MediaStorage(private val context: Context) {
    private val attachments = File(context.filesDir, "attachments").apply { mkdirs() }
    private val bundles = File(context.filesDir, "portable-assets").apply { mkdirs() }
    private val key = Regex("assets/[a-zA-Z0-9_.-]{1,150}")
    fun validKey(source: String) = key.matches(source) && source.substringAfter('/') !in listOf(".", "..")
    private fun mime(name: String) = when(name.substringAfterLast('.').lowercase()) {
        "png" -> "image/png"; "jpg", "jpeg" -> "image/jpeg"; "gif" -> "image/gif"; "webp" -> "image/webp"; "avif" -> "image/avif"; "svg" -> "image/svg+xml"; else -> error("Choose a supported image (PNG, JPEG, GIF, WebP, AVIF or SVG)")
    }
    private fun decode(data: String): Pair<String, ByteArray> {
        require(data.length <= 34_000_000) { "Image exceeds 25 MB" }
        val header = data.substringBefore(',')
        require(header.matches(Regex("data:image/(png|jpeg|gif|webp|avif|svg\\+xml);base64"))) { "Unsupported image data" }
        val bytes = Base64.decode(data.substringAfter(','), Base64.DEFAULT)
        require(bytes.size <= 25_000_000) { "Image exceeds 25 MB" }
        return header.removePrefix("data:").removeSuffix(";base64") to bytes
    }
    fun data(file: File): String { require(file.length() <= 25_000_000); return "data:${mime(file.name)};base64," + Base64.encodeToString(file.readBytes(), Base64.NO_WRAP) }
    private fun store(name: String, type: String, bytes: ByteArray): JSONObject {
        val extension = when(type.substringBefore(';')) { "image/png" -> "png"; "image/jpeg" -> "jpg"; "image/gif" -> "gif"; "image/webp" -> "webp"; "image/avif" -> "avif"; "image/svg+xml" -> "svg"; else -> error("Unsupported image type") }
        require(bytes.size <= 25_000_000)
        val file = File(attachments, "import-${UUID.randomUUID()}.$extension")
        file.outputStream().use { it.write(bytes); it.fd.sync() }
        return JSONObject().put("source", "assets/${file.name}").put("alt", name.substringBeforeLast('.').take(160))
    }
    fun importJson(images: JSONArray): JSONArray {
        require(images.length() in 1..32)
        var total = 0L; val result = JSONArray()
        for (i in 0 until images.length()) { val image = images.getJSONObject(i); val (type, bytes) = decode(image.getString("data")); total += bytes.size; require(total <= 75_000_000) { "Insert at most 75 MB at a time" }; result.put(store(image.optString("name", "Image"), type, bytes)) }
        return result
    }
    fun importUris(uris: List<Uri>): JSONArray {
        require(uris.size in 1..32)
        var total = 0L; val result = JSONArray()
        for (uri in uris) {
            val name = androidx.documentfile.provider.DocumentFile.fromSingleUri(context, uri)?.name ?: "Image"
            val type = context.contentResolver.getType(uri)?.takeIf { it.startsWith("image/") } ?: mime(name)
            val bytes = context.contentResolver.openInputStream(uri)?.use { readLimited(it, 25_000_000) } ?: error("Image permission is unavailable")
            total += bytes.size; require(total <= 75_000_000) { "Insert at most 75 MB at a time" }
            result.put(store(name, type, bytes))
        }
        return result
    }
    fun local(source: String, directory: String?): File? {
        if (!validKey(source)) return null
        if (directory != null && Regex("[a-f0-9-]{36}").matches(directory)) File(bundles, "$directory/${source.substringAfter('/')}").takeIf { it.isFile }?.let { return it }
        if (source.startsWith("assets/import-")) return File(attachments, source.substringAfter('/')).takeIf { it.isFile }
        return null
    }
    data class Opened(val markdown: String, val directory: String)
    fun openFmd(input: InputStream): Opened {
        val directory = UUID.randomUUID().toString(); val root = File(bundles, directory).apply { mkdirs() }
        try {
            var format = ""; var version = 0; var markdown: String? = null; var total = 0L; var count = 0
            val bounded = object : java.io.FilterInputStream(input) {
                var count = 0L
                override fun read(): Int { val value = super.read(); if (value >= 0) require(++count <= 120_000_000) { "FMD exceeds 120 MB" }; return value }
                override fun read(buffer: ByteArray, offset: Int, length: Int): Int { val size = super.read(buffer, offset, length); if (size > 0) { count += size; require(count <= 120_000_000) { "FMD exceeds 120 MB" } }; return size }
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
                    "markdown" -> { markdown = reader.nextString(); require(markdown!!.toByteArray().size <= 20_000_000) }
                    "assets" -> { reader.beginObject(); while(reader.hasNext()) {
                        val source = reader.nextName(); require(validKey(source)); require(++count <= 512)
                        val (type, bytes) = decode(reader.nextString()); require(mime(source) == type) { "Image extension does not match its type" }; total += bytes.size; require(total <= 75_000_000)
                        File(root, source.substringAfter('/')).writeBytes(bytes)
                    }; reader.endObject() }
                    else -> error("Unknown portable-file field")
                }
                reader.endObject(); require(reader.peek() == android.util.JsonToken.END_DOCUMENT)
            }
            require(format == "supermd-fmd" && version == 1 && markdown != null) { "Unsupported FMD file" }
            return Opened(markdown!!, directory)
        } catch (error: Exception) { root.deleteRecursively(); throw error }
    }
    fun writeFmd(output: java.io.OutputStream, markdown: String, assets: JSONObject) {
        require(markdown.toByteArray().size <= 20_000_000 && assets.length() <= 512)
        // Validate everything before the destination stream is written.
        var total = 0L
        assets.keys().forEach { source -> require(validKey(source)); val (type, bytes) = decode(assets.getString(source)); require(mime(source) == type) { "Image extension does not match its type" }; total += bytes.size; require(total <= 75_000_000) }
        JsonWriter(output.writer()).use { writer ->
            writer.beginObject().name("format").value("supermd-fmd").name("version").value(1).name("markdown").value(markdown).name("assets").beginObject()
            assets.keys().forEach { source -> writer.name(source).value(assets.getString(source)) }
            writer.endObject().endObject()
        }
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
