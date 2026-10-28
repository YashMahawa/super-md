package dev.supermd.studio

import android.util.Base64
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class AgentRelayClientTest {
    private val client = AgentRelayClient()
    private val revision = "a".repeat(64)
    private val svg = "<svg xmlns='http://www.w3.org/2000/svg'/>".toByteArray()

    private fun request(action: String = "attach", body: String = Base64.encodeToString(svg, Base64.NO_WRAP)) = JSONObject()
        .put("requestId", "asset_1").put("action", "asset_action").put("tabId", "tab:device:workspace:1")
        .put("expectedRevision", revision).put("assetAction", action)
        .put("assetName", "assets/model.svg").put("mimeType", "image/svg+xml").put("body", body)

    @Test fun acceptsBoundedPortableImageMutationAndReadActions() {
        client.validateRequest(request())
        client.validateRequest(request("list").put("body", "").put("offset", 50).put("limit", 50))
        client.validateRequest(request("source").put("body", ""))
    }

    @Test fun rejectsOversizedMalformedOrUnrevisionedAssetRequests() {
        assertThrows(IllegalArgumentException::class.java) {
            client.validateRequest(request(body = Base64.encodeToString(ByteArray(1_048_577), Base64.NO_WRAP)))
        }
        assertThrows(IllegalArgumentException::class.java) {
            client.validateRequest(request().put("mimeType", "text/html"))
        }
        assertThrows(IllegalArgumentException::class.java) {
            client.validateRequest(request().put("assetName", "assets/../escape.svg"))
        }
        assertThrows(IllegalArgumentException::class.java) {
            val missing = request()
            missing.remove("expectedRevision")
            client.validateRequest(missing)
        }
        assertEquals("asset_action", request().getString("action"))
    }

    @Test fun acceptsViewportImageFormatOnlyForRenderTabAndOnlySupportedEncodings() {
        val jpeg = JSONObject().put("requestId", "render_1").put("action", "render_tab")
            .put("tabId", "tab:device:workspace:1").put("imageFormat", "jpeg").put("width", 1000)
        client.validateRequest(jpeg)
        client.validateRequest(JSONObject(jpeg.toString()).put("imageFormat", "png"))
        client.validateRequest(JSONObject(jpeg.toString()).put("action", "get_diagram_image")
            .put("expectedRevision", revision).put("diagramId", "diagram-1"))

        assertThrows(IllegalArgumentException::class.java) {
            client.validateRequest(JSONObject(jpeg.toString()).put("imageFormat", "webp"))
        }
        assertThrows(IllegalArgumentException::class.java) {
            client.validateRequest(JSONObject(jpeg.toString()).put("action", "read_tab"))
        }
        assertThrows(IllegalArgumentException::class.java) {
            val missingTab = JSONObject(jpeg.toString())
            missingTab.remove("tabId")
            client.validateRequest(missingTab)
        }
    }

    @Test fun authenticatedWebSocketAdvertisesSupportedPreviewFormats() {
        val config = AgentAccessConfig(
            serverOrigin = "https://relay.example.test",
            groupId = "group-1",
            deviceId = "device-1",
            deviceKey = "device-secret",
            pairingKey = "pairing-secret",
            connectorKey = "connector-secret",
            displayName = "Android",
            platform = "android",
        )

        val request = client.authenticatedWebSocketRequest(config)
        assertEquals("png,jpeg", request.header("X-SuperMD-Preview-Formats"))
        assertEquals("Bearer device-secret", request.header("Authorization"))
        assertEquals("https", request.url.scheme)
    }
}
