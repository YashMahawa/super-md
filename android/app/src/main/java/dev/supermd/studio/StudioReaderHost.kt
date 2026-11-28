package dev.supermd.studio

import android.annotation.SuppressLint
import android.content.Context
import android.content.res.Configuration
import android.graphics.Color as AndroidColor
import android.net.Uri
import android.provider.Settings as AndroidSettings
import android.view.DragEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.view.inputmethod.InputMethodManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.activity.result.ActivityResultLauncher
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.key
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume
import kotlin.math.abs
import kotlin.math.hypot
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import org.json.JSONArray
import org.json.JSONObject

private suspend fun View.awaitWindowFocus() {
    if (hasWindowFocus()) return
    suspendCancellableCoroutine<Unit> { continuation ->
        val observer = viewTreeObserver
        val completed = AtomicBoolean(false)
        lateinit var listener: ViewTreeObserver.OnWindowFocusChangeListener
        fun removeListener() { if (observer.isAlive) observer.removeOnWindowFocusChangeListener(listener) }
        fun resumeIfFocused() {
            if (hasWindowFocus() && completed.compareAndSet(false, true)) {
                removeListener()
                continuation.resume(Unit)
            }
        }
        listener = ViewTreeObserver.OnWindowFocusChangeListener { hasFocus ->
            if (hasFocus) resumeIfFocused()
        }
        observer.addOnWindowFocusChangeListener(listener)
        continuation.invokeOnCancellation { removeListener() }
        resumeIfFocused()
    }
}

@Composable
internal fun BindReaderLifecycleAndHooks(
    activity: MainActivity,
    model: StudioViewModel,
    web: WebView?,
    currentWeb: () -> WebView? = { web },
    menu: Boolean,
    isMenuOpen: () -> Boolean = { menu },
    onDismissMenu: () -> Unit,
    findRequest: Int,
    currentFindRequest: () -> Int = { findRequest },
    findReplace: Boolean,
    onOpenReaderFind: (Boolean) -> Unit,
    onConsumeFindRequest: () -> Unit,
    readerReady: Boolean,
    isReaderReady: () -> Boolean = { readerReady },
    readerGeneration: Int,
) {
    // WebView timer controls are process-wide. Track every reader so a stopped
    // activity cannot pause another window that is still visible.
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner, web) {
        val currentReader = web
        if (currentReader == null) {
            // No reader exists during initial composition or renderer recovery;
            // registering that gap would create an owner with no view through
            // which to apply WebView's process-wide timer call.
            onDispose { }
        } else {
            val owner = Any()
            fun applyGlobalAction(action: ReaderTimerOwners.GlobalAction) {
                when (action) {
                    ReaderTimerOwners.GlobalAction.PAUSE -> currentReader.pauseTimers()
                    ReaderTimerOwners.GlobalAction.RESUME -> currentReader.resumeTimers()
                    ReaderTimerOwners.GlobalAction.NONE -> Unit
                }
            }
            val started = lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
            // A view can be recreated while its Activity is already STOPPED;
            // explicitly pause that view even when another reader keeps the
            // process-wide timers running.
            if (started) currentReader.onResume() else currentReader.onPause()
            applyGlobalAction(ReaderTimerOwners.process.acquire(owner, started))
            val observer = LifecycleEventObserver { _, event ->
                when (event) {
                    Lifecycle.Event.ON_STOP -> {
                        currentReader.onPause()
                        applyGlobalAction(ReaderTimerOwners.process.setStarted(owner, false))
                    }
                    Lifecycle.Event.ON_START -> {
                        applyGlobalAction(ReaderTimerOwners.process.setStarted(owner, true))
                        currentReader.onResume()
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
        model.assetAccessRestored = { document, source ->
            currentWeb()?.evaluateJavascript("window.dispatchEvent(new CustomEvent('supermd-asset-access-restored',{detail:{documentPath:${JSONObject.quote(document)},source:${JSONObject.quote(source)}}}))", null)
        }
        activity.dismissDocument = { currentWeb()?.evaluateJavascript("window.supermdDismiss?.() || false") { dismissed -> if (dismissed != "true") model.fullscreen(false) } ?: model.fullscreen(false) }
        activity.saveReaderPosition = { currentWeb()?.evaluateJavascript("window.supermdSavePosition?.()", null) }
        activity.openReaderFind = onOpenReaderFind
        activity.stepReaderFind = { direction ->
            onDismissMenu()
            currentWeb()?.let { reader ->
                reader.requestFocus(View.FOCUS_DOWN)
                reader.evaluateJavascript("window.supermdFindStep?.(${if (direction < 0) -1 else 1}); true", null)
            }
        }
        onDispose { activity.dismissDocument = null; activity.saveReaderPosition = null; activity.openReaderFind = null; activity.stepReaderFind = null; model.assetAccessRestored = null }
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
        if (isMenuOpen() || requested != currentFindRequest() || reader !== currentWeb()) return@LaunchedEffect
        onConsumeFindRequest()
        reader.requestFocus(View.FOCUS_DOWN)
        reader.evaluateJavascript("window.supermdFind?.(${if (replace) "true" else ""}); true") {
            reader.post {
                reader.requestFocus(View.FOCUS_DOWN)
                val hasHardwareKeyboard = activity.resources.configuration.keyboard != Configuration.KEYBOARD_NOKEYS
                val showImeWithHardware = AndroidSettings.Secure.getInt(activity.contentResolver, "show_ime_with_hard_keyboard", 0) == 1
                val inputMethod = activity.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
                if (!hasHardwareKeyboard || showImeWithHardware) {
                    @Suppress("DEPRECATION")
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
    DisposableEffect(model, readerReady, readerGeneration, web) {
        model.readerFlushRequester = { noteId ->
            val current = currentWeb()
            if (!isReaderReady() || current == null) model.readerStateIsNativeAuthoritative(noteId)
            else (current.getTag(R.id.reader_bridge_tag) as? ReaderBridge)?.requestFlush(noteId) ?: false
        }
        model.readerFlushStatusRequester = { noteId ->
            val current = currentWeb()
            if (!isReaderReady() || current == null) {
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
}

@Composable
internal fun BindReaderPersistenceCallbacks(
    model: StudioViewModel,
    activeNoteName: String,
    portable: ActivityResultLauncher<String>,
    save: ActivityResultLauncher<String>,
    portableSaveAs: ActivityResultLauncher<String>,
    web: WebView?,
    readerReady: Boolean,
    currentWeb: () -> WebView? = { web },
) {
    DisposableEffect(portable, activeNoteName) { model.requestPortable = { portable.launch(noteStem(activeNoteName).ifBlank { "Untitled" } + ".smd") }; onDispose { model.requestPortable = null } }
    DisposableEffect(save, portableSaveAs, model) {
        model.requestSaveAs = { note ->
            val stem = noteStem(note.name).ifBlank { "Untitled" }
            if (note.portable) portableSaveAs.launch("$stem.smd")
            else save.launch("$stem.md")
        }
        onDispose { model.requestSaveAs = null }
    }
    DisposableEffect(web, readerReady, model) {
        model.requestPortableWrite = if (readerReady && web != null) { request ->
            model.busy(true)
            val options = JSONObject()
                .put("id", request.noteId)
                .put("localAssets", JSONArray(request.localAssets))
                .put("omitLocalAssets", true)
            currentWeb()?.evaluateJavascript("window.supermdPortable?.(${request.save},$options)", null)
            true
        } else null
        onDispose { model.requestPortableWrite = null }
    }
}

@SuppressLint("ComposableNaming")
@Composable
internal fun BindReaderFormattingShortcuts(
    activity: MainActivity,
    web: WebView?,
    readerReady: Boolean,
    actualMode: String,
    editorFocused: Boolean,
    readerOverlay: Boolean,
    modalOpen: Boolean,
): State<(String) -> Unit> {
    val triggerFormat = rememberUpdatedState<(String) -> Unit> { action ->
        val reader = web
        if (reader != null && readerReady) {
            if (!reader.hasFocus()) reader.requestFocus(View.FOCUS_DOWN)
            reader.evaluateJavascript("window.supermdFormat?.(${JSONObject.quote(action)}); true", null)
        }
    }
    val canFormatNow = rememberUpdatedState {
        canTriggerHardwareFormatShortcut(actualMode, editorFocused, readerReady, readerOverlay, modalOpen)
    }
    DisposableEffect(activity) {
        activity.formatDocument = { action -> triggerFormat.value(action) }
        activity.canFormatEditor = { canFormatNow.value() }
        onDispose {
            activity.formatDocument = null
            activity.canFormatEditor = null
        }
    }
    return triggerFormat
}

@SuppressLint("ClickableViewAccessibility")
@Composable
internal fun StudioReaderWebViewHost(
    activity: MainActivity,
    model: StudioViewModel,
    scope: CoroutineScope,
    snackbar: SnackbarHostState,
    readerGeneration: Int,
    chromeTapJob: Array<Job?>,
    readerNote: Array<String?>,
    currentWeb: () -> WebView?,
    onWebChange: (WebView?) -> Unit,
    onReaderReadyChange: (Boolean) -> Unit,
    onResetPdfProgressOwnership: () -> Unit,
    onIncrementReaderGeneration: () -> Unit,
    isReadingChromeVisible: () -> Boolean,
    onReadingChromeVisibleChange: (Boolean) -> Unit,
    onShowImageChooser: (ValueCallback<Array<Uri>>) -> Unit,
    onExternalDrop: (WebView, DragEvent) -> Unit,
) {
    val currentDensity = rememberUpdatedState(LocalDensity.current)
    val currentOnShowImageChooser = rememberUpdatedState(onShowImageChooser)
    val currentOnExternalDrop = rememberUpdatedState(onExternalDrop)
    key(readerGeneration) {
        AndroidView(factory = { context ->
            FrameLayout(context).apply {
                layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                clipChildren = true
                clipToPadding = true
                addView(SelectionReaderWebView(context, model).apply {
                    // Percentage-height HTML needs MATCH_PARENT, not
                    // WRAP_CONTENT. The native container also confines
                    // WebView's accelerated drawing to the reading pane.
                    layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                    onWebChange(this)
                    setOnKeyListener { _, _, event -> activity.handleShortcut(event) }
                    setBackgroundColor(AndroidColor.TRANSPARENT)
                    configureReader(this, model, scope, ready = { if (currentWeb() === this) onReaderReadyChange(true) }, onAgentReply = activity::deliverAgentReply, onAgentExport = activity::requestAgentExport, rendererGone = { failedView ->
                        val wasCurrent = currentWeb() === failedView
                        retireAndDestroyReader(failedView)
                        if (wasCurrent) {
                            onReaderReadyChange(false)
                            onResetPdfProgressOwnership()
                            model.editorFocus(false)
                            readerNote[0] = null
                            onIncrementReaderGeneration()
                            onWebChange(null)
                            scope.launch {
                                snackbar.showSnackbar("The reader restarted. Changes already received by Super MD were restored; an edit still in transit may be missing.")
                            }
                        }
                    })
                    var touchY = 0f
                    var downX = 0f
                    var downY = 0f
                    var downTime = 0L
                    var moved = false
                    var multiTouch = false
                    var chromeIntent: Boolean? = null
                    var gestureEpoch = 0L
                    var gestureActive = false
                    setOnTouchListener { _, event ->
                        val densityScale = currentDensity.value.density
                        if (event.actionMasked == MotionEvent.ACTION_DOWN) {
                            chromeTapJob[0]?.cancel()
                            gestureEpoch++
                            gestureActive = true
                            touchY = event.rawY
                            downX = event.x; downY = event.y; downTime = event.eventTime; moved = false
                            multiTouch = false
                            chromeIntent = null
                        }
                        if (event.actionMasked == MotionEvent.ACTION_POINTER_DOWN) { multiTouch = true; chromeIntent = null }
                        if (event.actionMasked == MotionEvent.ACTION_MOVE && !multiTouch && event.pointerCount == 1 && model.state.value.mode in listOf("live", "reader") && !model.state.value.readerOverlay) {
                            if (hypot(event.x - downX, event.y - downY) > 8 * densityScale) moved = true
                            val travel = event.rawY - touchY
                            if (abs(travel) > 36 * densityScale) { chromeIntent = travel > 0; touchY = event.rawY }
                        }
                        // Never resize the viewport under an active
                        // gesture, selection handle or live editor.
                        if (event.actionMasked == MotionEvent.ACTION_UP && !multiTouch) {
                            gestureActive = false
                            val completedEpoch = gestureEpoch
                            val show = chromeIntent
                            val tap = !moved && event.eventTime - downTime < 350 && model.state.value.mode in listOf("live", "reader") && !model.state.value.readerOverlay
                            if (show != null || tap) {
                                val x = event.x / densityScale; val y = event.y / densityScale
                                chromeTapJob[0] = scope.launch {
                                    if (tap) delay(260)
                                    evaluateJavascript("(() => { const e=document.elementFromPoint($x,$y); return !!document.querySelector('.live-active-block textarea:focus') || !!window.getSelection()?.toString() || ${if (tap) "!!e?.closest('a,button,input,textarea,summary,img,.note-image,[data-independent-zoom],.interactive-chart,.media-dialog,.reading-search,.math-repair-panel')" else "false"}; })()") { interacting ->
                                        if (interacting != "true" && !gestureActive && completedEpoch == gestureEpoch) {
                                            readingChromeAfterGesture(model.state.value.fullscreen, isReadingChromeVisible(), show, tap)?.let(onReadingChromeVisibleChange)
                                        }
                                    }
                                }
                            }
                        }
                        if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) gestureActive = false
                        false
                    }
                    webChromeClient = object : WebChromeClient() {
                        override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, parameters: FileChooserParams): Boolean {
                            currentOnShowImageChooser.value(callback)
                            return true
                        }
                    }
                    setOnDragListener(ExternalDropDragController { event ->
                        currentOnExternalDrop.value(this, event)
                    })
                })
            }
        }, modifier = Modifier.fillMaxSize().clipToBounds(), onRelease = { frame ->
            val released = frame.getChildAt(0) as? WebView
            if (released != null) {
                if (currentWeb() === released) { onWebChange(null); onReaderReadyChange(false); model.editorFocus(false) }
                retireAndDestroyReader(released)
            }
            frame.removeAllViews()
        })
    }
}
