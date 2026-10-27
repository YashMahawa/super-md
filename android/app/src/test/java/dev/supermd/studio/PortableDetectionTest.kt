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
}
