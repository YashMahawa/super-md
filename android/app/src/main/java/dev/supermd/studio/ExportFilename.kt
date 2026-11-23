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
            // Portable notes may be reported as JSON or gzip by providers
            // instead of their custom extension MIME.
            NativeExportFormat.PORTABLE_SMD -> actual in setOf("application/vnd.supermd.smd", "application/vnd.supermd.fmd", "application/json", "application/gzip", "application/x-gzip", "text/json", "text/plain")
        }
    }

    fun hasExpectedHeader(prefix: ByteArray, format: NativeExportFormat): Boolean = when (format) {
        NativeExportFormat.PDF -> prefix.startsWithAscii("%PDF-")
        NativeExportFormat.MARKDOWN -> true // Markdown is UTF-8 text and has no required magic prefix.
        NativeExportFormat.PORTABLE_SMD -> prefix.size >= 2 && prefix[0] == 0x1f.toByte() && prefix[1] == 0x8b.toByte() || prefix.startsWithAscii("{\"format\":\"supermd-smd\"")
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

internal data class ExportDocumentMetadata(val displayName: String?, val mimeType: String?)

/** Pure policy for checking/renaming a destination before any output stream is opened. */
internal object ExportDestinationPolicy {
    fun validate(
        initial: ExportDocumentMetadata,
        format: NativeExportFormat,
        allowRename: Boolean,
        rename: (String) -> ExportDocumentMetadata?,
    ): ExportDocumentMetadata {
        var current = initial
        val initialName = current.displayName
        if (initialName == null) {
            val mime = current.mimeType?.substringBefore(';')?.trim()?.lowercase()
            require(!mime.isNullOrBlank() && mime !in setOf("application/octet-stream", "binary/octet-stream") && mimeMatchesWithoutFilename(mime, format)) {
                "The destination provider did not report a filename or a matching file type; choose another location."
            }
            return current
        }

        if (!ExportFilename.suffixMatches(initialName, format)) {
            require(allowRename) { "This existing file does not have the .${format.extension} extension; use Export As instead." }
            current = rename(ExportFilename.suggestedName(initialName, format))
                ?: error("The destination provider cannot correct the filename. Choose a name ending in .${format.extension}.")
            val renamedName = current.displayName
                ?: error("The destination provider did not confirm the corrected filename.")
            require(ExportFilename.suffixMatches(renamedName, format)) {
                "The destination provider kept a different extension. Choose a name ending in .${format.extension}."
            }
        }
        require(ExportFilename.mimeMatches(current.mimeType, format)) {
            "The destination provider identifies this as a different file type. Choose another location."
        }
        return current
    }

    // Without an extension there is no evidence that JSON/plain text is an
    // SMD note. Require its exact MIME; those generic representations are
    // accepted only when a `.smd` display name confirms the format.
    private fun mimeMatchesWithoutFilename(mime: String, format: NativeExportFormat): Boolean = when (format) {
        NativeExportFormat.PDF -> mime in setOf("application/pdf", "application/x-pdf")
        NativeExportFormat.MARKDOWN -> mime in setOf("text/markdown", "text/x-markdown", "text/plain")
        NativeExportFormat.PORTABLE_SMD -> mime in setOf("application/vnd.supermd.smd", "application/vnd.supermd.fmd")
    }
}
