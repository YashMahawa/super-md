package dev.supermd.studio

import android.system.ErrnoException
import android.system.OsConstants
import android.system.StructStat
import java.io.File
import java.io.FileDescriptor
import java.io.FileNotFoundException
import java.io.IOException
import java.io.RandomAccessFile
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.NoSuchFileException
import java.nio.file.NotLinkException
import java.nio.file.Paths
import java.nio.file.attribute.BasicFileAttributes
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadows.ShadowBlockGuardOs
import org.robolectric.shadows.ShadowLinux
import org.robolectric.util.ReflectionHelpers

/**
 * Replaces Robolectric's stubbed `ShadowLinux` (which ignores `O_NOFOLLOW`/`O_NONBLOCK` and
 * returns `st_mode = 0` from `fstat(FileDescriptor)`) with real NIO/POSIX attribute semantics
 * on the Linux test host.
 */
@Implements(className = "libcore.io.Linux", minSdk = 26, isInAndroidSdk = false)
class PosixShadowLinux : ShadowLinux() {
    internal data class TrackedDescriptor(
        val raf: RandomAccessFile,
        val backingTempFile: File?,
        val resolvedPath: String,
        val stMode: Int,
        val stDev: Long,
        val stIno: Long,
    )

    companion object {
        private val syntheticInodeCounter = AtomicLong(1_000_000L)
        private val trackedByIdentity = ConcurrentHashMap<Int, TrackedDescriptor>()

        internal fun closeTracked(fd: FileDescriptor?): Boolean {
            if (fd == null) return false
            val removed = trackedByIdentity.remove(System.identityHashCode(fd)) ?: return false
            runCatching { removed.raf.close() }
            removed.backingTempFile?.delete()
            return true
        }

        private fun extractInode(attrs: BasicFileAttributes): Long {
            val key = attrs.fileKey()?.toString().orEmpty()
            val match = Regex("ino=(\\d+)").find(key)
            if (match != null) {
                match.groupValues[1].toLongOrNull()?.let { return it }
            }
            return key.hashCode().toLong().and(0x7fffffffL).takeIf { it != 0L }
                ?: syntheticInodeCounter.incrementAndGet()
        }

        private fun extractDev(attrs: BasicFileAttributes): Long {
            val key = attrs.fileKey()?.toString().orEmpty()
            val match = Regex("dev=([0-9a-fA-F]+)").find(key)
            if (match != null) {
                match.groupValues[1].toLongOrNull(16)?.let { return it }
            }
            return 1L
        }

        private fun modeForAttributes(attrs: BasicFileAttributes): Int = when {
            attrs.isSymbolicLink -> OsConstants.S_IFLNK or 511
            attrs.isDirectory -> OsConstants.S_IFDIR or 493
            attrs.isRegularFile -> OsConstants.S_IFREG or 420
            else -> OsConstants.S_IFIFO or 384
        }

        private fun buildStructStat(
            stDev: Long,
            stIno: Long,
            stMode: Int,
            stSize: Long,
            mtimeSec: Long,
        ): StructStat = StructStat(
            stDev,
            stIno,
            stMode,
            1L,
            0,
            0,
            0L,
            stSize,
            mtimeSec,
            mtimeSec,
            mtimeSec,
            4096L,
            if (stSize > 0) ((stSize + 511L) / 512L) else 0L,
        )
    }

    @Implementation
    public override fun open(path: String?, flags: Int, mode: Int): FileDescriptor {
        if (path == null) {
            throw ErrnoException("open", OsConstants.ENOENT)
        }
        val nioPath = Paths.get(path)
        val noFollowAttrs = try {
            Files.readAttributes(nioPath, BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
        } catch (_: NoSuchFileException) {
            if ((flags and OsConstants.O_CREAT) == 0) {
                throw ErrnoException("open", OsConstants.ENOENT)
            }
            null
        } catch (err: IOException) {
            throw ErrnoException("open", OsConstants.EACCES, err)
        }

        if (noFollowAttrs != null && noFollowAttrs.isSymbolicLink && (flags and OsConstants.O_NOFOLLOW) != 0) {
            throw ErrnoException("open", OsConstants.ELOOP)
        }

        val targetAttrs = if (noFollowAttrs != null && noFollowAttrs.isSymbolicLink) {
            try {
                Files.readAttributes(nioPath, BasicFileAttributes::class.java)
            } catch (_: NoSuchFileException) {
                throw ErrnoException("open", OsConstants.ENOENT)
            } catch (err: IOException) {
                throw ErrnoException("open", OsConstants.EACCES, err)
            }
        } else {
            noFollowAttrs
        }

        if (targetAttrs != null && targetAttrs.isDirectory) {
            throw ErrnoException("open", OsConstants.EISDIR)
        }

        // Opening a writerless FIFO on the JVM via RandomAccessFile would block because Java
        // omits O_NONBLOCK. Simulate non-blocking FIFO open accurately when O_NONBLOCK is set.
        if (targetAttrs != null && !targetAttrs.isRegularFile && (flags and OsConstants.O_NONBLOCK) != 0) {
            val placeholder = File.createTempFile("robo-nonblock-special-", ".tmp").apply { deleteOnExit() }
            val raf = RandomAccessFile(placeholder, "r")
            val fd = raf.fd
            val realParent = runCatching { nioPath.parent?.toRealPath()?.resolve(nioPath.fileName)?.toString() }
                .getOrNull()
                ?: nioPath.toAbsolutePath().normalize().toString()
            trackedByIdentity[System.identityHashCode(fd)] = TrackedDescriptor(
                raf = raf,
                backingTempFile = placeholder,
                resolvedPath = realParent,
                stMode = modeForAttributes(targetAttrs),
                stDev = extractDev(targetAttrs),
                stIno = extractInode(targetAttrs),
            )
            return fd
        }

        val wantsWrite = (flags and (OsConstants.O_WRONLY or OsConstants.O_RDWR or OsConstants.O_CREAT)) != 0
        val rafMode = if (wantsWrite) "rw" else "r"
        val raf = try {
            RandomAccessFile(path, rafMode)
        } catch (missing: FileNotFoundException) {
            throw ErrnoException("open", OsConstants.ENOENT, missing)
        } catch (err: IOException) {
            throw ErrnoException("open", OsConstants.EIO, err)
        }
        val finalAttrs = targetAttrs ?: Files.readAttributes(nioPath, BasicFileAttributes::class.java)
        val resolvedRealPath = runCatching { nioPath.toRealPath().toString() }
            .getOrDefault(nioPath.toAbsolutePath().normalize().toString())
        val fd = raf.fd
        trackedByIdentity[System.identityHashCode(fd)] = TrackedDescriptor(
            raf = raf,
            backingTempFile = null,
            resolvedPath = resolvedRealPath,
            stMode = modeForAttributes(finalAttrs),
            stDev = extractDev(finalAttrs),
            stIno = extractInode(finalAttrs),
        )
        return fd
    }

    @Implementation
    public override fun stat(path: String?): StructStat {
        if (path == null) return super.stat(null)
        val attrs = try {
            Files.readAttributes(Paths.get(path), BasicFileAttributes::class.java)
        } catch (missing: NoSuchFileException) {
            throw ErrnoException("stat", OsConstants.ENOENT, missing)
        } catch (err: IOException) {
            throw ErrnoException("stat", OsConstants.EACCES, err)
        }
        return buildStructStat(
            stDev = extractDev(attrs),
            stIno = extractInode(attrs),
            stMode = modeForAttributes(attrs),
            stSize = attrs.size(),
            mtimeSec = attrs.lastModifiedTime().to(TimeUnit.SECONDS),
        )
    }

    @Implementation
    protected override fun lstat(path: String?): StructStat {
        if (path == null) throw ErrnoException("lstat", OsConstants.ENOENT)
        val attrs = try {
            Files.readAttributes(Paths.get(path), BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
        } catch (missing: NoSuchFileException) {
            throw ErrnoException("lstat", OsConstants.ENOENT, missing)
        } catch (err: IOException) {
            throw ErrnoException("lstat", OsConstants.EACCES, err)
        }
        return buildStructStat(
            stDev = extractDev(attrs),
            stIno = extractInode(attrs),
            stMode = modeForAttributes(attrs),
            stSize = attrs.size(),
            mtimeSec = attrs.lastModifiedTime().to(TimeUnit.SECONDS),
        )
    }

    @Implementation
    protected override fun fstat(fd: FileDescriptor?): StructStat {
        if (fd == null || !fd.valid()) {
            throw ErrnoException("fstat", OsConstants.EBADF)
        }
        trackedByIdentity[System.identityHashCode(fd)]?.let { tracked ->
            val length = runCatching { tracked.raf.length() }.getOrDefault(0L)
            return buildStructStat(
                stDev = tracked.stDev,
                stIno = tracked.stIno,
                stMode = tracked.stMode,
                stSize = length,
                mtimeSec = System.currentTimeMillis() / 1000L,
            )
        }
        val fdNum = runCatching { ReflectionHelpers.getField<Int>(fd, "fd") }.getOrDefault(-1)
        if (fdNum < 0) {
            throw ErrnoException("fstat", OsConstants.EBADF)
        }
        val linkTarget = runCatching { Files.readSymbolicLink(Paths.get("/proc/self/fd/$fdNum")).toString() }
            .getOrNull()
            ?: throw ErrnoException("fstat", OsConstants.EBADF)

        if (linkTarget.startsWith("pipe:") || linkTarget.contains("/ShadowParcelFileDescriptor/pipe-")) {
            return buildStructStat(
                stDev = 0L,
                stIno = syntheticInodeCounter.incrementAndGet(),
                stMode = OsConstants.S_IFIFO or 384,
                stSize = 0L,
                mtimeSec = System.currentTimeMillis() / 1000L,
            )
        }
        if (linkTarget.startsWith("socket:")) {
            return buildStructStat(
                stDev = 0L,
                stIno = syntheticInodeCounter.incrementAndGet(),
                stMode = OsConstants.S_IFSOCK or 384,
                stSize = 0L,
                mtimeSec = System.currentTimeMillis() / 1000L,
            )
        }
        val wasDeleted = linkTarget.endsWith(" (deleted)")
        val cleanPath = linkTarget.removeSuffix(" (deleted)")
        val attrs = runCatching {
            Files.readAttributes(Paths.get(cleanPath), BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
        }.getOrNull()
        if (attrs != null) {
            return buildStructStat(
                stDev = extractDev(attrs),
                stIno = extractInode(attrs),
                stMode = modeForAttributes(attrs),
                stSize = attrs.size(),
                mtimeSec = attrs.lastModifiedTime().to(TimeUnit.SECONDS),
            )
        }
        if (wasDeleted) {
            return buildStructStat(
                stDev = 1L,
                stIno = syntheticInodeCounter.incrementAndGet(),
                stMode = OsConstants.S_IFREG or 384,
                stSize = 0L,
                mtimeSec = System.currentTimeMillis() / 1000L,
            )
        }
        throw ErrnoException("fstat", OsConstants.ENOENT)
    }

    @Implementation
    protected fun readlink(path: String?): String {
        if (path == null) throw ErrnoException("readlink", OsConstants.ENOENT)
        if (path.startsWith("/proc/self/fd/")) {
            val fdNum = path.substringAfterLast('/').toIntOrNull()
            if (fdNum != null && fdNum >= 0) {
                val matched = trackedByIdentity.entries.firstOrNull { (_, entry) ->
                    entry.raf.fd.valid() &&
                        runCatching { ReflectionHelpers.getField<Int>(entry.raf.fd, "fd") }.getOrDefault(-1) == fdNum
                }?.value
                if (matched != null && matched.backingTempFile != null) {
                    return matched.resolvedPath
                }
            }
        }
        return try {
            val target = Files.readSymbolicLink(Paths.get(path)).toString()
            if (path.startsWith("/proc/self/fd/") && target.contains("/ShadowParcelFileDescriptor/pipe-")) {
                "pipe:[${target.hashCode().and(0x7fffffff)}]"
            } else {
                target
            }
        } catch (missing: NoSuchFileException) {
            throw ErrnoException("readlink", OsConstants.ENOENT, missing)
        } catch (notLink: NotLinkException) {
            throw ErrnoException("readlink", OsConstants.EINVAL, notLink)
        } catch (err: IOException) {
            throw ErrnoException("readlink", OsConstants.EACCES, err)
        }
    }
}

@Implements(className = "libcore.io.BlockGuardOs", isInAndroidSdk = false)
class PosixShadowBlockGuardOs : ShadowBlockGuardOs() {
    @Implementation
    protected override fun close(fd: FileDescriptor?) {
        if (!PosixShadowLinux.closeTracked(fd)) {
            super.close(fd)
        }
    }
}
