package dev.supermd.studio

import java.io.File
import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Test

class ClosedNoteStoreTest {
    private fun temporaryDirectory(block: (File) -> Unit) {
        val directory=Files.createTempDirectory("closed-note-store-test").toFile()
        try { block(directory) } finally { directory.deleteRecursively() }
    }

    @Test fun hugeDirtyPortableNoteRoundTripsAndKeepsAssetDirectoryPointer() = temporaryDirectory { directory ->
        val store=ClosedNoteStore(File(directory,"closed"))
        val note=Note(id="note-id",name="Portable.smd",uri="content://provider/note",
            content="λ".repeat(5*1024*1024),saved="old saved text",relative="folder/Portable.smd",
            assetDirectory="content://provider/assets")
        val reference=store.save(note)
        store.saveIndex(listOf(reference))
        assertEquals(note,ClosedNoteStore(File(directory,"closed")).load(reference))
        assertEquals(listOf(reference),store.loadIndex())
        assertEquals("content://provider/assets",store.loadIndex().single().assetDirectory)
    }

    @Test fun indexIsBoundedButHistoricalSnapshotsAreNotDeleted() = temporaryDirectory { directory ->
        val store=ClosedNoteStore(File(directory,"closed"))
        val refs=(0 until 14).map { index -> store.save(Note(id="note-$index",content="draft-$index")) }
        store.saveIndex(refs.takeLast(12))
        assertEquals(12,store.loadIndex().size)
        assertEquals("draft-0",store.load(refs.first()).content)
        assertEquals(14,File(directory,"closed").listFiles()!!.count {it.name.startsWith("snapshot-")})
    }

    @Test fun failedWriteLeavesOriginalDirectoryTargetAndRecoveryFallbackIntact() = temporaryDirectory { directory ->
        val blocked=File(directory,"not-a-directory").apply {writeText("preserve me")}
        val store=ClosedNoteStore(blocked)
        try {store.save(Note(id="note-id",content="valuable draft"));fail("Expected staging failure")}
        catch (_: Exception) { }
        assertEquals("preserve me",blocked.readText())

        val missing=ClosedNoteReference("same-id","Recovered.md",null,null,null,"a".repeat(32))
        val recovered=Note(id="same-id",name="Recovered.md",content="complete deleted draft",saved="baseline")
        assertEquals(recovered,store.loadForRecovery(missing,recovered))
    }

    @Test fun failedAtomicPromotionLeavesTargetUntouchedAndCleansStagingFile() = temporaryDirectory { directory ->
        val root=File(directory,"closed").apply {mkdirs()}
        val token="c".repeat(32)
        val target=File(root,"snapshot-$token.bin").apply {writeText("old snapshot")}
        val store=ClosedNoteStore(root,{token},{_,_->false})
        try {store.save(Note(id="note-id",content="important"));fail("Expected atomic rename failure")}
        catch (_: IllegalStateException) { }
        assertEquals("old snapshot",target.readText())
        assertArrayEquals(arrayOf(target),root.listFiles()!!.filter {it.name.startsWith("snapshot-")}.toTypedArray())
        assertTrue(root.listFiles()!!.none {it.extension=="tmp"})
    }

    @Test fun interruptedIndexPromotionKeepsPreviouslyCommittedIndex() = temporaryDirectory { directory ->
        var interrupt=false
        val root=File(directory,"closed")
        val store=ClosedNoteStore(root,{"d".repeat(32)},{staged,target -> if(interrupt)false else staged.renameTo(target)})
        val reference=store.save(Note(id="note-id",content="draft"))
        store.saveIndex(listOf(reference))
        interrupt=true
        try {store.saveIndex(emptyList());fail("Expected index promotion failure")}
        catch (_: IllegalStateException) { }
        assertEquals(listOf(reference),store.loadIndex())
        assertEquals("draft",store.load(reference).content)
    }

    @Test fun duplicateIdRecoveryResolvesClosedSnapshotBeforeUsingItsReference() = temporaryDirectory { directory ->
        val store=ClosedNoteStore(File(directory,"closed"))
        val closed=Note(id="duplicate-id",name="Closed.md",content="closed note body",saved="closed baseline")
        val reference=store.save(closed)
        val recovered=Note(id="duplicate-id",name="Recovered.md",content="deleted full draft",saved="deleted baseline")
        assertEquals(closed,store.loadForRecovery(reference,recovered))

        val unreadable=reference.copy(snapshot="b".repeat(32))
        assertEquals(recovered,store.loadForRecovery(unreadable,recovered))
    }

    @Test fun corruptIndexDoesNotExposeEmptyPlaceholderAsAReopenableNote() {
        val emptyPlaceholder = Note(id = "empty", name = "Empty.md", uri = "content://provider/empty")
        val nonEmptyLegacy = Note(id = "legacy", name = "Legacy.md", content = "draft", saved = "")
        assertTrue(closedNotesForRestore(emptyList(), listOf(emptyPlaceholder), emptySet(), indexValid = false).isEmpty())
        assertEquals(listOf(nonEmptyLegacy), closedNotesForRestore(emptyList(), listOf(emptyPlaceholder, nonEmptyLegacy), emptySet(), indexValid = false))
        assertEquals(listOf(emptyPlaceholder), closedNotesForRestore(emptyList(), listOf(emptyPlaceholder), emptySet(), indexValid = true))
    }
}
