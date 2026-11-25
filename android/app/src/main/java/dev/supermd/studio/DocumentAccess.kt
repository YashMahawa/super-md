package dev.supermd.studio

import android.content.Context
import android.content.Intent
import android.app.Activity
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Process
import android.provider.DocumentsContract
import android.system.ErrnoException
import android.system.OsConstants
import androidx.activity.result.contract.ActivityResultContract

data class DocumentAccessRequest(val uri: String, val name: String, val noteId: String?, val writing: Boolean, val detail: String? = null, val assetSource: String? = null)

internal const val DOCUMENT_ACCESS_MESSAGE = "File access needs to be restored. Your edits are kept in the local draft. Choose the original file in Android's file picker, or save a copy."
internal const val LINKED_ASSET_ACCESS_MESSAGE = "Linked file access is needed. Choose the linked file in Android's file picker, then retry the export. Your note is unchanged."
internal class LinkedAssetAccessRequiredException : SecurityException(LINKED_ASSET_ACCESS_MESSAGE)

/** Take each offered grant independently: a read-only offer must not lose its read grant. */
internal fun persistDocumentGrants(take: (Int) -> Unit): Int {
    var retained = 0
    for (mode in listOf(Intent.FLAG_GRANT_READ_URI_PERMISSION, Intent.FLAG_GRANT_WRITE_URI_PERMISSION)) {
        try { take(mode); retained = retained or mode } catch (_: SecurityException) { }
    }
    return retained
}

internal fun isDocumentAccessFailure(error: Throwable): Boolean = generateSequence(error) { it.cause }
    .take(16).any { it is SecurityException || it is ErrnoException && it.errno in listOf(OsConstants.EACCES, OsConstants.EPERM) }

/** Grants apply to URIs, not filenames. A tree URI and a plain URI can identify the same document. */
internal fun sameDocument(left: Uri, right: Uri): Boolean {
    if (left == right) return true
    if (left.scheme != "content" || right.scheme != "content" || left.authority != right.authority) return false
    val first = runCatching { DocumentsContract.getDocumentId(left) }.getOrNull() ?: return false
    return first == runCatching { DocumentsContract.getDocumentId(right) }.getOrNull()
}

internal fun isDocumentContainedInTree(rootDocumentId: String, documentId: String): Boolean {
    if (rootDocumentId.isEmpty() || documentId.isEmpty()) return false
    if ('\\' in rootDocumentId || '\u0000' in rootDocumentId || '\\' in documentId || '\u0000' in documentId) return false
    if (rootDocumentId.split('/').any { it == "." || it == ".." }) return false
    if (documentId.split('/').any { it == "." || it == ".." }) return false
    if (documentId == rootDocumentId) return true
    if (rootDocumentId == "/") return documentId.startsWith("/")
    val normalizedRoot = rootDocumentId.trimEnd('/')
    if (normalizedRoot.isNotEmpty() && (documentId == normalizedRoot || documentId.startsWith("$normalizedRoot/"))) return true
    if (rootDocumentId.endsWith(':') && documentId.startsWith(rootDocumentId)) {
        val remainder = documentId.removePrefix(rootDocumentId)
        return remainder.split('/').none { it == "." || it == ".." }
    }
    return false
}

internal sealed interface SafReadAccess {
    data class InGrantedTree(
        val treeUri: Uri,
        val rootDocumentId: String,
        val documentId: String,
        val documentUri: Uri,
    ) : SafReadAccess

    data class StandaloneDocument(val documentUri: Uri) : SafReadAccess

    data object Denied : SafReadAccess
}

internal class DocumentAccess(private val context: Context) {
    private fun granted(candidate: Uri, modes: Int) =
        context.checkUriPermission(candidate, Process.myPid(), Process.myUid(), modes) == PackageManager.PERMISSION_GRANTED

    fun hasWriteGrant(uri: Uri) = uri.scheme == "content" && granted(uri, Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
    fun hasReadGrant(uri: Uri, activeFolderUri: Uri? = null) = resolveReadAccess(uri, activeFolderUri) !is SafReadAccess.Denied

    fun persist(uri: Uri) {
        if (uri.scheme == "content") persistDocumentGrants { context.contentResolver.takePersistableUriPermission(uri, it) }
    }

    /** Reuse a user-granted containing tree; never manufacture access outside that tree. */
    fun resolve(uri: Uri, writing: Boolean = false): Uri {
        if (uri.scheme != "content") return uri
        val read = Intent.FLAG_GRANT_READ_URI_PERMISSION
        val write = Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        if (granted(uri, read or write)) return uri
        val id = runCatching { DocumentsContract.getDocumentId(uri) }.getOrNull() ?: return uri
        val candidates = context.contentResolver.persistedUriPermissions.mapNotNull { grant ->
            if (!DocumentsContract.isTreeUri(grant.uri) || grant.uri.authority != uri.authority || !grant.isReadPermission || writing && !grant.isWritePermission) return@mapNotNull null
            val root = runCatching { DocumentsContract.getTreeDocumentId(grant.uri) }.getOrNull() ?: return@mapNotNull null
            if (!isDocumentContainedInTree(root, id)) return@mapNotNull null
            grant.uri to DocumentsContract.buildDocumentUriUsingTree(grant.uri, id)
        }
        candidates.firstOrNull { (tree, doc) -> granted(doc, read or write) || granted(tree, read or write) }?.let { return it.second }
        if (!writing && granted(uri, read)) return uri
        val mode = if (writing) write else read
        return candidates.firstOrNull { (tree, doc) -> granted(doc, mode) || granted(tree, mode) }?.second ?: uri
    }

    fun resolveReadableTreeRoot(folderUri: Uri): Pair<Uri, String>? {
        if (folderUri.scheme != "content" || !DocumentsContract.isTreeUri(folderUri)) return null
        val authority = folderUri.authority?.takeIf { it.isNotEmpty() } ?: return null
        val rootId = runCatching { DocumentsContract.getTreeDocumentId(folderUri) }.getOrNull()?.takeIf { it.isNotEmpty() } ?: return null
        if ('\\' in rootId || '\u0000' in rootId || rootId.split('/').any { it == "." || it == ".." }) return null
        val read = Intent.FLAG_GRANT_READ_URI_PERMISSION
        val canonicalTree = DocumentsContract.buildTreeDocumentUri(authority, rootId)
        val rootDoc = DocumentsContract.buildDocumentUriUsingTree(canonicalTree, rootId)
        if (granted(folderUri, read) || granted(canonicalTree, read) || granted(rootDoc, read)) {
            return canonicalTree to rootId
        }
        val resolved = resolve(rootDoc, writing = false)
        if (DocumentsContract.isTreeUri(resolved) && resolved.authority == authority) {
            val parentRoot = runCatching { DocumentsContract.getTreeDocumentId(resolved) }.getOrNull()
            if (parentRoot != null && isDocumentContainedInTree(parentRoot, rootId)) {
                val parentTree = DocumentsContract.buildTreeDocumentUri(authority, parentRoot)
                if (granted(resolved, read) || granted(parentTree, read)) {
                    return parentTree to rootId
                }
            }
        }
        return null
    }

    fun resolveReadAccess(uri: Uri, activeFolderUri: Uri? = null): SafReadAccess {
        if (uri.scheme != "content") return SafReadAccess.Denied
        val authority = uri.authority?.takeIf { it.isNotEmpty() } ?: return SafReadAccess.Denied
        val read = Intent.FLAG_GRANT_READ_URI_PERMISSION
        val docId = runCatching { DocumentsContract.getDocumentId(uri) }.getOrNull()?.takeIf { it.isNotEmpty() }
            ?: return if (!DocumentsContract.isTreeUri(uri) && granted(uri, read)) SafReadAccess.StandaloneDocument(uri) else SafReadAccess.Denied
        if ('\\' in docId || '\u0000' in docId || docId.split('/').any { it == "." || it == ".." }) {
            return SafReadAccess.Denied
        }

        if (DocumentsContract.isTreeUri(uri)) {
            val treeRoot = runCatching { DocumentsContract.getTreeDocumentId(uri) }.getOrNull()?.takeIf { it.isNotEmpty() }
                ?: return SafReadAccess.Denied
            if ('\\' in treeRoot || '\u0000' in treeRoot || treeRoot.split('/').any { it == "." || it == ".." }) {
                return SafReadAccess.Denied
            }
            val looksHierarchical = '/' in treeRoot || '/' in docId || treeRoot.endsWith(':')
            if (looksHierarchical && !isDocumentContainedInTree(treeRoot, docId)) {
                return SafReadAccess.Denied
            }
            if (!looksHierarchical && docId != treeRoot && docId.startsWith("$treeRoot-")) {
                return SafReadAccess.Denied
            }
            val canonicalTree = DocumentsContract.buildTreeDocumentUri(authority, treeRoot)
            val canonicalDoc = DocumentsContract.buildDocumentUriUsingTree(canonicalTree, docId)
            if (granted(uri, read) || granted(canonicalDoc, read) || granted(canonicalTree, read)) {
                return SafReadAccess.InGrantedTree(canonicalTree, treeRoot, docId, canonicalDoc)
            }
        }

        if (activeFolderUri != null && activeFolderUri.authority == authority) {
            val activeRoot = resolveReadableTreeRoot(activeFolderUri)
            if (activeRoot != null && isDocumentContainedInTree(activeRoot.second, docId)) {
                val (treeUri, rootId) = activeRoot
                return SafReadAccess.InGrantedTree(
                    treeUri = treeUri,
                    rootDocumentId = rootId,
                    documentId = docId,
                    documentUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId),
                )
            }
        }

        for (grant in context.contentResolver.persistedUriPermissions) {
            if (!DocumentsContract.isTreeUri(grant.uri) || grant.uri.authority != authority || !grant.isReadPermission) continue
            val rootId = runCatching { DocumentsContract.getTreeDocumentId(grant.uri) }.getOrNull()?.takeIf { it.isNotEmpty() } ?: continue
            if (!isDocumentContainedInTree(rootId, docId)) continue
            val canonicalTree = DocumentsContract.buildTreeDocumentUri(authority, rootId)
            val treeDoc = DocumentsContract.buildDocumentUriUsingTree(canonicalTree, docId)
            if (granted(treeDoc, read) || granted(canonicalTree, read) || granted(grant.uri, read)) {
                return SafReadAccess.InGrantedTree(canonicalTree, rootId, docId, treeDoc)
            }
        }

        if (!DocumentsContract.isTreeUri(uri) && granted(uri, read)) {
            return SafReadAccess.StandaloneDocument(uri)
        }
        return SafReadAccess.Denied
    }
}

internal class RestoreDocumentAccess : ActivityResultContract<Uri, Uri?>() {
    override fun createIntent(context: Context, input: Uri) = Intent(Intent.ACTION_OPEN_DOCUMENT)
        .addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        .putExtra(DocumentsContract.EXTRA_INITIAL_URI, input)
    override fun parseResult(resultCode: Int, intent: Intent?): Uri? = if (resultCode == Activity.RESULT_OK) intent?.data else null
}
