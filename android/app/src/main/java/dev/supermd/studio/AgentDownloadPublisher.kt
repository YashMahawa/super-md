package dev.supermd.studio

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.util.Base64
import androidx.documentfile.provider.DocumentFile
import org.json.JSONObject
import java.io.OutputStream

/** Publishes agent media and exported documents to a configured SAF tree folder or MediaStore.Downloads. */
internal class AgentDownloadPublisher(private val context: Context) {
    fun saveAgentMedia(args: JSONObject, configuredLocation: String?): JSONObject {
        val encoded = args.getString("body")
        require(encoded.length <= 34_000_000) { "Media export exceeds 25 MB" }
        val bytes = Base64.decode(encoded, Base64.DEFAULT)
        require(bytes.size in 1..25_000_000) { "Media export must be at most 25 MB" }
        val mime = args.getString("mimeType").substringBefore(';').trim().lowercase()
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
        val (uri, savedName) = publishToConfiguredFolderOrDownloads(
            requestedName = "$stem.$extension",
            mime = mime,
            configuredLocation = configuredLocation,
            preQErrorMessage = "Choose a folder in Settings → New note location before saving media on this Android version",
        ) { _, output -> output.write(bytes); output.flush() }
        return JSONObject().put("filename", savedName).put("bytes", bytes.size).put("mimeType", mime).put("uri", uri.toString())
    }

    fun writeAgentDocument(
        filename: String,
        mimeType: String,
        configuredLocation: String?,
        writer: (Uri, OutputStream) -> Unit,
    ): Pair<Uri, String> {
        require(filename.isNotBlank() && filename.length <= 240 && filename == filename.substringAfterLast('/').substringAfterLast('\\') &&
            !filename.contains(Regex("[\\u0000-\\u001f\\u007f]"))) { "Invalid save-as filename" }
        val mime = mimeType.substringBefore(';').trim().lowercase()
        require(mime in SUPPORTED_DOCUMENT_MIMES) { "Unsupported document format" }
        return publishToConfiguredFolderOrDownloads(
            requestedName = filename,
            mime = mime,
            configuredLocation = configuredLocation,
            preQErrorMessage = "Choose a folder in Settings → New note location before saving to Downloads on this Android version",
            writer = writer,
        )
    }

    fun deleteAgentDocument(uri: Uri) {
        if (uri.authority == MediaStore.AUTHORITY) context.contentResolver.delete(uri, null, null)
        else DocumentFile.fromSingleUri(context, uri)?.delete()
    }

    private fun publishToConfiguredFolderOrDownloads(
        requestedName: String,
        mime: String,
        configuredLocation: String?,
        preQErrorMessage: String,
        writer: (Uri, OutputStream) -> Unit,
    ): Pair<Uri, String> {
        val folder = configuredLocation?.takeIf(String::isNotBlank)?.let(Uri::parse)
        if (folder != null) {
            require(DocumentsContract.isTreeUri(folder)) { "The configured note location is not a folder; choose it again in Super MD settings" }
            val parent = DocumentFile.fromTreeUri(context, folder)
                ?: error("Open the configured folder again to restore access")
            val name = uniqueName(requestedName) { parent.findFile(it) != null }
            val file = parent.createFile(mime, name) ?: error("The configured folder cannot create files")
            try {
                context.contentResolver.openOutputStream(file.uri, "w")?.use { writer(file.uri, it) }
                    ?: error("The configured folder cannot write files")
            } catch (error: Exception) {
                runCatching { file.delete() }
                throw error
            }
            return file.uri to (file.name ?: name)
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) error(preQErrorMessage)
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
            resolver.openOutputStream(uri, "w")?.use { writer(uri, it) }
                ?: error("Android could not write the Downloads entry")
            val published = ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }
            require(resolver.update(uri, published, null, null) > 0) { "Android could not publish the Downloads entry" }
        } catch (error: Exception) {
            runCatching { resolver.delete(uri, null, null) }
            throw error
        }
        return uri to name
    }

    private fun uniqueName(requested: String, exists: (String) -> Boolean): String {
        val dot = requested.lastIndexOf('.')
        val hasExtension = dot > 0 && dot < requested.lastIndex
        val stem = if (hasExtension) requested.substring(0, dot) else requested
        val suffix = if (hasExtension) requested.substring(dot) else ""
        var index = 1
        var candidate = requested
        while (exists(candidate)) { index++; candidate = "$stem ($index)$suffix" }
        return candidate
    }

    private companion object {
        val SUPPORTED_DOCUMENT_MIMES = setOf("text/markdown", "application/vnd.supermd.smd", "application/pdf", "application/zip")
    }
}
