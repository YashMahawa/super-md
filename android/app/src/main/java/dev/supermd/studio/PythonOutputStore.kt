package dev.supermd.studio

import android.util.JsonWriter
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.io.File
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import org.json.JSONArray
import org.json.JSONObject

/** Document/cell-scoped derived figures on disk; this store never executes code. */
internal class PythonOutputStore(private val root: File, private val legacyRoot: File? = null) {
    internal data class Context(val document: String, val cell: String, val interpreter: String)

    private fun validateContext(context: Context) {
        require(context.document.isNotEmpty() && context.document.length <= 2048 && context.document.none { it.code < 32 }) { "Invalid Python output context: document" }
        require(context.cell.isNotEmpty() && context.cell.length <= 512 && context.cell.none { it.code < 32 }) { "Invalid Python output context: cell" }
        require(context.interpreter.isNotEmpty() && context.interpreter.length <= 256 && context.interpreter.none { it.code < 32 }) { "Invalid Python output context: interpreter" }
    }

    private fun digest(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private fun sourceDigest(source: String): String {
        require(source.length <= 2_000_000) { "Python source is too large" }
        return digest(source.toByteArray(Charsets.UTF_8))
    }

    private fun pathAt(directory: File, source: String): File = File(directory, "${sourceDigest(source)}.json")
    private fun path(source: String): File = pathAt(root, source)

    private fun scopedPathAt(directory: File, source: String, context: Context): File {
        validateContext(context)
        // Length-prefix each UTF-8 value so arbitrary context text cannot create
        // ambiguous concatenations (for example, values containing separators).
        val bytes = ByteArrayOutputStream()
        DataOutputStream(bytes).use { out ->
            listOf(source, context.document, context.cell, context.interpreter).forEach { value ->
                val encoded = value.toByteArray(Charsets.UTF_8)
                out.writeInt(encoded.size)
                out.write(encoded)
            }
        }
        return File(directory, "${digest(bytes.toByteArray())}.json")
    }

    private fun scopedPath(source: String, context: Context): File = scopedPathAt(root, source, context)

    private fun payload(result: JSONObject): JSONObject {
        val keys = result.keys().asSequence().toSet()
        require(keys == setOf("stdout", "stderr", "images", "ok") || keys == setOf("stdout", "stderr", "images", "ok", "provenance")) { "Invalid Python output" }
        require(result.opt("ok") is Boolean) { "Invalid Python output" }
        require(result.opt("stdout") is String && result.getString("stdout").length <= 2_000_000 &&
            result.opt("stderr") is String && result.getString("stderr").length <= 2_000_000) { "Python text output is too large" }
        val images = result.opt("images") as? JSONArray ?: throw IllegalArgumentException("Invalid Python output")
        require(images.length() <= 20) { "Too many Python figures" }
        var characters = 0L
        for (i in 0 until images.length()) {
            val image = images.opt(i) as? String ?: throw IllegalArgumentException("Invalid Python image")
            require(image.matches(Regex("data:image/(png|jpeg|svg\\+xml);base64,[A-Za-z0-9+/=\\r\\n]*"))) { "Invalid Python image" }
            characters += image.length
        }
        require(characters <= 100_000_000) { "Python figures exceed 75 MB" }
        return JSONObject().put("stdout", result.getString("stdout")).put("stderr", result.getString("stderr"))
            .put("images", JSONArray(images.toString())).put("ok", result.getBoolean("ok"))
    }

    private fun savedAt(): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT).apply {
        timeZone = TimeZone.getTimeZone("UTC")
    }.format(Date())

    @Synchronized fun store(source: String, result: JSONObject, context: Context? = null) {
        val cleanResult = payload(result)
        val legacyTarget = path(source)
        val target: File
        if (context == null) {
            target = legacyTarget
        } else {
            val scoped = scopedPath(source, context)
            target = scoped
        }
        root.mkdirs()
        val staged = File.createTempFile(target.name, ".tmp", root)
        try {
            staged.outputStream().use { stream ->
                val writer = JsonWriter(stream.bufferedWriter())
                if (context == null) {
                    writeResult(writer, cleanResult)
                } else {
                    writer.beginObject().name("schemaVersion").value(2).name("sourceDigest").value(sourceDigest(source))
                        .name("context"); writeContext(writer, context)
                    writer.name("savedAt").value(savedAt()).name("result")
                    writeResult(writer, cleanResult)
                    writer.endObject()
                }
                writer.flush()
                stream.fd.sync()
            }
            check(staged.renameTo(target)) { "Could not preserve Python output" }
        } finally { staged.delete() }
    }

    private fun writeContext(writer: JsonWriter, context: Context) {
        writer.beginObject().name("document").value(context.document).name("cell").value(context.cell)
            .name("interpreter").value(context.interpreter).endObject()
    }

    private fun writeResult(writer: JsonWriter, result: JSONObject) {
        val images = result.getJSONArray("images")
        writer.beginObject().name("ok").value(result.getBoolean("ok"))
            .name("stdout").value(result.getString("stdout")).name("stderr").value(result.getString("stderr")).name("images").beginArray()
        for (i in 0 until images.length()) writer.value(images.getString(i))
        writer.endArray().endObject()
    }

    @Synchronized fun load(source: String, context: Context? = null): JSONObject? {
        if (context == null) {
            val candidates = listOfNotNull(path(source), legacyRoot?.let { pathAt(it, source) })
            val file = candidates.firstOrNull { it.isFile } ?: return null
            require(file.length() <= 110_000_000) { "Cached Python output is too large" }
            return JSONObject(file.readText())
        }

        val scopedCandidates = listOfNotNull(scopedPath(source, context), legacyRoot?.let { scopedPathAt(it, source, context) })
        val scopedFile = scopedCandidates.firstOrNull { it.isFile }
        if (scopedFile != null) {
            require(scopedFile.length() <= 110_000_000) { "Cached Python output is too large" }
            val envelope = JSONObject(scopedFile.readText())
            require(envelope.optInt("schemaVersion", -1) == 2 && envelope.optString("sourceDigest") == sourceDigest(source) &&
                envelope.optJSONObject("context")?.let { stored ->
                    stored.keys().asSequence().toSet() == setOf("document", "cell", "interpreter") &&
                        stored.optString("document") == context.document && stored.optString("cell") == context.cell &&
                        stored.optString("interpreter") == context.interpreter
                } == true &&
                envelope.opt("savedAt") is String) { "Invalid scoped Python output" }
            return JSONObject().put("result", payload(envelope.getJSONObject("result")))
                .put("provenance", JSONObject().put("verified", true).put("document", context.document)
                    .put("cell", context.cell).put("interpreter", context.interpreter).put("savedAt", envelope.getString("savedAt")))
        }

        val legacyCandidates = listOfNotNull(path(source), legacyRoot?.let { pathAt(it, source) })
        val legacyFile = legacyCandidates.firstOrNull { it.isFile } ?: return null
        require(legacyFile.length() <= 110_000_000) { "Cached Python output is too large" }
        return JSONObject().put("result", payload(JSONObject(legacyFile.readText())))
            .put("provenance", JSONObject().put("verified", false)
                .put("reason", "Legacy saved output; document and runtime were not recorded"))
    }
}
