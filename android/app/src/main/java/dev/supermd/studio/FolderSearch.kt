package dev.supermd.studio

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import androidx.documentfile.provider.DocumentFile
import java.io.File
import java.io.InputStream
import java.nio.file.Files
import java.util.Locale
import kotlin.coroutines.coroutineContext
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit

private val SEARCHABLE_EXTENSIONS = setOf("md", "smd", "fmd", "markdown", "qmd", "rmd", "txt")
private const val MAX_WALK_ENTRIES = 10_000
private const val MAX_FOLDER_DEPTH = 32
private const val MAX_SEARCH_MATCHES = 500
private const val MAX_MATCHES_PER_NOTE = 50
private const val SNIPPET_MAX_CHARS = 140
private const val BATCH_SIZE = 20
private const val SEARCH_WINDOW_CONCURRENCY = 6
private const val WALK_DIR_CONCURRENCY = 4

private val FENCE_REGEX = Regex("""^[ \t]{0,3}(`{3,}|~{3,})(.*)$""")
private val INLINE_SVG_OPEN = Regex("""<svg\b[^>]*>""", RegexOption.IGNORE_CASE)
private val INLINE_SVG_CLOSE = Regex("""</svg\s*>""", RegexOption.IGNORE_CASE)
private val DIAGRAM_FENCE_LANGS = setOf("svg", "svg+xml", "image/svg+xml", "mermaid", "smd-chart")

internal fun isSearchableNoteName(name: String): Boolean {
    if (name.isBlank() || name.startsWith('.')) return false
    val dot = name.lastIndexOf('.')
    if (dot <= 0 || dot == name.lastIndex) return false
    return name.substring(dot + 1).lowercase(Locale.ROOT) in SEARCHABLE_EXTENSIONS
}

data class FolderSearchMatch(
    val key: String,
    val tabId: String?,
    val uri: String?,
    val name: String,
    val relative: String,
    val line: Int,
    val column: Int,
    val snippet: String,
    val matchStart: Int,
    val matchEnd: Int,
    val dirty: Boolean,
    val isOpen: Boolean,
)

data class FolderSearchState(
    val visible: Boolean = false,
    val query: String = "",
    val caseSensitive: Boolean = false,
    val includeDiagrams: Boolean = false,
    val matches: List<FolderSearchMatch> = emptyList(),
    val scanning: Boolean = false,
    val scannedFiles: Int = 0,
    val truncated: Boolean = false,
)

internal sealed interface SearchTreeNode {
    val name: String
    val uriString: String
    val isDirectory: Boolean
    suspend fun listChildren(): List<SearchTreeNode>

    class LocalFileNode(private val file: File) : SearchTreeNode {
        override val name: String get() = file.name
        override val uriString: String get() = Uri.fromFile(file).toString()
        override val isDirectory: Boolean get() = file.isDirectory

        override suspend fun listChildren(): List<SearchTreeNode> {
            coroutineContext.ensureActive()
            val children = file.listFiles() ?: return emptyList()
            return children.mapNotNull { child ->
                val childName = child.name
                if (childName.isNullOrEmpty() || childName.startsWith('.')) return@mapNotNull null
                if (runCatching { Files.isSymbolicLink(child.toPath()) }.getOrDefault(false)) return@mapNotNull null
                if (child.isDirectory || child.isFile) LocalFileNode(child) else null
            }
        }
    }

    class SafFastNode(
        private val context: Context,
        private val treeUri: Uri,
        private val documentId: String,
        override val name: String,
        override val isDirectory: Boolean,
    ) : SearchTreeNode {
        override val uriString: String by lazy(LazyThreadSafetyMode.PUBLICATION) {
            DocumentsContract.buildDocumentUriUsingTree(treeUri, documentId).toString()
        }

        override suspend fun listChildren(): List<SearchTreeNode> {
            coroutineContext.ensureActive()
            if (!isDirectory) return emptyList()
            val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, documentId)
            val projection = arrayOf(
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_FLAGS,
            )
            return runCatching {
                val list = ArrayList<SearchTreeNode>()
                context.contentResolver.query(childrenUri, projection, null, null, null)?.use { cursor ->
                    val idIdx = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
                    val nameIdx = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
                    val mimeIdx = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_MIME_TYPE)
                    val flagsIdx = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_FLAGS)
                    while (cursor.moveToNext()) {
                        coroutineContext.ensureActive()
                        if (idIdx < 0 || nameIdx < 0) continue
                        val childId = cursor.getString(idIdx) ?: continue
                        val childName = cursor.getString(nameIdx) ?: continue
                        if (childName.isEmpty() || childName.startsWith('.')) continue
                        val flags = if (flagsIdx >= 0 && !cursor.isNull(flagsIdx)) cursor.getInt(flagsIdx) else 0
                        if ((flags and DocumentsContract.Document.FLAG_VIRTUAL_DOCUMENT) != 0) continue
                        val mime = if (mimeIdx >= 0 && !cursor.isNull(mimeIdx)) cursor.getString(mimeIdx) else ""
                        list.add(SafFastNode(context, treeUri, childId, childName, mime == DocumentsContract.Document.MIME_TYPE_DIR))
                    }
                }
                list
            }.getOrElse { emptyList() }
        }
    }

    class DocumentFileNode(private val doc: DocumentFile) : SearchTreeNode {
        override val name: String = doc.name.orEmpty()
        override val uriString: String = doc.uri.toString()
        override val isDirectory: Boolean = doc.isDirectory

        override suspend fun listChildren(): List<SearchTreeNode> {
            coroutineContext.ensureActive()
            if (!isDirectory) return emptyList()
            return doc.listFiles().mapNotNull { child ->
                val childName = child.name
                if (childName.isNullOrEmpty() || childName.startsWith('.') || child.isVirtual) null
                else DocumentFileNode(child)
            }
        }
    }
}

internal fun resolveSearchRoot(context: Context, folderUri: Uri?): SearchTreeNode? {
    if (folderUri == null) return null
    if (folderUri.scheme == "file") {
        val path = folderUri.path ?: return null
        val dir = File(path)
        if (!dir.isDirectory || runCatching { Files.isSymbolicLink(dir.toPath()) }.getOrDefault(false)) return null
        return SearchTreeNode.LocalFileNode(dir)
    }
    val treeDocId = runCatching { DocumentsContract.getTreeDocumentId(folderUri) }.getOrNull()
    if (!treeDocId.isNullOrEmpty()) {
        return SearchTreeNode.SafFastNode(
            context = context,
            treeUri = folderUri,
            documentId = treeDocId,
            name = "",
            isDirectory = true,
        )
    }
    return DocumentFile.fromTreeUri(context, folderUri)?.takeIf { it.isDirectory }?.let(SearchTreeNode::DocumentFileNode)
}

internal suspend fun walkFolderTree(
    root: SearchTreeNode?,
    maxEntries: Int = MAX_WALK_ENTRIES,
): List<FileEntry> {
    if (root == null || !root.isDirectory || maxEntries <= 0) return emptyList()
    val results = ArrayList<FileEntry>()
    val entryCount = java.util.concurrent.atomic.AtomicInteger(0)
    coroutineScope {
        val dirSemaphore = Semaphore(WALK_DIR_CONCURRENCY)

        suspend fun visit(node: SearchTreeNode, prefix: String, depth: Int, prefetched: List<SearchTreeNode>? = null) {
            coroutineContext.ensureActive()
            if (depth > MAX_FOLDER_DEPTH || entryCount.get() >= maxEntries) return
            val children = prefetched ?: node.listChildren()
            val dirs = ArrayList<Pair<SearchTreeNode, String>>()
            val files = ArrayList<FileEntry>()
            for (child in children) {
                coroutineContext.ensureActive()
                val childName = child.name
                if (childName.isEmpty() || childName.startsWith('.')) continue
                val rel = if (prefix.isEmpty()) childName else "$prefix/$childName"
                if (child.isDirectory) {
                    dirs.add(child to rel)
                } else if (isSearchableNoteName(childName)) {
                    files.add(FileEntry(childName, child.uriString, directory = false, relative = rel))
                }
            }
            files.sortBy { it.name.lowercase(Locale.ROOT) }
            for (entry in files) {
                if (entryCount.get() >= maxEntries) return
                results.add(entry)
                entryCount.incrementAndGet()
            }
            if (dirs.isEmpty() || depth + 1 > MAX_FOLDER_DEPTH || entryCount.get() >= maxEntries) return
            dirs.sortBy { it.first.name.lowercase(Locale.ROOT) }
            if (dirs.size == 1) {
                val (dirNode, rel) = dirs[0]
                visit(dirNode, rel, depth + 1)
                return
            }
            val prefetchedDirs: List<Deferred<List<SearchTreeNode>>> = dirs.map { (dirNode, _) ->
                async(Dispatchers.IO) {
                    dirSemaphore.withPermit {
                        if (entryCount.get() >= maxEntries) emptyList() else dirNode.listChildren()
                    }
                }
            }
            try {
                for (i in dirs.indices) {
                    if (entryCount.get() >= maxEntries) break
                    val (dirNode, rel) = dirs[i]
                    visit(dirNode, rel, depth + 1, prefetchedDirs[i].await())
                }
            } finally {
                for (job in prefetchedDirs) {
                    if (!job.isCompleted) job.cancel()
                }
            }
        }

        visit(root, "", 0)
    }
    return results
}

internal fun maskDiagramSpans(markdown: String): String {
    if (markdown.isEmpty()) return markdown
    val spans = ArrayList<IntRange>()
    val fencedRanges = ArrayList<IntRange>()
    var offset = 0
    var openChar = '\u0000'
    var openSize = 0
    var openFenceStart = 0
    var openBodyStart = 0
    var openIsDiagram = false
    val probe = StringBuilder()
    var probeLines = 0

    var idx = 0
    val total = markdown.length
    while (idx < total) {
        val nl = markdown.indexOf('\n', idx)
        val lineEnd = if (nl < 0) total else nl + 1
        val bodyEnd = if (lineEnd > idx && markdown[lineEnd - 1] == '\n') {
            if (lineEnd - 1 > idx && markdown[lineEnd - 2] == '\r') lineEnd - 2 else lineEnd - 1
        } else lineEnd
        val body = markdown.substring(idx, bodyEnd)
        val match = FENCE_REGEX.matchEntire(body)
        if (match != null) {
            val marker = match.groupValues[1]
            if (openChar == '\u0000') {
                val info = match.groupValues[2].trim().split(Regex("\\s+"), limit = 2).firstOrNull()?.lowercase(Locale.ROOT).orEmpty()
                openChar = marker[0]
                openSize = marker.length
                openFenceStart = offset
                openBodyStart = offset + (lineEnd - idx)
                openIsDiagram = info in DIAGRAM_FENCE_LANGS
                probe.setLength(0)
                probeLines = 0
            } else if (marker[0] == openChar && marker.length >= openSize) {
                fencedRanges.add(openFenceStart until (offset + (lineEnd - idx)))
                if (openIsDiagram || probe.toString().trimStart().startsWith("<svg", ignoreCase = true)) {
                    spans.add(openFenceStart until (offset + (lineEnd - idx)))
                }
                openChar = '\u0000'
            }
        } else if (openChar != '\u0000' && probeLines < 4) {
            probe.append(body.take(512)).append('\n')
            probeLines++
        }
        offset += (lineEnd - idx)
        idx = lineEnd
    }
    if (openChar != '\u0000') {
        fencedRanges.add(openFenceStart until total)
        if (openIsDiagram || probe.toString().trimStart().startsWith("<svg", ignoreCase = true)) {
            spans.add(openFenceStart until total)
        }
    }

    if (markdown.contains("<svg", ignoreCase = true)) {
        var cursor = 0
        var fenceIdx = 0
        while (cursor < total) {
            val openMatch = INLINE_SVG_OPEN.find(markdown, cursor) ?: break
            val start = openMatch.range.first
            while (fenceIdx < fencedRanges.size && fencedRanges[fenceIdx].last < start) fenceIdx++
            if (fenceIdx < fencedRanges.size && start in fencedRanges[fenceIdx]) {
                cursor = fencedRanges[fenceIdx].last + 1
                continue
            }
            if (openMatch.value.trimEnd().endsWith("/>")) {
                spans.add(start..(openMatch.range.last))
                cursor = openMatch.range.last + 1
                continue
            }
            val closeMatch = INLINE_SVG_CLOSE.find(markdown, openMatch.range.last + 1)
            val endExclusive = closeMatch?.let { it.range.last + 1 } ?: total
            spans.add(start until endExclusive)
            cursor = endExclusive
        }
    }

    if (spans.isEmpty()) return markdown
    val chars = markdown.toCharArray()
    for (range in spans) {
        val from = range.first.coerceAtLeast(0)
        val to = (range.last + 1).coerceAtMost(chars.size)
        for (i in from until to) {
            if (chars[i] != '\n' && chars[i] != '\r') chars[i] = '\u0000'
        }
    }
    return String(chars)
}

internal class FoldedText(
    val text: String,
    val starts: IntArray,
    val ends: IntArray,
)

private fun foldCodePoint(cp: Int): String = when (cp) {
    0x00DF, 0x1E9E -> "ss"
    0x03C2 -> "\u03c3"
    0x00B5 -> "\u03bc"
    0xFB00 -> "ff"
    0xFB01 -> "fi"
    0xFB02 -> "fl"
    0xFB03 -> "ffi"
    0xFB04 -> "ffl"
    0xFB05, 0xFB06 -> "st"
    else -> String(Character.toChars(cp)).lowercase(Locale.ROOT)
}

internal fun clampUtf16Boundary(text: String, index: Int): Int {
    val clamped = index.coerceIn(0, text.length)
    return if (clamped > 0 && clamped < text.length &&
        Character.isHighSurrogate(text[clamped - 1]) &&
        Character.isLowSurrogate(text[clamped])
    ) {
        clamped - 1
    } else {
        clamped
    }
}

internal fun foldWithOffsets(source: String): FoldedText {
    val sb = StringBuilder(source.length)
    var starts = IntArray(source.length + 8)
    var ends = IntArray(source.length + 8)
    var outLen = 0
    var i = 0
    while (i < source.length) {
        val ch = source[i]
        if (ch.code < 128) {
            if (outLen >= starts.size) {
                val nextCap = maxOf(starts.size * 2, outLen + 1)
                starts = starts.copyOf(nextCap)
                ends = ends.copyOf(nextCap)
            }
            sb.append(if (ch in 'A'..'Z') (ch.code + 32).toChar() else ch)
            starts[outLen] = i
            ends[outLen] = i + 1
            outLen++
            i++
            continue
        }
        val cp = source.codePointAt(i)
        val charCount = Character.charCount(cp)
        val folded = foldCodePoint(cp)
        if (outLen + folded.length > starts.size) {
            val nextCap = maxOf(starts.size * 2, outLen + folded.length)
            starts = starts.copyOf(nextCap)
            ends = ends.copyOf(nextCap)
        }
        for (k in 0 until folded.length) {
            sb.append(folded[k])
            starts[outLen] = i
            ends[outLen] = i + charCount
            outLen++
        }
        i += charCount
    }
    return FoldedText(sb.toString(), starts.copyOf(outLen), ends.copyOf(outLen))
}

private fun mightContainNeedle(
    markdown: String,
    query: String,
    foldedNeedle: String,
    caseSensitive: Boolean,
): Boolean {
    if ('\u0000' in query || '\u0000' in foldedNeedle) return true
    if (caseSensitive) return markdown.indexOf(query) >= 0
    if (isAsciiOnly(foldedNeedle) && isAsciiOnly(markdown)) {
        return markdown.contains(foldedNeedle, ignoreCase = true)
    }
    val sb = StringBuilder(markdown.length)
    var i = 0
    while (i < markdown.length) {
        val ch = markdown[i]
        if (ch.code < 128) {
            sb.append(if (ch in 'A'..'Z') (ch.code + 32).toChar() else ch)
            i++
        } else {
            val cp = markdown.codePointAt(i)
            i += Character.charCount(cp)
            sb.append(foldCodePoint(cp))
        }
    }
    return sb.indexOf(foldedNeedle) >= 0
}

internal data class SnippetSlice(
    val snippet: String,
    val matchStart: Int,
    val matchEnd: Int,
)

internal fun formatMatchSnippet(rawLine: String, origStart: Int, origEnd: Int): SnippetSlice {
    var lead = 0
    while (lead < rawLine.length && (rawLine[lead] == ' ' || rawLine[lead] == '\t')) lead++
    var trail = rawLine.length
    while (trail > lead && (rawLine[trail - 1] == ' ' || rawLine[trail - 1] == '\t' || rawLine[trail - 1] == '\r')) trail--
    val trimmed = rawLine.substring(lead, trail)
    val adjStart = (origStart - lead).coerceIn(0, trimmed.length)
    val adjEnd = (origEnd - lead).coerceIn(adjStart, trimmed.length)

    if (trimmed.length <= SNIPPET_MAX_CHARS) {
        return SnippetSlice(trimmed, adjStart, adjEnd)
    }

    val matchLen = (adjEnd - adjStart).coerceAtLeast(1)
    val contextBefore = ((SNIPPET_MAX_CHARS - matchLen) / 2).coerceAtLeast(16)
    var winStart = (adjStart - contextBefore).coerceAtLeast(0)
    var winEnd = (winStart + SNIPPET_MAX_CHARS).coerceAtMost(trimmed.length)
    if (winEnd - winStart < SNIPPET_MAX_CHARS) {
        winStart = (winEnd - SNIPPET_MAX_CHARS).coerceAtLeast(0)
    }
    if (winStart > 0 && Character.isLowSurrogate(trimmed[winStart])) winStart--
    if (winEnd < trimmed.length && Character.isLowSurrogate(trimmed[winEnd])) winEnd++

    val prefix = if (winStart > 0) "…" else ""
    val suffix = if (winEnd < trimmed.length) "…" else ""
    val body = trimmed.substring(winStart, winEnd)
    val snippet = prefix + body + suffix
    val relStart = prefix.length + (adjStart - winStart).coerceIn(0, body.length)
    val relEnd = prefix.length + (adjEnd - winStart).coerceIn(0, body.length)
    return SnippetSlice(snippet, relStart, relEnd.coerceAtLeast(relStart))
}

private fun isAsciiOnly(text: String): Boolean {
    for (i in 0 until text.length) {
        if (text[i].code >= 128) return false
    }
    return true
}

private fun findLineMatchSpans(
    searchLine: String,
    query: String,
    foldedNeedle: String,
    caseSensitive: Boolean,
): List<IntRange> {
    val spans = ArrayList<IntRange>()
    if (caseSensitive) {
        var cursor = 0
        while (spans.size < MAX_MATCHES_PER_NOTE && cursor <= searchLine.length) {
            val pos = searchLine.indexOf(query, cursor)
            if (pos < 0) break
            spans.add(pos until (pos + query.length))
            cursor = pos + query.length.coerceAtLeast(1)
        }
        return spans
    }
    if (isAsciiOnly(searchLine) && isAsciiOnly(foldedNeedle)) {
        val haystack = searchLine.lowercase(Locale.ROOT)
        var cursor = 0
        while (spans.size < MAX_MATCHES_PER_NOTE && cursor <= haystack.length) {
            val pos = haystack.indexOf(foldedNeedle, cursor)
            if (pos < 0) break
            spans.add(pos until (pos + foldedNeedle.length))
            cursor = pos + foldedNeedle.length.coerceAtLeast(1)
        }
        return spans
    }

    val folded = foldWithOffsets(searchLine)
    if (foldedNeedle.isEmpty() || folded.text.isEmpty()) return spans
    val total = folded.starts.size
    var fCursor = 0
    while (spans.size < MAX_MATCHES_PER_NOTE && fCursor <= total) {
        val fPos = folded.text.indexOf(foldedNeedle, fCursor)
        if (fPos < 0) break
        val fEnd = fPos + foldedNeedle.length
        val onStart = fPos == 0 || folded.starts[fPos] != folded.starts[fPos - 1]
        val onEnd = fEnd == total || folded.starts[fEnd] != folded.starts[fEnd - 1]
        if (!onStart || !onEnd) {
            fCursor = fPos + 1
            continue
        }
        val origStart = folded.starts[fPos]
        val origEnd = folded.ends[fEnd - 1]
        spans.add(origStart until origEnd)
        fCursor = fEnd
        while (fCursor < total && folded.starts[fCursor] < origEnd) fCursor++
    }
    return spans
}

private suspend fun searchMarkdownLines(
    markdown: String,
    query: String,
    foldedNeedle: String,
    caseSensitive: Boolean,
    excludeDiagrams: Boolean,
    keyPrefix: String,
    tabId: String?,
    uri: String?,
    name: String,
    relative: String,
    dirty: Boolean,
    isOpen: Boolean,
    remainingBudget: Int,
): Pair<List<FolderSearchMatch>, Boolean> {
    if (markdown.isEmpty() || query.isEmpty() || remainingBudget <= 0) return emptyList<FolderSearchMatch>() to false
    if (!mightContainNeedle(markdown, query, foldedNeedle, caseSensitive)) return emptyList<FolderSearchMatch>() to false
    val masked = if (excludeDiagrams) maskDiagramSpans(markdown) else markdown
    val origLines = markdown.split('\n')
    val searchLines = masked.split('\n')
    val limit = minOf(MAX_MATCHES_PER_NOTE, remainingBudget)
    val found = ArrayList<FolderSearchMatch>()
    var truncated = false

    for (lineIdx in searchLines.indices) {
        coroutineContext.ensureActive()
        val origLine = origLines.getOrElse(lineIdx) { "" }.trimEnd('\r')
        val searchLine = searchLines[lineIdx].trimEnd('\r')
        for (span in findLineMatchSpans(searchLine, query, foldedNeedle, caseSensitive)) {
            if (found.size >= limit) {
                if (found.size >= remainingBudget) truncated = true
                break
            }
            val origStart = span.first
            val origEnd = span.last + 1
            val slice = formatMatchSnippet(origLine, origStart, origEnd)
            found.add(
                FolderSearchMatch(
                    key = "$keyPrefix:${lineIdx + 1}:$origStart",
                    tabId = tabId,
                    uri = uri,
                    name = name,
                    relative = relative,
                    line = lineIdx + 1,
                    column = origStart + 1,
                    snippet = slice.snippet,
                    matchStart = slice.matchStart,
                    matchEnd = slice.matchEnd,
                    dirty = dirty,
                    isOpen = isOpen,
                ),
            )
        }
        if (truncated) break
    }
    return found to truncated
}

internal suspend fun streamTextSearch(
    query: String,
    tabs: List<Note>,
    recents: List<RecentNote>,
    folderRoot: SearchTreeNode?,
    media: MediaStorage,
    openUriStream: (Uri) -> InputStream?,
    activeTabId: String = "",
    caseSensitive: Boolean = false,
    excludeDiagrams: Boolean = true,
    maxMatches: Int = MAX_SEARCH_MATCHES,
    onBatch: (suspend (batch: List<FolderSearchMatch>, scannedFiles: Int, truncated: Boolean, done: Boolean) -> Unit)? = null,
): FolderSearchState {
    if (query.isBlank()) {
        onBatch?.invoke(emptyList(), 0, false, true)
        return FolderSearchState(query = query, caseSensitive = caseSensitive, includeDiagrams = !excludeDiagrams)
    }

    val seenKeys = HashSet<String>(maxOf(16, tabs.size * 2))
    fun markSeenUri(uriStr: String?): Uri? {
        if (uriStr.isNullOrBlank()) return null
        val parsed = runCatching { Uri.parse(uriStr) }.getOrNull() ?: return null
        if (!seenKeys.add(canonicalDocumentKey(parsed))) return null
        return parsed
    }

    val foldedNeedle = if (caseSensitive) query else foldWithOffsets(query).text
    val orderedTabs = tabs.sortedBy { if (it.id == activeTabId) 0 else 1 }
    val allMatches = ArrayList<FolderSearchMatch>()
    val pending = ArrayList<FolderSearchMatch>()
    var scannedFiles = 0
    var truncated = false

    suspend fun flush(done: Boolean) {
        if (onBatch != null && (pending.isNotEmpty() || done)) {
            val snapshot = pending.toList()
            pending.clear()
            onBatch(snapshot, scannedFiles, truncated, done)
        }
    }

    for (tab in orderedTabs) {
        coroutineContext.ensureActive()
        if (tab.id.isEmpty()) continue
        markSeenUri(tab.uri)
        scannedFiles++
        val (found, hitCap) = searchMarkdownLines(
            markdown = tab.content,
            query = query,
            foldedNeedle = foldedNeedle,
            caseSensitive = caseSensitive,
            excludeDiagrams = excludeDiagrams,
            keyPrefix = tab.uri ?: "tab:${tab.id}",
            tabId = tab.id,
            uri = tab.uri,
            name = tab.name,
            relative = tab.relative?.takeIf(String::isNotBlank) ?: tab.name,
            dirty = tab.dirty,
            isOpen = true,
            remainingBudget = maxMatches - allMatches.size,
        )
        if (found.isNotEmpty()) {
            allMatches.addAll(found)
            pending.addAll(found)
            if (pending.size >= BATCH_SIZE) flush(done = false)
        }
        if (hitCap || allMatches.size >= maxMatches) {
            truncated = true
            flush(done = true)
            return FolderSearchState(
                query = query,
                caseSensitive = caseSensitive,
                includeDiagrams = !excludeDiagrams,
                matches = allMatches,
                scanning = false,
                scannedFiles = scannedFiles,
                truncated = true,
            )
        }
    }

    val candidates: List<FileEntry> = if (folderRoot != null) {
        walkFolderTree(folderRoot)
    } else {
        orderedRecents(recents).map { rec ->
            FileEntry(rec.name, rec.uri, directory = false, relative = rec.relative?.takeIf(String::isNotBlank) ?: rec.name)
        }
    }

    val dedupedCandidates = ArrayList<Pair<FileEntry, Uri>>(candidates.size)
    for (entry in candidates) {
        coroutineContext.ensureActive()
        val parsedUri = markSeenUri(entry.uri) ?: continue
        dedupedCandidates.add(entry to parsedUri)
    }

    if (dedupedCandidates.isNotEmpty()) {
        coroutineScope {
            val inflight = ArrayDeque<Deferred<Pair<List<FolderSearchMatch>, Boolean>?>>(SEARCH_WINDOW_CONCURRENCY)
            var nextToSubmit = 0

            fun submitNext() {
                while (inflight.size < SEARCH_WINDOW_CONCURRENCY && nextToSubmit < dedupedCandidates.size) {
                    val (entry, parsedUri) = dedupedCandidates[nextToSubmit++]
                    inflight.addLast(
                        async(Dispatchers.IO) {
                            coroutineContext.ensureActive()
                            val markdown = runCatching {
                                openUriStream(parsedUri)?.use { stream -> media.readSearchableNote(stream) }
                            }.getOrNull() ?: return@async null
                            searchMarkdownLines(
                                markdown = markdown,
                                query = query,
                                foldedNeedle = foldedNeedle,
                                caseSensitive = caseSensitive,
                                excludeDiagrams = excludeDiagrams,
                                keyPrefix = entry.uri,
                                tabId = null,
                                uri = entry.uri,
                                name = entry.name,
                                relative = entry.relative.ifBlank { entry.name },
                                dirty = false,
                                isOpen = false,
                                remainingBudget = MAX_MATCHES_PER_NOTE,
                            )
                        },
                    )
                }
            }

            try {
                submitNext()
                while (inflight.isNotEmpty()) {
                    coroutineContext.ensureActive()
                    val task = inflight.removeFirst()
                    submitNext()
                    val scannedResult = task.await() ?: continue
                    scannedFiles++
                    val (found, _) = scannedResult
                    val remaining = maxMatches - allMatches.size
                    if (found.isNotEmpty() && remaining > 0) {
                        val accepted = if (found.size > remaining) found.subList(0, remaining) else found
                        allMatches.addAll(accepted)
                        pending.addAll(accepted)
                        if (pending.size >= BATCH_SIZE) flush(done = false)
                    }
                    if (found.size > remaining || allMatches.size >= maxMatches) {
                        truncated = true
                        break
                    }
                }
            } finally {
                for (task in inflight) {
                    if (!task.isCompleted) task.cancel()
                }
            }
        }
    }

    coroutineContext.ensureActive()
    flush(done = true)
    return FolderSearchState(
        query = query,
        caseSensitive = caseSensitive,
        includeDiagrams = !excludeDiagrams,
        matches = allMatches,
        scanning = false,
        scannedFiles = scannedFiles,
        truncated = truncated,
    )
}
