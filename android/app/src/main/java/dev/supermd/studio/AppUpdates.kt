package dev.supermd.studio

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.ContentValues
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.core.app.NotificationCompat
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

internal data class UpdateRelease(val version:String,val name:String,val url:String,val sums:String,val size:Long)
data class UpdateState(val status:String="",val checking:Boolean=false,val version:String?=null,val ready:Boolean=false,val automatic:Boolean=false,val checkOnOpen:Boolean=true)

internal fun stableVersion(value:String):List<Int> {
    require(Regex("v?\\d+\\.\\d+\\.\\d+").matches(value)){"Invalid stable version"}
    return value.removePrefix("v").split('.').map(String::toInt)
}
internal fun newerVersion(candidate:String,current:String):Boolean {
    val a=stableVersion(candidate);val b=stableVersion(current)
    for(i in a.indices)if(a[i]!=b[i])return a[i]>b[i]
    return false
}
internal fun officialAsset(raw:String):String {
    val url=Uri.parse(raw)
    require(url.scheme=="https" && url.encodedAuthority=="github.com" && url.path?.startsWith("/YashMahawa/super-md/releases/download/")==true && url.query==null && url.fragment==null){"Untrusted update asset"}
    return raw
}
internal fun releaseChecksum(text:String,name:String):String = text.lineSequence().mapNotNull {Regex("([a-fA-F0-9]{64})\\s+\\*?(.+)").matchEntire(it)}.firstOrNull{it.groupValues[2]==name}?.groupValues?.get(1)?.lowercase() ?: error("Release checksum is missing")

class AppUpdates(private val app:Application) {
    private val prefs=app.getSharedPreferences("studio-updates",0)
    private val mutable=MutableStateFlow(UpdateState(automatic=prefs.getBoolean("automatic",false),checkOnOpen=prefs.getBoolean("checkOnOpen",true)))
    val state=mutable.asStateFlow()
    private var release:UpdateRelease?=null
    private var readyFile:File?=null
    private val folder get()=File(app.filesDir,"updates").apply{mkdirs()}
    private val receipt get()=File(folder,"ready.json")
    private var restored=false
    private fun hash(file:File):String {
        val digest=MessageDigest.getInstance("SHA-256")
        file.inputStream().use{input->val buffer=ByteArray(256*1024);while(true){val n=input.read(buffer);if(n<0)break;digest.update(buffer,0,n)}}
        return digest.digest().joinToString(""){"%02x".format(it)}
    }
    private fun saveReceipt(value:JSONObject) {
        if(receipt.isFile && receipt.length()<=8192) {
            val previous=runCatching{JSONObject(receipt.readText())}.getOrNull();val old=previous?.optString("version").orEmpty()
            if(Regex("\\d+\\.\\d+\\.\\d+").matches(old) && old!=value.getString("version")) {
                val archive=android.util.AtomicFile(File(folder,"download-$old.json"));val output=archive.startWrite()
                try {output.write(previous.toString().toByteArray(Charsets.UTF_8));archive.finishWrite(output)}catch(error:Exception){archive.failWrite(output);throw error}
            }
        }
        val target=android.util.AtomicFile(receipt);val output=target.startWrite()
        try {output.write(value.toString().toByteArray(Charsets.UTF_8));target.finishWrite(output)}catch(error:Exception){target.failWrite(output);throw error}
    }
    private fun publishDownload(file:File,saved:JSONObject):Boolean {
        if(Build.VERSION.SDK_INT>=29) {
            val existing=saved.optString("publicUri")
            if(existing.isNotEmpty()) {
                val uri=Uri.parse(existing)
                val complete=runCatching{app.contentResolver.query(uri,arrayOf(MediaStore.MediaColumns.SIZE,MediaStore.MediaColumns.IS_PENDING,MediaStore.MediaColumns.OWNER_PACKAGE_NAME),null,null,null)?.use{cursor->
                    if(cursor.moveToFirst() && cursor.getString(2)==app.packageName){
                        if(cursor.getLong(0)==file.length()&&cursor.getInt(1)==0)true
                        else {app.contentResolver.delete(uri,null,null);false}
                    }else false
                } ?: false}.getOrDefault(false)
                if(complete)return true
            }
            val values=ContentValues().apply{put(MediaStore.MediaColumns.DISPLAY_NAME,file.name);put(MediaStore.MediaColumns.MIME_TYPE,"application/vnd.android.package-archive");put(MediaStore.MediaColumns.RELATIVE_PATH,Environment.DIRECTORY_DOWNLOADS+"/Super MD");put(MediaStore.MediaColumns.IS_PENDING,1)}
            val uri=app.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI,values) ?: error("Could not create Downloads entry")
            // Persist ownership before copying so interrupted downloads can be cleaned up.
            saved.put("publicUri",uri.toString());saveReceipt(saved)
            try {
                app.contentResolver.openOutputStream(uri)?.use{output->file.inputStream().use{it.copyTo(output)}} ?: error("Could not write Downloads entry")
                app.contentResolver.update(uri,ContentValues().apply{put(MediaStore.MediaColumns.IS_PENDING,0)},null,null)
                return true
            }catch(error:Exception){app.contentResolver.delete(uri,null,null);saved.remove("publicUri");saveReceipt(saved);throw error}
        }
        if(app.checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE)!=PackageManager.PERMISSION_GRANTED)return false
        @Suppress("DEPRECATION") val publicFolder=File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),"Super MD").apply{mkdirs()}
        val previous=saved.optString("publicPath")
        if(previous.isNotBlank()) {
            val fileBefore=File(previous)
            if(fileBefore.canonicalFile.parentFile==publicFolder.canonicalFile && fileBefore.isFile && hash(fileBefore)==saved.getString("sha256"))return true
        }
        val target=File.createTempFile("Super-MD-${saved.getString("version")}-",".apk",publicFolder)
        saved.put("publicPath",target.canonicalPath);saveReceipt(saved)
        file.copyTo(target,overwrite=true)
        android.media.MediaScannerConnection.scanFile(app,arrayOf(target.absolutePath),arrayOf("application/vnd.android.package-archive"),null)
        return true
    }
    private fun clearInstalled(saved:JSONObject,file:File,record:File=receipt) {
        if(Build.VERSION.SDK_INT>=29) {
            val uri=Uri.parse(saved.optString("publicUri"))
            if(uri.authority=="media" && uri.path?.startsWith("/external/downloads/")==true)runCatching {
                app.contentResolver.query(uri,arrayOf(MediaStore.MediaColumns.OWNER_PACKAGE_NAME),null,null,null)?.use{cursor->if(cursor.moveToFirst()&&cursor.getString(0)==app.packageName)app.contentResolver.delete(uri,null,null)}
            }
        }else {
            val path=saved.optString("publicPath")
            @Suppress("DEPRECATION") val parent=File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),"Super MD").canonicalFile
            if(path.isNotBlank())runCatching {val publicFile=File(path);if(publicFile.canonicalFile.parentFile==parent && hash(publicFile)==saved.getString("sha256"))publicFile.delete()}
        }
        file.delete();record.delete()
    }
    suspend fun restore() {
        if(restored || mutable.value.checking)return
        restored=true;mutable.value=mutable.value.copy(checking=true)
        try {
            withContext(Dispatchers.IO) {
                for(record in folder.listFiles().orEmpty().filter{Regex("download-\\d+\\.\\d+\\.\\d+\\.json").matches(it.name)}.take(64))runCatching {
                    require(record.length()<=8192);val previous=JSONObject(record.readText());val target=previous.getString("version");stableVersion(target)
                    val name=previous.getString("name");require(Regex("Super-MD-"+Regex.escape(target)+"-(arm64|x86_64|armeabi-v7a)-release\\.apk").matches(name))
                    if(!newerVersion(target,BuildConfig.VERSION_NAME)&&BuildConfig.VERSION_CODE.toLong()>=previous.getLong("versionCode"))clearInstalled(previous,File(folder,name),record)
                }
                if(!receipt.exists())return@withContext
                require(receipt.length()<=8192)
                val saved=JSONObject(receipt.readText());val name=saved.getString("name");val target=saved.getString("version")
                stableVersion(target);require(Regex("Super-MD-"+Regex.escape(target)+"-(arm64|x86_64|armeabi-v7a)-release\\.apk").matches(name))
                val file=File(folder,name);require(file.canonicalFile.parentFile==folder.canonicalFile)
                // Installation success is observed on a subsequent app launch, not
                // inferred from opening (or cancelling) Android's installer.
                if(!newerVersion(target,BuildConfig.VERSION_NAME) && BuildConfig.VERSION_CODE.toLong()>=saved.getLong("versionCode")) {clearInstalled(saved,file);return@withContext}
                val info=UpdateRelease(target,name,officialAsset(saved.getString("url")),officialAsset(saved.getString("sums")),saved.getLong("size"))
                require(info.size in 1..536_870_912 && file.length()==info.size && hash(file)==saved.getString("sha256")){"Saved installer changed"}
                release=info;verifyUpgrade(file)
                readyFile=file
                val public=runCatching{publishDownload(file,saved)}.getOrDefault(false)
                mutable.value=mutable.value.copy(version=target,ready=true,status=if(public)"Verified APK ready in Downloads → Super MD." else "Verified APK ready. Allow storage access to also save it in Downloads.")
            }
        }catch(error:Exception){mutable.value=mutable.value.copy(status="Saved update unavailable: ${error.message}")}
        finally {mutable.value=mutable.value.copy(checking=false)}
    }
    fun preference(automatic:Boolean?=null,checkOnOpen:Boolean?=null) {
        mutable.value=mutable.value.copy(automatic=automatic ?: mutable.value.automatic,checkOnOpen=checkOnOpen ?: mutable.value.checkOnOpen)
        prefs.edit().apply{automatic?.let{putBoolean("automatic",it)};checkOnOpen?.let{putBoolean("checkOnOpen",it)}}.apply()
    }
    private fun connection(raw:String):HttpURLConnection {
        var next=raw
        repeat(6){
            val url=URL(next)
            require(url.protocol=="https" && url.host in setOf("api.github.com","github.com","release-assets.githubusercontent.com","objects.githubusercontent.com")){"Untrusted update redirect"}
            val connection=(url.openConnection() as HttpURLConnection).apply{connectTimeout=15000;readTimeout=30000;instanceFollowRedirects=false;setRequestProperty("User-Agent","Super-MD-updater")}
            if(connection.responseCode in 300..399){val location=connection.getHeaderField("Location") ?: error("Missing redirect");next=URL(url,location).toString();connection.disconnect()}
            else {require(connection.responseCode==200){"Update server returned ${connection.responseCode}"};return connection}
        }
        error("Too many update redirects")
    }
    private fun read(raw:String,limit:Int):String {
        val conn=connection(raw)
        try {return conn.inputStream.use{input->val output=java.io.ByteArrayOutputStream();val buffer=ByteArray(8192);while(true){val count=input.read(buffer);if(count<0)break;require(output.size()+count<=limit){"Update response too large"};output.write(buffer,0,count)};output.toString("UTF-8")}}
        finally{conn.disconnect()}
    }
    suspend fun check() {
        if(!restored)restore()
        if(mutable.value.checking)return
        mutable.value=mutable.value.copy(checking=true,status="Checking published releases…")
        try {
            val info=withContext(Dispatchers.IO){
                val json=JSONObject(read("https://api.github.com/repos/YashMahawa/super-md/releases/latest",1_000_000))
                val version=json.getString("tag_name").removePrefix("v")
                if(json.optBoolean("draft") || json.optBoolean("prerelease") || !newerVersion(version,BuildConfig.VERSION_NAME))null
                else {
                    val abi=if("arm64-v8a" in Build.SUPPORTED_ABIS)"arm64" else if("x86_64" in Build.SUPPORTED_ABIS)"x86_64" else "armeabi-v7a"
                    val name="Super-MD-$version-$abi-release.apk";val assets=json.getJSONArray("assets")
                    val entries=(0 until assets.length()).map{assets.getJSONObject(it)}
                    val apk=entries.firstOrNull{it.getString("name")==name} ?: error("No update APK for this phone architecture")
                    val sums=entries.firstOrNull{it.getString("name")=="SHA256SUMS"} ?: error("Incomplete published release")
                    val size=apk.getLong("size");require(size in 1..536_870_912)
                    UpdateRelease(version,name,officialAsset(apk.getString("browser_download_url")),officialAsset(sums.getString("browser_download_url")),size)
                }
            }
            if(info!=null && info.version==release?.version && readyFile?.isFile==true) {
                mutable.value=mutable.value.copy(checking=false,status="Verified Super MD ${info.version} is already downloaded.");return
            }
            if(info==null && readyFile?.isFile==true) {mutable.value=mutable.value.copy(checking=false);return}
            release=info;readyFile=null
            mutable.value=mutable.value.copy(checking=false,version=info?.version,ready=false,status=if(info==null)"You're on the latest published version." else "Super MD ${info.version} is available.")
            if(info!=null){notifyAvailable();if(mutable.value.automatic)download()}
        } catch(error:Exception){mutable.value=mutable.value.copy(checking=false,status="Couldn't check updates: ${error.message}. Notes still work offline.")}
    }
    suspend fun download() {
        val info=release ?: return
        if(mutable.value.checking)return
        if(readyFile?.isFile==true) {
            try {withContext(Dispatchers.IO){if(receipt.isFile)publishDownload(readyFile!!,JSONObject(receipt.readText()))}}
            catch(error:Exception){mutable.value=mutable.value.copy(status="Verified APK kept. Could not save a public Downloads copy: ${error.message}")}
            return
        }
        mutable.value=mutable.value.copy(checking=true,status="Downloading and verifying APK…")
        try {
            val file=withContext(Dispatchers.IO){
                val expected=releaseChecksum(read(info.sums,65_536),info.name)
                val temporary=File.createTempFile("apk-",".part",folder)
                try {
                    val digest=MessageDigest.getInstance("SHA-256");var count=0L;val conn=connection(info.url)
                    try {conn.inputStream.use{input->temporary.outputStream().use{output->val buffer=ByteArray(256*1024);while(true){val n=input.read(buffer);if(n<0)break;count+=n;require(count<=info.size);digest.update(buffer,0,n);output.write(buffer,0,n)}}}}finally{conn.disconnect()}
                    val actual=digest.digest().joinToString(""){"%02x".format(it)}
                    require(count==info.size && actual==expected){"APK checksum mismatch"}
                    verifyUpgrade(temporary)
                    val destination=File(folder,info.name);require(temporary.renameTo(destination)){"Could not stage APK"}
                    @Suppress("DEPRECATION") val archive=app.packageManager.getPackageArchiveInfo(destination.absolutePath,0) ?: error("Invalid staged APK")
                    @Suppress("DEPRECATION") val versionCode=if(Build.VERSION.SDK_INT>=28)archive.longVersionCode else archive.versionCode.toLong()
                    val saved=JSONObject().put("version",info.version).put("name",info.name).put("url",info.url).put("sums",info.sums).put("size",info.size).put("sha256",expected).put("versionCode",versionCode)
                    saveReceipt(saved)
                    // Downloads publishing is not required for safe installation.
                    // A provider/storage failure must not discard a verified APK.
                    runCatching{publishDownload(destination,saved)}
                    destination
                } finally{temporary.delete()}
            }
            readyFile=file;mutable.value=mutable.value.copy(checking=false,ready=true,status="Verified APK ready. Saved in Downloads when storage access is available. Android will ask you to approve installation; the download is removed only after a successful upgrade.")
            notifyAvailable()
        }catch(error:Exception){mutable.value=mutable.value.copy(checking=false,status="Update download failed: ${error.message}")}
    }
    @Suppress("DEPRECATION") private fun verifyUpgrade(file:File) {
        val pm=app.packageManager;val flags=if(Build.VERSION.SDK_INT>=28)PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
        val incoming=pm.getPackageArchiveInfo(file.absolutePath,flags) ?: error("Invalid APK package")
        val installed=pm.getPackageInfo(app.packageName,flags)
        require(incoming.packageName==app.packageName && incoming.versionName==release?.version){"APK identity mismatch"}
        require((incoming.applicationInfo?.flags ?: error("Missing APK application info")) and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE == 0){"Refusing a debug APK"}
        val code=if(Build.VERSION.SDK_INT>=28)incoming.longVersionCode else incoming.versionCode.toLong()
        val oldCode=if(Build.VERSION.SDK_INT>=28)installed.longVersionCode else installed.versionCode.toLong()
        require(code>oldCode){"APK is not an upgrade"}
        fun signatures(info:android.content.pm.PackageInfo)=if(Build.VERSION.SDK_INT>=28)info.signingInfo?.apkContentsSigners?.toList() else info.signatures?.toList()
        require(signatures(incoming)?.toSet()==signatures(installed)?.toSet() && !signatures(incoming).isNullOrEmpty()){ "APK upgrade certificate mismatch" }
    }
    fun install(activity:android.app.Activity) {
        val file=readyFile ?: return
        if(!app.packageManager.canRequestPackageInstalls()) {
            activity.startActivity(Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,Uri.parse("package:${app.packageName}")))
            mutable.value=mutable.value.copy(status="Allow installs from Super MD, then tap Install update again.");return
        }
        verifyUpgrade(file)
        val uri=FileProvider.getUriForFile(app,"${app.packageName}.share",file)
        activity.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri,"application/vnd.android.package-archive").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
    }
    fun notifyAvailable() {
        if(mutable.value.version==null)return
        if(Build.VERSION.SDK_INT>=33 && app.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED)return
        val manager=app.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel("updates","App updates",NotificationManager.IMPORTANCE_DEFAULT))
        val intent=PendingIntent.getActivity(app,91,Intent(app,MainActivity::class.java).putExtra("showUpdates",true),PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        manager.notify(91,NotificationCompat.Builder(app,"updates").setSmallIcon(R.drawable.symbol_file).setContentTitle("Super MD update").setContentText(mutable.value.status).setContentIntent(intent).setAutoCancel(true).build())
    }
}
