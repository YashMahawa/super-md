package dev.supermd.studio

import android.app.Application
import android.content.ContentValues
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.security.MessageDigest

class UpdatePersistenceTest {
    private val app get()=InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as Application
    private fun receipt(version:String,code:Long):JSONObject {
        val name="Super-MD-$version-arm64-release.apk"
        return JSONObject().put("version",version).put("versionCode",code).put("name",name).put("size",4)
            .put("sha256",MessageDigest.getInstance("SHA-256").digest("test".toByteArray()).joinToString(""){"%02x".format(it)})
            .put("url","https://github.com/YashMahawa/super-md/releases/download/v$version/$name")
            .put("sums","https://github.com/YashMahawa/super-md/releases/download/v$version/SHA256SUMS")
    }
    @Test fun successfulUpgradeRemovesOnlyOwnedInstallerAndDownloadsCopy():Unit=runBlocking {
        val folder=File(app.filesDir,"updates").apply{mkdirs()};val record=File(folder,"ready.json")
        val before=record.takeIf{it.exists()}?.readBytes()
        val saved=receipt(BuildConfig.VERSION_NAME,BuildConfig.VERSION_CODE.toLong());val file=File(folder,saved.getString("name"));val fileBefore=file.takeIf{it.exists()}?.readBytes()
        var public:android.net.Uri?=null
        val unrelated=File(folder,"keep-user-note.md").apply{writeText("keep")}
        try {
            file.writeText("test")
            if(Build.VERSION.SDK_INT>=29) {
                public=app.contentResolver.insert(MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY),ContentValues().apply{put(MediaStore.MediaColumns.DISPLAY_NAME,"supermd-update-persistence-test.apk");put(MediaStore.MediaColumns.MIME_TYPE,"application/vnd.android.package-archive");put(MediaStore.MediaColumns.RELATIVE_PATH,Environment.DIRECTORY_DOWNLOADS+"/Super MD")})
                assertNotNull(public);app.contentResolver.openOutputStream(public!!)?.use{it.write("test".toByteArray())};saved.put("publicUri",public.toString())
            }
            record.writeText(saved.toString());AppUpdates(app).restore()
            assertFalse(file.exists());assertFalse(record.exists());assertEquals("keep",unrelated.readText())
            public?.let{uri->app.contentResolver.query(uri,arrayOf(MediaStore.MediaColumns._ID),null,null,null)?.use{assertFalse(it.moveToFirst())}}
        }finally {
            public?.let{runCatching{app.contentResolver.delete(it,null,null)}}
            unrelated.delete();if(fileBefore==null)file.delete() else file.writeBytes(fileBefore)
            if(before==null)record.delete() else record.writeBytes(before)
        }
    }
    @Test fun cancelledOrNotInstalledUpdateIsNeverDeleted():Unit=runBlocking {
        val folder=File(app.filesDir,"updates").apply{mkdirs()};val record=File(folder,"ready.json");val before=record.takeIf{it.exists()}?.readBytes()
        val saved=receipt("999.0.0",Int.MAX_VALUE.toLong());val file=File(folder,saved.getString("name"))
        try {
            file.writeText("test");record.writeText(saved.toString());val updates=AppUpdates(app);updates.restore()
            // Invalid synthetic APK cannot become installable, but must not be
            // mistaken for a successful installation and automatically deleted.
            assertFalse(updates.state.value.ready);assertTrue(file.exists());assertTrue(record.exists())
        }finally{file.delete();if(before==null)record.delete() else record.writeBytes(before)}
    }
}
