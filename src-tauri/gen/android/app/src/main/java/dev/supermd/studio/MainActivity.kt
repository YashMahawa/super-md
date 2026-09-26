package dev.supermd.studio

import android.os.Bundle
import android.os.Build
import android.content.res.Configuration
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import org.json.JSONObject

class MainActivity : TauriActivity() {
  private val systemAppearance = object {
    @JavascriptInterface
    fun colors(): String {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return "null"
      val dark = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
      fun color(id: Int) = String.format("%06x", getColor(id) and 0xFFFFFF)
      return JSONObject().apply {
        put("mode", if (dark) "dark" else "light")
        put("colours", JSONObject().apply {
          put("primary", color(if (dark) android.R.color.system_accent1_200 else android.R.color.system_accent1_600))
          put("onPrimary", color(if (dark) android.R.color.system_accent1_800 else android.R.color.system_accent1_0))
          put("surface", color(if (dark) android.R.color.system_neutral1_900 else android.R.color.system_neutral1_10))
          put("surfaceContainerLow", color(if (dark) android.R.color.system_neutral1_800 else android.R.color.system_neutral1_50))
          put("surfaceContainerHigh", color(if (dark) android.R.color.system_neutral1_700 else android.R.color.system_neutral1_100))
          put("onSurface", color(if (dark) android.R.color.system_neutral1_50 else android.R.color.system_neutral1_900))
          put("onSurfaceVariant", color(if (dark) android.R.color.system_neutral2_200 else android.R.color.system_neutral2_700))
          put("outlineVariant", color(if (dark) android.R.color.system_neutral2_600 else android.R.color.system_neutral2_200))
        })
      }.toString()
    }

    @JavascriptInterface
    fun setImmersive(enabled: Boolean) {
      runOnUiThread {
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        if (enabled) {
          controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
          controller.hide(WindowInsetsCompat.Type.systemBars())
        } else {
          controller.show(WindowInsetsCompat.Type.systemBars())
        }
      }
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    webView.addJavascriptInterface(systemAppearance, "SuperMdAndroid")
  }
}
