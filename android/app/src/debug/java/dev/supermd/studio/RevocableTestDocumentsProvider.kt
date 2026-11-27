package dev.supermd.studio

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import java.io.File
import java.io.FileNotFoundException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * Debug-only provider used by instrumentation tests on the emulator to exercise
 * real SAF document/tree URI grants, runtime revocations, and non-permission I/O errors.
 */
internal class RevocableTestDocumentsProvider : ContentProvider() {
    override fun onCreate(): Boolean {
        context?.let { ctx -> initializeRoot(ctx) }
        return true
    }

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor {
        val ctx = checkNotNull(context)
        initializeRoot(ctx)
        enforceAccess(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        val path = uri.path.orEmpty()
        if ("/children" in path) {
            val parentDocId = extractChildrenParentDocId(uri)
            val dir = fileForDocId(ctx, parentDocId)
            if (!dir.exists() || !dir.isDirectory) throw FileNotFoundException("Missing directory: $parentDocId")
            val cols = projection ?: arrayOf(
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                OpenableColumns.SIZE,
            )
            return MatrixCursor(cols).apply {
                dir.listFiles()?.sortedBy { it.name }?.forEach { child ->
                    val childDocId = if (parentDocId == ROOT_DOC_ID) child.name else "$parentDocId/${child.name}"
                    addRow(rowForFile(cols, childDocId, child))
                }
            }
        }
        val docId = DocumentsContract.getDocumentId(uri)
        if (docId in ordinaryQueryErrorDocIds) {
            throw IllegalStateException("Simulated transient provider query glitch for $docId")
        }
        val file = fileForDocId(ctx, docId)
        if (!file.exists()) throw FileNotFoundException("Missing document: $docId")
        val cols = projection ?: arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            OpenableColumns.SIZE,
        )
        return MatrixCursor(cols).apply {
            addRow(rowForFile(cols, docId, file))
        }
    }

    override fun getType(uri: Uri): String {
        val ctx = context ?: return "text/markdown"
        val docId = runCatching { DocumentsContract.getDocumentId(uri) }.getOrNull() ?: return "text/markdown"
        val file = fileForDocId(ctx, docId)
        return when {
            file.isDirectory -> DocumentsContract.Document.MIME_TYPE_DIR
            file.name.endsWith(".smd", ignoreCase = true) -> "application/vnd.supermd.smd"
            else -> "text/markdown"
        }
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0

    override fun call(method: String, arg: String?, extras: Bundle?): Bundle? {
        if (method == "android:renameDocument") {
            val ctx = checkNotNull(context)
            initializeRoot(ctx)
            val inExtras = checkNotNull(extras) { "Missing extras for $method" }
            @Suppress("DEPRECATION")
            val docUri = checkNotNull(inExtras.getParcelable<Uri>("uri")) { "Missing document uri for $method" }
            val displayName = checkNotNull(inExtras.getString(DocumentsContract.Document.COLUMN_DISPLAY_NAME)) {
                "Missing display name for $method"
            }
            enforceAccess(docUri, Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            val docId = DocumentsContract.getDocumentId(docUri)
            renameCallAttempts.computeIfAbsent(docId) { AtomicInteger(0) }.incrementAndGet()
            if (docId in ordinaryRenameErrorDocIds) {
                throw IllegalStateException("Simulated transient provider rename error for $docId")
            }
            val sourceFile = fileForDocId(ctx, docId)
            if (!sourceFile.exists()) {
                throw FileNotFoundException("Missing document for rename: $docId")
            }
            val parentRel = docId.substringBeforeLast('/', missingDelimiterValue = "")
            val newDocId = if (parentRel.isEmpty() || docId == ROOT_DOC_ID) displayName else "$parentRel/$displayName"
            val targetFile = fileForDocId(ctx, newDocId)
            targetFile.parentFile?.mkdirs()
            if (sourceFile.canonicalPath != targetFile.canonicalPath && !sourceFile.renameTo(targetFile)) {
                sourceFile.copyTo(targetFile, overwrite = true)
                sourceFile.delete()
            }
            val auth = docUri.authority ?: authority(ctx)
            val outUri = if (DocumentsContract.isTreeUri(docUri)) {
                val treeRoot = DocumentsContract.getTreeDocumentId(docUri)
                DocumentsContract.buildDocumentUriUsingTree(
                    DocumentsContract.buildTreeDocumentUri(auth, treeRoot),
                    newDocId,
                )
            } else {
                DocumentsContract.buildDocumentUri(auth, newDocId)
            }
            TestAuthorityGrants.transferDirectGrant(docUri, outUri)
            return Bundle().apply { putParcelable("uri", outUri) }
        }
        return super.call(method, arg, extras)
    }

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        val ctx = checkNotNull(context)
        initializeRoot(ctx)
        val required = if (mode == "r") {
            Intent.FLAG_GRANT_READ_URI_PERMISSION
        } else {
            Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        }
        enforceAccess(uri, required)
        val docId = DocumentsContract.getDocumentId(uri)
        if (mode == "r") {
            readOpenAttempts.computeIfAbsent(docId) { java.util.concurrent.atomic.AtomicInteger(0) }.incrementAndGet()
            if (docId in ordinaryReadIoErrorDocIds) {
                throw FileNotFoundException("Simulated transient provider I/O error for $docId")
            }
        }
        val file = fileForDocId(ctx, docId)
        if (!file.exists() && !mode.contains('w')) {
            throw FileNotFoundException("Missing test document: $docId")
        }
        file.parentFile?.mkdirs()
        val flags = when (mode) {
            "r" -> ParcelFileDescriptor.MODE_READ_ONLY
            "rw" -> ParcelFileDescriptor.MODE_READ_WRITE
            "wt", "w" -> ParcelFileDescriptor.MODE_WRITE_ONLY or
                ParcelFileDescriptor.MODE_CREATE or
                ParcelFileDescriptor.MODE_TRUNCATE
            else -> ParcelFileDescriptor.parseMode(mode)
        }
        return ParcelFileDescriptor.open(file, flags)
    }

    private fun enforceAccess(uri: Uri, requiredFlags: Int) {
        val allowed = TestAuthorityGrants.check(uri, requiredFlags) ?: false
        if (!allowed) {
            throw SecurityException(
                "Permission Denial: opening provider ${RevocableTestDocumentsProvider::class.java.name} " +
                    "for $uri requires that you obtain access using ACTION_OPEN_DOCUMENT or related APIs",
            )
        }
    }

    private fun extractChildrenParentDocId(uri: Uri): String {
        val segments = uri.pathSegments
        val idx = segments.lastIndexOf("document")
        if (idx >= 0 && idx + 1 < segments.size) {
            return Uri.decode(segments[idx + 1])
        }
        return DocumentsContract.getTreeDocumentId(uri)
    }

    private fun rowForFile(cols: Array<out String>, docId: String, file: File): Array<Any?> =
        cols.map { col ->
            when (col) {
                DocumentsContract.Document.COLUMN_DOCUMENT_ID -> docId
                DocumentsContract.Document.COLUMN_DISPLAY_NAME, OpenableColumns.DISPLAY_NAME -> file.name
                DocumentsContract.Document.COLUMN_MIME_TYPE -> when {
                    file.isDirectory -> DocumentsContract.Document.MIME_TYPE_DIR
                    file.name.endsWith(".smd", ignoreCase = true) -> "application/vnd.supermd.smd"
                    else -> "text/markdown"
                }
                OpenableColumns.SIZE, DocumentsContract.Document.COLUMN_SIZE -> if (file.isFile) file.length() else 0L
                DocumentsContract.Document.COLUMN_LAST_MODIFIED -> file.lastModified()
                else -> null
            }
        }.toTypedArray()

    companion object {
        const val ROOT_DOC_ID = "root"
        private val ordinaryReadIoErrorDocIds = ConcurrentHashMap.newKeySet<String>()
        private val ordinaryQueryErrorDocIds = ConcurrentHashMap.newKeySet<String>()
        private val ordinaryRenameErrorDocIds = ConcurrentHashMap.newKeySet<String>()
        private val readOpenAttempts = ConcurrentHashMap<String, AtomicInteger>()
        private val renameCallAttempts = ConcurrentHashMap<String, AtomicInteger>()
        @Volatile private var rootDir: File? = null

        fun authority(context: Context): String = "${context.packageName}.testdocs"

        private fun initializeRoot(context: Context): File {
            rootDir?.let { return it }
            return synchronized(this) {
                rootDir ?: File(context.cacheDir, "revocable-test-docs").apply { mkdirs() }.also { rootDir = it }
            }
        }

        fun reset(context: Context) {
            val auth = authority(context)
            TestAuthorityGrants.unregisterAuthority(auth)
            TestAuthorityGrants.registerAuthority(auth)
            ordinaryReadIoErrorDocIds.clear()
            ordinaryQueryErrorDocIds.clear()
            ordinaryRenameErrorDocIds.clear()
            readOpenAttempts.clear()
            renameCallAttempts.clear()
            val dir = initializeRoot(context)
            dir.deleteRecursively()
            dir.mkdirs()
        }

        fun openReadAttempts(docId: String): Int = readOpenAttempts[docId]?.get() ?: 0

        fun renameAttempts(docId: String): Int = renameCallAttempts[docId]?.get() ?: 0

        fun fileForDocId(context: Context, docId: String): File {
            val base = initializeRoot(context)
            return if (docId == ROOT_DOC_ID) base else File(base, docId)
        }

        fun putMarkdown(context: Context, docId: String, content: String): Uri {
            val auth = authority(context)
            TestAuthorityGrants.registerAuthority(auth)
            val file = fileForDocId(context, docId)
            file.parentFile?.mkdirs()
            file.writeText(content, Charsets.UTF_8)
            return DocumentsContract.buildDocumentUri(auth, docId)
        }

        fun treeUri(context: Context, treeRootDocId: String): Uri {
            val auth = authority(context)
            TestAuthorityGrants.registerAuthority(auth)
            fileForDocId(context, treeRootDocId).mkdirs()
            return DocumentsContract.buildTreeDocumentUri(auth, treeRootDocId)
        }

        fun grantReadWrite(uri: Uri, persist: Boolean = true) {
            val rw = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            TestAuthorityGrants.grant(uri, rw, persistable = true)
            if (persist) {
                TestAuthorityGrants.takePersistable(uri, rw)
            }
        }

        fun grantReadOnly(uri: Uri, persist: Boolean = true) {
            val r = Intent.FLAG_GRANT_READ_URI_PERMISSION
            TestAuthorityGrants.grant(uri, r, persistable = true)
            if (persist) {
                TestAuthorityGrants.takePersistable(uri, r)
            }
        }

        fun revokeAll(uri: Uri) {
            TestAuthorityGrants.revoke(uri)
        }

        fun setOrdinaryReadIoError(docId: String, enabled: Boolean) {
            if (enabled) ordinaryReadIoErrorDocIds.add(docId) else ordinaryReadIoErrorDocIds.remove(docId)
        }

        fun setOrdinaryRenameError(docId: String, enabled: Boolean) {
            if (enabled) ordinaryRenameErrorDocIds.add(docId) else ordinaryRenameErrorDocIds.remove(docId)
        }
    }
}
