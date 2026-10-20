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
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.withContext
import kotlinx.coroutines.suspendCancellableCoroutine
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean
import java.util.UUID
import kotlin.coroutines.resume

internal class ReaderBridge(
    private val web: WebView,
    private val model: StudioViewModel,
    private val scope: CoroutineScope,
    private val ready: () -> Unit,
    private val assetCapabilities: ReaderAssetCapabilities,
) {
    private val retired = AtomicBoolean(false)
    private val capabilityLock = Any()
    private val pendingPythonOutputs = ReaderPythonOutputPending()
    private val flushBarrier = ReaderFlushBarrier()
    private val pdfJobLock = Any()
    private val pdfJobs = LinkedHashMap<String, PdfExportJob>()

    /** A dead renderer has no reply channel; already-started native work may finish safely. */
    fun retire() {
        synchronized(capabilityLock) {
            if (retired.compareAndSet(false, true)) {
                assetCapabilities.clear()
                flushBarrier.failAll()
                synchronized(pdfJobLock) { pdfJobs.clear() }
            }
        }
    }

    /** Waits for the live reader to flush its acknowledged edit queue for this exact note. */
    suspend fun requestFlush(noteId: String, timeoutMillis: Long = 12_000): Boolean {
        if (retired.get() || noteId.isBlank()) return false
        val request = flushBarrier.register(UUID.randomUUID().toString(), noteId)
        try {
            if (retired.get()) {
                flushBarrier.cancel(request.token, request)
                return false
            }
            val script = "window.supermdFlush?.({action:'android_flush',target:${JSONObject.quote(noteId)},token:${JSONObject.quote(request.token)}})"
            if (!web.post {
                    if (retired.get()) flushBarrier.complete(request.token, "", null, null, "Reader retired")
                    else web.evaluateJavascript(script, null)
                }) {
                flushBarrier.cancel(request.token, request)
                return false
            }
            return withTimeoutOrNull(timeoutMillis) { request.result.await() } == true
        } finally {
            flushBarrier.cancel(request.token, request)
        }
    }

    @JavascriptInterface fun post(id: String, command: String, raw: String) {
        if (retired.get()) return
        // JavascriptInterface runs on WebView's JavaBridge thread. Enter through
        // the view's handler rather than relying on a coroutine interceptor to
        // switch threads (Compose test interceptors may start inline).
        web.post { if (retired.get()) return@post; scope.launch {
            try {
                if (retired.get()) return@launch
                val args = JSONObject(raw)
                val output: Any? = when(command) {
                    "reader_ready" -> { ready(); true }
                    "document_changed" -> { model.readerEdit(args.getString("id"), args.getString("content")); true }
                    "document_sync" -> protocolSync(args)
                    "document_patch" -> protocolPatch(args)
                    "document_resync" -> protocolResync(args)
                    "document_flushed" -> documentFlushed(args)
                    "reading_position" -> {model.readingPosition(args.getString("id"),args.getJSONObject("location"));true}
                    "zoom_changed" -> { model.readerZoom(args.getDouble("zoom").toFloat(), args.optBoolean("fullscreen", model.state.value.fullscreen)); true }
                    "reader_overlay_changed" -> { model.overlay(args.optBoolean("open"), args.optBoolean("image")); true }
                    "document_outline" -> { model.outline(args.getString("id"), args.getJSONArray("headings")); true }
                    "load_font" -> withContext(Dispatchers.IO) {model.fonts.reader(args.getString("family"))}
                    "cache_python_output" -> cachePythonOutput(args)
                    "load_python_output" -> loadPythonOutput(args)
                    "load_asset" -> model.asset(args.getString("documentPath"), args.getString("source"))
                    "resolve_reader_asset" -> withContext(Dispatchers.IO) {
                        val source = args.getString("source")
                        val (noteId, asset) = model.resolveReaderAsset(args.getString("documentPath"), source)
                        require(asset.mime != "image/svg+xml") { "SVG images use the safe data loader" }
                        val capability = synchronized(capabilityLock) {
                            check(!retired.get()) { "Reader is no longer available" }
                            assetCapabilities.register(noteId, source, asset.mime, asset.fingerprint)
                                ?: error("Reader asset capacity reached; using the safe data loader")
                        }
                        JSONObject()
                            .put("url", "${ReaderAssetPathHandler.URL_PREFIX}${capability.token}?v=${capability.fingerprint}")
                            .put("mime", capability.mime)
                    }
                    "import_images" -> withContext(Dispatchers.IO) { model.media.importJson(args.getJSONArray("images")) }
                    "fetch_resource" -> withContext(Dispatchers.IO) { JSONObject().put("body", model.media.fetch(args.getString("url"), args.optBoolean("image"))) }
                    "request_fmd_export" -> { model.requestPortable?.invoke() ?: error("The file picker is not ready"); true }
                    "export_fmd_native" -> { model.writePortable(args.getString("id"), args.getString("content"), args.getJSONObject("assets"), args.optBoolean("save"), args.getString("originalContent")); true }
                    "run_python" -> runPython(args)
                    "export_pdf_native" -> exportPdf(args)
                    "cancel_export" -> cancelPdfExport(args)
                    "export_markdown_native" -> { model.shareMarkdown(args.getString("content")); true }
                    "export_failed" -> {
                        val message = args.getString("error")
                        if (isPdfExportCancellationMessage(message)) model.pdfExportCancelled() else model.fail(message)
                        true
                    }
                    else -> error("Unknown document command")
                }
                val encoded = when(output) { null -> "null"; is JSONObject -> output.toString(); is String -> JSONObject.quote(output); else -> output.toString() }
                web.post { if (!retired.get()) web.evaluateJavascript("window.supermdReply?.(${JSONObject.quote(id)},$encoded,null)", null) }
            } catch (error: Exception) {
                if (!retired.get() && error is PdfExportCancelledException) model.pdfExportCancelled()
                else if (!retired.get() && command in listOf("export_pdf_native", "export_fmd_native", "export_markdown_native")) model.fail("Export failed: ${error.message}")
                web.post { if (!retired.get()) web.evaluateJavascript("window.supermdReply?.(${JSONObject.quote(id)},null,${JSONObject.quote(error.message ?: "Operation failed")})", null) }
            }
        } }
    }

    private suspend fun exportPdf(args: JSONObject): Boolean {
        val jobId = if (!args.has("jobId")) null else
            args.optString("jobId").takeIf { args.opt("jobId") is String }
                ?: error("Invalid PDF export job id")
        if (jobId == null) {
            model.export(args.getString("content"), args.getJSONObject("options").toString(), args.getJSONObject("assets"))
            return true
        }
        require(jobId.isNotBlank() && jobId.length <= 128) { "Invalid PDF export job id" }
        val documentId = args.optString("id").takeIf { args.opt("id") is String && it.isNotBlank() }
            ?: error("PDF export job is missing its document id")
        require(model.state.value.tabs.any { it.id == documentId }) { "The export note is no longer open" }
        val job = synchronized(pdfJobLock) {
            check(!retired.get()) { "Reader is no longer available" }
            check(pdfJobs.size < MAX_PDF_JOBS || pdfJobs.containsKey(jobId)) { "Too many PDF exports are active" }
            check(!pdfJobs.containsKey(jobId)) { "Duplicate PDF export job id" }
            PdfExportJob(jobId, documentId).also { pdfJobs[jobId] = it }
        }
        try {
            model.export(
                args.getString("content"),
                args.getJSONObject("options").toString(),
                args.getJSONObject("assets"),
                job = job,
                onPublishing = { publishPdfPhase(job) },
            )
            return true
        } catch (error: Exception) {
            if (job.phase == PdfExportJob.Phase.CANCELLED && isPdfExportCancellationMessage(error.message)) {
                throw PdfExportCancelledException()
            }
            throw error
        } finally {
            job.fail()
            synchronized(pdfJobLock) { if (pdfJobs[jobId] === job) pdfJobs.remove(jobId) }
        }
    }

    private fun cancelPdfExport(args: JSONObject): JSONObject {
        if (!hasOnlyKeys(args, "jobId")) return JSONObject().put("cancelled", false)
        val jobId = args.optString("jobId").takeIf { args.opt("jobId") is String } ?: return JSONObject().put("cancelled", false)
        val job = synchronized(pdfJobLock) { pdfJobs[jobId] }
        return JSONObject().put("cancelled", job?.cancel() == true)
    }

    private suspend fun publishPdfPhase(job: PdfExportJob) {
        if (retired.get()) return
        val script = "window.supermdExportPhase?.(${JSONObject.quote(job.id)},'publishing')"
        withTimeoutOrNull(1_000) {
            suspendCancellableCoroutine { continuation ->
                val posted = web.post {
                    if (retired.get()) {
                        if (continuation.isActive) continuation.resume(Unit)
                    } else {
                        web.evaluateJavascript(script) {
                            if (continuation.isActive) continuation.resume(Unit)
                        }
                    }
                }
                if (!posted && continuation.isActive) continuation.resume(Unit)
            }
        }
    }

    private companion object {
        const val MAX_PDF_JOBS = 8
    }

    private fun protocolSync(args: JSONObject): JSONObject {
        if (!hasOnlyKeys(args, "id", "epoch", "revision", "content")) return editConflict()
        val id = args.optString("id").takeIf { args.opt("id") is String } ?: return editConflict()
        val epoch = args.optString("epoch").takeIf { args.opt("epoch") is String } ?: return editConflict()
        val content = args.optString("content").takeIf { args.opt("content") is String } ?: return editConflict()
        val revision = exactLong(args.opt("revision")) ?: return editConflict()
        return model.readerSync(id, epoch, revision, content)
    }

    private fun protocolPatch(args: JSONObject): JSONObject {
        if (!hasOnlyKeys(args, "id", "epoch", "baseRevision", "revision", "changes")) return editConflict()
        val id = args.optString("id").takeIf { args.opt("id") is String } ?: return editConflict()
        val epoch = args.optString("epoch").takeIf { args.opt("epoch") is String } ?: return editConflict()
        val baseRevision = exactLong(args.opt("baseRevision")) ?: return editConflict()
        val revision = exactLong(args.opt("revision")) ?: return editConflict()
        val rawChanges = args.optJSONArray("changes") ?: return editConflict()
        if (rawChanges.length() > ReaderEditProtocol.MAX_CHANGES) return editConflict()
        val changes = ArrayList<ReaderEditChange>(rawChanges.length())
        for (index in 0 until rawChanges.length()) {
            val item = rawChanges.optJSONObject(index) ?: return editConflict()
            if (item.length() != 3 || !item.has("from") || !item.has("to") || !item.has("insert")) return editConflict()
            val from = exactLong(item.opt("from"))?.takeIf { it in 0..Int.MAX_VALUE.toLong() }?.toInt() ?: return editConflict()
            val to = exactLong(item.opt("to"))?.takeIf { it in 0..Int.MAX_VALUE.toLong() }?.toInt() ?: return editConflict()
            val insert = item.optString("insert").takeIf { item.opt("insert") is String } ?: return editConflict()
            changes += ReaderEditChange(from, to, insert)
        }
        return model.readerPatch(id, epoch, baseRevision, revision, changes)
    }

    private fun protocolResync(args: JSONObject): JSONObject {
        val recoverableId = args.optString("id").takeIf { args.opt("id") is String }
        val recoverableContent = args.optString("content").takeIf { args.opt("content") is String }
        fun malformed(): JSONObject {
            model.preserveMalformedReaderResync(recoverableId, recoverableContent)
            return editConflict()
        }
        if (!hasOnlyKeys(args, "id", "epoch", "revision", "bases", "content")) return malformed()
        val id = recoverableId ?: return malformed()
        val epoch = args.optString("epoch").takeIf { args.opt("epoch") is String } ?: return malformed()
        val revision = exactLong(args.opt("revision")) ?: return malformed()
        val content = recoverableContent ?: return malformed()
        val rawBases = args.optJSONArray("bases") ?: return malformed()
        if (rawBases.length() !in 1..2) return malformed()
        val bases = ArrayList<String>(rawBases.length())
        for (index in 0 until rawBases.length()) {
            val base = rawBases.optString(index).takeIf { rawBases.opt(index) is String } ?: return malformed()
            bases += base
        }
        return model.readerResync(id, epoch, revision, bases, content)
    }

    private fun documentFlushed(args: JSONObject): JSONObject {
        val token = args.optString("token").takeIf { args.opt("token") is String }
            ?: return editConflict()
        val id = args.optString("id").takeIf { args.opt("id") is String }
        val content = args.optString("content").takeIf { args.opt("content") is String }
        val error = args.optString("error").takeIf { args.opt("error") is String }
        val wellFormed = id != null && when {
            error != null -> hasOnlyKeys(args, "id", "token", "error")
            else -> content != null && hasOnlyKeys(args, "id", "token", "content")
        }
        val current = id?.let { target -> model.state.value.tabs.firstOrNull { it.id == target } }
        val accepted = flushBarrier.complete(
            token,
            id ?: "",
            content,
            current?.takeIf { model.state.value.active.id == it.id }?.content,
            if (wellFormed) error else "Malformed flush acknowledgement",
        )
        return if (accepted) JSONObject().put("accepted", true)
        else JSONObject().put("accepted", false).put("reason", "conflict")
    }

    private fun exactLong(value: Any?): Long? {
        val number = value as? Number ?: return null
        if (number is Double || number is Float) {
            val double = number.toDouble()
            if (!double.isFinite() || double % 1.0 != 0.0 || double < Long.MIN_VALUE.toDouble() || double > Long.MAX_VALUE.toDouble()) return null
        }
        return number.toLong()
    }

    private fun hasOnlyKeys(args: JSONObject, vararg expected: String): Boolean =
        args.length() == expected.size && expected.all(args::has)

    private fun editConflict() = JSONObject().put("accepted", false).put("reason", "conflict")

    private fun outputStore() = PythonOutputStore(
        java.io.File(web.context.filesDir, "derived-python"),
        java.io.File(web.context.cacheDir, "derived-python"),
    )

    private fun pythonOutputContext(args: JSONObject): PythonOutputStore.Context? {
        val openDocuments = model.state.value.tabs.flatMap { note ->
            listOfNotNull(note.id, note.uri)
        }.toSet()
        return ReaderPythonContext.from(args, openDocuments)
    }

    private suspend fun cachePythonOutput(args: JSONObject): Boolean = withContext(Dispatchers.IO) {
        val source = args.getString("source")
        val result = args.getJSONObject("result")
        val context = pythonOutputContext(args)
        if (context == null) {
            outputStore().store(source, result)
        } else {
            val payload = ReaderPythonContext.resultPayload(result)
            val store = outputStore()
            val existing = store.load(source, context)
            val existingResult = existing?.optJSONObject("result")
            if (existing?.optJSONObject("provenance")?.optBoolean("verified", false) == true &&
                existingResult != null && ReaderPythonContext.sameResult(existingResult, payload)
            ) return@withContext true

            // Only retry an unsaved result that this bridge actually emitted.
            // Client provenance is not accepted as proof of native execution.
            if (!pendingPythonOutputs.matches(source, context, payload)) return@withContext false
            store.store(source, payload, context)
            pendingPythonOutputs.clear(source, context)
        }
        true
    }

    private suspend fun loadPythonOutput(args: JSONObject): JSONObject? = withContext(Dispatchers.IO) {
        val store = outputStore()
        val context = pythonOutputContext(args)
        if (context == null) store.load(args.getString("source"))
        else ReaderPythonContext.flattenStoredOutput(store.load(args.getString("source"), context))
    }

    private suspend fun runPython(args: JSONObject): JSONObject {
        val context = pythonOutputContext(args)
        val code = args.getString("code")
        val result = try {
            model.python(code)
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            if (context == null) throw error
            JSONObject().put("ok", false).put("stdout", "")
                .put("stderr", error.message ?: "Python execution failed").put("images", org.json.JSONArray())
        }
        if (context == null) return result

        // The reply follows the durable write. Reloading the scoped envelope
        // supplies provenance generated by native storage, never by JS.
        val store = outputStore()
        try {
            val stored = withContext(Dispatchers.IO) {
                store.store(code, result, context)
                store.load(code, context)
            }
            val flattened = ReaderPythonContext.flattenStoredOutput(stored)
                ?: error("Python output could not be reloaded after saving")
            pendingPythonOutputs.clear(code, context)
            return flattened
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            pendingPythonOutputs.remember(code, context, result)
            return ReaderPythonContext.resultPayload(result).put(
                "provenance",
                JSONObject().put("verified", false).put("unsaved", true)
                    .put("reason", "Could not save execution output"),
            )
        }
    }
}

/** Breaks the WebView -> JavaScriptInterface reference when a reader is retired. */
internal fun retireReaderBridge(web: WebView) {
    (web.getTag(R.id.reader_bridge_tag) as? ReaderBridge)?.retire()
    web.setTag(R.id.reader_bridge_tag, null)
    web.removeJavascriptInterface("SuperMD")
}

/** Retires native access before destroying a view; safe if Compose releases it again later. */
internal fun retireAndDestroyReader(web: WebView) {
    val destroyed = web.getTag(R.id.reader_destroyed_tag) == true
    retireReaderBridge(web)
    if (!destroyed) {
        web.setTag(R.id.reader_destroyed_tag, true)
        (web.parent as? android.view.ViewGroup)?.removeView(web)
        web.destroy()
    }
}

fun configureReader(web: WebView, model: StudioViewModel, scope: CoroutineScope, ready: () -> Unit, rendererGone: (WebView) -> Unit) {
    web.settings.javaScriptEnabled = true
    web.settings.domStorageEnabled = true
    web.settings.allowFileAccess = false
    web.settings.allowContentAccess = false
    web.settings.setSupportZoom(false)
    web.settings.builtInZoomControls = false
    web.settings.displayZoomControls = false
    web.settings.textZoom = 100
    web.settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
    val capabilities = ReaderAssetCapabilities()
    val assetPathHandler = ReaderAssetPathHandler(
        capabilities,
        open = model::openReaderAsset,
        noteIsOpen = { noteId -> model.state.value.tabs.any { it.id == noteId } },
    )
    val loader = WebViewAssetLoader.Builder()
        .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(web.context))
        .addPathHandler("/reader-assets/", assetPathHandler)
        .build()
    val bridge = ReaderBridge(web, model, scope, ready, capabilities)
    web.webViewClient = object : WebViewClient() {
        override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
            // Android says a WebView whose renderer exited cannot be reused.
            // Retire this bridge before dropping the view so late native work
            // cannot send replies to its dead JavaScript context.
            retireAndDestroyReader(view)
            rendererGone(view)
            return true
        }

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? = loader.shouldInterceptRequest(request.url)
        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
            if (request.url.host == "appassets.androidplatform.net" && request.url.path?.startsWith("/assets/") == true) {
                model.fail("A bundled document resource is missing. Please reinstall a complete release.")
            }
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
    web.setTag(R.id.reader_bridge_tag, bridge)
    web.addJavascriptInterface(bridge, "SuperMD")
    web.loadUrl("https://appassets.androidplatform.net/assets/web/android-reader.html")
}
