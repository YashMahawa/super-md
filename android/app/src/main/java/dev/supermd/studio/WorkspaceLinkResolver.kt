package dev.supermd.studio

import android.net.Uri
import android.provider.DocumentsContract

internal val WORKSPACE_NOTE_EXTENSIONS = listOf("md", "smd", "fmd", "markdown", "txt")

data class PendingHeadingJump(
    val noteId: String,
    val heading: String,
    val token: String,
)

internal enum class ReaderUrlDecision {
    ALLOW_READER,
    BLOCK_INTERNAL,
    OPEN_EXTERNAL,
}

/**
 * Classifies main-frame and subresource URL navigations inside the Android reader WebView.
 * Allows only the bundled offline reader entrypoint on the main frame and its opaque-origin
 * Mermaid sandbox subframe, and never opens `appassets.androidplatform.net` URLs externally.
 */
internal fun classifyReaderNavigationUrl(url: Uri?, isForMainFrame: Boolean): ReaderUrlDecision {
    if (url == null) return ReaderUrlDecision.BLOCK_INTERNAL
    if (!shouldOverrideReaderNavigation(url, isForMainFrame)) {
        return ReaderUrlDecision.ALLOW_READER
    }
    if (url.host.equals("appassets.androidplatform.net", ignoreCase = true)) {
        return ReaderUrlDecision.BLOCK_INTERNAL
    }
    val scheme = url.scheme?.lowercase()
    if (isForMainFrame && scheme in setOf("https", "http", "mailto")) {
        return ReaderUrlDecision.OPEN_EXTERNAL
    }
    return ReaderUrlDecision.BLOCK_INTERNAL
}

internal class WorkspaceLinkException(message: String) : IllegalArgumentException(message)

internal data class WorkspaceResolvedNote(
    val uri: Uri,
    val name: String,
    val relative: String,
)

internal fun extractRelativeFromDocId(rootId: String, documentId: String): String? = when {
    documentId == rootId -> ""
    documentId.startsWith("${rootId.trimEnd('/')}/") -> documentId.removePrefix("${rootId.trimEnd('/')}/")
    rootId.endsWith(':') && documentId.startsWith(rootId) -> documentId.removePrefix(rootId).trimStart('/')
    else -> null
}

internal fun isExplicitRelativeWorkspaceTarget(rawTarget: String, wikilink: Boolean): Boolean =
    !wikilink ||
        rawTarget.startsWith("./") ||
        rawTarget.startsWith("../") ||
        rawTarget.startsWith(".\\") ||
        rawTarget.startsWith("..\\")

private val ENCODED_NUL_REGEX = Regex("%00", RegexOption.IGNORE_CASE)

internal fun sanitizeWorkspaceLinkTarget(rawTarget: String): String {
    if (rawTarget.contains('\u0000') || ENCODED_NUL_REGEX.containsMatchIn(rawTarget)) {
        throw WorkspaceLinkException("Invalid relative note path.")
    }
    val cleaned = rawTarget.trim().substringBefore('#').substringBefore('?').trim()
    if (cleaned.isEmpty()) {
        throw WorkspaceLinkException("Invalid relative note path.")
    }
    return cleaned
}

/**
 * Resolves a workspace-relative path against `parentRelative` without allowing
 * absolute paths, URL schemes, encoded path separators, or `..` escapes above the folder root.
 */
internal fun workspaceRelativePathParts(parentRelative: String, rawTarget: String): List<String> =
    try {
        readerAssetPathParts(parentRelative.replace('\\', '/').trim('/'), rawTarget.trim())
    } catch (_: IllegalStateException) {
        throw WorkspaceLinkException("Linked note is outside the authorized folder.")
    } catch (error: IllegalArgumentException) {
        throw WorkspaceLinkException(
            if (error.message?.contains("Encoded path separators", ignoreCase = true) == true) {
                "Encoded path separators are not allowed."
            } else {
                "Invalid relative note path."
            },
        )
    }

internal fun splitWorkspaceNameAndExt(name: String): Pair<String, String> {
    val dot = name.lastIndexOf('.')
    return if (dot <= 0 || dot == name.lastIndex) {
        name to ""
    } else {
        name.substring(0, dot) to name.substring(dot + 1).lowercase()
    }
}

internal fun expandWorkspaceCandidatePaths(
    parentRelative: String,
    cleanedTarget: String,
    wikilink: Boolean,
): List<List<String>> {
    val primaryParts = workspaceRelativePathParts(parentRelative, cleanedTarget)
    val (_, explicitExt) = splitWorkspaceNameAndExt(primaryParts.last())
    if (!wikilink && explicitExt.isNotEmpty() && explicitExt !in WORKSPACE_NOTE_EXTENSIONS) {
        throw WorkspaceLinkException("Only Markdown and Super MD notes can be opened from relative links.")
    }
    val baseLists = buildList {
        add(primaryParts)
        val decodedSegments = Uri.decode(cleanedTarget).replace('\\', '/').split('/')
        if (parentRelative.isNotEmpty()
            && !cleanedTarget.startsWith("./")
            && !cleanedTarget.startsWith("../")
            && !decodedSegments.contains("..")
        ) {
            val rootParts = workspaceRelativePathParts("", cleanedTarget)
            if (rootParts != primaryParts) add(rootParts)
        }
    }
    val expanded = ArrayList<List<String>>()
    for (parts in baseLists) {
        val (_, ext) = splitWorkspaceNameAndExt(parts.last())
        if (ext in WORKSPACE_NOTE_EXTENSIONS) {
            if (parts !in expanded) expanded += parts
        } else {
            for (noteExt in WORKSPACE_NOTE_EXTENSIONS) {
                val withExt = parts.dropLast(1) + "${parts.last()}.$noteExt"
                if (withExt !in expanded) expanded += withExt
            }
        }
    }
    return expanded
}

internal fun resolveLocalFileWorkspaceLink(
    sourceUri: Uri,
    rawTarget: String,
    wikilink: Boolean,
): WorkspaceResolvedNote? {
    if (sourceUri.scheme != "file") return null
    val rawPath = sourceUri.path ?: return null
    val sourceFile = java.io.File(rawPath)
    if (java.nio.file.Files.isSymbolicLink(sourceFile.toPath())) {
        throw WorkspaceLinkException("Linked note symlink paths are not allowed.")
    }
    val parentDir = runCatching { sourceFile.canonicalFile.parentFile }.getOrNull()?.takeIf { it.isDirectory }
        ?: throw WorkspaceLinkException("Invalid note path.")
    val cleaned = sanitizeWorkspaceLinkTarget(rawTarget)
    val candidateLists = expandWorkspaceCandidatePaths("", cleaned, wikilink)
    val boundaryPath = parentDir.toPath()
    for (parts in candidateLists) {
        var cur = parentDir
        for (segment in parts) {
            val next = java.io.File(cur, segment)
            if (java.nio.file.Files.isSymbolicLink(next.toPath())) {
                throw WorkspaceLinkException("Linked note symlink paths are not allowed.")
            }
            cur = next
        }
        if (!cur.isFile) continue
        val resolved = runCatching { cur.canonicalFile }.getOrNull() ?: continue
        val resolvedPath = resolved.toPath()
        if (!resolvedPath.startsWith(boundaryPath)) {
            throw WorkspaceLinkException("Linked note is outside the authorized folder.")
        }
        return WorkspaceResolvedNote(
            uri = Uri.fromFile(resolved),
            name = resolved.name,
            relative = boundaryPath.relativize(resolvedPath).toString().replace('\\', '/'),
        )
    }
    throw WorkspaceLinkException("Linked note not found: ${Uri.decode(cleaned)}")
}
