package dev.supermd.studio

import java.io.File
import java.io.FileOutputStream
import java.util.UUID

internal data class DeletedDraftCandidate(val note: Note, val lastModified: Long)

/** Durable, app-private recovery, independent of the bounded in-RAM closed tabs. */
internal class DeletedDraftStore(private val directory:File) {
    fun save(note:Note) {
        directory.mkdirs()
        val target=File(directory,"${UUID.randomUUID()}.json")
        val temporary=File(directory,target.name+".tmp")
        try {
            FileOutputStream(temporary).use {stream->
                NoteRecovery.write(stream.bufferedWriter(),StudioState(tabs=listOf(note),activeId=note.id))
                stream.fd.sync()
            }
            check(temporary.renameTo(target)) {"Could not preserve the deleted draft"}
        } finally {temporary.delete()}
    }
    fun latest(excluding:Set<String>):Note? = latestCandidate(excluding)?.note
    internal fun latestCandidate(excluding:Set<String>):DeletedDraftCandidate? {
        for(file in directory.listFiles().orEmpty().filter {it.isFile && it.extension=="json"}.sortedByDescending {it.lastModified()}) {
            val modified=file.lastModified()
            val note=runCatching {file.bufferedReader().use {NoteRecovery.read(it,StudioState()).tabs.single()}}.getOrNull() ?: continue
            if(note.id !in excluding)return DeletedDraftCandidate(note,modified)
        }
        return null
    }
}
