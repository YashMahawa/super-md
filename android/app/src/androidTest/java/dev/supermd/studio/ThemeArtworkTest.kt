package dev.supermd.studio

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class ThemeArtworkTest {
    @get:Rule val compose=createAndroidComposeRule<ComponentActivity>()
    private fun theme(color:String,opacity:Double=.1,withViewBox:Boolean=true):String {
        val box=if(withViewBox)"viewBox=\"0 0 100 100\"" else ""
        val svg="<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"100\" height=\"100\" $box><rect width=\"100\" height=\"100\" fill=\"$color\"/></svg>"
        val uri="data:image/svg+xml;base64,"+android.util.Base64.encodeToString(svg.toByteArray(),android.util.Base64.NO_WRAP)
        val art=JSONObject().put("image",uri).put("opacity",opacity).put("fit","cover")
        val variant=JSONObject().put("colors",JSONObject()).put("artwork",JSONObject().put("sidebar",art).put("reader",art))
        return JSONObject().put("format","supermd-theme").put("version",1).put("name","Artwork test").put("accent","blue").put("variants",JSONObject().put("dark",variant)).toString()
    }
    @Test fun nativeArtworkPaintsRealPixelsChangesAndCanBeHidden() {
        val state=mutableStateOf(StudioState(customTheme=theme("#ff0000"),theme="dark"))
        compose.activity.runOnUiThread {compose.activity.setContent {Box(Modifier.fillMaxSize().background(Color.Black).themeArtwork(state.value,"sidebar"))}}
        fun painted(r:Int,b:Int) {
            compose.waitForIdle()
            var latest:android.graphics.Bitmap?=null
            var seen="no frame"
            try {
                compose.waitUntil(15000){
                    latest?.recycle()
                    val bitmap=InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot();latest=bitmap
                    if(bitmap==null)false else {val c=bitmap.getPixel(bitmap.width/2,bitmap.height/2);seen="#%08x".format(c);kotlin.math.abs(android.graphics.Color.red(c)-r)<=2&&android.graphics.Color.green(c)<=2&&kotlin.math.abs(android.graphics.Color.blue(c)-b)<=2}
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
    @Test fun portableThemeShareIncludesControlsWithoutChangingTheImportedFile() {
        val original=theme("#ff0000")
        val state=StudioState(customTheme=original,patternKind="paws",patternOpacity=.08f,patternSize=30f,patternSpacing=96f)
        val output=JSONObject(themeForSharing(state));val selected=output.getJSONObject("variants").getJSONObject("dark")
        assertEquals("paws",selected.getJSONObject("background").getString("pattern"))
        assertEquals(30.0,selected.getJSONObject("background").getDouble("size"),.001)
        assertEquals(.08,selected.getJSONObject("artwork").getJSONObject("reader").getDouble("opacity"),.001)
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
