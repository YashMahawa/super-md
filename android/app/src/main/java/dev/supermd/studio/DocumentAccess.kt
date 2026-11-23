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

internal class DocumentAccess(private val context: Context) {
    fun hasWriteGrant(uri: Uri) = uri.scheme == "content" && context.checkUriPermission(uri, Process.myPid(), Process.myUid(), Intent.FLAG_GRANT_WRITE_URI_PERMISSION) == PackageManager.PERMISSION_GRANTED
    fun persist(uri: Uri) {
        if (uri.scheme == "content") persistDocumentGrants { context.contentResolver.takePersistableUriPermission(uri, it) }
    }

    /** Reuse a user-granted containing tree; never manufacture access outside that tree. */
    fun resolve(uri: Uri, writing: Boolean = false): Uri {
        if (uri.scheme != "content") return uri
        val read = Intent.FLAG_GRANT_READ_URI_PERMISSION
        val write = Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        fun granted(candidate: Uri, modes: Int) = context.checkUriPermission(candidate, Process.myPid(), Process.myUid(), modes) == PackageManager.PERMISSION_GRANTED
        if (granted(uri, read or write)) return uri
        val id = runCatching { DocumentsContract.getDocumentId(uri) }.getOrNull() ?: return uri
        val candidates = context.contentResolver.persistedUriPermissions.mapNotNull { grant ->
            if (!DocumentsContract.isTreeUri(grant.uri) || grant.uri.authority != uri.authority || !grant.isReadPermission || writing && !grant.isWritePermission) return@mapNotNull null
            val root = runCatching { DocumentsContract.getTreeDocumentId(grant.uri) }.getOrNull() ?: return@mapNotNull null
            val contained = id == root || id.startsWith(root.trimEnd('/') + "/") || root.endsWith(":") && id.startsWith(root)
            if (!contained) return@mapNotNull null
            DocumentsContract.buildDocumentUriUsingTree(grant.uri, id)
        }
        candidates.firstOrNull { granted(it, read or write) }?.let { return it }
        if (!writing && granted(uri, read)) return uri
        return candidates.firstOrNull { granted(it, if (writing) write else read) } ?: uri
    }
}

internal class RestoreDocumentAccess : ActivityResultContract<Uri, Uri?>() {
    override fun createIntent(context: Context, input: Uri) = Intent(Intent.ACTION_OPEN_DOCUMENT)
        .addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        .putExtra(DocumentsContract.EXTRA_INITIAL_URI, input)
    override fun parseResult(resultCode: Int, intent: Intent?): Uri? = if (resultCode == Activity.RESULT_OK) intent?.data else null
}
