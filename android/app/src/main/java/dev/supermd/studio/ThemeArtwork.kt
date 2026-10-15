package dev.supermd.studio

import android.graphics.BitmapFactory
import android.graphics.Picture
import android.util.Base64
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import com.caverock.androidsvg.SVG

private val artworkPictures=android.util.LruCache<String,Picture>(2)
/** Validated, bounded static artwork. Cache vector drawing commands rather
 * than adding a WebView, a full-size wallpaper bitmap or animation timers. */
@Composable internal fun Modifier.themeArtwork(state:StudioState,area:String):Modifier {
    val theme=remember(state.customTheme){themeDocument(state.customTheme)}
    val systemDark=androidx.compose.foundation.isSystemInDarkTheme()
    val mode=if(state.fullscreen)state.fullscreenTheme else state.theme
    val art=themeVariant(theme,mode,mode=="dark"||mode=="black"||mode=="system"&&systemDark)?.optJSONObject("artwork")?.optJSONObject(area)
    val uri=artworkImage(theme,art)
    val picture=remember(uri){runCatching {
        artworkPictures.get(uri)?.let {return@runCatching it}
        require(uri.length<=699180)
        val bytes=Base64.decode(uri.substringAfter(','),Base64.DEFAULT)
        require(bytes.size<=512*1024)
        val result=when {
            uri.startsWith("data:image/svg+xml;base64,")->{
                val svg=SVG.getFromString(bytes.toString(Charsets.UTF_8))
                val ratio=svg.documentAspectRatio.let {if(it.isFinite()&&it>0f)it else 1f}
                val width=if(ratio>=1f)1024 else (1024*ratio).toInt().coerceAtLeast(1)
                val height=if(ratio>=1f)(1024/ratio).toInt().coerceAtLeast(1)else 1024
                svg.renderToPicture(width,height)
            }
            uri.startsWith("data:image/png;base64,")||uri.startsWith("data:image/jpeg;base64,")||uri.startsWith("data:image/webp;base64,")->{
                val options=BitmapFactory.Options().apply {inJustDecodeBounds=true};BitmapFactory.decodeByteArray(bytes,0,bytes.size,options)
                require(options.outWidth>0&&options.outHeight>0&&options.outWidth.toLong()*options.outHeight<=4194304)
                options.inJustDecodeBounds=false;while(maxOf(options.outWidth,options.outHeight)/options.inSampleSize.coerceAtLeast(1)>1024)options.inSampleSize=options.inSampleSize.coerceAtLeast(1)*2
                val bitmap=BitmapFactory.decodeByteArray(bytes,0,bytes.size,options)?:error("Invalid artwork")
                Picture().apply {val canvas=beginRecording(bitmap.width,bitmap.height);canvas.drawBitmap(bitmap,0f,0f,null);endRecording()}
            }
            else->null
        }
        result?.also {artworkPictures.put(uri,it)}
    }.getOrNull()}
    val opacity=(art?.optDouble("opacity",.06)?:.06).toFloat().coerceIn(0f,.12f)
    val contain=art?.optString("fit")=="contain"
    val position=art?.optString("position","center").orEmpty()
    return if(picture==null)this else drawWithContent {
        drawIntoCanvas {canvas->
            val native=canvas.nativeCanvas
            val sx=size.width/picture.width
            val sy=size.height/picture.height
            val scale=if(contain)minOf(sx,sy)else maxOf(sx,sy)
            val paint=android.graphics.Paint().apply {alpha=(opacity*255).toInt()}
            native.saveLayer(0f,0f,size.width,size.height,paint)
            native.clipRect(0f,0f,size.width,size.height)
            val x=size.width-picture.width*scale;val y=size.height-picture.height*scale
            native.translate(if(position.contains("left"))0f else if(position.contains("right"))x else x/2,if(position.contains("top"))0f else if(position.contains("bottom"))y else y/2)
            native.scale(scale,scale);native.drawPicture(picture);native.restore()
        }
        drawContent()
    }
}
