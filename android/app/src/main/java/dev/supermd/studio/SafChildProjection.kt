package dev.supermd.studio

import android.content.ContentResolver
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import java.io.FileNotFoundException
import java.util.Locale

private const val MAX_SAF_RELATIVE_DEPTH = 32
private const val MAX_SAF_RESOLVE_PROJECTION_DIRS = 64

private val SAF_CHILD_PROJECTION = arrayOf(
    DocumentsContract.Document.COLUMN_DOCUMENT_ID,
    DocumentsContract.Document.COLUMN_DISPLAY_NAME,
    DocumentsContract.Document.COLUMN_MIME_TYPE,
    DocumentsContract.Document.COLUMN_FLAGS,
)

internal data class ProjectedSafChild(
    val documentId: String,
    val displayName: String,
    val mimeType: String?,
    val flags: Int = 0,
) {
    val isDirectory: Boolean get() = mimeType == DocumentsContract.Document.MIME_TYPE_DIR
    val isVirtual: Boolean get() = (flags and DocumentsContract.Document.FLAG_VIRTUAL_DOCUMENT) != 0
}

internal data class SafFolderListing(
    val effectiveRelative: String,
    val entries: List<FileEntry>,
)

internal data class SafMetadataRefreshResult(
    val metadata: Map<String, String?>,
    val folderListing: Result<SafFolderListing>?,
    val confirmedTreeKeys: Set<String> = emptySet(),
)

internal fun isSupportedSafFolderNoteName(name: String): Boolean = isSearchableNoteName(name)

internal fun inferSafParentDocumentId(
    authority: String?,
    rootDocumentId: String,
    documentId: String,
): String? {
    if (!isKnownPathContainedInTree(authority, rootDocumentId, documentId)) return null
    val root = parseExternalStorageDocumentId(rootDocumentId) ?: return null
    val doc = parseExternalStorageDocumentId(documentId) ?: return null
    if (doc.relativePath == root.relativePath || doc.relativePath.isEmpty()) return null
    val slash = doc.relativePath.lastIndexOf('/')
    val parentRelative = if (slash < 0) "" else doc.relativePath.substring(0, slash)
    val parentDocId = "${doc.volume}:$parentRelative"
    return parentDocId.takeIf { isKnownPathContainedInTree(authority, rootDocumentId, it) }
}

internal fun querySafChildDocuments(
    resolver: ContentResolver,
    treeUri: Uri,
    parentDocumentId: String,
): List<ProjectedSafChild>? {
    val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentDocumentId)
    val cursor = resolver.query(childrenUri, SAF_CHILD_PROJECTION, null, null, null) ?: return null
    cursor.use { c ->
        val idIndex = c.getColumnIndex(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
        val nameIndex = c.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
        val mimeIndex = c.getColumnIndex(DocumentsContract.Document.COLUMN_MIME_TYPE)
        val flagsIndex = c.getColumnIndex(DocumentsContract.Document.COLUMN_FLAGS)
        val results = ArrayList<ProjectedSafChild>(c.count.coerceAtLeast(0))
        while (c.moveToNext()) {
            val docId = if (idIndex >= 0 && !c.isNull(idIndex)) c.getString(idIndex) else null
            if (docId.isNullOrEmpty()) continue
            val childUri by lazy(LazyThreadSafetyMode.NONE) {
                DocumentsContract.buildDocumentUriUsingTree(treeUri, docId)
            }
            val displayName = when {
                nameIndex >= 0 && !c.isNull(nameIndex) -> c.getString(nameIndex)
                nameIndex < 0 -> querySingleStringColumn(resolver, childUri, DocumentsContract.Document.COLUMN_DISPLAY_NAME)
                else -> null
            }
            if (displayName.isNullOrEmpty()) continue
            val mimeType = when {
                mimeIndex >= 0 && !c.isNull(mimeIndex) -> c.getString(mimeIndex)
                mimeIndex < 0 -> querySingleStringColumn(resolver, childUri, DocumentsContract.Document.COLUMN_MIME_TYPE)
                else -> null
            }
            val flags = if (flagsIndex >= 0 && !c.isNull(flagsIndex)) c.getInt(flagsIndex) else 0
            results.add(ProjectedSafChild(docId, displayName, mimeType, flags))
        }
        return results
    }
}

private fun querySingleStringColumn(resolver: ContentResolver, uri: Uri, column: String): String? =
    runCatching {
        resolver.query(uri, arrayOf(column), null, null, null)?.use { cursor ->
            val index = cursor.getColumnIndex(column).let { if (it >= 0) it else 0 }
            if (cursor.moveToFirst() && cursor.columnCount > index && !cursor.isNull(index)) cursor.getString(index) else null
        }
    }.getOrNull()

internal fun querySingleDocumentMetadata(resolver: ContentResolver, uri: Uri): ProviderMetadata =
    queryProviderMetadata {
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME).let { if (it >= 0) it else 0 }
                val name = if (cursor.columnCount > index && !cursor.isNull(index)) cursor.getString(index) else null
                ProviderMetadata.Found(name)
            } else {
                ProviderMetadata.Missing
            }
        }
    }

/**
 * Per-operation stateless SAF child projection pass.
 * Shares projected directory snapshots within a single [listSafFolderListing] or
 * [refreshSafWorkspaceMetadata] invocation and is discarded immediately upon return.
 */
internal class SafProjectionPass(private val resolver: ContentResolver) {
    sealed interface DirectoryProjection {
        data class Loaded(val children: List<ProjectedSafChild>) : DirectoryProjection
        data object Missing : DirectoryProjection
        data object Denied : DirectoryProjection
        data object Unavailable : DirectoryProjection
    }

    private data class ParentKey(val treeUri: String, val parentDocumentId: String)
    private data class DocKey(val treeUri: String, val documentId: String)

    private val byParent = LinkedHashMap<ParentKey, DirectoryProjection>()
    private val byDocId = LinkedHashMap<DocKey, ProjectedSafChild>()
    private val bySingleUri = LinkedHashMap<String, ProviderMetadata>()
    private val confirmedKeysMutable = LinkedHashSet<String>()

    val confirmedTreeKeys: Set<String> get() = confirmedKeysMutable

    fun querySingleDocument(uri: Uri): ProviderMetadata =
        bySingleUri.getOrPut(uri.toString()) { querySingleDocumentMetadata(resolver, uri) }

    fun projectDirectory(treeUri: Uri, parentDocumentId: String): DirectoryProjection {
        val key = ParentKey(treeUri.toString(), parentDocumentId)
        byParent[key]?.let { return it }
        val result = try {
            val children = querySafChildDocuments(resolver, treeUri, parentDocumentId)
            if (children == null) {
                DirectoryProjection.Unavailable
            } else {
                children.forEach { child ->
                    byDocId.putIfAbsent(DocKey(treeUri.toString(), child.documentId), child)
                    if (!child.isDirectory && !child.isVirtual) {
                        confirmedKeysMutable.add(
                            DocumentsContract.buildDocumentUriUsingTree(treeUri, child.documentId).toString(),
                        )
                    }
                }
                DirectoryProjection.Loaded(children)
            }
        } catch (_: FileNotFoundException) {
            DirectoryProjection.Missing
        } catch (error: Exception) {
            if (isDocumentAccessFailure(error)) DirectoryProjection.Denied else DirectoryProjection.Unavailable
        }
        byParent[key] = result
        return result
    }

    fun walkRelativeDirectory(treeUri: Uri, rootDocumentId: String, relative: String): DirectoryProjection {
        val segments = relative.split('/').filter { it.isNotEmpty() }
        if (segments.size > MAX_SAF_RELATIVE_DEPTH || segments.any { it == "." || it == ".." || '\\' in it || '\u0000' in it }) {
            return DirectoryProjection.Missing
        }
        var currentDocumentId = rootDocumentId
        for (part in segments) {
            when (val current = projectDirectory(treeUri, currentDocumentId)) {
                is DirectoryProjection.Loaded -> {
                    val next = current.children.firstOrNull { it.displayName == part && it.isDirectory && !it.isVirtual }
                        ?: return DirectoryProjection.Missing
                    currentDocumentId = next.documentId
                }
                DirectoryProjection.Missing,
                DirectoryProjection.Denied,
                DirectoryProjection.Unavailable -> return current
            }
        }
        return projectDirectory(treeUri, currentDocumentId)
    }

    fun hasProjectedDocument(treeUri: Uri, documentId: String): Boolean =
        byDocId.containsKey(DocKey(treeUri.toString(), documentId))

    fun findProjectedDocument(treeUri: Uri, documentId: String): ProjectedSafChild? =
        byDocId[DocKey(treeUri.toString(), documentId)]
}

internal fun hasInvalidSafFolderRelative(relative: String): Boolean {
    if ('\\' in relative || '\u0000' in relative) return true
    val parts = relative.split('/').map { it.trim() }.filter { it.isNotEmpty() }
    return parts.size > MAX_SAF_RELATIVE_DEPTH || parts.any { it == "." || it == ".." }
}

internal fun listSafFolderListing(
    resolver: ContentResolver,
    documentAccess: DocumentAccess,
    folderUri: Uri,
    relative: String,
    pass: SafProjectionPass = SafProjectionPass(resolver),
): SafFolderListing {
    require(!hasInvalidSafFolderRelative(relative)) { "Invalid folder path" }
    val normalizedRequested = normalizeRelativePath(relative)
    val segments = normalizedRequested.split('/').filter { it.isNotEmpty() }
    val (treeUri, rootDocumentId) = documentAccess.resolveReadableTreeRoot(folderUri)
        ?: error("Choose the folder again to restore access")
    var currentChildren = when (val rootProjection = pass.projectDirectory(treeUri, rootDocumentId)) {
        is SafProjectionPass.DirectoryProjection.Loaded -> rootProjection.children
        SafProjectionPass.DirectoryProjection.Denied -> error("Choose the folder again to restore access")
        SafProjectionPass.DirectoryProjection.Missing,
        SafProjectionPass.DirectoryProjection.Unavailable -> error("Folder disappeared")
    }
    val resolvedParts = ArrayList<String>(segments.size)
    for (part in segments) {
        val nextDir = currentChildren.firstOrNull { it.displayName == part && it.isDirectory && !it.isVirtual } ?: break
        when (val nextProjection = pass.projectDirectory(treeUri, nextDir.documentId)) {
            is SafProjectionPass.DirectoryProjection.Loaded -> {
                resolvedParts += part
                currentChildren = nextProjection.children
            }
            SafProjectionPass.DirectoryProjection.Missing -> break
            SafProjectionPass.DirectoryProjection.Denied -> error("Choose the folder again to restore access")
            SafProjectionPass.DirectoryProjection.Unavailable -> error("Folder disappeared")
        }
    }
    val actualRelative = resolvedParts.joinToString("/")
    val prefix = if (actualRelative.isEmpty()) "" else "$actualRelative/"
    val entries = currentChildren.mapNotNull { child ->
        val name = child.displayName
        if (name.startsWith('.') || child.isVirtual) return@mapNotNull null
        if (child.isDirectory || isSupportedSafFolderNoteName(name)) {
            val childUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, child.documentId).toString()
            FileEntry(name, childUri, child.isDirectory, prefix + name)
        } else {
            null
        }
    }.sortedWith(compareByDescending<FileEntry> { it.directory }.thenBy { it.name.lowercase(Locale.ROOT) })
    return SafFolderListing(actualRelative, entries)
}

internal fun refreshSafWorkspaceMetadata(
    resolver: ContentResolver,
    documentAccess: DocumentAccess,
    uris: List<String>,
    relativeHints: Map<String, String> = emptyMap(),
    folderUriRaw: String? = null,
    listedRelative: String = "",
    confirmedTreeKeys: Set<String> = emptySet(),
): SafMetadataRefreshResult {
    val pass = SafProjectionPass(resolver)
    val activeFolderUri = folderUriRaw?.let(Uri::parse)
    val folderListing = activeFolderUri?.let { folderUri ->
        runCatching { listSafFolderListing(resolver, documentAccess, folderUri, listedRelative, pass) }
    }
    val metadata = LinkedHashMap<String, String?>()
    for (raw in uris) {
        val uri = Uri.parse(raw)
        if (uri.scheme != "content") continue
        when (
            val info = resolveNoteMetadataInPass(
                documentAccess = documentAccess,
                pass = pass,
                uri = uri,
                activeFolderUri = activeFolderUri,
                relativeHint = relativeHints[raw],
                confirmedTreeKeys = confirmedTreeKeys,
            )
        ) {
            is ProviderMetadata.Found -> info.name?.takeIf { it.isNotBlank() }?.let { metadata[raw] = it }
            ProviderMetadata.Missing -> metadata[raw] = null
            ProviderMetadata.Unavailable -> Unit
        }
    }
    return SafMetadataRefreshResult(metadata, folderListing, pass.confirmedTreeKeys)
}

internal fun confirmThirdPartyTreeMembership(
    pass: SafProjectionPass,
    treeUri: Uri,
    rootDocumentId: String,
    targetDocumentId: String,
    relativeHint: String? = null,
): Boolean {
    fun isConfirmedDocument(): Boolean =
        pass.findProjectedDocument(treeUri, targetDocumentId)?.let { !it.isDirectory && !it.isVirtual } == true

    if (targetDocumentId == rootDocumentId) return true
    pass.findProjectedDocument(treeUri, targetDocumentId)?.let { return !it.isDirectory && !it.isVirtual }
    if (!relativeHint.isNullOrBlank()) {
        pass.walkRelativeDirectory(treeUri, rootDocumentId, relativeHint.substringBeforeLast('/', ""))
        pass.findProjectedDocument(treeUri, targetDocumentId)?.let { return !it.isDirectory && !it.isVirtual }
    }
    val visited = HashSet<String>()
    val queue = ArrayDeque<Pair<String, Int>>()
    queue.addLast(rootDocumentId to 0)
    visited.add(rootDocumentId)
    var projectedDirs = 0
    while (queue.isNotEmpty() && projectedDirs < MAX_SAF_RESOLVE_PROJECTION_DIRS) {
        val (currentId, depth) = queue.removeFirst()
        projectedDirs++
        val projection = pass.projectDirectory(treeUri, currentId)
        pass.findProjectedDocument(treeUri, targetDocumentId)?.let { return !it.isDirectory && !it.isVirtual }
        if (projection is SafProjectionPass.DirectoryProjection.Loaded && depth < MAX_SAF_RELATIVE_DEPTH) {
            for (child in projection.children) {
                if (child.isDirectory && !child.isVirtual && visited.add(child.documentId)) {
                    queue.addLast(child.documentId to (depth + 1))
                }
            }
        }
    }
    return isConfirmedDocument()
}

private fun resolveNoteMetadataInPass(
    documentAccess: DocumentAccess,
    pass: SafProjectionPass,
    uri: Uri,
    activeFolderUri: Uri?,
    relativeHint: String?,
    confirmedTreeKeys: Set<String>,
): ProviderMetadata {
    val isConfirmed: (Uri, String) -> Boolean = { treeUri, docId ->
        pass.hasProjectedDocument(treeUri, docId) ||
            DocumentsContract.buildDocumentUriUsingTree(treeUri, docId).toString() in confirmedTreeKeys
    }
    return when (val access = documentAccess.resolveReadAccess(uri, activeFolderUri, isConfirmed)) {
        SafReadAccess.Denied -> {
            if (!DocumentsContract.isTreeUri(uri) && !isKnownPathDocumentProvider(uri.authority)) {
                val docId = runCatching { DocumentsContract.getDocumentId(uri) }.getOrNull()?.takeIf { it.isNotEmpty() && '\u0000' !in it }
                if (docId != null) {
                    for ((treeUri, rootId) in documentAccess.readableCandidateTrees(uri.authority, activeFolderUri)) {
                        confirmThirdPartyTreeMembership(pass, treeUri, rootId, docId, relativeHint)
                        pass.findProjectedDocument(treeUri, docId)?.let { projected ->
                            return if (projected.isDirectory) ProviderMetadata.Missing else ProviderMetadata.Found(projected.displayName)
                        }
                    }
                }
            }
            ProviderMetadata.Unavailable
        }
        is SafReadAccess.StandaloneDocument -> pass.querySingleDocument(access.documentUri)
        is SafReadAccess.InGrantedTree -> {
            pass.findProjectedDocument(access.treeUri, access.documentId)?.let { projected ->
                return if (projected.isDirectory) ProviderMetadata.Missing else ProviderMetadata.Found(projected.displayName)
            }
            val inferredParent = inferSafParentDocumentId(access.treeUri.authority, access.rootDocumentId, access.documentId)
            val projection = when {
                inferredParent != null -> pass.projectDirectory(access.treeUri, inferredParent)
                relativeHint != null -> pass.walkRelativeDirectory(
                    access.treeUri,
                    access.rootDocumentId,
                    relativeHint.substringBeforeLast('/', ""),
                )
                else -> null
            }
            pass.findProjectedDocument(access.treeUri, access.documentId)?.let { projected ->
                return if (projected.isDirectory) ProviderMetadata.Missing else ProviderMetadata.Found(projected.displayName)
            }
            when (projection) {
                SafProjectionPass.DirectoryProjection.Denied,
                SafProjectionPass.DirectoryProjection.Unavailable -> ProviderMetadata.Unavailable
                is SafProjectionPass.DirectoryProjection.Loaded,
                SafProjectionPass.DirectoryProjection.Missing,
                null -> pass.querySingleDocument(access.documentUri)
            }
        }
        is SafReadAccess.PendingTreeMembership -> {
            pass.findProjectedDocument(access.treeUri, access.documentId)?.let { projected ->
                return if (projected.isDirectory) ProviderMetadata.Missing else ProviderMetadata.Found(projected.displayName)
            }
            val projection = when {
                relativeHint != null -> pass.walkRelativeDirectory(
                    access.treeUri,
                    access.rootDocumentId,
                    relativeHint.substringBeforeLast('/', ""),
                )
                access.directDocumentUri == null -> pass.projectDirectory(access.treeUri, access.rootDocumentId)
                else -> null
            }
            pass.findProjectedDocument(access.treeUri, access.documentId)?.let { projected ->
                return if (projected.isDirectory) ProviderMetadata.Missing else ProviderMetadata.Found(projected.displayName)
            }
            val previouslyConfirmed = access.documentUri.toString() in confirmedTreeKeys ||
                canonicalTreeDocumentKey(uri)?.let { it in confirmedTreeKeys } == true
            when (projection) {
                SafProjectionPass.DirectoryProjection.Denied,
                SafProjectionPass.DirectoryProjection.Unavailable -> ProviderMetadata.Unavailable
                is SafProjectionPass.DirectoryProjection.Loaded,
                SafProjectionPass.DirectoryProjection.Missing,
                null -> when {
                    access.directDocumentUri != null -> pass.querySingleDocument(access.directDocumentUri)
                    previouslyConfirmed -> pass.querySingleDocument(access.documentUri)
                    else -> ProviderMetadata.Unavailable
                }
            }
        }
    }
}
