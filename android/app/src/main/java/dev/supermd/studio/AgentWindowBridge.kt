package dev.supermd.studio

import android.graphics.Bitmap
import android.graphics.Rect
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import android.util.Base64
import android.view.PixelCopy
import android.webkit.WebView
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.coroutines.resume
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.json.JSONObject

private const val MAX_AGENT_EXPORT_BYTES = 128L * 1024 * 1024
private const val AGENT_EXPORT_LEASE_MILLIS = 10L * 60 * 1000

private data class AgentExportArtifact(
    val uri: Uri,
    val filename: String,
    val format: String,
    val mimeType: String,
    val bytes: Long,
    val sha256: String,
    val createdAtMillis: Long,
)

internal class AgentWindowController(
    private val activity: MainActivity,
    private val onRelayStateChange: (AgentRelayClient.State) -> Unit,
    private val onRelayRetryingChange: (Boolean) -> Unit,
) {
    private val agentExportJobs = ConcurrentHashMap<String, JSONObject>()
    private val agentExportArtifacts = ConcurrentHashMap<String, AgentExportArtifact>()
    private val pendingAgentReplies = ConcurrentHashMap<String, (Any?, String?) -> Unit>()
    private val pendingAgentReplyTimeouts = ConcurrentHashMap<String, Runnable>()
    private val agentMainHandler = Handler(Looper.getMainLooper())
    private val agentRelayClient: AgentRelayClient by lazy {
        AgentRelayClient(
            onState = onRelayStateChange,
            onRetrying = onRelayRetryingChange,
            callFactory = activity.agentRelayCallFactoryForTest,
            webSocketFactory = activity.agentRelayWebSocketFactoryForTest,
        )
    }
    private var relayIdentity: String? = null
    private var activityStopped = false
    private val relayGraceTimerOwner = Any()
    private var relayGraceTimerActive = false
    @Volatile private var currentReaderWebView: WebView? = null
    private val backgroundDisconnectRunnable = Runnable {
        if (activityStopped) disconnectRelayNow()
    }
    internal fun attachCurrentReaderWebView(reader: WebView?) {
        currentReaderWebView = reader
    }
    private fun setRelayGraceTimerLease(active: Boolean) {
        if (relayGraceTimerActive == active) return
        relayGraceTimerActive = active
        val action = if (active) ReaderTimerOwners.process.acquire(relayGraceTimerOwner, true)
        else ReaderTimerOwners.process.release(relayGraceTimerOwner)
        val reader = currentReaderWebView ?: return
        when (action) {
            ReaderTimerOwners.GlobalAction.PAUSE -> reader.pauseTimers()
            ReaderTimerOwners.GlobalAction.RESUME -> reader.resumeTimers()
            ReaderTimerOwners.GlobalAction.NONE -> Unit
        }
    }
    internal fun disconnectRelayNow() {
        agentMainHandler.removeCallbacks(backgroundDisconnectRunnable)
        setRelayGraceTimerLease(false)
        agentRelayClient.disconnect()
        relayIdentity = null
        clearPendingAgentReplies()
    }
    internal fun onStart() {
        activityStopped = false
        agentMainHandler.removeCallbacks(backgroundDisconnectRunnable)
        setRelayGraceTimerLease(false)
        activity.syncAgentAccessUiState()
    }
    internal fun onResume() {
        activityStopped = false
        agentMainHandler.removeCallbacks(backgroundDisconnectRunnable)
        setRelayGraceTimerLease(false)
        activity.syncAgentAccessUiState()
    }
    internal fun onStop() {
        activityStopped = true
        val keepDuringGrace = !activity.isChangingConfigurations && !activity.isFinishing &&
            activity.agentAccessState.enabled && agentConfigForThisWindow() != null && activity.agentBackgroundGraceMillis > 0L
        if (keepDuringGrace) {
            setRelayGraceTimerLease(true)
            agentMainHandler.removeCallbacks(backgroundDisconnectRunnable)
            agentMainHandler.postDelayed(backgroundDisconnectRunnable, activity.agentBackgroundGraceMillis)
        } else {
            disconnectRelayNow()
        }
    }
    internal fun onDestroy() {
        activityStopped = true
        disconnectRelayNow()
        currentReaderWebView = null
    }
    internal fun agentConfigForThisWindow(): AgentAccessConfig? =
        activity.agentConfigOverrideForTest ?: activity.agentAccessState.configForWorkspace(activity.agentWorkspaceKey)
    internal fun localAgentTabId(value: String): String? {
        if (value.isBlank()) return null
        if (!value.startsWith("tab:")) return value.takeIf { ':' !in it }
        val parts = value.split(':')
        if (parts.size != 4) return null
        val config = agentConfigForThisWindow() ?: return null
        if (parts[1] != config.deviceId || parts[2] != activity.agentWorkspaceKey) return null
        return parts[3].takeIf { it.matches(Regex("^[A-Za-z0-9_-]{1,128}$")) }
    }
    internal fun requestAgentExport(args: JSONObject, exportHandler: ((JSONObject) -> Unit)?) {
        val jobId = args.optString("requestId").takeIf { it.matches(Regex("^[a-zA-Z0-9_-]{1,96}$")) } ?: error("Invalid export job id")
        check(args.optString("expectedRevision").matches(Regex("^[a-fA-F0-9]{64}$"))) { "Export requires the current document revision" }
        if (agentExportJobs.size >= 128) {
            agentExportJobs.entries.filter { it.value.optString("phase") in setOf("completed", "failed", "cancelled") }.take(64).forEach {
                if (agentExportJobs.remove(it.key, it.value)) agentExportArtifacts.remove(it.key)
            }
        }
        check(agentExportJobs.size < 128) { "Too many export jobs are being tracked; retry after checking earlier jobs" }
        check(agentExportJobs.putIfAbsent(jobId, JSONObject().put("jobId", jobId).put("phase", "awaiting_destination")) == null) { "That export job id has already been used" }
        val handler = exportHandler ?: run { agentExportJobs.remove(jobId); error("The Android export picker is unavailable") }
        handler(args)
    }
    internal fun updateAgentExportJob(jobId: String, phase: String, error: String? = null) {
        if (jobId.isNotBlank()) agentExportJobs[jobId] = JSONObject().put("jobId", jobId).put("phase", phase).apply { if (error != null) put("error", error.take(2048)) }
    }
    internal fun agentExportJob(jobId: String): JSONObject? = agentExportJobs[jobId]?.let { JSONObject(it.toString()) }
    internal suspend fun completeAgentExport(jobId: String, uri: Uri, fallbackName: String, format: String) = withContext(Dispatchers.IO) {
        require(agentExportJobs[jobId]?.optString("phase") in setOf("preparing", "saving")) { "This export job is not active in this app" }
        require(format in setOf("pdf", "smd", "md", "mdzip")) { "Unsupported export format" }
        val (bytes, digest) = fingerprintAgentExport(uri)
        require(bytes > 0 || format == "md") { "The completed PDF or portable export is empty" }
        require(bytes <= MAX_AGENT_EXPORT_BYTES) { "Agent downloads are limited to 128 MiB per export" }
        val queriedName = runCatching {
            activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) cursor.getString(0) else null
            }
        }.getOrNull()
        val rawName = queriedName?.takeIf { it.isNotBlank() } ?: fallbackName
        val filename = rawName.substringAfterLast('/').substringAfterLast('\\')
            .replace(Regex("[\\u0000-\\u001f\\u007f]"), "").take(256)
        require(filename.isNotBlank()) { "Android did not provide a valid export filename" }
        val mimeType = when (format) { "pdf" -> "application/pdf"; "smd" -> "application/vnd.supermd.smd"; "mdzip" -> "application/zip"; else -> "text/markdown" }
        val artifact = AgentExportArtifact(uri, filename, format, mimeType, bytes, digest, System.currentTimeMillis())
        agentExportArtifacts[jobId] = artifact
        agentExportJobs[jobId] = JSONObject().put("jobId", jobId).put("status", "completed").put("phase", "completed")
            .put("filename", filename).put("format", format).put("mimeType", mimeType).put("bytes", bytes)
            .put("sha256", digest).put("downloadable", true)
    }
    internal suspend fun readAgentExportChunk(jobId: String, offset: Long, limit: Int): JSONObject = withContext(Dispatchers.IO) {
        require(offset >= 0) { "Export chunk offset must be non-negative" }
        require(limit in 1..524_288) { "Export chunk limit must be between 1 and 524288 bytes" }
        require(agentExportJobs[jobId]?.optString("phase") == "completed") { "Only a completed export from this app can be downloaded" }
        val artifact = agentExportArtifacts[jobId] ?: error("This export artifact is unavailable in this app session")
        require(System.currentTimeMillis() - artifact.createdAtMillis <= AGENT_EXPORT_LEASE_MILLIS) { "The export download has expired; create a new export" }
        require(offset <= artifact.bytes) { "Export chunk offset is beyond the end of the file" }
        val remaining = artifact.bytes - offset
        val size = minOf(limit.toLong(), remaining).toInt()
        val body = ByteArray(size)
        activity.contentResolver.openInputStream(artifact.uri)?.use { input ->
            var skipped = 0L
            while (skipped < offset) {
                val amount = input.skip(offset - skipped)
                if (amount > 0) skipped += amount else {
                    if (input.read() < 0) error("The completed export ended before the requested offset")
                    skipped += 1
                }
            }
            var read = 0
            while (read < size) {
                val amount = input.read(body, read, size - read)
                if (amount < 0) error("The completed export changed while reading a chunk")
                read += amount
            }
        } ?: error("Android cannot open the completed export")
        val next = offset + size
        JSONObject().put("jobId", jobId).put("filename", artifact.filename).put("format", artifact.format)
            .put("mimeType", artifact.mimeType).put("bytes", artifact.bytes).put("sha256", artifact.sha256)
            .put("offset", offset).put("nextOffset", if (next < artifact.bytes) next else JSONObject.NULL)
            .put("body", Base64.encodeToString(body, Base64.NO_WRAP))
    }
    private fun fingerprintAgentExport(uri: Uri): Pair<Long, String> {
        val digest = MessageDigest.getInstance("SHA-256")
        var bytes = 0L
        activity.contentResolver.openInputStream(uri)?.use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                bytes = Math.addExact(bytes, count.toLong())
                digest.update(buffer, 0, count)
            }
        } ?: error("Android cannot open the completed export")
        return bytes to digest.digest().joinToString("") { "%02x".format(it) }
    }
    internal fun revokeAgentAccess(completion: (serverRevoked: Boolean) -> Unit) {
        val configs = activity.agentAccessState.allConfigs()
        activity.agentAccessState.setEnabled(false)
        activity.syncAgentAccessUiState()
        disconnectRelayNow()
        if (configs.isEmpty()) { activity.agentAccessState.revoke(); activity.syncAgentAccessUiState(); completion(true); return }
        val remaining = AtomicInteger(configs.size)
        val allRevoked = AtomicBoolean(true)
        configs.forEach { config -> agentRelayClient.revokeDevice(config) { revoked ->
            if (!revoked) allRevoked.set(false)
            if (remaining.decrementAndGet() == 0) {
                activity.agentAccessState.revoke()
                activity.syncAgentAccessUiState()
                clearPendingAgentReplies()
                completion(allRevoked.get())
            }
        } }
    }
    internal fun deliverAgentReply(requestId: String, result: Any?, error: String?) {
        pendingAgentReplyTimeouts.remove(requestId)?.let(agentMainHandler::removeCallbacks)
        pendingAgentReplies.remove(requestId)?.invoke(result, error)
    }
    internal fun captureAgentReply(requestId: String, callback: (Any?, String?) -> Unit) {
        pendingAgentReplyTimeouts.remove(requestId)?.let(agentMainHandler::removeCallbacks)
        pendingAgentReplies[requestId] = callback
        val timeout = Runnable {
            pendingAgentReplyTimeouts.remove(requestId)
            pendingAgentReplies.remove(requestId)?.invoke(null, "The live reader did not finish this request before its deadline")
        }
        pendingAgentReplyTimeouts[requestId] = timeout
        agentMainHandler.postDelayed(timeout, 18_000)
    }
    private fun clearPendingAgentReplies() {
        pendingAgentReplies.clear()
        pendingAgentReplyTimeouts.values.forEach(agentMainHandler::removeCallbacks)
        pendingAgentReplyTimeouts.clear()
    }
    internal fun dispatchAgentRequest(web: WebView, request: JSONObject, reply: (Any?, String?) -> Unit) {
        val requestId = request.optString("requestId")
        if (requestId.isBlank() || requestId.length > 96) { reply(null, "Invalid request id"); return }
        val payload = JSONObject(request.toString()).apply { remove("deviceId") }
        captureAgentReply(requestId, reply)
        val script = "window.supermdAgentRequest?.($payload,(result,error)=>window.SuperMD?.agentReply?.(${JSONObject.quote(requestId)},JSON.stringify(result??null),String(error||'')));true"
        web.evaluateJavascript(script, null)
    }
    internal fun dispatchAgentCompute(web: WebView, request: JSONObject, reply: (Any?, String?) -> Unit) {
        val requestId = request.optString("requestId")
        if (requestId.isBlank() || requestId.length > 96) { reply(null, "Invalid request id"); return }
        captureAgentReply(requestId, reply)
        val payload = JSONObject(request.toString())
        val callback = "(result,error)=>window.SuperMD?.agentReply?.(${JSONObject.quote(requestId)},JSON.stringify(result??null),String(error||''))"
        val script = "if(window.supermdAgentCompute)window.supermdAgentCompute($payload,$callback);else window.SuperMD?.agentReply?.(${JSONObject.quote(requestId)},'null','The native document computation helper is unavailable');true"
        web.evaluateJavascript(script, null)
    }
    internal fun agentRevision(value: String): String = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    internal fun agentSourceLength(value: String): Int = value.codePointCount(0, value.length)
    internal suspend fun captureAgentViewport(reader: WebView, requestedWidth: Int, imageFormat: String = "png", model: StudioViewModel): JSONObject {
        require(imageFormat in setOf("png", "jpeg")) { "Unsupported viewport image format" }
        check(reader.width > 0 && reader.height > 0 && reader.isAttachedToWindow) { "The live reading viewport is unavailable" }
        val context = suspendCancellableCoroutine<JSONObject> { continuation ->
            val requestId = "snapshot_context_${UUID.randomUUID()}"
            val request = JSONObject().put("requestId", requestId).put("action", "get_context")
            dispatchAgentRequest(reader, request) { result, error ->
                if (!continuation.isActive) return@dispatchAgentRequest
                val value = result as? JSONObject
                if (error != null) continuation.resumeWith(Result.failure(IllegalStateException(error)))
                else if (value == null) continuation.resumeWith(Result.failure(IllegalStateException("The reader returned no snapshot context")))
                else continuation.resume(value)
            }
            continuation.invokeOnCancellation {
                pendingAgentReplyTimeouts.remove(requestId)?.let(agentMainHandler::removeCallbacks)
                pendingAgentReplies.remove(requestId)
            }
        }
        val origin = IntArray(2)
        reader.getLocationInWindow(origin)
        val source = Rect(origin[0], origin[1], origin[0] + reader.width, origin[1] + reader.height)
        val targetWidth = requestedWidth.coerceIn(320, 1600).coerceAtMost(source.width())
        val targetHeight = (source.height().toDouble() * targetWidth / source.width()).toInt().coerceAtLeast(1)
        val bitmap = Bitmap.createBitmap(targetWidth, targetHeight, Bitmap.Config.ARGB_8888)
        val status = suspendCancellableCoroutine<Int> { continuation ->
            PixelCopy.request(activity.window, source, bitmap, { result ->
                if (continuation.isActive) continuation.resume(result)
            }, Handler(Looper.getMainLooper()))
            continuation.invokeOnCancellation { bitmap.recycle() }
        }
        check(status == PixelCopy.SUCCESS) { "Android could not capture the reading viewport (PixelCopy status $status)" }
        var encoded: ByteArray
        var finalBitmap = bitmap
        try {
            while (true) {
                val output = ByteArrayOutputStream()
                val format = if (imageFormat == "jpeg") Bitmap.CompressFormat.JPEG else Bitmap.CompressFormat.PNG
                val quality = if (imageFormat == "jpeg") 90 else 100
                check(finalBitmap.compress(format, quality, output)) { "Could not encode the viewport image" }
                encoded = output.toByteArray()
                if (encoded.size <= 3_500_000 || finalBitmap.width <= 480) break
                val next = Bitmap.createScaledBitmap(finalBitmap, (finalBitmap.width * .8f).toInt().coerceAtLeast(1), (finalBitmap.height * .8f).toInt().coerceAtLeast(1), true)
                if (next !== finalBitmap && finalBitmap !== bitmap) finalBitmap.recycle()
                finalBitmap = next
            }
            check(encoded.size <= 3_500_000) { "The reading viewport image exceeds the safe transfer limit" }
            val note = model.state.value.active
            val revision = context.optString("revision", agentRevision(note.content))
            val mimeType = if (imageFormat == "jpeg") "image/jpeg" else "image/png"
            return JSONObject().put("mime_type", mimeType).put("data", Base64.encodeToString(encoded, Base64.NO_WRAP))
                .put("width", finalBitmap.width).put("height", finalBitmap.height).put("revision", revision)
                .put("metadata", JSONObject().put("tabId", context.optString("tabId", "tab:${agentConfigForThisWindow()?.deviceId ?: "local"}:${activity.agentWorkspaceKey}:${note.id}"))
                    .put("mode", context.optString("mode", model.state.value.mode)).put("zoom", context.optDouble("zoom", model.state.value.zoom.toDouble()))
                    .put("reading", context.optJSONObject("reading") ?: JSONObject()).put("selection", context.optJSONObject("selection") ?: JSONObject()))
        } finally { if (finalBitmap !== bitmap) finalBitmap.recycle(); bitmap.recycle() }
    }
    internal fun refreshAgentRelay(
        currentRelayState: AgentRelayClient.State,
        currentRelayRetrying: Boolean,
        uiHandlerProvider: () -> ((JSONObject, (Any?, String?) -> Unit) -> Boolean)?,
        bridgeHandlerProvider: () -> ((JSONObject, (Any?, String?) -> Unit) -> Unit)?,
    ) {
        activity.syncAgentAccessUiState()
        if (!activity.agentAccessState.enabled) {
            disconnectRelayNow(); return
        }
        val config = agentConfigForThisWindow()
        if (config == null) { disconnectRelayNow(); return }
        val identity = "${config.groupId}:${config.deviceId}"
        if (identity == relayIdentity && (currentRelayState != AgentRelayClient.State.DISCONNECTED || currentRelayRetrying)) return
        relayIdentity = identity
        agentRelayClient.connect(config) { request, reply ->
            val ui = uiHandlerProvider()
            if (ui?.invoke(request, reply) != true) {
                val bridge = bridgeHandlerProvider()
                if (bridge == null) reply(null, "The live reader is not ready. Keep Super MD open on a note and retry.")
                else bridge(request, reply)
            }
        }
    }
}

@Composable internal fun BindAgentExportHandler(activity: MainActivity, model: StudioViewModel, activeNoteName: String, pdfOptionsJson: String) {
    val scope = rememberCoroutineScope()
    var pendingAgentExport by remember { mutableStateOf<JSONObject?>(null) }
    DisposableEffect(activity, model, activeNoteName, pdfOptionsJson) {
        activity.setAgentExportHandler { args ->
            check(pendingAgentExport == null) { "Finish the current export before starting another" }
            val safeArgs = JSONObject(args.toString())
            pendingAgentExport = safeArgs
            val jobId = args.optString("requestId")
            val format = args.optString("format", "pdf")
            check(format in setOf("pdf", "smd", "md", "mdzip")) { "Unsupported export format" }
            val requestedName = args.optString("filename").takeIf { it.isNotBlank() }
                ?: args.optString("id").takeIf { it.isNotBlank() } ?: noteStem(activeNoteName).ifBlank { "Untitled" }
            activity.updateAgentExportJob(jobId, "preparing")
            model.busy(true)
            scope.launch {
                try {
                    val pdfOptions = JSONObject(pdfOptionsJson)
                    val provided = safeArgs.optJSONObject("options") ?: JSONObject()
                    val archive = format == "mdzip" || (format == "md" && (safeArgs.optBoolean("archive", false) || provided.optBoolean("archive", false)))
                    val effectiveFormat = if (archive) "mdzip" else format
                    listOf("pageSize", "margin", "fontSize", "lineHeight", "paragraphSpacing", "fontFamily", "pageNumbers", "themed")
                        .forEach { key -> if (provided.has(key)) pdfOptions.put(key, provided.get(key)) }
                    val (uri, filename) = model.writeAgentExport(
                        safeArgs.getString("content"), safeArgs.optJSONObject("assets") ?: JSONObject(),
                        effectiveFormat, requestedName, pdfOptions.toString(), archive = archive,
                    )
                    activity.completeAgentExport(jobId, uri, filename, effectiveFormat)
                    model.busy(false)
                } catch (error: Exception) {
                    activity.updateAgentExportJob(jobId, "failed", error.message ?: "Export failed")
                    model.fail("Agent export failed: ${error.message}")
                } finally { pendingAgentExport = null }
            }
        }
        onDispose { activity.setAgentExportHandler(null) }
    }
}
