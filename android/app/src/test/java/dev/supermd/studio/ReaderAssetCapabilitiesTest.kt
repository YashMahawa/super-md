package dev.supermd.studio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.ByteArrayInputStream
import java.io.IOException

@RunWith(RobolectricTestRunner::class)
class ReaderAssetCapabilitiesTest {
    @Test fun repeatedResolutionDeduplicatesWithoutPuttingSourceInToken() {
        val table = ReaderAssetCapabilities()
        val first = table.register("note-1", "images/photo.png", "image/png", "revision-a")!!
        val again = table.register("note-1", "images/photo.png", "image/png", "revision-a")

        assertEquals(first, again)
        assertTrue(first.token.matches(Regex("[a-f0-9]{32}")))
        assertFalse(first.token.contains("photo"))
        assertEquals(1, table.size())
    }

    @Test fun changedRevisionGetsNewCapabilityAndClosedNotesAreRejectedOnEveryLookup() {
        val table = ReaderAssetCapabilities()
        val old = table.register("note-1", "images/photo.png", "image/png", "revision-a")!!
        val changed = table.register("note-1", "images/photo.png", "image/png", "revision-b")!!

        assertNotEquals(old.token, changed.token)
        assertNotNull(table.lookup(old.token) { true })
        assertNull(table.lookup(old.token) { false })
        assertEquals(1, table.size()) // the closed note's capability is revoked, not just denied
        assertNull(table.lookup("../../outside", { true }))
    }

    @Test fun capabilityTableKeepsLiveUrlsAndFallsBackForNewResolutionsAtItsBound() {
        val table = ReaderAssetCapabilities(capacity = 2)
        val first = table.register("n", "a.png", "image/png", "1")!!
        table.register("n", "b.png", "image/png", "1")
        assertEquals(first, table.register("n", "a.png", "image/png", "1"))
        assertNull(table.register("n", "c.png", "image/png", "1"))

        assertEquals(2, table.size())
        assertEquals(first, table.lookup(first.token) { true })

        val handler = ReaderAssetPathHandler(
            table,
            { _, _, fingerprint -> OpenReaderAsset("image/png", fingerprint, ByteArrayInputStream(byteArrayOf(7))) },
            { true },
        )
        val response = handler.handle(first.token)
        assertEquals(200, response.statusCode)
        assertEquals(7, response.data.read())
        response.data.close()
    }

    @Test fun fingerprintChangesWhenContentsChangeEvenWithUnchangedProviderMetadata() {
        val first = readerAssetFingerprint("provider-uri", 3, 100) { ByteArrayInputStream(byteArrayOf(1, 2, 3)) }
        val changed = readerAssetFingerprint("provider-uri", 3, 100) { ByteArrayInputStream(byteArrayOf(1, 2, 4)) }

        assertNotEquals(first, changed)
    }

    @Test fun streamLimitAllowsExactBoundaryAndClosesOnOverflow() {
        var closed = false
        val input = BoundedAssetInputStream(ByteArrayInputStream(byteArrayOf(1, 2, 3)), limit = 2) { closed = true }
        val buffer = ByteArray(8)

        assertEquals(2, input.read(buffer))
        try {
            input.read(buffer)
            throw AssertionError("expected overflow")
        } catch (_: IllegalArgumentException) {
            assertTrue(closed)
        }
    }

    @Test fun streamProviderFailureClosesTheUnderlyingStream() {
        var closed = false
        val provider = object : ByteArrayInputStream(byteArrayOf(1)) {
            override fun read(buffer: ByteArray, offset: Int, length: Int): Int = throw IOException("provider failed")
            override fun close() { closed = true; super.close() }
        }
        val bounded = BoundedAssetInputStream(provider)

        try {
            bounded.read(ByteArray(4))
            throw AssertionError("expected provider failure")
        } catch (_: IOException) {
            assertTrue(closed)
        }
    }

    @Test fun missingCapabilityUsesExplicitNonCacheable404() {
        val handler = ReaderAssetPathHandler(ReaderAssetCapabilities(), { _, _, _ -> error("must not open") }, { true })
        val response = handler.handle("unknown-token")

        assertEquals(404, response.statusCode)
        assertEquals("Not Found", response.reasonPhrase)
        assertEquals("no-store", response.responseHeaders["Cache-Control"])
        assertNotNull(response.data)
        assertEquals(-1, response.data.read())
    }
}
