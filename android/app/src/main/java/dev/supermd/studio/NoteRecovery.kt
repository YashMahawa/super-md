package dev.supermd.studio

import android.util.JsonReader
import android.util.JsonWriter
import android.util.JsonToken
import java.io.Reader
import java.io.Writer

/** Stream workspace JSON. Do not construct a second complete JSON string and
 * UTF-8 byte array for every large draft; unchanged saved text is shared. */
internal object NoteRecovery {
    fun write(output: Writer, state: StudioState) {
        val json=JsonWriter(output)
        fun notes(name: String, values: List<Note>) {
            json.name(name).beginArray()
            for(note in values) {
                json.beginObject().name("id").value(note.id).name("name").value(note.name)
                    .name("uri").value(note.uri ?: "").name("content").value(note.content)
                    .name("relative").value(note.relative ?: "").name("assetDirectory").value(note.assetDirectory ?: "")
                if(note.saved!=note.content)json.name("saved").value(note.saved)
                json.endObject()
            }
            json.endArray()
        }
        json.beginObject().name("active").value(state.active.id)
        notes("tabs",state.tabs);notes("closed",state.closedTabs)
        json.name("mode").value(state.mode).name("normalZoom").value(state.normalZoom.toDouble())
            .name("fullscreenZoom").value(state.fullscreenZoom.toDouble()).endObject()
        json.flush()
    }
    fun read(input: Reader, defaults: StudioState): StudioState = JsonReader(input).use { json ->
        fun note(): Note {
            var id="";var name="";var uri:String?=null;var content="";var saved:String?=null;var relative:String?=null;var assets:String?=null
            json.beginObject()
            while(json.hasNext()) {
                val key=json.nextName()
                if(json.peek()==JsonToken.NULL){json.nextNull();continue}
                when(key) {
                    "id"->id=json.nextString();"name"->name=json.nextString();"uri"->uri=json.nextString().takeIf{it.isNotBlank()}
                    "content"->content=json.nextString();"saved"->saved=json.nextString()
                    "relative"->relative=json.nextString().takeIf{it.isNotBlank()};"assetDirectory"->assets=json.nextString().takeIf{it.isNotBlank()}
                    else->json.skipValue()
                }
            }
            json.endObject();require(id.isNotBlank()&&name.isNotBlank()) {"Invalid recovery note"}
            return Note(id,name,uri,content,saved?.takeUnless{it==content}?:content,relative,assets)
        }
        fun notes(): List<Note> {val result=mutableListOf<Note>();json.beginArray();while(json.hasNext())result.add(note());json.endArray();return result}
        var state=defaults
        json.beginObject()
        while(json.hasNext())when(json.nextName()) {
            "tabs"->{val tabs=notes();if(tabs.isNotEmpty())state=state.copy(tabs=tabs)}
            "closed"->state=state.copy(closedTabs=notes().take(12))
            "active"->state=state.copy(activeId=json.nextString())
            "mode"->{val mode=json.nextString();if(mode in listOf("live","editor","reader","split"))state=state.copy(mode=mode)}
            "normalZoom"->state=state.copy(normalZoom=json.nextDouble().toFloat().coerceIn(40f,300f))
            "fullscreenZoom"->state=state.copy(fullscreenZoom=json.nextDouble().toFloat().coerceIn(40f,300f))
            else->json.skipValue()
        }
        json.endObject();state
    }
}
