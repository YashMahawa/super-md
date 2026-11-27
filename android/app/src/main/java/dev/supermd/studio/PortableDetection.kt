package dev.supermd.studio

/** Inspect only a bounded prefix. Providers often omit or lie about extensions. */
internal fun portableEnvelopeHeader(prefix: String): Boolean {
    val header=prefix.trimStart('\uFEFF',' ','\n','\r','\t')
    return header.startsWith('{') && Regex("\"format\"\\s*:\\s*\"supermd-(smd|fmd)\"").containsMatchIn(header)
}

internal fun portableGzipHeader(prefix: ByteArray): Boolean =
    prefix.size >= 2 && prefix[0] == 0x1f.toByte() && prefix[1] == 0x8b.toByte()

private val PORTABLE_ASSET_FILENAME = Regex("[A-Za-z0-9._-]{1,150}")
private val COMPAT_PORTABLE_ASSET_FILENAME = Regex("[A-Za-z0-9._-]{1,159}")

internal fun isValidPortableAssetFilename(filename: String): Boolean =
    PORTABLE_ASSET_FILENAME.matches(filename) && filename != "." && filename != ".."

internal fun isValidCompatPortableAssetFilename(filename: String): Boolean =
    COMPAT_PORTABLE_ASSET_FILENAME.matches(filename) && filename != "." && filename != ".."

internal fun isValidPortableAssetKey(source: String): Boolean =
    source.startsWith("assets/") && isValidPortableAssetFilename(source.substring(7))

internal fun isValidCompatPortableAssetKey(source: String): Boolean =
    source.startsWith("assets/") && isValidCompatPortableAssetFilename(source.substring(7))

internal fun isValidPortableAssetNameOrKey(value: String): Boolean =
    isValidPortableAssetFilename(value.removePrefix("assets/"))

internal fun isValidCompatPortableAssetNameOrKey(value: String): Boolean =
    isValidCompatPortableAssetFilename(value.removePrefix("assets/"))
