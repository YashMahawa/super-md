@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.material3.ExperimentalMaterial3ExpressiveApi::class)
package dev.supermd.studio

import android.os.Build
import android.webkit.WebView
import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsIgnoringVisibility
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.Redo
import androidx.compose.material.icons.automirrored.rounded.Undo
import androidx.compose.material.icons.rounded.Description
import androidx.compose.material.icons.rounded.FolderOpen
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DrawerState
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialExpressiveTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.MotionScheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.PlainTooltip
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.Shapes
import androidx.compose.material3.SheetValue
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TooltipAnchorPosition
import androidx.compose.material3.TooltipBox
import androidx.compose.material3.TooltipDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.material3.rememberBottomSheetState
import androidx.compose.material3.rememberTooltipState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.json.JSONObject

internal fun shouldShowNativeBusyOverlay(busy: Boolean, readerReady: Boolean, readerOwnsProgress: Boolean): Boolean =
    !readerOwnsProgress && (busy || !readerReady)

internal fun isSystemMotionEnabled(context: android.content.Context): Boolean =
    android.provider.Settings.Global.getFloat(context.contentResolver, android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f) != 0f

@Composable internal fun Studio(model: StudioViewModel, activity: MainActivity) {
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

@Composable internal fun BindStudioSystemBarsAndBack(
    activity: MainActivity, model: StudioViewModel, state: StudioState, dark: Boolean, readingChromeVisible: Boolean,
    settings: Boolean, contentsShown: Boolean, drawer: DrawerState, scope: CoroutineScope, web: WebView?, onDismissContents: () -> Unit,
) {
    val immersive = (state.fullscreen || !readingChromeVisible || state.readerOverlay) && !settings
    LaunchedEffect(immersive, dark) {
        WindowCompat.getInsetsController(activity.window, activity.window.decorView).apply { isAppearanceLightStatusBars = !dark; isAppearanceLightNavigationBars = !dark; systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE; if (immersive) hide(WindowInsetsCompat.Type.systemBars()) else show(WindowInsetsCompat.Type.systemBars()) }
    }
    BackHandler(contentsShown || state.fullscreen || drawer.isOpen || state.readerOverlay) {
        if (contentsShown) onDismissContents()
        else if (drawer.isOpen) { if (state.folder != null && state.folderRelative.isNotEmpty() && model.navigateFolderUp()) Unit else scope.launch { drawer.close() } }
        else web?.evaluateJavascript("window.supermdDismiss?.() || false") { dismissed -> if (dismissed != "true") model.fullscreen(false) }
    }
}

@Suppress("ComposableNaming") @Composable internal fun BindStudioChromeEffectsAndContents(
    model: StudioViewModel, state: StudioState, actualMode: String, motion: Boolean, readerReady: Boolean,
    chromeHeight: Int, readingChromeVisible: Boolean, contentsShown: Boolean, density: Density, web: WebView?,
    onHideReadingChrome: () -> Unit, onDismissContents: () -> Unit,
): Pair<Boolean, Float> {
    val headings by model.headings.collectAsStateWithLifecycle()
    val imageOverlay by model.imageOverlay.collectAsStateWithLifecycle()
    val chromeShown = !state.readerOverlay && !imageOverlay && (readingChromeVisible || state.activeConflicted)
    val chromeReveal by animateFloatAsState(if(chromeShown) 1f else 0f, animationSpec=tween(if(motion) 120 else 0),label="Reading chrome")
    LaunchedEffect(readerReady,chromeHeight) { if(readerReady) web?.evaluateJavascript("window.supermdChromeInset?.(${chromeHeight/density.density})",null) }
    // Navigation needs to avoid visible controls, but showing/hiding an overlay must never resize the reader or change its first-note spacer.
    LaunchedEffect(readerReady,chromeHeight,chromeShown) {
        val visibleInset=if(chromeShown) chromeHeight/density.density else 0f
        if(readerReady) web?.evaluateJavascript("document.documentElement.style.setProperty('--native-visible-chrome-inset','${visibleInset}px')",null)
    }
    // Reader overlays (search, repair) hide the top bar and system bars, so they anchor to the cutout-safe top edge, not the hidden chrome height.
    val safeTop = WindowInsets.displayCutout.getTop(density) / density.density
    LaunchedEffect(readerReady,safeTop) { if(readerReady) web?.evaluateJavascript("document.documentElement.style.setProperty('--native-safe-top','${safeTop}px')",null) }
    if (contentsShown) ContentsBottomSheet(headings = headings, noteId = state.active.id, motion = motion, onDismiss = onDismissContents) { heading ->
        if (actualMode in listOf("live", "reader") || state.fullscreen) onHideReadingChrome()
        web?.evaluateJavascript("window.supermdHeading?.(${JSONObject.quote(heading.id)},${heading.offset})", null)
        onDismissContents()
    }
    return chromeShown to chromeReveal
}

@Composable internal fun StudioFloatingChromeColumn(
    model: StudioViewModel, activity: MainActivity, state: StudioState, wide: Boolean, actualMode: String, motion: Boolean,
    readerReady: Boolean, chromeShown: Boolean, chromeReveal: Float, menu: Boolean, drawer: DrawerState, scope: CoroutineScope,
    web: WebView?, onChromeHeightChange: (Int) -> Unit, onMenuChange: (Boolean) -> Unit, onShowContents: () -> Unit,
    onSave: () -> Unit, onOpenExport: (Boolean) -> Unit, onRename: () -> Unit, onOpenSettings: () -> Unit,
    conflictBannerContent: @Composable () -> Unit,
) {
    val palette = MaterialTheme.colorScheme
    Column(Modifier.fillMaxWidth().zIndex(2f).onSizeChanged {onChromeHeightChange(it.height)}
        .graphicsLayer {translationY=-size.height*(1f-chromeReveal);alpha=chromeReveal}
        .then(if(chromeShown) Modifier else Modifier.clearAndSetSemantics {})
        .background(palette.surfaceContainerLow).themeArtwork(state,"toolbar")) {
        StudioTopBar(
            noteName = state.active.name,
            statusLabel = if (model.documentWriteNeedsAccess(state.active.id)) "Local draft · restore file access" else if (state.activeConflicted) "Changed on disk · autosave paused" else if (state.active.dirty) "Draft recovered automatically" else if (state.active.uri != null) "Saved" else "Local draft",
            fullscreen = state.fullscreen, wide = wide, actualMode = actualMode, centerLock = state.centerLock,
            readerReady = readerReady, busy = state.busy, menuExpanded = menu, onMenuExpandedChange = onMenuChange,
            onNavigateIcon = {
                if (state.fullscreen) onShowContents()
                else { scope.launch { drawer.open() }; state.folder?.let { if (state.files.isEmpty()) model.listFolder(android.net.Uri.parse(it), state.folderRelative) } }
            },
            onFolderSearch = { model.openFolderSearch() }, onFind = { activity.openReaderFind?.invoke(false) },
            onSave = onSave, onExport = { onOpenExport(false) },
            onToggleFullscreen = { model.fullscreen(!state.fullscreen) }, onToggleCenterLock = { model.centerLock(!state.centerLock) },
            canReopenClosedTab = state.closedTabs.isNotEmpty(), onReopenClosedTab = model::reopen,
            onSaveAs = model::beginSaveAs, onNewWindow = activity::newWindow, onShare = { onOpenExport(true) },
            onInsertMedia = { web?.evaluateJavascript("window.supermdMedia?.()", null) },
            onFixLatex = { web?.evaluateJavascript("window.supermdRepairMath?.()", null) },
            onRename = onRename, onSettings = onOpenSettings,
        )
        if(!state.fullscreen) NoteTabs(state.tabs, state.active.id, motion, model::select, model::requestClose, model::reorder, model::newNote)
        if(!state.fullscreen) StudioModeBar(
            wide = wide, actualMode = actualMode, centerLock = state.centerLock, readerReady = readerReady,
            onShowContents = onShowContents, onSelectMode = model::mode,
            onUndo = { web?.evaluateJavascript("window.supermdHistory?.('undo')", null) },
            onRedo = { web?.evaluateJavascript("window.supermdHistory?.('redo')", null) },
            onEnterFullscreen = { model.fullscreen(true) }, onToggleCenterLock = { model.centerLock(!state.centerLock) },
        )
        conflictBannerContent()
        HorizontalDivider(color = palette.outlineVariant.copy(alpha = .55f))
    }
}

@Composable internal fun StudioTopBar(
    noteName: String, statusLabel: String, fullscreen: Boolean, wide: Boolean, actualMode: String,
    centerLock: Boolean, readerReady: Boolean, busy: Boolean, menuExpanded: Boolean, onMenuExpandedChange: (Boolean) -> Unit,
    onNavigateIcon: () -> Unit, onFind: () -> Unit, onSave: () -> Unit, onExport: () -> Unit,
    onToggleFullscreen: () -> Unit, onToggleCenterLock: () -> Unit, canReopenClosedTab: Boolean = false,
    onReopenClosedTab: () -> Unit = {}, onSaveAs: () -> Unit = {}, onNewWindow: () -> Unit, onShare: () -> Unit,
    onInsertMedia: () -> Unit, onFixLatex: () -> Unit, onRename: () -> Unit, onSettings: () -> Unit, onFolderSearch: () -> Unit = {},
) {
    val palette = MaterialTheme.colorScheme
    TopAppBar(
        windowInsets = WindowInsets.statusBarsIgnoringVisibility.union(WindowInsets.displayCutout).only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal),
        colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
        title = {
            Column(Modifier.fillMaxWidth()) {
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
            if (wide && !fullscreen) {
                IconButton(onClick = onFolderSearch, modifier = Modifier.size(48.dp)) { Icon(painterResource(R.drawable.symbol_search), "Search across notes (Ctrl+Shift+F)") }
            }
            StudyIcon("Find in note", R.drawable.symbol_search, enabled = readerReady, action = onFind)
            IconButton(onClick = onSave, modifier = Modifier.size(48.dp)) { Icon(painterResource(R.drawable.symbol_save), "Save note") }
            IconButton(onClick = onExport, enabled = readerReady && !busy, modifier = Modifier.size(48.dp)) { Icon(painterResource(R.drawable.symbol_export), "Export") }
            if (fullscreen || (wide && actualMode != "reader")) {
                FullscreenAndCenterLockActions(fullscreen = fullscreen, centerLock = centerLock, onToggleFullscreen = onToggleFullscreen, onToggleCenterLock = onToggleCenterLock)
            }
            Box {
                IconButton(onClick = { onMenuExpandedChange(true) }, modifier = Modifier.size(48.dp)) { Icon(Icons.Rounded.MoreVert, "More actions") }
                DropdownMenu(expanded = menuExpanded, onDismissRequest = { onMenuExpandedChange(false) }) {
                    DropdownMenuItem(text = { Text("Search across notes") }, onClick = { onMenuExpandedChange(false); onFolderSearch() }, leadingIcon = { Icon(painterResource(R.drawable.symbol_search), null) })
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
    wide: Boolean, actualMode: String, centerLock: Boolean, readerReady: Boolean, onShowContents: () -> Unit,
    onSelectMode: (String) -> Unit, onUndo: () -> Unit, onRedo: () -> Unit, onEnterFullscreen: () -> Unit, onToggleCenterLock: () -> Unit,
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
            FullscreenAndCenterLockActions(fullscreen = false, centerLock = centerLock, onToggleFullscreen = onEnterFullscreen, onToggleCenterLock = onToggleCenterLock)
        } else {
            IconButton(onClick = onUndo, enabled = readerReady, modifier = Modifier.size(48.dp)) { Icon(Icons.AutoMirrored.Rounded.Undo, "Undo (Ctrl+Z)") }
            IconButton(onClick = onRedo, enabled = readerReady, modifier = Modifier.size(48.dp)) { Icon(Icons.AutoMirrored.Rounded.Redo, "Redo (Ctrl+Y)") }
        }
    }
}

@Composable internal fun ContentsBottomSheet(
    headings: List<OutlineHeading>, noteId: String, motion: Boolean = isSystemMotionEnabled(LocalContext.current),
    onDismiss: () -> Unit, onNavigate: (OutlineHeading) -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberBottomSheetState(initialValue = SheetValue.Hidden, enabledValues = setOf(SheetValue.Hidden, SheetValue.Expanded))) {
        ContentsSheetContent(headings = headings, noteId = noteId, motion = motion, onNavigate = onNavigate)
    }
}

@Composable internal fun ContentsSheetContent(
    headings: List<OutlineHeading>, noteId: String, motion: Boolean = isSystemMotionEnabled(LocalContext.current), onNavigate: (OutlineHeading) -> Unit,
) {
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
        Column(Modifier.widthIn(max = 640.dp).fillMaxWidth().navigationBarsPadding().padding(horizontal = 16.dp).padding(bottom = 16.dp)) {
            Text("Contents", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(horizontal = 8.dp, vertical = 8.dp))
            OutlinePanel(headings, noteId, Modifier.weight(1f, fill = false), motion = motion, navigate = onNavigate)
        }
    }
}

@Composable internal fun FilesDrawerContent(
    state: StudioState, recent: List<RecentNote>, folderRelative: String = state.folderRelative,
    onOpenNote: () -> Unit, onOpenFolder: () -> Unit, onCloseFolder: () -> Unit, onFolderRoot: () -> Unit,
    onActivateEntry: (FileEntry) -> Unit, onClearRecent: () -> Unit, onOpenRecent: (RecentNote) -> Unit, onPinRecent: (RecentNote) -> Unit,
    onNavigateFolderRelative: (String) -> Unit = { onFolderRoot() }, onCreateInFolder: (CreateFolderRequest) -> Unit = {},
    onRenameEntry: (FileEntry) -> Unit = {}, modifier: Modifier = Modifier, onFolderSearch: () -> Unit = {},
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

@Composable internal fun FullscreenAndCenterLockActions(fullscreen: Boolean, centerLock: Boolean, onToggleFullscreen: () -> Unit, onToggleCenterLock: () -> Unit) {
    StudyIcon(if (fullscreen) "Exit fullscreen" else "Fullscreen study", if (fullscreen) R.drawable.symbol_fullscreen_exit else R.drawable.symbol_fullscreen, action = onToggleFullscreen)
    StudyIcon(if (centerLock) "Centre locked · unlock horizontal movement" else "Lock document to centre", if (centerLock) R.drawable.symbol_lock else R.drawable.symbol_lock_open, action = onToggleCenterLock)
}

@Composable private fun StudyIcon(label:String, resource:Int, enabled:Boolean=true, action:()->Unit) {
    TooltipBox(positionProvider=TooltipDefaults.rememberTooltipPositionProvider(TooltipAnchorPosition.Above),tooltip={PlainTooltip{Text(label)}},state=rememberTooltipState()) {
        IconButton(onClick=action, enabled=enabled, modifier=Modifier.size(48.dp)) {Icon(painterResource(resource),label,Modifier.size(24.dp))}
    }
}
internal fun hex(color: Color) = "#%06x".format(color.toArgb() and 0xffffff)
