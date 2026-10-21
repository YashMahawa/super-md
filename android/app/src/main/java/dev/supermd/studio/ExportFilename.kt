package dev.supermd.studio

/** Filename and MIME contract shared by SAF export destinations and share copies. */
internal enum class NativeExportFormat(val extension: String, val mimeType: String) {
    PDF("pdf", "application/pdf"),
    MARKDOWN("md", "text/markdown"),
    PORTABLE_SMD("smd", "application/vnd.supermd.smd");

    companion object {
        fun fromMime(mime: String): NativeExportFormat = when (mime.substringBefore(';').trim().lowercase()) {
            "application/pdf" -> PDF
            "text/markdown", "text/x-markdown", "text/plain" -> MARKDOWN
            "application/vnd.supermd.smd", "application/vnd.supermd.fmd" -> PORTABLE_SMD
            else -> error("Unsupported export MIME type")
        }

        fun fromShareFormat(format: String): NativeExportFormat = when (format) {
            "pdf" -> PDF
            "md" -> MARKDOWN
            "smd" -> PORTABLE_SMD
            else -> error("Unsupported export format")
        }
    }
}

internal object ExportFilename {
    // Older Super MD releases and generic text editors used these names. Strip
    // them as format suffixes instead of turning e.g. `draft.fmd` into
    // `draft.fmd.pdf` when the user switches export format.
    private val knownSuffixes = (NativeExportFormat.entries.map { ".${it.extension}" } +
        listOf(".fmd", ".markdown", ".txt")).sortedByDescending(String::length)
    private val genericMimeTypes = setOf("application/octet-stream", "binary/octet-stream")

    /** Preserve human text and punctuation while excluding path/control and Windows-invalid characters. */
    fun suggestedName(input: String, format: NativeExportFormat): String {
        val cleaned = buildString(input.length) {
            input.codePoints().forEach { codePoint ->
                when {
                    codePoint == '/'.code || codePoint == '\\'.code -> append('-')
                    Character.isISOControl(codePoint) -> Unit
                    codePoint == ':'.code || codePoint == '*'.code || codePoint == '?'.code ||
                        codePoint == '"'.code || codePoint == '<'.code || codePoint == '>'.code || codePoint == '|'.code -> append('-')
                    else -> appendCodePoint(codePoint)
                }
            }
        }.trim().trimEnd('.')

        var stem = cleaned
        while (knownSuffixes.any { stem.endsWith(it, ignoreCase = true) }) {
            stem = stem.substringBeforeLast('.')
        }
        stem = stem.trim().trimEnd('.')
        if (stem.isBlank() || stem == "." || stem == "..") stem = "Note"
        stem = limitLength(stem).trim().trimEnd('.').ifBlank { "Note" }
        return "$stem.${format.extension}"
    }

    fun suffixMatches(name: String, format: NativeExportFormat): Boolean =
        name.substringAfterLast('.', "").equals(format.extension, ignoreCase = true)

    /** Null/empty and octet-stream are common from generic SAF providers; extension still must match. */
    fun mimeMatches(actualMime: String?, format: NativeExportFormat): Boolean {
        val actual = actualMime?.substringBefore(';')?.trim()?.lowercase().orEmpty()
        if (actual.isEmpty() || actual in genericMimeTypes) return true
        return when (format) {
            NativeExportFormat.PDF -> actual in setOf("application/pdf", "application/x-pdf")
            NativeExportFormat.MARKDOWN -> actual in setOf("text/markdown", "text/x-markdown", "text/plain")
            NativeExportFormat.PORTABLE_SMD -> actual in setOf("application/vnd.supermd.smd", "application/vnd.supermd.fmd")
        }
    }

    fun hasExpectedHeader(prefix: ByteArray, format: NativeExportFormat): Boolean = when (format) {
        NativeExportFormat.PDF -> prefix.startsWithAscii("%PDF-")
        NativeExportFormat.MARKDOWN -> true // Markdown is UTF-8 text and has no required magic prefix.
        NativeExportFormat.PORTABLE_SMD -> prefix.startsWithAscii("{\"format\":\"supermd-smd\"")
    }

    private fun limitLength(value: String): String {
        var offset = 0
        var codePoints = 0
        var utf8Bytes = 0
        while (offset < value.length && codePoints < MAX_STEM_CODE_POINTS) {
            val codePoint = value.codePointAt(offset)
            val encodedBytes = when {
                codePoint <= 0x7f -> 1
                codePoint <= 0x7ff -> 2
                codePoint <= 0xffff -> 3
                else -> 4
            }
            if (utf8Bytes + encodedBytes > MAX_STEM_UTF8_BYTES) break
            utf8Bytes += encodedBytes
            codePoints++
            offset += Character.charCount(codePoint)
        }
        return value.substring(0, offset)
    }

    private fun ByteArray.startsWithAscii(expected: String): Boolean {
        val bytes = expected.toByteArray(Charsets.US_ASCII)
        return size >= bytes.size && bytes.indices.all { this[it] == bytes[it] }
    }

    private const val MAX_STEM_CODE_POINTS = 120
    // Leave room for the longest supported suffix and stay below common
    // 255-byte filesystem component limits, even with multi-byte names.
    private const val MAX_STEM_UTF8_BYTES = 240
}
