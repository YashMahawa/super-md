package dev.supermd.studio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class AgentAccessStateTest {
    @Test fun groupIdMatchesRelayDerivationAndBindsBothWorkspaceKeys() {
        val pairing = "A".repeat(43)
        val connector = "B".repeat(43)
        assertEquals("7a3500af92d7b0d01d1148c1fd03e56d", AgentAccessState.groupIdFor(pairing, connector))
        assertNotEquals(AgentAccessState.groupIdFor(pairing, connector), AgentAccessState.groupIdFor(pairing, "C".repeat(43)))
        assertNotEquals(AgentAccessState.groupIdFor(pairing, connector), AgentAccessState.groupIdFor("D".repeat(43), connector))
    }

    @Test fun relayOriginMustBeHttpsAndContainNoPathOrCredentials() {
        assertEquals("https://relay.example.test", AgentAccessState.validateOrigin("https://Relay.Example.Test/"))
        assertThrows(IllegalArgumentException::class.java) { AgentAccessState.validateOrigin("http://relay.example.test") }
        assertThrows(IllegalArgumentException::class.java) { AgentAccessState.validateOrigin("https://relay.example.test/mcp") }
        assertThrows(IllegalArgumentException::class.java) { AgentAccessState.validateOrigin("https://user:pass@relay.example.test") }
    }
}
