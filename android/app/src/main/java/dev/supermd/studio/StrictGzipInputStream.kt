package dev.supermd.studio

import java.io.FilterInputStream
import java.io.IOException
import java.io.InputStream
import java.io.PushbackInputStream
import java.util.zip.CRC32
import java.util.zip.DataFormatException
import java.util.zip.Inflater

/** One-member gzip reader that verifies CRC/length and rejects trailing bytes. */
internal class StrictGzipInputStream(input: InputStream, private val outputLimit: Long = 120_000_000L) : InputStream() {
    private class Capped(input: InputStream) : FilterInputStream(input) {
        var count = 0L
        override fun read(): Int {
            val value = super.read()
            if (value >= 0 && ++count > 120_000_000L) throw IOException("Compressed SMD exceeds 120 MB")
            return value
        }
        override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
            val size = super.read(buffer, offset, length)
            if (size > 0 && (count + size).also { count = it } > 120_000_000L) throw IOException("Compressed SMD exceeds 120 MB")
            return size
        }
    }

    private val source = PushbackInputStream(Capped(input), 8192)
    private val inflater = Inflater(true)
    private val compressed = ByteArray(8192)
    private val checksum = CRC32()
    private var inputLength = 0
    private var outputSize = 0L
    private var verified = false
    private var closed = false

    init {
        try { readHeader() }
        catch (error: Exception) { inflater.end(); source.close(); throw error }
    }

    private fun required(): Int = source.read().also { if (it < 0) throw IOException("Compressed SMD is truncated") }
    private fun readHeader() {
        val headerCrc = CRC32()
        fun headerByte(): Int = required().also(headerCrc::update)
        if (headerByte() != 0x1f || headerByte() != 0x8b || headerByte() != 8) throw IOException("Invalid gzip SMD header")
        val flags = headerByte()
        if (flags and 0xe0 != 0) throw IOException("Invalid gzip flags")
        repeat(6) { headerByte() } // MTIME, XFL, OS
        if (flags and 0x04 != 0) {
            val length = headerByte() or (headerByte() shl 8)
            repeat(length) { headerByte() }
        }
        fun skipCString() { do { } while (headerByte() != 0) }
        if (flags and 0x08 != 0) skipCString()
        if (flags and 0x10 != 0) skipCString()
        if (flags and 0x02 != 0) {
            val expected = required() or (required() shl 8)
            if (expected != (headerCrc.value.toInt() and 0xffff)) throw IOException("Invalid gzip header checksum")
        }
    }

    override fun read(): Int {
        val one = ByteArray(1)
        val count = read(one, 0, 1)
        return if (count < 0) -1 else one[0].toInt() and 0xff
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        if (closed) throw IOException("Stream is closed")
        if (offset < 0 || length < 0 || length > buffer.size - offset) throw IndexOutOfBoundsException()
        if (length == 0) return 0
        if (verified) return -1
        while (true) {
            if (inflater.needsInput()) {
                inputLength = source.read(compressed)
                if (inputLength < 0) throw IOException("Compressed SMD is truncated")
                inflater.setInput(compressed, 0, inputLength)
            }
            val count = try { inflater.inflate(buffer, offset, length) }
            catch (error: DataFormatException) { throw IOException("Invalid compressed SMD", error) }
            if (count > 0) {
                outputSize += count
                if (outputSize > outputLimit) throw IOException("Inflated SMD exceeds 120 MB")
                checksum.update(buffer, offset, count)
                return count
            }
            if (inflater.finished()) {
                val remaining = inflater.remaining
                if (remaining > 0) source.unread(compressed, inputLength - remaining, remaining)
                val expectedCrc = readLittleEndian32()
                val expectedSize = readLittleEndian32()
                if (expectedCrc != checksum.value || expectedSize != (outputSize and 0xffffffffL)) throw IOException("Compressed SMD checksum mismatch")
                if (source.read() != -1) throw IOException("SMD gzip stream contains trailing or concatenated data")
                verified = true
                return -1
            }
            if (inflater.needsDictionary()) throw IOException("Compressed SMD requires a dictionary")
            if (inflater.needsInput()) continue
            throw IOException("Invalid compressed SMD stream")
        }
    }

    private fun readLittleEndian32(): Long {
        var value = 0L
        repeat(4) { index -> value = value or (required().toLong() shl (8 * index)) }
        return value
    }

    override fun close() {
        if (!closed) { closed = true; inflater.end(); source.close() }
    }
}
