package dev.supermd.studio

import org.json.JSONArray

internal fun markdownImageSourcesJson(markdown: String): String = try {
    PdfEngine.imageSources(markdown)
} catch (_: UnsatisfiedLinkError) {
    fallbackMarkdownImageSourcesJson(markdown)
} catch (_: NoClassDefFoundError) {
    fallbackMarkdownImageSourcesJson(markdown)
}

private fun fallbackMarkdownImageSourcesJson(markdown: String): String {
    val result = JSONArray()
    val pattern = Regex("""!\[(?:\\.|[^\]])*]\(\s*(?:<([^>\r\n]+)>|([^\s)\r\n]+))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)""")
    pattern.findAll(markdown).forEach { match ->
        val source = (match.groupValues[1].ifEmpty { match.groupValues[2] }).trim()
        if (source.isNotEmpty()) result.put(source)
    }
    return result.toString()
}

object PdfEngine {
    init { System.loadLibrary("smd_core") }
    @JvmStatic external fun export(markdown: String, options: String, assets: String, output: String): String
    @JvmStatic external fun imageSources(markdown: String): String
    @JvmStatic external fun fontFamilies(path: String): String
    @JvmStatic external fun validateTheme(input:String):String
}
