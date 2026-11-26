package dev.supermd.studio

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.os.Process
import android.provider.DocumentsContract
import android.system.Os
import android.system.OsConstants
import java.io.File
import java.io.InputStream
import java.nio.file.Files
import java.nio.file.Paths

internal data class ExternalIntentCaller(
    val uid: Int? = null,
    val callerGrantedOwnShareUri: Boolean = false,
)

internal sealed interface ExternalDocumentDecision {
    data object NoDocument : ExternalDocumentDecision
    data class Allowed(val uri: Uri, val intentFlags: Int) : ExternalDocumentDecision
    data class ExpiredGrant(val uri: Uri) : ExternalDocumentDecision
    data class Rejected(val uri: Uri, val reason: String) : ExternalDocumentDecision
}

/**
 * Validates untrusted external document entry points (MainActivity incoming Intents)
 * before persisting permissions, resolving URIs, or reading document bytes.
 *
 * Normal system picker selections (ACTION_OPEN_DOCUMENT / RestoreDocumentAccess) and
 * internal workspace/folder/recent restores do not pass through this gate.
 */
internal object ExternalDocumentEntryGuard {
    private val allowedActions = setOf(
        Intent.ACTION_VIEW,
        Intent.ACTION_EDIT,
        Intent.ACTION_MAIN,
    )

    private val restrictedSystemRoots = listOf(
        "/proc",
        "/sys",
        "/dev",
        "/data/data",
        "/data/user",
        "/data/user_de",
        "/data/misc",
    )

    fun dispatchIncomingIntent(
        context: Context,
        incoming: Intent?,
        savedInstanceState: Bundle?,
        initial: Boolean,
        targetModel: StudioViewModel,
        caller: ExternalIntentCaller = ExternalIntentCaller(),
    ) {
        val rawUri = incoming?.data ?: return
        if (initial && savedInstanceState != null) {
            val state = targetModel.state.value
            if (state.tabs.any { it.uri == rawUri.toString() } || state.closedTabs.any { it.uri == rawUri.toString() }) {
                return
            }
        }
        when (val decision = validateIncomingIntent(context, incoming, caller)) {
            ExternalDocumentDecision.NoDocument -> Unit
            is ExternalDocumentDecision.Allowed -> {
                persistOfferedIntentGrants(context, decision.uri, decision.intentFlags, caller)
                if (initial) targetModel.requestInitialExternalOpen(decision.uri, decision.intentFlags, caller)
                else targetModel.requestExternalOpen(decision.uri, decision.intentFlags, caller)
            }
            is ExternalDocumentDecision.ExpiredGrant -> {
                targetModel.handleExpiredExternalOpenGrant(decision.uri, initial = initial)
            }
            is ExternalDocumentDecision.Rejected -> {
                targetModel.rejectExternalOpen(decision.uri, decision.reason, initial = initial)
            }
        }
    }

    fun validateIncomingIntent(
        context: Context,
        intent: Intent?,
        caller: ExternalIntentCaller = ExternalIntentCaller(),
    ): ExternalDocumentDecision {
        val uri = intent?.data ?: return ExternalDocumentDecision.NoDocument
        val action = intent.action
        if (action != null && action !in allowedActions) {
            return ExternalDocumentDecision.Rejected(uri, "Unsupported document intent action")
        }
        return when (uri.scheme?.lowercase()) {
            "content" -> validateContentIntent(context, uri, intent.flags, caller)
            "file" -> validateFileIntent(context, uri, intent.flags)
            else -> ExternalDocumentDecision.Rejected(uri, "Unsupported document URI scheme")
        }
    }

    private fun validateContentIntent(
        context: Context,
        uri: Uri,
        intentFlags: Int,
        caller: ExternalIntentCaller,
    ): ExternalDocumentDecision {
        if (uri.authority.isNullOrBlank()) {
            return ExternalDocumentDecision.Rejected(uri, "Missing document provider authority")
        }
        if (DocumentsContract.isTreeUri(uri)) {
            return ExternalDocumentDecision.Rejected(uri, "Folder URIs cannot be opened as a note")
        }
        if ((intentFlags and Intent.FLAG_GRANT_READ_URI_PERMISSION) == 0) {
            return ExternalDocumentDecision.Rejected(uri, "Document read access was not granted by the caller")
        }
        if (!hasDirectReadUriPermission(context, uri, caller)) {
            return ExternalDocumentDecision.ExpiredGrant(uri)
        }
        return ExternalDocumentDecision.Allowed(uri, intentFlags)
    }

    private fun validateFileIntent(context: Context, uri: Uri, intentFlags: Int): ExternalDocumentDecision {
        if (!uri.authority.isNullOrEmpty() && !uri.authority.equals("localhost", ignoreCase = true)) {
            return ExternalDocumentDecision.Rejected(uri, "Remote file URIs are not supported")
        }
        val rawPath = uri.path
        if (rawPath.isNullOrBlank() || '\u0000' in rawPath) {
            return ExternalDocumentDecision.Rejected(uri, "Invalid file path")
        }
        val check = runCatching { requireSafeExternalFile(context, File(rawPath)) }
        if (check.isFailure) {
            return ExternalDocumentDecision.Rejected(
                uri,
                check.exceptionOrNull()?.message ?: "App-private paths cannot be opened externally",
            )
        }
        return ExternalDocumentDecision.Allowed(uri, intentFlags)
    }

    fun hasDirectReadUriPermission(
        context: Context,
        uri: Uri,
        caller: ExternalIntentCaller = ExternalIntentCaller(),
    ): Boolean {
        if (!uri.scheme.equals("content", ignoreCase = true)) return false
        if (
            context.checkUriPermission(
                uri,
                Process.myPid(),
                Process.myUid(),
                Intent.FLAG_GRANT_READ_URI_PERMISSION,
            ) == PackageManager.PERMISSION_GRANTED
        ) {
            return true
        }
        // On Android, UriGrantsManagerService skips inserting a dynamic UriPermission
        // record into mGrantedUriPermissions when targetUid already owns the provider
        // (${packageName}.share). Verify the kernel-authenticated caller instead so
        // legitimate own-share launches succeed while ungranted external callers fail.
        if (uri.authority == "${context.packageName}.share") {
            if (caller.callerGrantedOwnShareUri) return true
            val uid = caller.uid
            if (uid != null && uid > 0) {
                if (uid == Process.myUid()) return true
                return context.checkUriPermission(
                    uri,
                    -1,
                    uid,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION,
                ) == PackageManager.PERMISSION_GRANTED
            }
        }
        return false
    }

    fun persistOfferedIntentGrants(
        context: Context,
        uri: Uri,
        intentFlags: Int,
        caller: ExternalIntentCaller = ExternalIntentCaller(),
    ) {
        if (!uri.scheme.equals("content", ignoreCase = true)) return
        if ((intentFlags and Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION) == 0) return
        if ((intentFlags and Intent.FLAG_GRANT_READ_URI_PERMISSION) == 0) return
        if (!hasDirectReadUriPermission(context, uri, caller)) return
        val resolver = context.contentResolver
        try {
            resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } catch (_: SecurityException) {
            return
        }
        val offeredWrite = (intentFlags and Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != 0 &&
            context.checkUriPermission(
                uri,
                Process.myPid(),
                Process.myUid(),
                Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
            ) == PackageManager.PERMISSION_GRANTED
        if (offeredWrite) {
            try {
                resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            } catch (_: SecurityException) {
            }
        }
    }

    fun requireSafeExternalFile(context: Context, candidate: File): File {
        val normalizedLexical = candidate.absoluteFile.toPath().normalize().toString()
        require(!isForbiddenExternalPath(context, normalizedLexical)) {
            "App-private paths cannot be opened externally"
        }
        val canonical = runCatching { candidate.canonicalFile }.getOrElse {
            throw IllegalArgumentException("File path could not be resolved")
        }
        require(!isForbiddenExternalPath(context, canonical.path)) {
            "App-private paths cannot be opened externally"
        }
        return canonical
    }

    fun openVerifiedExternalInputStream(
        context: Context,
        resolver: ContentResolver,
        uri: Uri,
        intentFlags: Int,
        caller: ExternalIntentCaller = ExternalIntentCaller(),
    ): InputStream {
        return when (uri.scheme?.lowercase()) {
            "content" -> {
                require(!DocumentsContract.isTreeUri(uri)) { "Folder URIs cannot be opened as a note" }
                require((intentFlags and Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0) {
                    "Document read access was not granted by the caller"
                }
                if (!hasDirectReadUriPermission(context, uri, caller)) {
                    throw SecurityException("Document permission expired; choose it again")
                }
                persistOfferedIntentGrants(context, uri, intentFlags, caller)
                val pfd = resolver.openFileDescriptor(uri, "r")
                    ?: error("Document permission is unavailable; choose it again")
                try {
                    verifyOpenedDescriptor(context, uri, pfd)
                    ParcelFileDescriptor.AutoCloseInputStream(pfd)
                } catch (error: Throwable) {
                    runCatching { pfd.close() }
                    throw error
                }
            }
            "file" -> {
                require(uri.authority.isNullOrEmpty() || uri.authority.equals("localhost", ignoreCase = true)) {
                    "Remote file URIs are not supported"
                }
                val rawPath = uri.path?.takeIf { it.isNotBlank() && '\u0000' !in it }
                    ?: throw IllegalArgumentException("Invalid file path")
                val safeFile = requireSafeExternalFile(context, File(rawPath))
                val pfd = ParcelFileDescriptor.open(safeFile, ParcelFileDescriptor.MODE_READ_ONLY)
                try {
                    verifyOpenedDescriptor(context, uri, pfd)
                    ParcelFileDescriptor.AutoCloseInputStream(pfd)
                } catch (error: Throwable) {
                    runCatching { pfd.close() }
                    throw error
                }
            }
            else -> throw IllegalArgumentException("Unsupported document URI scheme")
        }
    }

    private fun verifyOpenedDescriptor(context: Context, uri: Uri, pfd: ParcelFileDescriptor) {
        val stat = runCatching { Os.fstat(pfd.fileDescriptor) }.getOrNull()
        if (stat != null && stat.st_mode != 0) {
            require(OsConstants.S_ISREG(stat.st_mode) || OsConstants.S_ISFIFO(stat.st_mode)) {
                "Document is not a regular file"
            }
        }
        val fdPath = resolveDescriptorPath(pfd) ?: return
        if (!fdPath.startsWith("/")) return
        val cleanFdPath = fdPath.removeSuffix(" (deleted)")
        if (isAllowedGrantedShareFile(context, uri, cleanFdPath)) return
        require(!isForbiddenExternalPath(context, cleanFdPath)) {
            "App-private paths cannot be opened externally"
        }
        val canonicalFdPath = runCatching { File(cleanFdPath).canonicalPath }.getOrNull()
        if (canonicalFdPath != null) {
            require(!isForbiddenExternalPath(context, canonicalFdPath)) {
                "App-private paths cannot be opened externally"
            }
        }
    }

    private fun isAllowedGrantedShareFile(context: Context, uri: Uri, resolvedPath: String): Boolean {
        if (!uri.scheme.equals("content", ignoreCase = true)) return false
        if (uri.authority != "${context.packageName}.share") return false
        val shareRoot = runCatching { File(context.cacheDir, "share").canonicalPath }.getOrNull() ?: return false
        val canonicalCandidate = runCatching { File(resolvedPath).canonicalPath }.getOrDefault(resolvedPath)
        return canonicalCandidate.startsWith("$shareRoot${File.separator}")
    }

    private fun resolveDescriptorPath(pfd: ParcelFileDescriptor): String? {
        val fdNumber = runCatching { pfd.fd }.getOrDefault(-1)
        if (fdNumber >= 3) {
            val procEntry = "/proc/self/fd/$fdNumber"
            runCatching { Os.readlink(procEntry) }.getOrNull()?.takeIf(String::isNotBlank)?.let { return it }
            runCatching { Files.readSymbolicLink(Paths.get(procEntry)).toString() }.getOrNull()
                ?.takeIf(String::isNotBlank)?.let { return it }
        }
        return null
    }

    internal fun isForbiddenExternalPath(context: Context, rawPath: String): Boolean {
        val normalized = runCatching { Paths.get(rawPath).normalize().toString() }.getOrDefault(rawPath)
        for (sysRoot in restrictedSystemRoots) {
            if (isSameOrChildPath(normalized, sysRoot)) return true
        }
        val pkg = context.packageName
        if (pkg.isNotBlank()) {
            for (segment in listOf("/Android/data/$pkg", "/Android/obb/$pkg", "/Android/media/$pkg")) {
                if (normalized.endsWith(segment) || normalized.contains("$segment/")) return true
            }
        }
        for (privateRoot in appPrivateRoots(context)) {
            if (isSameOrChildPath(normalized, privateRoot)) return true
        }
        return false
    }

    private fun appPrivateRoots(context: Context): Set<String> {
        val roots = LinkedHashSet<String>()
        fun addDir(dir: File?) {
            if (dir == null) return
            roots += dir.absoluteFile.toPath().normalize().toString()
            runCatching { dir.canonicalPath }.getOrNull()?.let { roots += it }
        }
        addDir(context.dataDir)
        runCatching { context.applicationInfo?.dataDir?.takeIf(String::isNotBlank)?.let(::File) }.getOrNull()?.let(::addDir)
        addDir(context.filesDir)
        addDir(context.cacheDir)
        addDir(context.codeCacheDir)
        addDir(context.noBackupFilesDir)
        addDir(runCatching { context.getDatabasePath("supermd.db")?.parentFile }.getOrNull())
        addDir(runCatching { context.createDeviceProtectedStorageContext().dataDir }.getOrNull())
        runCatching { context.externalCacheDirs }.getOrNull()?.forEach(::addDir)
        runCatching { context.getExternalFilesDirs(null) }.getOrNull()?.forEach(::addDir)
        runCatching { context.obbDirs }.getOrNull()?.forEach(::addDir)
        return roots
    }

    private fun isSameOrChildPath(candidate: String, root: String): Boolean {
        val cleanRoot = root.trimEnd('/')
        if (cleanRoot.isEmpty()) return false
        return candidate == cleanRoot || candidate.startsWith("$cleanRoot/")
    }
}
