@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.material3.ExperimentalMaterial3ExpressiveApi::class)
package dev.supermd.studio

import android.content.Intent
import android.os.Build
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.ExpandMore
import androidx.compose.material.icons.rounded.FolderOpen
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberSliderState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch
import org.json.JSONObject

@Composable internal fun StudioSettingsOverlay(
    state: StudioState, model: StudioViewModel, activity: MainActivity, surfaceColor: Color,
    noteLocation: String, settingsSection: String?, onSection: (String?) -> Unit, onDismiss: () -> Unit,
    chooseNoteLocation: () -> Unit, recoverDraft: () -> Unit, importTheme: () -> Unit, exportTheme: () -> Unit,
    showThemeGuide: () -> Unit, themeGuideReady: Boolean, importFont: () -> Unit, agentAccessContent: @Composable () -> Unit,
) {
    BackHandler { if (settingsSection != null) onSection(null) else onDismiss() }
    Surface(Modifier.fillMaxSize(), color = surfaceColor) { Column(Modifier.fillMaxSize().safeDrawingPadding()) {
        TopAppBar(title = { Text(settingsSection ?: "Settings") }, navigationIcon = { IconButton(onClick = { if (settingsSection != null) onSection(null) else onDismiss() }) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "Back") } })
        Settings(state, model, activity, noteLocation, settingsSection, onSection, chooseNoteLocation, recoverDraft, importTheme, exportTheme, showThemeGuide, themeGuideReady, importFont, agentAccessContent)
    } }
}

@Composable private fun Settings(state: StudioState, model: StudioViewModel, activity:MainActivity, noteLocation: String, section: String?, onSection: (String?)->Unit, chooseNoteLocation: ()->Unit, recoverDraft:()->Unit, importTheme:()->Unit, exportTheme:()->Unit, showThemeGuide:()->Unit, themeGuideReady:Boolean, importFont: ()->Unit, agentAccessContent: @Composable () -> Unit) {
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
            if (section == "Agent connection") SettingsGroup("Live Agent Access") { agentAccessContent() }
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
