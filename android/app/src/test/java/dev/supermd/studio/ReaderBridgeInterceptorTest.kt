package dev.supermd.studio

import android.net.Uri
import androidx.webkit.WebViewAssetLoader
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.io.ByteArrayInputStream

@RunWith(RobolectricTestRunner::class)
class ReaderBridgeInterceptorTest {
    private fun createLoader(capabilities: ReaderAssetCapabilities): WebViewAssetLoader {
        val context = RuntimeEnvironment.getApplication()
        val assetHandler = ReaderAssetPathHandler(
            capabilities,
            open = { _, _, fingerprint ->
                OpenReaderAsset("image/png", fingerprint, ByteArrayInputStream(byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47)))
            },
            noteIsOpen = { true },
        )
        return WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context))
            .addPathHandler("/reader-assets/", assetHandler)
            .build()
    }

    @Test
    fun blocksDirectExternalHttpHttpsFileAndUnmappedRequestsNeverReturningNull() {
        val capabilities = ReaderAssetCapabilities()
        val loader = createLoader(capabilities)

        for (blockedUrl in listOf(
            "https://evil.example/beacon.png",
            "http://evil.example/beacon.png",
            "file:///etc/hosts",
            "content://media/external/images/media/1",
            "https://appassets.androidplatform.net/unmapped/secret.txt",
        )) {
            val response = interceptReaderRequest(loader, Uri.parse(blockedUrl), "GET")
            assertNotNull("Expected non-null blocking response for $blockedUrl", response)
            assertEquals("Expected 403 for $blockedUrl", 403, response.statusCode)
            assertEquals("no-store", response.responseHeaders["Cache-Control"])
            assertEquals(-1, response.data.read())
        }

        val postAttempt = interceptReaderRequest(
            loader,
            Uri.parse("https://appassets.androidplatform.net/assets/web/android-reader.html"),
            "POST",
        )
        assertEquals(403, postAttempt.statusCode)
    }

    @Test
    fun servesRegisteredReaderAssetCapabilitiesAndReportsMissingBundledAssetsAs404() {
        val capabilities = ReaderAssetCapabilities()
        val capability = capabilities.register("note-1", "diagrams/chart.png", "image/png", "rev-1")!!
        val loader = createLoader(capabilities)

        val assetUrl = "${ReaderAssetPathHandler.URL_PREFIX}${capability.token}?v=${capability.fingerprint}"
        val assetResponse = interceptReaderRequest(loader, Uri.parse(assetUrl), "GET")
        assertEquals(200, assetResponse.statusCode)
        assertEquals("image/png", assetResponse.mimeType)
        assertEquals(0x89, assetResponse.data.read() and 0xFF)
        assetResponse.data.close()

        val missingBundled = interceptReaderRequest(
            loader,
            Uri.parse("https://appassets.androidplatform.net/assets/web/does-not-exist.js"),
            "GET",
        )
        assertEquals(404, missingBundled.statusCode)
        assertEquals("no-store", missingBundled.responseHeaders["Cache-Control"])
    }
}
