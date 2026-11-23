package dev.supermd.studio

import android.net.Uri

internal val KNOWN_NOTE_SUFFIXES = listOf(".markdown", ".smd", ".fmd", ".md", ".txt")
internal val NON_NOTE_FORMAT_SUFFIXES = listOf(".pdf", ".zip", ".html", ".htm", ".docx", ".json")
internal val SUPPORTED_FOLDER_NOTE_EXTENSIONS = setOf("md", "smd", "markdown", "fmd", "txt")
private val RESERVED_FILENAME_CHARS = setOf('/', '\\', '\u0000', ':', '*', '?', '"', '<', '>', '|')

internal sealed interface NoteRenameResult {
    data class Valid(val filename: String) : NoteRenameResult
    data class Invalid(val error: String) : NoteRenameResult
}

private fun matchingSuffix(name: String, suffixes: List<String>): String {
    val lower = name.lowercase()
    for (suffix in suffixes) {
        if (lower.endsWith(suffix)) {
            return name.substring(name.length - suffix.length)
        }
    }
    return ""
}

internal fun noteStem(name: String): String {
    val base = name.substringAfterLast('/').substringAfterLast('\\')
    val suffix = matchingSuffix(base, KNOWN_NOTE_SUFFIXES)
    return if (suffix.isNotEmpty()) base.dropLast(suffix.length) else base
}

internal fun resolveNoteRename(
    requested: String,
    currentName: String,
    portable: Boolean = false,
    hasSavedTarget: Boolean = false,
): NoteRenameResult {
    val trimmed = requested.trim()
    if (trimmed.isEmpty()) {
        return NoteRenameResult.Invalid("Enter a note name.")
    }
    if (trimmed.any { ch -> ch in RESERVED_FILENAME_CHARS || ch.code < 32 || ch.code == 127 }) {
        return NoteRenameResult.Invalid("Choose a filename without path separators or reserved characters.")
    }
    if (trimmed == "." || trimmed == ".." || trimmed.startsWith('.')) {
        return NoteRenameResult.Invalid("Note names cannot start with a dot or have an empty title.")
    }

    val currentExt = if (portable) {
        matchingSuffix(currentName, listOf(".fmd", ".smd")).ifEmpty { ".smd" }
    } else {
        val matchedCurrent = matchingSuffix(currentName, KNOWN_NOTE_SUFFIXES)
        when {
            matchedCurrent.isNotEmpty() -> matchedCurrent
            hasSavedTarget -> ""
            else -> ".md"
        }
    }

    val allKnownSuffixes = (KNOWN_NOTE_SUFFIXES + NON_NOTE_FORMAT_SUFFIXES).sortedByDescending { it.length }
    val typedSuffix = matchingSuffix(trimmed, allKnownSuffixes)
    val resolved = if (typedSuffix.isNotEmpty()) {
        if (!typedSuffix.equals(currentExt, ignoreCase = true)) {
            return NoteRenameResult.Invalid("Rename keeps the note format. Use Export to change formats.")
        }
        val stem = trimmed.dropLast(typedSuffix.length)
        if (stem.isBlank() || stem == "." || stem == ".." || stem.startsWith('.')) {
            return NoteRenameResult.Invalid("Note names cannot start with a dot or have an empty title.")
        }
        stem + typedSuffix
    } else {
        trimmed + currentExt
    }

    if (resolved.endsWith('.') || resolved.endsWith(' ')) {
        return NoteRenameResult.Invalid("Note names cannot end with a dot or space.")
    }
    if (resolved.toByteArray(Charsets.UTF_8).size > 255) {
        return NoteRenameResult.Invalid("Note name is too long.")
    }
    return NoteRenameResult.Valid(resolved)
}

internal fun isSupportedFolderNoteFile(name: String): Boolean {
    if (name.isBlank() || name.startsWith('.')) return false
    val ext = name.substringAfterLast('.', "").lowercase()
    return ext.isNotEmpty() && ext in SUPPORTED_FOLDER_NOTE_EXTENSIONS
}

internal fun normalizeFolderRelative(relative: String): String =
    relative.split('/').map { it.trim() }.filter { it.isNotEmpty() && it != "." && it != ".." }.joinToString("/")

internal fun parentFolderRelative(relative: String): String {
    val normalized = normalizeFolderRelative(relative)
    return if ('/' in normalized) normalized.substringBeforeLast('/') else ""
}

internal fun renameRecentNotes(
    existing: List<RecentNote>,
    oldUri: String?,
    newUri: String,
    newName: String,
    newRelative: String?,
    sameUri: (String, String) -> Boolean = { left, right -> sameDocument(Uri.parse(left), Uri.parse(right)) },
): List<RecentNote> {
    val wasPinned = existing.any { entry ->
        entry.pinned && ((oldUri != null && sameUri(entry.uri, oldUri)) || sameUri(entry.uri, newUri))
    }
    val remaining = existing.filterNot { entry ->
        (oldUri != null && sameUri(entry.uri, oldUri)) || sameUri(entry.uri, newUri)
    }
    return orderedRecents(listOf(RecentNote(newName, newUri, newRelative, wasPinned)) + remaining)
}
