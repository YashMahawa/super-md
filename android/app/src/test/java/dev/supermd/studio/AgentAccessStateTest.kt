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

    @Test fun setupGuideEmbedsCompleteAuthoringSkillWithoutBrokenRelativeLinksAndSkillZipIsClean() {
        val repoRoot = java.io.File(System.getProperty("user.dir") ?: ".").let { dir ->
            generateSequence(dir.canonicalFile) { it.parentFile }.first { java.io.File(it, "docs/skills/super-md/SKILL.md").isFile }
        }
        val bundledSkillFile = java.io.File(repoRoot, "dist/super-md-agent-SKILL.md")
        org.junit.Assert.assertTrue("dist/super-md-agent-SKILL.md must exist", bundledSkillFile.isFile)
        val config = AgentAccessConfig(
            serverOrigin = "https://relay.example.test",
            pairingKey = "A".repeat(43),
            connectorKey = "B".repeat(43),
            groupId = "7a3500af92d7b0d01d1148c1fd03e56d",
            deviceId = "android-device-1",
            deviceKey = "C".repeat(43),
            displayName = "Pixel",
            platform = "android",
        )
        val guide = AgentSetupGuide.instructions(config, bundledSkillFile.readText(Charsets.UTF_8))
        for (expected in listOf(
            "study-notes.md",
            "visual-authoring.md",
            "agent-connection.md",
            "# Exam-ready study notes",
            "# Diagram and interaction guide",
            "# Agent connection",
            "# Connection for this installation",
            config.mcpUrl,
        )) {
            org.junit.Assert.assertTrue("Guide missing $expected", guide.contains(expected))
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
            org.junit.Assert.assertTrue("Unexpected relative link in Android guide: $target", target.startsWith("#"))
            org.junit.Assert.assertTrue("Broken anchor in Android guide: $target", headings.contains(target.drop(1)))
        }

        val skillZipFile = java.io.File(repoRoot, "dist/super-md-skill.zip")
        org.junit.Assert.assertTrue("dist/super-md-skill.zip must exist", skillZipFile.isFile)
        java.util.zip.ZipFile(skillZipFile).use { zip ->
            val names = zip.entries().asSequence().map { it.name }.toSet()
            for (required in listOf(
                "super-md/SKILL.md",
                "super-md/references/study-notes.md",
                "super-md/references/visual-authoring.md",
                "super-md/references/agent-connection.md",
                "super-md/assets/study-visual-example.svg",
            )) {
                org.junit.Assert.assertTrue("Skill archive missing $required", names.contains(required))
            }
            org.junit.Assert.assertFalse(names.any { it.contains("local-preferences.md") })
            val combined = names.joinToString("\n") { entryName ->
                zip.getInputStream(zip.getEntry(entryName)).readBytes().toString(Charsets.UTF_8)
            }
            org.junit.Assert.assertFalse(combined.contains("relay.example.test"))
            org.junit.Assert.assertFalse(combined.contains("pairingKey"))
        }
    }
}
