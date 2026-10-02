package dev.supermd.studio

import android.content.Context
import android.net.Uri
import android.util.Base64
import android.util.AtomicFile
import androidx.documentfile.provider.DocumentFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

/** Private font files, never base64 in note source or recovery snapshots. */
class FontLibrary(private val context: Context) {
    private val directory = File(context.filesDir, "fonts").apply { mkdirs() }
    private val index = File(directory, "index.json")
    private fun records(): List<Pair<File, List<String>>> = runCatching {
        val data = JSONArray(index.readText())
        (0 until minOf(data.length(), 32)).mapNotNull { i ->
            val record = data.getJSONObject(i); val filename = record.getString("file")
            if (!Regex("[0-9a-f]{64}\\.(ttf|otf)").matches(filename)) return@mapNotNull null
            val file = File(directory, filename)
            if (!file.isFile || file.length() !in 1..20_000_000) return@mapNotNull null
            val names = record.getJSONArray("families")
            file to (0 until names.length()).map { names.getString(it) }.filter { it.length in 1..120 }
        }
    }.getOrDefault(emptyList())
    val families get() = records().flatMap { it.second }.distinct().sorted()
    fun import(uri: Uri): String = synchronized(lock) {
        val name = DocumentFile.fromSingleUri(context, uri)?.name ?: "Font.ttf"
        val extension = name.substringAfterLast('.').lowercase()
        require(extension in listOf("ttf", "otf")) { "Choose a TTF or OTF font under 20 MB" }
        val bytes = context.contentResolver.openInputStream(uri)?.use { readLimited(it, 20_000_000) } ?: error("Cannot read this font")
        require(bytes.isNotEmpty()) { "This font is empty" }
        val hash = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        val file = File(directory, "$hash.$extension")
        val entries = records()
        val existing = entries.find { it.first == file }
        if (existing != null) return@synchronized existing.second.first()
        require(entries.size < 32 && entries.sumOf { it.first.length() } + bytes.size <= 64_000_000) { "Font library limit: 32 files or 64 MB" }
        file.outputStream().use { it.write(bytes); it.fd.sync() }
        val names = JSONArray(PdfEngine.fontFamilies(file.absolutePath))
        if (names.length() == 0) { file.delete(); error("This file could not be read as a font") }
        val family = names.getString(0)
        val data = JSONArray().apply { entries.forEach { put(JSONObject().put("file", it.first.name).put("families", JSONArray(it.second))) }; put(JSONObject().put("file", file.name).put("families", names)) }
        val atomic = AtomicFile(index); val stream = atomic.startWrite()
        try { stream.write(data.toString().toByteArray()); atomic.finishWrite(stream) } catch (error: Exception) { atomic.failWrite(stream); throw error }
        family
    }
    fun reader(family: String): JSONObject {
        val file = records().find { family in it.second }?.first ?: error("Imported font is unavailable")
        return JSONObject().put("family", family).put("data", "data:font/ttf;base64," + Base64.encodeToString(file.readBytes(), Base64.NO_WRAP))
    }
    fun addPdfFonts(family: String, assets: File) { records().filter { family in it.second }.forEach { it.first.copyTo(File(assets,"__font_${it.first.name}"), overwrite = false) } }
    companion object { private val lock = Any() }
}
