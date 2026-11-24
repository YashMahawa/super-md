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
import java.io.StringReader
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.util.UUID
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import javax.xml.parsers.DocumentBuilderFactory
import org.w3c.dom.Element
import org.xml.sax.ErrorHandler
import org.xml.sax.InputSource
import org.xml.sax.SAXParseException

private val forbiddenSvgElements = setOf("script", "foreignobject", "iframe", "object", "embed")
private val allowedSvgHref = Regex("^(?:#|data:image/)", RegexOption.IGNORE_CASE)
private val externalSvgUrl = Regex("url\\(\\s*['\"]?(?:https?:|//|file:|javascript:)", RegexOption.IGNORE_CASE)
private val externalSvgStyle = Regex("url\\(\\s*['\"]?(?:https?:|//|file:|javascript:)|@import", RegexOption.IGNORE_CASE)
private val svgEntityDecl = Regex("<!ENTITY\\b", RegexOption.IGNORE_CASE)

internal fun requireSafeSvg(bytes: ByteArray) {
    val source = try {
        Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes))
            .toString()
    } catch (_: CharacterCodingException) {
        throw IllegalArgumentException("This SVG is not valid UTF-8")
    }
    require(!svgEntityDecl.containsMatchIn(source)) { "SVG XML entities are not allowed" }
    val document = try {
        val factory = DocumentBuilderFactory.newInstance().apply {
            isNamespaceAware = true
            isExpandEntityReferences = false
            isValidating = false
            runCatching { setFeature("http://javax.xml.XMLConstants/feature/secure-processing", true) }
            runCatching { setFeature("http://xml.org/sax/features/external-general-entities", false) }
            runCatching { setFeature("http://xml.org/sax/features/external-parameter-entities", false) }
            runCatching { setFeature("http://apache.org/xml/features/nonvalidating/load-external-dtd", false) }
        }
        val builder = factory.newDocumentBuilder().apply {
            setEntityResolver { _, _ -> InputSource(StringReader("")) }
            setErrorHandler(object : ErrorHandler {
                override fun warning(exception: SAXParseException) = Unit
                override fun error(exception: SAXParseException) { throw exception }
                override fun fatalError(exception: SAXParseException) { throw exception }
            })
        }
        builder.parse(InputSource(StringReader(source)))
    } catch (error: Exception) {
        throw IllegalArgumentException("This SVG is not valid XML", error)
    }
    val root = document.documentElement ?: throw IllegalArgumentException("This SVG is not valid XML")
    val rootName = (root.localName ?: root.tagName.substringAfter(':')).lowercase()
    require(rootName == "svg") { "This SVG is not valid XML" }
    val stack = ArrayDeque<Element>().apply { add(root) }
    while (stack.isNotEmpty()) {
        val element = stack.removeLast()
        val tag = (element.localName ?: element.tagName.substringAfter(':')).lowercase()
        require(tag !in forbiddenSvgElements) { "SVG must be a self-contained image, without scripts or embedded HTML" }
        val attributes = element.attributes
        for (i in 0 until attributes.length) {
            val attr = attributes.item(i)
            val fullName = attr.nodeName
            val local = (attr.localName ?: fullName.substringAfter(':')).lowercase()
            val value = attr.nodeValue.orEmpty().trim()
            require(!fullName.startsWith("on", ignoreCase = true) && !local.startsWith("on")) { "SVG event handlers are not allowed" }
            if ((fullName.equals("href", ignoreCase = true) || fullName.equals("xlink:href", ignoreCase = true) ||
                    (local == "href" && !fullName.startsWith("xmlns", ignoreCase = true))) && !allowedSvgHref.containsMatchIn(value)
            ) {
                throw IllegalArgumentException("External SVG resources must be embedded first")
            }
            require(!externalSvgUrl.containsMatchIn(value)) { "External SVG resources must be embedded first" }
        }
        if (tag == "style") {
            require(!externalSvgStyle.containsMatchIn(element.textContent.orEmpty())) { "External SVG styles are not allowed" }
        }
        val children = element.childNodes
        for (i in children.length - 1 downTo 0) {
            val child = children.item(i)
            if (child is Element) stack.add(child)
        }
    }
}

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
                media.requirePortableImage(mime, bytes)
                if (mime == "image/svg+xml") requireSafeSvg(bytes)
                val extension = path.substringAfterLast('.').lowercase()
                require(extension in when(mime) {
                    "image/png" -> setOf("png"); "image/jpeg" -> setOf("jpg", "jpeg"); "image/gif" -> setOf("gif")
                    "image/webp" -> setOf("webp"); "image/avif" -> setOf("avif"); "image/svg+xml" -> setOf("svg"); else -> emptySet()
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
        return if (!configuredFolder.isNullOrBlank()) saveTree(Uri.parse(configuredFolder))
        else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) saveDownloads()
        else error("Choose an export folder in Settings before saving Markdown with assets")
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
