package dev.supermd.studio
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class EngineTest {
    @Test fun largePortableStringsCrossReaderBufferBoundaries() {
        val app = ApplicationProvider.getApplicationContext<android.app.Application>(); val media = MediaStorage(app)
        val markdown = sample + "\n\n" + "Unicode λ and escaped quotes \"remain editable\".\n".repeat(200)
        val vector = "<svg xmlns='http://www.w3.org/2000/svg' width='200' height='100'>" + "<path d='M0 90L200 10' stroke='blue'/>".repeat(300) + "</svg>"
        val data = "data:image/svg+xml;base64," + android.util.Base64.encodeToString(vector.toByteArray(), android.util.Base64.NO_WRAP)
        val output = java.io.ByteArrayOutputStream(); media.writeFmd(output, markdown, JSONObject().put("assets/image-long.svg", data))
        val opened = media.openFmd(output.toByteArray().inputStream()); assertEquals(markdown, opened.markdown)
        assertEquals(data, media.data(media.local("assets/image-long.svg", opened.directory)!!))
    }
    @Test fun portableImagesStayOutsideSourceAndExportOffline() = runBlocking {
        val app = ApplicationProvider.getApplicationContext<android.app.Application>()
        val media = MediaStorage(app)
        val vector = "<svg xmlns='http://www.w3.org/2000/svg' width='120' height='60'><path d='M0 55L120 5' stroke='blue'/></svg>"
        val data = "data:image/svg+xml;base64," + android.util.Base64.encodeToString(vector.toByteArray(), android.util.Base64.NO_WRAP)
        val imported = media.importJson(org.json.JSONArray().put(JSONObject().put("name", "Proof.svg").put("data", data))).getJSONObject(0)
        val source = imported.getString("source")
        val markdown = "# Portable note\n\n![Proof](<$source>)\n\n${'$'}${'$'}\\int_0^1 x^2dx=\\frac13${'$'}${'$'}\n\n```python\nprint('never execute implicitly')\n```"
        val file = File(app.cacheDir, "portable-test.fmd")
        file.outputStream().use { media.writeFmd(it, markdown, JSONObject().put(source, data)) }
        val opened = file.inputStream().use(media::openFmd)
        assertEquals(markdown, opened.markdown); assertFalse(opened.markdown.contains("base64"))
        assertEquals(data, media.data(media.local(source, opened.directory)!!))
        val images = org.json.JSONArray(PdfEngine.imageSources(markdown)); assertEquals(1, images.length()); assertEquals(source, images.getString(0))
        val assets = File(app.cacheDir, "portable-test-assets").apply { mkdirs() }
        File(assets, "proof.svg").writeText(vector)
        val pdf = File(app.cacheDir, "portable-test.pdf")
        assertEquals("", PdfEngine.export(markdown.replace(source, "proof.svg"), StudioState().pdf, assets.absolutePath, pdf.absolutePath))
        PdfRenderer(ParcelFileDescriptor.open(pdf, ParcelFileDescriptor.MODE_READ_ONLY)).use { assertTrue(it.pageCount > 0) }
        val unsafe = """{"format":"supermd-fmd","version":1,"markdown":"note","assets":{"assets/../bad.svg":"$data"}}"""
        assertTrue(runCatching { media.openFmd(unsafe.byteInputStream()) }.isFailure)
    }
    @Test fun latexTablesAndLocalMatplotlibExportOffline() = runBlocking {
        val app = ApplicationProvider.getApplicationContext<android.app.Application>()
        val model = StudioViewModel(app)
        val output = model.python("import numpy as np\nimport matplotlib.pyplot as plt\nx = np.linspace(-3,3,100)\nplt.plot(x, np.exp(-x*x))\nprint('local-python-ok')")
        assertTrue(output.getBoolean("ok")); assertTrue(output.getString("stdout").contains("local-python-ok"))
        val plot = output.getJSONArray("images").getString(0)
        assertTrue(plot.startsWith("data:image/svg+xml;base64,"))
        val assets = File(app.cacheDir, "engine-test-assets").apply { mkdirs() }
        File(assets, "plot.svg").writeBytes(android.util.Base64.decode(plot.substringAfter(','), android.util.Base64.DEFAULT))
        val pdf = File(app.cacheDir, "engine-test.pdf")
        val md = "# Android PDF\n\n> [!TIP] Equation\n> Inline ${'$'}e^{i\\pi}+1=0${'$'}.\n\n${'$'}${'$'}\n\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix} \\quad \\int_0^1 x^2dx=\\frac13\n${'$'}${'$'}\n\n![Local plot](plot.svg)\n\n| Index | Formula | Explanation |\n|---|---|---|\n" + (0 until 120).joinToString("\n") { "| $it | ${'$'}\\frac{1}{1+x^2}${'$'} | This explanation wraps and flows across pages without cropping. |" }
        val error = PdfEngine.export(md, StudioState().pdf, assets.absolutePath, pdf.absolutePath)
        assertEquals("", error)
        assertTrue(pdf.readBytes().take(5).toByteArray().toString(Charsets.US_ASCII).startsWith("%PDF-"))
        PdfRenderer(ParcelFileDescriptor.open(pdf, ParcelFileDescriptor.MODE_READ_ONLY)).use { assertTrue("Table must span pages", it.pageCount > 3) }
    }
}
