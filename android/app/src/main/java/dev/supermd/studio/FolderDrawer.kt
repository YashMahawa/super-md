@file:OptIn(
    androidx.compose.foundation.ExperimentalFoundationApi::class,
    androidx.compose.material3.ExperimentalMaterial3Api::class,
)

package dev.supermd.studio

import android.net.Uri
import android.provider.DocumentsContract
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.MenuBook
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

internal enum class CreateFolderItemKind { MARKDOWN_NOTE, PORTABLE_NOTE, SUBFOLDER }

internal data class CreateFolderRequest(val parentRelative: String, val initialKind: CreateFolderItemKind)

internal fun friendlyTreeFolderLabel(folderUriRaw: String?): String {
    if (folderUriRaw.isNullOrBlank()) return "Open folder"
    val parsed = runCatching { Uri.parse(folderUriRaw) }.getOrNull() ?: return "Open folder"
    val treeId = runCatching { DocumentsContract.getTreeDocumentId(parsed) }.getOrNull()
    val candidate = treeId?.substringAfterLast(':')?.trim('/')?.substringAfterLast('/')
        ?: Uri.decode(folderUriRaw.substringAfterLast('/'))
    return candidate.takeIf { it.isNotBlank() } ?: "Open folder"
}

@Composable
internal fun FolderDrawerHeader(
    folderUriRaw: String,
    folderRelative: String,
    onNavigateRelative: (String) -> Unit,
    onRequestCreate: (CreateFolderRequest) -> Unit,
    onCloseFolder: () -> Unit,
) {
    var createMenuOpen by remember { mutableStateOf(false) }
    val rootLabel = remember(folderUriRaw) { friendlyTreeFolderLabel(folderUriRaw) }
    val currentTitle = if (folderRelative.isEmpty()) rootLabel else folderRelative.substringAfterLast('/')

    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        shape = MaterialTheme.shapes.medium,
        modifier = Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 4.dp),
    ) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                if (folderRelative.isNotEmpty()) {
                    IconButton(onClick = { onNavigateRelative(parentRelativePath(folderRelative)) }, modifier = Modifier.size(36.dp)) {
                        Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "Parent folder")
                    }
                } else {
                    Icon(Icons.Rounded.FolderOpen, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(end = 8.dp).size(20.dp))
                }
                Column(Modifier.weight(1f)) {
                    Text(currentTitle, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (folderRelative.isNotEmpty()) {
                        Text("$rootLabel / $folderRelative", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
                Box {
                    IconButton(onClick = { createMenuOpen = true }, modifier = Modifier.size(36.dp)) {
                        Icon(Icons.Rounded.Add, contentDescription = "Create in folder")
                    }
                    DropdownMenu(expanded = createMenuOpen, onDismissRequest = { createMenuOpen = false }) {
                        DropdownMenuItem(
                            text = { Text("New Markdown note (.md)") },
                            leadingIcon = { Icon(Icons.Rounded.Description, null) },
                            onClick = { createMenuOpen = false; onRequestCreate(CreateFolderRequest(folderRelative, CreateFolderItemKind.MARKDOWN_NOTE)) },
                        )
                        DropdownMenuItem(
                            text = { Text("New portable note (.smd)") },
                            leadingIcon = { Icon(Icons.Rounded.Inventory2, null) },
                            onClick = { createMenuOpen = false; onRequestCreate(CreateFolderRequest(folderRelative, CreateFolderItemKind.PORTABLE_NOTE)) },
                        )
                        DropdownMenuItem(
                            text = { Text("New subfolder") },
                            leadingIcon = { Icon(Icons.Rounded.CreateNewFolder, null) },
                            onClick = { createMenuOpen = false; onRequestCreate(CreateFolderRequest(folderRelative, CreateFolderItemKind.SUBFOLDER)) },
                        )
                    }
                }
                IconButton(onClick = onCloseFolder, modifier = Modifier.size(36.dp)) {
                    Icon(Icons.Rounded.Close, contentDescription = "Close folder")
                }
            }
            if (folderRelative.isNotEmpty()) {
                TextButton(onClick = { onNavigateRelative("") }, contentPadding = PaddingValues(horizontal = 4.dp, vertical = 0.dp)) {
                    Text("Folder root", style = MaterialTheme.typography.labelMedium)
                }
            }
        }
    }
}

internal fun LazyListScope.folderFileItems(
    files: List<FileEntry>,
    activeUri: String?,
    onActivate: (FileEntry) -> Unit,
    onCreateInFolder: (CreateFolderRequest) -> Unit,
    onRename: (FileEntry) -> Unit,
) {
    items(files, key = { "file:${it.uri}:${it.relative}" }) { entry ->
        var menuExpanded by remember { mutableStateOf(false) }
        val haptics = LocalHapticFeedback.current
        val isActive = !entry.directory && activeUri != null && sameDocument(Uri.parse(activeUri), Uri.parse(entry.uri))

        Box(Modifier.fillMaxWidth()) {
            ListItem(
                leadingContent = {
                    Icon(
                        imageVector = if (entry.directory) Icons.Rounded.Folder else Icons.Rounded.Description,
                        contentDescription = null,
                        tint = if (isActive || entry.directory) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                },
                trailingContent = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        IconButton(onClick = { menuExpanded = true }, modifier = Modifier.size(36.dp)) {
                            Icon(Icons.Rounded.MoreVert, contentDescription = "Actions for ${entry.name}", modifier = Modifier.size(18.dp))
                        }
                        Icon(if (entry.directory) Icons.Rounded.ChevronRight else Icons.AutoMirrored.Rounded.MenuBook, contentDescription = null, modifier = Modifier.size(18.dp))
                    }
                },
                colors = if (isActive) ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.45f)) else ListItemDefaults.colors(),
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).combinedClickable(
                    onClick = { onActivate(entry) },
                    onLongClick = { haptics.performHapticFeedback(HapticFeedbackType.LongPress); menuExpanded = true },
                ),
            ) {
                Text(entry.name, maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = if (isActive) FontWeight.SemiBold else FontWeight.Normal)
            }

            DropdownMenu(expanded = menuExpanded, onDismissRequest = { menuExpanded = false }) {
                DropdownMenuItem(
                    text = { Text(if (entry.directory) "Open folder" else "Open note") },
                    leadingIcon = { Icon(if (entry.directory) Icons.Rounded.FolderOpen else Icons.AutoMirrored.Rounded.MenuBook, null) },
                    onClick = { menuExpanded = false; onActivate(entry) },
                )
                if (entry.directory) {
                    HorizontalDivider()
                    DropdownMenuItem(
                        text = { Text("New Markdown note (.md)") },
                        leadingIcon = { Icon(Icons.Rounded.Description, null) },
                        onClick = { menuExpanded = false; onCreateInFolder(CreateFolderRequest(entry.relative, CreateFolderItemKind.MARKDOWN_NOTE)) },
                    )
                    DropdownMenuItem(
                        text = { Text("New portable note (.smd)") },
                        leadingIcon = { Icon(Icons.Rounded.Inventory2, null) },
                        onClick = { menuExpanded = false; onCreateInFolder(CreateFolderRequest(entry.relative, CreateFolderItemKind.PORTABLE_NOTE)) },
                    )
                    DropdownMenuItem(
                        text = { Text("New subfolder") },
                        leadingIcon = { Icon(Icons.Rounded.CreateNewFolder, null) },
                        onClick = { menuExpanded = false; onCreateInFolder(CreateFolderRequest(entry.relative, CreateFolderItemKind.SUBFOLDER)) },
                    )
                }
                HorizontalDivider()
                DropdownMenuItem(text = { Text("Rename") }, leadingIcon = { Icon(Icons.Rounded.Edit, null) }, onClick = { menuExpanded = false; onRename(entry) })
            }
        }
    }
}

@Composable
internal fun FolderActionDialogs(
    state: StudioState,
    model: StudioViewModel,
    createRequest: CreateFolderRequest?,
    onDismissCreate: () -> Unit,
    onNoteCreated: () -> Unit,
    renameTarget: FileEntry?,
    onDismissRename: () -> Unit,
) {
    if (createRequest != null) {
        var kind by remember(createRequest) { mutableStateOf(createRequest.initialKind) }
        var rawName by remember(createRequest) { mutableStateOf("") }
        val validation = remember(rawName, kind) {
            if (rawName.isBlank()) null
            else runCatching {
                validateFolderEntryName(
                    rawName = rawName,
                    isDirectory = kind == CreateFolderItemKind.SUBFOLDER,
                    currentExtension = when (kind) {
                        CreateFolderItemKind.PORTABLE_NOTE -> "smd"
                        CreateFolderItemKind.MARKDOWN_NOTE -> "md"
                        CreateFolderItemKind.SUBFOLDER -> ""
                    },
                )
            }
        }
        val targetLabel = createRequest.parentRelative.ifEmpty { friendlyTreeFolderLabel(state.folder) }

        AlertDialog(
            onDismissRequest = onDismissCreate,
            title = {
                Text(when (kind) {
                    CreateFolderItemKind.MARKDOWN_NOTE -> "New Markdown note"
                    CreateFolderItemKind.PORTABLE_NOTE -> "New portable note"
                    CreateFolderItemKind.SUBFOLDER -> "New subfolder"
                })
            },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("In $targetLabel", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        FilterChip(selected = kind == CreateFolderItemKind.MARKDOWN_NOTE, onClick = { kind = CreateFolderItemKind.MARKDOWN_NOTE }, label = { Text(".md") })
                        FilterChip(selected = kind == CreateFolderItemKind.PORTABLE_NOTE, onClick = { kind = CreateFolderItemKind.PORTABLE_NOTE }, label = { Text(".smd") })
                        FilterChip(selected = kind == CreateFolderItemKind.SUBFOLDER, onClick = { kind = CreateFolderItemKind.SUBFOLDER }, label = { Text("Folder") })
                    }
                    OutlinedTextField(
                        value = rawName,
                        onValueChange = { rawName = it },
                        singleLine = true,
                        isError = validation?.isFailure == true,
                        label = { Text(if (kind == CreateFolderItemKind.SUBFOLDER) "Folder name" else "Note name") },
                        supportingText = {
                            val err = validation?.exceptionOrNull()?.message
                            val okName = validation?.getOrNull()
                            when {
                                err != null -> Text(err, color = MaterialTheme.colorScheme.error)
                                okName != null -> Text("Will create $okName")
                            }
                        },
                    )
                }
            },
            confirmButton = {
                TextButton(
                    enabled = validation?.isSuccess == true,
                    onClick = {
                        val req = createRequest
                        onDismissCreate()
                        when (kind) {
                            CreateFolderItemKind.SUBFOLDER -> model.createSubfolder(req.parentRelative, rawName)
                            CreateFolderItemKind.MARKDOWN_NOTE -> model.createFolderNote(req.parentRelative, rawName, portable = false) { if (it != null) onNoteCreated() }
                            CreateFolderItemKind.PORTABLE_NOTE -> model.createFolderNote(req.parentRelative, rawName, portable = true) { if (it != null) onNoteCreated() }
                        }
                    },
                ) { Text("Create") }
            },
            dismissButton = { TextButton(onClick = onDismissCreate) { Text("Cancel") } },
        )
    }

    if (renameTarget != null) {
        val hasDot = !renameTarget.directory && '.' in renameTarget.name
        val currentExt = if (hasDot) renameTarget.name.substringAfterLast('.', "") else ""
        val initialText = if (renameTarget.directory) renameTarget.name else noteStem(renameTarget.name)
        var rawName by remember(renameTarget) { mutableStateOf(initialText) }
        var submitError by remember(renameTarget) { mutableStateOf<String?>(null) }
        var renameBusy by remember(renameTarget) { mutableStateOf(false) }
        val validation = remember(rawName, renameTarget) {
            if (rawName.isBlank()) null
            else runCatching {
                validateFolderEntryName(
                    rawName = rawName,
                    isDirectory = renameTarget.directory,
                    currentExtension = currentExt,
                    hasSavedTarget = !renameTarget.directory,
                )
            }
        }
        val activeError = submitError ?: validation?.exceptionOrNull()?.message
        AlertDialog(
            onDismissRequest = { if (!renameBusy) onDismissRename() },
            title = { Text(if (renameTarget.directory) "Rename folder" else "Rename note") },
            text = {
                OutlinedTextField(
                    value = rawName,
                    onValueChange = { rawName = it; submitError = null },
                    enabled = !renameBusy,
                    singleLine = true,
                    isError = activeError != null,
                    label = { Text(if (renameTarget.directory) "Folder name" else "Note name") },
                    supportingText = {
                        val okName = validation?.getOrNull()
                        when {
                            activeError != null -> Text(activeError, color = MaterialTheme.colorScheme.error)
                            !renameTarget.directory && okName != null -> Text("Saves as $okName")
                        }
                    },
                )
            },
            confirmButton = {
                TextButton(
                    enabled = !renameBusy && validation?.isSuccess == true,
                    onClick = {
                        val target = renameTarget
                        renameBusy = true
                        submitError = null
                        model.renameFolderEntry(
                            entryUri = Uri.parse(target.uri),
                            entryRelative = target.relative,
                            isDirectory = target.directory,
                            requested = rawName,
                            showGlobalError = false,
                        ) { ok, err ->
                            renameBusy = false
                            if (ok) onDismissRename() else submitError = err
                        }
                    },
                ) { Text("Rename") }
            },
            dismissButton = { TextButton(enabled = !renameBusy, onClick = onDismissRename) { Text("Cancel") } },
        )
    }
}
