package dev.supermd.studio

import android.util.Base64
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.io.InputStream

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class PortableEnvelopeCodecTest {
    private val svgBytes = "<svg xmlns='http://www.w3.org/2000/svg'><text>∑ 日本語 🧪</text></svg>".toByteArray(Charsets.UTF_8)
    private val svgDataUrl = "data:image/svg+xml;base64," + Base64.encodeToString(svgBytes, Base64.NO_WRAP)

    private class OneByteInputStream(private val data: ByteArray) : InputStream() {
        private var index = 0
        override fun read(): Int = if (index < data.size) data[index++].toInt() and 0xff else -1
        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (len == 0) return 0
            val next = read()
            if (next < 0) return -1
            b[off] = next.toByte()
            return 1
        }
    }

    @Test
    fun multiByteUtf8MarkdownRoundTripsAndEnforcesUtf8ByteCaps() {
        val app = RuntimeEnvironment.getApplication()
        val media = MediaStorage(app)
        val utf8Markdown = "# ∫₀^∞ e^{-x²} dx = √π/2 — 日本語のノート 🧪🚀\n\nEquations: α ≠ β, 中文段落。\n\n![Diagram](assets/utf8.svg)\n"
        val exactUtf8Bytes = utf8Markdown.toByteArray(Charsets.UTF_8).size
        assertTrue(exactUtf8Bytes > utf8Markdown.length)

        val assets = JSONObject().put("assets/utf8.svg", svgDataUrl)
        val compressed = ByteArrayOutputStream().also { media.writeFmd(it, utf8Markdown, assets) }.toByteArray()
        assertTrue(portableGzipHeader(compressed))

        // Short 1-byte stream reads still sniff gzip magic and decode UTF-8 cleanly.
        val opened = media.openFmd(OneByteInputStream(compressed))
        try {
            assertEquals(utf8Markdown, opened.markdown)
            assertArrayEquals(svgBytes, media.local("assets/utf8.svg", opened.directory)!!.readBytes())
            assertTrue(media.portableEnvelopeMatches(OneByteInputStream(compressed), utf8Markdown, assets))
            assertEquals(utf8Markdown, media.portableMarkdown(OneByteInputStream(compressed), stopAfterMarkdown = true))
            assertEquals(utf8Markdown, media.readSearchableNote(OneByteInputStream(compressed)))

            assertEquals(utf8Markdown, media.portableMarkdown(ByteArrayInputStream(compressed), stopAfterMarkdown = true, maxMarkdownBytes = exactUtf8Bytes))
            assertThrows(IllegalArgumentException::class.java) {
                media.portableMarkdown(ByteArrayInputStream(compressed), stopAfterMarkdown = true, maxMarkdownBytes = exactUtf8Bytes - 1)
            }
            assertNull(media.readSearchableNote(ByteArrayInputStream(compressed), maxPortableMarkdownBytes = exactUtf8Bytes - 1))

            val localOut = ByteArrayOutputStream()
            media.writeLocalPortable(localOut, utf8Markdown, opened.directory)
            val reopenedLocal = media.openFmd(ByteArrayInputStream(localOut.toByteArray()))
            try {
                assertEquals(utf8Markdown, reopenedLocal.markdown)
                assertArrayEquals(svgBytes, media.local("assets/utf8.svg", reopenedLocal.directory)!!.readBytes())
            } finally {
                File(app.filesDir, "portable-assets/${reopenedLocal.directory}").deleteRecursively()
            }
        } finally {
            File(app.filesDir, "portable-assets/${opened.directory}").deleteRecursively()
        }
    }

    @Test
    fun boundedOutputStreamCountsChunkedWritesAccuratelyAndRejectsOverflowWithoutCorruption() {
        val sink = ByteArrayOutputStream()
        val bounded = BoundedOutputStream(sink, maxBytes = 10L, errorMessage = "Cap exceeded")
        val buf = byteArrayOf(9, 1, 2, 3, 4, 9)
        bounded.write(buf, 1, 4)
        bounded.write(5)
        assertEquals(5L, bounded.bytes)

        assertThrows(IndexOutOfBoundsException::class.java) { bounded.write(buf, -1, 2) }
        assertThrows(IndexOutOfBoundsException::class.java) { bounded.write(buf, 4, 4) }
        val err = assertThrows(IllegalArgumentException::class.java) { bounded.write(byteArrayOf(6, 7, 8, 9, 10, 11), 0, 6) }
        assertEquals("Cap exceeded", err.message)
        assertEquals(5L, bounded.bytes)
        assertEquals(5, sink.size())

        bounded.write(byteArrayOf(6, 7, 8, 9, 10), 0, 5)
        assertEquals(10L, bounded.bytes)
        assertThrows(IllegalArgumentException::class.java) { bounded.write(11) }
        assertEquals(10L, bounded.bytes)
        assertArrayEquals(byteArrayOf(1, 2, 3, 4, 5, 6, 7, 8, 9, 10), sink.toByteArray())
    }

    @Test
    fun withBoundedPortableJsonReaderRejectsOversizedTokensAndInvalidGzipStreams() {
        val media = MediaStorage(RuntimeEnvironment.getApplication())
        val oversizedStream = object : InputStream() {
            private val prefix = """{"format":"supermd-smd","version":1,"markdown":"""".toByteArray(Charsets.UTF_8)
            private var emitted = 0L
            private val total = prefix.size + 34_000_005L
            override fun read(): Int = if (emitted >= total) -1 else (if (emitted < prefix.size) prefix[emitted.toInt()].toInt() and 0xff else 'a'.code).also { emitted++ }
            override fun read(b: ByteArray, off: Int, len: Int): Int {
                if (emitted >= total) return -1
                val n = minOf(len.toLong(), total - emitted).toInt()
                for (i in 0 until n) b[off + i] = if (emitted + i < prefix.size) prefix[(emitted + i).toInt()] else 'a'.code.toByte()
                emitted += n
                return n
            }
        }
        val tokenErr = assertThrows(IllegalArgumentException::class.java) {
            withBoundedPortableJsonReader(oversizedStream) { reader ->
                reader.beginObject()
                while (reader.hasNext()) { reader.nextName(); reader.nextString() }
            }
        }
        assertEquals("FMD token is too large", tokenErr.message)

        val validGzip = ByteArrayOutputStream().also { media.writeFmd(it, "# Note", JSONObject()) }.toByteArray()
        for (corrupt in listOf(validGzip.copyOf(validGzip.size - 3), validGzip + byteArrayOf(0x00))) {
            assertThrows(IOException::class.java) {
                withBoundedPortableJsonReader(ByteArrayInputStream(corrupt)) { reader ->
                    reader.beginObject()
                    while (reader.hasNext()) { reader.nextName(); reader.skipValue() }
                    reader.endObject()
                    reader.peek()
                }
            }
        }
    }

    @Test
    fun openFmdCleansUpTemporaryBundleAndInvalidatesCachedAssetsOnMidStreamFailure() {
        val app = RuntimeEnvironment.getApplication()
        val media = MediaStorage(app)
        val bundlesRoot = File(app.filesDir, "portable-assets").apply { mkdirs() }
        val baselineDirs = bundlesRoot.listFiles()?.map { it.name }?.toSet().orEmpty()
        val failingEnvelope = """{"format":"supermd-smd","version":1,"markdown":"# Partial","assets":{"assets/good.svg":"$svgDataUrl","assets/mismatch.png":"$svgDataUrl"}}"""
            .toByteArray(Charsets.UTF_8)

        assertThrows(IllegalArgumentException::class.java) { media.openFmd(ByteArrayInputStream(failingEnvelope)) }
        assertEquals(baselineDirs, bundlesRoot.listFiles()?.map { it.name }?.toSet().orEmpty())
        assertEquals(0, media.cachedLocalAssetCount())
    }
}
