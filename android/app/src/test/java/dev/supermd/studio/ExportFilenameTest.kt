package dev.supermd.studio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ExportFilenameTest {
    @Test fun preservesUnicodeEmojiSpacesAndOrdinaryPunctuationForEveryFormat() {
        val stem = "Ångström 📚 — lesson [draft] + 50%"
        assertEquals("$stem.pdf", ExportFilename.suggestedName(stem, NativeExportFormat.PDF))
        assertEquals("$stem.md", ExportFilename.suggestedName(stem, NativeExportFormat.MARKDOWN))
        assertEquals("$stem.smd", ExportFilename.suggestedName(stem, NativeExportFormat.PORTABLE_SMD))
    }

    @Test fun replacesOnlyUnsafeCharactersAndNeverCreatesAPath() {
        val actual = ExportFilename.suggestedName("../A\\B: C?\u0000🙂.smd", NativeExportFormat.PDF)
        assertEquals("..-A-B- C-🙂.pdf", actual)
        assertFalse(actual.contains('/'))
        assertFalse(actual.contains('\\'))
        assertFalse(actual.any { Character.isISOControl(it) })
    }

    @Test fun stripsRepeatedKnownSuffixesAndAddsExactlyOneExpectedSuffix() {
        assertEquals("Study v2.pdf", ExportFilename.suggestedName("Study v2.MD.pdf.smd", NativeExportFormat.PDF))
        assertEquals("Study v2.md", ExportFilename.suggestedName("Study v2.SMD", NativeExportFormat.MARKDOWN))
        assertEquals("Study v2.pdf", ExportFilename.suggestedName("Study v2.fmd", NativeExportFormat.PDF))
        assertEquals("Study v2.smd", ExportFilename.suggestedName("Study v2.markdown.txt", NativeExportFormat.PORTABLE_SMD))
        assertEquals("Note.smd", ExportFilename.suggestedName("...", NativeExportFormat.PORTABLE_SMD))
        assertTrue(ExportFilename.suffixMatches("Ångström 📚.PDF", NativeExportFormat.PDF))
        assertFalse(ExportFilename.suffixMatches("Ångström 📚.smd", NativeExportFormat.PDF))
    }

    @Test fun boundsLongUnicodeNamesByCodePointsAndUtf8BytesWithoutSplittingSurrogates() {
        val name = ExportFilename.suggestedName("🙂".repeat(200), NativeExportFormat.MARKDOWN)
        val stem = name.removeSuffix(".md")
        assertTrue(stem.codePointCount(0, stem.length) <= 120)
        assertTrue(stem.toByteArray(Charsets.UTF_8).size <= 240)
        assertEquals(60, stem.codePointCount(0, stem.length))
        assertFalse(stem.last().isHighSurrogate())
    }

    @Test fun acceptsGenericProviderMimeButRejectsKnownMismatches() {
        assertTrue(ExportFilename.mimeMatches("application/octet-stream", NativeExportFormat.PDF))
        assertTrue(ExportFilename.mimeMatches(null, NativeExportFormat.PORTABLE_SMD))
        assertTrue(ExportFilename.mimeMatches("text/plain", NativeExportFormat.MARKDOWN))
        assertFalse(ExportFilename.mimeMatches("text/markdown", NativeExportFormat.PDF))
        assertFalse(ExportFilename.mimeMatches("application/pdf", NativeExportFormat.PORTABLE_SMD))
    }

    @Test fun validatesNativeFileHeadersForPdfAndPortableSmd() {
        assertTrue(ExportFilename.hasExpectedHeader("%PDF-1.7".toByteArray(), NativeExportFormat.PDF))
        assertFalse(ExportFilename.hasExpectedHeader("{\"format\":\"supermd-fmd\"}".toByteArray(), NativeExportFormat.PORTABLE_SMD))
        assertTrue(ExportFilename.hasExpectedHeader("{\"format\":\"supermd-smd\",\"version\":1}".toByteArray(), NativeExportFormat.PORTABLE_SMD))
        assertTrue(ExportFilename.hasExpectedHeader(byteArrayOf(0x1f.toByte(), 0x8b.toByte()), NativeExportFormat.PORTABLE_SMD))
    }
}
