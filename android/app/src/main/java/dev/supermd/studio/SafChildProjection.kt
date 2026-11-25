package dev.supermd.studio

import android.content.ContentResolver
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import java.io.FileNotFoundException
import java.util.Locale

private val FOLDER_LIST_NOTE_EXTENSIONS = setOf("md", "smd", "markdown", "fmd")
private const val MAX_SAF_RELATIVE_DEPTH = 32

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

internal data class SafMetadataRefreshResult(
    val metadata: Map<String, String?>,
    val folderEntries: Result<List<FileEntry>>?,
)

internal fun isSupportedSafFolderNoteName(name: String): Boolean {
    if (name.isBlank() || name.startsWith('.')) return false
    val dot = name.lastIndexOf('.')
    if (dot <= 0 || dot == name.lastIndex) return false
    return name.substring(dot + 1).lowercase(Locale.ROOT) in FOLDER_LIST_NOTE_EXTENSIONS
}

internal fun inferSafParentDocumentId(rootDocumentId: String, documentId: String): String? {
    if (documentId == rootDocumentId || !isDocumentContainedInTree(rootDocumentId, documentId)) return null
    val slash = documentId.lastIndexOf('/')
    if (slash >= 0) {
        val parent = if (slash == 0 && rootDocumentId == "/") "/" else documentId.substring(0, slash)
        if (parent.isNotEmpty() && isDocumentContainedInTree(rootDocumentId, parent)) return parent
    }
    if (rootDocumentId.endsWith(':') && documentId.startsWith(rootDocumentId)) {
        return rootDocumentId
    }
    return null
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
 * Shares projected directory snapshots within a single [listSafFolderEntries] or
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

    fun findProjectedDocument(treeUri: Uri, documentId: String): ProjectedSafChild? =
        byDocId[DocKey(treeUri.toString(), documentId)]
}

internal fun listSafFolderEntries(
    resolver: ContentResolver,
    documentAccess: DocumentAccess,
    folderUri: Uri,
    relative: String,
    pass: SafProjectionPass = SafProjectionPass(resolver),
): List<FileEntry> {
    val segments = relative.split('/').filter { it.isNotEmpty() }
    require(segments.size <= MAX_SAF_RELATIVE_DEPTH && segments.none { it == "." || it == ".." || '\\' in it || '\u0000' in it }) {
        "Invalid folder path"
    }
    val (treeUri, rootDocumentId) = documentAccess.resolveReadableTreeRoot(folderUri)
        ?: error("Choose the folder again to restore access")
    val normalizedRelative = segments.joinToString("/")
    val leaf = pass.walkRelativeDirectory(treeUri, rootDocumentId, normalizedRelative)
    val children = when (leaf) {
        is SafProjectionPass.DirectoryProjection.Loaded -> leaf.children
        SafProjectionPass.DirectoryProjection.Denied -> error("Choose the folder again to restore access")
        SafProjectionPass.DirectoryProjection.Missing,
        SafProjectionPass.DirectoryProjection.Unavailable -> error("Folder disappeared")
    }
    val prefix = if (normalizedRelative.isEmpty()) "" else "$normalizedRelative/"
    return children.mapNotNull { child ->
        val name = child.displayName
        if (name.startsWith('.') || child.isVirtual) return@mapNotNull null
        if (child.isDirectory || isSupportedSafFolderNoteName(name)) {
            val childUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, child.documentId).toString()
            FileEntry(name, childUri, child.isDirectory, prefix + name)
        } else {
            null
        }
    }.sortedWith(compareByDescending<FileEntry> { it.directory }.thenBy { it.name.lowercase(Locale.ROOT) })
}

internal fun refreshSafWorkspaceMetadata(
    resolver: ContentResolver,
    documentAccess: DocumentAccess,
    uris: List<String>,
    relativeHints: Map<String, String> = emptyMap(),
    folderUriRaw: String? = null,
    listedRelative: String = "",
): SafMetadataRefreshResult {
    val pass = SafProjectionPass(resolver)
    val activeFolderUri = folderUriRaw?.let(Uri::parse)
    val folderEntries = activeFolderUri?.let { folderUri ->
        runCatching { listSafFolderEntries(resolver, documentAccess, folderUri, listedRelative, pass) }
    }
    val metadata = LinkedHashMap<String, String?>()
    for (raw in uris) {
        val uri = Uri.parse(raw)
        if (uri.scheme != "content") continue
        when (val info = resolveNoteMetadataInPass(resolver, documentAccess, pass, uri, activeFolderUri, relativeHints[raw])) {
            is ProviderMetadata.Found -> info.name?.takeIf { it.isNotBlank() }?.let { metadata[raw] = it }
            ProviderMetadata.Missing -> metadata[raw] = null
            ProviderMetadata.Unavailable -> Unit
        }
    }
    return SafMetadataRefreshResult(metadata, folderEntries)
}

private fun resolveNoteMetadataInPass(
    resolver: ContentResolver,
    documentAccess: DocumentAccess,
    pass: SafProjectionPass,
    uri: Uri,
    activeFolderUri: Uri?,
    relativeHint: String?,
): ProviderMetadata = when (val access = documentAccess.resolveReadAccess(uri, activeFolderUri)) {
    SafReadAccess.Denied -> ProviderMetadata.Unavailable
    is SafReadAccess.StandaloneDocument -> querySingleDocumentMetadata(resolver, access.documentUri)
    is SafReadAccess.InGrantedTree -> {
        pass.findProjectedDocument(access.treeUri, access.documentId)?.let { projected ->
            return if (projected.isDirectory) ProviderMetadata.Missing else ProviderMetadata.Found(projected.displayName)
        }
        val inferredParent = inferSafParentDocumentId(access.rootDocumentId, access.documentId)
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
            null -> querySingleDocumentMetadata(resolver, access.documentUri)
        }
    }
}
