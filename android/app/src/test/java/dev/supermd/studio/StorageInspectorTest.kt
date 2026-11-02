package dev.supermd.studio

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StorageInspectorTest {
    @Test fun reportsFixedAppOwnedCategoriesAndSeparatesLegacyPythonCache() {
        val files = Files.createTempDirectory("storage-inspector-files").toFile()
        val cache = Files.createTempDirectory("storage-inspector-cache").toFile()
        try {
            File(files, "workspace.json").writeBytes(ByteArray(11))
            File(files, "deleted-drafts").apply { mkdirs(); File(this, "draft.bin").writeBytes(ByteArray(13)) }
            File(files, "closed-notes").apply { mkdirs(); File(this, "snapshot.bin").writeBytes(ByteArray(17)) }
            File(files, "reader-conflicts").apply { mkdirs(); File(this, "conflict.json").writeBytes(ByteArray(19)) }
            File(files, "derived-python").apply { mkdirs(); File(this, "result.json").writeBytes(ByteArray(23)) }
            File(cache, "derived-python").apply { mkdirs(); File(this, "legacy.json").writeBytes(ByteArray(29)) }
            File(cache, "temporary.bin").writeBytes(ByteArray(31))

            val report = StorageInspector.inspect(files, cache)
            val durable = report.retained.associateBy { it.label }

            assertEquals(11L, durable.getValue("Workspace and window recovery").bytes)
            assertEquals(13L, durable.getValue("Deleted-draft recovery").bytes)
            assertEquals(17L, durable.getValue("Closed-note recovery").bytes)
            assertEquals(19L, durable.getValue("Reader conflict drafts").bytes)
            assertEquals(23L, report.executionResults.bytes)
            assertTrue(report.executionResults.files == 1)
            assertTrue(report.legacyExecutionResults.label.contains("preserved by Super MD; Android may clear cache"))
            assertEquals(29L, report.legacyExecutionResults.bytes)
            assertEquals(31L, report.otherCache.bytes)
            assertFalse(report.partial)
            assertTrue((report.retained + report.legacyExecutionResults + report.otherCache).all {
                !it.label.contains(files.absolutePath) && !it.label.contains(cache.absolutePath)
            })
        } finally {
            files.deleteRecursively()
            cache.deleteRecursively()
        }
    }

    @Test fun cleanupClearsOnlyGeneratedPythonResultFolders() {
        val files = Files.createTempDirectory("storage-cleanup-files").toFile()
        val cache = Files.createTempDirectory("storage-cleanup-cache").toFile()
        try {
            File(files, "derived-python/nested").apply { mkdirs(); File(this, "result.png").writeBytes(ByteArray(7)) }
            File(cache, "derived-python").apply { mkdirs(); File(this, "old.json").writeBytes(ByteArray(11)) }
            File(files, "closed-notes").apply { mkdirs(); File(this, "draft.md").writeText("keep") }
            File(files, "updates").apply { mkdirs(); File(this, "verified.apk").writeBytes(ByteArray(3)) }
            val cleaned = StorageInspector.clearPythonResults(files, cache)
            assertEquals(2, cleaned)
            assertFalse(File(files, "derived-python").exists())
            assertFalse(File(cache, "derived-python").exists())
            assertEquals("keep", File(files, "closed-notes/draft.md").readText())
            assertTrue(File(files, "updates/verified.apk").exists())
        } finally {
            files.deleteRecursively()
            cache.deleteRecursively()
        }
    }

    @Test fun cleanupRejectsLinkedResultsWithoutTouchingExternalFiles() {
        val files = Files.createTempDirectory("storage-links-files").toFile()
        val cache = Files.createTempDirectory("storage-links-cache").toFile()
        val outside = Files.createTempDirectory("storage-links-outside").toFile()
        try {
            File(outside, "important.txt").writeText("keep")
            Files.createSymbolicLink(File(files, "derived-python").toPath(), outside.toPath())
            val rejected = runCatching { StorageInspector.clearPythonResults(files, cache) }
            assertTrue(rejected.isFailure)
            assertEquals("keep", File(outside, "important.txt").readText())
        } finally {
            files.deleteRecursively()
            cache.deleteRecursively()
            outside.deleteRecursively()
        }
    }

    @Test fun skipsSymlinksAndMarksBoundedOrUnreadableScansPartial() {
        val files = Files.createTempDirectory("storage-inspector-symlinks").toFile()
        val cache = Files.createTempDirectory("storage-inspector-empty-cache").toFile()
        val outside = Files.createTempDirectory("storage-inspector-outside").toFile()
        try {
            File(outside, "secret.bin").writeBytes(ByteArray(101))
            val link = File(files, "reader-conflicts")
            Files.createSymbolicLink(link.toPath(), outside.toPath())

            val report = StorageInspector.inspect(files, cache)

            val conflicts = report.retained.first { it.label == "Reader conflict drafts" }
            assertEquals(0L, conflicts.bytes)
            assertEquals(0, conflicts.files)
            assertEquals(1, conflicts.skippedEntries)
            assertTrue(report.partial)
        } finally {
            Files.deleteIfExists(File(files, "reader-conflicts").toPath())
            files.deleteRecursively()
            cache.deleteRecursively()
            outside.deleteRecursively()
        }
    }
}
