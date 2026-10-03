package dev.supermd.studio

import android.util.JsonWriter
import java.io.File
import java.security.MessageDigest
import org.json.JSONObject

/** Derived figures on disk, so offscreen cells/PDF can reload them after the
 * bounded JavaScript redisplay cache evicts their image data. Never runs code. */
internal class PythonOutputStore(private val root: File) {
    private fun path(source: String): File {
        require(source.length<=2_000_000){"Python source is too large"}
        val key=MessageDigest.getInstance("SHA-256").digest(source.toByteArray()).joinToString(""){"%02x".format(it)}
        return File(root,"$key.json")
    }
    @Synchronized fun store(source: String,result: JSONObject) {
        require(result.getString("stdout").length<=2_000_000&&result.getString("stderr").length<=2_000_000){"Python text output is too large"}
        val images=result.getJSONArray("images");require(images.length()<=20){"Too many Python figures"}
        var characters=0L
        for(i in 0 until images.length()){val image=images.getString(i);require(image.matches(Regex("data:image/(png|jpeg|svg\\+xml);base64,[A-Za-z0-9+/=\\r\\n]*"))){"Invalid Python image"};characters+=image.length}
        require(characters<=100_000_000){"Python figures exceed 75 MB"}
        root.mkdirs();val target=path(source);val staged=File.createTempFile(target.name,".tmp",root)
        try {
            staged.outputStream().use {stream ->
                val writer=JsonWriter(stream.bufferedWriter());writer.beginObject().name("ok").value(result.getBoolean("ok"))
                    .name("stdout").value(result.getString("stdout")).name("stderr").value(result.getString("stderr")).name("images").beginArray()
                for(i in 0 until images.length())writer.value(images.getString(i))
                writer.endArray().endObject();writer.flush();stream.fd.sync()
            }
            check(staged.renameTo(target)){"Could not preserve Python output"}
        } finally {staged.delete()}
    }
    @Synchronized fun load(source: String): JSONObject? {
        val file=path(source);if(!file.isFile)return null
        require(file.length()<=110_000_000){"Cached Python output is too large"}
        return JSONObject(file.readText())
    }
}
