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
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.URL
import java.util.UUID
import java.util.zip.Deflater
import java.util.zip.GZIPOutputStream

/** Attachments live outside Markdown and recovery snapshots. FMD is the shareable envelope. */
class MediaStorage(private val context: Context) {
    private val attachments = File(context.filesDir, "attachments").apply { mkdirs() }
    private val bundles = File(context.filesDir, "portable-assets").apply { mkdirs() }

    fun createEmptyPortableDirectory(): String {
        val id = UUID.randomUUID().toString()
        check(File(bundles, id).mkdirs()) { "Could not prepare the portable note's local asset directory" }
        return id
    }
    private val key = Regex("assets/[a-zA-Z0-9_.-]{1,150}")
    private fun gzip(output: java.io.OutputStream) = object : GZIPOutputStream(output, 8192) {
        init { def.setLevel(Deflater.BEST_COMPRESSION) }
    }
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

    /** Canonical image data URL for a relay-supplied portable asset. */
    fun portableImageData(type: String, bytes: ByteArray): String {
        val mime = type.substringBefore(';').lowercase()
        require(mime in setOf("image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/svg+xml")) { "Unsupported image type" }
        require(bytes.size in 1..1_048_576) { "Relay supplied assets are limited to 1 MiB" }
        requireMediaSignature(mime, bytes)
        return "data:$mime;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
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
            val (type, bytes) = decode(value)
            require(mime(source) == type) { "Portable image extension does not match its type" }
            require(bytes.size <= 25_000_000) { "Portable image exceeds 25 MB" }
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
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: error("Android could not create a Downloads entry")
        try {
            resolver.openOutputStream(uri, "w")?.use { it.write(bytes); it.flush() }
                ?: error("Android could not write the Downloads entry")
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                resolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
            }
        } catch (error: Exception) { runCatching { resolver.delete(uri, null, null) }; throw error }
        return JSONObject().put("filename", name).put("bytes", bytes.size).put("mimeType", mime).put("uri", uri.toString())
    }

    /** Create a new document in the configured SAF folder or the app's Downloads collection. */
    fun writeAgentDocument(filename: String, mimeType: String, configuredLocation: String?, writer: (Uri, java.io.OutputStream) -> Unit): Pair<Uri, String> {
        require(filename.isNotBlank() && filename.length <= 240 && filename == filename.substringAfterLast('/').substringAfterLast('\\') &&
            !filename.contains(Regex("[\\u0000-\\u001f\\u007f]"))) { "Invalid save-as filename" }
        val mime = mimeType.substringBefore(';').lowercase()
        require(mime in setOf("text/markdown", "application/vnd.supermd.smd", "application/pdf")) { "Unsupported document format" }
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
            "image/svg+xml" -> require(String(bytes, 0, minOf(bytes.size, 4096), Charsets.UTF_8).contains(Regex("<svg(?:\\s|>)", RegexOption.IGNORE_CASE))) { "SVG document is invalid" }
            "text/plain" -> require(bytes.none { it == 0.toByte() }) { "Text media contains binary data" }
        }
    }
    fun local(source: String, directory: String?): File? {
        if (!validKey(source)) return null
        if (directory != null && Regex("[a-f0-9-]{36}").matches(directory)) containedFile(bundles, File(bundles, "$directory/${source.substringAfter('/')}")).let { if (it != null) return it }
        if (source.startsWith("assets/import-")) return containedFile(attachments, File(attachments, source.substringAfter('/')))
        return null
    }

    internal fun readerAsset(file: File): ReaderAssetSource {
        val canonical = file.canonicalFile
        require(canonical.isFile) { "Image not found" }
        require(canonical.length() <= BoundedAssetInputStream.MAX_READER_ASSET_BYTES) { "Image exceeds 25 MB" }
        val mime = imageMime(canonical.name, null)
        val open = { canonical.inputStream() }
        return ReaderAssetSource(mime, readerAssetFingerprint(canonical.path, canonical.length(), canonical.lastModified(), open), canonical.length(), open)
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
                        val (type, bytes) = decode(reader.nextString()); require(mime(source) == type) { "Image extension does not match its type" }; total += bytes.size; require(total <= 75_000_000) { "FMD assets exceed 75 MB" }
                        File(root, source.substringAfter('/')).writeBytes(bytes)
                    }; reader.endObject() }
                    else -> error("Unknown portable-file field")
                }
                reader.endObject(); require(reader.peek() == android.util.JsonToken.END_DOCUMENT) { "Unexpected data after the FMD envelope" }
            }
            require(format in listOf("supermd-smd", "supermd-fmd") && version == 1 && markdown != null) { "Unsupported portable SMD file" }
            return Opened(markdown!!, directory)
        } catch (error: Exception) { root.deleteRecursively(); throw error }
    }
    fun writeFmd(output: java.io.OutputStream, markdown: String, assets: JSONObject) {
        require(markdown.toByteArray().size <= 20_000_000 && assets.length() <= 512)
        // Validate everything before the destination stream is written.
        var total = 0L
        assets.keys().forEach { source -> require(validKey(source)); val (type, bytes) = decode(assets.getString(source)); require(mime(source) == type) { "Image extension does not match its type" }; total += bytes.size; require(total <= 75_000_000) }
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
        JsonWriter(boundedJson.writer()).use { writer ->
            writer.beginObject().name("format").value("supermd-smd").name("version").value(1).name("markdown").value(markdown).name("assets").beginObject()
            assets.keys().forEach { source -> writer.name(source).value(assets.getString(source)) }
            writer.endObject().endObject()
        }
    }
    fun portableMarkdown(input: InputStream): String {
        // Our envelope puts source before assets. Never load image bytes merely
        // to check whether a portable note's source changed externally.
        val sniff=if(input.markSupported())input else BufferedInputStream(input)
        sniff.mark(2);val gzip=sniff.read()==0x1f&&sniff.read()==0x8b;sniff.reset()
        val content=if(gzip)StrictGzipInputStream(sniff) else sniff
        val bounded=object:java.io.FilterInputStream(content){var consumed=0L;override fun read():Int {val value=super.read();if(value>=0)require(++consumed<=120_000_000);return value};override fun read(buffer:ByteArray,offset:Int,length:Int):Int {val size=super.read(buffer,offset,length);if(size>0){consumed+=size;require(consumed<=120_000_000)};return size}}
        val limitedText=object:java.io.FilterReader(bounded.reader()){var quoted=false;var escaped=false;var tokenLength=0;override fun read(buffer:CharArray,offset:Int,size:Int):Int{val count=super.read(buffer,offset,size);for(i in offset until offset+maxOf(count,0)){val c=buffer[i];if(quoted){require(++tokenLength<=34_000_000){"Portable token is too large"};if(escaped)escaped=false else if(c=='\\')escaped=true else if(c=='\"')quoted=false}else if(c=='\"'){quoted=true;tokenLength=0}};return count}}
        var markdown:String?=null
        JsonReader(limitedText.buffered()).use {reader->
            reader.beginObject()
            while(reader.hasNext()){val name=reader.nextName();if(name=="markdown"){val source=reader.nextString();require(source.toByteArray().size<=20_000_000);markdown=source}else reader.skipValue()}
            reader.endObject()
            require(reader.peek()==android.util.JsonToken.END_DOCUMENT) { "Unexpected data after the portable envelope" }
        }
        return markdown ?: error("Portable source is unavailable")
    }
    fun writeLocalPortable(output: java.io.OutputStream, markdown: String, directory: String?) {
        val sources=JSONArray(PdfEngine.imageSources(markdown))
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
