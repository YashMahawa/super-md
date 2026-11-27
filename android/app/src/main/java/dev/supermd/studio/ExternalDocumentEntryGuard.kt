package dev.supermd.studio

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.os.Process
import android.provider.DocumentsContract
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.system.StructStat
import java.io.Closeable
import java.io.File
import java.io.FileDescriptor
import java.io.IOException
import java.io.InputStream
import java.io.InterruptedIOException
import java.nio.file.Files
import java.nio.file.Paths
import java.util.concurrent.atomic.AtomicBoolean

internal data class ExternalIntentCaller(
    val uid: Int? = null,
    val callerGrantedOwnShareUri: Boolean = false,
    val allowGrantedShareFile: Boolean = true,
)

internal sealed interface ExternalDocumentDecision {
    data object NoDocument : ExternalDocumentDecision
    data class Allowed(val uri: Uri, val intentFlags: Int) : ExternalDocumentDecision
    data class ExpiredGrant(val uri: Uri) : ExternalDocumentDecision
    data class Rejected(val uri: Uri, val reason: String) : ExternalDocumentDecision
}

internal class ExternalFolderUriException(message: String) : IllegalArgumentException(message)

internal interface ExternalFileSyscalls {
    fun openReadOnlyNonBlockingNoFollow(path: String): FileDescriptor
    fun fstat(fd: FileDescriptor): StructStat?
    fun lstat(path: String): StructStat?
    fun pread(fd: FileDescriptor, buffer: ByteArray, offset: Int, length: Int, position: Long): Int
    fun close(fd: FileDescriptor)
    fun resolveDescriptorPath(fd: FileDescriptor): String?
}

internal object AndroidOsFileSyscalls : ExternalFileSyscalls {
    override fun openReadOnlyNonBlockingNoFollow(path: String): FileDescriptor {
        val flags = OsConstants.O_RDONLY or
            OsConstants.O_NOFOLLOW or
            OsConstants.O_NONBLOCK or
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) OsConstants.O_CLOEXEC else 0
        return Os.open(path, flags, 0)
    }

    override fun fstat(fd: FileDescriptor): StructStat? = Os.fstat(fd)

    override fun lstat(path: String): StructStat? = Os.lstat(path)

    override fun pread(
        fd: FileDescriptor,
        buffer: ByteArray,
        offset: Int,
        length: Int,
        position: Long,
    ): Int {
        if (length == 0) return 0
        while (true) {
            try {
                val count = Os.pread(fd, buffer, offset, length, position)
                return if (count <= 0) -1 else count
            } catch (errno: ErrnoException) {
                if (errno.errno == OsConstants.EINTR) continue
                throw IOException("Failed to read file descriptor", errno)
            } catch (interrupted: InterruptedIOException) {
                throw interrupted
            }
        }
    }

    override fun close(fd: FileDescriptor) {
        runCatching { Os.close(fd) }
    }

    override fun resolveDescriptorPath(fd: FileDescriptor): String? {
        val directFd = extractRawFdNumber(fd)
        if (directFd >= 3) {
            resolveProcFdPath(directFd)?.let { return it }
        }
        val dupResolved = runCatching {
            ParcelFileDescriptor.dup(fd).use { dupPfd ->
                val dupFd = runCatching { dupPfd.fd }.getOrDefault(-1)
                if (dupFd >= 3) resolveProcFdPath(dupFd) else null
            }
        }.getOrNull()
        return dupResolved
    }

    internal fun resolveProcFdPath(fdNumber: Int): String? {
        if (fdNumber < 3) return null
        val procEntry = "/proc/self/fd/$fdNumber"
        runCatching { Os.readlink(procEntry) }.getOrNull()?.takeIf(String::isNotBlank)?.let { return it }
        runCatching { Files.readSymbolicLink(Paths.get(procEntry)).toString() }.getOrNull()
            ?.takeIf(String::isNotBlank)?.let { return it }
        return null
    }

    private fun extractRawFdNumber(fd: FileDescriptor): Int {
        for (fieldName in listOf("descriptor", "fd")) {
            val num = runCatching {
                val field = FileDescriptor::class.java.getDeclaredField(fieldName)
                field.isAccessible = true
                field.getInt(fd)
            }.getOrDefault(-1)
            if (num >= 0) return num
        }
        return -1
    }
}

internal class OpenedRegularFileHandle(
    val rawPath: String,
    private val fd: FileDescriptor,
    private val syscalls: ExternalFileSyscalls,
) : Closeable {
    private val consumed = AtomicBoolean(false)
    private val closed = AtomicBoolean(false)

    fun consumeInputStream(): InputStream {
        check(consumed.compareAndSet(false, true)) { "Regular file handle was already consumed" }
        check(!closed.get()) { "Regular file handle is already closed" }
        return OwnedFileDescriptorInputStream(fd, syscalls) {
            closed.set(true)
        }
    }

    override fun close() {
        if (!consumed.get() && closed.compareAndSet(false, true)) {
            syscalls.close(fd)
        }
    }
}

private class OwnedFileDescriptorInputStream(
    private val fd: FileDescriptor,
    private val syscalls: ExternalFileSyscalls,
    private val onClose: () -> Unit,
) : InputStream() {
    private val lock = Any()
    private var position = 0L
    private var isClosed = false

    override fun read(): Int {
        val single = ByteArray(1)
        val count = read(single, 0, 1)
        return if (count <= 0) -1 else (single[0].toInt() and 0xff)
    }

    override fun read(b: ByteArray, off: Int, len: Int): Int {
        if (off < 0 || len < 0 || len > b.size - off) {
            throw IndexOutOfBoundsException("off=$off len=$len size=${b.size}")
        }
        if (len == 0) return 0
        synchronized(lock) {
            if (isClosed) throw IOException("Stream closed")
            val count = syscalls.pread(fd, b, off, len, position)
            if (count > 0) {
                position += count
            }
            return count
        }
    }

    override fun close() {
        val shouldClose = synchronized(lock) {
            if (isClosed) false else {
                isClosed = true
                true
            }
        }
        if (shouldClose) {
            try {
                syscalls.close(fd)
            } finally {
                onClose()
            }
        }
    }
}

internal class AdmittedExternalDrop(
    val uri: Uri,
    val intentFlags: Int,
    private val fileHandle: OpenedRegularFileHandle? = null,
) : Closeable {
    fun openInputStream(context: Context, resolver: ContentResolver): InputStream {
        if (fileHandle != null) {
            return fileHandle.consumeInputStream()
        }
        return ExternalDocumentEntryGuard.openVerifiedExternalInputStream(
            context = context,
            resolver = resolver,
            uri = uri,
            intentFlags = intentFlags,
            caller = ExternalIntentCaller(allowGrantedShareFile = false),
        )
    }

    override fun close() {
        fileHandle?.close()
    }
}

internal sealed interface ExternalDropUriDecision : Closeable {
    data class Allowed(
        val uri: Uri,
        val admitted: AdmittedExternalDrop,
    ) : ExternalDropUriDecision {
        val intentFlags: Int get() = admitted.intentFlags
        override fun close() = admitted.close()
    }

    data class MissingGrant(val uri: Uri) : ExternalDropUriDecision {
        override fun close() = Unit
    }

    data class Rejected(
        val uri: Uri,
        val reason: String,
        val isFolder: Boolean = false,
    ) : ExternalDropUriDecision {
        override fun close() = Unit
    }
}

/**
 * Validates untrusted external document and media entry points (MainActivity incoming Intents,
 * drag-and-drop URIs, and picked image URIs) before persisting permissions, resolving URIs, or
 * reading bytes.
 *
 * Normal system document picker selections (ACTION_OPEN_DOCUMENT / RestoreDocumentAccess) and
 * internal workspace/folder/recent restores do not pass through this gate.
 */
internal object ExternalDocumentEntryGuard {
    @Volatile
    internal var fileSyscalls: ExternalFileSyscalls = AndroidOsFileSyscalls

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

    private fun providerAuthority(uri: Uri): String? =
        uri.authority?.substringAfter('@')?.takeIf { it.isNotBlank() }

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
        if (providerAuthority(uri) == null) {
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
        val check = runCatching { openSafeRegularFileHandle(context, uri).use { } }
        if (check.isFailure) {
            val error = check.exceptionOrNull()
            val reason = when (error) {
                is ExternalFolderUriException -> "Folder URIs cannot be opened as a note"
                else -> error?.message ?: "App-private paths cannot be opened externally"
            }
            return ExternalDocumentDecision.Rejected(uri, reason)
        }
        return ExternalDocumentDecision.Allowed(uri, intentFlags)
    }

    /**
     * Admits a dropped URI for note-open or inline-image import.
     *
     * For a `file:` URI, opens a single `O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC`
     * descriptor, requires a confirmed regular-file `fstat` (`S_ISREG`) and path containment on
     * that descriptor, and retains the open handle inside [ExternalDropUriDecision.Allowed] so
     * callers read from the exact verified descriptor without reopening the path.
     *
     * For a `content:` URI, enforces explicit drag read permission and direct URI grant while
     * keeping legitimate streamed content providers working when opened.
     */
    fun admitDroppedUri(
        context: Context,
        uri: Uri,
        dragReadPermissionGranted: Boolean,
    ): ExternalDropUriDecision {
        return when (uri.scheme?.lowercase()) {
            "content" -> {
                val authority = providerAuthority(uri)
                    ?: return ExternalDropUriDecision.Rejected(uri, "Missing content provider authority")
                if (authority.equals("${context.packageName}.share", ignoreCase = true)) {
                    return ExternalDropUriDecision.Rejected(uri, "App-private share URIs cannot be dropped")
                }
                if (DocumentsContract.isTreeUri(uri)) {
                    return ExternalDropUriDecision.Rejected(
                        uri = uri,
                        reason = "Folder drops are not supported",
                        isFolder = true,
                    )
                }
                if (!dragReadPermissionGranted || !hasDirectReadUriPermission(context, uri)) {
                    return ExternalDropUriDecision.MissingGrant(uri)
                }
                ExternalDropUriDecision.Allowed(
                    uri = uri,
                    admitted = AdmittedExternalDrop(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION),
                )
            }
            "file" -> {
                try {
                    val handle = openSafeRegularFileHandle(context, uri)
                    ExternalDropUriDecision.Allowed(
                        uri = uri,
                        admitted = AdmittedExternalDrop(uri = uri, intentFlags = 0, fileHandle = handle),
                    )
                } catch (folder: ExternalFolderUriException) {
                    ExternalDropUriDecision.Rejected(
                        uri = uri,
                        reason = folder.message ?: "Folder drops are not supported",
                        isFolder = true,
                    )
                } catch (error: Throwable) {
                    ExternalDropUriDecision.Rejected(
                        uri = uri,
                        reason = error.message ?: "App-private paths cannot be opened externally",
                        isFolder = false,
                    )
                }
            }
            else -> ExternalDropUriDecision.Rejected(uri, "Unsupported drop URI scheme")
        }
    }

    fun validateDroppedUri(
        context: Context,
        uri: Uri,
        dragReadPermissionGranted: Boolean,
    ): ExternalDropUriDecision {
        return when (val decision = admitDroppedUri(context, uri, dragReadPermissionGranted)) {
            is ExternalDropUriDecision.Allowed -> {
                val flags = decision.intentFlags
                decision.close()
                ExternalDropUriDecision.Allowed(uri, AdmittedExternalDrop(uri, flags))
            }
            else -> decision
        }
    }

    fun openVerifiedDroppedInputStream(
        context: Context,
        resolver: ContentResolver,
        uri: Uri,
        dragReadPermissionGranted: Boolean,
    ): InputStream {
        return when (val decision = admitDroppedUri(context, uri, dragReadPermissionGranted)) {
            is ExternalDropUriDecision.MissingGrant ->
                throw SecurityException("Dropped file read access was not granted")
            is ExternalDropUriDecision.Rejected ->
                throw IllegalArgumentException(decision.reason)
            is ExternalDropUriDecision.Allowed -> {
                try {
                    decision.admitted.openInputStream(context, resolver)
                } catch (error: Throwable) {
                    decision.close()
                    throw error
                }
            }
        }
    }

    fun validatePickedMediaUri(context: Context, uri: Uri) {
        when (uri.scheme?.lowercase()) {
            "content" -> {
                val authority = providerAuthority(uri) ?: throw IllegalArgumentException("Unsupported image URI")
                require(!authority.equals("${context.packageName}.share", ignoreCase = true)) {
                    "Unsupported image URI"
                }
                require(!DocumentsContract.isTreeUri(uri)) { "Unsupported image URI" }
            }
            "file" -> {
                openSafeRegularFileHandle(context, uri).use { }
            }
            else -> throw IllegalArgumentException("Unsupported image URI")
        }
    }

    fun openVerifiedPickedMediaInputStream(
        context: Context,
        resolver: ContentResolver,
        uri: Uri,
    ): InputStream {
        return when (uri.scheme?.lowercase()) {
            "content" -> {
                validatePickedMediaUri(context, uri)
                val pfd = resolver.openFileDescriptor(uri, "r")
                    ?: error("Image permission is unavailable")
                try {
                    verifyOpenedContentDescriptor(context, uri, pfd, allowGrantedShareFile = false)
                    ParcelFileDescriptor.AutoCloseInputStream(pfd)
                } catch (error: Throwable) {
                    runCatching { pfd.close() }
                    throw error
                }
            }
            "file" -> {
                val handle = openSafeRegularFileHandle(context, uri)
                try {
                    handle.consumeInputStream()
                } catch (error: Throwable) {
                    handle.close()
                    throw error
                }
            }
            else -> throw IllegalArgumentException("Unsupported image URI")
        }
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
        if (providerAuthority(uri)?.equals("${context.packageName}.share", ignoreCase = true) == true) {
            if (!caller.allowGrantedShareFile) return false
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

    internal fun openSafeRegularFileHandle(context: Context, uri: Uri): OpenedRegularFileHandle {
        require(uri.authority.isNullOrEmpty() || uri.authority.equals("localhost", ignoreCase = true)) {
            "Remote file URIs are not supported"
        }
        val rawPath = uri.path?.takeIf { it.isNotBlank() && '\u0000' !in it }
            ?: throw IllegalArgumentException("Invalid file path")
        val normalizedLexical = File(rawPath).absoluteFile.toPath().normalize().toString()
        require(!isForbiddenExternalPath(context, normalizedLexical)) {
            "App-private paths cannot be opened externally"
        }

        val syscalls = fileSyscalls
        val fd = try {
            syscalls.openReadOnlyNonBlockingNoFollow(rawPath)
        } catch (errno: ErrnoException) {
            when (errno.errno) {
                OsConstants.ELOOP -> throw IllegalArgumentException("Symbolic links cannot be opened externally", errno)
                OsConstants.EISDIR -> throw ExternalFolderUriException("Folder drops are not supported")
                else -> throw IllegalArgumentException("File path could not be opened", errno)
            }
        } catch (error: Throwable) {
            throw IllegalArgumentException(error.message ?: "File path could not be opened", error)
        }

        try {
            val stat = runCatching { syscalls.fstat(fd) }.getOrNull()
                ?: throw IllegalArgumentException("Could not confirm file descriptor status")
            if (stat.st_mode == 0) {
                throw IllegalArgumentException("Could not confirm file descriptor status")
            }
            if (OsConstants.S_ISDIR(stat.st_mode)) {
                throw ExternalFolderUriException("Folder drops are not supported")
            }
            require(OsConstants.S_ISREG(stat.st_mode)) {
                "Document is not a regular file"
            }

            val fdPath = syscalls.resolveDescriptorPath(fd)?.takeIf { it.startsWith("/") }
            if (fdPath != null) {
                val wasDeleted = fdPath.endsWith(" (deleted)")
                val cleanFdPath = fdPath.removeSuffix(" (deleted)")
                require(!isForbiddenExternalPath(context, cleanFdPath)) {
                    "App-private paths cannot be opened externally"
                }
                if (!wasDeleted) {
                    val sameInode = runCatching { syscalls.lstat(cleanFdPath) }.getOrNull()?.let { pathStat ->
                        pathStat.st_mode != 0 &&
                            OsConstants.S_ISREG(pathStat.st_mode) &&
                            pathStat.st_dev == stat.st_dev &&
                            pathStat.st_ino == stat.st_ino
                    } ?: false
                    if (sameInode) {
                        val canonicalFdPath = runCatching { File(cleanFdPath).canonicalPath }.getOrNull()
                        if (canonicalFdPath != null) {
                            require(!isForbiddenExternalPath(context, canonicalFdPath)) {
                                "App-private paths cannot be opened externally"
                            }
                        }
                    }
                }
            } else {
                val canonical = runCatching { File(rawPath).canonicalFile }.getOrElse {
                    throw IllegalArgumentException("Could not confirm file descriptor path")
                }
                require(!isForbiddenExternalPath(context, canonical.path)) {
                    "App-private paths cannot be opened externally"
                }
                val pathStat = runCatching { syscalls.lstat(canonical.path) }.getOrNull()
                    ?: throw IllegalArgumentException("Could not confirm file descriptor status")
                if (
                    pathStat.st_mode == 0 ||
                    !OsConstants.S_ISREG(pathStat.st_mode) ||
                    pathStat.st_dev != stat.st_dev ||
                    pathStat.st_ino != stat.st_ino
                ) {
                    throw IllegalArgumentException("Could not confirm file descriptor status")
                }
            }

            return OpenedRegularFileHandle(rawPath = rawPath, fd = fd, syscalls = syscalls)
        } catch (error: Throwable) {
            runCatching { syscalls.close(fd) }
            throw error
        }
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
                val authority = providerAuthority(uri)
                    ?: throw IllegalArgumentException("Missing document provider authority")
                if (!caller.allowGrantedShareFile && authority.equals("${context.packageName}.share", ignoreCase = true)) {
                    throw IllegalArgumentException("App-private share URIs cannot be opened externally")
                }
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
                    verifyOpenedContentDescriptor(
                        context = context,
                        uri = uri,
                        pfd = pfd,
                        allowGrantedShareFile = caller.allowGrantedShareFile,
                    )
                    ParcelFileDescriptor.AutoCloseInputStream(pfd)
                } catch (error: Throwable) {
                    runCatching { pfd.close() }
                    throw error
                }
            }
            "file" -> {
                val handle = openSafeRegularFileHandle(context, uri)
                try {
                    handle.consumeInputStream()
                } catch (error: Throwable) {
                    handle.close()
                    throw error
                }
            }
            else -> throw IllegalArgumentException("Unsupported document URI scheme")
        }
    }

    private fun verifyOpenedContentDescriptor(
        context: Context,
        uri: Uri,
        pfd: ParcelFileDescriptor,
        allowGrantedShareFile: Boolean,
    ) {
        val stat = runCatching { fileSyscalls.fstat(pfd.fileDescriptor) }.getOrNull()
        if (stat != null && stat.st_mode != 0) {
            require(
                OsConstants.S_ISREG(stat.st_mode) ||
                    OsConstants.S_ISFIFO(stat.st_mode) ||
                    OsConstants.S_ISSOCK(stat.st_mode),
            ) {
                "Document is not a regular file"
            }
        }
        val fdPath = resolveParcelDescriptorPath(pfd) ?: return
        if (!fdPath.startsWith("/")) return
        val cleanFdPath = fdPath.removeSuffix(" (deleted)")
        if (allowGrantedShareFile && isAllowedGrantedShareFile(context, uri, cleanFdPath)) return
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
        if (providerAuthority(uri)?.equals("${context.packageName}.share", ignoreCase = true) != true) return false
        val shareRoot = runCatching { File(context.cacheDir, "share").canonicalPath }.getOrNull() ?: return false
        val canonicalCandidate = runCatching { File(resolvedPath).canonicalPath }.getOrDefault(resolvedPath)
        return canonicalCandidate.startsWith("$shareRoot${File.separator}")
    }

    private fun resolveParcelDescriptorPath(pfd: ParcelFileDescriptor): String? {
        val fdNumber = runCatching { pfd.fd }.getOrDefault(-1)
        return AndroidOsFileSyscalls.resolveProcFdPath(fdNumber)
    }

    internal fun isForbiddenExternalPath(context: Context, rawPath: String): Boolean {
        val normalized = runCatching { Paths.get(rawPath).normalize().toString() }.getOrDefault(rawPath)
        for (sysRoot in restrictedSystemRoots) {
            if (isSameOrChildPath(normalized, sysRoot)) return true
        }
        val pkg = context.packageName
        if (pkg.isNotBlank()) {
            for (segment in listOf("/Android/data/$pkg", "/Android/obb/$pkg", "/Android/media/$pkg")) {
                if (normalized.endsWith(segment, ignoreCase = true) || normalized.contains("$segment/", ignoreCase = true)) {
                    return true
                }
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
