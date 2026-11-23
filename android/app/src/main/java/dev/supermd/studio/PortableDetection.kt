package dev.supermd.studio

/** Inspect only a bounded prefix. Providers often omit or lie about extensions. */
internal fun portableEnvelopeHeader(prefix: String): Boolean {
    val header=prefix.trimStart('\uFEFF',' ','\n','\r','\t')
    return header.startsWith('{') && Regex("\"format\"\\s*:\\s*\"supermd-(smd|fmd)\"").containsMatchIn(header)
}

internal fun portableGzipHeader(prefix: ByteArray): Boolean =
    prefix.size >= 2 && prefix[0] == 0x1f.toByte() && prefix[1] == 0x8b.toByte()
