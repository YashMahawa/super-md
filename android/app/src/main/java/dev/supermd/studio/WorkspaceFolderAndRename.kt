package dev.supermd.studio

internal fun normalizeFolderRelative(relative: String): String =
    relative.split('/').map { it.trim() }.filter { it.isNotEmpty() && it != "." && it != ".." }.joinToString("/")

internal fun parentFolderRelative(relative: String): String {
    val normalized = normalizeFolderRelative(relative)
    return if ('/' in normalized) normalized.substringBeforeLast('/') else ""
}
