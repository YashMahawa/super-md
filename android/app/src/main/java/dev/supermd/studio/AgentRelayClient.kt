package dev.supermd.studio

import android.os.Handler
import android.os.Looper
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONObject
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import kotlin.math.min
import kotlin.random.Random

/** Outbound-only WebSocket bridge from this app instance to the Super MD relay. */
class AgentRelayClient(
    private val onState: (State) -> Unit = {},
    private val onRetrying: (Boolean) -> Unit = {},
    callFactory: okhttp3.Call.Factory? = null,
    webSocketFactory: WebSocket.Factory? = null,
) {
    constructor(onState: (State) -> Unit) : this(onState, {}, null, null)

    enum class State { DISCONNECTED, CONNECTING, CONNECTED }

    private class SocketSession(val sessionId: Long, val config: AgentAccessConfig, val handler: (JSONObject, (Any?, String?) -> Unit) -> Unit) {
        @Volatile var socket: WebSocket? = null; @Volatile var closing = false; val activeRequests = linkedSetOf<String>()
    }

    private val main = Handler(Looper.getMainLooper())
    internal var client = OkHttpClient.Builder().connectTimeout(12, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS).pingInterval(25, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true).build()
    private val customCallFactory: okhttp3.Call.Factory? = callFactory
    internal var webSocketFactory: WebSocket.Factory = webSocketFactory ?: client
    private fun activeCallFactory(): okhttp3.Call.Factory = customCallFactory ?: client
    @Volatile private var stopped = true
    @Volatile private var sessionId = 0L
    @Volatile private var activeSocket: SocketSession? = null
    @Volatile private var state = State.DISCONNECTED
    @Volatile private var retrying = false
    private var config: AgentAccessConfig? = null
    private var handler: ((JSONObject, (Any?, String?) -> Unit) -> Unit)? = null
    private var retryAttempt = 0

    /** Starts/reconnects the relay connection. The callback is always dispatched on the main thread. */
    @Synchronized fun connect(config: AgentAccessConfig, handler: (request: JSONObject, reply: (result: Any?, error: String?) -> Unit) -> Unit) {
        disconnect()
        require(config.serverOrigin.startsWith("https://")) { "Live Agent relay requires HTTPS" }
        val nextSession = ++sessionId; this.config = config; this.handler = handler
        stopped = false; retryAttempt = 0; enroll(nextSession, config)
    }

    @Synchronized fun disconnect() {
        sessionId += 1; stopped = true; main.removeCallbacksAndMessages(RETRY_TOKEN)
        activeSocket?.let { prev ->
            activeSocket = null
            synchronized(prev.activeRequests) { prev.activeRequests.clear() }
            if (!prev.closing) prev.socket?.close(1000, "Live Agent access disabled")
        }
        setRetrying(false)
        setState(State.DISCONNECTED)
    }

    fun currentState(): State = state
    fun isRetrying(): Boolean = retrying

    /** Best-effort removal of a device registration; pairing credentials remain local until caller erases them. */
    fun revokeDevice(config: AgentAccessConfig, completion: (Boolean) -> Unit) {
        val body = JSONObject().put("groupId", config.groupId).put("pairingKey", config.pairingKey)
            .put("deviceId", config.deviceId).toString().toRequestBody(JSON_MEDIA_TYPE)
        val request = Request.Builder().url(config.serverOrigin.trimEnd('/') + "/device/revoke").post(body).build()
        activeCallFactory().newCall(request).apply { timeout().timeout(15, TimeUnit.SECONDS) }.enqueue(object : okhttp3.Callback {
            override fun onFailure(call: okhttp3.Call, e: java.io.IOException) { main.post { completion(false) } }
            override fun onResponse(call: okhttp3.Call, response: Response) { response.use { val success = it.isSuccessful; main.post { completion(success) } } }
        })
    }

    /** Pairing keys travel only in this TLS registration request, never to MCP clients. */
    private fun enroll(expectedSession: Long, current: AgentAccessConfig) {
        synchronized(this) { if (!ownsSession(expectedSession) || config !== current || activeSocket != null) return; setState(State.CONNECTING) }
        val body = JSONObject().put("groupId", current.groupId).put("deviceId", current.deviceId)
            .put("deviceKey", current.deviceKey).put("displayName", current.displayName)
            .put("platform", current.platform).put("pairingKey", current.pairingKey)
            .put("connectorKey", current.connectorKey)
            .toString().toRequestBody(JSON_MEDIA_TYPE)
        val request = Request.Builder().url(current.serverOrigin.trimEnd('/') + "/device/enroll")
            .post(body).build()
        activeCallFactory().newCall(request).apply { timeout().timeout(15, TimeUnit.SECONDS) }.enqueue(object : okhttp3.Callback {
            override fun onFailure(call: okhttp3.Call, e: java.io.IOException) = onEnrollFailed(expectedSession, current)
            override fun onResponse(call: okhttp3.Call, response: Response) {
                response.use {
                    if (!it.isSuccessful) { onEnrollFailed(expectedSession, current); return }
                    val returnedGroup = runCatching {
                        val stream = it.body?.byteStream() ?: error("Empty enrollment response")
                        val bytes = stream.use { body ->
                            val output = java.io.ByteArrayOutputStream()
                            val buffer = ByteArray(1024)
                            while (true) {
                                val count = body.read(buffer)
                                if (count < 0) break
                                require(output.size() + count <= 8 * 1024) { "Enrollment response is too large" }
                                output.write(buffer, 0, count)
                            }
                            output.toByteArray()
                        }
                        require(bytes.size <= 8 * 1024) { "Enrollment response is too large" }
                        JSONObject(bytes.toString(Charsets.UTF_8)).getString("groupId")
                    }.getOrNull()
                    if (returnedGroup != current.groupId) { onEnrollFailed(expectedSession, current); return }
                }
                openSocket(expectedSession, current)
            }
        })
    }

    private fun ownsSession(expectedSession: Long): Boolean = !stopped && sessionId == expectedSession
    private fun ownsSocket(slot: SocketSession, ws: WebSocket): Boolean {
        if (slot.socket == null) slot.socket = ws
        return !stopped && !slot.closing && sessionId == slot.sessionId && activeSocket === slot && slot.socket === ws
    }
    private fun closeSocket(slot: SocketSession, ws: WebSocket, code: Int, reason: String) { slot.closing = true; ws.close(code, reason) }
    @Synchronized private fun onEnrollFailed(expectedSession: Long, current: AgentAccessConfig) { if (ownsSession(expectedSession) && config === current && activeSocket == null) scheduleReconnect(expectedSession) }
    @Synchronized private fun onSocketTerminated(slot: SocketSession, ws: WebSocket) {
        synchronized(slot.activeRequests) { slot.activeRequests.clear() }
        if (activeSocket !== slot || (slot.socket != null && slot.socket !== ws)) return
        activeSocket = null; if (ownsSession(slot.sessionId)) scheduleReconnect(slot.sessionId)
    }

    @Synchronized private fun openSocket(expectedSession: Long, current: AgentAccessConfig) {
        val currentHandler = handler ?: return
        if (!ownsSession(expectedSession) || config !== current || activeSocket != null) return
        val slot = SocketSession(expectedSession, current, currentHandler)
        activeSocket = slot
        val created = webSocketFactory.newWebSocket(authenticatedWebSocketRequest(current), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) { if (!ownsSocket(slot, webSocket)) webSocket.close(1000, "Disabled") }
            override fun onMessage(webSocket: WebSocket, text: String) {
                if (!ownsSocket(slot, webSocket)) return
                if (text.toByteArray(Charsets.UTF_8).size > MAX_MESSAGE_BYTES) { closeSocket(slot, webSocket, 1008, "Invalid relay frame"); return }
                try {
                    val message = JSONObject(text)
                    when (message.optString("type")) {
                        "registered" -> synchronized(this@AgentRelayClient) {
                            require(message.getString("groupId") == slot.config.groupId && message.getString("deviceId") == slot.config.deviceId)
                            if (ownsSocket(slot, webSocket)) {
                                retryAttempt = 0
                                setRetrying(false)
                                setState(State.CONNECTED)
                            }
                        }
                        "request" -> acceptRequest(slot, webSocket, message)
                        else -> throw IllegalArgumentException("Unexpected relay frame")
                    }
                } catch (_: Exception) { if (ownsSocket(slot, webSocket)) closeSocket(slot, webSocket, 1008, "Invalid relay request") }
            }
            override fun onMessage(webSocket: WebSocket, bytes: ByteString) { if (ownsSocket(slot, webSocket)) closeSocket(slot, webSocket, 1003, "Text frames only") }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = onSocketTerminated(slot, webSocket)
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = onSocketTerminated(slot, webSocket)
        })
        slot.socket = created
        if (!ownsSocket(slot, created) && !slot.closing) closeSocket(slot, created, 1000, "Disabled")
    }

    internal fun authenticatedWebSocketRequest(current: AgentAccessConfig): Request {
        val endpoint = current.serverOrigin.replaceFirst("https://", "wss://") +
            "/device?groupId=${current.groupId}&deviceId=${current.deviceId}"
        return Request.Builder().url(endpoint)
            .header("Authorization", "Bearer ${current.deviceKey}")
            .header("X-SuperMD-Connector-Hash", sha256(current.connectorKey))
            .header("X-SuperMD-Display-Name", current.displayName.take(80))
            .header("X-SuperMD-Platform", current.platform)
            .header("X-SuperMD-Preview-Formats", "png,jpeg")
            .build()
    }

    private fun acceptRequest(slot: SocketSession, socket: WebSocket, message: JSONObject) {
        if (!ownsSocket(slot, socket)) return
        val requestId = message.optString("requestId")
        require(REQUEST_ID.matches(requestId)) { "Invalid request id" }
        require(message.length() <= 16) { "Too many RPC fields" }
        require(message.optString("action") in ACTIONS) { "Action is not supported" }
        require(message.optString("deviceId") == slot.config.deviceId) { "Request is routed to a different device" }
        synchronized(slot.activeRequests) {
            require(slot.activeRequests.size < MAX_ACTIVE_REQUESTS) { "Too many app requests are active" }
            require(slot.activeRequests.add(requestId)) { "Duplicate request id" }
        }
        val request = try {
            JSONObject(message.toString()).apply { remove("type"); remove("deviceId") }.also(::validateRequest)
        } catch (error: Exception) { finish(slot, socket, requestId, null, error.message ?: "Invalid request"); return }
        main.post {
            if (!ownsSocket(slot, socket)) return@post
            val completed = java.util.concurrent.atomic.AtomicBoolean(false)
            try { slot.handler(request) { result, error -> if (completed.compareAndSet(false, true)) finish(slot, socket, requestId, result, error) } }
            catch (error: Exception) { if (completed.compareAndSet(false, true)) finish(slot, socket, requestId, null, error.message ?: "The app request failed") }
        }
    }

    private fun normalizeDocumentOptions(request: JSONObject) {
        if (request.optString("action") != "document_action") return
        val action = request.optString("documentAction")
        if (action == "export_chunk") {
            val options = request.optJSONObject("options") ?: return
            if (!request.has("jobId") && options.has("jobId")) request.put("jobId", options.get("jobId"))
            return
        }
        if (action !in setOf("create", "save", "export")) return
        val options = request.optJSONObject("options") ?: return
        listOf("filename", "format").forEach { key -> if (!request.has(key) && options.has(key)) request.put(key, options.get(key)) }
        if (!request.has("titleHint")) {
            val title = when {
                options.has("titleHint") -> options.get("titleHint")
                options.has("title") -> options.get("title")
                else -> null
            }
            if (title != null) request.put("titleHint", title)
        }
    }

    internal fun validateRequest(request: JSONObject) {
        normalizeDocumentOptions(request)
        val keys = request.keys().asSequence().toSet()
        require(keys.all { it in RPC_FIELDS }) { "Unknown RPC field" }
        require(REQUEST_ID.matches(request.optString("requestId"))) { "Invalid request id" }
        val action = request.getString("action")
        if (request.has("imageFormat")) {
            require(action in setOf("render_tab", "get_diagram_image")) { "imageFormat is only supported for viewport or diagram images" }
            require(request.getString("imageFormat") in setOf("png", "jpeg")) { "Invalid imageFormat" }
        }
        if (action in TAB_ACTIONS) require(request.optString("tabId").isNotBlank() && request.optString("tabId").length <= 512) { "tabId is required" }
        if (action in setOf("outline_tab", "latex_review", "latex_apply", "get_context")) require(request.optString("tabId").isNotBlank()) { "tabId is required" }
        if (action in setOf("list_diagrams", "get_diagram", "get_diagram_image", "replace_tab_asset", "asset_action")) require(request.optString("tabId").isNotBlank()) { "tabId is required" }
        if (action in setOf("get_diagram", "get_diagram_image", "replace_tab_asset", "asset_action")) require(REVISION.matches(request.optString("expectedRevision"))) { "A current document revision is required" }
        if (action in setOf("get_diagram", "get_diagram_image")) require(request.optString("diagramId").let { it.startsWith("diagram:") && it.length in 9..128 }) { "A listed diagramId is required" }
        if (action == "replace_tab_asset") {
            require(request.optString("assetName").isNotBlank() && request.optString("assetPath").isNotBlank()) { "Asset replacement requires assetName and assetPath" }
            require(request.get("assetPath") is String) { "Invalid assetPath" }
            val assetPath = request.getString("assetPath")
            require(assetPath.toByteArray(Charsets.UTF_8).size <= 4096 && !assetPath.contains('\u0000')) { "Invalid assetPath" }
        }
        if (action == "asset_action") {
            val kind = request.optString("assetAction")
            require(kind in setOf("list", "source", "attach")) { "Invalid assetAction" }
            if (kind == "source") require(request.optString("assetName").isNotBlank()) { "assetName is required" }
            if (kind == "list") {
                require(request.optInt("offset", 0) in 0..512) { "Invalid asset offset" }
                require(request.optInt("limit", 50) in 1..50) { "Invalid asset limit" }
            }
            if (kind == "attach") {
                require(request.optString("assetName").isNotBlank()) { "assetName is required" }
                require(request.optString("mimeType") in ASSET_MIMES) { "Unsupported image type" }
                val body = request.optString("body")
                require(body.isNotEmpty() && body.length <= MAX_ASSET_BASE64 && body.length % 4 == 0) { "Asset body must be at most 1 MiB of base64" }
                val bytes = android.util.Base64.decode(body, android.util.Base64.DEFAULT)
                require(bytes.size in 1..MAX_ASSET_BYTES && android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP) == body) { "Asset body must be canonical base64 and at most 1 MiB" }
                require(isValidPortableAssetNameOrKey(request.getString("assetName"))) { "Invalid assetName" }
            }
        }
        if (action == "document_action") {
            require(request.optString("documentAction") in DOCUMENT_ACTIONS) { "Invalid document action" }
            val docAction = request.getString("documentAction")
            if (docAction in TAB_DOCUMENT_ACTIONS && docAction != "job_status") require(request.optString("tabId").isNotBlank()) { "tabId is required for this action" }
            if (docAction in setOf("job_status", "export_chunk")) require(request.optString("jobId").matches(REQUEST_ID)) { "A valid jobId is required for this action" }
            if (docAction in REVISIONED_DOCUMENT_ACTIONS || (docAction == "latexfix" && request.optJSONObject("options")?.has("repairIndices") == true))
                require(REVISION.matches(request.optString("expectedRevision"))) { "A current document revision is required" }
            if (docAction == "save" && request.optJSONObject("options")?.optBoolean("saveAs", false) == true)
                require(request.optString("filename").isNotBlank()) { "Save As requires an explicit filename" }
            if (docAction == "create" && request.has("format")) require(request.getString("format") in setOf("md", "smd")) { "Create format must be md or smd" }
            if (docAction == "save" && request.has("format")) require(request.getString("format") in setOf("md", "smd")) { "Save format must be md or smd" }
            if (docAction == "export_chunk") {
                require(!request.has("offset") || request.getLong("offset") >= 0L) { "Export chunk offset must be a non-negative byte position" }
                require(!request.has("limit") || request.getInt("limit") in 1..MAX_EXPORT_CHUNK_BYTES) { "Export chunk limit must be 1–524288 bytes" }
            }
            if (docAction == "latex_apply") require(request.has("repairIndices") || request.optJSONObject("options")?.has("repairIndices") == true) { "latex_apply requires reviewed repair indices" }
        }
        if (action in setOf("patch_tab", "latex_apply")) require(REVISION.matches(request.optString("expectedRevision"))) { "A current document revision is required" }
        if (action == "latex_apply") require(request.has("repairIndices")) { "latex_apply requires reviewed repair indices" }
        if (action == "patch_tab") {
            require(request.has("expectedRevision") && request.has("operations")) { "A patch needs an expected revision and operations" }
        }
        request.optString("expectedRevision").takeIf { request.has("expectedRevision") }?.let { require(REVISION.matches(it)) { "Invalid content revision" } }
        if (request.has("operations")) {
            val operations = request.getJSONArray("operations")
            require(operations.length() <= 100 && operations.toString().toByteArray(Charsets.UTF_8).size <= MAX_TEXT_BYTES) { "Patch is too large" }
        }
        if (request.has("content")) require(request.getString("content").toByteArray(Charsets.UTF_8).size <= MAX_TEXT_BYTES) { "Document content is too large" }
        if (request.has("options")) require(request.getJSONObject("options").toString().toByteArray(Charsets.UTF_8).size <= 16 * 1024) { "Document options are too large" }
        if (request.has("view")) require(request.getString("view") in setOf("source", "prose")) { "Invalid document view" }
        if (request.has("diagramId")) require(request.get("diagramId") is String && request.getString("diagramId").let { it.startsWith("diagram:") && it.length in 9..128 }) { "Invalid diagram id" }
        if (request.has("jobId")) require(request.get("jobId") is String && request.getString("jobId").length in 1..128) { "Invalid job id" }
        if (request.has("format")) require(request.get("format") is String && request.getString("format") in setOf("pdf", "smd", "md", "mdzip")) { "Invalid export format" }
        if (request.has("repairIndices")) {
            val indices = request.getJSONArray("repairIndices")
            val values = (0 until indices.length()).map { indices.optInt(it, -1) }
            require(values.size in 1..40 && values.all { it >= 0 } && values.distinct().size == values.size) { "Invalid repair indices" }
        }
        request.optJSONObject("options")?.takeIf { it.has("repairIndices") }?.let { options ->
            val indices = options.getJSONArray("repairIndices")
            val values = (0 until indices.length()).map { indices.optInt(it, -1) }
            require(values.size in 1..40 && values.all { it >= 0 } && values.distinct().size == values.size) { "Invalid repair indices" }
        }
        if (request.has("assetName")) {
            require(request.get("assetName") is String) { "Invalid assetName" }
            val assetName = request.getString("assetName")
            require(assetName.toByteArray(Charsets.UTF_8).size <= 256 && (REVISION.matches(assetName) || isValidCompatPortableAssetNameOrKey(assetName))) { "Invalid assetName" }
        }
        if (request.has("filename")) require(request.get("filename") is String && request.getString("filename").length <= 256 && !request.getString("filename").contains('/') && !request.getString("filename").contains('\\')) { "Invalid filename" }
        if (request.has("titleHint")) require(request.get("titleHint") is String && request.getString("titleHint").length <= 200 && !request.getString("titleHint").contains('\u0000')) { "Invalid titleHint" }
        if (request.has("format")) require(request.get("format") is String) { "Invalid format" }
        if (request.has("query")) require(request.getString("query").length in 1..2048) { "Invalid query" }
        if (action == "search_tab") require(request.optString("query").length in 1..500) { "Search query must contain 1–500 characters" }
        if (action == "search_tab" && request.has("limit")) require(request.getInt("limit") in 1..25) { "Search limit must be 1–25" }
        if (request.has("caseSensitive")) require(request.get("caseSensitive") is Boolean) { "caseSensitive must be a boolean" }
        if (request.has("wholeWord")) require(request.get("wholeWord") is Boolean) { "wholeWord must be a boolean" }
        if (request.has("regex")) require(request.get("regex") is Boolean) { "regex must be a boolean" }
        if (request.has("excludeDiagrams")) require(request.get("excludeDiagrams") is Boolean) { "excludeDiagrams must be a boolean" }
        if (request.has("options")) {
            val options = request.getJSONObject("options")
            options.keys().forEach { key ->
                if (key in BOOLEAN_OPTIONS) require(options.get(key) is Boolean) { "$key must be a boolean" }
            }
        }
        listOf("context" to 500, "width" to 1600).forEach { (field, max) ->
            if (request.has(field)) require(request.getInt(field) in 0..max) { "Invalid $field" }
        }
        if (request.has("offset") && !(action == "document_action" && request.optString("documentAction") == "export_chunk")) require(request.getInt("offset") in 0..20_000_000) { "Invalid offset" }
        if (request.has("limit") && !(action == "document_action" && request.optString("documentAction") == "export_chunk")) require(request.getInt("limit") in 0..12_000) { "Invalid limit" }
        if (request.has("width")) require(request.getInt("width") >= 1) { "Invalid width" }
    }

    private fun finish(slot: SocketSession, socket: WebSocket, requestId: String, result: Any?, error: String?) {
        if (!ownsSocket(slot, socket)) return
        val removed = synchronized(slot.activeRequests) { slot.activeRequests.remove(requestId) }
        if (!removed || !ownsSocket(slot, socket) || socket.queueSize() > MAX_MESSAGE_BYTES) return
        val reply = JSONObject().put("type", "reply").put("requestId", requestId)
        if (error != null) reply.put("error", error.take(MAX_ERROR_LENGTH)) else if (result != null) reply.put("result", result)
        val encoded = reply.toString()
        if (encoded.toByteArray(Charsets.UTF_8).size <= MAX_MESSAGE_BYTES) socket.send(encoded)
    }

    @Synchronized private fun scheduleReconnect(expectedSession: Long) {
        val current = config ?: return
        if (!ownsSession(expectedSession)) return
        setRetrying(true)
        setState(State.DISCONNECTED)
        val base = min(60_000L, 1_000L shl retryAttempt.coerceAtMost(6))
        retryAttempt += 1
        val delay = (base * Random.nextDouble(0.75, 1.25)).toLong()
        main.removeCallbacksAndMessages(RETRY_TOKEN)
        main.postAtTime({ enroll(expectedSession, current) }, RETRY_TOKEN, android.os.SystemClock.uptimeMillis() + delay)
    }

    private fun setRetrying(value: Boolean) {
        retrying = value
        val targetSession = sessionId
        if (Looper.myLooper() == Looper.getMainLooper()) onRetrying(value) else main.post { if (sessionId == targetSession) onRetrying(value) }
    }

    private fun setState(value: State) {
        state = value
        val targetSession = sessionId
        if (Looper.myLooper() == Looper.getMainLooper()) onState(value) else main.post { if (sessionId == targetSession) onState(value) }
    }
    private fun sha256(value: String): String = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    private companion object {
        val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
        const val MAX_MESSAGE_BYTES = 5 * 1024 * 1024
        const val MAX_TEXT_BYTES = 64 * 1024
        const val MAX_ACTIVE_REQUESTS = 8
        const val MAX_ERROR_LENGTH = 2048
        val RETRY_TOKEN = Any()
        val REQUEST_ID = Regex("^[a-zA-Z0-9_-]{1,96}$")
        val REVISION = Regex("^[a-f0-9]{64}$", RegexOption.IGNORE_CASE)
        val ACTIONS = setOf("list_tabs", "read_tab", "search_tab", "patch_tab", "render_tab", "list_diagrams", "get_diagram", "get_diagram_image", "replace_tab_asset", "asset_action", "document_action", "outline_tab", "get_context", "latex_review", "latex_apply")
        val TAB_ACTIONS = setOf("read_tab", "search_tab", "patch_tab", "render_tab")
        val TAB_DOCUMENT_ACTIONS = setOf("export", "latexfix", "latex_review", "latex_apply", "save", "snapshot", "get_context", "activate", "close", "outline")
        val DOCUMENT_ACTIONS = setOf("create", "export", "latexfix", "latex_review", "latex_apply", "open", "save", "snapshot", "job_status", "get_context", "activate", "close", "outline", "export_chunk")
        val REVISIONED_DOCUMENT_ACTIONS = setOf("save", "close", "latex_apply")
        val BOOLEAN_OPTIONS = setOf("background", "saveAs", "discardChanges", "archive")
        const val MAX_ASSET_BYTES = 1024 * 1024
        const val MAX_ASSET_BASE64 = 1_400_000
        const val MAX_EXPORT_CHUNK_BYTES = 524_288
        val ASSET_MIMES = setOf("image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/svg+xml")
        val RPC_FIELDS = setOf("requestId", "action", "tabId", "offset", "limit", "query", "context", "expectedRevision", "operations", "width", "imageFormat", "documentAction", "content", "options", "diagramId", "format", "repairIndices", "jobId", "heading", "filename", "titleHint", "title", "windowId", "assetName", "assetPath", "assetAction", "mimeType", "body", "view", "caseSensitive", "wholeWord", "regex", "excludeDiagrams")
    }
}
