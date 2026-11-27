package dev.supermd.studio

import android.content.ClipData
import android.content.ClipboardManager
import android.security.keystore.KeyGenParameterSpec
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.io.InputStream
import java.io.OutputStream
import java.security.Key
import java.security.KeyStoreSpi
import java.security.Provider
import java.security.SecureRandom
import java.security.Security
import java.security.cert.Certificate
import java.security.spec.AlgorithmParameterSpec
import java.util.Collections
import java.util.Date
import java.util.Enumeration
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.KeyGeneratorSpi
import javax.crypto.SecretKey
import javax.crypto.spec.SecretKeySpec

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

    @Test fun setupGuideEmbedsCompleteAuthoringSkillWithoutBrokenRelativeLinksAndSkillZipIsClean() {
        val repoRoot = java.io.File(System.getProperty("user.dir") ?: ".").let { dir ->
            generateSequence(dir.canonicalFile) { it.parentFile }.first { java.io.File(it, "docs/skills/super-md/SKILL.md").isFile }
        }
        val bundledSkillFile = java.io.File(repoRoot, "dist/super-md-agent-SKILL.md")
        assertTrue("dist/super-md-agent-SKILL.md must exist", bundledSkillFile.isFile)
        val pairingKey = "synthPairingKey_" + "A".repeat(28)
        val connectorKey = "synthConnectorKey_" + "B".repeat(26)
        val deviceKey = "synthDeviceKey_" + "C".repeat(29)
        val groupId = AgentAccessState.groupIdFor(pairingKey, connectorKey)
        val config = AgentAccessConfig(
            serverOrigin = "https://relay.synthetic.example",
            pairingKey = pairingKey,
            connectorKey = connectorKey,
            groupId = groupId,
            deviceId = "00000000-0000-4000-8000-000000000001",
            deviceKey = deviceKey,
            displayName = "Synthetic Pixel",
            platform = "android",
        )
        assertEquals("https://relay.synthetic.example/mcp/$groupId/$connectorKey", config.mcpUrl)
        val guide = AgentSetupGuide.instructions(config, bundledSkillFile.readText(Charsets.UTF_8))
        for (expected in listOf(
            "study-notes.md",
            "visual-authoring.md",
            "agent-connection.md",
            "# Exam-ready study notes",
            "# Diagram and interaction guide",
            "# Agent connection",
            "# Connection for this installation",
            "not included in saved setup guides",
            "Settings → Agent connection",
            "Copy private MCP URL",
        )) {
            assertTrue("Guide missing $expected", guide.contains(expected))
        }
        for (forbidden in listOf(
            config.mcpUrl,
            config.connectorKey,
            config.pairingKey,
            config.deviceKey,
            config.groupId,
            config.deviceId,
            config.serverOrigin,
            "connectorKey",
            "pairingKey",
            "deviceKey",
        )) {
            assertFalse("Saved guide must omit $forbidden", guide.contains(forbidden))
        }
        val withoutCode = guide
            .replace(Regex("```[\\s\\S]*?```"), "")
            .replace(Regex("`[^`\\n]+`"), "")
        val headings = withoutCode.lineSequence()
            .filter { it.startsWith("#") }
            .map { it.trimStart('#').trim().lowercase().replace(Regex("[^a-z0-9 -]"), "").replace(" ", "-") }
            .toSet()
        for (match in Regex("\\[[^\\]]+]\\(([^)]+)\\)").findAll(withoutCode)) {
            val target = match.groupValues[1]
            if (target.startsWith("https://") || target.startsWith("http://")) continue
            assertTrue("Unexpected relative link in Android guide: $target", target.startsWith("#"))
            assertTrue("Broken anchor in Android guide: $target", headings.contains(target.drop(1)))
        }

        val skillZipFile = java.io.File(repoRoot, "dist/super-md-skill.zip")
        assertTrue("dist/super-md-skill.zip must exist", skillZipFile.isFile)
        java.util.zip.ZipFile(skillZipFile).use { zip ->
            val names = zip.entries().asSequence().map { it.name }.toSet()
            for (required in listOf(
                "super-md/SKILL.md",
                "super-md/references/study-notes.md",
                "super-md/references/visual-authoring.md",
                "super-md/references/agent-connection.md",
                "super-md/assets/study-visual-example.svg",
            )) {
                assertTrue("Skill archive missing $required", names.contains(required))
            }
            assertFalse(names.any { it.contains("local-preferences.md") })
            val combined = names.joinToString("\n") { entryName ->
                zip.getInputStream(zip.getEntry(entryName)).readBytes().toString(Charsets.UTF_8)
            }
            assertFalse(combined.contains("relay.synthetic.example"))
            assertFalse(combined.contains("relay.example.test"))
            assertFalse(combined.contains("pairingKey"))
        }
    }

    @Test fun savedSetupGuideOmitsSyntheticConnectorWhileKeepingExactMcpUrlAndPairingExportSeparate() {
        val context = RuntimeEnvironment.getApplication()
        val provider = InMemoryAndroidKeyStoreProvider()
        val hadProvider = Security.getProvider(provider.name) != null
        if (!hadProvider) Security.addProvider(provider)
        val state = AgentAccessState(context)
        try {
            val pairingKey = "synthPairingKey_" + "P".repeat(28)
            val connectorKey = "synthConnectorKey_" + "Q".repeat(26)
            val groupId = AgentAccessState.groupIdFor(pairingKey, connectorKey)
            val syntheticPairing = JSONObject()
                .put("format", "supermd-agent-pairing")
                .put("version", 1)
                .put("serverOrigin", "https://relay.synthetic.example")
                .put("groupId", groupId)
                .put("pairingKey", pairingKey)
                .put("connectorKey", connectorKey)
                .toString(2)

            val joined = state.joinPairingFile(syntheticPairing, "Synthetic Tablet")
            val expectedMcpUrl = "https://relay.synthetic.example/mcp/$groupId/$connectorKey"
            assertEquals(expectedMcpUrl, joined.mcpUrl)
            assertFalse(state.enabled)

            for (enabledState in listOf(false, true)) {
                state.setEnabled(enabledState)
                assertEquals(enabledState, state.enabled)
                val current = state.currentConfig()
                assertNotNull(current)
                assertEquals(expectedMcpUrl, current!!.mcpUrl)

                // Saved setup guide (both with and without bundled skill markdown) omits the connector and all secrets.
                for (skillMarkdown in listOf(null, "# Synthetic Skill\n\nAuthoring guidance.")) {
                    val savedGuide = AgentSetupGuide.instructions(current, skillMarkdown)
                    assertTrue(savedGuide.contains("# Connection for this installation"))
                    assertTrue(savedGuide.contains("not included in saved setup guides"))
                    assertTrue(savedGuide.contains("Settings → Agent connection"))
                    assertTrue(savedGuide.contains("Copy private MCP URL"))
                    if (skillMarkdown != null) assertTrue(savedGuide.contains("# Synthetic Skill"))
                    for (forbidden in listOf(
                        expectedMcpUrl,
                        connectorKey,
                        pairingKey,
                        current.deviceKey,
                        groupId,
                        current.deviceId,
                        current.serverOrigin,
                        "supermd-agent-pairing",
                        "connectorKey",
                        "pairingKey",
                        "deviceKey",
                    )) {
                        assertFalse("Saved guide (enabled=$enabledState) must omit $forbidden", savedGuide.contains(forbidden))
                    }
                }
            }

            // Explicit Copy private MCP URL action still copies the exact Streamable HTTP connector URL.
            val clipboard = context.getSystemService(ClipboardManager::class.java)
            clipboard.setPrimaryClip(ClipData.newPlainText("Super MD MCP connector", state.currentConfig()!!.mcpUrl))
            assertEquals(expectedMcpUrl, clipboard.primaryClip?.getItemAt(0)?.text?.toString())

            // Trusted device pairing export stays separate and preserves workspace pairing JSON without per-device keys.
            val exportedPairingRaw = state.currentPairingFile()
            assertNotNull(exportedPairingRaw)
            val exportedPairing = JSONObject(exportedPairingRaw!!)
            assertEquals("supermd-agent-pairing", exportedPairing.getString("format"))
            assertEquals(1, exportedPairing.getInt("version"))
            assertEquals("https://relay.synthetic.example", exportedPairing.getString("serverOrigin"))
            assertEquals(groupId, exportedPairing.getString("groupId"))
            assertEquals(pairingKey, exportedPairing.getString("pairingKey"))
            assertEquals(connectorKey, exportedPairing.getString("connectorKey"))
            assertFalse(exportedPairing.has("deviceKey"))
            assertFalse(exportedPairing.has("deviceId"))
        } finally {
            state.revoke()
            if (!hadProvider) Security.removeProvider(provider.name)
        }
    }
}

private class InMemoryAndroidKeyStoreProvider : Provider("AndroidKeyStore", 1.0, "Robolectric in-memory AndroidKeyStore") {
    init {
        put("KeyStore.AndroidKeyStore", StoreSpi::class.java.name)
        put("KeyGenerator.AES", AesKeyGenSpi::class.java.name)
    }

    companion object {
        val keys = ConcurrentHashMap<String, SecretKey>()
    }

    class StoreSpi : KeyStoreSpi() {
        override fun engineGetKey(alias: String, password: CharArray?): Key? = keys[alias]
        override fun engineGetCertificateChain(alias: String): Array<Certificate>? = null
        override fun engineGetCertificate(alias: String): Certificate? = null
        override fun engineGetCreationDate(alias: String): Date? = if (keys.containsKey(alias)) Date() else null
        override fun engineSetKeyEntry(alias: String, key: Key, password: CharArray?, chain: Array<out Certificate>?) {
            keys[alias] = key as SecretKey
        }
        override fun engineSetKeyEntry(alias: String, key: ByteArray, chain: Array<out Certificate>?) = throw UnsupportedOperationException()
        override fun engineSetCertificateEntry(alias: String, cert: Certificate) = throw UnsupportedOperationException()
        override fun engineDeleteEntry(alias: String) { keys.remove(alias) }
        override fun engineAliases(): Enumeration<String> = Collections.enumeration(keys.keys)
        override fun engineContainsAlias(alias: String): Boolean = keys.containsKey(alias)
        override fun engineSize(): Int = keys.size
        override fun engineIsKeyEntry(alias: String): Boolean = keys.containsKey(alias)
        override fun engineIsCertificateEntry(alias: String): Boolean = false
        override fun engineGetCertificateAlias(cert: Certificate): String? = null
        override fun engineStore(stream: OutputStream?, password: CharArray?) = Unit
        override fun engineLoad(stream: InputStream?, password: CharArray?) = Unit
    }

    class AesKeyGenSpi : KeyGeneratorSpi() {
        private var alias: String = "supermd.live-agent.credentials.v1"
        private var random: SecureRandom = SecureRandom()

        override fun engineInit(random: SecureRandom?) {
            if (random != null) this.random = random
        }

        override fun engineInit(params: AlgorithmParameterSpec?, random: SecureRandom?) {
            if (random != null) this.random = random
            if (params is KeyGenParameterSpec) {
                runCatching { params.keystoreAlias }.getOrNull()?.takeIf { it.isNotBlank() }?.let { alias = it }
            }
        }

        override fun engineInit(keysize: Int, random: SecureRandom?) {
            if (random != null) this.random = random
        }

        override fun engineGenerateKey(): SecretKey {
            val raw = ByteArray(32).also(random::nextBytes)
            return SecretKeySpec(raw, "AES").also { keys[alias] = it }
        }
    }
}
