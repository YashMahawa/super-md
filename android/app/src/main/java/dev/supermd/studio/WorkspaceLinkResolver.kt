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
 * Never opens `appassets.androidplatform.net` URLs in an external browser.
 */
internal fun classifyReaderNavigationUrl(url: Uri, isForMainFrame: Boolean): ReaderUrlDecision {
    if (url.host.equals("appassets.androidplatform.net", ignoreCase = true)) {
        return if (url.path == "/assets/web/android-reader.html") ReaderUrlDecision.ALLOW_READER
        else ReaderUrlDecision.BLOCK_INTERNAL
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
            val queried = runCatching {
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
            }.getOrNull()
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
            val docId = runCatching { DocumentsContract.getDocumentId(file.uri) }.getOrDefault(name)
            WorkspaceTreeChild(
                documentId = docId,
                name = name,
                uri = file.uri,
                isDirectory = file.isDirectory,
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

/**
 * Resolves a workspace-relative path against `parentRelative` without allowing
 * absolute paths, URL schemes, encoded path separators, or `..` escapes above the folder root.
 */
internal fun workspaceRelativePathParts(parentRelative: String, rawTarget: String): List<String> =
    try {
        readerAssetPathParts(parentRelative.replace('\\', '/').trim('/'), rawTarget.trim())
    } catch (_: IllegalStateException) {
        throw WorkspaceLinkException("Links cannot navigate outside the open folder.")
    } catch (error: IllegalArgumentException) {
        throw WorkspaceLinkException(
            if (error.message?.contains("Encoded path separators") == true) {
                "Encoded path separators are not allowed in note links."
            } else {
                "Invalid note link."
            },
        )
    }

private fun extensionPriority(extLower: String): Int {
    val idx = WORKSPACE_NOTE_EXTENSIONS.indexOf(extLower)
    return if (idx >= 0) idx else WORKSPACE_NOTE_EXTENSIONS.size
}

private fun splitNameAndExt(name: String): Pair<String, String> {
    val dot = name.lastIndexOf('.')
    return if (dot <= 0 || dot == name.lastIndex) {
        name to ""
    } else {
        name.substring(0, dot) to name.substring(dot + 1).lowercase()
    }
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
        val stemLower: String,
        val extLower: String,
        val relative: String,
        val relativeLower: String,
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
        if (noteUri.scheme == "content" && treeUri.scheme == "content" && noteUri.authority == treeUri.authority) {
            val rootId = runCatching { lister.rootDocumentId(treeUri) }.getOrNull()
            val docId = runCatching { DocumentsContract.getDocumentId(noteUri) }.getOrNull()
            if (rootId != null && docId != null) {
                extractRelativeFromDocId(rootId, docId)?.takeIf { it.isNotEmpty() }?.let { return it }
            }
        }
        val index = ensureIndexed(treeUri)
        if (!knownRelative.isNullOrBlank()) {
            val cleaned = knownRelative.trim('/')
            index.byRelativeExact[cleaned]?.takeIf { sameDocument(it.uri, noteUri) }?.let { return it.relative }
        }
        return index.entries.firstOrNull { sameDocument(it.uri, noteUri) }?.relative
    }

    fun resolve(
        treeUri: Uri,
        noteRelative: String?,
        rawTarget: String,
        wikilink: Boolean,
    ): WorkspaceResolvedNote {
        val cleaned = rawTarget.trim().substringBefore('#').substringBefore('?').trim()
        if (cleaned.isEmpty()) {
            throw WorkspaceLinkException("Link target is empty.")
        }
        if (isExplicitRelativeWorkspaceTarget(cleaned, wikilink)) {
            if (noteRelative == null) {
                throw WorkspaceLinkException("Choose the folder containing this note to follow relative links.")
            }
            val parentRelative = noteRelative.substringBeforeLast('/', "")
            val parts = workspaceRelativePathParts(parentRelative, cleaned)
            val candidateRel = parts.joinToString("/")
            val index = ensureIndexed(treeUri)
            resolveRelativeCandidate(index, candidateRel)?.let { return it }
            throw WorkspaceLinkException("Note not found: ${Uri.decode(cleaned)}")
        }

        // Wikilink resolution (basename or subpath inside the granted folder)
        val parts = workspaceRelativePathParts("", cleaned)
        val normalizedQuery = parts.joinToString("/")
        val queryLower = normalizedQuery.lowercase()
        val (_, queryExt) = splitNameAndExt(parts.last())
        val hasKnownNoteExt = queryExt in WORKSPACE_NOTE_EXTENSIONS
        val index = ensureIndexed(treeUri)

        if (parts.size > 1) {
            resolveRelativeCandidate(index, normalizedQuery)?.let { return it }
            val suffixMatches = index.entries.filter { entry ->
                if (hasKnownNoteExt) {
                    entry.relativeLower.endsWith("/$queryLower")
                } else {
                    entry.relativeWithoutExtLower == queryLower ||
                        entry.relativeWithoutExtLower.endsWith("/$queryLower")
                }
            }
            pickBestMatch(suffixMatches)?.let { return it.toResolved() }
            throw WorkspaceLinkException("Note not found in folder: ${Uri.decode(cleaned)}")
        }

        val targetNameLower = parts.single().lowercase()
        val matches = index.entries.filter { entry ->
            if (hasKnownNoteExt) {
                entry.name.lowercase() == targetNameLower
            } else {
                entry.stemLower == targetNameLower || entry.name.lowercase() == targetNameLower
            }
        }
        pickBestMatch(matches)?.let { return it.toResolved() }
        throw WorkspaceLinkException("Note not found in folder: ${Uri.decode(cleaned)}")
    }

    private fun resolveRelativeCandidate(index: CachedTree, candidateRel: String): WorkspaceResolvedNote? {
        index.byRelativeExact[candidateRel]?.let { return it.toResolved() }
        index.byRelativeLower[candidateRel.lowercase()]?.let { return it.toResolved() }
        val (_, ext) = splitNameAndExt(candidateRel.substringAfterLast('/'))
        if (ext !in WORKSPACE_NOTE_EXTENSIONS) {
            for (noteExt in WORKSPACE_NOTE_EXTENSIONS) {
                val withExt = "$candidateRel.$noteExt"
                index.byRelativeExact[withExt]?.let { return it.toResolved() }
                index.byRelativeLower[withExt.lowercase()]?.let { return it.toResolved() }
            }
        }
        return null
    }

    private fun pickBestMatch(matches: List<IndexedEntry>): IndexedEntry? =
        matches.minWithOrNull(
            compareBy<IndexedEntry> { it.depth }
                .thenBy { extensionPriority(it.extLower) }
                .thenBy { it.relativeLower },
        )

    private fun IndexedEntry.toResolved() = WorkspaceResolvedNote(uri = uri, name = name, relative = relative)

    private fun ensureIndexed(treeUri: Uri): CachedTree {
        val key = treeUri.toString()
        val now = clock()
        cached?.takeIf { it.treeKey == key && now - it.builtAtMillis in 0..ttlMillis }?.let { return it }
        synchronized(lock) {
            val againNow = clock()
            cached?.takeIf { it.treeKey == key && againNow - it.builtAtMillis in 0..ttlMillis }?.let { return it }
            val built = scanTree(treeUri, key, againNow)
            cached = built
            return built
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
            val children = runCatching { lister.listChildren(treeUri, dirDocId) }.getOrDefault(emptyList())
                .sortedBy { it.name.lowercase() }
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
                    val (stem, ext) = splitNameAndExt(name)
                    if (ext !in WORKSPACE_NOTE_EXTENSIONS) continue
                    val relativeLower = relative.lowercase()
                    val withoutExt = if (prefix.isEmpty()) stem else "$prefix/$stem"
                    val entry = IndexedEntry(
                        uri = child.uri,
                        documentId = child.documentId,
                        name = name,
                        stemLower = stem.lowercase(),
                        extLower = ext,
                        relative = relative,
                        relativeLower = relativeLower,
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
