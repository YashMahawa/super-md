package dev.supermd.studio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MarkdownBlocksTest {
    @Test fun obsidianCalloutAtStartIsParsed() {
        val blocks = parseBlocks("> [!TIP] Keep this\n> Review the graph.\n\n# Next")
        assertTrue(blocks[0] is NoteBlock.Callout)
        val callout = blocks[0] as NoteBlock.Callout
        assertEquals("tip", callout.kind)
        assertEquals("Keep this", callout.title)
        assertEquals("Review the graph.", callout.body)
        assertTrue(blocks[1] is NoteBlock.Heading)
    }

    @Test fun imageAndTableRemainSeparateBlocks() {
        val blocks = parseBlocks("![diagram](content://example/1)\n\n| A | B |\n|---|---|\n| one | two |")
        assertEquals(2, blocks.size)
        assertEquals("content://example/1", (blocks[0] as NoteBlock.Image).url)
        assertEquals(2, (blocks[1] as NoteBlock.Table).rows.size)
    }

    @Test fun interactiveChartParsesWithoutExecutingCode() {
        val blocks = parseBlocks("```smd-chart\n{\"title\":\"Waves\",\"series\":[{\"expression\":\"a * Math.sin(x)\"}]}\n```")
        assertEquals("Waves", (blocks.single() as NoteBlock.Chart).definition.getString("title"))
    }
}
