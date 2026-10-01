@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.material3.ExperimentalMaterial3ExpressiveApi::class)
package dev.supermd.studio

import android.graphics.Color as AndroidColor
import android.os.Build
import android.os.Bundle
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
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.snap
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
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
import org.json.JSONObject

class MainActivity : ComponentActivity() {
    private val model: StudioViewModel by viewModels()
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        if (Build.VERSION.SDK_INT >= 28) window.attributes = window.attributes.apply { layoutInDisplayCutoutMode = if (Build.VERSION.SDK_INT >= 30) WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS else WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES }
        setContent { Studio(model, this) }
        intent?.data?.let { uri -> model.open(uri) }
    }
    override fun onStop() { model.flush(); super.onStop() }
}

@Composable private fun Studio(model: StudioViewModel, activity: MainActivity) {
    val state by model.state.collectAsStateWithLifecycle()
    val systemDark = androidx.compose.foundation.isSystemInDarkTheme()
    val theme = if (state.fullscreen) state.fullscreenTheme else state.theme
    val dark = theme == "dark" || theme == "black" || (theme == "system" && systemDark)
    val context = LocalContext.current
    var colors = when { Build.VERSION.SDK_INT >= 31 -> if (dark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context); dark -> darkColorScheme(primary = Color(0xffb2c8ff), secondary = Color(0xffbcc6dc)); else -> lightColorScheme(primary = Color(0xff42669e), secondary = Color(0xff56647c)) }
    if (theme == "black") colors = colors.copy(background = Color.Black, surface = Color.Black, surfaceContainer = Color(0xff101217), surfaceContainerLow = Color(0xff080a0d))
    val systemMotion = remember { android.provider.Settings.Global.getFloat(context.contentResolver, android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f) != 0f }
    MaterialExpressiveTheme(colorScheme = colors, motionScheme = if (state.motion && systemMotion) MotionScheme.expressive() else NoMotionScheme) {
        StudioContent(model, state, activity, dark, state.motion && systemMotion)
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
    var settings by remember { mutableStateOf(false) }
    var exporting by remember { mutableStateOf(false) }
    var zoomEditing by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    var web by remember { mutableStateOf<WebView?>(null) }
    var readerReady by remember { mutableStateOf(false) }
    var folderRelative by remember { mutableStateOf("") }
    var hinge by remember { mutableStateOf<FoldingFeature?>(null) }
    val recent by model.recent.collectAsStateWithLifecycle()
    var imageCallback by remember { mutableStateOf<android.webkit.ValueCallback<Array<android.net.Uri>>?>(null) }
    var imageNote by remember { mutableStateOf("") }
    val imagePicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        imageCallback?.onReceiveValue(null); imageCallback = null
        if (uris.isNotEmpty()) model.importDropped(uris, imageNote) { images -> images?.let { web?.evaluateJavascript("window.supermdInsertImages?.($it)", null) } }
    }
    LaunchedEffect(activity) { WindowInfoTracker.getOrCreate(activity).windowLayoutInfo(activity).collect { info -> hinge = info.displayFeatures.filterIsInstance<FoldingFeature>().firstOrNull { it.isSeparating && it.orientation == FoldingFeature.Orientation.VERTICAL } } }
    val open = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { it?.let(model::open) }
    val save = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("text/markdown")) { it?.let { uri -> model.save(uri) } }
    val folder = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { it?.let { uri -> folderRelative = ""; model.setFolder(uri) } }
    val pdf = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/pdf")) { uri ->
        if (uri != null) { model.outputUri = uri; model.busy(true); web?.evaluateJavascript("window.supermdExport?.(${state.pdf})", null) ?: model.fail("The reader is not ready. Open the note again.") }
    }
    val portable = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/vnd.supermd.fmd")) { uri ->
        if (uri != null) { model.portableOutput = uri; model.busy(true); web?.evaluateJavascript("window.supermdPortable?.(false)", null) ?: model.fail("The reader is not ready") }
    }
    DisposableEffect(portable, state.active.name) { model.requestPortable = { portable.launch(state.active.name.substringBeforeLast('.') + ".fmd") }; onDispose { model.requestPortable = null } }
    val saveAction: () -> Unit = { if (state.active.uri == null) save.launch(state.active.name) else if (state.active.name.endsWith(".fmd", true)) { model.busy(true); web?.evaluateJavascript("window.supermdPortable?.(true)", null) ?: model.fail("The reader is not ready") } else model.save(); Unit }
    LaunchedEffect(state.message) { state.message?.let { snackbar.showSnackbar(it); model.dismissMessage() } }
    LaunchedEffect(state.fullscreen, dark) {
        WindowCompat.getInsetsController(activity.window, activity.window.decorView).apply { isAppearanceLightStatusBars = !dark; isAppearanceLightNavigationBars = !dark; systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE; if (state.fullscreen) hide(WindowInsetsCompat.Type.systemBars()) else show(WindowInsetsCompat.Type.systemBars()) }
    }
    BackHandler(state.fullscreen || drawer.isOpen) { if (drawer.isOpen) scope.launch { drawer.close() } else model.fullscreen(false) }
    val palette = MaterialTheme.colorScheme
    val cutout = WindowInsets.displayCutout
    val density = LocalDensity.current
    val cutoutTop = cutout.getTop(density) / density.density
    val cutoutLeft = cutout.getLeft(density, androidx.compose.ui.unit.LayoutDirection.Ltr) / density.density
    val cutoutRight = cutout.getRight(density, androidx.compose.ui.unit.LayoutDirection.Ltr) / density.density
    val tokens = remember(palette) { JSONObject().put("primary", hex(palette.primary)).put("on-primary", hex(palette.onPrimary)).put("surface", hex(palette.surface)).put("surface-low", hex(palette.surfaceContainerLow)).put("surface-high", hex(palette.surfaceContainerHigh)).put("text", hex(palette.onSurface)).put("muted", hex(palette.onSurfaceVariant)).put("outline", hex(palette.outlineVariant)) }
    BoxWithConstraints(Modifier.fillMaxSize().background(palette.surface)) {
        // A phone in landscape is wide but still short. Keep its three single
        // pane modes; offer split only when both dimensions have tablet room.
        val wide = maxWidth >= 720.dp && maxHeight >= 600.dp
        val actualMode = if (!wide && state.mode == "split") "live" else state.mode
        LaunchedEffect(readerReady, state.active, actualMode, state.zoom, dark, state.fullscreen, state.font, state.size, tokens, hinge, cutoutTop, cutoutLeft, cutoutRight, motion) {
            if (readerReady) {
                val note = state.active
                val payload = JSONObject().put("id", note.id).put("content", note.content).put("path", note.uri ?: note.id).put("mode", actualMode).put("dark", dark).put("fullscreen", state.fullscreen).put("font", state.font).put("size", state.size).put("colors", tokens).put("zoom", state.zoom).put("motion", motion)
                web?.evaluateJavascript("window.supermdLoad?.($payload)", null)
                web?.evaluateJavascript("document.documentElement.style.setProperty('--cutout-top','${if (state.fullscreen) cutoutTop else 0f}px');document.documentElement.style.setProperty('--cutout-left','${if (state.fullscreen) cutoutLeft else 0f}px');document.documentElement.style.setProperty('--cutout-right','${if (state.fullscreen) cutoutRight else 0f}px')", null)
                val hingeGap = if (hinge != null && actualMode == "split") hinge!!.bounds.width() / density.density else 0f
                web?.evaluateJavascript("document.querySelector('.android-document')?.style.setProperty('gap','${hingeGap}px')", null)
            }
        }
        // Closed-drawer drag recognition steals diagonal scrolls and pinch
        // gestures from WebView. Opening is deliberate (menu button); dragging
        // still dismisses an already-open drawer.
        ModalNavigationDrawer(drawerState = drawer, gesturesEnabled = drawer.isOpen && !state.fullscreen, drawerContent = {
            ModalDrawerSheet(modifier = Modifier.widthIn(max = 340.dp)) {
                Column(Modifier.fillMaxHeight().safeDrawingPadding().padding(horizontal = 16.dp)) {
                    Text("Your files", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(vertical = 20.dp))
                    FilledTonalButton(onClick = { folder.launch(state.folder?.let(android.net.Uri::parse)) }, modifier = Modifier.fillMaxWidth()) { Icon(Icons.Rounded.FolderOpen, null); Spacer(Modifier.width(8.dp)); Text("Open any folder") }
                    Text("No vault. No hidden metadata.", style = MaterialTheme.typography.bodySmall, color = palette.onSurfaceVariant, modifier = Modifier.padding(vertical = 12.dp))
                    if (folderRelative.isNotEmpty()) TextButton(onClick = { folderRelative = ""; state.folder?.let { model.listFolder(android.net.Uri.parse(it), "") } }) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, null); Text("Folder root") }
                    Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
                        if (recent.isNotEmpty()) {
                            Row(verticalAlignment = Alignment.CenterVertically) { Text("Recent files", style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f)); TextButton(onClick = model::clearRecent) { Text("Clear") } }
                            recent.take(12).forEach { note -> ListItem(headlineContent = { Text(note.name, maxLines = 1, overflow = TextOverflow.Ellipsis) }, leadingContent = { Icon(Icons.Rounded.History, null) }, modifier = Modifier.clickable { model.open(android.net.Uri.parse(note.uri), note.relative); scope.launch { drawer.close() } }) }
                            HorizontalDivider(Modifier.padding(vertical = 8.dp))
                        }
                        state.files.forEach { entry ->
                            val activate = { if (entry.directory) { folderRelative = entry.relative; model.listFolder(android.net.Uri.parse(entry.uri), entry.relative) } else { model.open(android.net.Uri.parse(entry.uri), entry.relative); scope.launch { drawer.close() } }; Unit }
                            ListItem(headlineContent = { Text(entry.name, maxLines = 1, overflow = TextOverflow.Ellipsis) }, leadingContent = { Icon(if (entry.directory) Icons.Rounded.Folder else Icons.Rounded.Description, null) }, modifier = Modifier.fillMaxWidth().clickable(onClick = activate), trailingContent = { Icon(if (entry.directory) Icons.Rounded.ChevronRight else Icons.AutoMirrored.Rounded.MenuBook, null) })
                        }
                    }
                    FilledTonalButton(onClick = { model.newNote(); scope.launch { drawer.close() } }, modifier = Modifier.fillMaxWidth().padding(bottom = 16.dp)) { Icon(Icons.Rounded.Add, null); Text("New note", Modifier.padding(start = 8.dp)) }
                }
            }
        }) {
            Column(Modifier.fillMaxSize().imePadding()) {
                AnimatedVisibility(!state.fullscreen, enter = expandVertically(animationSpec = if (motion) spring(dampingRatio = .85f, stiffness = 500f) else tween(0)), exit = shrinkVertically(animationSpec = tween(if (motion) 180 else 0))) {
                    Column {
                        TopAppBar(title = { Column { Text(state.active.name, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleMedium); Text(if (state.active.dirty) "Draft recovered automatically" else if (state.active.uri != null) "Saved" else "Local draft", style = MaterialTheme.typography.labelSmall, color = palette.onSurfaceVariant) } }, navigationIcon = { IconButton(onClick = { scope.launch { drawer.open() }; state.folder?.let { if (state.files.isEmpty()) model.listFolder(android.net.Uri.parse(it), "") } }) { Icon(Icons.Rounded.Menu, "Open files") } }, actions = {
                            IconButton(onClick = saveAction) { Icon(Icons.Rounded.Save, "Save note") }
                            IconButton(onClick = { exporting = true }, enabled = readerReady && !state.busy) { Icon(Icons.Rounded.IosShare, "Export") }
                            Box { IconButton(onClick = { menu = true }) { Icon(Icons.Rounded.MoreVert, "More actions") }; DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                                DropdownMenuItem(text = { Text("Open note") }, onClick = { menu = false; open.launch(arrayOf("text/*", "application/octet-stream", "application/vnd.supermd.fmd")) }, leadingIcon = { Icon(Icons.Rounded.FolderOpen, null) })
                                DropdownMenuItem(text = { Text("New tab") }, onClick = { menu = false; model.newNote() }, leadingIcon = { Icon(Icons.Rounded.Add, null) })
                                DropdownMenuItem(text = { Text("Reopen closed tab") }, onClick = { menu = false; model.reopen() })
                                DropdownMenuItem(text = { Text("Save as Markdown") }, onClick = { menu = false; save.launch(if (state.active.name.endsWith(".fmd", true)) state.active.name.substringBeforeLast('.') + ".md" else state.active.name) })
                                DropdownMenuItem(text = { Text("Insert image or link") }, onClick = { menu = false; web?.evaluateJavascript("window.supermdMedia?.()", null) }, leadingIcon = { Icon(Icons.Rounded.Image, null) })
                                DropdownMenuItem(text = { Text("Zoom · ${state.zoom.toInt()}%") }, onClick = { menu = false; zoomEditing = true }, leadingIcon = { Icon(Icons.Rounded.ZoomIn, null) })
                                DropdownMenuItem(text = { Text("Find and replace") }, onClick = { menu = false; model.mode("editor"); web?.postDelayed({ web?.evaluateJavascript("window.supermdFind?.()", null) }, 200) }, leadingIcon = { Icon(Icons.Rounded.Search, null) })
                                DropdownMenuItem(text = { Text("Fullscreen study") }, onClick = { menu = false; model.fullscreen(true) }, leadingIcon = { Icon(Icons.Rounded.Fullscreen, null) })
                                DropdownMenuItem(text = { Text("Settings") }, onClick = { menu = false; settings = true }, leadingIcon = { Icon(Icons.Rounded.Settings, null) })
                            } }
                        })
                        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                            state.tabs.forEach { note -> Surface(color = if (state.active.id == note.id) palette.secondaryContainer else palette.surface, shape = RoundedCornerShape(18.dp), modifier = Modifier.padding(end = 4.dp)) { Row(verticalAlignment = Alignment.CenterVertically) { TextButton(onClick = { model.select(note.id) }, contentPadding = PaddingValues(start = 12.dp, end = 4.dp)) { Text((if (note.dirty) "• " else "") + note.name, maxLines = 1) }; IconButton(onClick = { model.close(note.id) }, modifier = Modifier.size(36.dp)) { Icon(Icons.Rounded.Close, "Close ${note.name}", Modifier.size(16.dp)) } } } }
                            IconButton(onClick = model::newNote) { Icon(Icons.Rounded.Add, "New tab") }
                        }
                        val modes = if (wide) listOf("live", "editor", "reader", "split") else listOf("live", "editor", "reader")
                        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = if (wide) 32.dp else 16.dp, vertical = 8.dp)) { modes.forEachIndexed { index, mode -> SegmentedButton(selected = actualMode == mode, onClick = { model.mode(mode) }, shape = SegmentedButtonDefaults.itemShape(index, modes.size)) { Text(when(mode) { "editor" -> "Source"; "reader" -> "Read"; "split" -> "Split"; else -> "Live" }) } } }
                    }
                }
                Box(Modifier.weight(1f).fillMaxWidth().windowInsetsPadding(if (state.fullscreen) WindowInsets(0) else WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal + WindowInsetsSides.Bottom))) {
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
                            setBackgroundColor(AndroidColor.TRANSPARENT)
                            configureReader(this, model, scope) { readerReady = true }
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
                    if (state.fullscreen) Surface(shape = RoundedCornerShape(24.dp), color = palette.surfaceContainer.copy(alpha = .94f), modifier = Modifier.align(Alignment.TopEnd).safeDrawingPadding().padding(8.dp)) { Row(verticalAlignment = Alignment.CenterVertically) { IconButton(onClick = { model.zoom(state.zoom - 10) }) { Icon(Icons.Rounded.Remove, "Zoom out") }; TextButton(onClick = { zoomEditing = true }) { Text("${state.zoom.toInt()}%") }; IconButton(onClick = { model.zoom(state.zoom + 10) }) { Icon(Icons.Rounded.Add, "Zoom in") }; IconButton(onClick = { model.fullscreen(false) }) { Icon(Icons.Rounded.FullscreenExit, "Exit fullscreen") } } }
                    SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).safeDrawingPadding())
                    if (state.busy) Surface(color = palette.surface.copy(alpha = .9f), modifier = Modifier.fillMaxSize()) { Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) { CircularProgressIndicator(); Spacer(Modifier.height(16.dp)); Text("Preparing your document…") } }
                }
            }
        }
    }
    if (settings) ModalBottomSheet(onDismissRequest = { settings = false }) { Settings(state, model) }
    if (exporting) ModalBottomSheet(onDismissRequest = { exporting = false }) { ExportSettings(state.pdf, model::pdf) { format -> exporting = false; if (format == "fmd") portable.launch(state.active.name.substringBeforeLast('.') + ".fmd") else pdf.launch(state.active.name.substringBeforeLast('.') + ".pdf") } }
    if (zoomEditing) ZoomDialog(state.zoom, { zoomEditing = false }) { model.zoom(it); zoomEditing = false }
    state.error?.let { AlertDialog(onDismissRequest = model::dismissError, title = { Text("Couldn't finish") }, text = { Text(it, Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState())) }, confirmButton = { TextButton(onClick = model::dismissError) { Text("OK") } }) }
    if (!state.welcomed) WelcomeSetup(state, model) { model.welcomeDone(); open.launch(arrayOf("text/*", "application/octet-stream", "application/vnd.supermd.fmd")) }
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

private fun hex(color: Color) = "#%06x".format(color.toArgb() and 0xffffff)

@Composable private fun Settings(state: StudioState, model: StudioViewModel) {
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(24.dp)) {
        Text("Make room for thought", style = MaterialTheme.typography.headlineSmall)
        Spacer(Modifier.height(20.dp))
        Choice("Appearance", state.theme, listOf("system" to "System", "light" to "Light", "dark" to "Dark", "black" to "Pure black")) { model.appearance(theme = it) }
        Choice("Fullscreen appearance", state.fullscreenTheme, listOf("system" to "System", "light" to "Light", "dark" to "Dark", "black" to "Pure black")) { model.appearance(fullTheme = it) }
        Choice("Reading font", state.font, listOf("sans" to "Sans", "serif" to "Serif", "mono" to "Mono")) { model.appearance(font = it) }
        Text("Text size · ${state.size.toInt()}", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 16.dp))
        StudySlider(value = state.size, onCommit = { model.appearance(size = it) }, valueRange = 13f..28f)
        Row(verticalAlignment = Alignment.CenterVertically) { Column(Modifier.weight(1f)) { Text("Expressive motion", style = MaterialTheme.typography.titleMedium); Text("Spring transitions and responsive controls", style = MaterialTheme.typography.bodySmall) }; Switch(checked = state.motion, onCheckedChange = { model.appearance(motion = it) }) }
        Text("Dynamic color follows your wallpaper on Android 12+. The monochrome icon follows your launcher's themed-icon setting.", style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 16.dp))
        Spacer(Modifier.height(32.dp))
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

@Composable private fun ExportSettings(raw: String, onChange: (String) -> Unit, export: (String) -> Unit) {
    var format by rememberSaveable { mutableStateOf("pdf") }
    var options by remember(raw) { mutableStateOf(JSONObject(raw)) }
    fun update(key: String, value: Any) { options = JSONObject(options.toString()).put(key, value); onChange(options.toString()) }
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(24.dp)) {
        Text("Export your note", style = MaterialTheme.typography.headlineSmall)
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(vertical = 16.dp)) {
            listOf("pdf" to "PDF document", "fmd" to "Portable FMD").forEachIndexed { index, (key, label) -> SegmentedButton(selected = format == key, onClick = { format = key }, shape = SegmentedButtonDefaults.itemShape(index, 2)) { Text(label) } }
        }
        if (format == "pdf") {
        Text("Vector equations, plots and real pagination. Typeset locally on this device.", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(bottom = 12.dp))
        Choice("Paper", options.optString("pageSize", "a4"), listOf("a4" to "A4", "a5" to "A5", "letter" to "Letter", "legal" to "Legal")) { update("pageSize", it) }
        Choice("Document font", options.optString("fontFamily", "Libertinus Serif"), listOf("Libertinus Serif" to "Serif", "Noto Sans" to "Sans", "New Computer Modern" to "Book", "DejaVu Sans Mono" to "Mono")) { update("fontFamily", it) }
        Text("Margins · ${options.optDouble("margin",18.0).toInt()} mm", Modifier.padding(top = 16.dp)); StudySlider(value = options.optDouble("margin",18.0).toFloat(), onCommit = { update("margin", it.toInt()) }, valueRange = 4f..60f)
        Text("Font size · ${"%.1f".format(options.optDouble("fontSize",10.5))} pt"); StudySlider(value = options.optDouble("fontSize",10.5).toFloat(), onCommit = { update("fontSize", (it * 2).toInt() / 2.0) }, valueRange = 7f..24f)
        Text("Line spacing · ${"%.2f".format(options.optDouble("lineHeight",1.35))}"); StudySlider(value = options.optDouble("lineHeight",1.35).toFloat(), onCommit = { update("lineHeight", it.toDouble()) }, valueRange = .9f..2.2f)
        Row(verticalAlignment = Alignment.CenterVertically) { Text("Page numbers", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium); Switch(checked = options.optBoolean("pageNumbers",true), onCheckedChange = { update("pageNumbers", it) }) }
        } else {
            Text("Your Markdown and images in one editable file.", style = MaterialTheme.typography.titleMedium)
            Text("Reopen it in Super MD to edit, drop in images, or select an image to replace or remove it. Source mode shows Markdown, never image bytes.", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 12.dp))
        }
        Button(onClick = { export(format) }, shapes = ButtonDefaults.shapes(), modifier = Modifier.fillMaxWidth().padding(top = 20.dp, bottom = 28.dp)) { Icon(Icons.Rounded.IosShare, null); Text("Choose destination & export", Modifier.padding(start = 8.dp)) }
    }
}

@Composable private fun ZoomDialog(value: Float, dismiss: () -> Unit, apply: (Float) -> Unit) {
    var draft by rememberSaveable { mutableStateOf(value.toInt().toString()) }
    val parsed = draft.trim().removeSuffix("%").toFloatOrNull()
    val valid = parsed != null && parsed.isFinite() && parsed in 60f..240f
    AlertDialog(onDismissRequest = dismiss, title = { Text("Content zoom") }, text = { Column {
        OutlinedTextField(value = draft, onValueChange = { draft = it }, label = { Text("Zoom percentage") }, suffix = { Text("%") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), isError = !valid, supportingText = { Text("60% to 240%. Toolbars stay the same size.") })
        TextButton(onClick = { draft = "100" }) { Text("Reset to 100%") }
    } }, confirmButton = { TextButton(onClick = { parsed?.let(apply) }, enabled = valid) { Text("Apply") } }, dismissButton = { TextButton(onClick = dismiss) { Text("Cancel") } })
}
