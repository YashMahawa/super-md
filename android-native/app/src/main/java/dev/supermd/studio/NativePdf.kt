package dev.supermd.studio

import android.content.Context
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.pdf.PdfDocument
import android.net.Uri
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

data class PdfOptions(val pageSize: String = "A4", val margin: Int = 42, val textScale: Float = 1f)

fun pdfCompatibilityIssue(context: Context, markdown: String, folderUri: Uri? = null): String? {
    val blocks = parseBlocks(markdown)
    if (blocks.any { it is NoteBlock.Equation } || blocks.any {
            val text = when (it) { is NoteBlock.Paragraph -> it.text; is NoteBlock.Heading -> it.text; is NoteBlock.Callout -> it.body; else -> "" }
            Regex("(?<!\\\\)\\$[^$\\n]+\\$").containsMatchIn(text)
        }) return "Math typesetting is not ready in the Android PDF renderer. Use the desktop exporter for this note."
    if (blocks.any { it is NoteBlock.Code && it.language == "mermaid" }) return "Diagram export is not ready in the Android PDF renderer. Use the desktop exporter for this note."
    if (blocks.any { it is NoteBlock.Paragraph && it.text.contains("![[") }) return "This note contains an unresolved embedded image. Use a standard Markdown image reference."
    for (block in blocks) {
        if (block is NoteBlock.Image) {
            val uri = resolveImageUri(context, block.url, folderUri)
            if (uri == null || runCatching { context.contentResolver.openInputStream(uri)?.use { it.read() } }.getOrNull() == null) {
                return "An image cannot be read: ${block.url}. Choose the note's image folder before exporting."
            }
        }
        if (block is NoteBlock.Chart) {
            val expression = block.definition.optJSONArray("series")?.optJSONObject(0)?.optString("expression", "") ?: ""
            if ("sin" !in expression && "cos" !in expression) return "This chart expression is not supported by the Android PDF renderer. Use the desktop exporter for this note."
        }
    }
    return null
}

/** Generates pages on Android's vector PDF canvas; it never screenshots the editor or prints a WebView. */
fun createNativePdf(context: Context, markdown: String, options: PdfOptions, folderUri: Uri? = null): ByteArray {
    pdfCompatibilityIssue(context, markdown, folderUri)?.let { error(it) }
    val blocks = parseBlocks(markdown)
    val size = if (options.pageSize == "Letter") 612 to 792 else 595 to 842
    val pageWidth = size.first
    val pageHeight = size.second
    val margin = options.margin.coerceIn(24, 90).toFloat()
    val contentWidth = pageWidth - margin * 2
    val document = PdfDocument()
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(30, 34, 42); textSize = 11f * options.textScale.coerceIn(.75f, 1.6f) }
    val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    var canvas: Canvas? = null
    var page: PdfDocument.Page? = null
    var y = margin
    var pageNumber = 0

    fun newPage() {
        page?.let(document::finishPage)
        pageNumber++
        page = document.startPage(PdfDocument.PageInfo.Builder(pageWidth, pageHeight, pageNumber).create())
        canvas = page!!.canvas
        canvas!!.drawColor(Color.WHITE)
        y = margin
    }

    fun ensure(height: Float) {
        if (canvas == null || y + height > pageHeight - margin) newPage()
    }

    fun lines(text: String, indent: Float = 0f): List<String> {
        val width = (contentWidth - indent).coerceAtLeast(40f)
        return text.split('\n').flatMap { original ->
            if (original.isBlank()) listOf("") else {
                val output = mutableListOf<String>()
                var remaining = original.trimEnd()
                while (remaining.isNotEmpty()) {
                    val count = paint.breakText(remaining, true, width, null).coerceAtLeast(1)
                    if (count >= remaining.length) { output += remaining; break }
                    val cut = remaining.take(count).lastIndexOf(' ').takeIf { it > count / 3 } ?: count
                    output += remaining.take(cut).trimEnd()
                    remaining = remaining.drop(cut).trimStart()
                }
                output
            }
        }
    }

    fun textBlock(text: String, indent: Float = 0f, lineHeight: Float = paint.textSize * 1.42f) {
        for (line in lines(text, indent)) {
            ensure(lineHeight)
            y += lineHeight
            canvas!!.drawText(line, margin + indent, y - lineHeight * .22f, paint)
        }
        y += lineHeight * .35f
    }

    newPage()
    try {
        for (block in blocks) {
            when (block) {
                is NoteBlock.Heading -> {
                    y += if (block.level == 1) 16f else 9f
                    paint.typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
                    paint.textSize = (25f - (block.level - 1) * 2.5f).coerceAtLeast(12f) * options.textScale
                    textBlock(block.text)
                    paint.typeface = Typeface.DEFAULT
                    paint.textSize = 11f * options.textScale
                }
                is NoteBlock.Paragraph -> textBlock(block.text.replace(Regex("[*_`]{1,3}"), ""))
                is NoteBlock.Callout -> {
                    val originalSize = paint.textSize
                    paint.textSize = 10.5f * options.textScale
                    val label = block.title.ifBlank { block.kind.replaceFirstChar(Char::uppercase) }
                    val segments = listOf(label) + lines(block.body, 15f)
                    for ((index, segment) in segments.withIndex()) {
                        val height = paint.textSize * 1.6f
                        ensure(height)
                        fill.color = Color.rgb(238, 244, 255)
                        canvas!!.drawRect(RectF(margin, y, pageWidth - margin, y + height), fill)
                        fill.color = Color.rgb(65, 96, 163)
                        canvas!!.drawRect(RectF(margin, y, margin + 3, y + height), fill)
                        paint.typeface = if (index == 0) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
                        y += height
                        canvas!!.drawText(segment, margin + 12f, y - height * .28f, paint)
                    }
                    paint.typeface = Typeface.DEFAULT
                    paint.textSize = originalSize
                    y += 10f
                }
                is NoteBlock.Code -> {
                    val originalSize = paint.textSize
                    paint.textSize = 9.2f * options.textScale
                    paint.typeface = Typeface.MONOSPACE
                    for (line in lines(block.body, 18f)) {
                        val height = paint.textSize * 1.55f
                        ensure(height)
                        fill.color = Color.rgb(243, 245, 249)
                        canvas!!.drawRect(margin, y, pageWidth - margin, y + height, fill)
                        y += height
                        canvas!!.drawText(line, margin + 9f, y - height * .27f, paint)
                    }
                    paint.typeface = Typeface.DEFAULT
                    paint.textSize = originalSize
                    y += 10f
                }
                is NoteBlock.Table -> {
                    val columns = block.rows.maxOfOrNull(List<String>::size)?.coerceAtLeast(1) ?: 1
                    val cellWidth = contentWidth / columns
                    for ((rowIndex, row) in block.rows.withIndex()) {
                        val rowLines = row.map { cell ->
                            val available = (cellWidth - 12f).coerceAtLeast(16f)
                            val result = mutableListOf<String>()
                            var rest = cell
                            while (rest.isNotBlank()) {
                                val count = paint.breakText(rest, true, available, null).coerceAtLeast(1)
                                result += rest.take(count)
                                rest = rest.drop(count)
                            }
                            result.ifEmpty { listOf("") }
                        }
                        val lineHeight = paint.textSize * 1.35f
                        val height = rowLines.maxOf(List<String>::size) * lineHeight + 10f
                        ensure(height)
                        fill.color = if (rowIndex == 0) Color.rgb(230, 237, 249) else if (rowIndex % 2 == 0) Color.rgb(249, 250, 252) else Color.WHITE
                        canvas!!.drawRect(margin, y, pageWidth - margin, y + height, fill)
                        paint.typeface = if (rowIndex == 0) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
                        rowLines.forEachIndexed { column, wrapped ->
                            wrapped.forEachIndexed { lineIndex, text -> canvas!!.drawText(text, margin + column * cellWidth + 6f, y + 7f + (lineIndex + 1) * lineHeight, paint) }
                        }
                        paint.typeface = Typeface.DEFAULT
                        y += height
                    }
                    y += 10f
                }
                is NoteBlock.Image -> {
                    val uri = resolveImageUri(context, block.url, folderUri)
                    val bitmap = uri?.let { runCatching { context.contentResolver.openInputStream(it)?.use(BitmapFactory::decodeStream) }.getOrNull() }
                    if (bitmap == null) {
                        error("Image unavailable: ${block.url}")
                    } else {
                        val scale = min(contentWidth / bitmap.width, 300f / bitmap.height)
                        val height = bitmap.height * scale
                        ensure(height + 12f)
                        canvas!!.drawBitmap(bitmap, null, RectF(margin, y, margin + bitmap.width * scale, y + height), fill)
                        y += height + 12f
                        bitmap.recycle()
                    }
                }
                is NoteBlock.Chart -> {
                    ensure(188f)
                    val initialValue = block.definition.optJSONArray("sliders")?.optJSONObject(0)?.optDouble("value", 1.0) ?: 1.0
                    drawChart(canvas!!, block.definition, RectF(margin, y, pageWidth - margin, y + 170f), paint, initialValue)
                    y += 188f
                }
                is NoteBlock.Equation -> Unit
            }
        }
        page?.let(document::finishPage)
        page = null
        val output = ByteArrayOutputStream()
        document.writeTo(output)
        return output.toByteArray()
    } finally {
        page?.let(document::finishPage)
        document.close()
    }
}

fun chartValue(definition: JSONObject, x: Double, parameter: Double): Double {
    val expression = definition.optJSONArray("series")?.optJSONObject(0)?.optString("expression") ?: "a * Math.sin(x)"
    val normalized = expression.replace(" ", "")
    val frequency = definition.optJSONArray("sliders")?.optJSONObject(1)?.optDouble("value", 1.0) ?: 1.0
    return when {
        "cos" in normalized -> parameter * cos(frequency * x)
        "sin" in normalized -> parameter * sin(frequency * x)
        else -> parameter * x
    }
}

fun drawChart(canvas: Canvas, definition: JSONObject, bounds: RectF, paint: Paint, parameter: Double = 1.0) {
    val oldColor = paint.color
    val oldWidth = paint.strokeWidth
    paint.color = Color.rgb(224, 230, 241)
    canvas.drawRoundRect(bounds, 12f, 12f, paint)
    val graph = RectF(bounds.left + 22f, bounds.top + 20f, bounds.right - 18f, bounds.bottom - 18f)
    paint.color = Color.rgb(130, 142, 164)
    paint.strokeWidth = 1f
    canvas.drawLine(graph.left, graph.centerY(), graph.right, graph.centerY(), paint)
    canvas.drawLine(graph.centerX(), graph.top, graph.centerX(), graph.bottom, paint)
    val minX = definition.optJSONObject("x")?.optDouble("min", -6.28) ?: -6.28
    val maxX = definition.optJSONObject("x")?.optDouble("max", 6.28) ?: 6.28
    paint.color = Color.rgb(62, 91, 166)
    paint.strokeWidth = 2.6f
    var previousX = graph.left
    var previousY = graph.centerY()
    for (step in 0..180) {
        val x = minX + (maxX - minX) * step / 180.0
        val value = chartValue(definition, x, parameter).coerceIn(-3.0, 3.0)
        val screenX = graph.left + graph.width() * step / 180f
        val screenY = graph.centerY() - value.toFloat() * graph.height() / 6f
        if (step > 0) canvas.drawLine(previousX, previousY, screenX, screenY, paint)
        previousX = screenX
        previousY = screenY
    }
    paint.color = oldColor
    paint.strokeWidth = oldWidth
}
