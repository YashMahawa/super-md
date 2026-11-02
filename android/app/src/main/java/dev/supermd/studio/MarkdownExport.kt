package dev.supermd.studio

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.documentfile.provider.DocumentFile
import org.json.JSONObject
import java.io.File
import java.io.OutputStream
import java.util.UUID
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

internal fun markdownAssetPath(raw: String): String {
    val path = Uri.decode(raw)
    require(path.length in 1..512 && !path.startsWith('/') && !path.contains('\\') &&
        path.split('/').all { it.isNotBlank() && it !in listOf(".", "..") && !it.endsWith('.') && !it.endsWith(' ') &&
            !Regex("^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\\.|$)", RegexOption.IGNORE_CASE).containsMatchIn(it) && !it.any { c -> c.code < 32 || c in ":<>\"|?*" } }) { "Invalid Markdown asset path" }
    return path
}

/** Staged, bounded export files. The source document and its attachments are never modified. */
internal class MarkdownExport(private val context: Context, val filename: String, content: String, assets: JSONObject) : AutoCloseable {
    val directory = File(context.cacheDir, "markdown-export/${UUID.randomUUID()}").apply { check(mkdirs()) }
    val markdown: File
    val files = linkedMapOf<String, Pair<File, String>>()
    init {
        try {
            require(filename == filename.substringAfterLast('/').substringAfterLast('\\') && filename.endsWith(".md") && filename.length <= 240) { "Invalid Markdown filename" }
            require(content.length <= 20_000_000 && assets.length() <= 512) { "Markdown export is too large" }
            val media = MediaStorage(context)
            markdown = File(directory, filename).apply { bufferedWriter(Charsets.UTF_8).use { it.write(content) } }
            var total = markdown.length()
            val names = mutableSetOf(filename.lowercase())
            for (raw in assets.keys()) {
                val path = markdownAssetPath(raw)
                require(names.add(path.lowercase())) { "Conflicting Markdown asset names" }
                val (mime, bytes) = media.decodePortableImage(assets.getString(raw))
                val extension = path.substringAfterLast('.').lowercase()
                require(extension in when(mime) {
                    "image/png" -> setOf("png"); "image/jpeg" -> setOf("jpg", "jpeg"); "image/gif" -> setOf("gif")
                    "image/webp" -> setOf("webp"); "image/avif" -> setOf("avif"); else -> emptySet()
                }) { "Markdown image filename does not match its type" }
                total += bytes.size
                require(total <= 128L * 1024 * 1024) { "Markdown and assets exceed 128 MiB" }
                val file = File(directory, path)
                check(file.parentFile!!.mkdirs() || file.parentFile!!.isDirectory)
                file.outputStream().use { it.write(bytes) }
                files[path] = file to mime
            }
        } catch (error: Exception) { directory.deleteRecursively(); throw error }
    }
    fun writeZip(output: OutputStream) {
        ZipOutputStream(output).use { zip ->
            for ((name, file) in listOf(filename to markdown) + files.map { it.key to it.value.first }) {
                zip.putNextEntry(ZipEntry(name))
                file.inputStream().use { it.copyTo(zip) }
                zip.closeEntry()
            }
        }
    }
    fun save(configuredFolder: String?, archive: Boolean): Pair<Uri, String> {
        val media = MediaStorage(context)
        if (archive) return media.writeAgentDocument(filename.removeSuffix(".md") + ".zip", "application/zip", configuredFolder) { _, output -> writeZip(output) }
        if (files.isEmpty()) return media.writeAgentDocument(filename, "text/markdown", configuredFolder) { _, output -> markdown.inputStream().use { it.copyTo(output) } }
        return if (!configuredFolder.isNullOrBlank()) saveTree(Uri.parse(configuredFolder)) else saveDownloads()
    }
    private fun saveTree(tree: Uri): Pair<Uri, String> {
        val parent = DocumentFile.fromTreeUri(context, tree) ?: error("Choose the export folder again to restore access")
        val stem = filename.removeSuffix(".md")
        var name = stem
        var index = 2
        while (parent.findFile(name) != null) { name = "$stem (${index++})"; require(index < 10000) }
        val folder = parent.createDirectory(name) ?: error("The selected folder cannot create exports")
        try {
            var result: Uri? = null
            // Publish the Markdown only after all of its companion images exist.
            for ((path, item) in files + mapOf(filename to (markdown to "text/markdown"))) {
                var target = folder
                val parts = path.split('/')
                for (part in parts.dropLast(1)) {
                    target = target.findFile(part)?.also { require(it.isDirectory) } ?: target.createDirectory(part) ?: error("Cannot create asset folder")
                }
                val document = target.createFile(item.second, parts.last()) ?: error("Cannot create export file")
                require(document.name == parts.last()) { "The provider changed an asset filename; use ZIP instead" }
                context.contentResolver.openOutputStream(document.uri, "w")?.use { out -> item.first.inputStream().use { it.copyTo(out) } } ?: error("Cannot write export file")
                if (path == filename) result = document.uri
            }
            return requireNotNull(result) to filename
        } catch (error: Exception) { runCatching { folder.delete() }; throw error }
    }
    @androidx.annotation.RequiresApi(29)
    private fun saveDownloads(): Pair<Uri, String> {
        require(Build.VERSION.SDK_INT >= 29) { "Choose an export folder in Settings before saving Markdown with assets" }
        val resolver = context.contentResolver
        // A private export subfolder prevents collisions with existing user assets.
        val root = "${Environment.DIRECTORY_DOWNLOADS}/Super MD/${filename.removeSuffix(".md")} (${UUID.randomUUID().toString().take(8)})"
        val created = mutableListOf<Uri>()
        try {
            var result: Uri? = null
            for ((path, item) in files + mapOf(filename to (markdown to "text/markdown"))) {
                val relative = "$root/" + path.substringBeforeLast('/', "").let { if(it.isBlank()) "" else "$it/" }
                val name = path.substringAfterLast('/')
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, name); put(MediaStore.Downloads.MIME_TYPE, item.second)
                    put(MediaStore.Downloads.RELATIVE_PATH, relative); put(MediaStore.Downloads.IS_PENDING, 1)
                }
                val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: error("Cannot create Downloads export")
                created += uri
                resolver.openOutputStream(uri, "w")?.use { out -> item.first.inputStream().use { it.copyTo(out) } } ?: error("Cannot write Downloads export")
                resolver.query(uri, arrayOf(MediaStore.Downloads.DISPLAY_NAME), null, null, null)?.use { cursor ->
                    require(cursor.moveToFirst() && cursor.getString(0) == name) { "Android changed an asset filename; use ZIP instead" }
                } ?: error("Cannot verify export filenames")
                if (path == filename) result = uri
            }
            for (uri in created) require(resolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null) > 0) { "Cannot publish Downloads export" }
            return requireNotNull(result) to filename
        } catch (error: Exception) { created.forEach { runCatching { resolver.delete(it, null, null) } }; throw error }
    }
    override fun close() { directory.deleteRecursively() }
}
