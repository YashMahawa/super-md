@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.material3.ExperimentalMaterial3ExpressiveApi::class)
package dev.supermd.studio

import android.graphics.Color as AndroidColor
import android.graphics.Bitmap
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.view.PixelCopy
import java.io.ByteArrayOutputStream
import android.os.Build
import android.os.Bundle
import android.content.Intent
import android.view.View
import android.view.WindowManager
import android.view.ViewGroup
import android.widget.FrameLayout
import android.view.inputmethod.InputMethodManager
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.viewModels
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.compose.setContent
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.snap
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.MenuBook
import androidx.compose.material.icons.automirrored.rounded.Redo
import androidx.compose.material.icons.automirrored.rounded.Undo
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.zIndex
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.flow.first
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

internal fun shouldShowNativeBusyOverlay(busy: Boolean, readerReady: Boolean, readerOwnsProgress: Boolean): Boolean =
    !readerOwnsProgress && (busy || !readerReady)

internal fun isSystemMotionEnabled(context: android.content.Context): Boolean =
    android.provider.Settings.Global.getFloat(context.contentResolver, android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f) != 0f

private suspend fun View.awaitWindowFocus() {
    if (hasWindowFocus()) return
    suspendCancellableCoroutine<Unit> { continuation ->
        val observer = viewTreeObserver
        val completed = AtomicBoolean(false)
        lateinit var listener: android.view.ViewTreeObserver.OnWindowFocusChangeListener
        fun removeListener() { if (observer.isAlive) observer.removeOnWindowFocusChangeListener(listener) }
        fun resumeIfFocused() {
            if (hasWindowFocus() && completed.compareAndSet(false, true)) {
                removeListener()
                continuation.resume(Unit)
            }
        }
        listener = android.view.ViewTreeObserver.OnWindowFocusChangeListener { hasFocus ->
            if (hasFocus) resumeIfFocused()
        }
        observer.addOnWindowFocusChangeListener(listener)
        continuation.invokeOnCancellation { removeListener() }
        resumeIfFocused()
    }
}

class MainActivity : ComponentActivity() {
    var dismissDocument: (() -> Unit)? = null
    var saveReaderPosition: (() -> Unit)? = null
    var openReaderFind: ((Boolean) -> Unit)? = null
    var stepReaderFind: ((Int) -> Unit)? = null
    var formatDocument: ((String) -> Unit)? = null
    var canFormatEditor: (() -> Boolean)? = null
    val agentAccessState: AgentAccessState by lazy { AgentAccessState(this) }
    var agentRelayState by mutableStateOf(AgentRelayClient.State.DISCONNECTED)
        private set
    var agentRelayRetrying by mutableStateOf(false)
        private set
    var agentAccessEnabled by mutableStateOf(false)
        private set
    internal var agentBackgroundGraceMillis: Long = DEFAULT_AGENT_BACKGROUND_GRACE_MILLIS
    internal var agentConfigOverrideForTest: AgentAccessConfig? = null
    internal var agentRelayCallFactoryForTest: okhttp3.Call.Factory? = null
    internal var agentRelayWebSocketFactoryForTest: okhttp3.WebSocket.Factory? = null
    @Volatile private var agentBridgeHandler: ((JSONObject, (Any?, String?) -> Unit) -> Unit)? = null
    @Volatile private var agentUiHandler: ((JSONObject, (Any?, String?) -> Unit) -> Boolean)? = null
    @Volatile private var agentExportHandler: ((JSONObject) -> Unit)? = null
    private val agentController = AgentWindowController(
        activity = this,
        onRelayStateChange = { agentRelayState = it },
        onRelayRetryingChange = { agentRelayRetrying = it },
    )
    private var workspaceKey = "main"
    internal val agentWorkspaceKey: String get() = workspaceKey
    @androidx.annotation.VisibleForTesting
    internal var activityResultRegistryOverride by mutableStateOf(defaultActivityResultRegistryOwnerForTest)
    private val model: StudioViewModel by viewModels { object : androidx.lifecycle.ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : androidx.lifecycle.ViewModel> create(modelClass: Class<T>): T = StudioViewModel(application, workspaceKey) as T
    } }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        workspaceKey = (savedInstanceState?.getString("workspace") ?: intent.getStringExtra("workspace") ?: "main").takeIf { it == "main" || runCatching { java.util.UUID.fromString(it) }.isSuccess } ?: "main"
        syncAgentAccessUiState()
        enableEdgeToEdge()
        if (Build.VERSION.SDK_INT >= 28) window.attributes = window.attributes.apply { layoutInDisplayCutoutMode = if (Build.VERSION.SDK_INT >= 30) WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS else WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES }
        // Create this task's workspace before RESUMED/lifecycle consumers can
        // request it. Compose's first frame may otherwise run after onResume.
        val windowModel = model
        setContent {
            val registryOverride = activityResultRegistryOverride
            if (registryOverride != null) {
                CompositionLocalProvider(androidx.activity.compose.LocalActivityResultRegistryOwner provides registryOverride) {
                    Studio(windowModel, this)
                }
            } else {
                Studio(windowModel, this)
            }
        }
        val savedDispatcherSession = savedInstanceState?.getString(OPEN_DISPATCHER_SESSION)
        if (savedDispatcherSession != windowModel.openDispatcherSessionId) {
            handleExternalDocumentIntent(intent, savedInstanceState, initial = true, targetModel = windowModel)
        }
    }
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleExternalDocumentIntent(intent, savedInstanceState = null, initial = false, targetModel = model)
    }
    private fun handleExternalDocumentIntent(
        incoming: Intent?,
        savedInstanceState: Bundle?,
        initial: Boolean,
        targetModel: StudioViewModel,
    ) {
        val caller = resolveExternalIntentCaller(incoming, initial)
        ExternalDocumentEntryGuard.dispatchIncomingIntent(this, incoming, savedInstanceState, initial, targetModel, caller)
    }
    private fun resolveExternalIntentCaller(incoming: Intent?, initial: Boolean): ExternalIntentCaller {
        val uri = incoming?.data
        val isOwnShareUri = uri != null &&
            uri.scheme.equals("content", ignoreCase = true) &&
            uri.authority == "${packageName}.share"
        if (Build.VERSION.SDK_INT >= 35) {
            val caller = runCatching { currentCaller }.getOrNull()?.takeIf { it.uid > 0 }
                ?: if (initial) runCatching { initialCaller }.getOrNull()?.takeIf { it.uid > 0 } else null
            if (caller != null) {
                val grantedShare = isOwnShareUri && runCatching {
                    caller.checkContentUriPermission(uri!!, Intent.FLAG_GRANT_READ_URI_PERMISSION) ==
                        android.content.pm.PackageManager.PERMISSION_GRANTED
                }.getOrDefault(false)
                return ExternalIntentCaller(uid = caller.uid, callerGrantedOwnShareUri = grantedShare)
            }
        }
        if (initial && Build.VERSION.SDK_INT >= 34) {
            val launchedUid = runCatching { launchedFromUid }.getOrDefault(-1)
            if (launchedUid > 0) {
                val grantedShare = isOwnShareUri && (
                    launchedUid == android.os.Process.myUid() ||
                        checkUriPermission(uri!!, -1, launchedUid, Intent.FLAG_GRANT_READ_URI_PERMISSION) ==
                            android.content.pm.PackageManager.PERMISSION_GRANTED
                    )
                return ExternalIntentCaller(uid = launchedUid, callerGrantedOwnShareUri = grantedShare)
            }
        }
        return ExternalIntentCaller()
    }
    fun requestOpen(uri: android.net.Uri, relative: String? = null) {
        model.retainDocumentAccess(uri)
        model.requestOpen(uri, relative)
    }
    internal fun syncAgentAccessUiState() {
        agentAccessEnabled = agentAccessState.enabled && agentConfigForThisWindow() != null
    }
    internal fun attachCurrentReaderWebView(reader: WebView?) = agentController.attachCurrentReaderWebView(reader)
    internal fun disconnectRelayNow() = agentController.disconnectRelayNow()
    override fun onStart() { super.onStart(); agentController.onStart() }
    override fun onStop() { saveReaderPosition?.invoke(); model.flush(); agentController.onStop(); super.onStop() }
    override fun onDestroy() { agentController.onDestroy(); super.onDestroy() }
    override fun onResume() { super.onResume(); agentController.onResume(); model.refreshMetadata(); model.refreshExternal(); model.reloadCustomTheme(); refreshAgentRelay() }
    internal fun agentConfigForThisWindow(): AgentAccessConfig? = agentController.agentConfigForThisWindow()
    internal fun localAgentTabId(value: String): String? = agentController.localAgentTabId(value)
    internal fun setAgentRequestHandlers(bridge: ((JSONObject, (Any?, String?) -> Unit) -> Unit)?, ui: ((JSONObject, (Any?, String?) -> Unit) -> Boolean)?) { agentBridgeHandler = bridge; agentUiHandler = ui }
    internal fun setAgentUiHandler(handler: ((JSONObject, (Any?, String?) -> Unit) -> Boolean)?) { agentUiHandler = handler }
    internal fun setAgentExportHandler(handler: ((JSONObject) -> Unit)?) { agentExportHandler = handler }
    internal fun requestAgentExport(args: JSONObject) = agentController.requestAgentExport(args, agentExportHandler)
    internal fun updateAgentExportJob(jobId: String, phase: String, error: String? = null) = agentController.updateAgentExportJob(jobId, phase, error)
    internal fun agentExportJob(jobId: String): JSONObject? = agentController.agentExportJob(jobId)
    internal suspend fun completeAgentExport(jobId: String, uri: android.net.Uri, fallbackName: String, format: String) = agentController.completeAgentExport(jobId, uri, fallbackName, format)
    internal suspend fun readAgentExportChunk(jobId: String, offset: Long, limit: Int): JSONObject = agentController.readAgentExportChunk(jobId, offset, limit)
    internal fun revokeAgentAccess(completion: (serverRevoked: Boolean) -> Unit) = agentController.revokeAgentAccess(completion)
    internal fun deliverAgentReply(requestId: String, result: Any?, error: String?) = agentController.deliverAgentReply(requestId, result, error)
    internal fun captureAgentReply(requestId: String, callback: (Any?, String?) -> Unit) = agentController.captureAgentReply(requestId, callback)
    internal fun dispatchAgentRequest(web: WebView, request: JSONObject, reply: (Any?, String?) -> Unit) = agentController.dispatchAgentRequest(web, request, reply)
    internal fun dispatchAgentCompute(web: WebView, request: JSONObject, reply: (Any?, String?) -> Unit) = agentController.dispatchAgentCompute(web, request, reply)
    internal fun agentRevision(value: String): String = agentController.agentRevision(value)
    internal fun agentSourceLength(value: String): Int = agentController.agentSourceLength(value)
    internal suspend fun captureAgentViewport(reader: WebView, requestedWidth: Int, imageFormat: String = "png"): JSONObject = agentController.captureAgentViewport(reader, requestedWidth, imageFormat, model)
    internal fun refreshAgentRelay() = agentController.refreshAgentRelay(agentRelayState, agentRelayRetrying, { agentUiHandler }, { agentBridgeHandler })
    fun handleShortcut(event: android.view.KeyEvent): Boolean {
        if (event.action == android.view.KeyEvent.ACTION_DOWN) {
            if (canFormatEditor?.invoke() == true) {
                val formatAction = markdownFormatActionForKey(
                    keyCode = event.keyCode,
                    isCtrlPressed = event.isCtrlPressed,
                    isShiftPressed = event.isShiftPressed,
                    isAltPressed = event.isAltPressed,
                    isMetaPressed = event.isMetaPressed,
                )
                if (formatAction != null) {
                    if (event.repeatCount == 0) formatDocument?.invoke(formatAction)
                    return true
                }
            }
        }
        if (event.action == android.view.KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
            if (event.keyCode == android.view.KeyEvent.KEYCODE_F11) { model.fullscreen(!model.state.value.fullscreen); return true }
            if (event.keyCode == android.view.KeyEvent.KEYCODE_F3 && !event.isCtrlPressed && !event.isAltPressed && !event.isMetaPressed) {
                if (!model.folderSearch.value.visible) stepReaderFind?.invoke(if (event.isShiftPressed) -1 else 1)
                return true
            }
            if (event.keyCode == android.view.KeyEvent.KEYCODE_ESCAPE) {
                if (model.folderSearch.value.visible) {
                    model.cancelWorkspaceSearch()
                    return true
                }
                if (model.state.value.fullscreen || model.state.value.readerOverlay) {
                    dismissDocument?.invoke() ?: model.fullscreen(false)
                    return true
                }
            }
            val primaryMod = event.isCtrlPressed || event.isMetaPressed
            if (primaryMod && !event.isAltPressed) {
                if (event.keyCode == android.view.KeyEvent.KEYCODE_F) {
                    if (event.isShiftPressed) model.openFolderSearch() else openReaderFind?.invoke(false)
                    return true
                }
                if (event.keyCode == android.view.KeyEvent.KEYCODE_H && !event.isShiftPressed) {
                    openReaderFind?.invoke(true)
                    return true
                }
                if (event.keyCode == android.view.KeyEvent.KEYCODE_S) {
                    if (event.isShiftPressed) model.beginSaveAs() else model.saveManual()
                    return true
                }
            }
            if (event.isCtrlPressed && event.keyCode == android.view.KeyEvent.KEYCODE_N) { newWindow(); return true }
            if (event.isCtrlPressed) {
                when(event.keyCode) {
                    android.view.KeyEvent.KEYCODE_T -> { if(event.isShiftPressed)model.reopen() else model.newNote();return true }
                    android.view.KeyEvent.KEYCODE_W -> { if(event.isShiftPressed)finish() else if(model.state.value.tabs.isNotEmpty())model.requestClose(model.state.value.active.id);return true }
                    android.view.KeyEvent.KEYCODE_TAB -> { model.cycle(if(event.isShiftPressed)-1 else 1);return true }
                    android.view.KeyEvent.KEYCODE_PAGE_DOWN -> {model.cycle(1);return true}
                    android.view.KeyEvent.KEYCODE_PAGE_UP -> {model.cycle(-1);return true}
                }
                if(event.keyCode in android.view.KeyEvent.KEYCODE_1..android.view.KeyEvent.KEYCODE_9){model.tabNumber(event.keyCode-android.view.KeyEvent.KEYCODE_1+1);return true}
            }
        }
        return false
    }
    override fun onKeyDown(keyCode: Int, event: android.view.KeyEvent): Boolean = handleShortcut(event) || super.onKeyDown(keyCode, event)
    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString("workspace", workspaceKey)
        outState.putString(OPEN_DISPATCHER_SESSION, model.openDispatcherSessionId)
        super.onSaveInstanceState(outState)
    }
    companion object {
        private const val OPEN_DISPATCHER_SESSION = "open_dispatcher_session"
        internal const val DEFAULT_AGENT_BACKGROUND_GRACE_MILLIS = 3L * 60L * 1000L
        @Volatile
        @androidx.annotation.VisibleForTesting
        internal var defaultActivityResultRegistryOwnerForTest: androidx.activity.result.ActivityResultRegistryOwner? = null
    }
    fun newWindow() {
        model.flush()
        startActivity(Intent(this, MainActivity::class.java).putExtra("workspace", java.util.UUID.randomUUID().toString()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_MULTIPLE_TASK or Intent.FLAG_ACTIVITY_LAUNCH_ADJACENT))
    }
}

internal data class AgentStatusPillUi(val visible: Boolean, val label: String, val stateKey: String)

internal fun sendAgentBridgeReply(
    activity: MainActivity,
    model: StudioViewModel,
    targetId: String,
    result: Any?,
    error: String?,
    reply: (Any?, String?) -> Unit,
) {
    val current = model.state.value.tabs.firstOrNull { it.id == targetId }
    val knownConflict = error?.takeIf { message ->
        message.contains("revision conflict", ignoreCase = true) ||
            message.contains("changed since the supplied revision", ignoreCase = true) ||
            message.contains("changed since the expected revision", ignoreCase = true)
    }
    if (knownConflict != null && current != null) {
        reply(null, JSONObject().put("error", knownConflict).put("currentRevision", activity.agentRevision(current.content))
            .put("sourceLength", activity.agentSourceLength(current.content)).toString())
    } else reply(result, error)
}

internal fun handleInactiveTabSnapshotRequest(
    activity: MainActivity,
    model: StudioViewModel,
    scope: kotlinx.coroutines.CoroutineScope,
    web: WebView,
    request: JSONObject,
    target: String,
    snapshot: Note,
    canonicalTabId: (Note) -> String,
    reply: (Any?, String?) -> Unit,
) {
    if (request.optString("action") !in setOf("read_tab", "search_tab", "outline_tab", "list_diagrams", "get_diagram", "patch_tab")) {
        reply(null, "This Android action requires the requested tab to be active")
        return
    }
    val contentBytes = snapshot.content.toByteArray(Charsets.UTF_8)
    if (contentBytes.size > MAX_AGENT_SNAPSHOT_BYTES) { reply(null, "This document exceeds Android's 2 MiB inactive-tab snapshot limit; activate it and retry"); return }
    val compute = JSONObject().put("requestId", request.optString("requestId"))
        .put("action", request.optString("action")).put("tabId", target).put("content", snapshot.content)
    listOf("expectedRevision", "operations", "offset", "limit", "query", "context", "heading", "view", "diagramId", "caseSensitive", "wholeWord", "regex", "excludeDiagrams")
        .forEach { key -> if (request.has(key)) compute.put(key, request.get(key)) }
    if (request.has("expectedRevision")) compute.put("expectedRevision", request.getString("expectedRevision").lowercase())
    activity.dispatchAgentCompute(web, compute) { raw, error ->
        if (error != null) { reply(null, error); return@dispatchAgentCompute }
        val result = raw as? JSONObject
        if (result == null) { reply(null, "Android could not read the computed document result"); return@dispatchAgentCompute }
        val snapshotRevision = activity.agentRevision(snapshot.content)
        if (result.optString("tabId") != target) {
            reply(null, "The document result did not match the captured Android note snapshot")
            return@dispatchAgentCompute
        }
        if (request.optString("action") == "patch_tab") {
            val patchedContent = result.optString("patchedContent", "")
            if (!result.optString("baseRevision").equals(snapshotRevision, ignoreCase = true) ||
                result.optInt("baseSourceLength", -1) != activity.agentSourceLength(snapshot.content) ||
                result.optInt("sourceLength", -1) != activity.agentSourceLength(patchedContent) ||
                !request.optString("expectedRevision").equals(snapshotRevision, ignoreCase = true)) {
                sendAgentBridgeReply(activity, model, target, null, "Revision conflict: the note changed; read it again before editing", reply)
                return@dispatchAgentCompute
            }
            scope.launch {
                runCatching {
                    model.commitAgentSnapshotPatch(target, snapshotRevision, patchedContent, result.optString("revision"))
                }.onFailure { sendAgentBridgeReply(activity, model, target, null, it.message ?: "Could not save the inactive-tab patch", reply) }
                    .onSuccess { result.remove("patchedContent"); result.put("tabId", canonicalTabId(snapshot)); reply(result, null) }
            }
        } else {
            if (!result.optString("revision").equals(snapshotRevision, ignoreCase = true) || result.optInt("sourceLength", -1) != activity.agentSourceLength(snapshot.content)) {
                reply(null, "The document revision changed while Android was reading it; retry")
            } else {
                result.put("tabId", canonicalTabId(snapshot))
                reply(result, null)
            }
        }
    }
}

internal fun resolveAgentStatusPillUi(
    accessEnabled: Boolean,
    relayState: AgentRelayClient.State,
    retrying: Boolean,
): AgentStatusPillUi {
    val visible = accessEnabled || relayState != AgentRelayClient.State.DISCONNECTED || retrying
    return when {
        relayState == AgentRelayClient.State.CONNECTED -> AgentStatusPillUi(visible, "AI connected", "connected")
        retrying -> AgentStatusPillUi(visible, "AI retrying…", "retrying")
        relayState == AgentRelayClient.State.CONNECTING -> AgentStatusPillUi(visible, "AI connecting…", "connecting")
        else -> AgentStatusPillUi(visible, "AI offline", "offline")
    }
}

@Composable private fun Studio(model: StudioViewModel, activity: MainActivity) {
    val state by model.state.collectAsStateWithLifecycle()
    val systemDark = androidx.compose.foundation.isSystemInDarkTheme()
    val theme = if (state.fullscreen) state.fullscreenTheme else state.theme
    val dark = theme == "dark" || theme == "black" || (theme == "system" && systemDark)
    val context = LocalContext.current
    val custom=remember(state.customTheme){themeDocument(state.customTheme)}
    val colors = remember(context,dark,theme,state.accent,custom) {
        var base = when { Build.VERSION.SDK_INT >= 31 -> if (dark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context); dark -> darkColorScheme(primary = Color(0xffb2c8ff), secondary = Color(0xffbcc6dc)); else -> lightColorScheme(primary = Color(0xff42669e), onPrimary = Color.White, primaryContainer = Color(0xffd7e3ff), onPrimaryContainer = Color(0xff162c4c), secondary = Color(0xff56647c), surface = Color(0xfff7f9fd), background = Color(0xfff7f9fd), surfaceContainerLow = Color(0xfff0f3fa), surfaceContainerHigh = Color(0xffe5ebf5)) }
        base=accentColors(base,custom?.optString("accent")?:state.accent,dark)
        if (!dark) base = studyLightColors(base)
        if (theme == "black") base = manualAccent("neutral",true).copy(primary=Color(0xffdedede),onPrimary=Color(0xff1a1a1a),primaryContainer=Color(0xff343434),onPrimaryContainer=Color(0xfff0f0f0),background=Color.Black,surface=Color.Black,surfaceContainer=Color(0xff171717),surfaceContainerLow=Color(0xff101010),surfaceContainerHigh=Color(0xff242424))
        customThemeColors(base,custom,theme,dark)
    }
    val systemMotion = isSystemMotionEnabled(context)
    val shapes=remember(custom){val radius=custom?.optJSONObject("metrics")?.optDouble("controlRadius",Double.NaN);if(radius!=null&&radius.isFinite())Shapes().copy(small=RoundedCornerShape(radius.toFloat().coerceIn(0f,28f).dp),medium=RoundedCornerShape(radius.toFloat().coerceIn(0f,28f).dp),large=RoundedCornerShape(radius.toFloat().coerceIn(0f,28f).dp))else Shapes()}
    MaterialExpressiveTheme(colorScheme = colors, shapes=shapes, motionScheme = if (state.motion && systemMotion) MotionScheme.expressive() else NoMotionScheme) {
        Surface(Modifier.fillMaxSize(), color = colors.surface, contentColor = colors.onSurface) {
            StudioContent(model, state, activity, dark, state.motion && systemMotion)
        }
    }
}

private object NoMotionScheme : MotionScheme {
    override fun <T> defaultSpatialSpec(): FiniteAnimationSpec<T> = snap()
    override fun <T> fastSpatialSpec(): FiniteAnimationSpec<T> = snap()
    override fun <T> slowSpatialSpec(): FiniteAnimationSpec<T> = snap()
    override fun <T> defaultEffectsSpec(): FiniteAnimationSpec<T> = snap()
    override fun <T> fastEffectsSpec(): FiniteAnimationSpec<T> = snap()
    override fun <T> slowEffectsSpec(): FiniteAnimationSpec<T> = snap()
}

internal fun shouldAcceptExternalDrag(localState: Any?, description: android.content.ClipDescription?): Boolean {
    if (localState != null || description == null) return false
    val count = description.mimeTypeCount
    if (count <= 0) return false
    var hasExternalPayload = false
    for (index in 0 until count) {
        val mime = description.getMimeType(index)?.substringBefore(';')?.trim()?.lowercase().orEmpty()
        if (mime.startsWith("chromium/")) return false
        if (mime.isNotEmpty() && mime != "text/plain" && mime != "text/html") {
            hasExternalPayload = true
        }
    }
    return hasExternalPayload
}

internal class ExternalDropDragController(
    private val onExternalDrop: (android.view.DragEvent) -> Unit,
) : android.view.View.OnDragListener {
    private var acceptingExternalDrag = false

    override fun onDrag(view: android.view.View?, event: android.view.DragEvent): Boolean =
        onDragAction(
            action = event.action,
            localState = event.localState,
            description = event.clipDescription,
            event = event,
        )

    internal fun onDragAction(
        action: Int,
        localState: Any?,
        description: android.content.ClipDescription?,
        event: android.view.DragEvent? = null,
    ): Boolean {
        return when (action) {
            android.view.DragEvent.ACTION_DRAG_STARTED -> {
                acceptingExternalDrag = shouldAcceptExternalDrag(localState, description)
                acceptingExternalDrag
            }
            android.view.DragEvent.ACTION_DROP -> {
                if (!acceptingExternalDrag) return false
                if (event != null) onExternalDrop(event)
                true
            }
            android.view.DragEvent.ACTION_DRAG_ENDED -> {
                val handled = acceptingExternalDrag
                acceptingExternalDrag = false
                handled
            }
            else -> acceptingExternalDrag
        }
    }
}

internal fun shouldBlockNativeDrop(
    state: StudioState,
    folderSearchVisible: Boolean = false,
    accessRequestOpen: Boolean = false,
    settingsOpen: Boolean = false,
    exporting: Boolean = false,
    renaming: Boolean = false,
    contentsShown: Boolean = false,
    drawerOpen: Boolean = false,
): Boolean =
    !state.welcomed ||
        state.busy ||
        state.readerOverlay ||
        folderSearchVisible ||
        accessRequestOpen ||
        state.folderAccessPrompt != null ||
        state.pendingCloseNoteId != null ||
        state.pendingSaveConflictNoteId != null ||
        settingsOpen ||
        exporting ||
        renaming ||
        contentsShown ||
        drawerOpen

internal fun extractDroppedFileUris(clip: android.content.ClipData?): List<android.net.Uri> {
    if (clip == null) return emptyList()
    return (0 until clip.itemCount).mapNotNull { index ->
        clip.getItemAt(index)?.uri?.takeIf { uri ->
            uri.scheme?.lowercase() in setOf("content", "file")
        }
    }
}

@Composable private fun StudioContent(model: StudioViewModel, state: StudioState, activity: MainActivity, dark: Boolean, motion: Boolean) {
    val scope = rememberCoroutineScope()
    val drawer = rememberDrawerState(DrawerValue.Closed)
    val snackbar = remember { SnackbarHostState() }
    var settings by remember { mutableStateOf(activity.intent.getBooleanExtra("showUpdates",false)) }
    var settingsSection by rememberSaveable { mutableStateOf<String?>(null) }
    val update by model.updates.state.collectAsStateWithLifecycle()
    val notificationPermission=rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()){granted->if(granted)model.updates.notifyAvailable()}
    LaunchedEffect(update.version) {
        if(update.version!=null) {
            scope.launch{snackbar.showSnackbar("Super MD ${update.version} is available. See Settings → About & updates.")}
            val permissionPrefs=activity.getSharedPreferences("studio-updates",0)
            if(Build.VERSION.SDK_INT>=33 && !permissionPrefs.getBoolean("notificationAsked",false)) {
                permissionPrefs.edit().putBoolean("notificationAsked",true).apply()
                notificationPermission.launch(android.Manifest.permission.POST_NOTIFICATIONS)
            }
        }
    }
    var exporting by remember { mutableStateOf(false) }
    var sharing by remember { mutableStateOf(false) }
    var readerPdfOwnsProgress by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    var findRequest by remember { mutableIntStateOf(0) }
    var findReplace by remember { mutableStateOf(false) }
    var renaming by rememberSaveable {mutableStateOf(false)}
    var contentsShown by remember {mutableStateOf(false)}
    var readingChromeVisible by remember {mutableStateOf(true)}
    LaunchedEffect(state.busy) { if (!state.busy) readerPdfOwnsProgress = false }
    LaunchedEffect(state.active.id, state.mode, settings) { if (!state.fullscreen) readingChromeVisible = true }
    LaunchedEffect(state.fullscreen) { if (state.fullscreen) readingChromeVisible = false }
    // A delayed single tap allows Live's double tap to enter editing without
    // hiding chrome or resizing the viewport in the middle of that action.
    val chromeTapJob=remember {arrayOfNulls<kotlinx.coroutines.Job>(1)}
    DisposableEffect(Unit){onDispose{chromeTapJob[0]?.cancel()}}
    var web by remember { mutableStateOf<WebView?>(null) }
    var chromeHeight by remember { mutableIntStateOf(0) }
    val readerNote = remember { arrayOfNulls<String>(1) }
    // WebView timer controls are process-wide. Track every reader so a stopped
    // activity cannot pause another window that is still visible.
    val lifecycleOwner = androidx.lifecycle.compose.LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner, web) {
        val currentWeb = web
        if (currentWeb == null) {
            // No reader exists during initial composition or renderer recovery;
            // registering that gap would create an owner with no view through
            // which to apply WebView's process-wide timer call.
            onDispose { }
        } else {
            val owner = Any()
            fun applyGlobalAction(action: ReaderTimerOwners.GlobalAction) {
                when (action) {
                    ReaderTimerOwners.GlobalAction.PAUSE -> currentWeb.pauseTimers()
                    ReaderTimerOwners.GlobalAction.RESUME -> currentWeb.resumeTimers()
                    ReaderTimerOwners.GlobalAction.NONE -> Unit
                }
            }
            val started = lifecycleOwner.lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.STARTED)
            // A view can be recreated while its Activity is already STOPPED;
            // explicitly pause that view even when another reader keeps the
            // process-wide timers running.
            if (started) currentWeb.onResume() else currentWeb.onPause()
            applyGlobalAction(ReaderTimerOwners.process.acquire(owner, started))
            val observer = androidx.lifecycle.LifecycleEventObserver { _, event ->
                when (event) {
                    androidx.lifecycle.Lifecycle.Event.ON_STOP -> {
                        currentWeb.onPause()
                        applyGlobalAction(ReaderTimerOwners.process.setStarted(owner, false))
                    }
                    androidx.lifecycle.Lifecycle.Event.ON_START -> {
                        applyGlobalAction(ReaderTimerOwners.process.setStarted(owner, true))
                        currentWeb.onResume()
                    }
                    else -> Unit
                }
            }
            lifecycleOwner.lifecycle.addObserver(observer)
            onDispose {
                lifecycleOwner.lifecycle.removeObserver(observer)
                applyGlobalAction(ReaderTimerOwners.process.release(owner))
            }
        }
    }
    DisposableEffect(activity, web) {
        activity.attachCurrentReaderWebView(web)
        model.assetAccessRestored = { document, source ->
            web?.evaluateJavascript("window.dispatchEvent(new CustomEvent('supermd-asset-access-restored',{detail:{documentPath:${JSONObject.quote(document)},source:${JSONObject.quote(source)}}}))", null)
        }
        activity.dismissDocument = { web?.evaluateJavascript("window.supermdDismiss?.() || false") { dismissed -> if (dismissed != "true") model.fullscreen(false) } ?: model.fullscreen(false) }
        activity.saveReaderPosition={web?.evaluateJavascript("window.supermdSavePosition?.()",null)}
        activity.openReaderFind = { replace ->
            menu = false
            findReplace = replace
            findRequest++
        }
        activity.stepReaderFind = { direction ->
            menu = false
            web?.let { reader ->
                reader.requestFocus(View.FOCUS_DOWN)
                reader.evaluateJavascript("window.supermdFindStep?.(${if (direction < 0) -1 else 1}); true", null)
            }
        }
        onDispose { activity.attachCurrentReaderWebView(null); activity.dismissDocument = null;activity.saveReaderPosition=null;activity.openReaderFind=null;activity.stepReaderFind=null;model.assetAccessRestored=null }
    }
    LaunchedEffect(findRequest, menu, web) {
        if (findRequest == 0 || menu) return@LaunchedEffect
        val requested = findRequest
        val replace = findReplace
        // Wait for the popup window to release native focus before asking the
        // WebView for focus. This follows the actual dismissal instead of
        // estimating its transition duration.
        val reader = web ?: return@LaunchedEffect
        reader.awaitWindowFocus()
        if (menu || requested != findRequest || reader !== web) return@LaunchedEffect
        findRequest = 0
        findReplace = false
        reader.requestFocus(View.FOCUS_DOWN)
        reader.evaluateJavascript("window.supermdFind?.(${if (replace) "true" else ""}); true") {
            reader.post {
                reader.requestFocus(View.FOCUS_DOWN)
                val hasHardwareKeyboard = activity.resources.configuration.keyboard != android.content.res.Configuration.KEYBOARD_NOKEYS
                val showImeWithHardware = android.provider.Settings.Secure.getInt(activity.contentResolver, "show_ime_with_hard_keyboard", 0) == 1
                val inputMethod = activity.getSystemService(android.content.Context.INPUT_METHOD_SERVICE) as? InputMethodManager
                if (!hasHardwareKeyboard || showImeWithHardware) {
                    inputMethod?.showSoftInput(reader, InputMethodManager.SHOW_IMPLICIT)
                } else {
                    // WebView.focus() can itself open the software keyboard
                    // after an input receives focus. Honor the hardware-keyboard
                    // preference even when DOM focus was restored natively.
                    inputMethod?.hideSoftInputFromWindow(reader.windowToken, 0)
                }
            }
        }
    }
    var readerReady by remember { mutableStateOf(false) }
    var readerGeneration by remember { mutableIntStateOf(0) }
    DisposableEffect(model, readerReady, readerGeneration, web) {
        model.readerFlushRequester = { noteId ->
            val current = web
            if (!readerReady || current == null) model.readerStateIsNativeAuthoritative(noteId)
            else (current.getTag(R.id.reader_bridge_tag) as? ReaderBridge)?.requestFlush(noteId) ?: false
        }
        model.readerFlushStatusRequester = { noteId ->
            val current = web
            if (!readerReady || current == null) {
                if (model.readerStateIsNativeAuthoritative(noteId)) ReaderFlushStatus.ACKNOWLEDGED
                else ReaderFlushStatus.FAILED
            } else {
                (current.getTag(R.id.reader_bridge_tag) as? ReaderBridge)?.requestFlushStatus(noteId)
                    ?: ReaderFlushStatus.FAILED
            }
        }
        onDispose {
            model.readerFlushRequester = null
            model.readerFlushStatusRequester = null
        }
    }
    DisposableEffect(activity, model, readerReady) {
        val handler = if (readerReady) {
            OpenIntentDispatcher.Handler<OpenDocumentTarget> { target, relative ->
                model.openDocument(
                    target.uri,
                    relative,
                    externalIntentFlags = target.externalIntentFlags,
                    externalCaller = target.externalCaller,
                )
            }
        } else null
        model.attachReaderOpenHandler(handler)
        onDispose { if (handler != null) model.detachReaderOpenHandler(handler) }
    }
    DisposableEffect(activity, model, readerReady, web, state.tabs, state.activeId) {
        val bridge: ((JSONObject, (Any?, String?) -> Unit) -> Unit)? = if (!readerReady || web == null) null else bridge@{ incoming, reply ->
            val request = JSONObject(incoming.toString())
            val globallyQualified = request.optString("tabId")
            val rawTabId = if (globallyQualified.isNotBlank()) activity.localAgentTabId(globallyQualified) else null
            if (globallyQualified.isNotBlank() && rawTabId == null) { reply(null, "This tab belongs to a different device or workspace"); return@bridge }
            if (rawTabId != null) request.put("tabId", rawTabId)
            request.optString("expectedRevision").takeIf { it.isNotBlank() }?.let { request.put("expectedRevision", it.lowercase()) }
            fun canonicalTabId(note: Note): String = "tab:${activity.agentConfigForThisWindow()?.deviceId ?: "local"}:${activity.agentWorkspaceKey}:${note.id}"
            fun sendAgentReply(targetId: String, result: Any?, error: String?) =
                sendAgentBridgeReply(activity, model, targetId, result, error, reply)
            fun withSelectedTab(snapshotSafeWhenInactive: Boolean = false, action: suspend () -> Unit) {
                val target = request.optString("tabId").takeIf { it.isNotBlank() }
                if (target == null) { scope.launch { action() }; return }
                val snapshot = model.state.value.tabs.firstOrNull { it.id == target }
                if (snapshot == null) { reply(null, "The requested tab is not open on this device"); return }
                val suppliedRevision = request.optString("expectedRevision").takeIf { it.isNotBlank() }
                if (suppliedRevision != null && !activity.agentRevision(snapshot.content).equals(suppliedRevision, ignoreCase = true)) {
                    sendAgentReply(target, null, "Revision conflict: the note changed; read it again before editing")
                    return
                }
                if (model.state.value.activeId != target && snapshotSafeWhenInactive) {
                    handleInactiveTabSnapshotRequest(activity, model, scope, web!!, request, target, snapshot, ::canonicalTabId, reply)
                } else if (model.state.value.activeId != target) {
                    reply(null, "The requested tab is inactive. Activate it in Super MD before using this Android reader action.")
                } else scope.launch { action() }
            }
            when (request.optString("action")) {
                "list_tabs" -> {
                    val tabs = org.json.JSONArray()
                    val liveState = model.state.value
                    liveState.tabs.take(100).forEach { note ->
                        val id = canonicalTabId(note)
                        tabs.put(JSONObject().put("id", id).put("tabId", id).put("name", note.name).put("saved", !note.dirty)
                            .put("active", note.id == liveState.activeId).put("mode", if (note.id == liveState.activeId) liveState.mode else "live")
                            .put("path", note.uri ?: note.id).put("uri", note.uri ?: JSONObject.NULL)
                            .put("revision", activity.agentRevision(note.content)))
                    }
                    reply(JSONObject().put("tabs", tabs), null)
                }
                "document_action" -> when (request.optString("documentAction")) {
                    "create" -> {
                        val options = request.optJSONObject("options")
                        val title = request.optString("titleHint").takeIf { it.isNotBlank() }
                            ?: request.optString("filename").takeIf { it.isNotBlank() }
                        val format = request.optString("format").takeIf { it.isNotBlank() }
                            ?: if (title?.endsWith(".smd", ignoreCase = true) == true) "smd" else "md"
                        model.newNote(title, request.optString("content").takeIf { request.has("content") },
                            options?.optBoolean("background", false) == true, format) { created ->
                            if (created == null) reply(null, "Super MD could not create a tab")
                            else {
                                val updated = model.state.value.tabs.firstOrNull { it.id == created.id } ?: created
                                reply(JSONObject().put("tabId", canonicalTabId(updated)).put("name", updated.name)
                                    .put("path", updated.uri ?: updated.id).put("uri", updated.uri ?: JSONObject.NULL)
                                    .put("active", updated.id == model.state.value.activeId).put("format", if (updated.portable) "smd" else "md")
                                    .put("revision", activity.agentRevision(updated.content)), null)
                            }
                        }
                    }
                    "activate" -> {
                        val target = request.optString("tabId")
                        if (model.state.value.tabs.none { it.id == target }) reply(null, "The requested tab is not open on this device")
                        else {
                            model.select(target)
                            scope.launch {
                                val selected = kotlinx.coroutines.withTimeoutOrNull(5_000) { model.state.first { it.activeId == target } }
                                if (selected == null) reply(null, "Could not activate the requested open tab")
                                else {
                                    // ActiveId changes before the WebView's React tree has necessarily received
                                    // supermdLoad for the new tab. Do not report activation complete until the
                                    // live reader has acknowledged this exact native snapshot; otherwise an
                                    // immediate close can safely fail its own flush while JS still holds the
                                    // previous tab. The close barrier remains mandatory after this handshake.
                                    val readerReady = model.awaitReaderSnapshot(target)
                                    if (!readerReady) reply(null, "The requested tab is still loading in the reader; retry activation shortly")
                                    else {
                                        val note = model.state.value.tabs.firstOrNull { it.id == target }
                                        if (note == null || model.state.value.activeId != target) reply(null, "The requested tab is no longer open")
                                        else reply(JSONObject().put("tabId", canonicalTabId(note)).put("name", note.name)
                                            .put("path", note.uri ?: note.id).put("uri", note.uri ?: JSONObject.NULL).put("active", true)
                                            .put("revision", activity.agentRevision(note.content)), null)
                                    }
                                }
                            }
                        }
                    }
                    "save" -> {
                        val target = request.optString("tabId")
                        val options = request.optJSONObject("options")
                        val requestedFormat = request.optString("format").takeIf { it.isNotBlank() }
                        if (options?.optBoolean("saveAs", false) == true) {
                            val note = model.state.value.tabs.firstOrNull { it.id == target }
                            if (note == null) reply(null, "The requested tab is not open on this device")
                            else if (requestedFormat != null && requestedFormat != (if (note.portable) "smd" else "md"))
                                reply(null, "Android Save As preserves this note's ${if (note.portable) "smd" else "md"} format; converting formats is not supported")
                            else if (!activity.agentRevision(note.content).equals(request.optString("expectedRevision"), ignoreCase = true))
                                sendAgentReply(target, null, "Revision conflict: the note changed; read it again before saving")
                            else {
                                model.busy(true)
                                scope.launch {
                                    runCatching { model.saveAgentAs(target, request.getString("expectedRevision"), request.getString("filename")) }
                                        .onFailure { error -> model.fail("Could not save as: ${error.message}"); sendAgentReply(target, null, error.message ?: "Could not save as") }
                                        .onSuccess { (path, name) ->
                                            val saved = model.state.value.tabs.firstOrNull { it.id == target }
                                            if (saved == null) reply(null, "The note closed while it was saving")
                                            else reply(JSONObject().put("tabId", canonicalTabId(saved)).put("name", name).put("path", path).put("uri", path)
                                                .put("active", saved.id == model.state.value.activeId).put("revision", activity.agentRevision(saved.content))
                                                .put("saved", !saved.dirty).put("savedAs", true), null)
                                        }
                                }
                            }
                        }
                        else {
                            val note = model.state.value.tabs.firstOrNull { it.id == target }
                            if (note == null) reply(null, "The requested tab is not open on this device")
                            else if (requestedFormat != null && requestedFormat != (if (note.portable) "smd" else "md"))
                                reply(null, "Android save preserves this note's ${if (note.portable) "smd" else "md"} format; converting formats is not supported")
                            else if (!activity.agentRevision(note.content).equals(request.optString("expectedRevision"), ignoreCase = true))
                                sendAgentReply(target, null, "Revision conflict: the note changed; read it again before saving")
                            else if (note.portable) {
                                model.busy(true)
                                scope.launch {
                                    runCatching { model.saveAgentPortable(target, request.getString("expectedRevision")) }
                                        .onFailure { error -> sendAgentReply(target, null, model.reportDocumentSaveFailure(target, error, "Could not save portable note: ${error.message}")) }
                                        .onSuccess {
                                            val saved = model.state.value.tabs.firstOrNull { it.id == target }
                                            if (saved == null) reply(null, "The note closed while it was saving")
                                            else reply(JSONObject().put("tabId", canonicalTabId(saved)).put("name", saved.name)
                                                .put("path", saved.uri ?: saved.id).put("uri", saved.uri ?: JSONObject.NULL)
                                                .put("active", saved.id == model.state.value.activeId).put("revision", activity.agentRevision(saved.content))
                                                .put("saved", !saved.dirty), null)
                                        }
                                }
                            }
                            else model.save(noteId = target, expectedRevision = request.optString("expectedRevision")) { error ->
                                if (error != null) sendAgentReply(target, null, error)
                                else {
                                    val saved = model.state.value.tabs.firstOrNull { it.id == target }
                                    if (saved == null) reply(null, "The note closed while it was saving")
                                    else reply(JSONObject().put("tabId", canonicalTabId(saved)).put("name", saved.name)
                                        .put("path", saved.uri ?: saved.id).put("uri", saved.uri ?: JSONObject.NULL)
                                        .put("active", saved.id == model.state.value.activeId).put("revision", activity.agentRevision(saved.content))
                                        .put("saved", !saved.dirty), null)
                                }
                            }
                        }
                    }
                    "close" -> {
                        val target = request.optString("tabId")
                        val note = model.state.value.tabs.firstOrNull { it.id == target }
                        val discard = request.optJSONObject("options")?.optBoolean("discardChanges", false) == true
                        if (note == null) reply(null, "The requested tab is not open on this device")
                        else if (!activity.agentRevision(note.content).equals(request.optString("expectedRevision"), ignoreCase = true)) sendAgentReply(target, null, "Revision conflict: the note changed since the supplied revision; it remains open")
                        else if (note.dirty && !discard) reply(null, "The note has unsaved changes. Set options.discardChanges=true to close it; Android will retain its recovery copy.")
                        else {
                            model.close(target, request.getString("expectedRevision"), refuseDirty = true, discardChanges = discard) { error ->
                                if (error != null) sendAgentReply(target, null, error)
                                else {
                                    val current = model.state.value
                                    reply(JSONObject().put("closed", true).put("activeTabId", canonicalTabId(current.active))
                                        .put("tabId", canonicalTabId(current.active)).put("name", current.active.name)
                                        .put("path", current.active.uri ?: current.active.id).put("uri", current.active.uri ?: JSONObject.NULL)
                                        .put("revision", activity.agentRevision(current.active.content)), null)
                                }
                            }
                        }
                    }
                    "open" -> { reply(null, "Use Super MD's Open action on Android, then retry the device request.") }
                    "job_status" -> reply(activity.agentExportJob(request.optString("jobId")) ?: JSONObject().put("jobId", request.optString("jobId")).put("phase", "unknown"), null)
                    "export_chunk" -> scope.launch {
                        try { reply(activity.readAgentExportChunk(request.getString("jobId"), request.optLong("offset", 0L), request.optInt("limit", 262_144)), null) }
                        catch (error: Exception) { reply(null, error.message ?: "Could not read this export chunk") }
                    }
                    else -> {
                        val action = when (request.optString("documentAction")) {
                            "latexfix" -> if (request.optJSONObject("options")?.has("repairIndices") == true) "latex_apply" else "latex_review"
                            "outline" -> "outline_tab"
                            "snapshot" -> "snapshot"
                            else -> request.optString("documentAction")
                        }
                        if (request.optString("documentAction") in setOf("latexfix", "latex_apply") && action == "latex_apply" && !request.has("repairIndices"))
                            request.optJSONObject("options")?.takeIf { it.has("repairIndices") }?.let { request.put("repairIndices", it.getJSONArray("repairIndices")) }
                        request.optJSONObject("options")?.let { options ->
                            listOf("offset", "limit").forEach { field -> if (!request.has(field) && options.has(field)) request.put(field, options.get(field)) }
                        }
                        if (request.optString("documentAction") == "export") {
                            val options = request.optJSONObject("options")
                            val requestedName = request.optString("filename").takeIf { it.isNotBlank() } ?: options?.optString("filename").orEmpty()
                            val filename = requestedName.takeIf { it.isNotBlank() }?.let { it.substringAfterLast('/').substringAfterLast('\\').replace(Regex("[\\u0000-\\u001f\\u007f]"), "").take(240) }
                                ?.takeIf { it.isNotBlank() }
                            val exportFormat = request.optString("format").takeIf { it.isNotBlank() } ?: options?.optString("format", "pdf") ?: "pdf"
                            request.put("action", "export_document").put("format", exportFormat)
                            if (filename != null) request.put("filename", filename)
                            options?.remove("filename")
                            options?.remove("format")
                        }
                        else request.put("action", action)
                        if (request.optString("action") == "snapshot") withSelectedTab { runCatching { activity.captureAgentViewport(web!!, request.optInt("width", 1200)) }.onSuccess { reply(it, null) }.onFailure { reply(null, it.message ?: "Could not capture the reading viewport") } }
                        else withSelectedTab { activity.dispatchAgentRequest(web!!, request) { result, error -> sendAgentReply(request.optString("tabId"), result, error) } }
                    }
                }
                "render_tab" -> withSelectedTab { runCatching { activity.captureAgentViewport(web!!, request.optInt("width", 1200), request.optString("imageFormat", "png")) }.onSuccess { reply(it, null) }.onFailure { reply(null, it.message ?: "Could not capture the reading viewport") } }
                "get_diagram", "get_diagram_image", "list_diagrams" -> withSelectedTab(snapshotSafeWhenInactive = true) { activity.dispatchAgentRequest(web!!, request) { result, error -> sendAgentReply(request.optString("tabId"), result, error) } }
                "replace_tab_asset" -> withSelectedTab {
                    val flush = JSONObject(request.toString()).put("action", "flush_current")
                    activity.dispatchAgentRequest(web!!, flush) { _, flushError ->
                        if (flushError != null) reply(null, flushError)
                        else scope.launch {
                            runCatching {
                                model.replacePortableAsset(
                                    request.getString("tabId"), request.getString("assetName"),
                                    request.getString("assetPath"), request.getString("expectedRevision"),
                                )
                            }.onSuccess {
                                if (it.optBoolean("changed")) web?.evaluateJavascript("window.dispatchEvent(new Event('supermd-assets-changed'))", null)
                                reply(it, null)
                            }
                                .onFailure { sendAgentReply(request.optString("tabId"), null, it.message ?: "Could not replace the portable image") }
                        }
                    }
                }
                "asset_action" -> withSelectedTab {
                    val flush = JSONObject(request.toString()).put("action", "flush_current")
                    activity.dispatchAgentRequest(web!!, flush) { _, flushError ->
                        if (flushError != null) reply(null, flushError)
                        else scope.launch {
                            runCatching { model.agentAssetAction(request) }
                                .onSuccess {
                                    if (request.optString("assetAction") == "attach") web?.evaluateJavascript("window.dispatchEvent(new Event('supermd-assets-changed'))", null)
                                    reply(it, null)
                                }
                                .onFailure { sendAgentReply(request.optString("tabId"), null, it.message ?: "Could not use the portable image asset") }
                        }
                    }
                }
                "read_tab", "search_tab", "patch_tab", "get_context", "outline_tab", "latex_review", "latex_apply" -> withSelectedTab(snapshotSafeWhenInactive = request.optString("action") in setOf("read_tab", "search_tab", "patch_tab", "outline_tab")) { activity.dispatchAgentRequest(web!!, request) { result, error -> sendAgentReply(request.optString("tabId"), result, error) } }
                else -> reply(null, "This action is not supported by the Android live reader.")
            }
        }
        activity.setAgentRequestHandlers(bridge, null)
        onDispose { activity.setAgentRequestHandlers(null, null) }
    }
    var createFolderRequest by remember { mutableStateOf<CreateFolderRequest?>(null) }
    var renameFolderTarget by remember { mutableStateOf<FileEntry?>(null) }
    var hinge by remember { mutableStateOf<FoldingFeature?>(null) }
    val recent by model.recent.collectAsStateWithLifecycle()
    val folderSearch by model.folderSearch.collectAsStateWithLifecycle()
    val seededFind by model.seededFind.collectAsStateWithLifecycle()
    val accessRequest by model.documentAccessRequests.collectAsStateWithLifecycle()
    var accessPickerShowing by rememberSaveable { mutableStateOf(false) }
    val accessPicker = rememberLauncherForActivityResult(RestoreDocumentAccess()) { uri ->
        accessPickerShowing = false
        val request = model.documentAccessRequests.value
        if (uri != null && request != null) model.restoreDocumentAccess(request, uri) else model.dismissDocumentAccess()
    }
    var imageCallback by remember { mutableStateOf<android.webkit.ValueCallback<Array<android.net.Uri>>?>(null) }
    var imageNote by remember { mutableStateOf("") }
    DisposableEffect(model, activity) {
        model.shareReady = { activity.startActivity(Intent.createChooser(it, "Share note")) }
        onDispose { model.shareReady = null }
    }
    val imagePicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        imageCallback?.onReceiveValue(null); imageCallback = null
        if (uris.isNotEmpty()) model.importDropped(uris, imageNote) { images -> images?.let { web?.evaluateJavascript("window.supermdInsertImages?.($it)", null) } }
    }
    LaunchedEffect(activity) { WindowInfoTracker.getOrCreate(activity).windowLayoutInfo(activity).collect { info -> hinge = info.displayFeatures.filterIsInstance<FoldingFeature>().firstOrNull { it.isSeparating && it.orientation == FoldingFeature.Orientation.VERTICAL } } }
    val open = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { it?.let { uri -> activity.requestOpen(uri) } }
    val fontPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) {it?.let(model::importFont)}
    val themePicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) {it?.let {uri->model.importCustomTheme(uri)}}
    val themeExport = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) {it?.let {uri->model.exportCustomTheme(uri)}}
    var noteLocation by remember {mutableStateOf(model.noteLocation())}
    val noteFolder = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) {it?.let {uri->runCatching{model.noteLocation(uri);noteLocation=uri.toString()}.onFailure{model.fail("Could not remember this folder: ${it.message}")}}}
    val save = rememberLauncherForActivityResult(NoteDestination("text/markdown", model::noteLocation)) { uri -> if (uri != null) model.save(uri) else model.cancelSaveAs() }
    val portableSaveAs = rememberLauncherForActivityResult(NoteDestination("application/vnd.supermd.smd", model::noteLocation)) { uri -> if (uri != null) model.completePortableSaveAs(uri) else model.cancelSaveAs() }
    val folder = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { it?.let { uri -> model.setFolder(uri) } }
    var workspaceFolderPickerShowing by rememberSaveable { mutableStateOf(false) }
    val workspaceFolderPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        workspaceFolderPickerShowing = false
        if (uri != null) model.grantWorkspaceFolderForLink(uri)
        else model.dismissWorkspaceFolderPrompt()
    }
    val pdf = rememberLauncherForActivityResult(NoteDestination("application/pdf", model::noteLocation)) { uri ->
        if (uri != null) { readerPdfOwnsProgress = true; model.setPdfDestination(uri); model.busy(true); web?.evaluateJavascript("window.supermdExport?.(${state.pdf})", null) ?: model.fail("The reader is not ready. Open the note again.") }
    }
    val portable = rememberLauncherForActivityResult(NoteDestination("application/vnd.supermd.smd", model::noteLocation)) { uri ->
        if (uri != null) { model.setPortableDestination(uri); model.busy(true); web?.evaluateJavascript("window.supermdPortable?.(false)", null) ?: model.fail("The reader is not ready") }
    }
    BindAgentExportHandler(activity = activity, model = model, activeNoteName = state.active.name, pdfOptionsJson = state.pdf)
    DisposableEffect(activity, open, save, model) {
        activity.setAgentUiHandler { request, reply ->
            if (request.optString("action") != "document_action") false
            else when (request.optString("documentAction")) {
                "open" -> if (request.optJSONObject("options")?.optBoolean("background", false) == true) {
                    reply(null, "Background file picking is unavailable on Android; open the file in Super MD first")
                    true
                } else { open.launch(arrayOf("text/*", "application/octet-stream", "application/vnd.supermd.smd", "application/vnd.supermd.fmd", "application/gzip", "application/x-gzip")); reply(JSONObject().put("accepted", true).put("message", "Choose a file in Android's document picker"), null); true }
                "save" -> false
                else -> false
            }
        }
        onDispose { activity.setAgentUiHandler(null) }
    }
    DisposableEffect(portable, state.active.name) { model.requestPortable = { portable.launch(noteStem(state.active.name).ifBlank { "Untitled" } + ".smd") }; onDispose { model.requestPortable = null } }
    DisposableEffect(save, portableSaveAs, model) {
        model.requestSaveAs = { note ->
            val stem = noteStem(note.name).ifBlank { "Untitled" }
            if (note.portable) portableSaveAs.launch("$stem.smd")
            else save.launch("$stem.md")
        }
        onDispose { model.requestSaveAs = null }
    }
    DisposableEffect(web, readerReady, model) {
        model.requestPortableWrite = if (readerReady && web != null) { saveInPlace ->
            model.busy(true)
            web?.evaluateJavascript("window.supermdPortable?.($saveInPlace)", null)
            true
        } else null
        onDispose { model.requestPortableWrite = null }
    }
    val saveAction: () -> Unit = { model.saveManual() }
    LaunchedEffect(state.message) { state.message?.let { snackbar.showSnackbar(it); model.dismissMessage() } }
    val immersive = (state.fullscreen || !readingChromeVisible || state.readerOverlay) && !settings
    LaunchedEffect(immersive, dark) {
        WindowCompat.getInsetsController(activity.window, activity.window.decorView).apply { isAppearanceLightStatusBars = !dark; isAppearanceLightNavigationBars = !dark; systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE; if (immersive) hide(WindowInsetsCompat.Type.systemBars()) else show(WindowInsetsCompat.Type.systemBars()) }
    }
    BackHandler(contentsShown || state.fullscreen || drawer.isOpen || state.readerOverlay) {
        if (contentsShown) {
            contentsShown = false
        } else if (drawer.isOpen) {
            if (state.folder != null && state.folderRelative.isNotEmpty() && model.navigateFolderUp()) {
                Unit
            } else {
                scope.launch { drawer.close() }
            }
        } else {
            web?.evaluateJavascript("window.supermdDismiss?.() || false") { dismissed -> if (dismissed != "true") model.fullscreen(false) }
        }
    }
    val palette = MaterialTheme.colorScheme
    val density = LocalDensity.current
    val tokens = remember(palette) { JSONObject().put("primary", hex(palette.primary)).put("on-primary", hex(palette.onPrimary)).put("primary-container",hex(palette.primaryContainer)).put("on-primary-container",hex(palette.onPrimaryContainer)).put("surface", hex(palette.surface)).put("surface-low", hex(palette.surfaceContainerLow)).put("surface-high", hex(palette.surfaceContainerHigh)).put("text", hex(palette.onSurface)).put("muted", hex(palette.onSurfaceVariant)).put("outline", hex(palette.outlineVariant)) }
    BoxWithConstraints(Modifier.fillMaxSize().background(palette.surface)) {
        // A phone in landscape is wide but still short. Keep its three single
        // pane modes; offer split only when both dimensions have tablet room.
        val displayIsLarge = if (Build.VERSION.SDK_INT >= 30) activity.windowManager.maximumWindowMetrics.bounds.let { minOf(it.width(), it.height()) / density.density >= 600f } else activity.resources.configuration.smallestScreenWidthDp >= 600
        val wide = displayIsLarge && maxWidth >= 720.dp && maxHeight >= 400.dp
        val actualMode = if (!wide && state.mode == "split") "live" else state.mode
        val imeVisible = WindowInsets.ime.getBottom(density) > 0
        val modalOpen = settings || exporting || renaming || contentsShown || folderSearch.visible || drawer.isOpen || (!accessPickerShowing && accessRequest != null) || state.pendingCloseNote != null || state.pendingSaveConflictNote != null || state.error != null || !state.welcomed
        val showFormattingBar = shouldShowKeyboardFormattingBar(actualMode, imeVisible, state.editorFocused, readerReady, state.readerOverlay, modalOpen)
        val triggerFormat = rememberUpdatedState<(String) -> Unit> { action ->
            val reader = web
            if (reader != null && readerReady) {
                if (!reader.hasFocus()) reader.requestFocus(View.FOCUS_DOWN)
                reader.evaluateJavascript("window.supermdFormat?.(${JSONObject.quote(action)}); true", null)
            }
        }
        val canFormatNow = rememberUpdatedState {
            canTriggerHardwareFormatShortcut(actualMode, state.editorFocused, readerReady, state.readerOverlay, modalOpen)
        }
        DisposableEffect(activity) {
            activity.formatDocument = { action -> triggerFormat.value(action) }
            activity.canFormatEditor = { canFormatNow.value() }
            onDispose {
                activity.formatDocument = null
                activity.canFormatEditor = null
            }
        }
        val readerContent=remember {arrayOfNulls<String>(1)}
        val sentAgentSeq = remember { mutableStateMapOf<String, Long>() }
        LaunchedEffect(readerReady, state.active, state.pendingHeading, actualMode, dark, state.fullscreen, state.font, state.size, state.widthPercent,state.lineHeight,state.spellCheck,state.grammarCheck,state.latexAutofix,state.typewriterScroll,state.restorePosition,state.centerLock,state.imageAppearance,state.svgAppearance,state.imageContrast,state.fullDocumentAccessibility,state.customTheme,state.patternKind,state.patternOpacity,state.patternSize,state.patternSpacing,tokens, hinge, motion, seededFind) {
            if (!readerReady) {
                readerNote[0] = null
                sentAgentSeq.clear()
            }
            if (readerReady && state.active.id.isNotEmpty()) {
                val note = state.active
                val pendingHeading = state.pendingHeading?.takeIf { it.noteId == note.id }
                val matchingSeed = seededFind?.takeIf { model.activeMatchesSeedTarget(note, it) }
                val lastSeq = sentAgentSeq[note.id] ?: 0L
                val unseenEdits = note.agentEdits.filter { it.seq > lastSeq }
                val payload = JSONObject().put("id", note.id).put("editProtocol", 1).apply {
                    if (readerNote[0] == note.id && (readerContent[0] === note.content || model.readerEcho[note.id] === note.content)) put("contentUnchanged", true)
                    else put("content", note.content)
                    if (note.agentUnreviewed) put("agentUnreviewed", true)
                    if (unseenEdits.isNotEmpty()) {
                        val editsJson = JSONArray()
                        unseenEdits.forEach { step ->
                            editsJson.put(JSONObject().put("seq", step.seq).put("before", step.before).put("after", step.after))
                        }
                        put("pendingAgentEdits", editsJson)
                    }
                }.put("path", note.uri ?: note.id).put("portable", note.portable).put("mode", actualMode).put("dark", dark).put("fullscreen", state.fullscreen).put("font", state.font).put("size", state.size).put("widthPercent",state.widthPercent).put("lineHeight",state.lineHeight).put("spellCheck",state.spellCheck).put("grammarCheck",state.grammarCheck).put("latexAutofix",state.latexAutofix).put("typewriterScroll",state.typewriterScroll).put("restorePosition",state.restorePosition).put("centerLock",state.centerLock).put("imageAppearance",state.imageAppearance).put("svgAppearance",state.svgAppearance).put("imageContrast",state.imageContrast).put("fullDocumentAccessibility",state.fullDocumentAccessibility).put("colors", tokens).put("zoom", state.zoom).put("motion", motion)
                if (pendingHeading != null) {
                    payload.put("pendingHeading", JSONObject().put("heading", pendingHeading.heading).put("token", pendingHeading.token))
                }
                payload.put("readingLocation",model.readingLocation(note.uri))
                payload.put("customStyle",themeStyle(themeDocument(state.customTheme),if(state.fullscreen)state.fullscreenTheme else state.theme,dark,state.patternKind,state.patternOpacity,state.patternSize,state.patternSpacing))
                if (matchingSeed != null) {
                    val seededJson = JSONObject()
                        .put("query", matchingSeed.query)
                        .put("caseSensitive", matchingSeed.caseSensitive)
                        .put("nonce", matchingSeed.nonce)
                    if (matchingSeed.sourceStart != null && matchingSeed.sourceEnd != null && matchingSeed.sourceStart >= 0 && matchingSeed.sourceEnd >= matchingSeed.sourceStart) {
                        seededJson.put("sourceStart", matchingSeed.sourceStart)
                        seededJson.put("sourceEnd", matchingSeed.sourceEnd)
                        if (!matchingSeed.matchText.isNullOrEmpty()) {
                            seededJson.put("matchText", matchingSeed.matchText)
                        }
                    }
                    payload.put("seededFind", seededJson)
                }
                web?.evaluateJavascript("document.documentElement.dataset.platform='android';window.supermdLoad?.($payload)", null)
                if (unseenEdits.isNotEmpty()) sentAgentSeq[note.id] = unseenEdits.maxOf { it.seq }
                if (pendingHeading != null) model.consumePendingHeading(pendingHeading.token)
                if (matchingSeed != null) {
                    model.consumeSeededFind(matchingSeed.nonce)
                }
                readerNote[0] = note.id
                readerContent[0] = note.content
                val hingeGap = if (hinge != null && actualMode == "split") hinge!!.bounds.width() / density.density else 0f
                web?.evaluateJavascript("document.querySelector('.android-document')?.style.setProperty('gap','${hingeGap}px')", null)
            }
        }
        LaunchedEffect(readerReady, state.zoomCommand) {
            if (readerReady) web?.evaluateJavascript("window.supermdSetZoom?.(${state.zoom},${state.zoomCommand})", null)
        }
        val headings by model.headings.collectAsStateWithLifecycle()
        val imageOverlay by model.imageOverlay.collectAsStateWithLifecycle()
        val chromeShown = !state.readerOverlay && !imageOverlay && (readingChromeVisible || state.activeConflicted)
        val chromeReveal by animateFloatAsState(if(chromeShown) 1f else 0f,
            animationSpec=tween(if(motion) 120 else 0),label="Reading chrome")
        LaunchedEffect(readerReady,chromeHeight) {
            if(readerReady) web?.evaluateJavascript("window.supermdChromeInset?.(${chromeHeight/density.density})",null)
        }
        // Navigation needs to avoid visible controls, but showing/hiding an
        // overlay must never resize the reader or change its first-note spacer.
        LaunchedEffect(readerReady,chromeHeight,chromeShown) {
            val visibleInset=if(chromeShown) chromeHeight/density.density else 0f
            if(readerReady) web?.evaluateJavascript("document.documentElement.style.setProperty('--native-visible-chrome-inset','${visibleInset}px')",null)
        }
        // Reader overlays (search, repair) hide the top bar and system bars, so
        // they anchor to the cutout-safe top edge, not the hidden chrome height.
        val safeTop = WindowInsets.displayCutout.getTop(density) / density.density
        LaunchedEffect(readerReady,safeTop) {
            if(readerReady) web?.evaluateJavascript("document.documentElement.style.setProperty('--native-safe-top','${safeTop}px')",null)
        }
        if (contentsShown) {
            ContentsBottomSheet(headings = headings, noteId = state.active.id, motion = motion, onDismiss = { contentsShown = false }) { heading ->
                if (actualMode in listOf("live", "reader") || state.fullscreen) readingChromeVisible = false
                web?.evaluateJavascript("window.supermdHeading?.(${JSONObject.quote(heading.id)},${heading.offset})", null)
                contentsShown = false
            }
        }
        // Closed-drawer drag recognition steals diagonal scrolls and pinch
        // gestures from WebView. Opening is deliberate (menu button); dragging
        // still dismisses an already-open drawer.
        ModalNavigationDrawer(drawerState = drawer, gesturesEnabled = drawer.isOpen && !state.fullscreen, drawerContent = {
            ModalDrawerSheet(modifier = Modifier.widthIn(max = 340.dp)) {
                FilesDrawerContent(
                    state = state,
                    recent = recent,
                    folderRelative = state.folderRelative,
                    onOpenNote = { open.launch(arrayOf("text/*", "application/octet-stream", "application/vnd.supermd.smd", "application/vnd.supermd.fmd", "application/gzip", "application/x-gzip")); scope.launch { drawer.close() } },
                    onOpenFolder = { folder.launch(state.folder?.let(android.net.Uri::parse)) },
                    onCloseFolder = model::closeFolder,
                    onFolderRoot = { model.navigateFolderUp() },
                    onNavigateFolderRelative = { rel -> state.folder?.let { model.listFolder(android.net.Uri.parse(it), rel) } },
                    onCreateInFolder = { req -> createFolderRequest = req },
                    onRenameEntry = { entry -> renameFolderTarget = entry },
                    onFolderSearch = { scope.launch { drawer.close() }; model.openFolderSearch() },
                    onActivateEntry = { entry ->
                        if (entry.directory) {
                            model.listFolder(android.net.Uri.parse(state.folder ?: entry.uri), entry.relative)
                        } else {
                            activity.requestOpen(android.net.Uri.parse(entry.uri), entry.relative)
                            scope.launch { drawer.close() }
                        }
                    },
                    onClearRecent = model::clearRecent,
                    onOpenRecent = { note -> activity.requestOpen(android.net.Uri.parse(note.uri), note.relative); scope.launch { drawer.close() } },
                    onPinRecent = { note -> model.pinRecent(note.uri) },
                )
            }
        }) {
            // Measure chrome even when hidden, but place it in a separate layer.
            // Its visibility must never resize/recreate the WebView underneath.
            Box(Modifier.fillMaxSize().imePadding().clipToBounds()) {
                    Column(Modifier.fillMaxWidth().zIndex(2f).onSizeChanged {chromeHeight=it.height}
                        .graphicsLayer {translationY=-size.height*(1f-chromeReveal);alpha=chromeReveal}
                        .then(if(chromeShown) Modifier else Modifier.clearAndSetSemantics {})
                        .background(palette.surfaceContainerLow).themeArtwork(state,"toolbar")) {
                        val pillUi = resolveAgentStatusPillUi(
                            accessEnabled = activity.agentAccessEnabled,
                            relayState = activity.agentRelayState,
                            retrying = activity.agentRelayRetrying,
                        )
                        val activeNeedsAccess = state.writeNeedsAccess(state.active.id) || model.documentWriteNeedsAccess(state.active.id)
                        StudioTopBar(
                            noteName = state.active.name,
                            statusLabel = if (activeNeedsAccess) "Local draft · restore file access" else if (state.activeConflicted) "Changed on disk · autosave paused" else if (state.active.dirty) "Draft recovered automatically" else if (state.active.uri != null) "Saved" else "Local draft",
                            onRestoreAccess = if (activeNeedsAccess) ({ model.requestWriteAccessIfBlocked(state.active.id, explicit = true) }) else null,
                            fullscreen = state.fullscreen,
                            wide = wide,
                            actualMode = actualMode,
                            centerLock = state.centerLock,
                            readerReady = readerReady,
                            busy = state.busy,
                            menuExpanded = menu,
                            onMenuExpandedChange = { menu = it },
                            onNavigateIcon = {
                                if (state.fullscreen) contentsShown = true
                                else {
                                    scope.launch { drawer.open() }
                                    state.folder?.let { if (state.files.isEmpty()) model.listFolder(android.net.Uri.parse(it), state.folderRelative) }
                                }
                            },
                            onFolderSearch = { model.openFolderSearch() },
                            onFind = { activity.openReaderFind?.invoke(false) },
                            onSave = saveAction,
                            onExport = { sharing = false; exporting = true },
                            onToggleFullscreen = { model.fullscreen(!state.fullscreen) },
                            onToggleCenterLock = { model.centerLock(!state.centerLock) },
                            canReopenClosedTab = state.closedTabs.isNotEmpty(),
                            onReopenClosedTab = model::reopen,
                            onSaveAs = model::beginSaveAs,
                            onNewWindow = activity::newWindow,
                            onShare = { sharing = true; exporting = true },
                            onInsertMedia = { web?.evaluateJavascript("window.supermdMedia?.()", null) },
                            onFixLatex = { web?.evaluateJavascript("window.supermdRepairMath?.()", null) },
                            onRename = { renaming = true },
                            onSettings = { settingsSection = null; settings = true },
                            agentPillUi = pillUi,
                            onAgentStatusClick = { settingsSection = "Agent connection"; settings = true },
                        )
                        if(!state.fullscreen) NoteTabs(state.tabs, state.active.id, motion, model::select, model::requestClose, model::reorder, model::newNote)
                        val jumpNote = state.agentJumpTabId?.takeIf { it != state.active.id }?.let { jumpId -> state.tabs.firstOrNull { it.id == jumpId } }
                        if (!state.fullscreen && jumpNote != null) {
                            Surface(
                                color = palette.secondaryContainer.copy(alpha = 0.85f),
                                contentColor = palette.onSecondaryContainer,
                                shape = RoundedCornerShape(14.dp),
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(horizontal = 12.dp, vertical = 4.dp)
                                    .testTag("agentJumpBanner"),
                            ) {
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    modifier = Modifier.padding(start = 12.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
                                ) {
                                    Text(
                                        "AI updated ${jumpNote.name} in background",
                                        style = MaterialTheme.typography.labelLarge,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                        modifier = Modifier.weight(1f),
                                    )
                                    TextButton(
                                        onClick = { model.select(jumpNote.id) },
                                        modifier = Modifier.testTag("agentJumpButton"),
                                    ) {
                                        Text("Jump", fontWeight = FontWeight.SemiBold)
                                    }
                                    IconButton(
                                        onClick = model::dismissAgentJump,
                                        modifier = Modifier.size(36.dp).testTag("agentJumpDismiss"),
                                    ) {
                                        Icon(painterResource(R.drawable.symbol_close), "Dismiss agent notification", Modifier.size(18.dp))
                                    }
                                }
                            }
                        }
                        if(!state.fullscreen) StudioModeBar(
                            wide = wide,
                            actualMode = actualMode,
                            centerLock = state.centerLock,
                            readerReady = readerReady,
                            onShowContents = { contentsShown = true },
                            onSelectMode = model::mode,
                            onUndo = { web?.evaluateJavascript("window.supermdHistory?.('undo')", null) },
                            onRedo = { web?.evaluateJavascript("window.supermdHistory?.('redo')", null) },
                            onEnterFullscreen = { model.fullscreen(true) },
                            onToggleCenterLock = { model.centerLock(!state.centerLock) },
                        )
                        if (state.activeConflicted) {
                            ConflictBanner(
                                busy = state.busy,
                                onSaveAs = { model.beginSaveAs() },
                                onReload = { model.reloadFromDisk() },
                                onOverwrite = { model.saveManual(forceOverwrite = true) },
                            )
                        }
                        HorizontalDivider(color = palette.outlineVariant.copy(alpha = .55f))
                    }
                // The reading surface is edge-to-edge in BOTH chrome states.
                // Only controls receive safe insets, not the document width.
                val handleExternalDrop = rememberUpdatedState<(WebView, android.view.DragEvent) -> Unit> { reader, event ->
                    if (shouldBlockNativeDrop(
                            model.state.value,
                            folderSearchVisible = model.folderSearch.value.visible,
                            accessRequestOpen = model.documentAccessRequests.value != null,
                            settingsOpen = settings,
                            exporting = exporting,
                            renaming = renaming,
                            contentsShown = contentsShown,
                            drawerOpen = drawer.isOpen,
                        )) {
                        return@rememberUpdatedState
                    }
                    val permissions = activity.requestDragAndDropPermissions(event)
                    val uris = extractDroppedFileUris(event.clipData)
                    if (uris.isNotEmpty()) {
                        val id = model.state.value.active.id
                        val currentDensity = reader.resources.displayMetrics.density.takeIf { it > 0f } ?: density.density
                        val x = event.x / currentDensity
                        val y = event.y / currentDensity
                        reader.evaluateJavascript("window.supermdCaptureInsertion?.($x,$y)", null)
                        model.importDropped(uris, id) { images ->
                            permissions?.release()
                            images?.let { reader.evaluateJavascript("window.supermdInsertImages?.($it)", null) }
                        }
                    } else {
                        permissions?.release()
                        if ((event.clipData?.itemCount ?: 0) > 0) {
                            model.importDropped(emptyList(), model.state.value.active.id) {}
                        }
                    }
                }
                Column(Modifier.fillMaxSize()) { Box(Modifier.fillMaxWidth().weight(1f)) {
                    key(readerGeneration) { AndroidView(factory = { context -> FrameLayout(context).apply {
                        layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                        clipChildren = true
                        clipToPadding = true
                        addView(SelectionReaderWebView(context, model).apply {
                            // Percentage-height HTML needs MATCH_PARENT, not
                            // WRAP_CONTENT. The native container also confines
                            // WebView's accelerated drawing to the reading pane.
                            layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                            web = this
                            setOnKeyListener { _, _, event -> activity.handleShortcut(event) }
                            setBackgroundColor(AndroidColor.TRANSPARENT)
                            configureReader(this, model, scope, ready = { if (web === this) readerReady = true }, onAgentReply = activity::deliverAgentReply, onAgentExport = activity::requestAgentExport, rendererGone = { failedView ->
                                val wasCurrent = web === failedView
                                retireAndDestroyReader(failedView)
                                if (wasCurrent) {
                                    readerReady = false
                                    readerPdfOwnsProgress = false
                                    model.editorFocus(false)
                                    readerNote[0] = null
                                    sentAgentSeq.clear()
                                    readerGeneration++
                                    web = null
                                    scope.launch {
                                        snackbar.showSnackbar("The reader restarted. Changes already received by Super MD were restored; an edit still in transit may be missing.")
                                    }
                                }
                            })
                            var touchY=0f
                            var downX=0f
                            var downY=0f
                            var downTime=0L
                            var moved=false
                            var multiTouch=false
                            var chromeIntent:Boolean?=null
                            var gestureEpoch=0L
                            var gestureActive=false
                            setOnTouchListener {_,event->
                                if(event.actionMasked==android.view.MotionEvent.ACTION_DOWN) {
                                    chromeTapJob[0]?.cancel()
                                    gestureEpoch++
                                    gestureActive=true
                                    touchY=event.rawY
                                    downX=event.x;downY=event.y;downTime=event.eventTime;moved=false
                                    multiTouch=false
                                    chromeIntent=null
                                }
                                if(event.actionMasked==android.view.MotionEvent.ACTION_POINTER_DOWN) {multiTouch=true;chromeIntent=null}
                                if(event.actionMasked==android.view.MotionEvent.ACTION_MOVE && !multiTouch && event.pointerCount==1 && model.state.value.mode in listOf("live","reader") && !model.state.value.readerOverlay) {
                                    if(kotlin.math.hypot(event.x-downX,event.y-downY)>8*density.density)moved=true
                                    val travel=event.rawY-touchY
                                    if(kotlin.math.abs(travel)>36*density.density){chromeIntent=travel>0;touchY=event.rawY}
                                }
                                // Never resize the viewport under an active
                                // gesture, selection handle or live editor.
                                if(event.actionMasked==android.view.MotionEvent.ACTION_UP && !multiTouch) {
                                    gestureActive=false
                                    val completedEpoch=gestureEpoch
                                    val show=chromeIntent
                                    val tap=!moved && event.eventTime-downTime<350 && model.state.value.mode in listOf("live","reader") && !model.state.value.readerOverlay
                                    if(show!=null || tap) {
                                        val x=event.x/density.density;val y=event.y/density.density
                                        chromeTapJob[0]=scope.launch {
                                            if(tap)delay(260)
                                            evaluateJavascript("(() => { const e=document.elementFromPoint($x,$y); return !!document.querySelector('.live-active-block textarea:focus') || !!window.getSelection()?.toString() || ${if(tap) "!!e?.closest('a,button,input,textarea,summary,img,.note-image,[data-independent-zoom],.interactive-chart,.media-dialog,.reading-search,.math-repair-panel,.reader-agent-banner')" else "false"}; })()") { interacting ->
                                                if(interacting!="true" && !gestureActive && completedEpoch==gestureEpoch) {
                                                    readingChromeAfterGesture(model.state.value.fullscreen, readingChromeVisible, show, tap)?.let { readingChromeVisible=it }
                                                }
                                            }
                                        }
                                    }
                                }
                                if(event.actionMasked==android.view.MotionEvent.ACTION_UP || event.actionMasked==android.view.MotionEvent.ACTION_CANCEL)gestureActive=false
                                false
                            }
                            webChromeClient = object : android.webkit.WebChromeClient() {
                                override fun onShowFileChooser(view: WebView, callback: android.webkit.ValueCallback<Array<android.net.Uri>>, parameters: FileChooserParams): Boolean {
                                    imageCallback?.onReceiveValue(null); imageCallback = callback; imageNote = model.state.value.active.id
                                    imagePicker.launch(arrayOf("image/*")); return true
                                }
                            }
                            setOnDragListener(ExternalDropDragController { event ->
                                handleExternalDrop.value(this, event)
                            })
                        })
                    } }, modifier = Modifier.fillMaxSize().clipToBounds(), onRelease = { frame ->
                        val released = frame.getChildAt(0) as? WebView
                        if (released != null) {
                            if (web === released) { web = null; readerReady = false; model.editorFocus(false) }
                            retireAndDestroyReader(released)
                        }
                        frame.removeAllViews()
                    }) }
                    SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).safeDrawingPadding())
                    if (shouldShowNativeBusyOverlay(state.busy, readerReady, readerPdfOwnsProgress)) Surface(color = palette.surface.copy(alpha = .96f), modifier = Modifier.fillMaxSize()) { Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) { if(motion) LoadingIndicator() else Icon(Icons.Rounded.Description,null,Modifier.size(48.dp),tint=palette.primary); Spacer(Modifier.height(16.dp)); Text(if(state.busy) "Preparing your document…" else "Opening your workspace…") } }
                }
                if (showFormattingBar) KeyboardFormattingBar(onFormat = { triggerFormat.value(it) }) }
            }
        }
    }
    if (settings) {
        BackHandler { if (settingsSection != null) settingsSection = null else { settings = false; settingsSection = null } }
        Surface(Modifier.fillMaxSize(), color = palette.surface) { Column(Modifier.fillMaxSize().safeDrawingPadding()) {
            TopAppBar(title = { Text(settingsSection ?: "Settings") }, navigationIcon = { IconButton(onClick = { if (settingsSection != null) settingsSection = null else { settings = false; settingsSection = null } }) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "Back") } })
            Settings(state, model, activity, noteLocation, settingsSection, { settingsSection = it }, {noteFolder.launch(noteLocation.takeIf{it.isNotBlank()}?.let(android.net.Uri::parse))}, {model.recoverDeletedDraft();settings=false;settingsSection=null}, {themePicker.launch(arrayOf("application/json","text/plain","application/octet-stream"))}, {themeExport.launch("My theme.supermd-theme.json")}, {settings=false;settingsSection=null;web?.evaluateJavascript("window.supermdThemeGuide?.()",null)}, readerReady) {fontPicker.launch(arrayOf("font/ttf","font/otf","application/x-font-ttf","application/vnd.ms-opentype","application/octet-stream"))}
        } }
    }
    FolderActionDialogs(
        state = state,
        model = model,
        createRequest = createFolderRequest,
        onDismissCreate = { createFolderRequest = null },
        onNoteCreated = { scope.launch { drawer.close() } },
        renameTarget = renameFolderTarget,
        onDismissRename = { renameFolderTarget = null },
    )
    // Long forms must not strand their primary action below a half-open sheet.
    if (renaming) {
        val initialStem = remember(state.active.id, state.active.name) {
            if (noteExtension(state.active.name).isNotEmpty()) noteStem(state.active.name) else state.active.name
        }
        var name by rememberSaveable(state.active.id, state.active.name) { mutableStateOf(initialStem) }
        var renameError by remember(state.active.id, state.active.name) { mutableStateOf<String?>(null) }
        var renameBusy by remember(state.active.id, state.active.name) { mutableStateOf(false) }
        AlertDialog(
            onDismissRequest = { if (!renameBusy) renaming = false },
            title = { Text("Rename note") },
            text = {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it; renameError = null },
                    enabled = !renameBusy,
                    singleLine = true,
                    isError = renameError != null,
                    label = { Text("Note name") },
                    supportingText = renameError?.let { err -> { Text(err, color = MaterialTheme.colorScheme.error) } },
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        renameBusy = true
                        renameError = null
                        model.rename(state.active.id, name, showGlobalError = false) { ok, err ->
                            renameBusy = false
                            if (ok) renaming = false else renameError = err
                        }
                    },
                    enabled = !renameBusy && name.isNotBlank(),
                ) { Text("Rename") }
            },
            dismissButton = { TextButton(enabled = !renameBusy, onClick = { renaming = false }) { Text("Cancel") } },
        )
    }
    if (exporting) ModalBottomSheet(onDismissRequest = { exporting = false }, sheetState = rememberBottomSheetState(initialValue = SheetValue.Hidden, enabledValues = setOf(SheetValue.Hidden, SheetValue.Expanded))) { ExportSettings(state.pdf, model::pdf, sharing = sharing, fonts = state.customFonts, noteLocation = noteLocation) { format ->
        exporting = false
        if (format in listOf("md", "mdzip")) {
            val archive = format == "mdzip"
            if (model.prepareMarkdownExport(sharing, archive)) web?.evaluateJavascript("window.supermdExportMarkdown?.($archive)", null) ?: model.fail("The reader is not ready")
        } else if (sharing) {
            if (model.prepareShare(format)) {
                if (format == "pdf") readerPdfOwnsProgress = true
                when (format) { "pdf" -> web?.evaluateJavascript("window.supermdExport?.(${state.pdf})", null) ?: model.fail("The reader is not ready"); "smd" -> web?.evaluateJavascript("window.supermdPortable?.(false)", null) ?: model.fail("The reader is not ready") }
            }
        } else {
            val stem = noteStem(state.active.name).ifBlank { "Untitled" }
            if (format == "smd") portable.launch("$stem.smd") else pdf.launch("$stem.pdf")
        }
    } }
    if (!accessPickerShowing) accessRequest?.let { request ->
        AlertDialog(onDismissRequest = model::dismissDocumentAccess,
            title = { Text(if (request.assetSource == null) "Restore file access" else "Allow linked file access") },
            text = { Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(request.name, style = MaterialTheme.typography.titleSmall)
                Text(request.detail ?: if(request.assetSource == null) DOCUMENT_ACCESS_MESSAGE else LINKED_ASSET_ACCESS_MESSAGE)
                if (request.assetSource == null && request.noteId == state.active.id) TextButton(onClick = {
                    model.dismissDocumentAccess()
                    model.beginSaveAs()
                }) { Text("Save a copy instead") }
            } },
            confirmButton = { TextButton(onClick = { accessPickerShowing = true; accessPicker.launch(android.net.Uri.parse(request.uri)) }) { Text(if(request.assetSource == null) "Choose original file" else "Choose linked file") } },
            dismissButton = { TextButton(onClick = model::dismissDocumentAccess) { Text("Not now") } })
    }
    if (!workspaceFolderPickerShowing) state.folderAccessPrompt?.let { prompt ->
        AlertDialog(
            onDismissRequest = model::dismissWorkspaceFolderPrompt,
            title = { Text("Allow folder access for note links") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(prompt.noteName, style = MaterialTheme.typography.titleSmall)
                    Text("Super MD needs permission for the folder containing this note to open linked notes like \"${prompt.target}\". Your current note and edits remain untouched.")
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    workspaceFolderPickerShowing = true
                    workspaceFolderPicker.launch(prompt.initialUri)
                }) { Text("Choose folder") }
            },
            dismissButton = {
                TextButton(onClick = model::dismissWorkspaceFolderPrompt) { Text("Not now") }
            },
        )
    }
    if (folderSearch.visible) {
        BackHandler { model.cancelWorkspaceSearch() }
        FolderSearchModal(
            state = folderSearch,
            hasFolder = state.folder != null,
            onUpdate = model::updateFolderSearch,
            onSelect = model::openSearchMatch,
            onDismiss = model::cancelWorkspaceSearch,
        )
    }
    state.pendingCloseNote?.let { note ->
        AlertDialog(
            onDismissRequest = model::dismissCloseConfirmation,
            title = { Text("Save changes to ${note.name}?") },
            text = { Text("Save your changes before closing, or discard them.") },
            confirmButton = {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = { model.resolveCloseConfirmation("discard") }) { Text("Discard") }
                    Button(onClick = { model.resolveCloseConfirmation("save") }) { Text("Save") }
                }
            },
            dismissButton = {
                TextButton(onClick = { model.resolveCloseConfirmation("cancel") }) { Text("Cancel") }
            },
        )
    }
    state.pendingSaveConflictNote?.let { note ->
        AlertDialog(
            onDismissRequest = model::dismissSaveConflict,
            icon = { Icon(painterResource(R.drawable.symbol_warning), null, tint = MaterialTheme.colorScheme.error) },
            title = { Text("${note.name} changed on disk") },
            text = { Text("This note was modified outside Super MD since you opened or last saved it. Save a copy to keep both versions, or overwrite the file on disk.") },
            confirmButton = {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = { model.resolveSaveConflict("overwrite") }) { Text("Overwrite") }
                    Button(onClick = { model.resolveSaveConflict("save_as") }) { Text("Save as") }
                }
            },
            dismissButton = {
                TextButton(onClick = { model.resolveSaveConflict("cancel") }) { Text("Cancel") }
            },
        )
    }
    state.error?.let { AlertDialog(onDismissRequest = model::dismissError, title = { Text("Couldn't finish") }, text = { Text(it, Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState())) }, confirmButton = { TextButton(onClick = model::dismissError) { Text("OK") } }) }
    if (!state.welcomed) WelcomeSetup(state, model) { model.welcomeDone(); open.launch(arrayOf("text/*", "application/octet-stream", "application/vnd.supermd.smd", "application/vnd.supermd.fmd", "application/gzip", "application/x-gzip")) }
}

internal fun buildHighlightedSnippet(
    snippet: String,
    matchStart: Int,
    matchEnd: Int,
    highlightColor: Color,
): AnnotatedString {
    val safeStart = clampUtf16Boundary(snippet, matchStart)
    val safeEnd = clampUtf16Boundary(snippet, matchEnd).coerceAtLeast(safeStart)
    if (safeEnd <= safeStart) return AnnotatedString(snippet)
    return buildAnnotatedString {
        append(snippet.substring(0, safeStart))
        withStyle(
            SpanStyle(
                color = highlightColor,
                background = highlightColor.copy(alpha = 0.18f),
                fontWeight = FontWeight.SemiBold,
            ),
        ) {
            append(snippet.substring(safeStart, safeEnd))
        }
        append(snippet.substring(safeEnd))
    }
}

@Composable internal fun FolderSearchModal(
    state: FolderSearchState,
    hasFolder: Boolean,
    onUpdate: (String, Boolean, Boolean) -> Unit,
    onSelect: (FolderSearchMatch) -> Unit,
    onDismiss: () -> Unit,
) {
    val focusRequester = remember { FocusRequester() }
    var selectedIndex by remember(state.matches) { mutableIntStateOf(0) }
    val highlightColor = MaterialTheme.colorScheme.primary
    LaunchedEffect(Unit) { runCatching { focusRequester.requestFocus() } }
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(
            shape = RoundedCornerShape(28.dp),
            color = MaterialTheme.colorScheme.surfaceContainerHigh,
            tonalElevation = 6.dp,
            modifier = Modifier
                .widthIn(max = 680.dp)
                .fillMaxWidth(0.95f)
                .heightIn(max = 580.dp)
                .onPreviewKeyEvent { event ->
                    if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                    when (event.key) {
                        Key.Escape -> { onDismiss(); true }
                        Key.DirectionDown -> {
                            if (state.matches.isNotEmpty()) selectedIndex = (selectedIndex + 1).coerceAtMost(state.matches.lastIndex)
                            true
                        }
                        Key.DirectionUp -> {
                            if (state.matches.isNotEmpty()) selectedIndex = (selectedIndex - 1).coerceAtLeast(0)
                            true
                        }
                        Key.Enter, Key.NumPadEnter -> {
                            state.matches.getOrNull(selectedIndex)?.let(onSelect)
                            true
                        }
                        else -> false
                    }
                },
        ) {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Search across notes", style = MaterialTheme.typography.titleLarge)
                        Text(
                            if (hasFolder) "Streams live tabs and folder notes (.md, .smd, .fmd, .markdown, .txt)"
                            else "No folder open · searching open tabs and accessible recent notes",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    TextButton(onClick = onDismiss) { Text("Close") }
                }
                OutlinedTextField(
                    value = state.query,
                    onValueChange = { onUpdate(it, state.caseSensitive, state.includeDiagrams) },
                    singleLine = true,
                    placeholder = { Text("Search text across notes…") },
                    leadingIcon = { Icon(Icons.Rounded.Search, null) },
                    trailingIcon = {
                        if (state.query.isNotEmpty()) {
                            IconButton(onClick = { onUpdate("", state.caseSensitive, state.includeDiagrams) }) {
                                Icon(Icons.Rounded.Close, "Clear query")
                            }
                        }
                    },
                    modifier = Modifier.fillMaxWidth().focusRequester(focusRequester),
                )
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    FilterChip(
                        selected = state.caseSensitive,
                        onClick = { onUpdate(state.query, !state.caseSensitive, state.includeDiagrams) },
                        label = { Text("Match case") },
                    )
                    FilterChip(
                        selected = state.includeDiagrams,
                        onClick = { onUpdate(state.query, state.caseSensitive, !state.includeDiagrams) },
                        label = { Text("Diagrams") },
                    )
                    Spacer(Modifier.weight(1f))
                    if (state.query.isNotEmpty()) {
                        Text(
                            if (state.scanning) "Scanning · ${state.matches.size} (${state.scannedFiles} files)…"
                            else "${state.matches.size}${if (state.truncated) "+" else ""} in ${state.scannedFiles} files",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                if (state.scanning) LinearProgressIndicator(Modifier.fillMaxWidth())
                if (state.query.isEmpty()) {
                    Text(
                        "Type to search Markdown prose across notes. Inline SVG, Mermaid, and chart blocks are skipped unless Diagrams is enabled.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(vertical = 12.dp),
                    )
                } else if (!state.scanning && state.matches.isEmpty()) {
                    Text(
                        "No matches found.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(vertical = 16.dp),
                    )
                } else {
                    LazyColumn(Modifier.weight(1f, fill = false), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        items(state.matches.size, key = { state.matches[it].key }) { index ->
                            val match = state.matches[index]
                            val selected = index == selectedIndex
                            val annotatedSnippet = remember(match.snippet, match.matchStart, match.matchEnd, highlightColor) {
                                buildHighlightedSnippet(match.snippet, match.matchStart, match.matchEnd, highlightColor)
                            }
                            Surface(
                                shape = RoundedCornerShape(16.dp),
                                color = if (selected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainerLow,
                                modifier = Modifier.fillMaxWidth().clickable { onSelect(match) },
                            ) {
                                Column(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                        Text(match.relative, style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                                        if (match.dirty) {
                                            Text("Edited", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                                        }
                                        Surface(shape = RoundedCornerShape(999.dp), color = MaterialTheme.colorScheme.secondaryContainer) {
                                            Text(
                                                "L${match.line}",
                                                style = MaterialTheme.typography.labelSmall,
                                                color = MaterialTheme.colorScheme.onSecondaryContainer,
                                                modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
                                            )
                                        }
                                    }
                                    Text(
                                        text = annotatedSnippet,
                                        style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                                        maxLines = 2,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable private fun WelcomeSetup(state: StudioState, model: StudioViewModel, open: () -> Unit) {
    var step by rememberSaveable { mutableIntStateOf(0) }
    AlertDialog(onDismissRequest = {}, icon = { Icon(Icons.AutoMirrored.Rounded.MenuBook, null, Modifier.size(40.dp), tint = MaterialTheme.colorScheme.primary) },
        title = { Text(listOf("Welcome to Super MD", "Make it comfortable", "Your next clear thought")[step]) },
        text = { Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState())) {
            Text("${step + 1} of 3", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
            Spacer(Modifier.height(16.dp))
            when (step) {
                0 -> { Text("A calm place for notes, equations and ideas. Ordinary files, no vault, no account."); Spacer(Modifier.height(16.dp)); Text("Write in Live, edit precisely in Source, or settle into Read. Tablets also have Split.") }
                1 -> { Choice("Appearance", state.theme, listOf("system" to "System", "light" to "Light", "dark" to "Dark", "black" to "Black")) { model.appearance(theme = it) }; Choice("Reading font", state.font, listOf("sans" to "Sans", "serif" to "Serif", "mono" to "Mono")) { model.appearance(font = it) }; Row(verticalAlignment = Alignment.CenterVertically) { Text("Expressive motion", Modifier.weight(1f)); Switch(state.motion, { model.appearance(motion = it) }) } }
                else -> { Text("Explore equations, sliders and diagrams in the sample. PDFs are typeset locally, including on this device."); Spacer(Modifier.height(16.dp)); Text("Python runs only when you press Run. Only run code you trust.", fontWeight = FontWeight.Medium); Spacer(Modifier.height(16.dp)); Text("For images beside a note, open its containing folder to grant Android permission.") }
            }
        } },
        confirmButton = { Button(onClick = { if (step < 2) step++ else model.welcomeDone() }) { Text(if (step < 2) "Continue" else "Explore the sample") } },
        dismissButton = { if (step > 0) TextButton(onClick = { if (step == 2) open() else step-- }) { Text(if (step == 2) "Open a note" else "Back") } })
}

@Composable private fun ConflictBanner(
    busy: Boolean,
    onSaveAs: () -> Unit,
    onReload: () -> Unit,
    onOverwrite: () -> Unit,
) {
    val palette = MaterialTheme.colorScheme
    Surface(
        color = palette.errorContainer,
        contentColor = palette.onErrorContainer,
        shape = RoundedCornerShape(16.dp),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
    ) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Icon(painterResource(R.drawable.symbol_warning), null, Modifier.size(20.dp), tint = palette.onErrorContainer)
                Column(Modifier.weight(1f)) {
                    Text("Changed on disk", style = MaterialTheme.typography.titleSmall)
                    Text("This file was modified outside Super MD. Autosave is paused for this tab.", style = MaterialTheme.typography.bodySmall)
                }
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                FilledTonalButton(onClick = onSaveAs, enabled = !busy) { Text("Save as") }
                OutlinedButton(onClick = onReload, enabled = !busy) { Text("Reload from disk") }
                TextButton(onClick = onOverwrite, enabled = !busy) { Text("Overwrite") }
            }
        }
    }
}

@Composable internal fun StudioTopBar(
    noteName: String,
    statusLabel: String,
    fullscreen: Boolean,
    wide: Boolean,
    actualMode: String,
    centerLock: Boolean,
    readerReady: Boolean,
    busy: Boolean,
    menuExpanded: Boolean,
    onMenuExpandedChange: (Boolean) -> Unit,
    onNavigateIcon: () -> Unit,
    onFind: () -> Unit,
    onSave: () -> Unit,
    onExport: () -> Unit,
    onToggleFullscreen: () -> Unit,
    onToggleCenterLock: () -> Unit,
    canReopenClosedTab: Boolean = false,
    onReopenClosedTab: () -> Unit = {},
    onSaveAs: () -> Unit = {},
    onNewWindow: () -> Unit,
    onShare: () -> Unit,
    onInsertMedia: () -> Unit,
    onFixLatex: () -> Unit,
    onRename: () -> Unit,
    onSettings: () -> Unit,
    onFolderSearch: () -> Unit = {},
    agentPillUi: AgentStatusPillUi = AgentStatusPillUi(visible = false, label = "", stateKey = "off"),
    onAgentStatusClick: () -> Unit = {},
    onRestoreAccess: (() -> Unit)? = null,
) {
    val palette = MaterialTheme.colorScheme
    TopAppBar(
        windowInsets = WindowInsets.statusBarsIgnoringVisibility.union(WindowInsets.displayCutout).only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal),
        colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
        title = {
            Column(
                Modifier
                    .fillMaxWidth()
                    .then(
                        if (onRestoreAccess != null) {
                            Modifier.heightIn(min = 48.dp).clickable(onClick = onRestoreAccess)
                        } else {
                            Modifier
                        },
                    ),
                verticalArrangement = Arrangement.Center,
            ) {
                Text(noteName, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleMedium)
                Text(statusLabel, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelSmall, color = palette.onSurfaceVariant)
            }
        },
        navigationIcon = {
            IconButton(onClick = onNavigateIcon, modifier = Modifier.size(48.dp)) {
                Icon(painterResource(if (fullscreen) R.drawable.symbol_contents else R.drawable.symbol_sidebar), if (fullscreen) "Show contents" else "Open files")
            }
        },
        actions = {
            if (agentPillUi.visible) {
                val agentPillDotColor = when (agentPillUi.stateKey) {
                    "connected" -> Color(0xff2e7d32)
                    "retrying", "connecting" -> Color(0xffef6c00)
                    else -> palette.error
                }
                Surface(
                    onClick = { onMenuExpandedChange(false); onAgentStatusClick() },
                    shape = RoundedCornerShape(999.dp),
                    color = if (agentPillUi.stateKey == "connected") palette.primaryContainer else palette.surfaceContainerHigh,
                    contentColor = if (agentPillUi.stateKey == "connected") palette.onPrimaryContainer else palette.onSurface,
                    modifier = Modifier
                        .padding(end = 4.dp)
                        .semantics { contentDescription = agentPillUi.label }
                        .testTag("agentStatusPill"),
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        modifier = Modifier.padding(horizontal = if (wide) 10.dp else 8.dp, vertical = 6.dp),
                    ) {
                        Box(Modifier.size(8.dp).background(agentPillDotColor, RoundedCornerShape(999.dp)))
                        Text(if (wide) agentPillUi.label else "AI", style = MaterialTheme.typography.labelMedium, maxLines = 1)
                    }
                }
            }
            StudyIcon("Find in note", R.drawable.symbol_search, enabled = readerReady, action = onFind)
            IconButton(onClick = onSave, modifier = Modifier.size(48.dp)) { Icon(painterResource(R.drawable.symbol_save), "Save note") }
            IconButton(onClick = onExport, enabled = readerReady && !busy, modifier = Modifier.size(48.dp)) { Icon(painterResource(R.drawable.symbol_export), "Export") }
            if (fullscreen || (wide && actualMode != "reader")) {
                StudyIcon(if (fullscreen) "Exit fullscreen" else "Fullscreen study", if (fullscreen) R.drawable.symbol_fullscreen_exit else R.drawable.symbol_fullscreen, action = onToggleFullscreen)
                StudyIcon(if (centerLock) "Centre locked · unlock horizontal movement" else "Lock document to centre", if (centerLock) R.drawable.symbol_lock else R.drawable.symbol_lock_open, action = onToggleCenterLock)
            }
            Box {
                IconButton(onClick = { onMenuExpandedChange(true) }, modifier = Modifier.size(48.dp)) { Icon(Icons.Rounded.MoreVert, "More actions") }
                DropdownMenu(expanded = menuExpanded, onDismissRequest = { onMenuExpandedChange(false) }) {
                    DropdownMenuItem(text = { Text("Reopen closed tab") }, enabled = canReopenClosedTab, onClick = { onMenuExpandedChange(false); onReopenClosedTab() }, leadingIcon = { Icon(painterResource(R.drawable.symbol_undo), null) })
                    DropdownMenuItem(text = { Text("Save as") }, enabled = !busy, onClick = { onMenuExpandedChange(false); onSaveAs() }, leadingIcon = { Icon(painterResource(R.drawable.symbol_save), null) })
                    HorizontalDivider()
                    DropdownMenuItem(text = { Text("New window") }, onClick = { onMenuExpandedChange(false); onNewWindow() }, leadingIcon = { Icon(painterResource(R.drawable.symbol_open_window), null) })
                    DropdownMenuItem(text = { Text("Share note") }, enabled = readerReady && !busy, onClick = { onMenuExpandedChange(false); onShare() }, leadingIcon = { Icon(painterResource(R.drawable.symbol_share), null) })
                    DropdownMenuItem(text = { Text("Insert image or link") }, onClick = { onMenuExpandedChange(false); onInsertMedia() }, leadingIcon = { Icon(painterResource(R.drawable.symbol_image), null) })
                    DropdownMenuItem(text = { Text("Fix LaTeX") }, onClick = { onMenuExpandedChange(false); onFixLatex() }, leadingIcon = { Icon(painterResource(R.drawable.symbol_bug), null) })
                    DropdownMenuItem(text = { Text("Rename note") }, onClick = { onMenuExpandedChange(false); onRename() }, leadingIcon = { Icon(painterResource(R.drawable.symbol_rename), null) })
                    DropdownMenuItem(text = { Text("Settings") }, onClick = { onMenuExpandedChange(false); onSettings() }, leadingIcon = { Icon(painterResource(R.drawable.symbol_settings), null) })
                }
            }
        }
    )
}

@Composable internal fun StudioModeBar(
    wide: Boolean,
    actualMode: String,
    centerLock: Boolean,
    readerReady: Boolean,
    onShowContents: () -> Unit,
    onSelectMode: (String) -> Unit,
    onUndo: () -> Unit,
    onRedo: () -> Unit,
    onEnterFullscreen: () -> Unit,
    onToggleCenterLock: () -> Unit,
) {
    val palette = MaterialTheme.colorScheme
    val modes = if (wide) listOf("live", "editor", "reader", "split") else listOf("live", "editor", "reader")
    Row(Modifier.fillMaxWidth().padding(horizontal = if (wide) 24.dp else 8.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        StudyIcon("Show contents", R.drawable.symbol_contents, action = onShowContents)
        Spacer(Modifier.width(4.dp))
        SingleChoiceSegmentedButtonRow(Modifier.weight(1f)) {
            modes.forEachIndexed { index, mode ->
                SegmentedButton(
                    selected = actualMode == mode,
                    onClick = { onSelectMode(mode) },
                    icon = {},
                    contentPadding = PaddingValues(horizontal = 8.dp, vertical = 8.dp),
                    colors = SegmentedButtonDefaults.colors(activeContainerColor = palette.primary, activeContentColor = palette.onPrimary),
                    shape = SegmentedButtonDefaults.itemShape(index, modes.size),
                    modifier = Modifier.heightIn(min = 48.dp),
                ) {
                    Text(
                        when (mode) { "editor" -> "Source"; "reader" -> "Read"; "split" -> "Split"; else -> "Live" },
                        maxLines = 1,
                        softWrap = false,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
        Spacer(Modifier.width(4.dp))
        if (actualMode == "reader") {
            StudyIcon("Fullscreen study", R.drawable.symbol_fullscreen, action = onEnterFullscreen)
            StudyIcon(if (centerLock) "Centre locked · unlock horizontal movement" else "Lock document to centre", if (centerLock) R.drawable.symbol_lock else R.drawable.symbol_lock_open, action = onToggleCenterLock)
        } else {
            IconButton(onClick = onUndo, enabled = readerReady, modifier = Modifier.size(48.dp)) { Icon(Icons.AutoMirrored.Rounded.Undo, "Undo (Ctrl+Z)") }
            IconButton(onClick = onRedo, enabled = readerReady, modifier = Modifier.size(48.dp)) { Icon(Icons.AutoMirrored.Rounded.Redo, "Redo (Ctrl+Y)") }
        }
    }
}

@Composable internal fun ContentsBottomSheet(
    headings: List<OutlineHeading>,
    noteId: String,
    motion: Boolean = isSystemMotionEnabled(LocalContext.current),
    onDismiss: () -> Unit,
    onNavigate: (OutlineHeading) -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberBottomSheetState(initialValue = SheetValue.Hidden, enabledValues = setOf(SheetValue.Hidden, SheetValue.Expanded))) {
        ContentsSheetContent(headings = headings, noteId = noteId, motion = motion, onNavigate = onNavigate)
    }
}

@Composable internal fun ContentsSheetContent(
    headings: List<OutlineHeading>,
    noteId: String,
    motion: Boolean = isSystemMotionEnabled(LocalContext.current),
    onNavigate: (OutlineHeading) -> Unit,
) {
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
        Column(Modifier.widthIn(max = 640.dp).fillMaxWidth().navigationBarsPadding().padding(horizontal = 16.dp).padding(bottom = 16.dp)) {
            Text("Contents", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(horizontal = 8.dp, vertical = 8.dp))
            OutlinePanel(headings, noteId, Modifier.weight(1f, fill = false), motion = motion, navigate = onNavigate)
        }
    }
}

@Composable internal fun FilesDrawerContent(
    state: StudioState,
    recent: List<RecentNote>,
    folderRelative: String = state.folderRelative,
    onOpenNote: () -> Unit,
    onOpenFolder: () -> Unit,
    onCloseFolder: () -> Unit,
    onFolderRoot: () -> Unit,
    onActivateEntry: (FileEntry) -> Unit,
    onClearRecent: () -> Unit,
    onOpenRecent: (RecentNote) -> Unit,
    onPinRecent: (RecentNote) -> Unit,
    onNavigateFolderRelative: (String) -> Unit = { onFolderRoot() },
    onCreateInFolder: (CreateFolderRequest) -> Unit = {},
    onRenameEntry: (FileEntry) -> Unit = {},
    modifier: Modifier = Modifier,
    onFolderSearch: () -> Unit = {},
) {
    val palette = MaterialTheme.colorScheme
    LazyColumn(
        modifier = modifier.fillMaxSize().themeArtwork(state, "sidebar").safeDrawingPadding(),
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
    ) {
        item(key = "header") {
            Text("Your files", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(vertical = 8.dp))
        }
        item(key = "file-actions") {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = onOpenNote, shapes = ButtonDefaults.shapes(), modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                    Icon(Icons.Rounded.Description, null); Spacer(Modifier.width(8.dp)); Text("Open note")
                }
                FilledTonalButton(onClick = onOpenFolder, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                    Icon(Icons.Rounded.FolderOpen, null); Spacer(Modifier.width(8.dp)); Text("Open folder")
                }
                OutlinedButton(onClick = onFolderSearch, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                    Icon(Icons.Rounded.Search, null, Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("Search across notes", maxLines = 1)
                }
                if (state.folder != null) {
                    FolderDrawerHeader(
                        folderUriRaw = state.folder,
                        folderRelative = folderRelative,
                        onNavigateRelative = onNavigateFolderRelative,
                        onRequestCreate = onCreateInFolder,
                        onCloseFolder = onCloseFolder,
                    )
                }
                Text("No vault. No hidden metadata.", style = MaterialTheme.typography.bodySmall, color = palette.onSurfaceVariant, modifier = Modifier.padding(vertical = 4.dp))
            }
        }
        folderFileItems(
            files = state.files,
            activeUri = state.active.uri,
            onActivate = onActivateEntry,
            onCreateInFolder = onCreateInFolder,
            onRename = onRenameEntry,
        )
        if (recent.isNotEmpty()) {
            item(key = "recent-header") {
                Column {
                    HorizontalDivider(Modifier.padding(vertical = 8.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("Recent notes", Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
                        TextButton(onClick = onClearRecent, modifier = Modifier.heightIn(min = 48.dp)) { Text("Clear unpinned") }
                    }
                }
            }
            items(recent, key = { "recent:${it.uri}" }) { note ->
                Box(Modifier.padding(vertical = 3.dp)) {
                    RecentNoteCard(
                        note = note,
                        selected = state.active.uri == note.uri,
                        onOpen = { onOpenRecent(note) },
                        onPin = { onPinRecent(note) },
                    )
                }
            }
        }
    }
}

@Composable private fun StudyIcon(label:String, resource:Int, enabled:Boolean=true, action:()->Unit) {
    TooltipBox(positionProvider=TooltipDefaults.rememberTooltipPositionProvider(TooltipAnchorPosition.Above),tooltip={PlainTooltip{Text(label)}},state=rememberTooltipState()) {
        IconButton(onClick=action, enabled=enabled, modifier=Modifier.size(48.dp)) {Icon(painterResource(resource),label,Modifier.size(24.dp))}
    }
}
private fun hex(color: Color) = "#%06x".format(color.toArgb() and 0xffffff)

@Composable private fun Settings(state: StudioState, model: StudioViewModel, activity:MainActivity, noteLocation: String, section: String?, onSection: (String?)->Unit, chooseNoteLocation: ()->Unit, recoverDraft:()->Unit, importTheme:()->Unit, exportTheme:()->Unit, showThemeGuide:()->Unit, themeGuideReady:Boolean, importFont: ()->Unit) {
    val update by model.updates.state.collectAsStateWithLifecycle()
    val scope=rememberCoroutineScope()
    var confirmPythonCleanup by remember { mutableStateOf(false) }
    if (confirmPythonCleanup) AlertDialog(
        onDismissRequest = { confirmPythonCleanup = false },
        title = { Text("Clear temporary Python results?") },
        text = { Text("This deletes app-generated Python plots and execution previews. Saved notes, recovery drafts, exported files and installed Python are not deleted. Re-run a Python cell to regenerate missing previews.") },
        confirmButton = { TextButton(onClick = { confirmPythonCleanup = false; model.clearPythonStorage() }) { Text("Clear results") } },
        dismissButton = { TextButton(onClick = { confirmPythonCleanup = false }) { Text("Cancel") } },
    )
    val downloadPermission=rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()){granted->
        if(update.ready) { if(granted)scope.launch{model.updates.saveToDownloads()} else model.updates.storagePermissionDenied() }
        else scope.launch{model.updates.download()}
    }
    if (section == null) {
        SettingsHome(onOpen = onSection)
    } else {
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()), horizontalAlignment = Alignment.CenterHorizontally) {
        Column(Modifier.widthIn(max = 760.dp).fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            if (section == "Appearance") SettingsGroup("Workspace appearance") {
                Text("System follows your wallpaper colors. Fullscreen can have a different theme.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Choice("Workspace theme", state.theme, listOf("system" to "System", "light" to "Light", "dark" to "Dark", "black" to "Pure black")) { model.appearance(theme = it) }
                Choice("Fullscreen theme", state.fullscreenTheme, listOf("system" to "System", "light" to "Light", "dark" to "Dark", "black" to "Pure black")) { model.appearance(fullTheme = it) }
                if(state.customTheme.isBlank())Choice("Theme color",state.accent,listOf("system" to "System","blue" to "Blue","violet" to "Violet","rose" to "Rose","amber" to "Amber")){model.appearance(accent=it)}
                else Text("Colors follow your active custom theme. Reset it to use the built-in accent picker.",style=MaterialTheme.typography.bodySmall)
                Row(verticalAlignment = Alignment.CenterVertically) { Column(Modifier.weight(1f)) { Text("Expressive motion", style = MaterialTheme.typography.titleMedium); Text("Spring transitions and responsive controls", style = MaterialTheme.typography.bodySmall) }; Switch(checked = state.motion, onCheckedChange = { model.appearance(motion = it) }) }
            }
            if (section == "Appearance") SettingsGroup("Custom theme") {
                val activeThemeName = themeDocument(state.customTheme)?.optString("name") ?: "Built-in appearance"
                val bundledPresets = remember { bundledThemes(activity.assets) }
                val presetChoices = remember(bundledPresets) { listOf("builtin" to "Built-in appearance") + bundledPresets.map { it.id to it.name } }
                Text(activeThemeName,style=MaterialTheme.typography.titleMedium)
                Text("Choose a bundled preset or import your own JSON theme to customize controls, colors, reading typography and background patterns. Reading font and text size remain yours.",style=MaterialTheme.typography.bodySmall)
                ThemePresetChoice(
                    label = "Theme preset",
                    activeKind = state.activeThemeKind,
                    activeId = state.activeThemeId,
                    activeName = activeThemeName,
                    choices = presetChoices,
                    change = model::selectBundledTheme,
                )
                if (state.savedThemes.isNotEmpty()) {
                    Text("Saved imported themes", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 8.dp, bottom = 4.dp))
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        state.savedThemes.forEach { entry ->
                            val selected = state.activeThemeKind == "saved" && state.activeThemeId == entry.id
                            Surface(
                                shape = RoundedCornerShape(18.dp),
                                color = if (selected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainerHigh,
                                modifier = Modifier.fillMaxWidth().clickable { model.selectSavedTheme(entry.id) },
                            ) {
                                Row(
                                    modifier = Modifier.fillMaxWidth().padding(start = 14.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Icon(
                                        imageVector = if (selected) Icons.Rounded.Check else Icons.Rounded.FolderOpen,
                                        contentDescription = null,
                                        tint = if (selected) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurfaceVariant,
                                        modifier = Modifier.size(20.dp),
                                    )
                                    Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                                        Text(
                                            entry.name,
                                            style = MaterialTheme.typography.bodyLarge,
                                            fontWeight = FontWeight.Medium,
                                            color = if (selected) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurface,
                                            maxLines = 1,
                                            overflow = TextOverflow.Ellipsis,
                                        )
                                        if (entry.sourceUri.isNotBlank()) {
                                            Text(
                                                "Linked external file",
                                                style = MaterialTheme.typography.bodySmall,
                                                color = if (selected) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurfaceVariant,
                                                maxLines = 1,
                                                overflow = TextOverflow.Ellipsis,
                                            )
                                        }
                                    }
                                    IconButton(onClick = { model.deleteSavedTheme(entry.id) }) {
                                        Icon(
                                            imageVector = Icons.Rounded.Close,
                                            contentDescription = "Remove ${entry.name}",
                                            tint = if (selected) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurfaceVariant,
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
                FlowRow(horizontalArrangement=Arrangement.spacedBy(8.dp)){FilledTonalButton(onClick=importTheme){Text("Import theme…")};OutlinedButton(onClick=exportTheme){Text(if(state.customTheme.isBlank())"Export template…" else "Export theme…")};if(state.customTheme.isNotBlank())OutlinedButton(onClick={model.shareCustomTheme {send->runCatching {activity.startActivity(Intent.createChooser(send,"Share theme"))}.onFailure {model.fail("No app could share the theme: ${it.message}")}}}){Text("Share theme…")}}
                if(state.customTheme.isNotBlank())FlowRow(horizontalArrangement=Arrangement.spacedBy(8.dp)){if(state.customThemeSource.isNotBlank())TextButton(onClick=model::reloadCustomTheme){Text("Reload file")};TextButton(onClick=model::resetCustomTheme){Text("Reset to built-in")}}
                if(state.customTheme.isNotBlank()) {
                    val themeAppearance=themeStyle(themeDocument(state.customTheme),state.theme,when(state.theme){"dark","black"->true;"light"->false;else->androidx.compose.foundation.isSystemInDarkTheme()},state.patternKind,state.patternOpacity,state.patternSize,state.patternSpacing)
                    val background=themeAppearance.optJSONObject("background")?:JSONObject()
                    Text("Reading background",style=MaterialTheme.typography.titleMedium)
                    Choice("Pattern",background.optString("pattern","none"),listOf("none" to "None","paws" to "Cat paws","dots" to "Dots","grid" to "Grid","diagonal" to "Diagonal","gradient" to "Gradient")){model.readingPreference("patternKind",it)}
                    Text("Visibility · ${(background.optDouble("opacity",.06)*100).toInt()}%")
                    StudySlider(value=background.optDouble("opacity",.06).toFloat(),onCommit={model.themeBackgroundPreference("patternOpacity",it)},valueRange=0f..0.25f)
                    if(background.optString("pattern")=="paws") {
                        Text("Paw size · ${background.optInt("size",24)} px")
                        StudySlider(value=background.optDouble("size",24.0).toFloat(),onCommit={model.themeBackgroundPreference("patternSize",it)},valueRange=8f..64f)
                    }
                    if(background.optString("pattern")!="gradient") {
                        Text("Pattern spacing · ${background.optInt("spacing",24)} px")
                        StudySlider(value=background.optDouble("spacing",24.0).toFloat(),onCommit={model.themeBackgroundPreference("patternSpacing",it)},valueRange=12f..192f)
                    }
                    Text("Viewing only. Your theme file, notes and PDF exports are unchanged.",style=MaterialTheme.typography.bodySmall)
                    TextButton(onClick=model::resetThemeBackground){Text("Use theme's background settings")}
                }
                Text("Edit the exported JSON with an editor or AI, then import it. Providers that support notifications update automatically; otherwise tap Reload.",style=MaterialTheme.typography.bodySmall)
                TextButton(enabled=themeGuideReady,onClick=showThemeGuide){Text("Theme authoring guide")}
            }
            if (section == "Reading & media") SettingsGroup("Reading") {
                Row(verticalAlignment=Alignment.CenterVertically){Text("Continue from last reading position",Modifier.weight(1f));Switch(state.restorePosition,model::restorePosition)}
                Row(verticalAlignment=Alignment.CenterVertically){Text("Full document accessibility",Modifier.weight(1f));Switch(state.fullDocumentAccessibility,model::fullDocumentAccessibility)}
                Text("Keeps the complete document in the semantic tree for assistive technology and browser Find. Large notes may use substantially more memory.",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
                FontChoice("Reading font", if(state.font=="sans") "Manrope" else state.font, listOf("Manrope" to "Manrope", "roboto" to "Roboto", "noto" to "Noto Sans", "serif" to "Noto Serif", "mono" to "JetBrains Mono", "system" to "System")+state.customFonts.map {it to it}) { model.appearance(font = it) }
                FilledTonalButton(onClick=importFont){Text("Import font…")}
                Text("Text size · ${state.size.toInt()} px", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 16.dp))
                StudySlider(value = state.size, onCommit = { model.appearance(size = it) }, valueRange = 6f..32f)
                Text("Reading width · ${state.widthPercent.toInt()}%",style=MaterialTheme.typography.titleSmall)
                StudySlider(value=state.widthPercent,onCommit={model.reading(widthPercent=it)},valueRange=50f..150f)
                Text("Vertical spacing · ${"%.2f".format(state.lineHeight)}",style=MaterialTheme.typography.titleSmall)
                StudySlider(value=state.lineHeight,onCommit={model.reading(lineHeight=it)},valueRange=1.15f..2.2f)
                Text("Width adapts to this window and fullscreen. Pinch text, images and plots independently.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (section == "Reading & media") SettingsGroup("Images & diagrams") {
                val choices=listOf("original" to "Original (off)","invert-dark" to "Invert in dark themes","auto" to "Auto adapt to theme","monochrome" to "Theme monochrome","contrast" to "Separate from theme")
                Choice("Image appearance",state.imageAppearance,choices){model.readingPreference("imageAppearance",it)}
                Choice("Diagram appearance (SVG, Mermaid & charts)",state.svgAppearance,choices){model.readingPreference("svgAppearance",it)}
                Text("Separation strength · ${"%.2f".format(state.imageContrast)}")
                StudySlider(value=state.imageContrast,onCommit=model::imageContrast,valueRange=1f..2f)
                Text("Auto adapts neutral ink and paper, preserving readable colours. Theme monochrome recolours the whole image. Separation preserves original colours and adds a readable backing and edge. Original files and PDF exports are unchanged.",style=MaterialTheme.typography.bodySmall)
            }
            if (section == "Files & startup") SettingsGroup("File handling") {
                OutlinedButton(onClick=recoverDraft) {Text("Recover latest deleted draft")}
                Choice("On startup",state.startup,listOf("restore" to "Restore previous tabs","new" to "New blank note")){model.readingPreference("startup",it)}
                Text("Unsaved drafts are recovered in either mode. Welcome is shown only on first use.",style=MaterialTheme.typography.bodySmall)
                Row(verticalAlignment=Alignment.CenterVertically){Text("Autosave existing notes",Modifier.weight(1f));Switch(checked=state.autosave,onCheckedChange={model.reading(autosave=it)})}
                Text("New note location",style=MaterialTheme.typography.titleSmall)
                FilledTonalButton(onClick=chooseNoteLocation,modifier=Modifier.fillMaxWidth()){Icon(Icons.Rounded.FolderOpen,null);Text(if(noteLocation.isBlank())"Downloads" else android.net.Uri.decode(noteLocation.substringAfterLast('/')),Modifier.padding(start=8.dp),maxLines=1,overflow=TextOverflow.Ellipsis)}
            }
            if (section == "Writing & shortcuts") SettingsGroup("Writing") {
                Row(verticalAlignment=Alignment.CenterVertically){Text("Typewriter scrolling",Modifier.weight(1f));Switch(checked=state.typewriterScroll,onCheckedChange=model::typewriterScroll)}
                Text("Off by default. Vertically centers the active line in Source, Split and Live while typing.",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
                Row(verticalAlignment=Alignment.CenterVertically){Text("Spell check",Modifier.weight(1f));Switch(checked=state.spellCheck,onCheckedChange={model.writing(spellCheck=it)})}
                Row(verticalAlignment=Alignment.CenterVertically){Text("Grammar check",Modifier.weight(1f));Switch(checked=state.grammarCheck,onCheckedChange={model.writing(grammarCheck=it)})}
                Row(verticalAlignment=Alignment.CenterVertically){Text("LaTeX autofix on paste",Modifier.weight(1f));Switch(checked=state.latexAutofix,onCheckedChange=model::latexAutofix)}
                Text("Off by default. Repairs validated LaTeX errors in pasted text in Source and Live. Code, links and existing formula fragments are protected; Undo restores the paste.",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
                Text("Offline English suggestions in Source and Live editing. Grammar checks repeated words and a/an. Code, links and LaTeX are excluded; no text is uploaded or automatically replaced.",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (section == "Writing & shortcuts") SettingsGroup("Selected text") {
                Choice("Selection assistant", state.selectionAssistant, SelectionActions.assistants, model::selectionAssistant)
                Text("Select text and use Search Google or Ask in the selection toolbar. Ask copies the text and opens the assistant for you to paste and review; it never submits a prompt automatically.",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (section == "Writing & shortcuts") SettingsGroup("Python & windows") {
                Text("Hardware keyboard shortcuts: Ctrl+Shift+F searches across notes, Ctrl+F finds in the current note, and Esc dismisses overlays.", style = MaterialTheme.typography.bodyMedium)
                Text("NumPy and Matplotlib run locally in a separate worker. Code runs only when you press Run; never automatically on open or export.", style = MaterialTheme.typography.bodyMedium)
                Text("New window opens an independent workspace. Your device controls split-screen and desktop window placement. Hold and drag a tab to reorder it.", style = MaterialTheme.typography.bodyMedium)
                Text("The monochrome icon follows your launcher's themed-icon setting.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (section == "Agent connection") SettingsGroup("Live Agent Access") { AgentAccessSettings(activity) }
            if (section == "Storage") SettingsGroup("Storage diagnostics") {
                Text("Inspect app-owned storage sizes and file counts. Clean only generated Python previews with confirmation; notes, exports and recovery are protected.", style = MaterialTheme.typography.bodyMedium)
                FilledTonalButton(onClick = model::inspectStorage, enabled = !state.storageScanning) {
                    Text(if (state.storageScanning) "Inspecting…" else "Inspect storage")
                }
                if (state.storageScanning) LinearProgressIndicator(Modifier.fillMaxWidth())
                state.storageReport?.let { report ->
                    Text("Retained app data", style = MaterialTheme.typography.titleSmall)
                    report.retained.filterNot { it.label == "Execution results" }.forEach { StorageUsageLine(it) }
                    Text("Execution results", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 8.dp))
                    StorageUsageLine(report.executionResults)
                    StorageUsageLine(report.legacyExecutionResults)
                    OutlinedButton(
                        onClick = { confirmPythonCleanup = true },
                        enabled = !state.storageScanning && report.executionResults.files + report.legacyExecutionResults.files > 0,
                    ) { Text("Clear temporary Python results…") }

                    Text("Other cache", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 8.dp))
                    StorageUsageLine(report.otherCache)
                    if (report.partial) Text("Some entries could not be measured or were skipped; totals may be incomplete. No files were changed.", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
                }
            }
            if (section == "Updates & about") SettingsGroup("About & updates") {
                Text("Super MD ${BuildConfig.VERSION_NAME}",style=MaterialTheme.typography.titleMedium)
                Text("© Yash Mahawar · MIT License",style=MaterialTheme.typography.bodySmall)
                Row(verticalAlignment=Alignment.CenterVertically){Text("Check for updates on opening",Modifier.weight(1f));Switch(update.checkOnOpen,{model.updates.preference(checkOnOpen=it)})}
                Row(verticalAlignment=Alignment.CenterVertically){Text("Automatically download updates",Modifier.weight(1f));Switch(update.automatic,{model.updates.preference(automatic=it)})}
                Text("Only published release APKs, verified against the release checksum and signing certificate. Downloads are remembered between launches and saved in Downloads → Super MD. Android asks for approval; the app's installer copies are removed after a successful upgrade, not after cancellation.",color=MaterialTheme.colorScheme.onSurfaceVariant)
                if(update.status.isNotBlank())Text(update.status)
                FilledTonalButton(onClick={scope.launch{model.updates.check()}},enabled=!update.checking){Text("Check for updates")}
                if(update.version!=null)Button(onClick={if(update.ready)runCatching{model.updates.install(activity)}.onFailure{model.fail(it.message ?: "Could not open installer")} else if(Build.VERSION.SDK_INT<=28 && activity.checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE)!=android.content.pm.PackageManager.PERMISSION_GRANTED)downloadPermission.launch(android.Manifest.permission.WRITE_EXTERNAL_STORAGE) else scope.launch{model.updates.download()}},enabled=!update.checking){Text(if(update.ready)"Install update" else "Download update")}
                if(update.ready && !update.publicCopy)TextButton(onClick={if(Build.VERSION.SDK_INT<=28 && activity.checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE)!=android.content.pm.PackageManager.PERMISSION_GRANTED)downloadPermission.launch(android.Manifest.permission.WRITE_EXTERNAL_STORAGE) else scope.launch{model.updates.saveToDownloads()}},enabled=!update.checking){Text("Save verified APK to Downloads")}
                OutlinedButton(onClick = {
                    runCatching { activity.startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse("https://github.com/YashMahawa/super-md/releases/latest"))) }
                        .onFailure { model.fail("Could not open GitHub releases: " + it.message) }
                }) { Text("Open latest release on GitHub") }
                TextButton(onClick={activity.startActivity(Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(android.provider.Settings.EXTRA_APP_PACKAGE,activity.packageName))}){Text("Update notification permissions")}
            }
        }
    }
    }
}

@Composable private fun AgentAccessSettings(activity: MainActivity) {
    val scope = rememberCoroutineScope()
    val saved = activity.agentAccessState.currentConfig()
    var origin by remember { mutableStateOf(saved?.serverOrigin.orEmpty()) }
    var message by remember { mutableStateOf("") }
    var pendingPairingFile by remember { mutableStateOf<String?>(null) }
    var pendingGuide by remember { mutableStateOf<String?>(null) }
    var pendingSkillArchive by remember { mutableStateOf<ByteArray?>(null) }
    var enabled by remember { mutableStateOf(activity.agentAccessState.enabled) }
    fun revokeThen(action: () -> Unit) {
        message = "Disconnecting and revoking previous device registrations…"
        activity.revokeAgentAccess { confirmed ->
            enabled = false
            action()
            if (!confirmed) message = "Local credentials were erased, but the relay could not confirm revocation. A previously copied device key may remain usable until the relay expires or restarts."
        }
    }
    fun joinWorkspace(text: String) {
        runCatching { activity.agentAccessState.joinPairingFile(text) }
            .onSuccess { config -> enabled = false; origin = config.serverOrigin; activity.refreshAgentRelay(); message = "This Android device joined the workspace. Switch Live Agent Access on when you want it connected. Keep the pairing file private." }
            .onFailure { message = "Could not join workspace: ${it.message}" }
    }
    val pairingExport = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri ->
        val raw = pendingPairingFile
        pendingPairingFile = null
        if (uri != null && raw != null) runCatching {
            activity.contentResolver.openOutputStream(uri, "w")?.use { it.write(raw.toByteArray(Charsets.UTF_8)); it.flush() }
                ?: error("Android could not write the pairing file")
        }.onSuccess { message = "Trusted pairing file saved. Share it only with a device you trust." }
            .onFailure { message = "Could not save pairing file: ${it.message}" }
    }
    fun createWorkspace() {
        runCatching { activity.agentAccessState.createPairingFile(origin) }
            .onSuccess { pendingPairingFile = it; origin = activity.agentAccessState.currentConfig()?.serverOrigin.orEmpty(); activity.refreshAgentRelay(); pairingExport.launch("SuperMD-pairing.json") }
            .onFailure { message = "Could not create workspace: ${it.message}" }
    }
    val pairingImport = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) scope.launch {
            val raw = runCatching { withContext(Dispatchers.IO) {
                activity.contentResolver.openInputStream(uri)?.use { input ->
                    val bytes = ByteArray(8 * 1024 + 1); val count = input.read(bytes)
                    require(count in 1..8 * 1024) { "Pairing file is empty or too large" }
                    String(bytes, 0, count, Charsets.UTF_8)
                } ?: error("The pairing file cannot be read")
            } }
            raw.onSuccess { text ->
                if (activity.agentAccessState.currentConfig() != null) revokeThen { joinWorkspace(text) }
                else joinWorkspace(text)
            }
                .onFailure { message = "Could not read pairing file: ${it.message}" }
        }
    }
    val guideExport = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("text/markdown")) { uri ->
        val guide = pendingGuide
        pendingGuide = null
        if (uri != null && guide != null) runCatching {
            activity.contentResolver.openOutputStream(uri, "w")?.use { it.write(guide.toByteArray(Charsets.UTF_8)); it.flush() }
                ?: error("Android could not write the setup guide")
        }.onSuccess { message = "Setup instructions saved." }
            .onFailure { message = "Could not save setup guide: ${it.message}" }
    }
    val skillExport = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/zip")) { uri ->
        val archive = pendingSkillArchive
        pendingSkillArchive = null
        if (uri != null && archive != null) runCatching {
            activity.contentResolver.openOutputStream(uri, "w")?.use { it.write(archive); it.flush() }
                ?: error("Android could not write the skill package")
        }.onSuccess { message = "Skill package saved." }
            .onFailure { message = "Could not save skill package: ${it.message}" }
    }
    val config = activity.agentConfigForThisWindow() ?: activity.agentAccessState.currentConfig()
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("Enter your own Super MD relay server or import a trusted pairing file. Connect an AI client to currently open tabs on this device. Access is off by default; the relay does not store notes.", style = MaterialTheme.typography.bodyMedium)
        OutlinedTextField(value = origin, onValueChange = { origin = it }, modifier = Modifier.fillMaxWidth(), singleLine = true,
            label = { Text("HTTPS relay origin") }, placeholder = { Text("https://relay.example.com") })
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Live Agent Access", style = MaterialTheme.typography.titleSmall)
                Text(if (enabled) "${activity.agentRelayState.name.lowercase().replaceFirstChar(Char::uppercase)} · reconnects while this app is open" else "Off · the device will not connect to the relay", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Switch(checked = enabled, enabled = config != null, onCheckedChange = { checked ->
                enabled = checked
                activity.agentAccessState.setEnabled(checked)
                activity.refreshAgentRelay()
            })
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            FilledTonalButton(enabled = origin.isNotBlank(), onClick = {
                if (activity.agentAccessState.currentConfig() != null) revokeThen(::createWorkspace) else createWorkspace()
            }) { Text("Create workspace & export pairing file") }
            OutlinedButton(onClick = { pairingImport.launch(arrayOf("application/json", "application/octet-stream", "text/plain")) }) { Text("Join from pairing file…") }
            OutlinedButton(enabled = config != null, onClick = {
                val file = activity.agentAccessState.currentPairingFile()
                if (file == null) message = "Create or join a workspace first"
                else { pendingPairingFile = file; pairingExport.launch("SuperMD-pairing.json") }
            }) { Text("Export trusted pairing file…") }
            OutlinedButton(onClick = {
                runCatching { activity.assets.open("web/super-md-skill.zip").use { it.readBytes() } }
                    .onSuccess { bytes -> pendingSkillArchive = bytes; skillExport.launch("super-md-skill.zip") }
                    .onFailure { message = "Could not load skill package: ${it.message}" }
            }) { Text("Export skill package (.zip)…") }
        }
        if (config != null) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = {
                    val clipboard = activity.getSystemService(android.content.ClipboardManager::class.java)
                    clipboard.setPrimaryClip(android.content.ClipData.newPlainText("Super MD MCP connector", config.mcpUrl))
                    message = "Private MCP connector URL copied. Share it only with the intended AI client."
                }) { Text("Copy private MCP URL") }
                TextButton(onClick = {
                    val skill = runCatching { activity.assets.open("web/super-md-agent-SKILL.md").bufferedReader().use { it.readText() } }.getOrNull()
                    pendingGuide = AgentSetupGuide.instructions(config, skill)
                    guideExport.launch("SuperMD-Live-Agent-setup.md")
                }) { Text("Save setup instructions…") }
            }
        }
        Text("The pairing file authorizes trusted devices; it is not for an AI client. Give the AI client only the private MCP URL. Each phone or open app window gets its own device key. Turning Live Agent Access off disconnects this app. Revoke removes this device from the relay and erases this device's credentials.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (config != null) TextButton(onClick = {
            message = "Disconnecting and revoking device registrations…"
            activity.revokeAgentAccess { confirmed ->
                enabled = false
                message = if (confirmed) "Live Agent access revoked on this device and the relay confirmed removal."
                    else "Local credentials were erased, but the relay could not confirm revocation. A previously copied device key may remain usable until the relay expires or restarts."
                activity.refreshAgentRelay()
            }
        }) { Text("Revoke this device's Live Agent access") }
        if (message.isNotBlank()) Text(message, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
    }
}

@Composable private fun StorageUsageLine(usage: StorageCategoryUsage) {
    Column(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(usage.label, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
            Text("${usage.files} files · ${formatStorageBytes(usage.bytes)}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (usage.skippedEntries > 0) Text("${usage.skippedEntries} entries skipped or unreadable", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable private fun SearchableChoice(
    label: String,
    selectedKey: String,
    summary: String,
    choices: List<Pair<String, String>>,
    searchLabel: String,
    emptyLabel: String,
    topPadding: androidx.compose.ui.unit.Dp = 12.dp,
    change: (String) -> Unit,
) {
    var opened by remember { mutableStateOf(false) }
    Text(label, style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = topPadding, bottom = 6.dp))
    FilledTonalButton(onClick = { opened = true }, modifier = Modifier.fillMaxWidth()) {
        Text(summary, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
        Icon(Icons.Rounded.ExpandMore, null)
    }
    if (opened) {
        var query by remember { mutableStateOf("") }
        val matches = remember(query, choices) { choices.distinctBy { it.first }.filter { it.second.contains(query.trim(), ignoreCase = true) } }
        AlertDialog(onDismissRequest = { opened = false }, title = { Text(label) }, text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(value = query, onValueChange = { query = it }, singleLine = true, label = { Text(searchLabel) }, leadingIcon = { Icon(Icons.Rounded.Search, null) }, modifier = Modifier.fillMaxWidth())
                if (matches.isEmpty()) Text(emptyLabel, color = MaterialTheme.colorScheme.onSurfaceVariant)
                LazyColumn(Modifier.heightIn(max = 340.dp)) {
                    items(matches, key = { it.first }) { (key, name) ->
                        val selected = key == selectedKey
                        ListItem(trailingContent = { if (selected) Icon(Icons.Rounded.Check, "Selected") }, colors = ListItemDefaults.colors(containerColor = if (selected) MaterialTheme.colorScheme.primaryContainer else Color.Transparent), modifier = Modifier.clickable { change(key); opened = false }) { Text(name) }
                    }
                }
            }
        }, confirmButton = { TextButton(onClick = { opened = false }) { Text("Cancel") } })
    }
}

@Composable private fun ThemePresetChoice(label: String, activeKind: String, activeId: String, activeName: String, choices: List<Pair<String,String>>, change: (String) -> Unit) {
    val selectedKey = when (activeKind) {
        "preset" -> activeId
        "saved" -> ""
        else -> "builtin"
    }
    val summary = when (activeKind) {
        "saved" -> "Imported · $activeName"
        "preset" -> choices.find { it.first == activeId }?.second ?: activeName
        else -> "Built-in appearance"
    }
    SearchableChoice(label, selectedKey, summary, choices, "Search themes", "No matching themes", topPadding = 8.dp, change = change)
}

@Composable internal fun FontChoice(label: String, value: String, choices: List<Pair<String,String>>, change: (String) -> Unit) {
    SearchableChoice(label, value, choices.find { it.first == value }?.second ?: value, choices, "Search fonts", "No matching fonts", change = change)
}

@Composable private fun SettingsHome(onOpen: (String?)->Unit) {
    val categories = listOf(
        "Appearance" to "Themes, colors, motion and custom theme files",
        "Reading & media" to "Typography, reading layout, images and diagrams",
        "Files & startup" to "Autosave, startup behavior, note location and recovery",
        "Writing & shortcuts" to "Spelling, LaTeX, selected text and Python",
        "Agent connection" to "Pair and manage local agent access",
        "Storage" to "Inspect app-owned storage",
        "Updates & about" to "Release updates, notifications and app details"
    )
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()), horizontalAlignment = Alignment.CenterHorizontally) {
        Column(Modifier.widthIn(max = 760.dp).fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("Personalize Super MD", style = MaterialTheme.typography.headlineSmall)
            Text("Choose a settings section", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(4.dp))
            categories.forEach { (title, description) ->
                Surface(
                    shape = RoundedCornerShape(24.dp),
                    color = MaterialTheme.colorScheme.surfaceContainerLow,
                    modifier = Modifier.fillMaxWidth().clickable { onOpen(title) }
                ) {
                    Row(Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(title, style = MaterialTheme.typography.titleMedium)
                            Text(description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        Icon(Icons.AutoMirrored.Rounded.ArrowBack, null, Modifier.size(20.dp).graphicsLayer(rotationZ = 180f), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
}

@Composable private fun SettingsGroup(title: String, content: @Composable ColumnScope.() -> Unit) {
    Surface(shape = RoundedCornerShape(28.dp), color = MaterialTheme.colorScheme.surfaceContainerLow) {
        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(title, style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(vertical = 4.dp))
            content()
        }
    }
}

@Composable internal fun Choice(label: String, value: String, choices: List<Pair<String,String>>, change: (String) -> Unit) {
    Text(label, style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 12.dp, bottom = 6.dp))
    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) { choices.forEach { (key, name) -> FilterChip(selected = value == key, onClick = { change(key) }, label = { Text(name) }) } }
}

@Composable internal fun StudySlider(value: Float, valueRange: ClosedFloatingPointRange<Float>, onCommit: (Float) -> Unit) {
    val slider = rememberSliderState(value = value, trackRange = valueRange)
    LaunchedEffect(value) { slider.value = value }
    // Material's gesture state handles every drag frame locally. Persisting
    // preferences and updating the document bridge happen once on release.
    Slider(state = slider, onValueChange = { slider.value = it }, onValueChangeFinished = { onCommit(slider.value) })
}
