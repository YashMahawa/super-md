package dev.supermd.studio

import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.junit.Test

@RunWith(RobolectricTestRunner::class)
class PythonOutputStoreTest {
    private fun context(document: String = "doc-a", cell: String = "cell-1", interpreter: String = "python-3.13") =
        PythonOutputStore.Context(document, cell, interpreter)

    private fun result(output: String) = JSONObject().put("ok", true).put("stdout", output)
        .put("stderr", "").put("images", JSONArray())

    private fun temporaryStore(block: (File, PythonOutputStore) -> Unit) {
        val root = Files.createTempDirectory("python-output-test").toFile()
        try { block(root, PythonOutputStore(root)) } finally { root.deleteRecursively() }
    }

    private fun temporaryRoots(block: (File, File) -> Unit) {
        val primary = Files.createTempDirectory("python-output-primary").toFile()
        val oldCache = Files.createTempDirectory("python-output-cache").toFile()
        try { block(primary, oldCache) } finally { primary.deleteRecursively(); oldCache.deleteRecursively() }
    }

    @Test fun scopedResultsStaySeparateAndPersistWithNativeProvenance() = temporaryStore { root, store ->
        val source = "print('same')"
        val contexts = listOf(context(), context(document = "doc-b"), context(cell = "cell-2"), context(interpreter = "python-3.12"))
        contexts.forEachIndexed { index, ctx ->
            val untrusted = result("result-$index").put("provenance", JSONObject().put("verified", true).put("document", "forged"))
            store.store(source, untrusted, ctx)
        }
        assertEquals(contexts.size, root.listFiles()!!.size)
        contexts.forEachIndexed { index, ctx ->
            val loaded = PythonOutputStore(root).load(source, ctx)!!
            assertEquals("result-$index", loaded.getJSONObject("result").getString("stdout"))
            val provenance = loaded.getJSONObject("provenance")
            assertTrue(provenance.getBoolean("verified"))
            assertEquals(ctx.document, provenance.getString("document"))
            assertEquals(ctx.cell, provenance.getString("cell"))
            assertEquals(ctx.interpreter, provenance.getString("interpreter"))
            assertTrue(provenance.getString("savedAt").endsWith("Z"))
        }
    }

    @Test fun scopedMissWarnsAndPreservesLegacyResult() = temporaryStore { root, store ->
        val source = "old source"
        val legacy = result("legacy")
        store.store(source, legacy)
        val legacyPath = File(root, MessageDigest.getInstance("SHA-256").digest(source.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) } + ".json")
        val contents = legacyPath.readBytes()
        val loaded = store.load(source, context())!!
        assertEquals("legacy", loaded.getJSONObject("result").getString("stdout"))
        val provenance = loaded.getJSONObject("provenance")
        assertFalse(provenance.getBoolean("verified"))
        assertEquals("Legacy saved output; document and runtime were not recorded", provenance.getString("reason"))
        assertArrayEquals(contents, legacyPath.readBytes())
        assertEquals(1, root.listFiles()!!.size)
        assertEquals("legacy", PythonOutputStore(root).load(source)!!.getString("stdout"))
    }

    @Test fun malformedContextIsRejectedAndFailedAtomicPromotionKeepsTarget() = temporaryStore { root, store ->
        val source = "stable"
        val good = context()
        val badContexts = listOf(
            PythonOutputStore.Context("", "cell", "python"),
            PythonOutputStore.Context("doc", "x".repeat(513), "python"),
        )
        badContexts.forEach { bad ->
            try { store.load(source, bad); fail("Expected invalid context rejection") }
            catch (_: IllegalArgumentException) { }
        }
        val scopedIdentity = java.io.ByteArrayOutputStream().also { bytes ->
            java.io.DataOutputStream(bytes).use { out ->
                listOf(source, good.document, good.cell, good.interpreter).forEach { value ->
                    val encoded = value.toByteArray(Charsets.UTF_8); out.writeInt(encoded.size); out.write(encoded)
                }
            }
        }.toByteArray()
        val scopedName = MessageDigest.getInstance("SHA-256").digest(scopedIdentity).joinToString("") { "%02x".format(it) } + ".json"
        val blocker = File(root, scopedName)
        assertTrue(blocker.mkdir())
        try { store.store(source, result("after"), good); fail("Expected atomic promotion failure") }
        catch (_: IllegalStateException) { }
        assertTrue(blocker.isDirectory)
        assertTrue("Temporary staging file should be cleaned", root.listFiles()!!.contentEquals(arrayOf(blocker)))
    }

    @Test fun durableRootReceivesNewWritesAndFallsBackToLegacyCacheWithoutModifyingIt() = temporaryRoots { primary, oldCache ->
        val source = "print('durable')"
        val ctx = context(document = "old-note")
        val oldStore = PythonOutputStore(oldCache)
        oldStore.store(source, result("scoped old"), ctx)
        val oldFilesBefore = oldCache.listFiles()!!.map { it.name }.toSet()

        val durableStore = PythonOutputStore(primary, oldCache)
        val recovered = durableStore.load(source, ctx)!!
        assertEquals("scoped old", recovered.getJSONObject("result").getString("stdout"))
        assertTrue(recovered.getJSONObject("provenance").getBoolean("verified"))
        assertEquals(oldFilesBefore, oldCache.listFiles()!!.map { it.name }.toSet())

        durableStore.store("new source", result("new output"), ctx)
        assertEquals(1, primary.listFiles()!!.size)
        assertEquals(oldFilesBefore, oldCache.listFiles()!!.map { it.name }.toSet())
        assertEquals("new output", durableStore.load("new source", ctx)!!.getJSONObject("result").getString("stdout"))
    }

    @Test fun durableStoreReadsLegacySourceOnlyCacheAsUnverifiedWithoutMigrationOrDeletion() = temporaryRoots { primary, oldCache ->
        val source = "old unscoped source"
        PythonOutputStore(oldCache).store(source, result("old output"))
        val filesBefore = oldCache.listFiles()!!.map { it.name }.toSet()

        val loaded = PythonOutputStore(primary, oldCache).load(source, context())!!
        assertEquals("old output", loaded.getJSONObject("result").getString("stdout"))
        assertFalse(loaded.getJSONObject("provenance").getBoolean("verified"))
        assertEquals(filesBefore, oldCache.listFiles()!!.map { it.name }.toSet())
        assertTrue(primary.listFiles().isNullOrEmpty())
    }
}
