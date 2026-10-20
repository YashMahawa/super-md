package dev.supermd.studio

import android.webkit.WebResourceResponse
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.IOException
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class ReaderAssetPathTest {
    @Test fun relativePathRejectsTraversalAndEncodedSeparators() {
        assertEquals(listOf("notes", "images", "photo.png"), readerAssetPathParts("notes", "images/photo.png"))
        assertEquals(listOf("notes", "photo.png"), readerAssetPathParts("notes/images", "../photo.png"))
        assertThrows(IllegalStateException::class.java) { readerAssetPathParts("", "../outside.png") }
        assertThrows(IllegalArgumentException::class.java) { readerAssetPathParts("", "images%2f..%2foutside.png") }
        assertThrows(IllegalArgumentException::class.java) { readerAssetPathParts("", "/etc/passwd") }
    }

    @Test fun importedSymlinkCannotEscapeAttachmentRootAndMimeIsAllowlisted() {
        val app = ApplicationProvider.getApplicationContext<android.app.Application>()
        val storage = MediaStorage(app)
        val id = UUID.randomUUID().toString()
        val source = "assets/import-$id.png"
        val outside = File(app.cacheDir, "outside-$id.png").apply { writeBytes(byteArrayOf(1, 2, 3)) }
        val link = File(app.filesDir, "attachments/import-$id.png")
        try {
            try {
                java.nio.file.Files.createSymbolicLink(link.toPath(), outside.toPath())
            } catch (_: UnsupportedOperationException) {
                return // The filesystem does not support symlinks on this device.
            } catch (_: IOException) {
                return
            }
            assertNull(storage.local(source, null))
            assertEquals("image/png", storage.imageMime("photo.png", "image/png"))
            assertThrows(IllegalArgumentException::class.java) { storage.imageMime("photo.png", "image/x-unknown") }
            assertThrows(IllegalStateException::class.java) { storage.imageMime("photo.unknown", null) }
        } finally {
            link.delete()
            outside.delete()
        }
    }

    @Test fun staleOrClosedCapabilitiesReturnExplicitEmptyResponseWithoutOpeningProvider() {
        val capabilities = ReaderAssetCapabilities()
        val stale = requireNotNull(capabilities.register("closed-note", "images/photo.png", "image/png", "revision-1"))
        var opens = 0
        val handler = ReaderAssetPathHandler(
            capabilities,
            open = { _, _, _ -> opens++; error("closed note must not open") },
            noteIsOpen = { false },
        )

        val response: WebResourceResponse = handler.handle(stale.token)
        assertEquals(404, response.statusCode)
        assertEquals("text/plain", response.mimeType)
        assertEquals("Not Found", response.reasonPhrase)
        assertEquals("no-store", response.responseHeaders["Cache-Control"])
        assertEquals(-1, response.data.read())
        assertEquals(0, opens)
    }

    @Test fun staleFingerprintDoesNotStreamChangedSource() {
        val capabilities = ReaderAssetCapabilities()
        val stale = requireNotNull(capabilities.register("open-note", "images/photo.png", "image/png", "old-revision"))
        var opens = 0
        val handler = ReaderAssetPathHandler(
            capabilities,
            open = { _, _, _ -> opens++; OpenReaderAsset("image/png", "new-revision", java.io.ByteArrayInputStream(byteArrayOf(1))) },
            noteIsOpen = { true },
        )

        val response = handler.handle(stale.token)
        assertEquals(404, response.statusCode)
        assertEquals("text/plain", response.mimeType)
        assertEquals("Not Found", response.reasonPhrase)
        assertEquals("no-store", response.responseHeaders["Cache-Control"])
        assertEquals(-1, response.data.read())
        assertEquals(1, opens)
    }
}
