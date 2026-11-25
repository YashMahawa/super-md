package dev.supermd.studio

import android.os.Build
import android.os.PowerManager
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.InputStreamReader
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

class ThemeArtworkTest {
    @get:Rule val compose=createAndroidComposeRule<ComponentActivity>()

    private fun runUiShell(command:String) {
        val automation=InstrumentationRegistry.getInstrumentation().uiAutomation
        automation.executeShellCommand(command).use {descriptor->
            InputStreamReader(android.os.ParcelFileDescriptor.AutoCloseInputStream(descriptor)).readText()
        }
    }

    private fun invalidateHierarchy(view:View) {
        view.invalidate()
        if(view is ViewGroup){
            for(index in 0 until view.childCount)invalidateHierarchy(view.getChildAt(index))
        }
    }

    private fun preparePresenterWindow() {
        val power=compose.activity.getSystemService(PowerManager::class.java)
        if(power!=null&&!power.isInteractive){
            runCatching {runUiShell("input keyevent KEYCODE_WAKEUP");runUiShell("wm dismiss-keyguard")}
        }
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            val activity=compose.activity
            if(Build.VERSION.SDK_INT>=Build.VERSION_CODES.O_MR1){
                activity.setShowWhenLocked(true)
                activity.setTurnScreenOn(true)
            }
            activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    private fun requestPresenterRedraw() {
        compose.activity.runOnUiThread {
            val decor=compose.activity.window.decorView
            if(decor.isAttachedToWindow){
                invalidateHierarchy(decor)
                decor.postInvalidateOnAnimation()
            }
        }
    }

    private fun awaitPresenterReady():Pair<Int,Int> {
        compose.waitForIdle()
        val sampleCenter=AtomicReference(0 to 0)
        var lastWakeMs=0L
        compose.waitUntil(15_000){
            val now=SystemClock.uptimeMillis()
            val power=compose.activity.getSystemService(PowerManager::class.java)
            if(power!=null&&!power.isInteractive&&now-lastWakeMs>1_000L){
                lastWakeMs=now
                runCatching {runUiShell("input keyevent KEYCODE_WAKEUP");runUiShell("wm dismiss-keyguard")}
            }
            var ready=false
            InstrumentationRegistry.getInstrumentation().runOnMainSync {
                val activity=compose.activity
                val decor=activity.window.decorView
                val resumed=ActivityLifecycleMonitorRegistry.getInstance()
                    .getActivitiesInStage(Stage.RESUMED)
                    .any {it===activity}
                if(!activity.hasWindowFocus())decor.requestFocus()
                if(resumed&&decor.isAttachedToWindow&&decor.isShown&&decor.width>0&&decor.height>0&&activity.hasWindowFocus()){
                    val location=IntArray(2)
                    decor.getLocationOnScreen(location)
                    sampleCenter.set((location[0]+decor.width/2) to (location[1]+decor.height/2))
                    ready=true
                }
            }
            ready
        }
        if(Build.VERSION.SDK_INT>=Build.VERSION_CODES.Q){
            val committed=CountDownLatch(1)
            InstrumentationRegistry.getInstrumentation().runOnMainSync {
                val decor=compose.activity.window.decorView
                if(decor.viewTreeObserver.isAlive){
                    decor.viewTreeObserver.registerFrameCommitCallback {committed.countDown()}
                }else{
                    committed.countDown()
                }
                invalidateHierarchy(decor)
                decor.postInvalidateOnAnimation()
            }
            committed.await(2_500,TimeUnit.MILLISECONDS)
        }
        compose.waitForIdle()
        return sampleCenter.get()
    }
    @Test fun componentRolesReachReaderAndRoundtripInSharedTheme() {
        val document=JSONObject().put("format","supermd-theme").put("version",1).put("name","Components").put("variants",JSONObject().put("light",JSONObject().put("colors",JSONObject().put("python-bg","#172a31").put("table-header-bg","#314e40").put("table-border","#807251")))).put("metrics",JSONObject().put("pythonRadius",16).put("tableBorderWidth",2).put("pythonSourceMaxHeight",24))
        val original=document.toString();val state=StudioState(customTheme=original,theme="light")
        val style=themeStyle(themeDocument(original),"light",false)
        assertEquals("#172a31",style.getJSONObject("colors").getString("python-bg"));assertEquals(16,style.getJSONObject("metrics").getInt("pythonRadius"))
        val shared=themeForSharing(state);assertFalse(JSONObject(PdfEngine.validateTheme(shared)).has("error"));assertEquals(original,state.customTheme)
    }
    private fun theme(color:String,opacity:Double=.1,withViewBox:Boolean=true):String {
        val box=if(withViewBox)"viewBox=\"0 0 100 100\"" else ""
        val svg="<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"100\" height=\"100\" $box><rect width=\"100\" height=\"100\" fill=\"$color\"/></svg>"
        val uri="data:image/svg+xml;base64,"+android.util.Base64.encodeToString(svg.toByteArray(),android.util.Base64.NO_WRAP)
        val art=JSONObject().put("image",uri).put("opacity",opacity).put("fit","cover")
        val variant=JSONObject().put("colors",JSONObject()).put("artwork",JSONObject().put("sidebar",art).put("reader",art))
        return JSONObject().put("format","supermd-theme").put("version",1).put("name","Artwork test").put("accent","blue").put("variants",JSONObject().put("dark",variant)).toString()
    }
    @Test fun nativeArtworkPaintsRealPixelsChangesAndCanBeHidden() {
        preparePresenterWindow()
        val state=mutableStateOf(StudioState(customTheme=theme("#ff0000"),theme="dark"))
        compose.setContent {Box(Modifier.fillMaxSize().background(Color.Black).themeArtwork(state.value,"sidebar"))}
        fun painted(r:Int,b:Int) {
            val (centerX,centerY)=awaitPresenterReady()
            var latest:android.graphics.Bitmap?=null
            var seen="no frame"
            try {
                compose.waitUntil(15000){
                    latest?.recycle()
                    val bitmap=InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot();latest=bitmap
                    if(bitmap==null){
                        requestPresenterRedraw()
                        false
                    }else{
                        val x=centerX.coerceIn(0,bitmap.width-1)
                        val y=centerY.coerceIn(0,bitmap.height-1)
                        val c=bitmap.getPixel(x,y);seen="#%08x".format(c)
                        val matches=kotlin.math.abs(android.graphics.Color.red(c)-r)<=2&&android.graphics.Color.green(c)<=2&&kotlin.math.abs(android.graphics.Color.blue(c)-b)<=2
                        if(!matches)requestPresenterRedraw()
                        matches
                    }
                }
            }catch(error:androidx.compose.ui.test.ComposeTimeoutException){throw AssertionError("Artwork must present RGB($r,0,$b); observed $seen",error)}
            finally {
                latest?.let {bitmap->java.io.File(compose.activity.cacheDir,"theme-art-$r-$b.png").outputStream().use {bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it)};bitmap.recycle()}
            }
        }
        painted(25,0)
        compose.runOnIdle {state.value=state.value.copy(customTheme=theme("#0000ff"))};painted(0,25)
        compose.runOnIdle {state.value=state.value.copy(customTheme=theme("#ff0000",withViewBox=false))};painted(25,0)
        compose.runOnIdle {state.value=state.value.copy(customTheme=theme("#0000ff",0.0))};painted(0,0)
        val bitmap=android.graphics.Bitmap.createBitmap(2,2,android.graphics.Bitmap.Config.ARGB_8888).apply {eraseColor(android.graphics.Color.RED)}
        @Suppress("DEPRECATION") val formats=listOf("png" to android.graphics.Bitmap.CompressFormat.PNG,"jpeg" to android.graphics.Bitmap.CompressFormat.JPEG,"webp" to android.graphics.Bitmap.CompressFormat.WEBP)
        try {for((mime,format) in formats){
            val stream=java.io.ByteArrayOutputStream();bitmap.compress(format,90,stream)
            val uri="data:image/$mime;base64,"+android.util.Base64.encodeToString(stream.toByteArray(),android.util.Base64.NO_WRAP)
            val raster=JSONObject(theme("#ff0000")).put("assets",JSONObject().put("painting",uri))
            raster.getJSONObject("variants").getJSONObject("dark").getJSONObject("artwork").getJSONObject("sidebar").put("image","asset:painting")
            compose.runOnIdle {state.value=state.value.copy(customTheme=raster.toString())};painted(25,0)
        }}finally{bitmap.recycle()}
    }
    @Test fun portableThemeSharePreservesCanonicalThemeAndIsolatesArtworkFromPatternControls() {
        val original=theme("#ff0000")
        val state=StudioState(customTheme=original,patternKind="paws",patternOpacity=.08f,patternSize=30f,patternSpacing=96f)
        val style=themeStyle(themeDocument(original),"dark",true,state.patternKind,state.patternOpacity,state.patternSize,state.patternSpacing)
        assertEquals("paws",style.getJSONObject("background").getString("pattern"))
        assertEquals(30.0,style.getJSONObject("background").getDouble("size"),.001)
        assertEquals(.1,style.getJSONObject("artwork").getJSONObject("reader").getDouble("opacity"),.001)
        val hiddenPattern=themeStyle(themeDocument(original),"dark",true,"none",0f,state.patternSize,state.patternSpacing)
        assertEquals(.1,hiddenPattern.getJSONObject("artwork").getJSONObject("reader").getDouble("opacity"),.001)
        val output=JSONObject(themeForSharing(state));val selected=output.getJSONObject("variants").getJSONObject("dark")
        assertFalse(selected.has("background"))
        assertEquals(.1,selected.getJSONObject("artwork").getJSONObject("reader").getDouble("opacity"),.001)
        assertEquals(.1,selected.getJSONObject("artwork").getJSONObject("sidebar").getDouble("opacity"),.001)
        assertEquals(original,state.customTheme)
        assertFalse(JSONObject(PdfEngine.validateTheme(output.toString())).has("error"))
    }
    @Test fun reusableRasterAssetsResolveForRenderingAndStayBundledForSharing() {
        val bitmap=android.graphics.Bitmap.createBitmap(2,2,android.graphics.Bitmap.Config.ARGB_8888).apply {eraseColor(android.graphics.Color.RED)}
        val stream=java.io.ByteArrayOutputStream();bitmap.compress(android.graphics.Bitmap.CompressFormat.JPEG,90,stream);bitmap.recycle()
        val uri="data:image/jpeg;base64,"+android.util.Base64.encodeToString(stream.toByteArray(),android.util.Base64.NO_WRAP)
        val document=JSONObject(theme("#ff0000")).put("assets",JSONObject().put("painting",uri))
        val reader=document.getJSONObject("variants").getJSONObject("dark").getJSONObject("artwork").getJSONObject("reader")
        reader.put("image","asset:painting").put("position","right")
        val original=document.toString();val state=StudioState(customTheme=original,theme="dark",patternOpacity=.15f)
        assertEquals(uri,themeStyle(themeDocument(original),"dark",true).getJSONObject("artwork").getJSONObject("reader").getString("image"))
        val shared=JSONObject(themeForSharing(state))
        assertEquals(uri,shared.getJSONObject("assets").getString("painting"))
        assertEquals("asset:painting",shared.getJSONObject("variants").getJSONObject("dark").getJSONObject("artwork").getJSONObject("reader").getString("image"))
        assertEquals(original,state.customTheme)
        assertFalse(JSONObject(PdfEngine.validateTheme(shared.toString())).has("error"))
    }
}
