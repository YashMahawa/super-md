@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.material3.ExperimentalMaterial3ExpressiveApi::class)
package dev.supermd.studio

import android.graphics.Color as AndroidColor
import android.os.Build
import android.os.Bundle
import android.content.Intent
import android.view.WindowManager
import android.view.ViewGroup
import android.widget.FrameLayout
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
import androidx.compose.ui.zIndex
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import org.json.JSONObject

class MainActivity : ComponentActivity() {
    var dismissDocument: (() -> Unit)? = null
    private var workspaceKey = "main"
    private val model: StudioViewModel by viewModels { object : androidx.lifecycle.ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : androidx.lifecycle.ViewModel> create(modelClass: Class<T>): T = StudioViewModel(application, workspaceKey) as T
    } }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        workspaceKey = (savedInstanceState?.getString("workspace") ?: intent.getStringExtra("workspace") ?: "main").takeIf { it == "main" || runCatching { java.util.UUID.fromString(it) }.isSuccess } ?: "main"
        enableEdgeToEdge()
        if (Build.VERSION.SDK_INT >= 28) window.attributes = window.attributes.apply { layoutInDisplayCutoutMode = if (Build.VERSION.SDK_INT >= 30) WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS else WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES }
        // Create this task's workspace before RESUMED/lifecycle consumers can
        // request it. Compose's first frame may otherwise run after onResume.
        val windowModel = model
        setContent { Studio(windowModel, this) }
        intent?.data?.let { uri -> model.open(uri) }
    }
    override fun onStop() { model.flush(); super.onStop() }
    override fun onResume() { super.onResume(); model.refreshExternal() }
    fun handleShortcut(event: android.view.KeyEvent): Boolean {
        if (event.action == android.view.KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
            if (event.keyCode == android.view.KeyEvent.KEYCODE_F11) { model.fullscreen(!model.state.value.fullscreen); return true }
            if (event.keyCode == android.view.KeyEvent.KEYCODE_ESCAPE && (model.state.value.fullscreen || model.state.value.readerOverlay)) { dismissDocument?.invoke() ?: model.fullscreen(false); return true }
            if (event.isCtrlPressed && event.keyCode == android.view.KeyEvent.KEYCODE_N) { newWindow(); return true }
            if (event.isCtrlPressed) {
                when(event.keyCode) {
                    android.view.KeyEvent.KEYCODE_T -> { if(event.isShiftPressed)model.reopen() else model.newNote();return true }
                    android.view.KeyEvent.KEYCODE_W -> { if(event.isShiftPressed)finish() else model.close(model.state.value.active.id);return true }
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
    override fun onSaveInstanceState(outState: Bundle) { outState.putString("workspace", workspaceKey); super.onSaveInstanceState(outState) }
    fun newWindow() {
        model.flush()
        startActivity(Intent(this, MainActivity::class.java).putExtra("workspace", java.util.UUID.randomUUID().toString()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_MULTIPLE_TASK or Intent.FLAG_ACTIVITY_LAUNCH_ADJACENT))
    }
}

@Composable private fun Studio(model: StudioViewModel, activity: MainActivity) {
    val state by model.state.collectAsStateWithLifecycle()
    val systemDark = androidx.compose.foundation.isSystemInDarkTheme()
    val theme = if (state.fullscreen) state.fullscreenTheme else state.theme
    val dark = theme == "dark" || theme == "black" || (theme == "system" && systemDark)
    val context = LocalContext.current
    val colors = remember(context,dark,theme,state.accent) {
        var base = when { Build.VERSION.SDK_INT >= 31 -> if (dark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context); dark -> darkColorScheme(primary = Color(0xffb2c8ff), secondary = Color(0xffbcc6dc)); else -> lightColorScheme(primary = Color(0xff42669e), onPrimary = Color.White, primaryContainer = Color(0xffd7e3ff), onPrimaryContainer = Color(0xff162c4c), secondary = Color(0xff56647c), surface = Color(0xfff7f9fd), background = Color(0xfff7f9fd), surfaceContainerLow = Color(0xfff0f3fa), surfaceContainerHigh = Color(0xffe5ebf5)) }
        base=accentColors(base,state.accent,dark)
        if (!dark) base = studyLightColors(base)
        if (theme == "black") base = manualAccent("neutral",true).copy(primary=Color(0xffdedede),onPrimary=Color(0xff1a1a1a),primaryContainer=Color(0xff343434),onPrimaryContainer=Color(0xfff0f0f0),background=Color.Black,surface=Color.Black,surfaceContainer=Color(0xff171717),surfaceContainerLow=Color(0xff101010),surfaceContainerHigh=Color(0xff242424))
        base
    }
    val systemMotion = remember { android.provider.Settings.Global.getFloat(context.contentResolver, android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f) != 0f }
    MaterialExpressiveTheme(colorScheme = colors, motionScheme = if (state.motion && systemMotion) MotionScheme.expressive() else NoMotionScheme) {
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

@Composable private fun StudioContent(model: StudioViewModel, state: StudioState, activity: MainActivity, dark: Boolean, motion: Boolean) {
    val scope = rememberCoroutineScope()
    val drawer = rememberDrawerState(DrawerValue.Closed)
    val snackbar = remember { SnackbarHostState() }
    var settings by remember { mutableStateOf(activity.intent.getBooleanExtra("showUpdates",false)) }
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
    var menu by remember { mutableStateOf(false) }
    var renaming by remember {mutableStateOf(false)}
    var contentsShown by remember {mutableStateOf(false)}
    var sidebarSection by rememberSaveable {mutableStateOf("folder")}
    var readingChromeVisible by remember {mutableStateOf(true)}
    LaunchedEffect(state.active.id, state.mode, settings) { if (!state.fullscreen) readingChromeVisible = true }
    LaunchedEffect(state.fullscreen) { if (state.fullscreen) readingChromeVisible = false }
    // A delayed single tap allows Live's double tap to enter editing without
    // hiding chrome or resizing the viewport in the middle of that action.
    val chromeTapJob=remember {arrayOfNulls<kotlinx.coroutines.Job>(1)}
    DisposableEffect(Unit){onDispose{chromeTapJob[0]?.cancel()}}
    var web by remember { mutableStateOf<WebView?>(null) }
    var chromeHeight by remember { mutableIntStateOf(0) }
    val readerNote = remember { arrayOfNulls<String>(1) }
    // Battery: a backgrounded WebView otherwise keeps JS timers, animation
    // frames and compositor work alive. Pause it once hidden (not on multi-window pause).
    val lifecycleOwner = androidx.lifecycle.compose.LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner, web) {
        val observer = androidx.lifecycle.LifecycleEventObserver { _, event ->
            when (event) {
                androidx.lifecycle.Lifecycle.Event.ON_STOP -> web?.let { it.onPause(); it.pauseTimers() }
                androidx.lifecycle.Lifecycle.Event.ON_START -> web?.let { it.resumeTimers(); it.onResume() }
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
    DisposableEffect(activity, web) {
        activity.dismissDocument = { web?.evaluateJavascript("window.supermdDismiss?.() || false") { dismissed -> if (dismissed != "true") model.fullscreen(false) } ?: model.fullscreen(false) }
        onDispose { activity.dismissDocument = null }
    }
    var readerReady by remember { mutableStateOf(false) }
    var folderRelative by remember { mutableStateOf("") }
    var hinge by remember { mutableStateOf<FoldingFeature?>(null) }
    val recent by model.recent.collectAsStateWithLifecycle()
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
    val open = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { it?.let(model::open) }
    val fontPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) {it?.let(model::importFont)}
    var noteLocation by remember {mutableStateOf(model.noteLocation())}
    val noteFolder = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) {it?.let {uri->runCatching{model.noteLocation(uri);noteLocation=uri.toString()}.onFailure{model.fail("Could not remember this folder: ${it.message}")}}}
    val save = rememberLauncherForActivityResult(NoteDestination("text/markdown", model::noteLocation)) { it?.let { uri -> model.save(uri) } }
    val folder = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { it?.let { uri -> folderRelative = ""; model.setFolder(uri) } }
    val pdf = rememberLauncherForActivityResult(NoteDestination("application/pdf", model::noteLocation)) { uri ->
        if (uri != null) { model.outputUri = uri; model.busy(true); web?.evaluateJavascript("window.supermdExport?.(${state.pdf})", null) ?: model.fail("The reader is not ready. Open the note again.") }
    }
    val portable = rememberLauncherForActivityResult(NoteDestination("application/vnd.supermd.smd", model::noteLocation)) { uri ->
        if (uri != null) { model.portableOutput = uri; model.busy(true); web?.evaluateJavascript("window.supermdPortable?.(false)", null) ?: model.fail("The reader is not ready") }
    }
    DisposableEffect(portable, state.active.name) { model.requestPortable = { portable.launch(state.active.name.substringBeforeLast('.') + ".smd") }; onDispose { model.requestPortable = null } }
    val saveAction: () -> Unit = { if (state.active.uri == null) save.launch(state.active.name.substringBeforeLast('.') + ".md") else if (state.active.portable) { model.busy(true); web?.evaluateJavascript("window.supermdPortable?.(true)", null) ?: model.fail("The reader is not ready") } else model.save(); Unit }
    LaunchedEffect(state.message) { state.message?.let { snackbar.showSnackbar(it); model.dismissMessage() } }
    val immersive = (state.fullscreen || !readingChromeVisible || state.readerOverlay) && !settings
    LaunchedEffect(immersive, dark) {
        WindowCompat.getInsetsController(activity.window, activity.window.decorView).apply { isAppearanceLightStatusBars = !dark; isAppearanceLightNavigationBars = !dark; systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE; if (immersive) hide(WindowInsetsCompat.Type.systemBars()) else show(WindowInsetsCompat.Type.systemBars()) }
    }
    BackHandler(state.fullscreen || drawer.isOpen || state.readerOverlay) { if (drawer.isOpen) scope.launch { drawer.close() } else web?.evaluateJavascript("window.supermdDismiss?.() || false") {dismissed->if(dismissed!="true")model.fullscreen(false)} }
    val palette = MaterialTheme.colorScheme
    val density = LocalDensity.current
    val tokens = remember(palette) { JSONObject().put("primary", hex(palette.primary)).put("on-primary", hex(palette.onPrimary)).put("surface", hex(palette.surface)).put("surface-low", hex(palette.surfaceContainerLow)).put("surface-high", hex(palette.surfaceContainerHigh)).put("text", hex(palette.onSurface)).put("muted", hex(palette.onSurfaceVariant)).put("outline", hex(palette.outlineVariant)) }
    BoxWithConstraints(Modifier.fillMaxSize().background(palette.surface)) {
        // A phone in landscape is wide but still short. Keep its three single
        // pane modes; offer split only when both dimensions have tablet room.
        val displayIsLarge = if (Build.VERSION.SDK_INT >= 30) activity.windowManager.maximumWindowMetrics.bounds.let { minOf(it.width(), it.height()) / density.density >= 600f } else activity.resources.configuration.smallestScreenWidthDp >= 600
        val wide = displayIsLarge && maxWidth >= 720.dp && maxHeight >= 400.dp
        val actualMode = if (!wide && state.mode == "split") "live" else state.mode
        LaunchedEffect(readerReady, state.active, actualMode, dark, state.fullscreen, state.font, state.size, state.widthPercent,state.lineHeight,state.spellCheck,state.grammarCheck,tokens, hinge, motion) {
            if (!readerReady) readerNote[0] = null
            if (readerReady) {
                val note = state.active
                val payload = JSONObject().put("id", note.id).apply { if (readerNote[0] == note.id && model.readerEcho[note.id] === note.content) put("contentUnchanged", true) else put("content", note.content) }.put("path", note.uri ?: note.id).put("mode", actualMode).put("dark", dark).put("fullscreen", state.fullscreen).put("font", state.font).put("size", state.size).put("widthPercent",state.widthPercent).put("lineHeight",state.lineHeight).put("spellCheck",state.spellCheck).put("grammarCheck",state.grammarCheck).put("colors", tokens).put("zoom", state.zoom).put("motion", motion)
                web?.evaluateJavascript("document.documentElement.dataset.platform='android';window.supermdLoad?.($payload)", null)
                readerNote[0] = note.id
                val hingeGap = if (hinge != null && actualMode == "split") hinge!!.bounds.width() / density.density else 0f
                web?.evaluateJavascript("document.querySelector('.android-document')?.style.setProperty('gap','${hingeGap}px')", null)
            }
        }
        LaunchedEffect(readerReady, state.zoomCommand) {
            if (readerReady) web?.evaluateJavascript("window.supermdSetZoom?.(${state.zoom})", null)
        }
        val headings by model.headings.collectAsStateWithLifecycle()
        val imageOverlay by model.imageOverlay.collectAsStateWithLifecycle()
        val chromeShown = !state.readerOverlay && !imageOverlay && readingChromeVisible
        val chromeReveal by animateFloatAsState(if(chromeShown) 1f else 0f,
            animationSpec=tween(if(motion) 120 else 0),label="Reading chrome")
        LaunchedEffect(readerReady,chromeHeight) {
            if(readerReady) web?.evaluateJavascript("window.supermdChromeInset?.(${chromeHeight/density.density})",null)
        }
        // Reader overlays (search, repair) hide the top bar and system bars, so
        // they anchor to the cutout-safe top edge, not the hidden chrome height.
        val safeTop = WindowInsets.displayCutout.getTop(density) / density.density
        LaunchedEffect(readerReady,safeTop) {
            if(readerReady) web?.evaluateJavascript("document.documentElement.style.setProperty('--native-safe-top','${safeTop}px')",null)
        }
        if(contentsShown) AlertDialog(onDismissRequest={contentsShown=false},title={Text("Contents")},text={OutlinePanel(headings,state.active.id){heading->readingChromeVisible=false;web?.evaluateJavascript("window.supermdHeading?.(${JSONObject.quote(heading.id)},${heading.offset})",null);contentsShown=false}},confirmButton={TextButton(onClick={contentsShown=false}){Text("Close")}})
        // Closed-drawer drag recognition steals diagonal scrolls and pinch
        // gestures from WebView. Opening is deliberate (menu button); dragging
        // still dismisses an already-open drawer.
        ModalNavigationDrawer(drawerState = drawer, gesturesEnabled = drawer.isOpen && !state.fullscreen, drawerContent = {
            ModalDrawerSheet(modifier = Modifier.widthIn(max = 340.dp)) {
                Column(Modifier.fillMaxHeight().safeDrawingPadding().padding(horizontal = 16.dp)) {
                    Text("Your files", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(vertical = 20.dp))
                    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(bottom=12.dp)) {listOf("folder" to "Folder","contents" to "Contents").forEachIndexed {index,entry->SegmentedButton(selected=sidebarSection==entry.first,onClick={sidebarSection=entry.first},shape=SegmentedButtonDefaults.itemShape(index,2),colors=SegmentedButtonDefaults.colors(activeContainerColor=palette.primary,activeContentColor=palette.onPrimary)){Text(entry.second)}}}
                    Button(onClick = { open.launch(arrayOf("text/*", "application/octet-stream", "application/vnd.supermd.smd", "application/vnd.supermd.fmd")); scope.launch { drawer.close() } }, shapes = ButtonDefaults.shapes(), modifier = Modifier.fillMaxWidth()) { Icon(Icons.Rounded.Description, null); Spacer(Modifier.width(8.dp)); Text("Open note") }
                    FilledTonalButton(onClick = { folder.launch(state.folder?.let(android.net.Uri::parse)) }, modifier = Modifier.fillMaxWidth()) { Icon(Icons.Rounded.FolderOpen, null); Spacer(Modifier.width(8.dp)); Text("Open folder") }
                    if (state.folder != null) TextButton(onClick = { folderRelative = ""; model.closeFolder() }) { Icon(Icons.Rounded.Close, null); Text("Close folder", Modifier.padding(start = 8.dp)) }
                    Text("No vault. No hidden metadata.", style = MaterialTheme.typography.bodySmall, color = palette.onSurfaceVariant, modifier = Modifier.padding(vertical = 12.dp))
                    if (folderRelative.isNotEmpty()) TextButton(onClick = { folderRelative = ""; state.folder?.let { model.listFolder(android.net.Uri.parse(it), "") } }) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, null); Text("Folder root") }
                    if(sidebarSection=="contents") OutlinePanel(headings,state.active.id,Modifier.weight(1f)){heading->readingChromeVisible=false;web?.evaluateJavascript("window.supermdHeading?.(${JSONObject.quote(heading.id)},${heading.offset})",null);scope.launch{drawer.close()}}
                    else LazyColumn(Modifier.weight(1f)) {
                        items(state.files, key={"file:${it.uri}:${it.relative}"}) { entry ->
                            val activate = { if (entry.directory) { folderRelative = entry.relative; model.listFolder(android.net.Uri.parse(entry.uri), entry.relative) } else { model.open(android.net.Uri.parse(entry.uri), entry.relative); scope.launch { drawer.close() } }; Unit }
                            ListItem(headlineContent = { Text(entry.name, maxLines = 1, overflow = TextOverflow.Ellipsis) }, leadingContent = { Icon(if (entry.directory) Icons.Rounded.Folder else Icons.Rounded.Description, null) }, modifier = Modifier.fillMaxWidth().clickable(onClick = activate), trailingContent = { Icon(if (entry.directory) Icons.Rounded.ChevronRight else Icons.AutoMirrored.Rounded.MenuBook, null) })
                        }
                    }
                    HorizontalDivider(Modifier.padding(vertical=8.dp))
                    if(recent.isNotEmpty()) {
                        Row(verticalAlignment=Alignment.CenterVertically){Text("Recent notes",Modifier.weight(1f),style=MaterialTheme.typography.titleSmall);TextButton(onClick=model::clearRecent){Text("Clear")}}
                        LazyColumn(Modifier.heightIn(max=200.dp),verticalArrangement=Arrangement.spacedBy(6.dp),contentPadding=PaddingValues(bottom=12.dp)) {
                            items(recent.take(12),key={it.uri}) { note ->
                                val selected=state.active.uri==note.uri
                                Surface(onClick={model.open(android.net.Uri.parse(note.uri),note.relative);scope.launch{drawer.close()}},shape=RoundedCornerShape(16.dp),color=if(selected)palette.secondaryContainer else palette.surfaceContainerLow,contentColor=if(selected)palette.onSecondaryContainer else palette.onSurface) {
                                    Row(Modifier.fillMaxWidth().padding(horizontal=14.dp,vertical=14.dp),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(12.dp)) {
                                        Icon(painterResource(R.drawable.symbol_file),null,Modifier.size(24.dp))
                                        Text(note.name,Modifier.weight(1f),maxLines=2,overflow=TextOverflow.Ellipsis,style=MaterialTheme.typography.bodyMedium)
                                        if(selected)Icon(Icons.Rounded.Check,"Current note",Modifier.size(20.dp))
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }) {
            // Measure chrome even when hidden, but place it in a separate layer.
            // Its visibility must never resize/recreate the WebView underneath.
            Box(Modifier.fillMaxSize().imePadding().clipToBounds()) {
                    Column(Modifier.fillMaxWidth().zIndex(2f).onSizeChanged {chromeHeight=it.height}
                        .graphicsLayer {translationY=-size.height*(1f-chromeReveal);alpha=chromeReveal}
                        .then(if(chromeShown) Modifier else Modifier.clearAndSetSemantics {})
                        .background(palette.surfaceContainerLow)) {
                        TopAppBar(windowInsets=WindowInsets.statusBarsIgnoringVisibility.union(WindowInsets.displayCutout).only(WindowInsetsSides.Top+WindowInsetsSides.Horizontal), colors = TopAppBarDefaults.topAppBarColors(containerColor = palette.surfaceContainerLow), title = { Column { Text(state.active.name, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleMedium); Text(if (state.active.dirty) "Draft recovered automatically" else if (state.active.uri != null) "Saved" else "Local draft", style = MaterialTheme.typography.labelSmall, color = palette.onSurfaceVariant) } }, navigationIcon = { IconButton(onClick = { if (state.fullscreen) contentsShown=true else { scope.launch { drawer.open() }; state.folder?.let { if (state.files.isEmpty()) model.listFolder(android.net.Uri.parse(it), "") } } }) { Icon(painterResource(if(state.fullscreen) R.drawable.symbol_contents else R.drawable.symbol_sidebar), if(state.fullscreen) "Show contents" else "Open files") } }, actions = {
                            IconButton(onClick = saveAction) { Icon(painterResource(R.drawable.symbol_save), "Save note") }
                            IconButton(onClick = { sharing = false; exporting = true }, enabled = readerReady && !state.busy) { Icon(painterResource(R.drawable.symbol_export), "Export") }
                            StudyIcon(if(state.fullscreen) "Exit fullscreen" else "Fullscreen study", if(state.fullscreen) R.drawable.symbol_fullscreen_exit else R.drawable.symbol_fullscreen) { model.fullscreen(!state.fullscreen) }
                            Box { IconButton(onClick = { menu = true }) { Icon(Icons.Rounded.MoreVert, "More actions") }; DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                                DropdownMenuItem(text = { Text("New window") }, onClick = { menu = false; activity.newWindow() }, leadingIcon = { Icon(painterResource(R.drawable.symbol_open_window), null) })
                                DropdownMenuItem(text = { Text("Share note") }, enabled = readerReady && !state.busy, onClick = { menu = false; sharing = true; exporting = true }, leadingIcon = { Icon(painterResource(R.drawable.symbol_share), null) })
                                if(!state.active.portable) DropdownMenuItem(text = { Text("Save as Markdown") }, onClick = { menu = false; save.launch(state.active.name.substringBeforeLast('.') + ".md") })
                                DropdownMenuItem(text = { Text("Insert image or link") }, onClick = { menu = false; web?.evaluateJavascript("window.supermdMedia?.()", null) }, leadingIcon = { Icon(painterResource(R.drawable.symbol_image), null) })
                                DropdownMenuItem(text = { Text("Fix LaTeX") }, onClick = { menu = false; web?.evaluateJavascript("window.supermdRepairMath?.()", null) }, leadingIcon = { Icon(painterResource(R.drawable.symbol_bug), null) })
                                DropdownMenuItem(text = { Text("Find in note") }, onClick = { menu = false; web?.evaluateJavascript("window.supermdFind?.()", null) }, leadingIcon = { Icon(painterResource(R.drawable.symbol_search), null) })
                                DropdownMenuItem(text = {Text("Rename note")},onClick = {menu=false;renaming=true},leadingIcon={Icon(painterResource(R.drawable.symbol_rename),null)})
                                DropdownMenuItem(text = { Text("Settings") }, onClick = { menu = false; settings = true }, leadingIcon = { Icon(painterResource(R.drawable.symbol_settings), null) })
                            } }
                        })
                        if(!state.fullscreen) NoteTabs(state.tabs, state.active.id, motion, model::select, model::close, model::reorder, model::newNote)
                        val modes = if (wide) listOf("live", "editor", "reader", "split") else listOf("live", "editor", "reader")
                        if(!state.fullscreen) Row(Modifier.fillMaxWidth().padding(horizontal = if (wide) 24.dp else 8.dp, vertical = 8.dp),verticalAlignment=Alignment.CenterVertically) {
                            SingleChoiceSegmentedButtonRow(Modifier.weight(1f)) { modes.forEachIndexed { index, mode -> SegmentedButton(selected = actualMode == mode, onClick = { model.mode(mode) }, colors = SegmentedButtonDefaults.colors(activeContainerColor = palette.primary, activeContentColor = palette.onPrimary), shape = SegmentedButtonDefaults.itemShape(index, modes.size)) { Text(when(mode) { "editor" -> "Source"; "reader" -> "Read"; "split" -> "Split"; else -> "Live" }) } } }
                            IconButton(onClick={web?.evaluateJavascript("window.supermdHistory?.('undo')",null)},enabled=readerReady){Icon(Icons.Rounded.Undo,"Undo (Ctrl+Z)")}
                            IconButton(onClick={web?.evaluateJavascript("window.supermdHistory?.('redo')",null)},enabled=readerReady){Icon(Icons.Rounded.Redo,"Redo (Ctrl+Y)")}
                        }
                        HorizontalDivider(color = palette.outlineVariant.copy(alpha = .55f))
                    }
                // The reading surface is edge-to-edge in BOTH chrome states.
                // Only controls receive safe insets, not the document width.
                Box(Modifier.fillMaxSize()) {
                    AndroidView(factory = { context -> FrameLayout(context).apply {
                        layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                        clipChildren = true
                        clipToPadding = true
                        addView(WebView(context).apply {
                            // Percentage-height HTML needs MATCH_PARENT, not
                            // WRAP_CONTENT. The native container also confines
                            // WebView's accelerated drawing to the reading pane.
                            layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                            web = this
                            setOnKeyListener { _, _, event -> activity.handleShortcut(event) }
                            setBackgroundColor(AndroidColor.TRANSPARENT)
                            configureReader(this, model, scope) { readerReady = true }
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
                                            evaluateJavascript("(() => { const e=document.elementFromPoint($x,$y); return !!document.querySelector('.live-active-block textarea:focus') || !!window.getSelection()?.toString() || ${if(tap) "!!e?.closest('a,button,input,textarea,summary,img,.note-image,[data-independent-zoom],.interactive-chart,.media-dialog,.reading-search,.math-repair-panel')" else "false"}; })()") { interacting ->
                                                if(interacting!="true" && !gestureActive && completedEpoch==gestureEpoch)readingChromeVisible=show ?: !readingChromeVisible
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
                            setOnDragListener { _, event ->
                                when(event.action) {
                                    android.view.DragEvent.ACTION_DRAG_STARTED -> event.clipDescription?.let { it.hasMimeType("image/*") || it.hasMimeType("application/octet-stream") || it.hasMimeType("text/uri-list") } == true
                                    android.view.DragEvent.ACTION_DROP -> {
                                        val permissions = activity.requestDragAndDropPermissions(event)
                                        val clip = event.clipData
                                        val uris = (0 until (clip?.itemCount ?: 0)).mapNotNull { clip!!.getItemAt(it).uri }
                                        if (uris.isNotEmpty()) {
                                            val id = model.state.value.active.id
                                            evaluateJavascript("window.supermdCaptureInsertion?.()", null)
                                            model.importDropped(uris, id) { images -> permissions?.release(); images?.let { evaluateJavascript("window.supermdInsertImages?.($it)", null) } }
                                        } else permissions?.release()
                                        true
                                    }
                                    else -> true
                                }
                            }
                        })
                    } }, modifier = Modifier.fillMaxSize().clipToBounds(), onRelease = { readerReady = false; web?.removeJavascriptInterface("SuperMD"); web?.destroy(); it.removeAllViews(); web = null })
                    SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).safeDrawingPadding())
                    if (state.busy || !readerReady) Surface(color = palette.surface.copy(alpha = .96f), modifier = Modifier.fillMaxSize()) { Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) { if(motion) LoadingIndicator() else Icon(Icons.Rounded.Description,null,Modifier.size(48.dp),tint=palette.primary); Spacer(Modifier.height(16.dp)); Text(if(state.busy) "Preparing your document…" else "Opening your workspace…") } }
                }
            }
        }
    }
    if (settings) {
        BackHandler { settings = false }
        Surface(Modifier.fillMaxSize(), color = palette.surface) { Column(Modifier.fillMaxSize().safeDrawingPadding()) {
            TopAppBar(title = { Text("Settings") }, navigationIcon = { IconButton(onClick = { settings = false }) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "Back") } })
            Settings(state, model, activity, noteLocation, {noteFolder.launch(noteLocation.takeIf{it.isNotBlank()}?.let(android.net.Uri::parse))}) {fontPicker.launch(arrayOf("font/ttf","font/otf","application/x-font-ttf","application/vnd.ms-opentype","application/octet-stream"))}
        } }
    }
    // Long forms must not strand their primary action below a half-open sheet.
    if (renaming) {
        var name by remember(state.active.id) {mutableStateOf(state.active.name)}
        AlertDialog(onDismissRequest={renaming=false},title={Text("Rename note")},text={OutlinedTextField(value=name,onValueChange={name=it},singleLine=true,label={Text("Note name")})},confirmButton={TextButton(onClick={model.rename(state.active.id,name);renaming=false},enabled=name.isNotBlank()){Text("Rename")}},dismissButton={TextButton(onClick={renaming=false}){Text("Cancel")}})
    }
    if (exporting) ModalBottomSheet(onDismissRequest = { exporting = false }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) { ExportSettings(state.pdf, model::pdf, state.active.portable, sharing,state.customFonts) { format ->
        exporting = false
        if (sharing) {
            if (model.prepareShare(format)) when (format) { "pdf" -> web?.evaluateJavascript("window.supermdExport?.(${state.pdf})", null) ?: model.fail("The reader is not ready"); "smd" -> web?.evaluateJavascript("window.supermdPortable?.(false)", null) ?: model.fail("The reader is not ready"); "md" -> web?.evaluateJavascript("window.supermdExportMarkdown?.()", null) ?: model.fail("The reader is not ready") }
        } else if (format == "smd") portable.launch(state.active.name.substringBeforeLast('.') + ".smd") else pdf.launch(state.active.name.substringBeforeLast('.') + ".pdf")
    } }
    state.error?.let { AlertDialog(onDismissRequest = model::dismissError, title = { Text("Couldn't finish") }, text = { Text(it, Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState())) }, confirmButton = { TextButton(onClick = model::dismissError) { Text("OK") } }) }
    if (!state.welcomed) WelcomeSetup(state, model) { model.welcomeDone(); open.launch(arrayOf("text/*", "application/octet-stream", "application/vnd.supermd.smd", "application/vnd.supermd.fmd")) }
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

@Composable private fun StudyIcon(label:String, resource:Int, action:()->Unit) {
    TooltipBox(positionProvider=TooltipDefaults.rememberTooltipPositionProvider(),tooltip={PlainTooltip{Text(label)}},state=rememberTooltipState()) {
        IconButton(onClick=action) {Icon(painterResource(resource),label,Modifier.size(24.dp))}
    }
}
private fun hex(color: Color) = "#%06x".format(color.toArgb() and 0xffffff)
private class NoteDestination(mime: String, private val preferred: () -> String): ActivityResultContracts.CreateDocument(mime) {
    override fun createIntent(context: android.content.Context, input: String): Intent {
        val location = preferred().takeIf { it.isNotBlank() }?.let { tree ->
            val uri=android.net.Uri.parse(tree)
            android.provider.DocumentsContract.buildDocumentUriUsingTree(uri, android.provider.DocumentsContract.getTreeDocumentId(uri))
        } ?: android.net.Uri.parse("content://com.android.externalstorage.documents/document/primary%3ADownload")
        return super.createIntent(context,input).putExtra(android.provider.DocumentsContract.EXTRA_INITIAL_URI,location)
    }
}

@Composable private fun Settings(state: StudioState, model: StudioViewModel, activity:MainActivity, noteLocation: String, chooseNoteLocation: ()->Unit, importFont: ()->Unit) {
    val update by model.updates.state.collectAsStateWithLifecycle()
    val scope=rememberCoroutineScope()
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()), horizontalAlignment = Alignment.CenterHorizontally) {
        Column(Modifier.widthIn(max = 760.dp).fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            SettingsSection("Appearance") {
                Text("System follows your wallpaper colors. Fullscreen can have a different theme.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Choice("Workspace theme", state.theme, listOf("system" to "System", "light" to "Light", "dark" to "Dark", "black" to "Pure black")) { model.appearance(theme = it) }
                Choice("Fullscreen theme", state.fullscreenTheme, listOf("system" to "System", "light" to "Light", "dark" to "Dark", "black" to "Pure black")) { model.appearance(fullTheme = it) }
                Choice("Theme color",state.accent,listOf("system" to "System","blue" to "Blue","violet" to "Violet","rose" to "Rose","amber" to "Amber")){model.appearance(accent=it)}
                Row(verticalAlignment = Alignment.CenterVertically) { Column(Modifier.weight(1f)) { Text("Expressive motion", style = MaterialTheme.typography.titleMedium); Text("Spring transitions and responsive controls", style = MaterialTheme.typography.bodySmall) }; Switch(checked = state.motion, onCheckedChange = { model.appearance(motion = it) }) }
            }
            SettingsSection("Reading") {
                FontChoice("Reading font", if(state.font=="sans") "Manrope" else state.font, listOf("Manrope" to "Manrope", "roboto" to "Roboto", "noto" to "Noto Sans", "serif" to "Noto Serif", "mono" to "JetBrains Mono", "system" to "System")+state.customFonts.map {it to it}) { model.appearance(font = it) }
                FilledTonalButton(onClick=importFont){Text("Import font…")}
                Text("Text size · ${state.size.toInt()} px", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 16.dp))
                StudySlider(value = state.size, onCommit = { model.appearance(size = it) }, valueRange = 6f..32f)
                Text("Reading width · ${state.widthPercent.toInt()}%",style=MaterialTheme.typography.titleSmall)
                StudySlider(value=state.widthPercent,onCommit={model.reading(widthPercent=it)},valueRange=50f..150f)
                Text("Vertical spacing · ${"%.2f".format(state.lineHeight)}",style=MaterialTheme.typography.titleSmall)
                StudySlider(value=state.lineHeight,onCommit={model.reading(lineHeight=it)},valueRange=1.15f..2.2f)
                Text("Width adapts to this window and fullscreen. Pinch text, images and plots independently.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Row(verticalAlignment=Alignment.CenterVertically){Text("Autosave existing notes",Modifier.weight(1f));Switch(checked=state.autosave,onCheckedChange={model.reading(autosave=it)})}
                Text("New note location",style=MaterialTheme.typography.titleSmall)
                FilledTonalButton(onClick=chooseNoteLocation,modifier=Modifier.fillMaxWidth()){Icon(Icons.Rounded.FolderOpen,null);Text(if(noteLocation.isBlank())"Downloads" else android.net.Uri.decode(noteLocation.substringAfterLast('/')),Modifier.padding(start=8.dp),maxLines=1,overflow=TextOverflow.Ellipsis)}
            }
            SettingsSection("Writing assistance") {
                Row(verticalAlignment=Alignment.CenterVertically){Text("Spell check",Modifier.weight(1f));Switch(checked=state.spellCheck,onCheckedChange={model.writing(spellCheck=it)})}
                Row(verticalAlignment=Alignment.CenterVertically){Text("Grammar check",Modifier.weight(1f));Switch(checked=state.grammarCheck,onCheckedChange={model.writing(grammarCheck=it)})}
                Text("Offline English suggestions in Source and Live editing. Grammar checks repeated words and a/an. Code, links and LaTeX are excluded; no text is uploaded or automatically replaced.",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
            }
            SettingsSection("Python & windows") {
                Text("NumPy and Matplotlib run locally in a separate worker. Code runs only when you press Run; never automatically on open or export.", style = MaterialTheme.typography.bodyMedium)
                Text("New window opens an independent workspace. Your device controls split-screen and desktop window placement. Hold and drag a tab to reorder it.", style = MaterialTheme.typography.bodyMedium)
                Text("The monochrome icon follows your launcher's themed-icon setting.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            SettingsSection("About & updates") {
                Text("Super MD ${BuildConfig.VERSION_NAME}",style=MaterialTheme.typography.titleMedium)
                Text("© Yash Mahawar · MIT License",style=MaterialTheme.typography.bodySmall)
                Row(verticalAlignment=Alignment.CenterVertically){Text("Check for updates on opening",Modifier.weight(1f));Switch(update.checkOnOpen,{model.updates.preference(checkOnOpen=it)})}
                Row(verticalAlignment=Alignment.CenterVertically){Text("Automatically download updates",Modifier.weight(1f));Switch(update.automatic,{model.updates.preference(automatic=it)})}
                Text("Only published release APKs. Downloads are checked against the release checksum and this app's signing certificate. Android asks for approval before installation.",color=MaterialTheme.colorScheme.onSurfaceVariant)
                if(update.status.isNotBlank())Text(update.status)
                FilledTonalButton(onClick={scope.launch{model.updates.check()}},enabled=!update.checking){Text("Check for updates")}
                if(update.version!=null)Button(onClick={if(update.ready)runCatching{model.updates.install(activity)}.onFailure{model.fail(it.message ?: "Could not open installer")} else scope.launch{model.updates.download()}},enabled=!update.checking){Text(if(update.ready)"Install update" else "Download update")}
                TextButton(onClick={activity.startActivity(Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(android.provider.Settings.EXTRA_APP_PACKAGE,activity.packageName))}){Text("Update notification permissions")}
            }
        }
    }
}

@Composable private fun FontChoice(label: String, value: String, choices: List<Pair<String,String>>, change: (String) -> Unit) {
    var opened by remember { mutableStateOf(false) }
    Text(label, style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 12.dp, bottom = 6.dp))
    FilledTonalButton(onClick = { opened = true }, modifier = Modifier.fillMaxWidth()) {
        Text(choices.find {it.first == value}?.second ?: value, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
        Icon(Icons.Rounded.ExpandMore, null)
    }
    if (opened) {
        var query by remember { mutableStateOf("") }
        val matches = remember(query, choices) {choices.distinctBy {it.first}.filter {it.second.contains(query.trim(), ignoreCase = true)}}
        AlertDialog(onDismissRequest = {opened = false}, title = {Text(label)}, text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(value = query, onValueChange = {query = it}, singleLine = true, label = {Text("Search fonts")}, leadingIcon = {Icon(Icons.Rounded.Search, null)}, modifier = Modifier.fillMaxWidth())
                if (matches.isEmpty()) Text("No matching fonts", color = MaterialTheme.colorScheme.onSurfaceVariant)
                LazyColumn(Modifier.heightIn(max = 340.dp)) {
                    items(matches, key = {it.first}) { (key, name) ->
                        ListItem(headlineContent = {Text(name)}, trailingContent = {if (key == value) Icon(Icons.Rounded.Check, "Selected")}, colors = ListItemDefaults.colors(containerColor = if (key == value) MaterialTheme.colorScheme.primaryContainer else Color.Transparent), modifier = Modifier.clickable {change(key); opened = false})
                    }
                }
            }
        }, confirmButton = {TextButton(onClick = {opened = false}) {Text("Cancel")}})
    }
}

@Composable private fun SettingsSection(title: String, content: @Composable ColumnScope.() -> Unit) {
    Surface(shape = RoundedCornerShape(28.dp), color = MaterialTheme.colorScheme.surfaceContainerLow) {
        Column(Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(title, style = MaterialTheme.typography.titleLarge)
            content()
        }
    }
}

@Composable private fun Choice(label: String, value: String, choices: List<Pair<String,String>>, change: (String) -> Unit) {
    Text(label, style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 12.dp, bottom = 6.dp))
    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) { choices.forEach { (key, name) -> FilterChip(selected = value == key, onClick = { change(key) }, label = { Text(name) }) } }
}

@Composable private fun StudySlider(value: Float, valueRange: ClosedFloatingPointRange<Float>, onCommit: (Float) -> Unit) {
    val slider = rememberSliderState(value = value, trackRange = valueRange)
    LaunchedEffect(value) { slider.value = value }
    // Material's gesture state handles every drag frame locally. Persisting
    // preferences and updating the document bridge happen once on release.
    Slider(state = slider, onValueChange = { slider.value = it }, onValueChangeFinished = { onCommit(slider.value) })
}

@Composable private fun PdfOptions(options: JSONObject, fonts: List<String> = emptyList(), update: (String, Any) -> Unit) {
    Choice("Paper", options.optString("pageSize", "a4"), listOf("a3" to "A3","a4" to "A4", "a5" to "A5","a6" to "A6","iso-b4" to "B4 (ISO)","iso-b5" to "B5 (ISO)","iso-b6" to "B6 (ISO)", "letter" to "Letter", "legal" to "Legal","tabloid" to "Tabloid","executive" to "Executive")) { update("pageSize", it) }
    FontChoice("Document font", options.optString("fontFamily", "Manrope"), (listOf("Manrope","Roboto","Noto Sans","Noto Serif","JetBrains Mono","Libertinus Serif","New Computer Modern","DejaVu Sans Mono")+fonts).distinct().map {it to it}) { update("fontFamily", it) }
    Text("Margins · ${options.optDouble("margin",18.0).toInt()} mm", Modifier.padding(top = 16.dp)); StudySlider(value = options.optDouble("margin",18.0).toFloat(), onCommit = { update("margin", it.toInt()) }, valueRange = 4f..60f)
    Text("Font size · ${"%.1f".format(options.optDouble("fontSize",10.0))} pt"); StudySlider(value = options.optDouble("fontSize",10.0).toFloat(), onCommit = { update("fontSize", (it * 2).toInt() / 2.0) }, valueRange = 5f..24f)
    Text("Line spacing · ${"%.2f".format(options.optDouble("lineHeight",1.45))}"); StudySlider(value = options.optDouble("lineHeight",1.45).toFloat(), onCommit = { update("lineHeight", it.toDouble()) }, valueRange = .9f..2.2f)
    Text("Paragraph spacing · ${"%.1f".format(options.optDouble("paragraphSpacing",1.2))}"); StudySlider(value = options.optDouble("paragraphSpacing",1.2).toFloat(), onCommit = { update("paragraphSpacing", it.toDouble()) }, valueRange = 0f..3f)
    Row(verticalAlignment = Alignment.CenterVertically) { Text("Page numbers", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium); Switch(checked = options.optBoolean("pageNumbers",true), onCheckedChange = { update("pageNumbers", it) }) }
    Row(verticalAlignment = Alignment.CenterVertically) {Text("Light Material theme", Modifier.weight(1f)); Switch(checked = options.optBoolean("themed",false), onCheckedChange = {update("themed", it)})}
    Text("Off uses plain paper. On uses your accent with light surfaces, even in dark mode.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable private fun ExportSettings(raw: String, onChange: (String) -> Unit, portableSource: Boolean = false, sharing: Boolean = false, fonts:List<String> = emptyList(), export: (String) -> Unit) {
    var format by rememberSaveable { mutableStateOf("pdf") }
    var options by remember(raw) { mutableStateOf(JSONObject(raw)) }
    fun update(key: String, value: Any) { options = JSONObject(options.toString()).put(key, value); onChange(options.toString()) }
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
        Column(Modifier.widthIn(max = 640.dp).fillMaxWidth()) {
            Column(Modifier.weight(1f, fill = false).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp)) {
                Text(if (sharing) "Share your note" else "Export your note", style = MaterialTheme.typography.headlineSmall)
                val formats = if (sharing) listOf("pdf" to "PDF", "md" to "Markdown", "smd" to "Portable SMD") else listOf("pdf" to "PDF document", "smd" to "Portable SMD")
                if (!portableSource || sharing) SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(vertical = 16.dp)) {
                    formats.forEachIndexed { index, (key, label) -> SegmentedButton(selected = format == key, onClick = { format = key }, shape = SegmentedButtonDefaults.itemShape(index, formats.size)) { Text(label) } }
                }
                if (format == "pdf") {
                    Text("Vector equations, plots and real pagination. Typeset locally on this device.", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(bottom = 12.dp))
                    PdfOptions(options, fonts, ::update)
                } else if (format == "md") {
                    Text("Editable Markdown text. For a single file that also includes images, choose Portable SMD.", style = MaterialTheme.typography.bodyMedium)
                } else {
                    Text("Your Markdown and images in one editable file.", style = MaterialTheme.typography.titleMedium)
                    Text("Reopen it in Super MD to edit, drop in images, or select an image to replace or remove it. Source mode shows Markdown, never image bytes.", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 12.dp))
                }
            }
            Button(onClick = { export(format) }, shapes = ButtonDefaults.shapes(), modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 16.dp)) {
                Icon(painterResource(if (sharing) R.drawable.symbol_share else R.drawable.symbol_export), null)
                Text(if (sharing) "Prepare & share" else "Choose destination & export", Modifier.padding(start = 8.dp))
            }
        }
    }
}
