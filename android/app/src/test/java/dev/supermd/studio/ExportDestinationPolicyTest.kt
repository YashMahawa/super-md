package dev.supermd.studio

import org.junit.Assert.*
import org.junit.Test

class ExportDestinationPolicyTest {
    @Test fun freshTargetUsesProviderConfirmedRename() {
        val calls = mutableListOf<String>()
        val actual = ExportDestinationPolicy.validate(ExportDocumentMetadata("Ångström 📚.md", "application/pdf"), NativeExportFormat.PDF, true) { requested ->
            calls += requested
            ExportDocumentMetadata(requested, "application/pdf")
        }
        assertEquals(listOf("Ångström 📚.pdf"), calls)
        assertEquals(ExportDocumentMetadata("Ångström 📚.pdf", "application/pdf"), actual)
    }

    @Test fun existingWrongSuffixAndMatchingSuffixWrongMimeAreRejectedWithoutRename() {
        for ((metadata, format) in listOf(
            ExportDocumentMetadata("existing.smd", "application/vnd.supermd.smd") to NativeExportFormat.PDF,
            ExportDocumentMetadata("report.pdf", "application/vnd.supermd.smd") to NativeExportFormat.PDF,
        )) {
            var renameCalled = false
            assertTrue(runCatching {
                ExportDestinationPolicy.validate(metadata, format, allowRename = false) { renameCalled = true; null }
            }.isFailure)
            assertFalse(renameCalled)
        }
    }

    @Test fun missingNameNeedsSpecificMatchingMimeAndSmdAllowsJsonProviders() {
        val metadata = ExportDocumentMetadata(null, "application/vnd.supermd.smd")
        assertEquals(metadata, ExportDestinationPolicy.validate(metadata, NativeExportFormat.PORTABLE_SMD, true) { error("unexpected rename") })
        assertTrue(ExportDestinationPolicy.validate(ExportDocumentMetadata("note.smd", "application/json"), NativeExportFormat.PORTABLE_SMD, false) { error("unexpected rename") }.displayName == "note.smd")
        assertTrue(ExportFilename.mimeMatches("text/plain", NativeExportFormat.PORTABLE_SMD))
        assertTrue(runCatching {
            ExportDestinationPolicy.validate(ExportDocumentMetadata(null, "application/json"), NativeExportFormat.PORTABLE_SMD, true) { error("unexpected rename") }
        }.isFailure)
        assertTrue(runCatching {
            ExportDestinationPolicy.validate(ExportDocumentMetadata(null, "application/octet-stream"), NativeExportFormat.PDF, true) { error("unexpected rename") }
        }.isFailure)
    }

    @Test fun renameFailureOrProviderKeepingWrongSuffixRejectsBeforeCallerCanWrite() {
        for (rename: (String) -> ExportDocumentMetadata? in listOf(
            { _: String -> null },
            { _: String -> ExportDocumentMetadata("report.md", "application/pdf") },
        )) {
            var calls = 0
            assertTrue(runCatching {
                ExportDestinationPolicy.validate(ExportDocumentMetadata("report.md", "text/markdown"), NativeExportFormat.PDF, true) { requested ->
                    calls++
                    assertEquals("report.pdf", requested)
                    rename(requested)
                }
            }.isFailure)
            assertEquals(1, calls)
        }
    }
}
