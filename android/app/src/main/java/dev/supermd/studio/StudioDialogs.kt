@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.material3.ExperimentalMaterial3ExpressiveApi::class)
package dev.supermd.studio

import android.app.Activity
import android.content.ClipData
import android.content.ClipDescription
import android.net.Uri
import android.view.DragEvent
import android.view.View
import android.webkit.WebView
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.MenuBook
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SheetValue
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

internal fun shouldAcceptExternalDrag(localState: Any?, description: ClipDescription?): Boolean {
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
    private val onExternalDrop: (DragEvent) -> Unit,
) : View.OnDragListener {
    private var acceptingExternalDrag = false

    override fun onDrag(view: View?, event: DragEvent): Boolean =
        onDragAction(
            action = event.action,
            localState = event.localState,
            description = event.clipDescription,
            event = event,
        )

    internal fun onDragAction(
        action: Int,
        localState: Any?,
        description: ClipDescription?,
        event: DragEvent? = null,
    ): Boolean {
        return when (action) {
            DragEvent.ACTION_DRAG_STARTED -> {
                acceptingExternalDrag = shouldAcceptExternalDrag(localState, description)
                acceptingExternalDrag
            }
            DragEvent.ACTION_DROP -> {
                if (!acceptingExternalDrag) return false
                if (event != null) onExternalDrop(event)
                true
            }
            DragEvent.ACTION_DRAG_ENDED -> {
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

internal fun extractDroppedFileUris(clip: ClipData?): List<Uri> {
    if (clip == null) return emptyList()
    return (0 until clip.itemCount).mapNotNull { index ->
        clip.getItemAt(index)?.uri?.takeIf { uri ->
            uri.scheme?.lowercase() in setOf("content", "file")
        }
    }
}

@Composable
internal fun rememberExternalDropHandler(
    model: StudioViewModel,
    activity: Activity,
    settingsOpen: Boolean,
    exporting: Boolean,
    renaming: Boolean,
    contentsShown: Boolean,
    drawerOpen: Boolean,
): State<(WebView, DragEvent) -> Unit> {
    val density = LocalDensity.current
    return rememberUpdatedState { reader, event ->
        if (shouldBlockNativeDrop(
                model.state.value,
                folderSearchVisible = model.folderSearch.value.visible,
                accessRequestOpen = model.documentAccessRequests.value != null,
                settingsOpen = settingsOpen,
                exporting = exporting,
                renaming = renaming,
                contentsShown = contentsShown,
                drawerOpen = drawerOpen,
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
}

@Composable
internal fun StudioPrimaryDialogs(
    state: StudioState,
    model: StudioViewModel,
    renaming: Boolean,
    onDismissRename: () -> Unit,
    exporting: Boolean,
    sharing: Boolean,
    noteLocation: String,
    web: WebView?,
    onDismissExport: () -> Unit,
    onReaderPdfOwnsProgress: () -> Unit,
    onLaunchPortableExport: (String) -> Unit,
    onLaunchPdfExport: (String) -> Unit,
    accessPickerShowing: Boolean,
    accessRequest: DocumentAccessRequest?,
    onLaunchAccessPicker: (Uri) -> Unit,
    workspaceFolderPickerShowing: Boolean,
    onLaunchWorkspaceFolderPicker: (Uri) -> Unit,
) {
    var pendingRenameKey by rememberSaveable { mutableStateOf<String?>(null) }
    var pendingRenameInput by rememberSaveable { mutableStateOf<String?>(null) }
    // Long forms must not strand their primary action below a half-open sheet.
    if (renaming) {
        val activeRenameKey = "${state.active.id}\n${state.active.name}"
        val initialStem = remember(state.active.id, state.active.name, pendingRenameKey, pendingRenameInput) {
            if (pendingRenameKey == activeRenameKey && pendingRenameInput != null) {
                pendingRenameInput!!
            } else if (noteExtension(state.active.name).isNotEmpty()) {
                noteStem(state.active.name)
            } else {
                state.active.name
            }
        }
        var name by rememberSaveable(state.active.id, state.active.name, pendingRenameInput) { mutableStateOf(initialStem) }
        var renameError by remember(state.active.id, state.active.name) { mutableStateOf<String?>(null) }
        var renameBusy by remember(state.active.id, state.active.name) { mutableStateOf(false) }
        AlertDialog(
            onDismissRequest = {
                if (!renameBusy) {
                    if (pendingRenameKey == activeRenameKey) {
                        pendingRenameKey = null
                        pendingRenameInput = null
                    }
                    onDismissRename()
                }
            },
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
                        val targetId = state.active.id
                        val submittedName = name
                        renameBusy = true
                        renameError = null
                        model.rename(targetId, submittedName, showGlobalError = false) { ok, err ->
                            renameBusy = false
                            if (ok) {
                                if (pendingRenameKey == activeRenameKey) {
                                    pendingRenameKey = null
                                    pendingRenameInput = null
                                }
                                onDismissRename()
                            } else if (err == DOCUMENT_ACCESS_MESSAGE || model.documentAccessRequests.value?.noteId == targetId) {
                                pendingRenameKey = activeRenameKey
                                pendingRenameInput = submittedName
                                onDismissRename()
                            } else {
                                renameError = err
                            }
                        }
                    },
                    enabled = !renameBusy && name.isNotBlank(),
                ) { Text("Rename") }
            },
            dismissButton = {
                TextButton(
                    enabled = !renameBusy,
                    onClick = {
                        if (pendingRenameKey == activeRenameKey) {
                            pendingRenameKey = null
                            pendingRenameInput = null
                        }
                        onDismissRename()
                    },
                ) { Text("Cancel") }
            },
        )
    }
    if (exporting) ModalBottomSheet(onDismissRequest = onDismissExport, sheetState = rememberBottomSheetState(initialValue = SheetValue.Hidden, enabledValues = setOf(SheetValue.Hidden, SheetValue.Expanded))) { ExportSettings(state.pdf, model::pdf, sharing = sharing, fonts = state.customFonts, noteLocation = noteLocation) { format ->
        onDismissExport()
        if (format in listOf("md", "mdzip")) {
            val archive = format == "mdzip"
            if (model.prepareMarkdownExport(sharing, archive)) web?.evaluateJavascript("window.supermdExportMarkdown?.($archive)", null) ?: model.fail("The reader is not ready")
        } else if (sharing) {
            if (model.prepareShare(format)) {
                if (format == "pdf") onReaderPdfOwnsProgress()
                when (format) { "pdf" -> web?.evaluateJavascript("window.supermdExport?.(${state.pdf})", null) ?: model.fail("The reader is not ready"); "smd" -> web?.evaluateJavascript("window.supermdPortable?.(false)", null) ?: model.fail("The reader is not ready") }
            }
        } else {
            val stem = noteStem(state.active.name).ifBlank { "Untitled" }
            if (format == "smd") onLaunchPortableExport("$stem.smd") else onLaunchPdfExport("$stem.pdf")
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
            confirmButton = { TextButton(onClick = { onLaunchAccessPicker(Uri.parse(request.uri)) }) { Text(if(request.assetSource == null) "Choose original file" else "Choose linked file") } },
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
                TextButton(onClick = { onLaunchWorkspaceFolderPicker(prompt.initialUri) }) { Text("Choose folder") }
            },
            dismissButton = {
                TextButton(onClick = model::dismissWorkspaceFolderPrompt) { Text("Not now") }
            },
        )
    }
}

@Composable
internal fun StudioConfirmationDialogs(state: StudioState, model: StudioViewModel) {
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
}

@Composable internal fun WelcomeSetup(state: StudioState, model: StudioViewModel, open: () -> Unit) {
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

@Composable internal fun ConflictBanner(
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
