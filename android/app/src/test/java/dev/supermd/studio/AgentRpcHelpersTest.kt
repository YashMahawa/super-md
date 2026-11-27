package dev.supermd.studio

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class AgentRpcHelpersTest {
    private val unsavedMd = Note(id = "draft-1", name = "Draft.md", uri = null, content = "# Draft\n", saved = "")
    private val savedSmd = Note(
        id = "portable-1",
        name = "Paper.smd",
        uri = "content://provider/doc/42",
        content = "# Paper\n",
        saved = "# Paper\n",
        assetDirectory = "bundle-dir-1",
    )

    private fun keysOf(json: JSONObject): Set<String> = json.keys().asSequence().toSet()

    @Test fun buildAgentTabJsonMatchesAllSevenRpcPayloadsAndNullUriBehavior() {
        val draftRev = agentContentRevision(unsavedMd.content)
        val smdRev = agentContentRevision(savedSmd.content)

        // 1. list_tabs (unsaved active tab without URI vs saved inactive tab with URI)
        val listedDraft = buildAgentTabJson(
            note = unsavedMd, tabId = "tab:dev:main:draft-1", revision = draftRev,
            id = "tab:dev:main:draft-1", active = true, saved = !unsavedMd.dirty, mode = "source",
        )
        assertEquals(setOf("id", "tabId", "name", "saved", "active", "mode", "path", "uri", "revision"), keysOf(listedDraft))
        assertEquals("tab:dev:main:draft-1", listedDraft.getString("id"))
        assertEquals("draft-1", listedDraft.getString("path"))
        assertSame(JSONObject.NULL, listedDraft.get("uri"))
        assertTrue(listedDraft.isNull("uri"))
        assertFalse(listedDraft.getBoolean("saved"))
        assertTrue(listedDraft.getBoolean("active"))
        assertEquals("source", listedDraft.getString("mode"))
        assertEquals(draftRev, listedDraft.getString("revision"))

        val listedSmd = buildAgentTabJson(
            note = savedSmd, tabId = "tab:dev:main:portable-1", revision = smdRev,
            id = "tab:dev:main:portable-1", active = false, saved = !savedSmd.dirty, mode = "live",
        )
        assertEquals("content://provider/doc/42", listedSmd.getString("path"))
        assertEquals("content://provider/doc/42", listedSmd.getString("uri"))
        assertTrue(listedSmd.getBoolean("saved"))
        assertFalse(listedSmd.getBoolean("active"))

        // 2. document_action -> create (.md and .smd)
        val createdMd = buildAgentTabJson(unsavedMd, "tab:dev:main:draft-1", draftRev, active = true, format = "md")
        assertEquals(setOf("tabId", "name", "path", "uri", "active", "format", "revision"), keysOf(createdMd))
        assertEquals("md", createdMd.getString("format"))
        assertTrue(createdMd.isNull("uri"))

        val createdSmd = buildAgentTabJson(savedSmd, "tab:dev:main:portable-1", smdRev, active = false, format = "smd")
        assertEquals(setOf("tabId", "name", "path", "uri", "active", "format", "revision"), keysOf(createdSmd))
        assertEquals("smd", createdSmd.getString("format"))

        // 3. document_action -> activate
        val activated = buildAgentTabJson(savedSmd, "tab:dev:main:portable-1", smdRev, active = true)
        assertEquals(setOf("tabId", "name", "path", "uri", "active", "revision"), keysOf(activated))
        assertTrue(activated.getBoolean("active"))

        // 4. document_action -> save (saveAs = true)
        val savedAs = buildAgentTabJson(
            note = unsavedMd, tabId = "tab:dev:main:draft-1", revision = draftRev,
            nameOverride = "Renamed.md", pathOverride = "content://provider/new/9", uriOverride = "content://provider/new/9",
            active = true, saved = true, savedAs = true,
        )
        assertEquals(setOf("tabId", "name", "path", "uri", "active", "saved", "savedAs", "revision"), keysOf(savedAs))
        assertEquals("Renamed.md", savedAs.getString("name"))
        assertEquals("content://provider/new/9", savedAs.getString("path"))
        assertEquals("content://provider/new/9", savedAs.getString("uri"))
        assertTrue(savedAs.getBoolean("savedAs"))

        // 5 & 6. document_action -> in-place portable save & markdown save (no savedAs key)
        val savedPortable = buildAgentTabJson(savedSmd, "tab:dev:main:portable-1", smdRev, active = true, saved = true)
        val savedMarkdown = buildAgentTabJson(unsavedMd, "tab:dev:main:draft-1", draftRev, active = false, saved = false)
        assertEquals(setOf("tabId", "name", "path", "uri", "active", "saved", "revision"), keysOf(savedPortable))
        assertEquals(setOf("tabId", "name", "path", "uri", "active", "saved", "revision"), keysOf(savedMarkdown))

        // 7. document_action -> close (closed + activeTabId, without active/saved booleans)
        val closed = buildAgentTabJson(
            note = savedSmd, tabId = "tab:dev:main:portable-1", revision = smdRev,
            closed = true, activeTabId = "tab:dev:main:portable-1",
        )
        assertEquals(setOf("closed", "activeTabId", "tabId", "name", "path", "uri", "revision"), keysOf(closed))
        assertTrue(closed.getBoolean("closed"))
        assertEquals("tab:dev:main:portable-1", closed.getString("activeTabId"))
    }

    @Test fun validateAgentSavePrecheckDistinguishesMissingTabFormatMismatchAndRevisionConflict() {
        val mdRev = agentContentRevision(unsavedMd.content)
        val smdRev = agentContentRevision(savedSmd.content)

        val missing = validateAgentSavePrecheck(null, requestedFormat = null, expectedRevision = mdRev, saveAs = false)
        assertEquals(AgentSavePrecheckFailure("The requested tab is not open on this device", revisionConflict = false), missing)

        assertEquals(
            AgentSavePrecheckFailure("Android Save As preserves this note's md format; converting formats is not supported", revisionConflict = false),
            validateAgentSavePrecheck(unsavedMd, requestedFormat = "smd", expectedRevision = mdRev, saveAs = true),
        )
        assertEquals(
            AgentSavePrecheckFailure("Android save preserves this note's smd format; converting formats is not supported", revisionConflict = false),
            validateAgentSavePrecheck(savedSmd, requestedFormat = "md", expectedRevision = smdRev, saveAs = false),
        )

        val conflict = validateAgentSavePrecheck(unsavedMd, requestedFormat = "md", expectedRevision = "0".repeat(64), saveAs = false)
        assertEquals(AgentSavePrecheckFailure("Revision conflict: the note changed; read it again before saving", revisionConflict = true), conflict)

        assertNull(validateAgentSavePrecheck(unsavedMd, requestedFormat = null, expectedRevision = mdRev.uppercase(), saveAs = false))
        assertNull(validateAgentSavePrecheck(savedSmd, requestedFormat = "smd", expectedRevision = smdRev.lowercase(), saveAs = true))
    }
}
