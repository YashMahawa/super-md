package dev.supermd.studio

import android.content.Context
import android.net.Uri
import androidx.documentfile.provider.DocumentFile
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import java.io.File
import java.io.InputStream
import java.nio.file.Files

internal val SEARCHABLE_NOTE_EXTENSIONS = setOf("md", "smd", "fmd", "markdown", "txt")
internal const val MAX_FOLDER_SCAN_ENTRIES = 5_000
internal const val MAX_FOLDER_SCAN_DEPTH = 24
internal const val MAX_FOLDER_FILE_BYTES = 120_000_000L
internal const val MAX_PLAIN_SEARCH_BYTES = 5_000_000
internal const val MAX_QUICK_SWITCHER_RESULTS = 80
internal const val MAX_FOLDER_SEARCH_MATCHES = 300
private const val STREAM_BATCH_SIZE = 16

data class QuickSwitcherItem(
    val key: String,
    val name: String,
    val subtitle: String,
    val tabId: String? = null,
    val uri: String? = null,
    val relative: String? = null,
    val isOpen: Boolean = false,
    val pinned: Boolean = false,
    val isRecent: Boolean = false,
    val dirty: Boolean = false,
    val score: Int = 0,
)

data class QuickSwitcherState(
    val visible: Boolean = false,
    val query: String = "",
    val items: List<QuickSwitcherItem> = emptyList(),
    val loading: Boolean = false,
)

data class FolderSearchMatch(
    val key: String,
    val name: String,
    val relative: String,
    val uri: String? = null,
    val tabId: String? = null,
    val line: Int,
    val column: Int,
    val snippet: String,
    val dirty: Boolean = false,
)

data class FolderSearchState(
    val visible: Boolean = false,
    val query: String = "",
    val caseSensitive: Boolean = false,
    val includeDiagrams: Boolean = false,
    val scanning: Boolean = false,
    val scannedFiles: Int = 0,
    val truncated: Boolean = false,
    val matches: List<FolderSearchMatch> = emptyList(),
)

/** Step up one relative folder level ("a/b/c" -> "a/b", "a" -> ""). */
internal fun parentRelativePath(relative: String): String {
    val normalized = relative.trim('/')
    if (normalized.isEmpty()) return ""
    return normalized.substringBeforeLast('/', "")
}

internal fun isSearchableNoteName(name: String): Boolean {
    if (name.isBlank() || name.startsWith('.')) return false
    val ext = name.substringAfterLast('.', "").lowercase()
    return ext in SEARCHABLE_NOTE_EXTENSIONS
}

private val DIAGRAM_FENCE_LANGUAGES = setOf("svg", "svg+xml", "image/svg+xml", "mermaid", "smd-chart")
private val FENCE_OPEN_RE = Regex("^[ \\t]{0,3}(`{3,}|~{3,})([^\\r\\n]*)$")
private val INLINE_SVG_RE = Regex("<svg\\b[^>]*>[\\s\\S]*?</svg\\s*>", setOf(RegexOption.IGNORE_CASE))
private val WHITESPACE_RE = Regex("\\s+")

/**
 * Mask inline `<svg>...</svg>` blocks and fenced `svg`, `mermaid`, and `smd-chart`
 * blocks with spaces while preserving every newline so 1-based line numbers stay exact.
 */
internal fun maskDiagramSpans(text: String): String {
    if (text.isEmpty()) return text
    val chars = text.toCharArray()

    fun blankRange(start: Int, endExclusive: Int) {
        val safeStart = start.coerceAtLeast(0)
        val safeEnd = endExclusive.coerceAtMost(chars.size)
        for (i in safeStart until safeEnd) {
            if (chars[i] != '\n' && chars[i] != '\r') chars[i] = ' '
        }
    }

    var cursor = 0
    var inFence = false
    var fenceChar = '`'
    var fenceLen = 0
    var fenceStart = 0
    var fenceBodyStart = 0
    var fenceLang = ""
    val proseRanges = ArrayList<IntRange>()
    var proseStart = 0

    while (cursor < text.length) {
        val nl = text.indexOf('\n', cursor)
        val lineEnd = if (nl >= 0) nl + 1 else text.length
        val rawLine = text.substring(cursor, if (nl >= 0) nl else text.length).trimEnd('\r')

        if (!inFence) {
            val open = FENCE_OPEN_RE.matchEntire(rawLine)
            if (open != null) {
                val marker = open.groupValues[1]
                val info = open.groupValues[2].trim()
                if (!(marker[0] == '`' && '`' in info)) {
                    if (cursor > proseStart) proseRanges.add(proseStart until cursor)
                    inFence = true
                    fenceChar = marker[0]
                    fenceLen = marker.length
                    fenceStart = cursor
                    fenceBodyStart = lineEnd
                    fenceLang = info.split(WHITESPACE_RE).firstOrNull()?.lowercase().orEmpty()
                    cursor = lineEnd
                    continue
                }
            }
        } else {
            val stripped = rawLine.trimStart(' ', '\t')
            val indent = rawLine.length - stripped.length
            if (indent <= 3 && stripped.length >= fenceLen) {
                var run = 0
                while (run < stripped.length && stripped[run] == fenceChar) run++
                if (run >= fenceLen && stripped.substring(run).trim().isEmpty()) {
                    val body = text.substring(fenceBodyStart, cursor).trimStart()
                    val isSvgFence = fenceLang in setOf("", "xml", "html") && body.startsWith("<svg", ignoreCase = true)
                    if (fenceLang in DIAGRAM_FENCE_LANGUAGES || isSvgFence) {
                        blankRange(fenceStart, lineEnd)
                    }
                    inFence = false
                    proseStart = lineEnd
                    cursor = lineEnd
                    continue
                }
            }
        }
        cursor = lineEnd
    }

    if (inFence) {
        val body = text.substring(fenceBodyStart).trimStart()
        val isSvgFence = fenceLang in setOf("", "xml", "html") && body.startsWith("<svg", ignoreCase = true)
        if (fenceLang in DIAGRAM_FENCE_LANGUAGES || isSvgFence) {
            blankRange(fenceStart, text.length)
        }
    } else if (proseStart < text.length) {
        proseRanges.add(proseStart until text.length)
    }

    for (range in proseRanges) {
        val segment = text.substring(range.first, range.last + 1)
        if (!segment.contains("<svg", ignoreCase = true)) continue
        for (match in INLINE_SVG_RE.findAll(segment)) {
            blankRange(range.first + match.range.first, range.first + match.range.last + 1)
        }
    }
    return String(chars)
}

private fun isBoundary(candidate: String, index: Int): Boolean {
    if (index <= 0) return true
    val prev = candidate[index - 1]
    val curr = candidate[index]
    if (prev in "/\\-_ .()") return true
    return prev.isLowerCase() && curr.isUpperCase()
}

private fun subsequenceScore(queryLower: String, candidate: String): Int? {
    val candLower = candidate.lowercase()
    val qLen = queryLower.length
    val cLen = candLower.length
    if (qLen == 0) return 0
    if (qLen > cLen) return null

    var pos = -1
    val positions = IntArray(qLen)
    for (i in 0 until qLen) {
        pos = candLower.indexOf(queryLower[i], pos + 1)
        if (pos < 0) return null
        positions[i] = pos
    }

    val exactIdx = candLower.indexOf(queryLower)
    if (exactIdx >= 0) {
        var bonus = 240 - minOf(exactIdx * 4, 120)
        if (isBoundary(candidate, exactIdx)) bonus += 80
        if (exactIdx == 0) bonus += 60
        return bonus - minOf(cLen - qLen, 80)
    }

    var score = 80
    var prevIdx = -2
    for (idx in positions) {
        if (idx == prevIdx + 1) score += 28
        if (isBoundary(candidate, idx)) score += 32
        else if (prevIdx >= 0) score -= minOf((idx - prevIdx - 1) * 3, 24)
        prevIdx = idx
    }
    return score - minOf(cLen - qLen, 80)
}

internal fun fuzzyNoteScore(query: String, name: String, relative: String = ""): Int? {
    val q = query.trim().lowercase()
    if (q.isEmpty()) return 0
    val stem = name.substringBeforeLast('.', name)
    var best: Int? = null

    subsequenceScore(q, stem)?.let { s ->
        var total = s + 90
        if (stem.lowercase() == q) total += 200
        best = total
    }
    subsequenceScore(q, name)?.let { s ->
        val total = s + 60
        if (best == null || total > best!!) best = total
    }
    if (relative.isNotEmpty() && relative != name) {
        val relNorm = relative.replace('\\', '/')
        subsequenceScore(q, relNorm)?.let { s ->
            if (best == null || s > best!!) best = s
        }
    }
    return best
}

internal interface SearchTreeNode {
    val name: String?
    val uri: Uri
    val isDirectory: Boolean
    val isFile: Boolean
    val isVirtualOrSymlink: Boolean
    val lengthBytes: Long
    fun listChildren(): List<SearchTreeNode>
}

internal class SafSearchTreeNode(private val doc: DocumentFile) : SearchTreeNode {
    override val name: String? get() = doc.name
    override val uri: Uri get() = doc.uri
    override val isDirectory: Boolean get() = doc.isDirectory
    override val isFile: Boolean get() = doc.isFile
    override val isVirtualOrSymlink: Boolean get() = doc.isVirtual
    override val lengthBytes: Long get() = runCatching { doc.length() }.getOrDefault(0L)
    override fun listChildren(): List<SearchTreeNode> =
        runCatching { doc.listFiles().map(::SafSearchTreeNode) }.getOrDefault(emptyList())
}

internal class FileSearchTreeNode(private val file: File) : SearchTreeNode {
    override val name: String get() = file.name
    override val uri: Uri get() = Uri.fromFile(file)
    override val isVirtualOrSymlink: Boolean
        get() = runCatching { Files.isSymbolicLink(file.toPath()) }.getOrDefault(false)
    override val isDirectory: Boolean get() = !isVirtualOrSymlink && file.isDirectory
    override val isFile: Boolean get() = !isVirtualOrSymlink && file.isFile
    override val lengthBytes: Long get() = runCatching { file.length() }.getOrDefault(0L)
    override fun listChildren(): List<SearchTreeNode> =
        runCatching { file.listFiles()?.map(::FileSearchTreeNode).orEmpty() }.getOrDefault(emptyList())
}

internal fun resolveSearchRoot(context: Context, folderUri: Uri?): SearchTreeNode? {
    if (folderUri == null) return null
    if (folderUri.scheme == "file") {
        val path = folderUri.path ?: return null
        val root = File(path)
        if (!root.exists() || Files.isSymbolicLink(root.toPath()) || !root.isDirectory) return null
        return FileSearchTreeNode(root)
    }
    val tree = DocumentFile.fromTreeUri(context, folderUri) ?: return null
    if (!tree.isDirectory || tree.isVirtual) return null
    return SafSearchTreeNode(tree)
}

internal data class ScannedFolderNote(
    val name: String,
    val uri: Uri,
    val relative: String,
    val lengthBytes: Long,
)

internal suspend fun walkFolderNotes(
    root: SearchTreeNode?,
    maxEntries: Int = MAX_FOLDER_SCAN_ENTRIES,
): Pair<List<ScannedFolderNote>, Boolean> {
    if (root == null) return emptyList<ScannedFolderNote>() to false
    val results = ArrayList<ScannedFolderNote>()
    var visited = 0
    var truncated = false
    val stack = ArrayDeque<Triple<SearchTreeNode, String, Int>>()
    stack.addLast(Triple(root, "", 0))

    while (stack.isNotEmpty()) {
        currentCoroutineContext().ensureActive()
        val (current, prefix, depth) = stack.removeLast()
        if (depth > MAX_FOLDER_SCAN_DEPTH) {
            truncated = true
            continue
        }
        val children = current.listChildren()
            .filter { child ->
                val childName = child.name
                !childName.isNullOrBlank() && !childName.startsWith('.') && !child.isVirtualOrSymlink
            }
            .sortedBy { it.name?.lowercase().orEmpty() }

        val subdirs = ArrayList<Triple<SearchTreeNode, String, Int>>()
        for (child in children) {
            currentCoroutineContext().ensureActive()
            visited++
            if (visited > maxEntries) {
                truncated = true
                return results to true
            }
            val childName = child.name ?: continue
            val relative = if (prefix.isEmpty()) childName else "$prefix/$childName"
            if (child.isDirectory) {
                if (depth + 1 <= MAX_FOLDER_SCAN_DEPTH) {
                    subdirs.add(Triple(child, relative, depth + 1))
                } else {
                    truncated = true
                }
            } else if (child.isFile && isSearchableNoteName(childName)) {
                val len = child.lengthBytes
                if (len <= MAX_FOLDER_FILE_BYTES) {
                    results.add(ScannedFolderNote(childName, child.uri, relative, len))
                }
            }
        }
        for (i in subdirs.indices.reversed()) {
            stack.addLast(subdirs[i])
        }
    }
    return results to truncated
}

private fun sameTargetUri(left: String?, right: String?): Boolean {
    if (left.isNullOrBlank() || right.isNullOrBlank()) return false
    if (left == right) return true
    return runCatching { sameDocument(Uri.parse(left), Uri.parse(right)) }.getOrDefault(false)
}

/**
 * Recursive drawer filter: matches note filenames across nested subfolders and returns
 * only matching note entries (zero empty or non-matching directory rows).
 */
internal suspend fun filterFolderEntries(
    root: SearchTreeNode?,
    query: String,
    limit: Int = 250,
): List<FileEntry> {
    val trimmed = query.trim()
    if (trimmed.isEmpty() || root == null) return emptyList()
    val (notes, _) = walkFolderNotes(root)
    val scored = ArrayList<Pair<Int, FileEntry>>()
    for (note in notes) {
        currentCoroutineContext().ensureActive()
        val score = fuzzyNoteScore(trimmed, note.name, note.relative) ?: continue
        scored.add(score to FileEntry(note.name, note.uri.toString(), directory = false, relative = note.relative))
    }
    scored.sortWith(compareByDescending<Pair<Int, FileEntry>> { it.first }.thenBy { it.second.relative.lowercase() })
    return scored.take(limit).map { it.second }
}

/**
 * Rank open tabs, pinned/recent notes, and folder files for the Quick Switcher.
 * Empty query surfaces pinned and recent notes first, followed by open tabs and folder files.
 */
internal suspend fun rankQuickSwitcher(
    query: String,
    tabs: List<Note>,
    recents: List<RecentNote>,
    folderRoot: SearchTreeNode?,
    limit: Int = MAX_QUICK_SWITCHER_RESULTS,
): List<QuickSwitcherItem> {
    val q = query.trim()
    val candidates = ArrayList<QuickSwitcherItem>()
    val seenUris = ArrayList<String>()

    fun findSeenIndex(uri: String?): Int {
        if (uri.isNullOrBlank()) return -1
        return candidates.indexOfFirst { existing -> sameTargetUri(existing.uri, uri) }
    }

    val orderedRecentList = orderedRecents(recents)
    val recentRankByUri = orderedRecentList.mapIndexed { idx, r -> r.uri to idx }.toList()
    fun recentOrderFor(uri: String?): Pair<Int?, Boolean> {
        if (uri.isNullOrBlank()) return null to false
        val found = recentRankByUri.firstOrNull { (rUri, _) -> sameTargetUri(rUri, uri) }
        val pinned = orderedRecentList.any { sameTargetUri(it.uri, uri) && it.pinned }
        return found?.second to pinned
    }

    // 1. Open tabs (works cleanly when tabs is empty too)
    val openOrder = HashMap<String, Int>()
    tabs.forEachIndexed { idx, tab ->
        val (recIdx, isPinned) = recentOrderFor(tab.uri)
        val subtitle = tab.relative?.takeIf { it.isNotBlank() }
            ?: tab.uri?.let { Uri.decode(it).substringAfterLast(':') }
            ?: "Unsaved tab"
        val key = tab.uri ?: "tab:${tab.id}"
        openOrder[key] = idx
        tab.uri?.let(seenUris::add)
        candidates.add(
            QuickSwitcherItem(
                key = key,
                name = tab.name.ifBlank { "Untitled.md" },
                subtitle = subtitle,
                tabId = tab.id,
                uri = tab.uri,
                relative = tab.relative,
                isOpen = true,
                pinned = isPinned,
                isRecent = recIdx != null,
                dirty = tab.dirty,
            )
        )
    }

    // 2. Pinned and recent notes not already represented by an open tab
    orderedRecentList.forEach { rec ->
        currentCoroutineContext().ensureActive()
        if (findSeenIndex(rec.uri) >= 0) return@forEach
        seenUris.add(rec.uri)
        val subtitle = rec.relative?.takeIf { it.isNotBlank() }
            ?: Uri.decode(rec.uri).substringAfterLast(':')
        candidates.add(
            QuickSwitcherItem(
                key = rec.uri,
                name = rec.name,
                subtitle = subtitle,
                uri = rec.uri,
                relative = rec.relative,
                isOpen = false,
                pinned = rec.pinned,
                isRecent = true,
            )
        )
    }

    // 3. Folder notes across subfolders
    val (folderNotes, _) = walkFolderNotes(folderRoot)
    for (entry in folderNotes) {
        currentCoroutineContext().ensureActive()
        val uriString = entry.uri.toString()
        val existingIdx = findSeenIndex(uriString)
        if (existingIdx >= 0) {
            val current = candidates[existingIdx]
            if (current.relative.isNullOrBlank()) {
                candidates[existingIdx] = current.copy(relative = entry.relative, subtitle = entry.relative)
            }
            continue
        }
        seenUris.add(uriString)
        candidates.add(
            QuickSwitcherItem(
                key = uriString,
                name = entry.name,
                subtitle = entry.relative,
                uri = uriString,
                relative = entry.relative,
            )
        )
    }

    if (q.isEmpty()) {
        return candidates.sortedWith { a, b ->
            val aGroup = when {
                a.pinned -> 0
                a.isRecent -> 1
                a.isOpen -> 2
                else -> 3
            }
            val bGroup = when {
                b.pinned -> 0
                b.isRecent -> 1
                b.isOpen -> 2
                else -> 3
            }
            if (aGroup != bGroup) return@sortedWith aGroup.compareTo(bGroup)
            val aRec = recentOrderFor(a.uri).first ?: 9_999
            val bRec = recentOrderFor(b.uri).first ?: 9_999
            if (aRec != bRec) return@sortedWith aRec.compareTo(bRec)
            val aOpen = openOrder[a.key] ?: 9_999
            val bOpen = openOrder[b.key] ?: 9_999
            if (aOpen != bOpen) return@sortedWith aOpen.compareTo(bOpen)
            (a.relative ?: a.name).lowercase().compareTo((b.relative ?: b.name).lowercase())
        }.take(limit)
    }

    val scored = ArrayList<QuickSwitcherItem>()
    for (item in candidates) {
        currentCoroutineContext().ensureActive()
        val base = fuzzyNoteScore(q, item.name, item.relative.orEmpty()) ?: continue
        var bonus = 0
        if (item.pinned) bonus += 24
        else if (item.isRecent) bonus += 14
        if (item.isOpen) bonus += 18
        scored.add(item.copy(score = base + bonus))
    }
    scored.sortWith(
        compareByDescending<QuickSwitcherItem> { it.score }
            .thenByDescending { it.pinned }
            .thenByDescending { it.isOpen }
            .thenBy { (it.relative ?: it.name).lowercase() }
    )
    return scored.take(limit)
}

private fun formatMatchSnippet(rawLine: String, matchCol: Int, queryLen: Int, maxChars: Int = 140): String {
    val clean = rawLine.replace('\t', ' ').trimEnd('\r')
    if (clean.length <= maxChars) return clean.trim()
    val half = maxOf((maxChars - queryLen) / 2, 16)
    val start = maxOf(0, matchCol - half)
    val end = minOf(clean.length, start + maxChars)
    val adjStart = maxOf(0, end - maxChars)
    val prefix = if (adjStart > 0) "…" else ""
    val suffix = if (end < clean.length) "…" else ""
    return "$prefix${clean.substring(adjStart, end).trim()}$suffix"
}

private fun searchMarkdownLines(
    content: String,
    needle: String,
    caseSensitive: Boolean,
    excludeDiagrams: Boolean,
    name: String,
    relative: String,
    uri: String?,
    tabId: String?,
    dirty: Boolean,
    remainingSlots: Int,
): Pair<List<FolderSearchMatch>, Boolean> {
    if (content.isEmpty() || needle.isEmpty() || remainingSlots <= 0) return emptyList<FolderSearchMatch>() to false
    val effective = if (excludeDiagrams) maskDiagramSpans(content) else content
    val haystack = if (caseSensitive) effective else effective.lowercase()
    val target = if (caseSensitive) needle else needle.lowercase()
    if (!haystack.contains(target)) return emptyList<FolderSearchMatch>() to false

    val origLines = content.split('\n')
    val searchLines = haystack.split('\n')
    val matches = ArrayList<FolderSearchMatch>()
    val qLen = target.length

    for (idx in searchLines.indices) {
        val searchLine = searchLines[idx]
        var col = searchLine.indexOf(target)
        while (col >= 0) {
            val origLine = origLines.getOrElse(idx) { "" }
            val keyBase = uri ?: "tab:${tabId.orEmpty()}"
            matches.add(
                FolderSearchMatch(
                    key = "$keyBase:${idx + 1}:${col + 1}",
                    name = name,
                    relative = relative,
                    uri = uri,
                    tabId = tabId,
                    line = idx + 1,
                    column = col + 1,
                    snippet = formatMatchSnippet(origLine, col, qLen),
                    dirty = dirty,
                )
            )
            if (matches.size >= remainingSlots) {
                return matches to true
            }
            col = searchLine.indexOf(target, col + maxOf(qLen, 1))
        }
    }
    return matches to false
}

/**
 * Stream cross-note text search across live open tabs, folder notes (or accessible
 * recent notes when no folder is open), preferring live open-tab buffers over disk
 * files and never writing a cached index or requesting folder permissions.
 */
internal suspend fun streamTextSearch(
    query: String,
    tabs: List<Note>,
    recents: List<RecentNote>,
    folderRoot: SearchTreeNode?,
    media: MediaStorage,
    openUriStream: (Uri) -> InputStream?,
    caseSensitive: Boolean = false,
    excludeDiagrams: Boolean = true,
    maxMatches: Int = MAX_FOLDER_SEARCH_MATCHES,
    onBatch: (suspend (batch: List<FolderSearchMatch>, scannedFiles: Int, truncated: Boolean, done: Boolean) -> Unit)? = null,
): FolderSearchState {
    val needle = query
    if (needle.isEmpty()) {
        return FolderSearchState(
            query = query,
            caseSensitive = caseSensitive,
            includeDiagrams = !excludeDiagrams,
        )
    }

    val allMatches = ArrayList<FolderSearchMatch>()
    val pendingBatch = ArrayList<FolderSearchMatch>()
    val coveredUris = ArrayList<String>()
    var scannedFiles = 0
    var truncated = false

    suspend fun flushBatch(done: Boolean = false) {
        if (onBatch != null && (pendingBatch.isNotEmpty() || done)) {
            val snapshot = pendingBatch.toList()
            pendingBatch.clear()
            onBatch(snapshot, scannedFiles, truncated, done)
        }
    }

    fun isCovered(uri: String): Boolean = coveredUris.any { sameTargetUri(it, uri) }

    // 1. Live open tabs always override stale disk files.
    for (tab in tabs) {
        currentCoroutineContext().ensureActive()
        tab.uri?.takeIf { it.isNotBlank() }?.let(coveredUris::add)
        scannedFiles++
        val name = tab.name.ifBlank { "Untitled.md" }
        val relative = tab.relative?.takeIf { it.isNotBlank() } ?: name
        val (found, hitCap) = searchMarkdownLines(
            content = tab.content,
            needle = needle,
            caseSensitive = caseSensitive,
            excludeDiagrams = excludeDiagrams,
            name = name,
            relative = relative,
            uri = tab.uri,
            tabId = tab.id,
            dirty = tab.dirty,
            remainingSlots = maxMatches - allMatches.size,
        )
        if (found.isNotEmpty()) {
            allMatches.addAll(found)
            pendingBatch.addAll(found)
            if (pendingBatch.size >= STREAM_BATCH_SIZE) flushBatch(false)
        }
        if (hitCap || allMatches.size >= maxMatches) {
            truncated = true
            flushBatch(true)
            return FolderSearchState(
                query = query,
                caseSensitive = caseSensitive,
                includeDiagrams = !excludeDiagrams,
                scanning = false,
                scannedFiles = scannedFiles,
                truncated = true,
                matches = allMatches,
            )
        }
    }

    // 2. Folder files if a folder is open; otherwise accessible recent notes without prompting for permissions.
    data class DiskCandidate(val name: String, val uri: Uri, val relative: String)
    val diskCandidates = ArrayList<DiskCandidate>()
    if (folderRoot != null) {
        val (folderNotes, walkTrunc) = walkFolderNotes(folderRoot)
        if (walkTrunc) truncated = true
        for (item in folderNotes) {
            if (!isCovered(item.uri.toString())) {
                diskCandidates.add(DiskCandidate(item.name, item.uri, item.relative))
            }
        }
    } else {
        for (rec in orderedRecents(recents)) {
            if (rec.uri.isBlank() || isCovered(rec.uri) || !isSearchableNoteName(rec.name)) continue
            val parsed = runCatching { Uri.parse(rec.uri) }.getOrNull() ?: continue
            coveredUris.add(rec.uri)
            diskCandidates.add(
                DiskCandidate(
                    name = rec.name,
                    uri = parsed,
                    relative = rec.relative?.takeIf { it.isNotBlank() } ?: rec.name,
                )
            )
        }
    }

    for (candidate in diskCandidates) {
        currentCoroutineContext().ensureActive()
        val text = runCatching {
            openUriStream(candidate.uri)?.use { stream ->
                media.readSearchableNote(stream, maxPlainBytes = MAX_PLAIN_SEARCH_BYTES)
            }
        }.getOrNull() ?: continue
        scannedFiles++
        val (found, hitCap) = searchMarkdownLines(
            content = text,
            needle = needle,
            caseSensitive = caseSensitive,
            excludeDiagrams = excludeDiagrams,
            name = candidate.name,
            relative = candidate.relative,
            uri = candidate.uri.toString(),
            tabId = null,
            dirty = false,
            remainingSlots = maxMatches - allMatches.size,
        )
        if (found.isNotEmpty()) {
            allMatches.addAll(found)
            pendingBatch.addAll(found)
            if (pendingBatch.size >= STREAM_BATCH_SIZE) flushBatch(false)
        }
        if (hitCap || allMatches.size >= maxMatches) {
            truncated = true
            break
        }
    }

    flushBatch(true)
    return FolderSearchState(
        query = query,
        caseSensitive = caseSensitive,
        includeDiagrams = !excludeDiagrams,
        scanning = false,
        scannedFiles = scannedFiles,
        truncated = truncated,
        matches = allMatches,
    )
}
