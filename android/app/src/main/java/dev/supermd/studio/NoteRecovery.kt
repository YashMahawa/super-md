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
                if(note.assetsDirty)json.name("assetsDirty").value(true)
                if(note.viewMode!=null)json.name("viewMode").value(note.viewMode)
                if(note.viewNormalZoom!=null)json.name("viewNormalZoom").value(note.viewNormalZoom.toDouble())
                if(note.viewFullscreenZoom!=null)json.name("viewFullscreenZoom").value(note.viewFullscreenZoom.toDouble())
                json.endObject()
            }
            json.endArray()
        }
        json.beginObject().name("active").value(state.active.id)
        notes("tabs",state.tabs);notes("closed",state.closedTabs)
        json.name("mode").value(state.mode).name("normalZoom").value(state.normalZoom.toDouble())
            .name("fullscreenZoom").value(state.fullscreenZoom.toDouble())
            .name("defaultMode").value(state.defaultMode)
            .name("defaultNormalZoom").value(state.defaultNormalZoom.toDouble())
            .name("defaultFullscreenZoom").value(state.defaultFullscreenZoom.toDouble())
            .endObject()
        json.flush()
    }
    fun read(input: Reader, defaults: StudioState): StudioState = JsonReader(input).use { json ->
        fun note(): Note {
            var id="";var name="";var uri:String?=null;var content="";var saved:String?=null;var relative:String?=null;var assets:String?=null;var assetsDirty=false
            var viewMode:String?=null;var viewNormalZoom:Float?=null;var viewFullscreenZoom:Float?=null
            json.beginObject()
            while(json.hasNext()) {
                val key=json.nextName()
                if(json.peek()==JsonToken.NULL){json.nextNull();continue}
                when(key) {
                    "id"->id=json.nextString();"name"->name=json.nextString();"uri"->uri=json.nextString().takeIf{it.isNotBlank()}
                    "content"->content=json.nextString();"saved"->saved=json.nextString()
                    "relative"->relative=json.nextString().takeIf{it.isNotBlank()};"assetDirectory"->assets=json.nextString().takeIf{it.isNotBlank()}
                    "assetsDirty"->assetsDirty=json.nextBoolean()
                    "viewMode"->viewMode=json.nextString().takeIf{it in VALID_VIEW_MODES}
                    "viewNormalZoom"->viewNormalZoom=json.nextDouble().toFloat().takeIf{it.isFinite()}?.coerceIn(40f,300f)
                    "viewFullscreenZoom"->viewFullscreenZoom=json.nextDouble().toFloat().takeIf{it.isFinite()}?.coerceIn(40f,300f)
                    else->json.skipValue()
                }
            }
            json.endObject();require(id.isNotBlank()&&name.isNotBlank()) {"Invalid recovery note"}
            return Note(id,name,uri,content,saved?.takeUnless{it==content}?:content,relative,assets,assetsDirty,viewMode,viewNormalZoom,viewFullscreenZoom)
        }
        fun notes(): List<Note> {val result=mutableListOf<Note>();json.beginArray();while(json.hasNext())result.add(note());json.endArray();return result}
        var state=defaults
        var sawDefaultMode=false;var sawDefaultNormalZoom=false;var sawDefaultFullscreenZoom=false
        var legacyMode:String?=null;var legacyNormalZoom:Float?=null;var legacyFullscreenZoom:Float?=null
        json.beginObject()
        while(json.hasNext())when(json.nextName()) {
            "tabs"->{val tabs=notes();if(tabs.isNotEmpty())state=state.copy(tabs=tabs)}
            "closed"->state=state.copy(closedTabs=notes().take(12))
            "active"->state=state.copy(activeId=json.nextString())
            "mode"->{val mode=json.nextString();if(mode in VALID_VIEW_MODES){legacyMode=mode;state=state.copy(mode=mode)}}
            "normalZoom"->{val z=json.nextDouble().toFloat().coerceIn(40f,300f);legacyNormalZoom=z;state=state.copy(normalZoom=z)}
            "fullscreenZoom"->{val z=json.nextDouble().toFloat().coerceIn(40f,300f);legacyFullscreenZoom=z;state=state.copy(fullscreenZoom=z)}
            "defaultMode"->{sawDefaultMode=true;val mode=json.nextString();if(mode in VALID_VIEW_MODES)state=state.copy(defaultMode=mode)}
            "defaultNormalZoom"->{sawDefaultNormalZoom=true;state=state.copy(defaultNormalZoom=json.nextDouble().toFloat().coerceIn(40f,300f))}
            "defaultFullscreenZoom"->{sawDefaultFullscreenZoom=true;state=state.copy(defaultFullscreenZoom=json.nextDouble().toFloat().coerceIn(40f,300f))}
            else->json.skipValue()
        }
        json.endObject()
        if(!sawDefaultMode&&legacyMode!=null)state=state.copy(defaultMode=legacyMode)
        if(!sawDefaultNormalZoom&&legacyNormalZoom!=null)state=state.copy(defaultNormalZoom=legacyNormalZoom)
        if(!sawDefaultFullscreenZoom&&legacyFullscreenZoom!=null)state=state.copy(defaultFullscreenZoom=legacyFullscreenZoom)
        state.syncedActiveView()
    }
}
