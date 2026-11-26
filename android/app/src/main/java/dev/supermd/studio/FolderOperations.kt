package dev.supermd.studio

import android.net.Uri
import android.provider.DocumentsContract

private const val MAX_SAF_SUBTREE_DIRS = 256
private const val MAX_SAF_SUBTREE_DEPTH = 32
private const val MAX_SAF_OPEN_FOLDER_PROBE_DIRS = 64

internal val FOLDER_NOTE_EXTENSIONS = setOf("md", "smd", "markdown", "fmd", "txt")
private val KNOWN_NOTE_SUFFIXES = listOf(".markdown", ".smd", ".fmd", ".md", ".txt")
private val KNOWN_EXPORT_FORMATS = setOf("md", "markdown", "txt", "smd", "fmd", "pdf", "zip", "html", "docx")

// --- Naming & relative path helpers ---

internal fun noteExtension(name: String): String {
    val leaf = name.substringAfterLast('/').substringAfterLast('\\')
    val lower = leaf.lowercase()
    for (suffix in KNOWN_NOTE_SUFFIXES) {
        if (leaf.length > suffix.length && lower.endsWith(suffix)) {
            return leaf.substring(leaf.length - suffix.length + 1)
        }
    }
    val dot = leaf.lastIndexOf('.')
    if (dot > 0) {
        val rawExt = leaf.substring(dot + 1)
        if (rawExt.length in 1..16 && rawExt[0].code < 128 && rawExt[0].isLetter() && rawExt.all { it.code < 128 && it.isLetterOrDigit() }) {
            return rawExt
        }
    }
    return ""
}

internal fun noteStem(name: String): String {
    val leaf = name.substringAfterLast('/').substringAfterLast('\\')
    val ext = noteExtension(leaf)
    return if (ext.isNotEmpty() && leaf.length > ext.length + 1) {
        leaf.dropLast(ext.length + 1)
    } else {
        leaf
    }
}

internal fun isSupportedFolderNoteFile(name: String): Boolean =
    !name.startsWith('.') && '.' in name && name.substringAfterLast('.', "").lowercase() in FOLDER_NOTE_EXTENSIONS

internal fun normalizeRelativePath(relative: String?): String =
    relative.orEmpty().split('/').map { it.trim() }
        .filter { it.isNotEmpty() && it != "." && it != ".." }
        .joinToString("/")

internal fun parentRelativePath(relative: String): String {
    val normalized = normalizeRelativePath(relative)
    return if ('/' in normalized) normalized.substringBeforeLast('/') else ""
}

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

    val rawExt = currentExtension.trimStart('.')
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
    val expectedLower = expected.lowercase()
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
    require(supplied.lowercase() !in (KNOWN_EXPORT_FORMATS - expectedLower)) {
        "Rename keeps the .$expected format. Use Export to change formats."
    }
    return "$trimmed.$expected"
}

internal data class ResolvedSafParentDirectory(
    val treeUri: Uri,
    val rootDocumentId: String,
    val parentDocumentId: String,
    val parentDocumentUri: Uri,
    val children: List<ProjectedSafChild>,
)

internal data class ProjectedSafSubtreeNode(
    val documentId: String,
    val treeDocumentUri: Uri,
    val displayName: String,
    val relativePath: String,
    val isDirectory: Boolean,
)

internal fun canonicalTreeScopedUri(treeUri: Uri, candidateUri: Uri): Uri {
    if (candidateUri.scheme != "content" || candidateUri.authority != treeUri.authority) return candidateUri
    val docId = runCatching { DocumentsContract.getDocumentId(candidateUri) }.getOrNull()?.takeIf { it.isNotEmpty() }
        ?: return candidateUri
    return DocumentsContract.buildDocumentUriUsingTree(treeUri, docId)
}

internal fun knownPathRelativeInTree(uri: Uri, treeUri: Uri): String? {
    if (uri.scheme != "content" || treeUri.scheme != "content" || uri.authority != treeUri.authority) return null
    if (!DocumentsContract.isTreeUri(treeUri) || !isKnownPathDocumentProvider(treeUri.authority)) return null
    val rootId = runCatching { DocumentsContract.getTreeDocumentId(treeUri) }.getOrNull() ?: return null
    val docId = runCatching { DocumentsContract.getDocumentId(uri) }.getOrNull() ?: return null
    val rootPath = parseExternalStorageDocumentId(rootId) ?: return null
    val docPath = parseExternalStorageDocumentId(docId) ?: return null
    if (rootPath.volume != docPath.volume || docPath.relativePath == rootPath.relativePath) return null
    val rawRel = when {
        rootPath.relativePath.isEmpty() -> docPath.relativePath
        docPath.relativePath.startsWith("${rootPath.relativePath}/") ->
            docPath.relativePath.removePrefix("${rootPath.relativePath}/")
        else -> return null
    }
    return normalizeRelativePath(rawRel).takeIf { it.isNotEmpty() }
}

internal fun resolveSafParentDirectory(
    documentAccess: DocumentAccess,
    pass: SafProjectionPass,
    folderUri: Uri,
    parentRelative: String,
): ResolvedSafParentDirectory {
    require(!hasInvalidSafFolderRelative(parentRelative)) { "Invalid folder path" }
    val (treeUri, rootDocumentId) = documentAccess.resolveReadableTreeRoot(folderUri)
        ?: error("Choose the folder again to restore access")
    val segments = normalizeRelativePath(parentRelative).split('/').filter { it.isNotEmpty() }
    var currentDocumentId = rootDocumentId
    for (segment in segments) {
        require(segment != "." && segment != ".." && !segment.startsWith('.')) { "Invalid folder path" }
        val children = when (val projection = pass.projectDirectory(treeUri, currentDocumentId)) {
            is SafProjectionPass.DirectoryProjection.Loaded -> projection.children
            SafProjectionPass.DirectoryProjection.Denied -> error("Choose the folder again to restore access")
            SafProjectionPass.DirectoryProjection.Missing,
            SafProjectionPass.DirectoryProjection.Unavailable -> error("Open folder is not accessible")
        }
        val next = children.firstOrNull { it.displayName == segment && !it.isVirtual }
            ?: error("Folder '$segment' no longer exists")
        require(next.isDirectory) { "'$segment' is not a folder" }
        currentDocumentId = next.documentId
    }
    val finalChildren = when (val projection = pass.projectDirectory(treeUri, currentDocumentId)) {
        is SafProjectionPass.DirectoryProjection.Loaded -> projection.children
        SafProjectionPass.DirectoryProjection.Denied -> error("Choose the folder again to restore access")
        SafProjectionPass.DirectoryProjection.Missing,
        SafProjectionPass.DirectoryProjection.Unavailable -> error("Open folder is not accessible")
    }
    return ResolvedSafParentDirectory(
        treeUri = treeUri,
        rootDocumentId = rootDocumentId,
        parentDocumentId = currentDocumentId,
        parentDocumentUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, currentDocumentId),
        children = finalChildren,
    )
}

internal fun findDuplicateProjectedChild(
    children: List<ProjectedSafChild>,
    treeUri: Uri,
    candidateName: String,
    ignoreUri: Uri? = null,
): ProjectedSafChild? =
    children.firstOrNull { child ->
        val childUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, child.documentId)
        !(ignoreUri != null && sameDocument(childUri, ignoreUri)) &&
            child.displayName.equals(candidateName, ignoreCase = true)
    }

internal fun collectSafSubtree(
    pass: SafProjectionPass,
    treeUri: Uri,
    directoryDocumentId: String,
    baseRelative: String,
): List<ProjectedSafSubtreeNode> {
    val cleanBase = normalizeRelativePath(baseRelative)
    val results = ArrayList<ProjectedSafSubtreeNode>()
    val visitedDirs = HashSet<String>()
    val queue = ArrayDeque<Triple<String, String, Int>>()
    if (visitedDirs.add(directoryDocumentId)) {
        queue.addLast(Triple(directoryDocumentId, cleanBase, 0))
    }
    var projectedDirs = 0
    while (queue.isNotEmpty() && projectedDirs < MAX_SAF_SUBTREE_DIRS) {
        val (currentDirId, currentRel, depth) = queue.removeFirst()
        projectedDirs++
        val projection = pass.projectDirectory(treeUri, currentDirId)
        if (projection !is SafProjectionPass.DirectoryProjection.Loaded) continue
        for (child in projection.children) {
            if (child.isVirtual || child.displayName.isEmpty()) continue
            val childRel = childRelativePath(currentRel, child.displayName)
            val childTreeUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, child.documentId)
            results.add(
                ProjectedSafSubtreeNode(
                    documentId = child.documentId,
                    treeDocumentUri = childTreeUri,
                    displayName = child.displayName,
                    relativePath = childRel,
                    isDirectory = child.isDirectory,
                ),
            )
            if (child.isDirectory && depth + 1 < MAX_SAF_SUBTREE_DEPTH && visitedDirs.add(child.documentId)) {
                queue.addLast(Triple(child.documentId, childRel, depth + 1))
            }
        }
    }
    return results
}

internal fun findRelativeInSafTree(
    pass: SafProjectionPass,
    documentAccess: DocumentAccess,
    folderUri: Uri,
    targetUri: Uri,
    preferredDirRelative: String? = null,
): String? {
    if (targetUri.scheme != "content" || folderUri.scheme != "content" || targetUri.authority != folderUri.authority) return null
    if (!DocumentsContract.isTreeUri(folderUri)) return null
    if (isKnownPathDocumentProvider(folderUri.authority)) {
        return knownPathRelativeInTree(targetUri, folderUri)
    }
    val targetDocId = runCatching { DocumentsContract.getDocumentId(targetUri) }.getOrNull()
        ?.takeIf { it.isNotEmpty() && '\u0000' !in it } ?: return null
    val (treeUri, rootDocId) = documentAccess.resolveReadableTreeRoot(folderUri) ?: return null
    if (targetDocId == rootDocId) return null

    if (preferredDirRelative != null && !hasInvalidSafFolderRelative(preferredDirRelative)) {
        val cleanPref = normalizeRelativePath(preferredDirRelative)
        val resolvedPref = runCatching { resolveSafParentDirectory(documentAccess, pass, treeUri, cleanPref) }.getOrNull()
        resolvedPref?.children?.firstOrNull { !it.isVirtual && it.documentId == targetDocId }?.let { match ->
            return childRelativePath(cleanPref, match.displayName)
        }
    }

    val visitedDirs = HashSet<String>()
    val queue = ArrayDeque<Triple<String, String, Int>>()
    visitedDirs.add(rootDocId)
    queue.addLast(Triple(rootDocId, "", 0))
    var projectedDirs = 0
    while (queue.isNotEmpty() && projectedDirs < MAX_SAF_OPEN_FOLDER_PROBE_DIRS) {
        val (dirId, dirRel, depth) = queue.removeFirst()
        projectedDirs++
        val projection = pass.projectDirectory(treeUri, dirId)
        if (projection !is SafProjectionPass.DirectoryProjection.Loaded) continue
        for (child in projection.children) {
            if (child.isVirtual || child.displayName.isEmpty()) continue
            val childRel = childRelativePath(dirRel, child.displayName)
            if (child.documentId == targetDocId) return childRel
            if (child.isDirectory && depth + 1 < MAX_SAF_SUBTREE_DEPTH && visitedDirs.add(child.documentId)) {
                queue.addLast(Triple(child.documentId, childRel, depth + 1))
            }
        }
    }
    return null
}
