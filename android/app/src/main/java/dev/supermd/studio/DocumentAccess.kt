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

internal const val EXTERNAL_STORAGE_DOCUMENTS_AUTHORITY = "com.android.externalstorage.documents"

internal data class ExternalStorageDocumentPath(val volume: String, val relativePath: String)

internal fun isKnownPathDocumentProvider(authority: String?): Boolean =
    authority == EXTERNAL_STORAGE_DOCUMENTS_AUTHORITY

internal fun parseExternalStorageDocumentId(documentId: String): ExternalStorageDocumentPath? {
    if (documentId.isEmpty() || '\\' in documentId || '\u0000' in documentId) return null
    val colon = documentId.indexOf(':')
    if (colon <= 0) return null
    val volume = documentId.substring(0, colon)
    if ('/' in volume || ':' in volume || volume == "." || volume == "..") return null
    val rawPath = documentId.substring(colon + 1)
    if (rawPath.isEmpty()) return ExternalStorageDocumentPath(volume, "")
    if (rawPath.startsWith('/')) return null
    val trimmed = rawPath.trimEnd('/')
    if (trimmed.isEmpty()) return null
    if (trimmed.split('/').any { it.isEmpty() || it == "." || it == ".." }) return null
    return ExternalStorageDocumentPath(volume, trimmed)
}

internal fun isKnownPathContainedInTree(
    authority: String?,
    rootDocumentId: String,
    documentId: String,
): Boolean {
    if (!isKnownPathDocumentProvider(authority)) return false
    val root = parseExternalStorageDocumentId(rootDocumentId) ?: return false
    val doc = parseExternalStorageDocumentId(documentId) ?: return false
    if (root.volume != doc.volume) return false
    if (root.relativePath.isEmpty()) return true
    return doc.relativePath == root.relativePath || doc.relativePath.startsWith("${root.relativePath}/")
}

internal fun canonicalTreeDocumentKey(uri: Uri): String? {
    if (uri.scheme != "content" || !DocumentsContract.isTreeUri(uri)) return null
    val authority = uri.authority?.takeIf { it.isNotEmpty() } ?: return null
    val treeRoot = runCatching { DocumentsContract.getTreeDocumentId(uri) }.getOrNull()?.takeIf { it.isNotEmpty() } ?: return null
    val docId = runCatching { DocumentsContract.getDocumentId(uri) }.getOrNull()?.takeIf { it.isNotEmpty() } ?: return null
    return DocumentsContract.buildDocumentUriUsingTree(
        DocumentsContract.buildTreeDocumentUri(authority, treeRoot),
        docId,
    ).toString()
}

internal sealed interface SafReadAccess {
    data class InGrantedTree(
        val treeUri: Uri,
        val rootDocumentId: String,
        val documentId: String,
        val documentUri: Uri,
    ) : SafReadAccess

    data class PendingTreeMembership(
        val treeUri: Uri,
        val rootDocumentId: String,
        val documentId: String,
        val documentUri: Uri,
        val directDocumentUri: Uri? = null,
    ) : SafReadAccess

    data class StandaloneDocument(val documentUri: Uri) : SafReadAccess

    data object Denied : SafReadAccess
}

internal class DocumentAccess(
    private val context: Context,
    private val activeFolderUriProvider: (() -> Uri?)? = null,
    private val relativeHintProvider: ((Uri) -> String?)? = null,
    private val isConfirmedTreeChildProvider: ((treeUri: Uri, documentId: String) -> Boolean)? = null,
    private val onConfirmedTreeKeys: ((Set<String>) -> Unit)? = null,
) {
    private data class CandidateTreeGrant(
        val canonicalTree: Uri,
        val rootDocumentId: String,
        val hasReadAndWrite: Boolean,
    )

    private fun granted(candidate: Uri, modes: Int) =
        context.checkUriPermission(candidate, Process.myPid(), Process.myUid(), modes) == PackageManager.PERMISSION_GRANTED

    fun hasWriteGrant(uri: Uri) = uri.scheme == "content" && granted(uri, Intent.FLAG_GRANT_WRITE_URI_PERMISSION)

    fun hasReadGrant(
        uri: Uri,
        activeFolderUri: Uri? = activeFolderUriProvider?.invoke(),
        isConfirmedTreeChild: ((treeUri: Uri, documentId: String) -> Boolean)? = isConfirmedTreeChildProvider,
    ): Boolean = when (val access = resolveReadAccess(uri, activeFolderUri, isConfirmedTreeChild)) {
        is SafReadAccess.InGrantedTree,
        is SafReadAccess.StandaloneDocument -> true
        is SafReadAccess.PendingTreeMembership -> access.directDocumentUri != null
        SafReadAccess.Denied -> false
    }

    fun persist(uri: Uri) {
        if (uri.scheme == "content") persistDocumentGrants { context.contentResolver.takePersistableUriPermission(uri, it) }
    }

    /** Reuse a user-granted containing tree; never manufacture access outside that tree. */
    fun resolve(uri: Uri, writing: Boolean = false): Uri {
        if (uri.scheme != "content") return uri
        val read = Intent.FLAG_GRANT_READ_URI_PERMISSION
        val write = Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        if (granted(uri, read or write)) return uri
        val authority = uri.authority?.takeIf { it.isNotEmpty() } ?: return uri
        val id = runCatching { DocumentsContract.getDocumentId(uri) }.getOrNull()?.takeIf { it.isNotEmpty() } ?: return uri
        if ('\u0000' in id) return uri
        val knownPathProvider = isKnownPathDocumentProvider(authority)
        if (knownPathProvider && parseExternalStorageDocumentId(id) == null) return uri

        val candidateTrees = collectCandidateTrees(authority, id, writing, knownPathProvider)
        val alreadyReadable = !writing && granted(uri, read)
        if (alreadyReadable && candidateTrees.none { it.hasReadAndWrite }) {
            return uri
        }

        val passLazy = lazy(LazyThreadSafetyMode.NONE) { SafProjectionPass(context.contentResolver) }
        fun matchesTree(candidate: CandidateTreeGrant): Boolean {
            if (knownPathProvider) {
                return isKnownPathContainedInTree(authority, candidate.rootDocumentId, id)
            }
            if (id == candidate.rootDocumentId || isConfirmedTreeChildProvider?.invoke(candidate.canonicalTree, id) == true) {
                return true
            }
            val pass = passLazy.value
            val confirmed = confirmThirdPartyTreeMembership(
                pass = pass,
                treeUri = candidate.canonicalTree,
                rootDocumentId = candidate.rootDocumentId,
                targetDocumentId = id,
                relativeHint = relativeHintProvider?.invoke(uri),
            )
            if (pass.confirmedTreeKeys.isNotEmpty()) {
                onConfirmedTreeKeys?.invoke(pass.confirmedTreeKeys)
            }
            return confirmed
        }

        candidateTrees.firstOrNull { it.hasReadAndWrite && matchesTree(it) }?.let { winner ->
            return DocumentsContract.buildDocumentUriUsingTree(winner.canonicalTree, id)
        }
        if (alreadyReadable) return uri
        candidateTrees.firstOrNull { !it.hasReadAndWrite && matchesTree(it) }?.let { winner ->
            return DocumentsContract.buildDocumentUriUsingTree(winner.canonicalTree, id)
        }
        return uri
    }

    private fun collectCandidateTrees(
        authority: String,
        targetDocumentId: String,
        writing: Boolean,
        knownPathProvider: Boolean,
    ): List<CandidateTreeGrant> {
        val read = Intent.FLAG_GRANT_READ_URI_PERMISSION
        val write = Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        val mode = if (writing) write else read
        val byCanonicalTree = LinkedHashMap<String, CandidateTreeGrant>()

        fun addIfAuthorized(rawTreeUri: Uri, allowRead: Boolean, allowWrite: Boolean) {
            if (!DocumentsContract.isTreeUri(rawTreeUri) || rawTreeUri.authority != authority) return
            if (!allowRead || (writing && !allowWrite)) return
            val rootId = runCatching { DocumentsContract.getTreeDocumentId(rawTreeUri) }.getOrNull()
                ?.takeIf { it.isNotEmpty() && '\u0000' !in it } ?: return
            if (knownPathProvider && parseExternalStorageDocumentId(rootId) == null) return
            val canonicalTree = DocumentsContract.buildTreeDocumentUri(authority, rootId)
            val candidateDoc = DocumentsContract.buildDocumentUriUsingTree(canonicalTree, targetDocumentId)
            val rw = allowWrite && (
                granted(candidateDoc, read or write) ||
                    granted(canonicalTree, read or write) ||
                    granted(rawTreeUri, read or write)
                )
            val modeAuthorized = rw || (
                (!writing || allowWrite) && (
                    granted(candidateDoc, mode) ||
                        granted(canonicalTree, mode) ||
                        granted(rawTreeUri, mode)
                    )
                )
            if (!modeAuthorized) return
            val key = canonicalTree.toString()
            val previous = byCanonicalTree[key]
            if (previous == null || (!previous.hasReadAndWrite && rw)) {
                byCanonicalTree[key] = CandidateTreeGrant(canonicalTree, rootId, rw)
            }
        }

        for (grant in context.contentResolver.persistedUriPermissions) {
            addIfAuthorized(grant.uri, grant.isReadPermission, grant.isWritePermission)
        }
        activeFolderUriProvider?.invoke()?.let { activeFolder ->
            val rw = granted(activeFolder, read or write)
            val r = rw || granted(activeFolder, read)
            addIfAuthorized(activeFolder, allowRead = r, allowWrite = rw)
        }
        return byCanonicalTree.values.toList()
    }

    internal fun readableCandidateTrees(authority: String?, activeFolderUri: Uri? = null): List<Pair<Uri, String>> {
        val auth = authority?.takeIf { it.isNotEmpty() } ?: return emptyList()
        val read = Intent.FLAG_GRANT_READ_URI_PERMISSION
        val knownPathProvider = isKnownPathDocumentProvider(auth)
        val byCanonicalTree = LinkedHashMap<String, Pair<Uri, String>>()
        activeFolderUri?.takeIf { it.authority == auth }?.let { active ->
            resolveReadableTreeRoot(active)?.let { root -> byCanonicalTree[root.first.toString()] = root }
        }
        for (grant in context.contentResolver.persistedUriPermissions) {
            if (!DocumentsContract.isTreeUri(grant.uri) || grant.uri.authority != auth || !grant.isReadPermission) continue
            val rootId = runCatching { DocumentsContract.getTreeDocumentId(grant.uri) }.getOrNull()
                ?.takeIf { it.isNotEmpty() && '\u0000' !in it } ?: continue
            if (knownPathProvider && parseExternalStorageDocumentId(rootId) == null) continue
            val canonicalTree = DocumentsContract.buildTreeDocumentUri(auth, rootId)
            val rootDoc = DocumentsContract.buildDocumentUriUsingTree(canonicalTree, rootId)
            if (granted(canonicalTree, read) || granted(grant.uri, read) || granted(rootDoc, read)) {
                byCanonicalTree.putIfAbsent(canonicalTree.toString(), canonicalTree to rootId)
            }
        }
        return byCanonicalTree.values.toList()
    }

    fun resolveReadableTreeRoot(folderUri: Uri): Pair<Uri, String>? {
        if (folderUri.scheme != "content" || !DocumentsContract.isTreeUri(folderUri)) return null
        val authority = folderUri.authority?.takeIf { it.isNotEmpty() } ?: return null
        val rootId = runCatching { DocumentsContract.getTreeDocumentId(folderUri) }.getOrNull()?.takeIf { it.isNotEmpty() } ?: return null
        if ('\u0000' in rootId) return null
        val knownPathProvider = isKnownPathDocumentProvider(authority)
        if (knownPathProvider && parseExternalStorageDocumentId(rootId) == null) return null
        val read = Intent.FLAG_GRANT_READ_URI_PERMISSION
        val canonicalTree = DocumentsContract.buildTreeDocumentUri(authority, rootId)
        val rootDoc = DocumentsContract.buildDocumentUriUsingTree(canonicalTree, rootId)
        if (granted(folderUri, read) || granted(canonicalTree, read) || granted(rootDoc, read)) {
            return canonicalTree to rootId
        }
        if (knownPathProvider) {
            val resolved = resolve(rootDoc, writing = false)
            if (DocumentsContract.isTreeUri(resolved) && resolved.authority == authority) {
                val parentRoot = runCatching { DocumentsContract.getTreeDocumentId(resolved) }.getOrNull()
                if (parentRoot != null && isKnownPathContainedInTree(authority, parentRoot, rootId)) {
                    val parentTree = DocumentsContract.buildTreeDocumentUri(authority, parentRoot)
                    if (granted(resolved, read) || granted(parentTree, read)) {
                        return parentTree to rootId
                    }
                }
            }
        }
        return null
    }

    fun resolveReadAccess(
        uri: Uri,
        activeFolderUri: Uri? = null,
        isConfirmedTreeChild: ((treeUri: Uri, documentId: String) -> Boolean)? = null,
    ): SafReadAccess {
        if (uri.scheme != "content") return SafReadAccess.Denied
        val authority = uri.authority?.takeIf { it.isNotEmpty() } ?: return SafReadAccess.Denied
        val read = Intent.FLAG_GRANT_READ_URI_PERMISSION
        val knownPathProvider = isKnownPathDocumentProvider(authority)
        val docId = runCatching { DocumentsContract.getDocumentId(uri) }.getOrNull()?.takeIf { it.isNotEmpty() }
            ?: return if (!DocumentsContract.isTreeUri(uri) && granted(uri, read)) SafReadAccess.StandaloneDocument(uri) else SafReadAccess.Denied
        if ('\u0000' in docId) return SafReadAccess.Denied
        if (knownPathProvider && parseExternalStorageDocumentId(docId) == null) {
            return SafReadAccess.Denied
        }

        if (DocumentsContract.isTreeUri(uri)) {
            val treeRoot = runCatching { DocumentsContract.getTreeDocumentId(uri) }.getOrNull()?.takeIf { it.isNotEmpty() }
                ?: return SafReadAccess.Denied
            if ('\u0000' in treeRoot) return SafReadAccess.Denied
            if (knownPathProvider && !isKnownPathContainedInTree(authority, treeRoot, docId)) {
                return SafReadAccess.Denied
            }
            val canonicalTree = DocumentsContract.buildTreeDocumentUri(authority, treeRoot)
            val canonicalDoc = DocumentsContract.buildDocumentUriUsingTree(canonicalTree, docId)
            val plainDoc = DocumentsContract.buildDocumentUri(authority, docId)
            val directGrantDoc = plainDoc.takeIf { granted(it, read) }
            if (granted(uri, read) || granted(canonicalDoc, read) || granted(canonicalTree, read)) {
                return if (knownPathProvider || docId == treeRoot || isConfirmedTreeChild?.invoke(canonicalTree, docId) == true) {
                    SafReadAccess.InGrantedTree(canonicalTree, treeRoot, docId, canonicalDoc)
                } else {
                    SafReadAccess.PendingTreeMembership(canonicalTree, treeRoot, docId, canonicalDoc, directGrantDoc)
                }
            }
            if (directGrantDoc != null) {
                return SafReadAccess.StandaloneDocument(directGrantDoc)
            }
        }

        if (activeFolderUri != null && activeFolderUri.authority == authority) {
            val activeRoot = resolveReadableTreeRoot(activeFolderUri)
            if (activeRoot != null) {
                val (treeUri, rootId) = activeRoot
                val confirmed = if (knownPathProvider) {
                    isKnownPathContainedInTree(authority, rootId, docId)
                } else {
                    docId == rootId || isConfirmedTreeChild?.invoke(treeUri, docId) == true
                }
                if (confirmed) {
                    return SafReadAccess.InGrantedTree(
                        treeUri = treeUri,
                        rootDocumentId = rootId,
                        documentId = docId,
                        documentUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId),
                    )
                }
            }
        }

        for (grant in context.contentResolver.persistedUriPermissions) {
            if (!DocumentsContract.isTreeUri(grant.uri) || grant.uri.authority != authority || !grant.isReadPermission) continue
            val rootId = runCatching { DocumentsContract.getTreeDocumentId(grant.uri) }.getOrNull()?.takeIf { it.isNotEmpty() } ?: continue
            val canonicalTree = DocumentsContract.buildTreeDocumentUri(authority, rootId)
            val confirmed = if (knownPathProvider) {
                isKnownPathContainedInTree(authority, rootId, docId)
            } else {
                docId == rootId || isConfirmedTreeChild?.invoke(canonicalTree, docId) == true
            }
            if (!confirmed) continue
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
