package dev.supermd.studio
import android.graphics.pdf.PdfRenderer
import android.content.Intent
import android.os.ParcelFileDescriptor
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.async
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.util.zip.CRC32

private fun writeOversizedValidPng(file: File, minimumBytes: Int) {
    val bitmap = android.graphics.Bitmap.createBitmap(1, 1, android.graphics.Bitmap.Config.ARGB_8888)
    val png = ByteArrayOutputStream().use { output ->
        check(bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output))
        output.toByteArray()
    }
    bitmap.recycle()
    check(png.size > 20 && png.copyOfRange(png.size - 12, png.size).contentEquals(
        byteArrayOf(0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae.toByte(), 0x42, 0x60, 0x82.toByte())
    ))
    val chunkType = "tEXt".toByteArray(Charsets.US_ASCII)
    val keyword = "metadata\u0000".toByteArray(Charsets.ISO_8859_1)
    val chunkDataLength = minimumBytes - png.size
    check(chunkDataLength > keyword.size)
    val crc = CRC32().apply { update(chunkType); update(keyword) }
    file.outputStream().buffered().use { output ->
        output.write(png, 0, png.size - 12)
        val data = DataOutputStream(output)
        data.writeInt(chunkDataLength)
        data.write(chunkType)
        data.write(keyword)
        var remaining = chunkDataLength - keyword.size
        val block = ByteArray(64 * 1024) { 'x'.code.toByte() }
        while (remaining > 0) {
            val count = minOf(remaining, block.size)
            data.write(block, 0, count)
            crc.update(block, 0, count)
            remaining -= count
        }
        data.writeInt(crc.value.toInt())
        data.write(png, png.size - 12, 12)
    }
}

@RunWith(AndroidJUnit4::class)
class EngineTest {
    @Test fun createDocumentIntentKeepsUnicodeNameAndMatchesRequestedFormat() {
        val context=ApplicationProvider.getApplicationContext<android.content.Context>()
        val cases=listOf(
            Triple("application/pdf","Résumé 📚 [draft].smd","Résumé 📚 [draft].pdf"),
            Triple("text/markdown","Résumé 📚 [draft].pdf","Résumé 📚 [draft].md"),
            Triple("application/vnd.supermd.smd","Résumé 📚 [draft].md","Résumé 📚 [draft].smd"),
        )
        for((mime,input,expectedTitle) in cases) {
            val intent=NoteDestination(mime){""}.createIntent(context,input)
            assertEquals(Intent.ACTION_CREATE_DOCUMENT,intent.action)
            assertEquals(mime,intent.type)
            assertEquals(expectedTitle,intent.getStringExtra(Intent.EXTRA_TITLE))
            assertTrue(expectedTitle.endsWith(".${NativeExportFormat.fromMime(mime).extension}"))
        }
    }

    @Test fun portableThemeValidationAndNativeContrast() {
        val result=JSONObject(PdfEngine.validateTheme(themeTemplate));assertFalse(result.has("error"))
        val theme=result.getJSONObject("theme");assertEquals("My theme",theme.getString("name"))
        val untouched=manualAccent("violet",true);assertSame(untouched,customThemeColors(untouched,theme,"dark",true))
        assertTrue(JSONObject(PdfEngine.validateTheme(themeTemplate.replace("\"opacity\":0.05","\"opacity\":0.9"))).has("error"))
        assertTrue(JSONObject(PdfEngine.validateTheme(" ".repeat(65537))).has("error"))
        val roles=JSONObject().put("surface","#222222").put("surface-low","#252525").put("surface-high","#292929").put("text","#222222").put("primary","#222222")
        theme.getJSONObject("variants").getJSONObject("dark").put("colors",roles)
        val palette=customThemeColors(manualAccent("violet",true),theme,"dark",true)
        assertTrue(contrast(palette.onSurface,palette.surface)>=4.5f);assertTrue(contrast(palette.onPrimary,palette.primary)>=4.5f)
        assertEquals("dots",themeStyle(theme,"dark",true).getJSONObject("background").getString("pattern"))
        assertEquals(0,themeStyle(theme,"black",true).getJSONObject("colors").length())
    }
    @Test fun deletedDraftArchiveSurvivesBoundedClosedTabEviction() {
        val app=ApplicationProvider.getApplicationContext<android.app.Application>()
        val root=File(app.cacheDir,"deleted-draft-test-${java.util.UUID.randomUUID()}")
        try {
            val draft=Note(name="Recovered study.md",content="Unfinished λ mathematics",saved="")
            DeletedDraftStore(root).save(draft)
            val reopened=DeletedDraftStore(root).latest(emptySet())!!
            assertEquals(draft,reopened)
            assertTrue(reopened.dirty)
            assertNull(DeletedDraftStore(root).latest(setOf(draft.id)))
            assertFalse(root.listFiles()!!.any {it.extension=="tmp"})
        } finally {root.deleteRecursively()}
    }
    @Test fun derivedPythonOutputReloadsWithoutRerunningCode() {
        val app=ApplicationProvider.getApplicationContext<android.app.Application>()
        val root=File(app.cacheDir,"output-store-${java.util.UUID.randomUUID()}")
        try {
            val source="print('λ') # ../../not-a-path"
            val result=JSONObject().put("ok",true).put("stdout","λ\n").put("stderr","").put("images",org.json.JSONArray().put("data:image/svg+xml;base64,PHN2Zy8+"))
            val first=PythonOutputStore(root);assertNull(first.load(source));first.store(source,result)
            val second=PythonOutputStore(root);assertEquals(result.toString(),second.load(source)!!.toString());assertEquals(1,root.listFiles()!!.size)
            assertEquals("λ\n",second.load(source)!!.getString("stdout"))
        } finally {root.deleteRecursively()}
    }
    @Test fun streamingRecoveryPreservesLargeDraftsAndReadsPreviousSnapshots() {
        val app=ApplicationProvider.getApplicationContext<android.app.Application>()
        val text="Quoted \"Unicode λ\" and \\math\n".repeat(200_000)
        val clean=Note(name="Large.md",content=text,saved=text)
        val dirty=Note(name="Draft.md",content=text+"New edit",saved=text)
        val state=StudioState(tabs=listOf(clean,dirty),activeId=dirty.id,closedTabs=listOf(Note(name="Closed.md",content="Recover me",saved="")),mode="reader",normalZoom=123f)
        val file=File(app.cacheDir,"streamed-recovery.json")
        try {
            file.bufferedWriter().use{NoteRecovery.write(it,state)}
            val restored=file.bufferedReader().use{NoteRecovery.read(it,StudioState())}
            assertEquals(state.tabs,restored.tabs);assertEquals(state.closedTabs,restored.closedTabs)
            assertEquals(dirty.id,restored.activeId);assertEquals(123f,restored.normalZoom)
            assertSame("Clean saved text should not occupy another full string",restored.tabs[0].content,restored.tabs[0].saved)
            val previous="""{"tabs":[{"id":"legacy","name":"Legacy.md","content":"Quotes \"λ\"","saved":"original","uri":"","relative":"","assetDirectory":""}],"active":"legacy","closed":[],"mode":"live"}"""
            val legacy=NoteRecovery.read(previous.reader(),StudioState());assertEquals("Quotes \"λ\"",legacy.active.content);assertEquals("original",legacy.active.saved)
        } finally {file.delete()}
    }
    @Test fun selectablePapersAndPrivateFontsExportOnDevice() {
        val app=ApplicationProvider.getApplicationContext<android.app.Application>()
        val font=File(app.cacheDir,"import-Manrope.ttf")
        app.assets.open("web/fonts/Manrope.ttf").use { input->font.outputStream().use {input.copyTo(it)} }
        assertTrue(PdfEngine.fontFamilies(font.absolutePath).contains("Manrope"))
        val library=FontLibrary(app)
        val family=library.import(android.net.Uri.fromFile(font))
        assertEquals("Manrope",family)
        assertTrue(library.reader(family).getString("data").startsWith("data:font/ttf;base64,"))
        val assets=File(app.cacheDir,"papers-fonts-${java.util.UUID.randomUUID()}").apply {mkdirs()}
        library.addPdfFonts(family,assets)
        assertEquals(1,assets.listFiles()!!.size)
        for(paper in listOf("a3","a4","a5","a6","iso-b4","iso-b5","iso-b6","letter","legal","tabloid","executive")) {
            val options=JSONObject(StudioState().pdf).put("pageSize",paper).put("fontFamily",family).put("pageNumbers",false)
            val pdf=File(app.cacheDir,"paper-$paper.pdf")
            assertEquals(paper,"",PdfEngine.export("# Reading font\n\nText and ${'$'}\\frac13${'$'}.",options.toString(),assets.absolutePath,pdf.absolutePath))
            PdfRenderer(ParcelFileDescriptor.open(pdf,ParcelFileDescriptor.MODE_READ_ONLY)).use {renderer->assertTrue(renderer.pageCount>0);renderer.openPage(0).use {page->assertTrue(page.width>0 && page.height>0)} }
        }
    }
    @Test fun pythonRequestsFromTwoWindowsDoNotKillEachOther() = runBlocking {
        val app = ApplicationProvider.getApplicationContext<android.app.Application>()
        val first = StudioViewModel(app, java.util.UUID.randomUUID().toString())
        val second = StudioViewModel(app, java.util.UUID.randomUUID().toString())
        val a = async { first.python("import time\ntime.sleep(.3)\nprint('first-window')") }
        val b = async { second.python("print('second-window')") }
        assertTrue(a.await().getString("stdout").contains("first-window"))
        assertTrue(b.await().getString("stdout").contains("second-window"))
    }
    @Test fun obsidianSameLineProbabilityMathExportsOnDevice() {
        val app = ApplicationProvider.getApplicationContext<android.app.Application>()
        val md = "${'$'}${'$'}\\boxed{\\begin{aligned}\nP(A\\cup B)=&P(A)+P(B)\\\\\n&-P(A\\cap B).\n\\end{aligned}}${'$'}${'$'}\n\n## After the equation\n\n> [!TIP] Still present\n> ${'$'}P(A\\cap B)\\le1${'$'}\n"
        val assets = File(app.cacheDir, "probability-assets").apply { mkdirs() }
        val pdf = File(app.cacheDir, "probability.pdf")
        assertEquals("", PdfEngine.export(md, StudioState().pdf, assets.absolutePath, pdf.absolutePath))
        PdfRenderer(ParcelFileDescriptor.open(pdf, ParcelFileDescriptor.MODE_READ_ONLY)).use { assertTrue(it.pageCount > 0) }
    }
    @Test fun circularConvolutionAndRenamedSymbolsExportThroughShippingJni() {
        val app = ApplicationProvider.getApplicationContext<android.app.Application>()
        val directory = File(app.cacheDir, "symbol-compat-${java.util.UUID.randomUUID()}").apply { mkdirs() }
        try {
            val markdown = """# Symbol compatibility

${'$'}${'$'}y[n]=(x\circledast_N h)[n]=\sum_{m=0}^{N-1}x[m]h[(n-m)\bmod N].${'$'}${'$'}

${'$'}\oplus\otimes\odot\ominus\bigoplus\bigotimes\bigodot\partial\hbar\mho\llbracket x\rrbracket${'$'}

Literal ${'$'}\text{ast.circle}${'$'} must remain text.
"""
            val pdf = File(directory, "Circular convolution 📚.pdf")
            assertEquals("", PdfEngine.export(markdown, StudioState().pdf, directory.absolutePath, pdf.absolutePath))
            assertTrue(pdf.inputStream().use { String(it.readNBytes(5), Charsets.US_ASCII) } == "%PDF-")
            PdfRenderer(ParcelFileDescriptor.open(pdf, ParcelFileDescriptor.MODE_READ_ONLY)).use { assertTrue(it.pageCount > 0) }
        } finally { directory.deleteRecursively() }
    }
    @Test fun jniPdfLoadsReferencedAssetAndSkipsOversizedUnrelatedFile() {
        val app = ApplicationProvider.getApplicationContext<android.app.Application>()
        val directory = File(app.cacheDir, "pdf-assets-${java.util.UUID.randomUUID()}").apply { mkdirs() }
        try {
            val assets = File(directory, "assets").apply { mkdirs() }
            File(assets, "used.svg").writeText("<svg xmlns='http://www.w3.org/2000/svg' width='120' height='60'><path d='M0 55L120 5' stroke='blue'/></svg>")
            java.io.RandomAccessFile(File(assets, "unrelated.png"), "rw").use { it.setLength(500_000_000L) }
            val output = File(directory, "document.pdf")
            val error = PdfEngine.export("![Used](used.svg)", StudioState().pdf, assets.absolutePath, output.absolutePath)
            assertEquals("", error)
            assertTrue(output.isFile)
            val header = ByteArray(5)
            assertEquals(5, output.inputStream().use { it.read(header) })
            assertEquals("%PDF-", String(header, Charsets.US_ASCII))
        } finally { directory.deleteRecursively() }
    }
    @Test fun jniPdfRejectsReferencedAssetOverLimitBeforeWritingOutput() {
        val app = ApplicationProvider.getApplicationContext<android.app.Application>()
        val directory = File(app.cacheDir, "pdf-assets-limit-${java.util.UUID.randomUUID()}").apply { mkdirs() }
        try {
            val assets = File(directory, "assets").apply { mkdirs() }
            val oversized = File(assets, "too-large.png")
            writeOversizedValidPng(oversized, 25_000_001)
            assertTrue("The fixture must exceed the native PDF asset limit: ${oversized.length()}", oversized.length() > 25_000_000)
            val decoded = android.graphics.BitmapFactory.decodeFile(oversized.absolutePath)
            assertNotNull("The over-limit fixture must still be a valid PNG", decoded)
            assertEquals(1, decoded!!.width)
            decoded.recycle()
            val output = File(directory, "document.pdf")
            val markdown = "![Too large](too-large.png)"
            assertEquals("[\"too-large.png\"]", PdfEngine.imageSources(markdown))
            val error = PdfEngine.export(markdown, StudioState().pdf, assets.absolutePath, output.absolutePath)
            assertTrue("Expected a clear asset size error for ${oversized.length()} bytes, received: $error", error.contains("PDF asset exceeds its supported size: too-large.png"))
            assertFalse("A failed export must not leave a PDF", output.exists())
        } finally { directory.deleteRecursively() }
    }
    @Test fun largePortableStringsCrossReaderBufferBoundaries() {
        val app = ApplicationProvider.getApplicationContext<android.app.Application>(); val media = MediaStorage(app)
        val markdown = sample + "\n\n" + "Unicode λ and escaped quotes \"remain editable\".\n".repeat(200)
        val vector = "<svg xmlns='http://www.w3.org/2000/svg' width='200' height='100'>" + "<path d='M0 90L200 10' stroke='blue'/>".repeat(300) + "</svg>"
        val data = "data:image/svg+xml;base64," + android.util.Base64.encodeToString(vector.toByteArray(), android.util.Base64.NO_WRAP)
        val output = java.io.ByteArrayOutputStream(); media.writeFmd(output, markdown, JSONObject().put("assets/image-long.svg", data))
        val opened = media.openFmd(output.toByteArray().inputStream()); assertEquals(markdown, opened.markdown)
        assertEquals(data, media.data(media.local("assets/image-long.svg", opened.directory)!!))
    }
    @Test fun portableAssetsResolveWhenFilesDirUsesCanonicalAlias() {
        val app=ApplicationProvider.getApplicationContext<android.app.Application>()
        val alias=File(app.cacheDir,"files-alias-${java.util.UUID.randomUUID()}")
        java.nio.file.Files.createSymbolicLink(alias.toPath(),app.filesDir.canonicalFile.toPath())
        try {
            val aliasedContext=object:android.content.ContextWrapper(app) {
                override fun getFilesDir():File=alias
            }
            val media=MediaStorage(aliasedContext)
            val markdown="# Aliased filesDir"
            val vector="<svg xmlns='http://www.w3.org/2000/svg' width='20' height='10'><path d='M0 9L20 1'/></svg>"
            val data="data:image/svg+xml;base64,"+android.util.Base64.encodeToString(vector.toByteArray(),android.util.Base64.NO_WRAP)
            val output=java.io.ByteArrayOutputStream()
            media.writeFmd(output,markdown,JSONObject().put("assets/alias.svg",data))
            val opened=media.openFmd(output.toByteArray().inputStream())
            val asset=media.local("assets/alias.svg",opened.directory)
            assertNotNull("Canonical filesDir aliases must not make valid portable assets disappear",asset)
            assertEquals(data,media.data(asset!!))
        } finally {
            alias.delete()
        }
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
