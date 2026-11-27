package dev.supermd.studio
import org.junit.Assert.*
import org.junit.Test
class PortableDetectionTest {
    @Test fun acceptsPortableHeadersRegardlessOfProviderFilename() {
        for(kind in listOf("smd","fmd")) assertTrue(portableEnvelopeHeader("\uFEFF \n {\"format\": \"supermd-$kind\",\"version\":1,\"markdown\":\"# Note\",\"assets\":{}}"))
        assertFalse(portableEnvelopeHeader("# Plain Markdown"))
        assertFalse(portableEnvelopeHeader("{\"format\":\"csv\"}"))
        assertFalse(portableEnvelopeHeader("Examples:\n{\"format\":\"supermd-smd\"}"))
    }
    @Test fun recognizesGzipRegardlessOfFilenameAndStrictlyDecodesOneMember() {
        val output = java.io.ByteArrayOutputStream()
        java.util.zip.GZIPOutputStream(output).use { it.write("portable-json-v1".toByteArray()) }
        val gzip = output.toByteArray()
        assertTrue(portableGzipHeader(gzip.copyOf(2)))
        assertFalse(portableGzipHeader("{\"format\"}".toByteArray()))
        assertEquals("portable-json-v1", StrictGzipInputStream(gzip.inputStream()).readBytes().toString(Charsets.UTF_8))
        assertThrows(java.io.IOException::class.java) { StrictGzipInputStream(gzip.copyOf(gzip.size - 2).inputStream()).readBytes() }
        assertThrows(java.io.IOException::class.java) { StrictGzipInputStream((gzip + gzip).inputStream()).readBytes() }
        assertThrows(java.io.IOException::class.java) { StrictGzipInputStream(gzip.inputStream(), 4).readBytes() }
    }
    @Test fun enforces150CapForNewAssetNamesAnd159CompatRangeForExistingKeys() {
        val maxNew = "${"a".repeat(146)}.svg"
        val compatMin = "${"a".repeat(147)}.svg"
        val compatMax = "${"a".repeat(155)}.svg"
        val overCap = "${"a".repeat(156)}.svg"

        assertTrue(isValidPortableAssetFilename(maxNew))
        assertTrue(isValidPortableAssetKey("assets/$maxNew"))
        assertTrue(isValidPortableAssetNameOrKey(maxNew))
        assertTrue(isValidPortableAssetNameOrKey("assets/$maxNew"))

        for (compat in listOf(compatMin, compatMax)) {
            assertFalse(isValidPortableAssetFilename(compat))
            assertFalse(isValidPortableAssetKey("assets/$compat"))
            assertFalse(isValidPortableAssetNameOrKey(compat))
            assertFalse(isValidPortableAssetNameOrKey("assets/$compat"))
            assertTrue(isValidCompatPortableAssetFilename(compat))
            assertTrue(isValidCompatPortableAssetKey("assets/$compat"))
            assertTrue(isValidCompatPortableAssetNameOrKey(compat))
            assertTrue(isValidCompatPortableAssetNameOrKey("assets/$compat"))
        }

        for (invalid in listOf("", ".", "..", "../evil.svg", "sub/evil.svg", overCap)) {
            assertFalse(isValidPortableAssetFilename(invalid))
            assertFalse(isValidCompatPortableAssetFilename(invalid))
            assertFalse(isValidPortableAssetKey("assets/$invalid"))
            assertFalse(isValidCompatPortableAssetKey("assets/$invalid"))
            assertFalse(isValidPortableAssetNameOrKey(invalid))
            assertFalse(isValidCompatPortableAssetNameOrKey(invalid))
        }
    }
}
