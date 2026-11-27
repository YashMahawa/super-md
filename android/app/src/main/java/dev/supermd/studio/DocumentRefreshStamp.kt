package dev.supermd.studio

import android.content.ContentResolver
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import java.io.File
import java.nio.file.Files
import java.nio.file.attribute.BasicFileAttributes
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import org.json.JSONObject

/**
 * Minimum plausible `lastModified` epoch timestamp in milliseconds (~1973-03-03 UTC).
 * Rejects missing (`<= 0`), placeholder, and unit-confused Unix-epoch-second (`~1.7e9`)
 * provider timestamps so unknown metadata always falls back to stream verification.
 */
internal const val MIN_PLAUSIBLE_DOCUMENT_EPOCH_MS = 100_000_000_000L

/**
 * Guard window for whole-second timestamps (`lastModifiedMs % 1000 == 0 && lastModifiedNanos == 0`),
 * covering 1-second SAF / POSIX truncation and 2-second FAT / exFAT timestamp resolution.
 * Same-length external edits inside the same timestamp tick cannot hide behind a cached stamp.
 */
internal const val COARSE_DOCUMENT_STAMP_GUARD_MS = 2_500L

/**
 * Guard window for sub-second `file://` timestamps, covering coarse OS kernel-tick (`HZ`)
 * filesystem timestamps (typically 4 ms–10 ms on Linux ext4 / tmpfs / f2fs).
 */
internal const val FINE_DOCUMENT_STAMP_GUARD_MS = 50L

internal data class ProbedDocumentStamp(
    val canonicalDocKey: String,
    val size: Long,
    val lastModifiedMs: Long,
    val lastModifiedNanos: Int = 0,
    val creationTimeNanos: Long = 0L,
    val fileKey: Any? = null,
) {
    val isCoarseSecondAligned: Boolean
        get() = lastModifiedMs % 1_000L == 0L && lastModifiedNanos == 0

    fun requiredGuardWindowMs(): Long =
        if (isCoarseSecondAligned) COARSE_DOCUMENT_STAMP_GUARD_MS else FINE_DOCUMENT_STAMP_GUARD_MS

    fun isVerifiableAt(observedWallMs: Long): Boolean {
        if (size <= 0L || lastModifiedMs < MIN_PLAUSIBLE_DOCUMENT_EPOCH_MS) return false
        if (observedWallMs < lastModifiedMs) return false
        return observedWallMs - lastModifiedMs >= requiredGuardWindowMs()
    }
}

internal data class VerifiedDocumentStamp(
    val stamp: ProbedDocumentStamp,
    val savedMarkdown: String,
    val portable: Boolean,
    val assetDirectory: String?,
    val portableAssets: JSONObject?,
)

internal class DocumentRefreshStampStore {
    private val entries = ConcurrentHashMap<String, VerifiedDocumentStamp>()

    fun record(noteId: String, verified: VerifiedDocumentStamp) {
        entries[noteId] = verified
    }

    fun get(noteId: String): VerifiedDocumentStamp? = entries[noteId]

    fun matchesBaseline(
        noteId: String,
        probed: ProbedDocumentStamp?,
        savedMarkdown: String,
        portable: Boolean,
        assetDirectory: String?,
        expectedPortableAssets: JSONObject?,
    ): Boolean {
        if (probed == null) return false
        val cached = entries[noteId] ?: return false
        if (cached.stamp != probed) return false
        if (cached.portable != portable || cached.assetDirectory != assetDirectory) return false
        if (cached.savedMarkdown != savedMarkdown) return false
        if (!portable) return true
        val cachedAssets = cached.portableAssets ?: return false
        val currentAssets = expectedPortableAssets ?: return false
        return portableAssetsMatch(cachedAssets, currentAssets)
    }

    fun invalidate(noteId: String) {
        entries.remove(noteId)
    }

    fun invalidateUri(uriRaw: String) {
        val targetKey = runCatching { canonicalDocumentKey(Uri.parse(uriRaw)) }.getOrNull() ?: return
        entries.entries.removeIf { (_, value) -> value.stamp.canonicalDocKey == targetKey }
    }

    fun clear() {
        entries.clear()
    }
}

/**
 * Shallow-copy a `JSONObject` of `"assets/..." -> "data:image/...;base64,..."` entries while
 * preserving exact `String` object references so `MediaStorage.lookupValidatedMeta` (`===`) hits
 * without serializing or re-decoding multi-MB Base64 strings.
 */
internal fun shallowCopyPortableAssets(source: JSONObject): JSONObject {
    val copy = JSONObject()
    val keys = source.keys()
    while (keys.hasNext()) {
        val key = keys.next()
        copy.put(key, source.opt(key))
    }
    return copy
}

/**
 * Probe document metadata for per-tab refresh stamp comparison.
 *
 * Returns `null` when metadata is missing, zero-sized, or implausible so callers fall back
 * to read-only stream verification. Rethrows [CancellationException] and document access
 * failures (`SecurityException`, etc.) so SAF permission revocation handling stays authoritative.
 */
internal fun probeDocumentStamp(resolver: ContentResolver, target: Uri): ProbedDocumentStamp? {
    if (target.scheme.equals("file", ignoreCase = true)) {
        val path = target.path?.takeIf { it.isNotBlank() } ?: return null
        val attrs = try {
            Files.readAttributes(File(path).toPath(), BasicFileAttributes::class.java)
        } catch (_: Exception) {
            return null
        }
        if (!attrs.isRegularFile) return null
        val size = attrs.size()
        if (size <= 0L) return null
        val mtime = attrs.lastModifiedTime()
        val lastModifiedMs = mtime.toMillis()
        if (lastModifiedMs < MIN_PLAUSIBLE_DOCUMENT_EPOCH_MS) return null
        val subMillisNanos = mtime.toInstant().nano % 1_000_000
        val creationNanos = attrs.creationTime().to(TimeUnit.NANOSECONDS)
        return ProbedDocumentStamp(
            canonicalDocKey = canonicalDocumentKey(target),
            size = size,
            lastModifiedMs = lastModifiedMs,
            lastModifiedNanos = subMillisNanos,
            creationTimeNanos = creationNanos,
            fileKey = attrs.fileKey(),
        )
    }
    if (!target.scheme.equals("content", ignoreCase = true)) return null
    return try {
        resolver.query(
            target,
            arrayOf(OpenableColumns.SIZE, DocumentsContract.Document.COLUMN_LAST_MODIFIED),
            null,
            null,
            null,
        )?.use { cursor ->
            if (!cursor.moveToFirst()) return null
            val sizeIdx = cursor.getColumnIndex(OpenableColumns.SIZE)
            val modIdx = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED)
            if (sizeIdx < 0 || modIdx < 0 || cursor.isNull(sizeIdx) || cursor.isNull(modIdx)) {
                return null
            }
            val size = cursor.getLong(sizeIdx)
            val lastModifiedMs = cursor.getLong(modIdx)
            if (size <= 0L || lastModifiedMs < MIN_PLAUSIBLE_DOCUMENT_EPOCH_MS) return null
            ProbedDocumentStamp(
                canonicalDocKey = canonicalDocumentKey(target),
                size = size,
                lastModifiedMs = lastModifiedMs,
            )
        }
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (error: Throwable) {
        if (isDocumentAccessFailure(error)) throw error
        null
    }
}
