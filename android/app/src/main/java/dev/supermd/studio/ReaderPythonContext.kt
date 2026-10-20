package dev.supermd.studio

import org.json.JSONObject
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.LinkedHashMap

/** Validated identity supplied by the bundled reader for a Python cell. */
internal object ReaderPythonContext {
    /** Kept in sync with the Chaquopy version configured in android/app/build.gradle.kts. */
    const val EMBEDDED_INTERPRETER = "python-3.13"

    /** Missing context is the explicitly supported legacy protocol. */
    fun from(args: JSONObject, openDocumentIdsAndPaths: Set<String>): PythonOutputStore.Context? {
        if (!args.has("context")) return null
        val raw = args.optJSONObject("context") ?: throw IllegalArgumentException("Invalid Python output context")
        require(raw.length() == 3 && raw.has("document") && raw.has("cell") && raw.has("interpreter")) {
            "Invalid Python output context"
        }
        val document = raw.optString("document").takeIf { raw.opt("document") is String }
            ?: throw IllegalArgumentException("Invalid Python output context: document")
        val cell = raw.optString("cell").takeIf { raw.opt("cell") is String }
            ?: throw IllegalArgumentException("Invalid Python output context: cell")
        val interpreter = raw.optString("interpreter").takeIf { raw.opt("interpreter") is String }
            ?: throw IllegalArgumentException("Invalid Python output context: interpreter")
        require(document in openDocumentIdsAndPaths) { "Python output does not belong to an open document" }
        require(interpreter == "embedded" || interpreter == EMBEDDED_INTERPRETER) {
            "Python output interpreter does not match this runtime"
        }
        // The reader uses the portable `embedded` token when no interpreter is
        // configured. Store against the concrete runtime so provenance is exact.
        return PythonOutputStore.Context(document, cell, EMBEDDED_INTERPRETER)
    }

    /** Keep only the native Python payload fields; provenance is never part of its identity. */
    fun resultPayload(result: JSONObject): JSONObject = JSONObject()
        .put("ok", result.getBoolean("ok"))
        .put("stdout", result.getString("stdout"))
        .put("stderr", result.getString("stderr"))
        .put("images", org.json.JSONArray().apply {
            val images=result.getJSONArray("images")
            for(index in 0 until images.length())put(images.getString(index))
        })

    fun sameResult(first: JSONObject, second: JSONObject): Boolean = try {
        val a = resultPayload(first)
        val b = resultPayload(second)
        a.getBoolean("ok") == b.getBoolean("ok") && a.getString("stdout") == b.getString("stdout") &&
            a.getString("stderr") == b.getString("stderr") && a.getJSONArray("images").let { images ->
                val other=b.getJSONArray("images")
                images.length()==other.length() && (0 until images.length()).all {images.getString(it)==other.getString(it)}
            }
    } catch (_: Exception) { false }

    /** Compact proof for retries without retaining up to tens of MB of figures per run. */
    fun resultDigest(result: JSONObject): String {
        val digest = MessageDigest.getInstance("SHA-256")
        fun field(value: String) {
            val bytes = value.toByteArray(Charsets.UTF_8)
            digest.update(ByteBuffer.allocate(Int.SIZE_BYTES).putInt(bytes.size).array())
            digest.update(bytes)
        }
        field(if (result.getBoolean("ok")) "1" else "0")
        field(result.getString("stdout"))
        field(result.getString("stderr"))
        val images = result.getJSONArray("images")
        digest.update(ByteBuffer.allocate(Int.SIZE_BYTES).putInt(images.length()).array())
        for (index in 0 until images.length()) field(images.getString(index))
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    /** Converts the store's wrapper into the flattened reader-facing reply. */
    fun flattenStoredOutput(wrapper: JSONObject?): JSONObject? {
        if (wrapper == null) return null
        val result = JSONObject(wrapper.getJSONObject("result").toString())
        result.put("provenance", JSONObject(wrapper.getJSONObject("provenance").toString()))
        return result
    }
}

/** In-memory proof that an unsaved result was emitted by this native reader run. */
internal class ReaderPythonOutputPending(private val maxEntries: Int = 4) {
    private data class Key(val source: String, val context: PythonOutputStore.Context)
    private val results = LinkedHashMap<Key, String>(8, .75f, true)

    init { require(maxEntries > 0) }

    @Synchronized fun remember(source: String, context: PythonOutputStore.Context, result: JSONObject) {
        results[Key(source, context)] = ReaderPythonContext.resultDigest(result)
        while (results.size > maxEntries) results.remove(results.entries.iterator().next().key)
    }

    @Synchronized fun matches(source: String, context: PythonOutputStore.Context, result: JSONObject): Boolean =
        results[Key(source, context)]?.let { it == ReaderPythonContext.resultDigest(result) } == true

    @Synchronized fun clear(source: String, context: PythonOutputStore.Context) { results.remove(Key(source, context)) }
}
