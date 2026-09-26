package dev.supermd.studio

import android.content.Intent
import android.content.res.Configuration
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.AtomicFile
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.Crossfade
import androidx.compose.animation.ExperimentalAnimationApi
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.spring
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SecondaryScrollableTabRow
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

private data class OpenNote(val id: String, val title: String, val uri: Uri?, val content: String, val saved: String, val imageFolder: Uri? = null)
private enum class ReadingMode { LIVE, SOURCE, READ, SPLIT }
private enum class AppPalette { SYSTEM, LIGHT, DARK, BLACK }

class MainActivity : ComponentActivity() {
    private val notes = mutableStateListOf(OpenNote(UUID.randomUUID().toString(), "Untitled.smd", null, "# Your next idea\n\nWrite Markdown, add a callout, or open a note.", ""))
    private val closedNotes = mutableStateListOf<OpenNote>()
    private var selected by mutableIntStateOf(0)
    private var mode by mutableStateOf(ReadingMode.LIVE)
    private var readerFullscreen by mutableStateOf(false)
    private var normalPalette by mutableStateOf(AppPalette.SYSTEM)
    private var fullPalette by mutableStateOf(AppPalette.BLACK)
    private var motionEnabled by mutableStateOf(true)
    private var readerScale by mutableFloatStateOf(1f)
    private var splitFraction by mutableFloatStateOf(.5f)
    private var separatingFold by mutableStateOf<FoldingFeature?>(null)
    private var showSettings by mutableStateOf(false)
    private var showSearch by mutableStateOf(false)
    private var showPdf by mutableStateOf(false)
    private var exportingPdf by mutableStateOf(false)
    private var pendingPdf: ByteArray? = null
    private var pendingSaveId: String? = null
    private var pendingFolderNoteId: String? = null
    private var showCloseWarning by mutableStateOf(false)
    private var editBlock by mutableStateOf<Pair<Int, NoteBlock>?>(null)
    private var pdfOptions by mutableStateOf(PdfOptions())

    private val openPicker = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri == null) return@registerForActivityResult
        runCatching { contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
        runCatching { contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_WRITE_URI_PERMISSION) }
        Thread({
            val text = runCatching { contentResolver.openInputStream(uri)?.bufferedReader()?.use { it.readText() } }.getOrNull()
            runOnUiThread {
                if (text == null) toast("Could not open this document")
                else {
                    val title = uri.lastPathSegment?.substringAfterLast('/') ?: "Document.smd"
                    notes += OpenNote(UUID.randomUUID().toString(), title, uri, text, text)
                    selected = notes.lastIndex
                    mode = ReadingMode.LIVE
                }
            }
        }, "supermd-open-note").start()
    }
    private val savePicker = registerForActivityResult(ActivityResultContracts.CreateDocument("text/plain")) { uri ->
        val noteId = pendingSaveId
        pendingSaveId = null
        if (uri != null && noteId != null) writeNote(uri, noteId)
    }
    private val imageFolderPicker = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        val noteId = pendingFolderNoteId
        pendingFolderNoteId = null
        if (uri == null) return@registerForActivityResult
        runCatching { contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
        val index = notes.indexOfFirst { it.id == noteId }
        if (index < 0) return@registerForActivityResult
        notes[index] = notes[index].copy(imageFolder = uri)
        toast("Image folder connected to this note")
    }
    private val pdfPicker = registerForActivityResult(ActivityResultContracts.CreateDocument("application/pdf")) { uri ->
        val bytes = pendingPdf
        pendingPdf = null
        if (uri == null || bytes == null) { exportingPdf = false; return@registerForActivityResult }
        Thread({
            val result = runCatching { contentResolver.openOutputStream(uri, "wt")?.use { it.write(bytes) } ?: error("The selected location is not writable") }
            runOnUiThread {
                exportingPdf = false
                result.onSuccess { toast("PDF exported") }.onFailure { toast(it.message ?: "PDF export failed") }
            }
        }, "supermd-pdf-write").start()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val prefs = getSharedPreferences("appearance", MODE_PRIVATE)
        normalPalette = runCatching { AppPalette.valueOf(prefs.getString("normal", "SYSTEM")!!) }.getOrDefault(AppPalette.SYSTEM)
        fullPalette = runCatching { AppPalette.valueOf(prefs.getString("full", "BLACK")!!) }.getOrDefault(AppPalette.BLACK)
        motionEnabled = prefs.getBoolean("motion", true)
        restoreNotes()
        intent?.data?.let(::openFromIntent)
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                WindowInfoTracker.getOrCreate(this@MainActivity).windowLayoutInfo(this@MainActivity).collect { layout ->
                    separatingFold = layout.displayFeatures.filterIsInstance<FoldingFeature>()
                        .firstOrNull { it.isSeparating || it.state == FoldingFeature.State.HALF_OPENED }
                }
            }
        }
        setContent { SuperMdApp() }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.data?.let(::openFromIntent)
    }

    override fun onPause() {
        persistNotes()
        super.onPause()
    }

    private fun openFromIntent(uri: Uri) {
        Thread({
            val text = runCatching { contentResolver.openInputStream(uri)?.bufferedReader()?.use { it.readText() } }.getOrNull() ?: return@Thread
            runOnUiThread {
                notes += OpenNote(UUID.randomUUID().toString(), uri.lastPathSegment?.substringAfterLast('/') ?: "Document.smd", uri, text, text)
                selected = notes.lastIndex
            }
        }, "supermd-open-intent").start()
    }

    private fun updateContent(value: String) {
        notes[selected] = notes[selected].copy(content = value)
    }

    private fun saveActive() {
        val document = notes.getOrNull(selected) ?: return
        if (document.uri != null) writeNote(document.uri, document.id)
        else {
            pendingSaveId = document.id
            savePicker.launch(document.title)
        }
    }

    private fun chooseImageFolder() {
        pendingFolderNoteId = notes.getOrNull(selected)?.id
        imageFolderPicker.launch(null)
    }

    private fun writeNote(uri: Uri, noteId: String) {
        val document = notes.firstOrNull { it.id == noteId } ?: return
        Thread({
            val result = runCatching { contentResolver.openOutputStream(uri, "wt")?.bufferedWriter()?.use { it.write(document.content) } ?: error("The selected location is not writable") }
            runOnUiThread {
                result.onSuccess {
                    val index = notes.indexOfFirst { it.id == document.id }
                    if (index >= 0) notes[index] = notes[index].copy(uri = uri, title = uri.lastPathSegment?.substringAfterLast('/') ?: document.title, saved = document.content)
                    toast("Saved")
                }.onFailure {
                    if (document.uri == uri) {
                        toast("Cannot save the original. Choose a new location.")
                        pendingSaveId = document.id
                        savePicker.launch(document.title)
                    } else toast(it.message ?: "Could not save")
                }
            }
        }, "supermd-save-note").start()
    }

    private fun newNote() {
        notes += OpenNote(UUID.randomUUID().toString(), "Untitled.smd", null, "", "")
        selected = notes.lastIndex
        mode = ReadingMode.SOURCE
    }

    private fun closeNote() {
        if (notes.getOrNull(selected)?.let { it.content != it.saved } == true) { showCloseWarning = true; return }
        actuallyClose()
    }

    private fun actuallyClose() {
        closedNotes.add(0, notes[selected])
        if (closedNotes.size > 10) closedNotes.removeAt(closedNotes.lastIndex)
        if (notes.size == 1) { notes[0] = OpenNote(UUID.randomUUID().toString(), "Untitled.smd", null, "", ""); selected = 0 }
        else { notes.removeAt(selected); selected = selected.coerceAtMost(notes.lastIndex) }
        showCloseWarning = false
    }

    private fun reopenNote() {
        if (closedNotes.isEmpty()) return
        notes += closedNotes.removeAt(0)
        selected = notes.lastIndex
    }

    private fun toggleImmersive() {
        readerFullscreen = !readerFullscreen
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        if (readerFullscreen) {
            controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            controller.hide(WindowInsetsCompat.Type.systemBars())
            toast("Swipe back to exit fullscreen")
        } else controller.show(WindowInsetsCompat.Type.systemBars())
    }

    private fun persistNotes() {
        val payload = JSONObject().apply {
            put("selected", selected)
            put("notes", JSONArray().apply { notes.forEach { note -> put(JSONObject().apply {
                put("id", note.id); put("title", note.title); put("uri", note.uri?.toString()); put("content", note.content); put("saved", note.saved); put("imageFolder", note.imageFolder?.toString())
            }) } })
            put("closed", JSONArray().apply { closedNotes.forEach { note -> put(JSONObject().apply {
                put("id", note.id); put("title", note.title); put("uri", note.uri?.toString()); put("content", note.content); put("saved", note.saved); put("imageFolder", note.imageFolder?.toString())
            }) } })
        }.toString().toByteArray(Charsets.UTF_8)
        val file = AtomicFile(java.io.File(filesDir, "recovery.json"))
        var output: java.io.FileOutputStream? = null
        try { output = file.startWrite(); output.write(payload); file.finishWrite(output) }
        catch (_: Exception) { output?.let(file::failWrite) }
    }

    private fun restoreNotes() {
        val data = runCatching { JSONObject(AtomicFile(java.io.File(filesDir, "recovery.json")).readFully().toString(Charsets.UTF_8)) }.getOrNull() ?: return
        val restored = data.optJSONArray("notes") ?: return
        if (restored.length() == 0) return
        notes.clear()
        for (index in 0 until restored.length()) {
            val note = restored.optJSONObject(index) ?: continue
            notes += OpenNote(note.optString("id", UUID.randomUUID().toString()), note.optString("title", "Untitled.smd"), note.optString("uri").takeIf(String::isNotBlank)?.let(Uri::parse), note.optString("content"), note.optString("saved"), note.optString("imageFolder").takeIf(String::isNotBlank)?.let(Uri::parse))
        }
        if (notes.isEmpty()) notes += OpenNote(UUID.randomUUID().toString(), "Untitled.smd", null, "", "")
        selected = data.optInt("selected", 0).coerceIn(0, notes.lastIndex)
        data.optJSONArray("closed")?.let { closed ->
            closedNotes.clear()
            for (index in 0 until closed.length()) {
                val note = closed.optJSONObject(index) ?: continue
                closedNotes += OpenNote(note.optString("id", UUID.randomUUID().toString()), note.optString("title", "Untitled.smd"), note.optString("uri").takeIf(String::isNotBlank)?.let(Uri::parse), note.optString("content"), note.optString("saved"), note.optString("imageFolder").takeIf(String::isNotBlank)?.let(Uri::parse))
            }
        }
    }

    private fun toast(message: String) = Toast.makeText(this, message, Toast.LENGTH_LONG).show()

    private fun startPdfExport(note: OpenNote) {
        if (exportingPdf) return
        exportingPdf = true
        showPdf = false
        val options = pdfOptions
        Thread({
            val result = runCatching { createNativePdf(this, note.content, options, note.imageFolder) }
            runOnUiThread {
                result.onSuccess {
                    pendingPdf = it
                    pdfPicker.launch(note.title.substringBeforeLast('.') + ".pdf")
                }.onFailure {
                    exportingPdf = false
                    toast(it.message ?: "PDF export failed")
                }
            }
        }, "supermd-pdf-layout").start()
    }

    @OptIn(ExperimentalMaterial3Api::class)
    @Composable
    private fun SuperMdApp() {
        BackHandler(readerFullscreen) { toggleImmersive() }
        LaunchedEffect(notes.toList(), closedNotes.toList(), selected) {
            delay(700)
            persistNotes()
        }
        val systemDark = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
        val palette = if (readerFullscreen) fullPalette else normalPalette
        val dark = when (palette) { AppPalette.LIGHT -> false; AppPalette.DARK, AppPalette.BLACK -> true; AppPalette.SYSTEM -> systemDark }
        val scheme = when {
            palette == AppPalette.BLACK -> darkColorScheme(background = androidx.compose.ui.graphics.Color.Black, surface = androidx.compose.ui.graphics.Color.Black)
            palette == AppPalette.SYSTEM && Build.VERSION.SDK_INT >= 31 -> if (dark) dynamicDarkColorScheme(this) else dynamicLightColorScheme(this)
            dark -> darkColorScheme()
            else -> lightColorScheme()
        }
        MaterialTheme(colorScheme = scheme) {
            val active = notes.getOrNull(selected) ?: return@MaterialTheme
            val compactHeader = LocalConfiguration.current.screenWidthDp < 620
            var menuOpen by remember { mutableStateOf(false) }
            Scaffold(
                contentWindowInsets = WindowInsets.safeDrawing,
                topBar = {
                    if (!readerFullscreen) TopAppBar(
                        title = { Column { Text(active.title, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleMedium); Text(if (active.content == active.saved) "Saved" else "Unsaved changes", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) } },
                        actions = {
                            if (!compactHeader) {
                                TextButton(onClick = { openPicker.launch(arrayOf("*/*")) }) { Text("Open") }
                                TextButton(onClick = ::saveActive) { Text("Save") }
                                TextButton(onClick = { showPdf = true }) { Text("PDF") }
                            }
                            Box {
                                TextButton(onClick = { menuOpen = true }) { Text("Menu") }
                                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                                    DropdownMenuItem(text = { Text("New note") }, onClick = { menuOpen = false; newNote() })
                                    DropdownMenuItem(text = { Text("Open") }, onClick = { menuOpen = false; openPicker.launch(arrayOf("*/*")) })
                                    DropdownMenuItem(text = { Text("Save") }, onClick = { menuOpen = false; saveActive() })
                                    DropdownMenuItem(text = { Text("Export PDF") }, onClick = { menuOpen = false; showPdf = true })
                                    DropdownMenuItem(text = { Text("Find and replace") }, onClick = { menuOpen = false; showSearch = true })
                                    DropdownMenuItem(text = { Text("Choose image folder") }, onClick = { menuOpen = false; chooseImageFolder() })
                                    DropdownMenuItem(text = { Text("Fullscreen") }, onClick = { menuOpen = false; toggleImmersive() })
                                    DropdownMenuItem(text = { Text("Appearance") }, onClick = { menuOpen = false; showSettings = true })
                                    DropdownMenuItem(text = { Text("Close tab") }, onClick = { menuOpen = false; closeNote() })
                                }
                            }
                        },
                        colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface)
                    )
                },
                containerColor = MaterialTheme.colorScheme.surfaceContainerLow
            ) { padding ->
                BoxWithConstraints(Modifier.fillMaxSize().padding(padding)) {
                    val compact = maxWidth < 760.dp
                    val viewportWidth = maxWidth
                    val availableModes = if (compact) listOf(ReadingMode.LIVE, ReadingMode.SOURCE, ReadingMode.READ) else ReadingMode.entries
                    LaunchedEffect(compact) { if (compact && mode == ReadingMode.SPLIT) mode = ReadingMode.LIVE }
                    Column(Modifier.fillMaxSize()) {
                        if (!readerFullscreen) {
                            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                                TextButton(onClick = ::newNote) { Text(if (compact) "New" else "New tab") }
                                if (!compact) TextButton(onClick = ::closeNote) { Text("Close") }
                                if (closedNotes.isNotEmpty()) TextButton(onClick = ::reopenNote) { Text("Reopen") }
                                TextButton(onClick = { showSearch = true }) { Text("Find") }
                                Spacer(Modifier.weight(1f))
                                TextButton(onClick = ::toggleImmersive) { Text(if (compact) "Focus" else "Fullscreen") }
                            }
                            if (notes.size > 1) SecondaryScrollableTabRow(selectedTabIndex = selected, edgePadding = 12.dp) {
                                notes.forEachIndexed { index, note -> Tab(selected = index == selected, onClick = { selected = index }, text = { Text(note.title, maxLines = 1) }) }
                            }
                            SecondaryScrollableTabRow(selectedTabIndex = availableModes.indexOf(mode).coerceAtLeast(0), edgePadding = 12.dp) {
                                availableModes.forEach { choice -> Tab(selected = mode == choice, onClick = { mode = choice }, text = { Text(choice.name.lowercase().replaceFirstChar(Char::uppercase)) }) }
                            }
                        }
                        val panes: @Composable (ReadingMode) -> Unit = { shownMode ->
                            if (shownMode == ReadingMode.SPLIT && !compact) {
                                val widthPx = with(LocalDensity.current) { viewportWidth.toPx() }
                                val fold = separatingFold
                                if (fold?.orientation == FoldingFeature.Orientation.HORIZONTAL) {
                                    val hingeHeight = with(LocalDensity.current) { fold.bounds.height().toDp() }.coerceAtLeast(20.dp)
                                    Column(Modifier.fillMaxSize().padding(12.dp)) {
                                        Surface(Modifier.weight(1f).fillMaxWidth(), shape = RoundedCornerShape(20.dp), color = MaterialTheme.colorScheme.surface) {
                                            SourcePane(active.content, ::updateContent)
                                        }
                                        Spacer(Modifier.height(hingeHeight))
                                        Surface(Modifier.weight(1f).fillMaxWidth(), shape = RoundedCornerShape(20.dp), color = MaterialTheme.colorScheme.surface) {
                                            PreviewPane(active.content, active.imageFolder, false, readerScale, { readerScale = it }, { editBlock = it }, ::chooseImageFolder)
                                        }
                                    }
                                } else {
                                    val hinged = fold?.orientation == FoldingFeature.Orientation.VERTICAL
                                    val paneFraction = if (hinged) (fold!!.bounds.centerX() / widthPx).coerceIn(.28f, .72f) else splitFraction
                                    val gutter = if (hinged) with(LocalDensity.current) { fold!!.bounds.width().toDp() }.coerceAtLeast(20.dp) else 20.dp
                                    Row(Modifier.fillMaxSize().padding(12.dp)) {
                                        Surface(Modifier.weight(paneFraction).fillMaxHeight(), shape = RoundedCornerShape(20.dp), color = MaterialTheme.colorScheme.surface) {
                                            SourcePane(active.content, ::updateContent)
                                        }
                                        Box(Modifier.width(gutter).fillMaxHeight().then(if (hinged) Modifier else Modifier.pointerInput(widthPx) {
                                            detectDragGestures { change, drag ->
                                                change.consume()
                                                splitFraction = (splitFraction + drag.x / widthPx).coerceIn(.28f, .72f)
                                            }
                                        }), contentAlignment = Alignment.Center) {
                                            if (!hinged) Box(Modifier.width(4.dp).height(52.dp).clip(RoundedCornerShape(8.dp)).background(MaterialTheme.colorScheme.outlineVariant))
                                        }
                                        Surface(Modifier.weight(1f - paneFraction).fillMaxHeight(), shape = RoundedCornerShape(20.dp), color = MaterialTheme.colorScheme.surface) {
                                            PreviewPane(active.content, active.imageFolder, false, readerScale, { readerScale = it }, { editBlock = it }, ::chooseImageFolder)
                                        }
                                    }
                                }
                            } else {
                                Surface(Modifier.fillMaxSize().padding(if (readerFullscreen) 0.dp else 12.dp), shape = RoundedCornerShape(if (readerFullscreen) 0.dp else 22.dp), color = MaterialTheme.colorScheme.surface) {
                                    when (shownMode) {
                                        ReadingMode.SOURCE -> SourcePane(active.content, ::updateContent)
                                        ReadingMode.LIVE -> PreviewPane(active.content, active.imageFolder, true, readerScale, { readerScale = it }, { editBlock = it }, ::chooseImageFolder)
                                        else -> PreviewPane(active.content, active.imageFolder, false, readerScale, { readerScale = it }, { editBlock = it }, ::chooseImageFolder)
                                    }
                                }
                            }
                        }
                        if (motionEnabled) Crossfade(mode, animationSpec = spring(stiffness = 460f), modifier = Modifier.weight(1f), label = "Reading mode") { shownMode -> panes(shownMode) }
                        else Box(Modifier.weight(1f)) { panes(mode) }
                    }
                }
            }

            if (showSettings) ModalBottomSheet(onDismissRequest = { showSettings = false }) {
                Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("Appearance", style = MaterialTheme.typography.headlineSmall)
                    Text("Normal mode", style = MaterialTheme.typography.titleSmall)
                    PaletteChoices(normalPalette) { normalPalette = it; getSharedPreferences("appearance", MODE_PRIVATE).edit().putString("normal", it.name).apply() }
                    Text("Fullscreen mode", style = MaterialTheme.typography.titleSmall)
                    PaletteChoices(fullPalette) { fullPalette = it; getSharedPreferences("appearance", MODE_PRIVATE).edit().putString("full", it.name).apply() }
                    Row(verticalAlignment = Alignment.CenterVertically) { Text("Smooth motion", Modifier.weight(1f)); Switch(checked = motionEnabled, onCheckedChange = { motionEnabled = it; getSharedPreferences("appearance", MODE_PRIVATE).edit().putBoolean("motion", it).apply() }) }
                    Text("Reading scale", style = MaterialTheme.typography.titleSmall)
                    Slider(value = readerScale, onValueChange = { readerScale = it }, valueRange = .75f..2.2f)
                    Spacer(Modifier.height(16.dp))
                }
            }
            if (showCloseWarning) AlertDialog(onDismissRequest = { showCloseWarning = false }, title = { Text("Close this tab?") }, text = { Text("This note has unsaved changes. A recovery copy will remain on this device.") }, confirmButton = { TextButton(onClick = ::actuallyClose) { Text("Close tab") } }, dismissButton = { TextButton(onClick = { showCloseWarning = false }) { Text("Keep editing") } })
            editBlock?.let { (index, block) ->
                var edited by androidx.compose.runtime.remember(block, index) { mutableStateOf(block.raw) }
                AlertDialog(onDismissRequest = { editBlock = null }, title = { Text("Edit block") }, text = { OutlinedTextField(value = edited, onValueChange = { edited = it }, modifier = Modifier.fillMaxWidth().height(220.dp), textStyle = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 14.sp)) }, confirmButton = { TextButton(onClick = {
                    val blocks = parseBlocks(active.content)
                    var offset = 0
                    for (position in 0..index) {
                        val next = active.content.indexOf(blocks[position].raw, offset)
                        if (next < 0) break
                        if (position == index) { updateContent(active.content.replaceRange(next, next + block.raw.length, edited)); break }
                        offset = next + blocks[position].raw.length
                    }
                    editBlock = null
                }) { Text("Apply") } }, dismissButton = { TextButton(onClick = { editBlock = null }) { Text("Cancel") } })
            }
            if (showSearch) SearchDialog(active.content, { updateContent(it) }, { showSearch = false })
            if (showPdf) {
                var pdfIssue by remember(active.content, active.imageFolder) { mutableStateOf<String?>(null) }
                var checkingPdf by remember(active.content, active.imageFolder) { mutableStateOf(true) }
                LaunchedEffect(active.content, active.imageFolder) {
                    checkingPdf = true
                    pdfIssue = withContext(Dispatchers.IO) { pdfCompatibilityIssue(this@MainActivity, active.content, active.imageFolder) }
                    checkingPdf = false
                }
                AlertDialog(onDismissRequest = { showPdf = false }, title = { Text("Export PDF") }, text = {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("Native vector pages, not a screenshot of the editor.")
                    if (checkingPdf) Text("Checking this note…", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    pdfIssue?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { listOf("A4", "Letter").forEach { size -> FilterChip(selected = pdfOptions.pageSize == size, onClick = { pdfOptions = pdfOptions.copy(pageSize = size) }, label = { Text(size) }) } }
                    Text("Text scale")
                    Slider(value = pdfOptions.textScale, onValueChange = { pdfOptions = pdfOptions.copy(textScale = it) }, valueRange = .8f..1.5f)
                    Text("Margins")
                    Slider(value = pdfOptions.margin.toFloat(), onValueChange = { pdfOptions = pdfOptions.copy(margin = it.toInt()) }, valueRange = 24f..72f)
                }
            }, confirmButton = { TextButton(enabled = !checkingPdf && pdfIssue == null && !exportingPdf, onClick = { startPdfExport(active) }) { Text("Export") } }, dismissButton = { TextButton(onClick = { showPdf = false }) { Text("Cancel") } })
            }
        }
    }
}

@Composable
private fun PaletteChoices(selected: AppPalette, onSelect: (AppPalette) -> Unit) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        AppPalette.entries.forEach { palette -> FilterChip(selected = selected == palette, onClick = { onSelect(palette) }, label = { Text(if (palette == AppPalette.SYSTEM) "System" else palette.name.lowercase().replaceFirstChar(Char::uppercase)) }) }
    }
}

@Composable
private fun SourcePane(content: String, onChange: (String) -> Unit) {
    BasicTextField(value = content, onValueChange = onChange, modifier = Modifier.fillMaxSize().padding(20.dp), textStyle = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 15.sp, lineHeight = 23.sp, color = MaterialTheme.colorScheme.onSurface), cursorBrush = androidx.compose.ui.graphics.SolidColor(MaterialTheme.colorScheme.primary), decorationBox = { inner -> Box { if (content.isEmpty()) Text("Start writing Markdown…", color = MaterialTheme.colorScheme.onSurfaceVariant); inner() } })
}

@Composable
private fun PreviewPane(content: String, imageFolder: Uri?, editable: Boolean, scale: Float, onScale: (Float) -> Unit, onEdit: (Pair<Int, NoteBlock>) -> Unit, onChooseImageFolder: () -> Unit) {
    val blocks = androidx.compose.runtime.remember(content) { parseBlocks(content) }
    val latestScale by rememberUpdatedState(scale)
    LazyColumn(modifier = Modifier.fillMaxSize().pointerInput(Unit) {
        awaitEachGesture {
            awaitFirstDown(requireUnconsumed = false)
            do {
                val event = awaitPointerEvent()
                if (event.changes.count { it.pressed } >= 2) {
                    val zoom = event.calculateZoom()
                    if (zoom != 1f) onScale((latestScale * zoom).coerceIn(.75f, 2.2f))
                    event.changes.forEach { it.consume() }
                }
            } while (event.changes.any { it.pressed })
        }
    }, contentPadding = PaddingValues(horizontal = 24.dp, vertical = 28.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        itemsIndexed(blocks, key = { index, _ -> index }) { index, block ->
            Box(Modifier.fillMaxWidth().then(if (editable) Modifier.pointerInput(index, content) { detectTapGestures { onEdit(index to block) } } else Modifier)) {
                BlockView(block, scale, imageFolder, onChooseImageFolder)
            }
        }
        if (blocks.isEmpty()) item { Text(if (editable) "Tap here to write your first block in Source mode." else "This note is empty.", color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

@Composable
private fun BlockView(block: NoteBlock, scale: Float, imageFolder: Uri?, onChooseImageFolder: () -> Unit) {
    when (block) {
        is NoteBlock.Heading -> Text(block.text, fontSize = ((29 - (block.level - 1) * 3).coerceAtLeast(17) * scale).sp, lineHeight = ((36 - (block.level - 1) * 3).coerceAtLeast(24) * scale).sp, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurface)
        is NoteBlock.Paragraph -> Text(block.text.replace(Regex("[*_`]{1,3}"), ""), fontSize = (17 * scale).sp, lineHeight = (28 * scale).sp)
        is NoteBlock.Callout -> Surface(shape = RoundedCornerShape(18.dp), color = MaterialTheme.colorScheme.secondaryContainer, modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                Text(block.title.ifBlank { block.kind.replaceFirstChar(Char::uppercase) }, color = MaterialTheme.colorScheme.onSecondaryContainer, fontWeight = FontWeight.SemiBold)
                Text(block.body, color = MaterialTheme.colorScheme.onSecondaryContainer, fontSize = (16 * scale).sp, lineHeight = (24 * scale).sp)
            }
        }
        is NoteBlock.Code -> Surface(shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surfaceContainerHigh, modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (block.language.isNotBlank()) Text(block.language.uppercase(), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                Text(block.body, fontFamily = FontFamily.Monospace, fontSize = (13 * scale).sp, lineHeight = (20 * scale).sp)
            }
        }
        is NoteBlock.Table -> Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(12.dp))) {
            block.rows.forEachIndexed { index, row -> Row(Modifier.fillMaxWidth().background(if (index == 0) MaterialTheme.colorScheme.surfaceContainerHigh else MaterialTheme.colorScheme.surface).padding(8.dp)) {
                row.forEach { cell -> Text(cell, Modifier.weight(1f).padding(4.dp), fontSize = (13 * scale).sp, fontWeight = if (index == 0) FontWeight.Bold else FontWeight.Normal) }
            } }
        }
        is NoteBlock.Equation -> Text(block.latex, fontFamily = FontFamily.Serif, fontSize = (19 * scale).sp, color = MaterialTheme.colorScheme.primary)
        is NoteBlock.Image -> {
            val context = LocalContext.current
            val bitmap by produceState<android.graphics.Bitmap?>(null, block.url, imageFolder) {
                value = withContext(Dispatchers.IO) {
                    val uri = resolveImageUri(context, block.url, imageFolder)
                    uri?.let { runCatching { context.contentResolver.openInputStream(it)?.use(BitmapFactory::decodeStream) }.getOrNull() }
                }
            }
            if (bitmap != null) Image(bitmap!!.asImageBitmap(), contentDescription = block.alt, modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)))
            else Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("Image unavailable: ${block.alt.ifBlank { block.url }}", color = MaterialTheme.colorScheme.error)
                if (Uri.parse(block.url).scheme == null) TextButton(onClick = onChooseImageFolder) { Text("Choose note folder") }
            }
        }
        is NoteBlock.Chart -> {
            var parameter by androidx.compose.runtime.remember(block.raw) { mutableFloatStateOf(block.definition.optJSONArray("sliders")?.optJSONObject(0)?.optDouble("value", 1.0)?.toFloat() ?: 1f) }
            val slider = block.definition.optJSONArray("sliders")?.optJSONObject(0)
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(block.definition.optString("title", "Interactive graph"), style = MaterialTheme.typography.titleMedium)
                Canvas(Modifier.fillMaxWidth().height(210.dp)) { drawIntoCanvas { drawChart(it.nativeCanvas, block.definition, android.graphics.RectF(0f, 0f, size.width, size.height), android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG), parameter.toDouble()) } }
                if (slider != null) {
                    Text("${slider.optString("label", slider.optString("name", "Value"))}: ${"%.2f".format(parameter)}", style = MaterialTheme.typography.labelMedium)
                    Slider(value = parameter, onValueChange = { parameter = it }, valueRange = slider.optDouble("min", 0.0).toFloat()..slider.optDouble("max", 3.0).toFloat())
                }
            }
        }
    }
}

@Composable
private fun SearchDialog(content: String, onChange: (String) -> Unit, onDismiss: () -> Unit) {
    var query by androidx.compose.runtime.remember { mutableStateOf("") }
    var replacement by androidx.compose.runtime.remember { mutableStateOf("") }
    AlertDialog(onDismissRequest = onDismiss, title = { Text("Find and replace") }, text = {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            OutlinedTextField(value = query, onValueChange = { query = it }, label = { Text("Find") }, singleLine = true)
            OutlinedTextField(value = replacement, onValueChange = { replacement = it }, label = { Text("Replace with") }, singleLine = true)
            Text(if (query.isEmpty()) "Enter text to search" else "${content.split(query).size - 1} matches", style = MaterialTheme.typography.labelMedium)
        }
    }, confirmButton = { TextButton(enabled = query.isNotEmpty(), onClick = { onChange(content.replace(query, replacement)); onDismiss() }) { Text("Replace all") } }, dismissButton = { TextButton(onClick = onDismiss) { Text("Done") } })
}
