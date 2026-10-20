package dev.supermd.studio

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.junit.Test

@RunWith(RobolectricTestRunner::class)
class ReaderPythonContextTest {
    private val openDocuments = setOf("note-id", "content://provider/note.md")

    private fun args(document: String = "note-id", interpreter: String = ReaderPythonContext.EMBEDDED_INTERPRETER) =
        JSONObject().put("context", JSONObject().put("document", document).put("cell", "cell-1").put("interpreter", interpreter))

    @Test fun acceptsOnlyAnOpenNoteAndNormalizesTheEmbeddedInterpreter() {
        val byId = ReaderPythonContext.from(args(), openDocuments)!!
        assertEquals("note-id", byId.document)
        assertEquals("cell-1", byId.cell)
        assertEquals("python-3.13", byId.interpreter)

        assertEquals("content://provider/note.md", ReaderPythonContext.from(args("content://provider/note.md"), openDocuments)!!.document)
        assertEquals(ReaderPythonContext.EMBEDDED_INTERPRETER,
            ReaderPythonContext.from(args(interpreter = "embedded"), openDocuments)!!.interpreter)
        for (invalid in listOf(args("closed-note"), args(interpreter = "python-3.12"))) {
            try { ReaderPythonContext.from(invalid, openDocuments); fail("Expected contextual identity rejection") }
            catch (_: IllegalArgumentException) { }
        }
    }

    @Test fun unverifiedLegacyOutputCannotBePromotedToContextualCache() {
        val pending = ReaderPythonOutputPending()
        val context = PythonOutputStore.Context("note-id", "cell-1", ReaderPythonContext.EMBEDDED_INTERPRETER)
        val result = JSONObject().put("ok", false).put("stdout", "partial").put("stderr", "runtime error").put("images", JSONArray())
        pending.remember("source", context, result)

        assertTrue(pending.matches("source", context, result.put("provenance", JSONObject().put("verified", false).put("unsaved", true))))
        assertFalse(pending.matches("different source", context, result))
        assertFalse(pending.matches("source", context.copy(document = "other-note"), result))
        assertFalse(pending.matches("source", context, JSONObject().put("ok", true).put("stdout", "partial").put("stderr", "runtime error").put("images", JSONArray())))
        pending.clear("source", context)
        assertFalse(pending.matches("source", context, result))
        val forged = ReaderPythonOutputPending()
        assertFalse(forged.matches("source", context,
            result.put("provenance", JSONObject().put("verified", false).put("unsaved", true))))
    }

    @Test fun pendingNativeRunProofIsBoundedAndProvenanceDoesNotChangeTheResultDigest() {
        val pending = ReaderPythonOutputPending(maxEntries = 1)
        val first = PythonOutputStore.Context("note-id", "cell-1", ReaderPythonContext.EMBEDDED_INTERPRETER)
        val second = first.copy(cell = "cell-2")
        val result = JSONObject().put("ok", true).put("stdout", "figure").put("stderr", "")
            .put("images", JSONArray().put("data:image/png;base64,AQ=="))

        pending.remember("source-1", first, result)
        assertTrue(pending.matches("source-1", first, JSONObject(result.toString())
            .put("provenance", JSONObject().put("verified", false).put("unsaved", true))))
        pending.remember("source-2", second, result)
        assertFalse(pending.matches("source-1", first, result))
        assertTrue(pending.matches("source-2", second, result))
    }

    @Test fun absentContextKeepsLegacyModeButMalformedContextIsRejected() {
        assertNull(ReaderPythonContext.from(JSONObject().put("source", "code"), openDocuments))
        val malformed = JSONObject().put("context", JSONObject().put("document", "note-id").put("cell", "cell-1"))
        try { ReaderPythonContext.from(malformed, openDocuments); fail("Expected malformed context rejection") }
        catch (_: IllegalArgumentException) { }
    }

    @Test fun scopedStoreWrapperFlattensResultAndKeepsNativeProvenance() {
        val wrapper = JSONObject()
            .put("result", JSONObject().put("ok", false).put("stdout", "").put("stderr", "failed").put("images", JSONArray()))
            .put("provenance", JSONObject().put("verified", true).put("document", "note-id"))
        val flattened = ReaderPythonContext.flattenStoredOutput(wrapper)!!
        assertFalse(flattened.getBoolean("ok"))
        assertEquals("failed", flattened.getString("stderr"))
        assertTrue(flattened.getJSONObject("provenance").getBoolean("verified"))
        assertNull(ReaderPythonContext.flattenStoredOutput(null))
    }
}
