package dev.supermd.studio

import android.util.Base64
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream

@RunWith(RobolectricTestRunner::class)
class PortableCompressionTest {
    @Test fun compressedV1WritesAndReadsExactMarkdownAndAssetBytes() {
        val media=MediaStorage(RuntimeEnvironment.getApplication())
        val markdown="# α\n\n![Exact](assets/source.svg)\n"
        val svg="<svg xmlns='http://www.w3.org/2000/svg'><text>α</text></svg>".toByteArray()
        val assets=JSONObject().put("assets/source.svg","data:image/svg+xml;base64,"+Base64.encodeToString(svg,Base64.NO_WRAP))
        val output=ByteArrayOutputStream()
        media.writeFmd(output,markdown,assets)
        val bytes=output.toByteArray()
        assertTrue(portableGzipHeader(bytes.copyOf(2)))
        val opened=media.openFmd(ByteArrayInputStream(bytes))
        assertEquals(markdown,opened.markdown)
        val restored=media.local("assets/source.svg",opened.directory)!!
        assertArrayEquals(svg,restored.readBytes())
        restored.parentFile?.deleteRecursively()
    }

    @Test fun legacyJsonRemainsReadableAndCompressedTrailingDataIsRejected() {
        val media=MediaStorage(RuntimeEnvironment.getApplication())
        val legacy="""{"format":"supermd-smd","version":1,"markdown":"# Legacy","assets":{}}""".toByteArray()
        assertEquals("# Legacy",media.openFmd(ByteArrayInputStream(legacy)).markdown)
        val output=ByteArrayOutputStream()
        media.writeFmd(output,"# Note",JSONObject())
        assertThrows(Exception::class.java) { media.openFmd(ByteArrayInputStream(output.toByteArray()+byteArrayOf(1))) }
    }
}
