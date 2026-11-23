package dev.supermd.studio

import android.content.Context
import android.content.ContextWrapper
import android.util.Base64
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import java.util.zip.ZipInputStream
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class MarkdownExportTest {
    private val gifBytes = byteArrayOf(
        0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x02, 0x00, 0x01, 0x00,
        0x80.toByte(), 0x00, 0x00, 0xff.toByte(), 0x00, 0x00, 0x00, 0x00, 0x00,
        0x2c, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
    )

    @Test fun zipKeepsNestedRelativeAssetPathExactGifBytesAndSingleMarkdownSuffix() = withExportContext { context ->
        val assetPath = "figures/lesson-2/animation.gif"
        val source = "# Study\n\n![animation]($assetPath)\n"
        val dataUrl = "data:image/gif;base64," + Base64.encodeToString(gifBytes, Base64.NO_WRAP)
        val assets = JSONObject().put(assetPath, dataUrl)
        val sourceSnapshot = source
        val assetsSnapshot = assets.toString()

        MarkdownExport(context, "Study.md", source, assets).use { export ->
            val zipBytes = ByteArrayOutputStream().also(export::writeZip).toByteArray()
            val entries = readZip(zipBytes)

            assertEquals(setOf("Study.md", assetPath), entries.keys)
            assertEquals(sourceSnapshot, entries["Study.md"]!!.toString(Charsets.UTF_8))
            assertArrayEquals(gifBytes, entries[assetPath])
            assertFalse(entries.containsKey("Study.md.md"))
            assertEquals("Study.md", export.filename)
            assertEquals("export construction does not rewrite source Markdown", sourceSnapshot, source)
            assertEquals("export construction does not rewrite the source assets object", assetsSnapshot, assets.toString())
            assertEquals(dataUrl, assets.getString(assetPath))
        }
    }

    @Test fun exportRejectsTraversalAndAbsoluteAssetPathsAfterUriDecoding() = withExportContext { context ->
        val encoded = "data:image/gif;base64," + Base64.encodeToString(gifBytes, Base64.NO_WRAP)
        for (unsafe in listOf("../escape.gif", "images/%2e%2e/escape.gif", "/absolute.gif", "images\\escape.gif", "images//empty.gif")) {
            assertThrows("Rejected unsafe asset path: $unsafe", IllegalArgumentException::class.java) {
                MarkdownExport(context, "Study.md", "# Study", JSONObject().put(unsafe, encoded))
            }
        }
    }

    @Test fun exportRejectsCaseInsensitiveAndMarkdownFilenameConflicts() = withExportContext { context ->
        val encoded = "data:image/gif;base64," + Base64.encodeToString(gifBytes, Base64.NO_WRAP)
        val caseCollision = JSONObject().put("figures/Diagram.gif", encoded).put("figures/diagram.GIF", encoded)
        assertThrows(IllegalArgumentException::class.java) {
            MarkdownExport(context, "Study.md", "# Study", caseCollision)
        }

        val markdownCollision = JSONObject().put("study.MD", encoded)
        assertThrows(IllegalArgumentException::class.java) {
            MarkdownExport(context, "Study.md", "# Study", markdownCollision)
        }
    }

    @Test fun zipPackagesSvgAssetEntriesAndRejectsMimeExtensionMismatches() = withExportContext { context ->
        val svgBytes = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 20 20\"><circle cx=\"10\" cy=\"10\" r=\"6\"/></svg>"
            .toByteArray(Charsets.UTF_8)
        val svgDataUrl = "data:image/svg+xml;base64," + Base64.encodeToString(svgBytes, Base64.NO_WRAP)
        val gifDataUrl = "data:image/gif;base64," + Base64.encodeToString(gifBytes, Base64.NO_WRAP)
        val source = "# Shapes\n\n![Inline](<image1.svg>)\n\n![Nested](<figures/diagram.svg>)\n"
        val assets = JSONObject()
            .put("image1.svg", svgDataUrl)
            .put("figures/diagram.svg", svgDataUrl)
            .put("figures/anim.gif", gifDataUrl)

        MarkdownExport(context, "Shapes.md", source, assets).use { export ->
            val zipBytes = ByteArrayOutputStream().also(export::writeZip).toByteArray()
            assertTrue(ExportFilename.hasExpectedHeader(zipBytes, NativeExportFormat.MARKDOWN_ZIP))
            val entries = readZip(zipBytes)
            assertEquals(setOf("Shapes.md", "image1.svg", "figures/diagram.svg", "figures/anim.gif"), entries.keys)
            assertEquals(source, entries["Shapes.md"]!!.toString(Charsets.UTF_8))
            assertArrayEquals(svgBytes, entries["image1.svg"])
            assertArrayEquals(svgBytes, entries["figures/diagram.svg"])
            assertArrayEquals(gifBytes, entries["figures/anim.gif"])
        }

        assertThrows(IllegalArgumentException::class.java) {
            MarkdownExport(context, "Shapes.md", source, JSONObject().put("image1.svg", gifDataUrl))
        }
        assertThrows(IllegalArgumentException::class.java) {
            MarkdownExport(context, "Shapes.md", source, JSONObject().put("image1.png", svgDataUrl))
        }
    }

    @Test fun zipPreservesWikilinksObsidianImageEmbedFencedDoubleBracketsAndCalloutByteForByte() = withExportContext { context ->
        val pngBytes = Base64.decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
            Base64.DEFAULT,
        )
        val pngDataUrl = "data:image/png;base64," + Base64.encodeToString(pngBytes, Base64.NO_WRAP)
        val source = buildString {
            append("---\ntitle: \"Graph Relaxation 🧭\"\n---\n\n")
            append("Link [[wikilinks]] and [[Graph Theory#Shortest Paths|Shortest Paths]] beside `[[x]]`.\n\n")
            append("![[img.png]]\n\n")
            append("> [!NOTE] Invariant for [[wikilinks]]\n")
            append("> Keep \$d(v) <= d(u) + w(u, v)\$ and literal `[[x]]` intact.\n\n")
            append("```python\nbuckets = [[x] for x in range(4)]\n```\n")
        }
        val expectedBytes = source.toByteArray(Charsets.UTF_8)
        val assets = JSONObject().put("img.png", pngDataUrl)

        MarkdownExport(context, "Graph Relaxation.md", source, assets).use { export ->
            val zipBytes = ByteArrayOutputStream().also(export::writeZip).toByteArray()
            val entries = readZip(zipBytes)
            assertEquals(setOf("Graph Relaxation.md", "img.png"), entries.keys)
            assertArrayEquals(expectedBytes, entries["Graph Relaxation.md"])
            assertArrayEquals(pngBytes, entries["img.png"])
        }
    }

    private fun withExportContext(block: (Context) -> Unit) {
        val app = RuntimeEnvironment.getApplication()
        val tempCache = Files.createTempDirectory("markdown-export-test").toFile()
        val context = object : ContextWrapper(app) {
            override fun getCacheDir(): File = tempCache
        }
        try { block(context) } finally { tempCache.deleteRecursively() }
    }

    private fun readZip(bytes: ByteArray): Map<String, ByteArray> = buildMap {
        ZipInputStream(ByteArrayInputStream(bytes)).use { zip ->
            while (true) {
                val entry = zip.nextEntry ?: break
                put(entry.name, zip.readBytes())
                zip.closeEntry()
            }
        }
    }
}
