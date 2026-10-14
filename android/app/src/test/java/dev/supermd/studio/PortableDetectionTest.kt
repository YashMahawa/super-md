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
}
