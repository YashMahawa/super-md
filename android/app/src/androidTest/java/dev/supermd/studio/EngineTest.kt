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
