package dev.supermd.studio

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
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
            release=info;readyFile=null
            mutable.value=mutable.value.copy(checking=false,version=info?.version,ready=false,status=if(info==null)"You're on the latest published version." else "Super MD ${info.version} is available.")
            if(info!=null){notifyAvailable();if(mutable.value.automatic)download()}
        } catch(error:Exception){mutable.value=mutable.value.copy(checking=false,status="Couldn't check updates: ${error.message}. Notes still work offline.")}
    }
    suspend fun download() {
        val info=release ?: return
        if(mutable.value.checking)return
        mutable.value=mutable.value.copy(checking=true,status="Downloading and verifying APK…")
        try {
            val file=withContext(Dispatchers.IO){
                val expected=releaseChecksum(read(info.sums,65_536),info.name)
                val folder=File(app.cacheDir,"updates").apply{mkdirs()}
                val temporary=File.createTempFile("apk-",".part",folder)
                try {
                    val digest=MessageDigest.getInstance("SHA-256");var count=0L;val conn=connection(info.url)
                    try {conn.inputStream.use{input->temporary.outputStream().use{output->val buffer=ByteArray(256*1024);while(true){val n=input.read(buffer);if(n<0)break;count+=n;require(count<=info.size);digest.update(buffer,0,n);output.write(buffer,0,n)}}}}finally{conn.disconnect()}
                    val actual=digest.digest().joinToString(""){"%02x".format(it)}
                    require(count==info.size && actual==expected){"APK checksum mismatch"}
                    verifyUpgrade(temporary)
                    val destination=File(folder,info.name);require(temporary.renameTo(destination)){"Could not stage APK"};destination
                } finally{temporary.delete()}
            }
            readyFile=file;mutable.value=mutable.value.copy(checking=false,ready=true,status="Verified APK ready. Android will ask you to approve installation.")
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
