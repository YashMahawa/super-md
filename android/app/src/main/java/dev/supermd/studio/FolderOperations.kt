package dev.supermd.studio

import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import androidx.documentfile.provider.DocumentFile

internal val FOLDER_NOTE_EXTENSIONS = setOf("md", "smd", "markdown", "fmd", "txt")

data class FolderPickerItem(
    val name: String,
    val relative: String,
    val depth: Int,
    val expanded: Boolean,
    val expandable: Boolean,
    val isRoot: Boolean,
)

data class MoveImagesPrompt(
    val entryUri: String,
    val entryRelative: String,
    val isDirectory: Boolean,
    val targetRelative: String,
    val entryName: String,
    val imageCount: Int,
    val canCopy: Boolean,
)

internal data class SafLinkedAssetPlan(
    val sourceReference: String,
    val sourceFile: DocumentFile,
    val destSegments: List<String>?,
)

internal data class SafMarkdownMoveInspection(
    val affectedCount: Int,
    val copyPlans: List<SafLinkedAssetPlan>,
    val canCopyAll: Boolean,
)

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

internal fun isSameOrDescendantFolder(folderRelative: String, targetParentRelative: String): Boolean {
    val source = normalizeRelativePath(folderRelative)
    val target = normalizeRelativePath(targetParentRelative)
    return source.isNotEmpty() && (target == source || target.startsWith("$source/"))
}

internal fun ancestorRelativePaths(relative: String): Set<String> {
    val clean = normalizeRelativePath(relative)
    if (clean.isEmpty()) return setOf("")
    val result = linkedSetOf("")
    var current = ""
    for (part in clean.split('/')) {
        current = if (current.isEmpty()) part else "$current/$part"
        result.add(current)
    }
    return result
}

/**
 * Validates a note or subfolder name for creation or rename.
 * Preserves the note extension when omitted, rejects mismatched extensions,
 * and rejects `.` / `..`, hidden names starting with `.`, and path separators.
 */
internal fun validateFolderEntryName(
    rawName: String,
    isDirectory: Boolean,
    currentExtension: String = "",
): String {
    val trimmed = rawName.trim()
    require(trimmed.isNotEmpty()) { "Enter a name" }
    require(trimmed != "." && trimmed != "..") { "Choose a name other than '.' or '..'" }
    require(!trimmed.any { it == '/' || it == '\\' || it == '\u0000' }) {
        "Choose a name without path separators"
    }
    require(!trimmed.startsWith('.')) {
        "Names starting with '.' are hidden and not supported"
    }
    require(trimmed.length <= 240) { "Choose a shorter name" }
    if (isDirectory) return trimmed

    val expected = currentExtension.trimStart('.').lowercase().ifEmpty { "md" }
    val dot = trimmed.lastIndexOf('.')
    if (dot < 0) return "$trimmed.$expected"
    val stem = trimmed.substring(0, dot).trim()
    val supplied = trimmed.substring(dot + 1)
    require(stem.isNotEmpty() && stem != "." && stem != "..") { "Enter a valid note name" }
    require(supplied.equals(expected, ignoreCase = true)) {
        "Rename keeps the .$expected format. Use Export to change formats."
    }
    return "$stem.$expected"
}

private val FENCED_CODE_REGEX = Regex("(?m)^[ ]{0,3}(`{3,}|~{3,})[^\\n]*\\n[\\s\\S]*?(?:^[ ]{0,3}\\1[ \\t]*$|\\z)")
private val INLINE_CODE_REGEX = Regex("(`+)([^`]|\\n)*?\\1")
private val INLINE_LINK_OR_IMAGE_REGEX = Regex(
    "(!?)\\[(?:\\\\.|[^\\]])*\\]\\(\\s*(?:<([^>\\n]+)>|([^\\s)]+))(?:\\s+(?:\"[^\"]*\"|'[^']*'|\\([^)]*\\)))?\\s*\\)"
)
private val REF_DEF_REGEX = Regex("(?m)^[ ]{0,3}\\[([^\\]]+)\\]:\\s*<?([^\\s>]+)>?")
private val REF_USAGE_REGEX = Regex("(!?)\\[(?:\\\\.|[^\\]])*\\]\\[([^\\]]*)\\]|(!)\\[([^\\]]+)\\]")
private val WIKILINK_EMBED_REGEX = Regex("!\\[\\[([^\\]|#\\n]+)(?:[|#][^\\]]*)?\\]\\]")
private val SCHEME_REGEX = Regex("^[a-zA-Z][a-zA-Z0-9+.-]*:")
private val DIAGRAM_LINK_EXTENSIONS = setOf("svg", "mmd", "mermaid")
private val EMBED_ASSET_EXTENSIONS = setOf(
    "png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp", "ico", "mmd", "mermaid"
)

private fun maskCodeRegions(markdown: String): String {
    val chars = markdown.toCharArray()
    fun blankRange(range: IntRange) {
        for (i in range) {
            if (chars[i] != '\n' && chars[i] != '\r') chars[i] = ' '
        }
    }
    FENCED_CODE_REGEX.findAll(markdown).forEach { blankRange(it.range) }
    val afterFences = String(chars)
    INLINE_CODE_REGEX.findAll(afterFences).forEach { blankRange(it.range) }
    return String(chars)
}

private fun normalizeRelativeAssetCandidate(raw: String): String? {
    val trimmed = raw.trim()
    if (trimmed.isEmpty()) return null
    if (trimmed.startsWith('#') || trimmed.startsWith('/') || trimmed.startsWith("//")) return null
    if (trimmed.contains('\\') || trimmed.contains('\u0000')) return null
    if (SCHEME_REGEX.containsMatchIn(trimmed)) return null
    val withoutQuery = trimmed.substringBefore('#').substringBefore('?').trim()
    if (withoutQuery.isEmpty()) return null
    val decoded = Uri.decode(withoutQuery).trim()
    if (decoded.isEmpty() || decoded.startsWith('/') || decoded.contains('\\') || decoded.contains('\u0000')) {
        return null
    }
    return decoded
}

/**
 * Extracts local relative image and diagram paths referenced by a plain Markdown document,
 * ignoring fenced code blocks, inline code spans, external URLs, data URIs, and root-anchored paths.
 */
internal fun findLinkedRelativeAssets(markdown: String): List<String> {
    if (markdown.isBlank()) return emptyList()
    val masked = maskCodeRegions(markdown)
    val results = linkedSetOf<String>()

    val refDefs = mutableMapOf<String, String>()
    for (match in REF_DEF_REGEX.findAll(masked)) {
        val label = match.groupValues[1].trim().lowercase()
        val target = match.groupValues[2].trim()
        if (label.isNotEmpty() && target.isNotEmpty()) {
            refDefs.putIfAbsent(label, target)
        }
    }

    for (match in INLINE_LINK_OR_IMAGE_REGEX.findAll(masked)) {
        val isImage = match.groupValues[1] == "!"
        val rawTarget = match.groupValues[2].ifEmpty { match.groupValues[3] }
        val candidate = normalizeRelativeAssetCandidate(rawTarget) ?: continue
        val ext = candidate.substringAfterLast('.', "").lowercase()
        if (isImage || ext in DIAGRAM_LINK_EXTENSIONS) {
            results.add(candidate)
        }
    }

    if (refDefs.isNotEmpty()) {
        for (match in REF_USAGE_REGEX.findAll(masked)) {
            val bang = match.groupValues[1].ifEmpty { match.groupValues[3] }
            val rawLabel = if (match.groupValues[3].isNotEmpty()) {
                match.groupValues[4]
            } else {
                match.groupValues[2].ifEmpty {
                    match.value.removePrefix(bang).substringAfter('[').substringBefore(']')
                }
            }
            val target = refDefs[rawLabel.trim().lowercase()] ?: continue
            val candidate = normalizeRelativeAssetCandidate(target) ?: continue
            val ext = candidate.substringAfterLast('.', "").lowercase()
            if (bang == "!" || ext in DIAGRAM_LINK_EXTENSIONS) {
                results.add(candidate)
            }
        }
    }

    for (match in WIKILINK_EMBED_REGEX.findAll(masked)) {
        val candidate = normalizeRelativeAssetCandidate(match.groupValues[1]) ?: continue
        val ext = candidate.substringAfterLast('.', "").lowercase()
        if (ext in EMBED_ASSET_EXTENSIONS) {
            results.add(candidate)
        }
    }

    return results.toList()
}

internal fun resolveRelativeSegmentsInTree(baseDirRelative: String, rawRelativeRef: String): List<String>? {
    val stack = normalizeRelativePath(baseDirRelative)
        .split('/')
        .filter { it.isNotEmpty() }
        .toMutableList()
    val parts = rawRelativeRef.split('/')
    for (part in parts) {
        when {
            part.isEmpty() || part == "." -> Unit
            part == ".." -> {
                if (stack.isEmpty()) return null
                stack.removeAt(stack.lastIndex)
            }
            part.contains('\u0000') || part.contains('\\') -> return null
            else -> stack.add(part)
        }
    }
    return if (stack.isEmpty()) null else stack
}

internal fun resolveTreeDirectory(treeRoot: DocumentFile, relative: String): DocumentFile {
    var current = treeRoot
    require(current.isDirectory) { "Open folder is not accessible" }
    val segments = normalizeRelativePath(relative).split('/').filter { it.isNotEmpty() }
    for (segment in segments) {
        require(segment != "." && segment != ".." && !segment.startsWith('.')) { "Invalid folder path" }
        val next = current.findFile(segment) ?: error("Folder '$segment' no longer exists")
        require(next.isDirectory) { "'$segment' is not a folder" }
        current = next
    }
    return current
}

internal fun resolveTreeEntry(treeRoot: DocumentFile, relative: String): DocumentFile? {
    var current: DocumentFile = treeRoot
    val segments = normalizeRelativePath(relative).split('/').filter { it.isNotEmpty() }
    for (segment in segments) {
        if (segment.isEmpty() || segment == "." || segment == "..") return null
        current = current.findFile(segment) ?: return null
    }
    return current
}

internal fun findDuplicateInDirectory(parentDir: DocumentFile, candidateName: String, ignoreUri: Uri? = null): DocumentFile? =
    parentDir.listFiles().firstOrNull { child ->
        val existingName = child.name ?: return@firstOrNull false
        val sameTarget = ignoreUri != null && sameDocument(child.uri, ignoreUri)
        !sameTarget && existingName.equals(candidateName, ignoreCase = true)
    }

internal fun inspectMovedMarkdownSafAssets(
    treeRoot: DocumentFile,
    markdown: String,
    oldNoteRelative: String,
    targetParentRelative: String,
): SafMarkdownMoveInspection {
    val oldParent = parentRelativePath(oldNoteRelative)
    val newParent = normalizeRelativePath(targetParentRelative)
    if (oldParent == newParent) return SafMarkdownMoveInspection(0, emptyList(), true)
    val refs = findLinkedRelativeAssets(markdown)
    if (refs.isEmpty()) return SafMarkdownMoveInspection(0, emptyList(), true)

    val plans = mutableListOf<SafLinkedAssetPlan>()
    var canCopyAll = true
    for (ref in refs) {
        val srcSegments = resolveRelativeSegmentsInTree(oldParent, ref) ?: continue
        val srcFile = resolveTreeEntry(treeRoot, srcSegments.joinToString("/"))
        if (srcFile == null || !srcFile.isFile) continue
        val dstSegments = resolveRelativeSegmentsInTree(newParent, ref)
        if (dstSegments == null) {
            canCopyAll = false
            plans.add(SafLinkedAssetPlan(ref, srcFile, null))
            continue
        }
        if (dstSegments == srcSegments) continue
        if (dstSegments.any { it.startsWith('.') }) {
            canCopyAll = false
            plans.add(SafLinkedAssetPlan(ref, srcFile, null))
            continue
        }
        val existingDest = resolveTreeEntry(treeRoot, dstSegments.joinToString("/"))
        if (existingDest != null && existingDest.isFile) continue
        if (existingDest != null && existingDest.isDirectory) {
            canCopyAll = false
            plans.add(SafLinkedAssetPlan(ref, srcFile, null))
            continue
        }
        plans.add(SafLinkedAssetPlan(ref, srcFile, dstSegments))
    }
    return SafMarkdownMoveInspection(plans.size, plans, canCopyAll)
}

internal fun copyMovedMarkdownSafAssets(
    resolver: ContentResolver,
    treeRoot: DocumentFile,
    plans: List<SafLinkedAssetPlan>,
    mimeForFile: (String, String?) -> String,
) {
    for (plan in plans) {
        val segments = plan.destSegments ?: error("Linked image '${plan.sourceReference}' resolves outside the open folder")
        var currentDir = treeRoot
        for (folderName in segments.dropLast(1)) {
            val existing = currentDir.findFile(folderName)
            currentDir = when {
                existing == null -> currentDir.createDirectory(folderName)
                    ?: error("Could not create image folder '$folderName'")
                existing.isDirectory -> existing
                else -> error("Cannot create folder '$folderName' because a file has that name")
            }
        }
        val fileName = segments.last()
        val existing = currentDir.findFile(fileName)
        if (existing != null) {
            require(existing.isFile) { "Cannot copy image '$fileName' over a folder" }
            continue
        }
        val mime = mimeForFile(fileName, resolver.getType(plan.sourceFile.uri))
        val created = currentDir.createFile(mime, fileName) ?: error("Could not create image '$fileName'")
        try {
            resolver.openInputStream(plan.sourceFile.uri)?.use { input ->
                resolver.openOutputStream(created.uri, "wt")?.use { output ->
                    input.copyTo(output)
                    output.flush()
                } ?: error("Could not open '$fileName' for writing")
            } ?: error("Could not read source image '$fileName'")
        } catch (error: Exception) {
            runCatching { created.delete() }
            throw error
        }
    }
}

/**
 * Lazily lists folders for the Move-to-Folder picker.
 * Only lists immediate children of the open root and explicitly expanded folders.
 */
internal fun listMovePickerTargetsLazy(
    treeRoot: DocumentFile,
    rootLabel: String,
    excludeFolderRelative: String?,
    expandedRelatives: Set<String>,
): List<FolderPickerItem> {
    val cleanExclude = excludeFolderRelative?.let(::normalizeRelativePath)?.takeIf { it.isNotEmpty() }
    val normalizedExpanded = expandedRelatives.map(::normalizeRelativePath).toSet() + ""
    val items = mutableListOf<FolderPickerItem>()

    fun childDirectories(dir: DocumentFile, parentRel: String): List<Pair<DocumentFile, String>> =
        dir.listFiles().mapNotNull { entry ->
            val name = entry.name ?: return@mapNotNull null
            if (!entry.isDirectory || name.startsWith('.')) return@mapNotNull null
            val rel = childRelativePath(parentRel, name)
            if (cleanExclude != null && (rel == cleanExclude || rel.startsWith("$cleanExclude/"))) {
                return@mapNotNull null
            }
            entry to rel
        }.sortedBy { it.first.name?.lowercase().orEmpty() }

    val rootChildren = childDirectories(treeRoot, "")
    items.add(
        FolderPickerItem(
            name = rootLabel.ifBlank { "Folder root" },
            relative = "",
            depth = 0,
            expanded = true,
            expandable = rootChildren.isNotEmpty(),
            isRoot = true,
        )
    )

    fun visit(children: List<Pair<DocumentFile, String>>, depth: Int) {
        if (depth > 32) return
        for ((dir, rel) in children) {
            val isExpanded = rel in normalizedExpanded
            val grandChildren = if (isExpanded) childDirectories(dir, rel) else emptyList()
            items.add(
                FolderPickerItem(
                    name = dir.name ?: rel.substringAfterLast('/'),
                    relative = rel,
                    depth = depth,
                    expanded = isExpanded,
                    expandable = if (isExpanded) grandChildren.isNotEmpty() else true,
                    isRoot = false,
                )
            )
            if (isExpanded && grandChildren.isNotEmpty()) {
                visit(grandChildren, depth + 1)
            }
        }
    }

    visit(rootChildren, 1)
    return items
}

internal fun safAssetMimeForName(name: String, providerMime: String?): String {
    val cleanProvider = providerMime?.substringBefore(';')?.lowercase()
    if (!cleanProvider.isNullOrBlank() && cleanProvider != "application/octet-stream") {
        return cleanProvider
    }
    return when (name.substringAfterLast('.', "").lowercase()) {
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "gif" -> "image/gif"
        "webp" -> "image/webp"
        "avif" -> "image/avif"
        "svg" -> "image/svg+xml"
        "mmd", "mermaid", "txt" -> "text/plain"
        "smd" -> "application/vnd.supermd.smd"
        "fmd" -> "application/vnd.supermd.fmd"
        "md", "markdown" -> "text/markdown"
        else -> "application/octet-stream"
    }
}

/**
 * Moves a SAF document or folder within an open tree.
 * Uses [DocumentsContract.moveDocument] first; if the provider does not support moving,
 * falls back to copying within the granted tree and deleting the source only after verification.
 */
internal fun moveSafDocumentWithinTree(
    context: Context,
    resolver: ContentResolver,
    sourceDoc: DocumentFile,
    sourceParentDoc: DocumentFile,
    targetParentDoc: DocumentFile,
): DocumentFile {
    val expectedName = sourceDoc.name ?: error("Source entry has no name")
    val movedUri = try {
        DocumentsContract.moveDocument(resolver, sourceDoc.uri, sourceParentDoc.uri, targetParentDoc.uri)
    } catch (_: UnsupportedOperationException) {
        null
    } catch (_: IllegalArgumentException) {
        null
    }
    if (movedUri != null) {
        return targetParentDoc.findFile(expectedName)
            ?: DocumentFile.fromSingleUri(context, movedUri)
            ?: error("Moved item could not be resolved in destination folder")
    }

    val copied = copySafEntryRecursively(resolver, sourceDoc, targetParentDoc)
    if (!sourceDoc.delete()) {
        runCatching { copied.delete() }
        error("Could not remove original item after copying; move was rolled back")
    }
    return copied
}

private fun copySafEntryRecursively(
    resolver: ContentResolver,
    source: DocumentFile,
    targetParent: DocumentFile,
    depth: Int = 0,
): DocumentFile {
    require(depth <= 32) { "Folder nesting is too deep to copy safely" }
    val name = source.name ?: error("Cannot copy unnamed entry")
    if (source.isDirectory) {
        val createdDir = targetParent.createDirectory(name) ?: error("Could not create folder '$name'")
        try {
            for (child in source.listFiles()) {
                copySafEntryRecursively(resolver, child, createdDir, depth + 1)
            }
            return createdDir
        } catch (error: Exception) {
            runCatching { createdDir.delete() }
            throw error
        }
    } else {
        val mime = safAssetMimeForName(name, resolver.getType(source.uri))
        val createdFile = targetParent.createFile(mime, name) ?: error("Could not create file '$name'")
        try {
            resolver.openInputStream(source.uri)?.use { input ->
                resolver.openOutputStream(createdFile.uri, "wt")?.use { output ->
                    input.copyTo(output)
                    output.flush()
                } ?: error("Could not write moved file '$name'")
            } ?: error("Could not read source file '$name'")
            return createdFile
        } catch (error: Exception) {
            runCatching { createdFile.delete() }
            throw error
        }
    }
}
