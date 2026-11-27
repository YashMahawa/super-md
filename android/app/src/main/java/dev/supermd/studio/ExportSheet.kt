@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.material3.ExperimentalMaterial3ExpressiveApi::class)
package dev.supermd.studio

import android.content.Intent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import org.json.JSONObject

internal class NoteDestination(private val mime: String, private val preferred: () -> String): ActivityResultContracts.CreateDocument(mime) {
    override fun createIntent(context: android.content.Context, input: String): Intent {
        val expected = NativeExportFormat.fromMime(mime)
        val suggested = ExportFilename.suggestedName(input, expected)
        val location = preferred().takeIf { it.isNotBlank() }?.let { tree ->
            val uri=android.net.Uri.parse(tree)
            android.provider.DocumentsContract.buildDocumentUriUsingTree(uri, android.provider.DocumentsContract.getTreeDocumentId(uri))
        } ?: android.net.Uri.parse("content://com.android.externalstorage.documents/document/primary%3ADownload")
        return super.createIntent(context,suggested).putExtra(android.provider.DocumentsContract.EXTRA_INITIAL_URI,location)
    }
}

@Composable private fun PdfOptions(options: JSONObject, fonts: List<String> = emptyList(), update: (String, Any) -> Unit) {
    Choice("Paper", options.optString("pageSize", "a4"), listOf("a3" to "A3","a4" to "A4", "a5" to "A5","a6" to "A6","iso-b4" to "B4 (ISO)","iso-b5" to "B5 (ISO)","iso-b6" to "B6 (ISO)", "letter" to "Letter", "legal" to "Legal","tabloid" to "Tabloid","executive" to "Executive")) { update("pageSize", it) }
    FontChoice("Document font", options.optString("fontFamily", "Manrope"), (listOf("Manrope","Roboto","Noto Sans","Noto Serif","JetBrains Mono","Libertinus Serif","New Computer Modern","DejaVu Sans Mono")+fonts).distinct().map {it to it}) { update("fontFamily", it) }
    Text("Margins · ${options.optDouble("margin",18.0).toInt()} mm", Modifier.padding(top = 16.dp)); StudySlider(value = options.optDouble("margin",18.0).toFloat(), onCommit = { update("margin", it.toInt()) }, valueRange = 4f..60f)
    Text("Font size · ${"%.1f".format(options.optDouble("fontSize",10.0))} pt"); StudySlider(value = options.optDouble("fontSize",10.0).toFloat(), onCommit = { update("fontSize", (it * 2).toInt() / 2.0) }, valueRange = 5f..24f)
    Text("Line spacing · ${"%.2f".format(options.optDouble("lineHeight",1.45))}"); StudySlider(value = options.optDouble("lineHeight",1.45).toFloat(), onCommit = { update("lineHeight", it.toDouble()) }, valueRange = .9f..2.2f)
    Text("Paragraph spacing · ${"%.1f".format(options.optDouble("paragraphSpacing",1.2))}"); StudySlider(value = options.optDouble("paragraphSpacing",1.2).toFloat(), onCommit = { update("paragraphSpacing", it.toDouble()) }, valueRange = 0f..3f)
    Row(verticalAlignment = Alignment.CenterVertically) { Text("Page numbers", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium); Switch(checked = options.optBoolean("pageNumbers",true), onCheckedChange = { update("pageNumbers", it) }) }
    Row(verticalAlignment = Alignment.CenterVertically) {Text("Light Material theme", Modifier.weight(1f)); Switch(checked = options.optBoolean("themed",false), onCheckedChange = {update("themed", it)})}
    Text("Off uses plain paper. On uses your accent with light surfaces, even in dark mode.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

internal fun exportPrimaryActionLabel(format: String, sharing: Boolean): String = when {
    sharing -> "Prepare & share"
    format == "md" -> "Export Markdown"
    format == "mdzip" -> "Export ZIP"
    else -> "Choose destination & export"
}

@Composable internal fun ExportSettings(raw: String, onChange: (String) -> Unit, sharing: Boolean = false, fonts:List<String> = emptyList(), noteLocation: String = "", export: (String) -> Unit) {
    var format by rememberSaveable { mutableStateOf("pdf") }
    var options by remember(raw) { mutableStateOf(JSONObject(raw)) }
    fun update(key: String, value: Any) { options = JSONObject(options.toString()).put(key, value); onChange(options.toString()) }
    val directSaveCopy = if (noteLocation.isBlank()) "Saves directly to Downloads/Super MD." else "Saves directly to your configured note folder."
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
        Column(Modifier.widthIn(max = 640.dp).fillMaxWidth()) {
            Column(Modifier.weight(1f, fill = false).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp)) {
                Text(if (sharing) "Share your note" else "Export your note", style = MaterialTheme.typography.headlineSmall)
                val formats = listOf("pdf" to "PDF", "md" to "Markdown", "smd" to "Portable SMD", "mdzip" to "ZIP")
                Column(Modifier.fillMaxWidth().padding(vertical = 12.dp)) {
                    formats.chunked(2).forEach { row ->
                        Row(Modifier.fillMaxWidth()) {
                            row.forEach { (key, label) ->
                                FilterChip(selected = format == key, onClick = { format = key }, label = { Text(label) }, modifier = Modifier.weight(1f).padding(horizontal = 4.dp, vertical = 2.dp).heightIn(min = 48.dp))
                            }
                        }
                    }
                }
                if (format == "pdf") {
                    Text("Vector equations, plots and real pagination. Typeset locally on this device.", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(bottom = 12.dp))
                    PdfOptions(options, fonts, ::update)
                } else if (format == "mdzip") {
                    Text("Obsidian-ready Markdown and images in one ZIP. Sliders become static figures; diagrams and charts become linked SVG images.", style = MaterialTheme.typography.bodyMedium)
                    if (!sharing) Text(directSaveCopy, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp))
                } else if (format == "md") {
                    Text("SVGs and diagram sources are embedded in the Markdown. Images and GIFs keep readable relative filenames.", style = MaterialTheme.typography.bodyMedium)
                    if (!sharing) Text(directSaveCopy, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp))
                } else {
                    Text("Your Markdown and images in one editable file.", style = MaterialTheme.typography.titleMedium)
                    Text("Reopen it in Super MD to edit, drop in images, or select an image to replace or remove it. Source mode shows Markdown, never image bytes.", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 12.dp))
                }
            }
            Button(onClick = { export(format) }, shapes = ButtonDefaults.shapes(), modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 16.dp).heightIn(min = 48.dp)) {
                Icon(painterResource(if (sharing) R.drawable.symbol_share else R.drawable.symbol_export), null)
                Text(exportPrimaryActionLabel(format, sharing), Modifier.padding(start = 8.dp))
            }
        }
    }
}
