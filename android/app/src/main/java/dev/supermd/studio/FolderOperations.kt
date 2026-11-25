package dev.supermd.studio

import android.net.Uri
import androidx.documentfile.provider.DocumentFile

internal val FOLDER_NOTE_EXTENSIONS = setOf("md", "smd", "markdown", "fmd", "txt")
private val KNOWN_NOTE_SUFFIXES = listOf(".markdown", ".smd", ".fmd", ".md", ".txt")
private val KNOWN_EXPORT_FORMATS = setOf("md", "markdown", "txt", "smd", "fmd", "pdf", "zip", "html", "docx")

// --- Naming & relative path helpers ---

internal fun noteStem(name: String): String {
    val leaf = name.substringAfterLast('/').substringAfterLast('\\')
    val lower = leaf.lowercase()
    for (suffix in KNOWN_NOTE_SUFFIXES) {
        if (leaf.length > suffix.length && lower.endsWith(suffix)) {
            return leaf.dropLast(suffix.length)
        }
    }
    val dot = leaf.lastIndexOf('.')
    return if (dot > 0) leaf.substring(0, dot) else leaf
}

internal fun isSupportedFolderNoteFile(name: String): Boolean =
    !name.startsWith('.') && '.' in name && name.substringAfterLast('.', "").lowercase() in FOLDER_NOTE_EXTENSIONS

internal fun normalizeRelativePath(relative: String?): String =
    relative.orEmpty().trim('/').split('/').filter { it.isNotEmpty() }.joinToString("/")

internal fun parentRelativePath(relative: String): String =
    normalizeRelativePath(relative).substringBeforeLast('/', "")

internal fun childRelativePath(parentRelative: String, name: String): String {
    val parent = normalizeRelativePath(parentRelative)
    return if (parent.isEmpty()) name else "$parent/$name"
}

internal fun matchesRelativePrefix(candidate: String?, prefix: String): Boolean {
    val cleanCandidate = normalizeRelativePath(candidate)
    val cleanPrefix = normalizeRelativePath(prefix)
    return cleanPrefix.isNotEmpty() && (cleanCandidate == cleanPrefix || cleanCandidate.startsWith("$cleanPrefix/"))
}

internal fun remapRelativePrefix(candidate: String?, oldPrefix: String, newPrefix: String): String? {
    if (candidate == null) return null
    val cleanCandidate = normalizeRelativePath(candidate)
    val cleanOld = normalizeRelativePath(oldPrefix)
    val cleanNew = normalizeRelativePath(newPrefix)
    if (cleanOld.isEmpty()) return candidate
    if (cleanCandidate == cleanOld) return cleanNew
    if (cleanCandidate.startsWith("$cleanOld/")) {
        val suffix = cleanCandidate.removePrefix("$cleanOld/")
        return if (cleanNew.isEmpty()) suffix else "$cleanNew/$suffix"
    }
    return candidate
}

internal fun validateFolderEntryName(
    rawName: String,
    isDirectory: Boolean,
    currentExtension: String = "",
    hasSavedTarget: Boolean = false,
): String {
    val trimmed = rawName.trim()
    require(trimmed.isNotEmpty()) { "Enter a name" }
    require(trimmed != "." && trimmed != "..") { "Choose a name other than '.' or '..'" }
    require(!trimmed.any { it in "/\\:*?\"<>|\u0000" || it.code < 32 }) {
        "Choose a name without path separators or reserved characters"
    }
    require(!trimmed.startsWith('.') && !trimmed.endsWith('.')) {
        "Names starting or ending with '.' are not supported"
    }
    require(trimmed.length <= 240) { "Choose a shorter name" }
    if (isDirectory) return trimmed

    val rawExt = currentExtension.trimStart('.').lowercase()
    if (hasSavedTarget && rawExt.isEmpty()) {
        val dot = trimmed.lastIndexOf('.')
        if (dot > 0) {
            val supplied = trimmed.substring(dot + 1).lowercase()
            require(supplied !in KNOWN_EXPORT_FORMATS) {
                "Rename keeps the current note format. Use Export to change formats."
            }
        }
        return trimmed
    }

    val expected = rawExt.ifEmpty { "md" }
    val dot = trimmed.lastIndexOf('.')
    if (dot < 0) return "$trimmed.$expected"
    val stem = trimmed.substring(0, dot)
    val cleanStem = stem.trim()
    val supplied = trimmed.substring(dot + 1)
    if (supplied.equals(expected, ignoreCase = true)) {
        require(cleanStem.isNotEmpty() && cleanStem != "." && cleanStem != ".." && !cleanStem.endsWith('.')) {
            "Enter a valid note name"
        }
        return "$stem.$expected"
    }
    require(supplied.lowercase() !in (KNOWN_EXPORT_FORMATS - expected)) {
        "Rename keeps the .$expected format. Use Export to change formats."
    }
    return "$trimmed.$expected"
}

internal fun resolveTreeDirectory(treeRoot: DocumentFile, relative: String): DocumentFile {
    var current = treeRoot
    require(current.isDirectory) { "Open folder is not accessible" }
    for (segment in normalizeRelativePath(relative).split('/').filter { it.isNotEmpty() }) {
        require(segment != "." && segment != ".." && !segment.startsWith('.')) { "Invalid folder path" }
        val next = current.findFile(segment) ?: error("Folder '$segment' no longer exists")
        require(next.isDirectory) { "'$segment' is not a folder" }
        current = next
    }
    return current
}

internal fun resolveTreeEntry(treeRoot: DocumentFile, relative: String): DocumentFile? {
    var current: DocumentFile = treeRoot
    for (segment in normalizeRelativePath(relative).split('/').filter { it.isNotEmpty() }) {
        if (segment == "." || segment == "..") return null
        current = current.findFile(segment) ?: return null
    }
    return current
}

internal fun findDuplicateInDirectory(parentDir: DocumentFile, candidateName: String, ignoreUri: Uri? = null): DocumentFile? =
    parentDir.listFiles().firstOrNull { child ->
        val existingName = child.name ?: return@firstOrNull false
        !(ignoreUri != null && sameDocument(child.uri, ignoreUri)) && existingName.equals(candidateName, ignoreCase = true)
    }
