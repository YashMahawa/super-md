package dev.supermd.studio

import android.os.Looper
import java.security.MessageDigest
import java.time.Duration
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class AgentCanonicalHelpersTest {
    private val revision = "a".repeat(64)

    private fun syntheticConfig() = AgentAccessConfig(
        serverOrigin = "https://relay.synthetic.example",
        groupId = AgentAccessState.groupIdFor("synthPairingKey_" + "A".repeat(28), "synthConnectorKey_" + "B".repeat(26)),
        deviceId = "00000000-0000-4000-8000-000000000001",
        deviceKey = "synthDeviceKey_" + "C".repeat(29),
        pairingKey = "synthPairingKey_" + "A".repeat(28),
        connectorKey = "synthConnectorKey_" + "B".repeat(26),
        displayName = "Synthetic Android",
        platform = "android",
    )

    @Test fun canonicalRevisionHelperMatchesWindowBridgeRelayAndAccessState() {
        val activity = Robolectric.buildActivity(MainActivity::class.java).get()
        val samples = listOf(
            "",
            "# Plain ASCII note\nBody text",
            "# Heading ✨\n\$x^2 + y^2 = z^2\$ — café 🧪",
        )
        assertEquals(
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            agentContentRevision(""),
        )
        for (sample in samples) {
            val expected = MessageDigest.getInstance("SHA-256")
                .digest(sample.toByteArray(Charsets.UTF_8))
                .joinToString("") { "%02x".format(it) }
            assertEquals(expected, agentContentRevision(sample))
            assertEquals(expected, activity.agentRevision(sample))
        }

        val config = syntheticConfig()
        val wsRequest = AgentRelayClient().authenticatedWebSocketRequest(config)
        assertEquals(agentContentRevision(config.connectorKey), wsRequest.header("X-SuperMD-Connector-Hash"))

        val expectedGroup = MessageDigest.getInstance("SHA-256")
            .digest("supermd-group-v1\u0000${config.pairingKey}\u0000${agentContentRevision(config.connectorKey)}".toByteArray(Charsets.UTF_8))
            .take(16)
            .joinToString("") { "%02x".format(it) }
        assertEquals(expectedGroup, AgentAccessState.groupIdFor(config.pairingKey, config.connectorKey))
    }

    @Test fun canonicalRepairIndexHelperEnforcesBoundsUniquenessAndStrictIntegerTypes() {
        assertEquals(listOf(0), validateAgentRepairIndices(JSONArray().put(0)))
        assertEquals(listOf(3, 0, 12), validateAgentRepairIndices(JSONArray().put(3).put(0L).put(12)))
        val maxValid = JSONArray().apply { (0 until MAX_AGENT_REPAIR_INDICES).forEach(::put) }
        assertEquals((0 until 40).toList(), validateAgentRepairIndices(maxValid))

        val invalidArrays = listOf<Any?>(
            null,
            JSONObject.NULL,
            "0",
            JSONObject(),
            JSONArray(),
            JSONArray().apply { (0..MAX_AGENT_REPAIR_INDICES).forEach(::put) },
            JSONArray().put(-1),
            JSONArray().put(2).put(2),
            JSONArray().put(Int.MAX_VALUE.toLong() + 1L),
            JSONArray().put("1"),
            JSONArray().put(true),
            JSONArray().put(false),
            JSONArray().put(1.5),
            JSONArray().put(JSONObject.NULL),
        )
        for (invalid in invalidArrays) {
            val error = assertThrows(IllegalArgumentException::class.java) {
                validateAgentRepairIndices(invalid)
            }
            assertEquals("Invalid repair indices", error.message)
        }

        val client = AgentRelayClient()
        client.validateRequest(
            JSONObject()
                .put("requestId", "latex_top_ok")
                .put("action", "latex_apply")
                .put("tabId", "tab:device:main:1")
                .put("expectedRevision", revision)
                .put("repairIndices", maxValid),
        )
        client.validateRequest(
            JSONObject()
                .put("requestId", "latex_opt_ok")
                .put("action", "document_action")
                .put("documentAction", "latex_apply")
                .put("tabId", "tab:device:main:1")
                .put("expectedRevision", revision)
                .put("options", JSONObject().put("repairIndices", JSONArray().put(0).put(5))),
        )
        client.validateRequest(
            JSONObject()
                .put("requestId", "latexfix_opt_ok")
                .put("action", "document_action")
                .put("documentAction", "latexfix")
                .put("tabId", "tab:device:main:1")
                .put("expectedRevision", revision)
                .put("options", JSONObject().put("repairIndices", JSONArray().put(1))),
        )

        val invalidWireShapes = listOf(
            JSONArray(),
            JSONArray().apply { (0..40).forEach(::put) },
            JSONArray().put(1).put(1),
            JSONArray().put(-1),
            JSONArray().put("0"),
            JSONArray().put(true),
            JSONArray().put(0.5),
        )
        for (badIndices in invalidWireShapes) {
            val topError = assertThrows(IllegalArgumentException::class.java) {
                client.validateRequest(
                    JSONObject()
                        .put("requestId", "latex_top_bad")
                        .put("action", "latex_apply")
                        .put("tabId", "tab:device:main:1")
                        .put("expectedRevision", revision)
                        .put("repairIndices", badIndices),
                )
            }
            assertEquals("Invalid repair indices", topError.message)

            val optError = assertThrows(IllegalArgumentException::class.java) {
                client.validateRequest(
                    JSONObject()
                        .put("requestId", "latex_opt_bad")
                        .put("action", "document_action")
                        .put("documentAction", "latex_apply")
                        .put("tabId", "tab:device:main:1")
                        .put("expectedRevision", revision)
                        .put("options", JSONObject().put("repairIndices", badIndices)),
                )
            }
            assertEquals("Invalid repair indices", optError.message)
        }
    }

    @Test fun preservesExactlyOnceReplyCompletionExportBoundsTabIdIsolationAndCredentialFreeGuides() {
        val activity = Robolectric.buildActivity(MainActivity::class.java).get()

        val delivered = mutableListOf<Pair<Any?, String?>>()
        activity.captureAgentReply("req_once") { result, error -> delivered += (result to error) }
        activity.deliverAgentReply("req_once", "ok", null)
        activity.deliverAgentReply("req_once", "duplicate", "late error")
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(19))
        assertEquals(listOf<Pair<Any?, String?>>("ok" to null), delivered)

        val timedOut = mutableListOf<Pair<Any?, String?>>()
        activity.captureAgentReply("req_timeout") { result, error -> timedOut += (result to error) }
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(19))
        activity.deliverAgentReply("req_timeout", "too_late", null)
        assertEquals(1, timedOut.size)
        assertNull(timedOut.single().first)
        assertEquals("The live reader did not finish this request before its deadline", timedOut.single().second)

        assertEquals("note_1", activity.localAgentTabId("note_1"))
        assertNull(activity.localAgentTabId(""))
        assertNull(activity.localAgentTabId("invalid:colon"))
        assertNull(activity.localAgentTabId("tab:other-device:main:note_1"))

        assertThrows(IllegalArgumentException::class.java) {
            runBlocking { activity.readAgentExportChunk("job_1", -1L, 1024) }
        }
        assertThrows(IllegalArgumentException::class.java) {
            runBlocking { activity.readAgentExportChunk("job_1", 0L, 0) }
        }
        assertThrows(IllegalArgumentException::class.java) {
            runBlocking { activity.readAgentExportChunk("job_1", 0L, 524_289) }
        }

        val config = syntheticConfig()
        val guide = AgentSetupGuide.instructions(config, "# Skill Header")
        assertTrue(guide.contains("Copy private MCP URL"))
        assertFalse(guide.contains(config.mcpUrl))
        assertFalse(guide.contains(config.connectorKey))
        assertFalse(guide.contains(config.pairingKey))
        assertFalse(guide.contains(config.deviceKey))
    }
}
