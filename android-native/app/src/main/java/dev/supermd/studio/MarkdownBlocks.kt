package dev.supermd.studio

import org.json.JSONObject

sealed interface NoteBlock {
    val raw: String
    data class Heading(val level: Int, val text: String, override val raw: String) : NoteBlock
    data class Paragraph(val text: String, override val raw: String) : NoteBlock
    data class Callout(val kind: String, val title: String, val body: String, override val raw: String) : NoteBlock
    data class Code(val language: String, val body: String, override val raw: String) : NoteBlock
    data class Image(val alt: String, val url: String, override val raw: String) : NoteBlock
    data class Table(val rows: List<List<String>>, override val raw: String) : NoteBlock
    data class Equation(val latex: String, override val raw: String) : NoteBlock
    data class Chart(val definition: JSONObject, override val raw: String) : NoteBlock
}

/** A block parser shared by reading, live editing and the native PDF canvas. */
fun parseBlocks(source: String): List<NoteBlock> {
    val lines = source.replace("\r\n", "\n").split("\n")
    val blocks = mutableListOf<NoteBlock>()
    var index = 0
    while (index < lines.size) {
        val line = lines[index]
        if (line.isBlank()) { index++; continue }
        val start = index
        val heading = Regex("^(#{1,6})\\s+(.+)$").matchEntire(line)
        val image = Regex("^!\\[([^]]*)]\\(([^)]+)\\)$").matchEntire(line.trim())
        val obsidianCallout = Regex("^>\\s*\\[!([A-Za-z]+)]\\s*(.*)$").matchEntire(line)
        when {
            heading != null -> {
                blocks += NoteBlock.Heading(heading.groupValues[1].length, heading.groupValues[2], line)
                index++
            }
            image != null -> {
                blocks += NoteBlock.Image(image.groupValues[1], image.groupValues[2], line)
                index++
            }
            obsidianCallout != null -> {
                index++
                while (index < lines.size && lines[index].startsWith(">")) index++
                val raw = lines.subList(start, index).joinToString("\n")
                val body = lines.subList(start + 1, index).joinToString("\n") { it.removePrefix(">").trimStart() }
                blocks += NoteBlock.Callout(obsidianCallout.groupValues[1].lowercase(), obsidianCallout.groupValues[2], body, raw)
            }
            line.startsWith(":::callout ") -> {
                index++
                while (index < lines.size && lines[index].trim() != ":::") index++
                val body = lines.subList(start + 1, index).joinToString("\n")
                if (index < lines.size) index++
                val header = line.removePrefix(":::callout ").trim()
                blocks += NoteBlock.Callout(header.substringBefore(' ').lowercase(), header.substringAfter(' ', "").trim('"'), body, lines.subList(start, index).joinToString("\n"))
            }
            line.startsWith("```") -> {
                val language = line.removePrefix("```").trim()
                index++
                while (index < lines.size && !lines[index].startsWith("```")) index++
                val body = lines.subList(start + 1, index).joinToString("\n")
                if (index < lines.size) index++
                val raw = lines.subList(start, index).joinToString("\n")
                if (language == "smd-chart") {
                    val definition = runCatching { JSONObject(body) }.getOrNull()
                    blocks += if (definition != null) NoteBlock.Chart(definition, raw) else NoteBlock.Code(language, body, raw)
                } else blocks += NoteBlock.Code(language, body, raw)
            }
            line.trim() == "$$" -> {
                index++
                while (index < lines.size && lines[index].trim() != "$$") index++
                val latex = lines.subList(start + 1, index).joinToString("\n")
                if (index < lines.size) index++
                blocks += NoteBlock.Equation(latex, lines.subList(start, index).joinToString("\n"))
            }
            line.trim().startsWith("|") && index + 1 < lines.size && lines[index + 1].contains("---") -> {
                while (index < lines.size && lines[index].trim().startsWith("|")) index++
                val rawLines = lines.subList(start, index)
                val rows = rawLines.filterIndexed { rowIndex, _ -> rowIndex != 1 }.map { row -> row.trim().trim('|').split('|').map(String::trim) }
                blocks += NoteBlock.Table(rows, rawLines.joinToString("\n"))
            }
            else -> {
                index++
                while (index < lines.size && lines[index].isNotBlank() && !lines[index].startsWith("#") && !lines[index].startsWith("```") && !lines[index].startsWith("> [!") && !lines[index].startsWith(":::callout")) index++
                val raw = lines.subList(start, index).joinToString("\n")
                blocks += NoteBlock.Paragraph(raw, raw)
            }
        }
    }
    return blocks
}
