package dev.supermd.studio

import android.content.Intent
import android.net.Uri
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

class ReaderBridge(private val web: WebView, private val model: StudioViewModel, private val scope: CoroutineScope, private val ready: () -> Unit) {
    @JavascriptInterface fun post(id: String, command: String, raw: String) {
        // JavascriptInterface runs on WebView's JavaBridge thread. Enter through
        // the view's handler rather than relying on a coroutine interceptor to
        // switch threads (Compose test interceptors may start inline).
        web.post { scope.launch {
            try {
                val args = JSONObject(raw)
                val output: Any? = when(command) {
                    "reader_ready" -> { ready(); true }
                    "document_changed" -> { model.edit(args.getString("id"), args.getString("content")); true }
                    "zoom_changed" -> { model.zoom(args.getDouble("zoom").toFloat()); true }
                    "load_asset" -> model.asset(args.getString("documentPath"), args.getString("source"))
                    "run_python" -> model.python(args.getString("code"))
                    "export_pdf_native" -> { model.export(args.getString("content"), args.getJSONObject("options").toString(), args.getJSONObject("assets")); true }
                    "export_failed" -> { model.fail(args.getString("error")); true }
                    else -> error("Unknown document command")
                }
                val encoded = when(output) { null -> "null"; is JSONObject -> output.toString(); is String -> JSONObject.quote(output); else -> output.toString() }
                web.post { web.evaluateJavascript("window.supermdReply?.(${JSONObject.quote(id)},$encoded,null)", null) }
            } catch (error: Exception) {
                if (command == "export_pdf_native") model.fail("PDF export failed: ${error.message}")
                web.post { web.evaluateJavascript("window.supermdReply?.(${JSONObject.quote(id)},null,${JSONObject.quote(error.message ?: "Operation failed")})", null) }
            }
        } }
    }
}

fun configureReader(web: WebView, model: StudioViewModel, scope: CoroutineScope, ready: () -> Unit) {
    web.settings.javaScriptEnabled = true
    web.settings.domStorageEnabled = true
    web.settings.allowFileAccess = false
    web.settings.allowContentAccess = false
    web.settings.setSupportZoom(false)
    web.settings.builtInZoomControls = false
    web.settings.displayZoomControls = false
    web.settings.textZoom = 100
    web.settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
    val loader = WebViewAssetLoader.Builder().addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(web.context)).build()
    web.webViewClient = object : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? = loader.shouldInterceptRequest(request.url)
        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
            if (request.url.host == "appassets.androidplatform.net") model.fail("A bundled document resource is missing. Please reinstall a complete release.")
        }
        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: android.webkit.WebResourceError) {
            if (request.isForMainFrame) model.fail("The document reader could not load. Please reopen the note.")
        }
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            // The bridge is available only in the bundled offline reader. Never
            // navigate this WebView to a page from a note or external website.
            if (request.url.host == "appassets.androidplatform.net" && request.url.path == "/assets/web/android-reader.html") return false
            if (request.isForMainFrame && request.url.scheme in listOf("https", "http", "mailto")) runCatching { view.context.startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
            return true
        }
    }
    web.addJavascriptInterface(ReaderBridge(web, model, scope, ready), "SuperMD")
    web.loadUrl("https://appassets.androidplatform.net/assets/web/android-reader.html")
}
