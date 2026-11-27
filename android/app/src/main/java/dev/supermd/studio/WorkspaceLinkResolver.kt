package dev.supermd.studio

import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import androidx.documentfile.provider.DocumentFile

internal val WORKSPACE_NOTE_EXTENSIONS = listOf("md", "smd", "fmd", "markdown", "txt")

data class PendingHeadingJump(
    val noteId: String,
    val heading: String,
    val token: String,
)

data class WorkspaceFolderPrompt(
    val noteId: String,
    val noteName: String,
    val initialUri: Uri,
    val target: String,
    val fragment: String,
    val wikilink: Boolean,
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

internal data class WorkspaceTreeChild(
    val documentId: String,
    val name: String,
    val uri: Uri,
    val isDirectory: Boolean,
    val isVirtualOrLink: Boolean = false,
)

internal interface WorkspaceTreeLister {
    fun rootDocumentId(treeUri: Uri): String
    fun listChildren(treeUri: Uri, parentDocumentId: String): List<WorkspaceTreeChild>
}

internal class ContentResolverTreeLister(private val context: Context) : WorkspaceTreeLister {
    private val resolver: ContentResolver get() = context.contentResolver

    override fun rootDocumentId(treeUri: Uri): String = DocumentsContract.getTreeDocumentId(treeUri)

    override fun listChildren(treeUri: Uri, parentDocumentId: String): List<WorkspaceTreeChild> {
        val childrenUri = runCatching {
            DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentDocumentId)
        }.getOrNull()
        if (childrenUri != null) {
            val queried = try {
                val results = mutableListOf<WorkspaceTreeChild>()
                resolver.query(
                    childrenUri,
                    arrayOf(
                        DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                        DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                        DocumentsContract.Document.COLUMN_MIME_TYPE,
                        DocumentsContract.Document.COLUMN_FLAGS,
                    ),
                    null,
                    null,
                    null,
                )?.use { cursor ->
                    val idIdx = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
                    val nameIdx = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
                    val mimeIdx = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_MIME_TYPE)
                    val flagsIdx = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_FLAGS)
                    while (cursor.moveToNext()) {
                        val docId = if (idIdx >= 0 && !cursor.isNull(idIdx)) cursor.getString(idIdx) else continue
                        val name = if (nameIdx >= 0 && !cursor.isNull(nameIdx)) cursor.getString(nameIdx) else continue
                        if (name.isNullOrBlank()) continue
                        val mime = if (mimeIdx >= 0 && !cursor.isNull(mimeIdx)) cursor.getString(mimeIdx) else ""
                        val flags = if (flagsIdx >= 0 && !cursor.isNull(flagsIdx)) cursor.getInt(flagsIdx) else 0
                        val isDir = mime == DocumentsContract.Document.MIME_TYPE_DIR
                        if (!isDir) {
                            val (_, ext) = splitWorkspaceNameAndExt(name)
                            if (ext !in WORKSPACE_NOTE_EXTENSIONS) continue
                        }
                        val isVirtual = (flags and DocumentsContract.Document.FLAG_VIRTUAL_DOCUMENT) != 0
                        val childUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId)
                        results += WorkspaceTreeChild(
                            documentId = docId,
                            name = name,
                            uri = childUri,
                            isDirectory = isDir,
                            isVirtualOrLink = isVirtual,
                        )
                    }
                    results
                }
            } catch (security: SecurityException) {
                throw security
            } catch (_: Exception) {
                null
            }
            if (queried != null) return queried
        }

        // Fallback for providers that only expose DocumentFile traversal.
        val root = DocumentFile.fromTreeUri(context, treeUri) ?: return emptyList()
        val targetDir = if (parentDocumentId == rootDocumentId(treeUri)) {
            root
        } else {
            val rootId = rootDocumentId(treeUri)
            val rel = extractRelativeFromDocId(rootId, parentDocumentId) ?: return emptyList()
            var current: DocumentFile = root
            for (part in rel.split('/').filter { it.isNotEmpty() }) {
                current = current.findFile(part) ?: return emptyList()
            }
            current
        }
        return targetDir.listFiles().mapNotNull { file ->
            val name = file.name?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            val isDir = file.isDirectory
            if (!isDir) {
                val (_, ext) = splitWorkspaceNameAndExt(name)
                if (ext !in WORKSPACE_NOTE_EXTENSIONS) return@mapNotNull null
            }
            val docId = runCatching { DocumentsContract.getDocumentId(file.uri) }.getOrDefault(name)
            WorkspaceTreeChild(
                documentId = docId,
                name = name,
                uri = file.uri,
                isDirectory = isDir,
                isVirtualOrLink = file.isVirtual,
            )
        }
    }
}

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

private fun matchLocalChildSegment(
    dir: java.io.File,
    segment: String,
    exactCase: Boolean,
): java.io.File? {
    val direct = java.io.File(dir, segment)
    if (java.nio.file.Files.isSymbolicLink(direct.toPath())) {
        throw WorkspaceLinkException("Linked note symlink paths are not allowed.")
    }
    val entries = dir.listFiles()
        ?.sortedWith(compareBy<java.io.File> { it.name.lowercase() }.thenBy { it.name })
        ?: return null
    var foldedMatch: java.io.File? = null
    for (entry in entries) {
        val name = entry.name
        if (name.isEmpty()) continue
        if (name == segment) {
            if (java.nio.file.Files.isSymbolicLink(entry.toPath())) {
                throw WorkspaceLinkException("Linked note symlink paths are not allowed.")
            }
            return entry
        }
        if (!exactCase && foldedMatch == null && name.equals(segment, ignoreCase = true)) {
            if (java.nio.file.Files.isSymbolicLink(entry.toPath())) {
                throw WorkspaceLinkException("Linked note symlink paths are not allowed.")
            }
            foldedMatch = entry
        }
    }
    return if (exactCase) null else foldedMatch
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
    for (exactPass in listOf(true, false)) {
        for (parts in candidateLists) {
            var cur: java.io.File? = parentDir
            for (segment in parts) {
                cur = matchLocalChildSegment(cur!!, segment, exactCase = exactPass)
                if (cur == null) break
            }
            val matched = cur ?: continue
            if (!matched.isFile) continue
            val resolved = runCatching { matched.canonicalFile }.getOrNull() ?: continue
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
    }
    throw WorkspaceLinkException("Linked note not found: ${Uri.decode(cleaned)}")
}

internal data class WorkspaceCandidateBatch(
    val candidates: List<WorkspaceResolvedNote>,
    val fromCache: Boolean,
    val topCandidateIsExactCase: Boolean,
)

internal data class LocalTreeProbeResult(
    val matches: List<WorkspaceResolvedNote>,
    val allParentDirsListed: Boolean,
)

private fun extensionPriority(extLower: String): Int {
    val idx = WORKSPACE_NOTE_EXTENSIONS.indexOf(extLower)
    return if (idx >= 0) idx else WORKSPACE_NOTE_EXTENSIONS.size
}

/**
 * Bounded, in-memory cache of notes inside a granted SAF tree.
 * Never writes index files or hidden metadata to disk.
 */
internal class WorkspaceLinkCache(
    private val lister: WorkspaceTreeLister,
    private val maxFiles: Int = MAX_SCAN_FILES,
    private val maxDirectories: Int = MAX_SCAN_DIRECTORIES,
    private val maxDepth: Int = MAX_SCAN_DEPTH,
    private val ttlMillis: Long = CACHE_TTL_MILLIS,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private data class IndexedEntry(
        val uri: Uri,
        val documentId: String,
        val name: String,
        val stem: String,
        val stemLower: String,
        val extLower: String,
        val relative: String,
        val relativeLower: String,
        val relativeWithoutExt: String,
        val relativeWithoutExtLower: String,
        val depth: Int,
    )

    private data class CachedTree(
        val treeKey: String,
        val builtAtMillis: Long,
        val entries: List<IndexedEntry>,
        val byRelativeExact: Map<String, IndexedEntry>,
        val byRelativeLower: Map<String, IndexedEntry>,
    )

    @Volatile
    private var cached: CachedTree? = null
    private val lock = Any()

    fun invalidate() {
        synchronized(lock) {
            cached = null
        }
    }

    /**
     * Determines the note's relative path inside `treeUri` (e.g. `"sub/Note.md"`),
     * or `null` if `noteUri` does not belong to `treeUri`.
     */
    fun noteRelativeInTree(treeUri: Uri, noteUri: Uri, knownRelative: String? = null): String? {
        if (
            noteUri.scheme == "content" &&
            treeUri.scheme == "content" &&
            noteUri.authority == treeUri.authority &&
            isKnownPathDocumentProvider(treeUri.authority)
        ) {
            val rootId = runCatching { lister.rootDocumentId(treeUri) }.getOrNull()
            val docId = runCatching { DocumentsContract.getDocumentId(noteUri) }.getOrNull()
            if (rootId != null && docId != null && isKnownPathContainedInTree(treeUri.authority, rootId, docId)) {
                extractRelativeFromDocId(rootId, docId)?.takeIf { it.isNotEmpty() }?.let { return it }
            }
        }
        if (!knownRelative.isNullOrBlank()) {
            val knownParts = knownRelative.trim('/').split('/').filter { it.isNotEmpty() }
            if (knownParts.isNotEmpty()) {
                val probed = probeCandidateListsInTree(
                    treeUri = treeUri,
                    candidateLists = listOf(knownParts),
                    includeFoldedPass = true,
                )
                probed.matches.firstOrNull { sameDocument(it.uri, noteUri) }?.let { return it.relative }
            }
        }
        val index = ensureIndexed(treeUri)
        if (!knownRelative.isNullOrBlank()) {
            val cleaned = knownRelative.trim('/')
            index.byRelativeExact[cleaned]?.takeIf { sameDocument(it.uri, noteUri) }?.let { return it.relative }
            index.byRelativeLower[cleaned.lowercase()]?.takeIf { sameDocument(it.uri, noteUri) }?.let { return it.relative }
        }
        return index.entries.firstOrNull { sameDocument(it.uri, noteUri) }?.relative
    }

    /**
     * Probes specific relative path candidates directly via `lister.listChildren` without scanning
     * unrelated workspace directories. When `includeFoldedPass` is true, all `candidateLists` are
     * evaluated for exact segment casing first before falling back to case-folded segment matching.
     */
    fun probeCandidateListsInTree(
        treeUri: Uri,
        candidateLists: List<List<String>>,
        includeFoldedPass: Boolean,
        dirMemo: MutableMap<String, List<WorkspaceTreeChild>?> = HashMap(),
    ): LocalTreeProbeResult {
        val rootDocId = runCatching { lister.rootDocumentId(treeUri) }.getOrNull()
            ?: return LocalTreeProbeResult(emptyList(), allParentDirsListed = false)
        val seen = LinkedHashMap<String, WorkspaceResolvedNote>()
        var allListed = true

        fun listDir(docId: String, depth: Int): List<WorkspaceTreeChild>? {
            if (dirMemo.containsKey(docId)) return dirMemo[docId]
            val listed = try {
                lister.listChildren(treeUri, docId)
                    .filter { child ->
                        val n = child.name
                        n.isNotBlank() && !n.startsWith('.') && !child.isVirtualOrLink &&
                            !n.contains('/') && !n.contains('\\') && !n.contains('\u0000')
                    }
                    .sortedWith(compareBy<WorkspaceTreeChild> { it.name.lowercase() }.thenBy { it.name })
            } catch (security: SecurityException) {
                if (depth == 0) throw security
                null
            } catch (_: Exception) {
                null
            }
            dirMemo[docId] = listed
            return listed
        }

        val passes = if (includeFoldedPass) listOf(true, false) else listOf(true)
        for (exactPass in passes) {
            for (parts in candidateLists) {
                if (parts.isEmpty() || parts.size - 1 > maxDepth) continue
                var currentDocId = rootDocId
                var relPrefix = ""
                var failedListing = false
                var matchedNote: WorkspaceResolvedNote? = null
                for ((idx, segment) in parts.withIndex()) {
                    val children = listDir(currentDocId, idx)
                    if (children == null) {
                        failedListing = true
                        allListed = false
                        break
                    }
                    val isLast = idx == parts.lastIndex
                    val child = if (exactPass) {
                        children.firstOrNull { it.name == segment && it.isDirectory != isLast }
                    } else {
                        children.firstOrNull { it.name == segment && it.isDirectory != isLast }
                            ?: children.firstOrNull { it.name.equals(segment, ignoreCase = true) && it.isDirectory != isLast }
                    } ?: break
                    val currentRel = if (relPrefix.isEmpty()) child.name else "$relPrefix/${child.name}"
                    if (!isLast) {
                        currentDocId = child.documentId
                        relPrefix = currentRel
                    } else {
                        val (_, ext) = splitWorkspaceNameAndExt(child.name)
                        if (ext in WORKSPACE_NOTE_EXTENSIONS) {
                            matchedNote = WorkspaceResolvedNote(child.uri, child.name, currentRel)
                        }
                    }
                }
                if (!failedListing && matchedNote != null) {
                    seen.putIfAbsent(matchedNote.relative, matchedNote)
                }
            }
        }
        return LocalTreeProbeResult(seen.values.toList(), allListed)
    }

    fun resolve(
        treeUri: Uri,
        noteRelative: String?,
        rawTarget: String,
        wikilink: Boolean,
    ): WorkspaceResolvedNote =
        resolveCandidates(treeUri, noteRelative, rawTarget, wikilink).first()

    fun resolveCandidates(
        treeUri: Uri,
        noteRelative: String?,
        rawTarget: String,
        wikilink: Boolean,
    ): List<WorkspaceResolvedNote> {
        val cleaned = sanitizeWorkspaceLinkTarget(rawTarget)
        val batch = resolveCandidatesBatch(treeUri, noteRelative, rawTarget, wikilink)
        if (batch.candidates.isNotEmpty()) return batch.candidates
        val prefix = if (isExplicitRelativeWorkspaceTarget(cleaned, wikilink)) {
            "Linked note not found"
        } else {
            "Note not found in folder"
        }
        throw WorkspaceLinkException("$prefix: ${Uri.decode(cleaned)}")
    }

    fun resolveCandidatesBatch(
        treeUri: Uri,
        noteRelative: String?,
        rawTarget: String,
        wikilink: Boolean,
    ): WorkspaceCandidateBatch {
        val cleaned = sanitizeWorkspaceLinkTarget(rawTarget)
        val noteParentDir = noteRelative?.let { if ('/' in it) it.substringBeforeLast('/') else "" }
        if (isExplicitRelativeWorkspaceTarget(cleaned, wikilink)) {
            if (noteRelative == null) {
                throw WorkspaceLinkException("Choose the folder containing this note to follow relative links.")
            }
            val parentRelative = noteParentDir ?: ""
            val candidateLists = expandWorkspaceCandidatePaths(parentRelative, cleaned, wikilink)
            val (index, fromCache) = ensureIndexedWithState(treeUri)
            val found = ArrayList<WorkspaceResolvedNote>(2)
            var topIsExact = false
            for (exactOnly in listOf(true, false)) {
                for (parts in candidateLists) {
                    resolveRelativeCandidate(index, parts.joinToString("/"), exactOnly = exactOnly)?.let { candidate ->
                        if (found.none { it.relative == candidate.relative }) {
                            if (found.isEmpty() && exactOnly) topIsExact = true
                            found += candidate
                        }
                    }
                }
            }
            return WorkspaceCandidateBatch(found, fromCache, topIsExact)
        }

        // Wikilink resolution (sibling, root, or ranked basename/subpath inside the granted folder)
        val parts = workspaceRelativePathParts("", cleaned)
        val normalizedQuery = parts.joinToString("/")
        val queryLower = normalizedQuery.lowercase()
        val (_, queryExt) = splitWorkspaceNameAndExt(parts.last())
        val hasKnownNoteExt = queryExt in WORKSPACE_NOTE_EXTENSIONS
        val (index, fromCache) = ensureIndexedWithState(treeUri)
        val ordered = LinkedHashMap<String, WorkspaceResolvedNote>()

        if (noteParentDir != null) {
            val siblingRel = if (noteParentDir.isEmpty()) normalizedQuery else "$noteParentDir/$normalizedQuery"
            resolveRelativeCandidate(index, siblingRel, exactOnly = true)?.let { ordered.putIfAbsent(it.relative, it) }
        }

        if (parts.size > 1) {
            resolveRelativeCandidate(index, normalizedQuery, exactOnly = true)?.let { ordered.putIfAbsent(it.relative, it) }
            val suffixMatches = index.entries.filter { entry ->
                if (hasKnownNoteExt) {
                    entry.relativeLower == queryLower ||
                        entry.relativeLower.endsWith("/$queryLower")
                } else {
                    entry.relativeWithoutExtLower == queryLower ||
                        entry.relativeWithoutExtLower.endsWith("/$queryLower")
                }
            }
            for (entry in rankMatches(suffixMatches, noteParentDir) { entry ->
                if (hasKnownNoteExt) {
                    entry.relative == normalizedQuery || entry.relative.endsWith("/$normalizedQuery")
                } else {
                    entry.relativeWithoutExt == normalizedQuery || entry.relativeWithoutExt.endsWith("/$normalizedQuery")
                }
            }) {
                ordered.putIfAbsent(entry.relative, entry.toResolved())
            }
            val list = ordered.values.toList()
            val topExact = list.firstOrNull()?.let { top ->
                if (hasKnownNoteExt) {
                    top.relative == normalizedQuery || top.relative.endsWith("/$normalizedQuery")
                } else {
                    val (stem, _) = splitWorkspaceNameAndExt(top.name)
                    val topWithoutExt = if ('/' in top.relative) "${top.relative.substringBeforeLast('/')}/$stem" else stem
                    topWithoutExt == normalizedQuery || topWithoutExt.endsWith("/$normalizedQuery")
                }
            } ?: false
            return WorkspaceCandidateBatch(list, fromCache, topExact)
        }

        val targetSegment = parts.single()
        val targetNameLower = targetSegment.lowercase()
        val matches = index.entries.filter { entry ->
            if (hasKnownNoteExt) {
                entry.name.lowercase() == targetNameLower
            } else {
                entry.stemLower == targetNameLower || entry.name.lowercase() == targetNameLower
            }
        }
        for (entry in rankMatches(matches, noteParentDir) { entry ->
            if (hasKnownNoteExt) entry.name == targetSegment else entry.stem == targetSegment
        }) {
            ordered.putIfAbsent(entry.relative, entry.toResolved())
        }
        val list = ordered.values.toList()
        val topExact = list.firstOrNull()?.let { top ->
            if (hasKnownNoteExt) top.name == targetSegment else splitWorkspaceNameAndExt(top.name).first == targetSegment
        } ?: false
        return WorkspaceCandidateBatch(list, fromCache, topExact)
    }

    private fun resolveRelativeCandidate(
        index: CachedTree,
        candidateRel: String,
        exactOnly: Boolean = false,
    ): WorkspaceResolvedNote? {
        index.byRelativeExact[candidateRel]?.let { return it.toResolved() }
        if (!exactOnly) {
            index.byRelativeLower[candidateRel.lowercase()]?.let { return it.toResolved() }
        }
        val (_, ext) = splitWorkspaceNameAndExt(candidateRel.substringAfterLast('/'))
        if (ext !in WORKSPACE_NOTE_EXTENSIONS) {
            for (noteExt in WORKSPACE_NOTE_EXTENSIONS) {
                val withExt = "$candidateRel.$noteExt"
                index.byRelativeExact[withExt]?.let { return it.toResolved() }
                if (!exactOnly) {
                    index.byRelativeLower[withExt.lowercase()]?.let { return it.toResolved() }
                }
            }
        }
        return null
    }

    private fun rankMatches(
        matches: List<IndexedEntry>,
        noteParentDir: String?,
        exactCasePredicate: (IndexedEntry) -> Boolean,
    ): List<IndexedEntry> =
        matches.sortedWith(
            compareBy<IndexedEntry> { if (exactCasePredicate(it)) 0 else 1 }
                .thenBy { entry ->
                    val entryDir = if ('/' in entry.relative) entry.relative.substringBeforeLast('/') else ""
                    if (noteParentDir != null && entryDir.equals(noteParentDir, ignoreCase = true)) 0 else 1
                }
                .thenBy { it.depth }
                .thenBy { extensionPriority(it.extLower) }
                .thenBy { it.relativeLower }
                .thenBy { it.relative },
        )

    private fun IndexedEntry.toResolved() = WorkspaceResolvedNote(uri = uri, name = name, relative = relative)

    private fun ensureIndexed(treeUri: Uri): CachedTree =
        ensureIndexedWithState(treeUri).first

    private fun ensureIndexedWithState(treeUri: Uri): Pair<CachedTree, Boolean> {
        val key = treeUri.toString()
        val now = clock()
        cached?.takeIf { it.treeKey == key && now - it.builtAtMillis in 0..ttlMillis }?.let { return it to true }
        synchronized(lock) {
            val againNow = clock()
            cached?.takeIf { it.treeKey == key && againNow - it.builtAtMillis in 0..ttlMillis }?.let { return it to true }
            val built = scanTree(treeUri, key, againNow)
            cached = built
            return built to false
        }
    }

    private fun scanTree(treeUri: Uri, treeKey: String, now: Long): CachedTree {
        val rootDocId = lister.rootDocumentId(treeUri)
        val entries = ArrayList<IndexedEntry>()
        val byExact = LinkedHashMap<String, IndexedEntry>()
        val byLower = LinkedHashMap<String, IndexedEntry>()
        val queue = ArrayDeque<Triple<String, String, Int>>()
        queue.addLast(Triple(rootDocId, "", 0))
        val visitedDirs = HashSet<String>()
        visitedDirs.add(rootDocId)
        var scannedDirs = 0

        while (queue.isNotEmpty() && scannedDirs < maxDirectories && entries.size < maxFiles) {
            val (dirDocId, prefix, depth) = queue.removeFirst()
            scannedDirs++
            val children = (if (depth == 0) {
                lister.listChildren(treeUri, dirDocId)
            } else {
                runCatching { lister.listChildren(treeUri, dirDocId) }.getOrDefault(emptyList())
            }).sortedWith(compareBy<WorkspaceTreeChild> { it.name.lowercase() }.thenBy { it.name })
            for (child in children) {
                val name = child.name
                if (name.isBlank() || name.startsWith('.') || child.isVirtualOrLink) continue
                if (name.contains('/') || name.contains('\\') || name.contains('\u0000')) continue
                val relative = if (prefix.isEmpty()) name else "$prefix/$name"
                if (child.isDirectory) {
                    if (depth + 1 <= maxDepth && visitedDirs.add(child.documentId) && scannedDirs + queue.size < maxDirectories) {
                        queue.addLast(Triple(child.documentId, relative, depth + 1))
                    }
                } else {
                    if (entries.size >= maxFiles) break
                    val (stem, ext) = splitWorkspaceNameAndExt(name)
                    if (ext !in WORKSPACE_NOTE_EXTENSIONS) continue
                    val relativeLower = relative.lowercase()
                    val withoutExt = if (prefix.isEmpty()) stem else "$prefix/$stem"
                    val entry = IndexedEntry(
                        uri = child.uri,
                        documentId = child.documentId,
                        name = name,
                        stem = stem,
                        stemLower = stem.lowercase(),
                        extLower = ext,
                        relative = relative,
                        relativeLower = relativeLower,
                        relativeWithoutExt = withoutExt,
                        relativeWithoutExtLower = withoutExt.lowercase(),
                        depth = depth,
                    )
                    entries += entry
                    byExact.putIfAbsent(relative, entry)
                    byLower.putIfAbsent(relativeLower, entry)
                }
            }
        }

        return CachedTree(
            treeKey = treeKey,
            builtAtMillis = now,
            entries = entries,
            byRelativeExact = byExact,
            byRelativeLower = byLower,
        )
    }

    companion object {
        const val MAX_SCAN_FILES = 6_000
        const val MAX_SCAN_DIRECTORIES = 2_000
        const val MAX_SCAN_DEPTH = 16
        const val CACHE_TTL_MILLIS = 5_000L
    }
}
