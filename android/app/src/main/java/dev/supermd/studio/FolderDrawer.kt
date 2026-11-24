@file:OptIn(
    androidx.compose.foundation.ExperimentalFoundationApi::class,
    androidx.compose.material3.ExperimentalMaterial3Api::class,
)

package dev.supermd.studio

import android.net.Uri
import android.provider.DocumentsContract
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.DriveFileMove
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

internal enum class CreateFolderItemKind {
    MARKDOWN_NOTE,
    PORTABLE_NOTE,
    SUBFOLDER,
}

internal data class CreateFolderRequest(
    val parentRelative: String,
    val initialKind: CreateFolderItemKind,
)

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
    canReopenClosedNote: Boolean = false,
    onReopenClosedNote: () -> Unit = {},
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
                    IconButton(
                        onClick = { onNavigateRelative(parentRelativePath(folderRelative)) },
                        modifier = Modifier.size(36.dp),
                    ) {
                        Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "Parent folder")
                    }
                } else {
                    Icon(
                        Icons.Rounded.FolderOpen,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.padding(end = 8.dp).size(20.dp),
                    )
                }
                Column(Modifier.weight(1f)) {
                    Text(
                        text = currentTitle,
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (folderRelative.isNotEmpty()) {
                        Text(
                            text = "$rootLabel / $folderRelative",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                if (canReopenClosedNote) {
                    IconButton(
                        onClick = onReopenClosedNote,
                        modifier = Modifier.size(36.dp),
                    ) {
                        Icon(Icons.Rounded.Restore, contentDescription = "Reopen closed note")
                    }
                }
                Box {
                    IconButton(
                        onClick = { createMenuOpen = true },
                        modifier = Modifier.size(36.dp),
                    ) {
                        Icon(Icons.Rounded.Add, contentDescription = "Create in folder")
                    }
                    DropdownMenu(
                        expanded = createMenuOpen,
                        onDismissRequest = { createMenuOpen = false },
                    ) {
                        DropdownMenuItem(
                            text = { Text("New Markdown note (.md)") },
                            leadingIcon = { Icon(Icons.Rounded.Description, null) },
                            onClick = {
                                createMenuOpen = false
                                onRequestCreate(CreateFolderRequest(folderRelative, CreateFolderItemKind.MARKDOWN_NOTE))
                            },
                        )
                        DropdownMenuItem(
                            text = { Text("New portable note (.smd)") },
                            leadingIcon = { Icon(Icons.Rounded.Inventory2, null) },
                            onClick = {
                                createMenuOpen = false
                                onRequestCreate(CreateFolderRequest(folderRelative, CreateFolderItemKind.PORTABLE_NOTE))
                            },
                        )
                        DropdownMenuItem(
                            text = { Text("New subfolder") },
                            leadingIcon = { Icon(Icons.Rounded.CreateNewFolder, null) },
                            onClick = {
                                createMenuOpen = false
                                onRequestCreate(CreateFolderRequest(folderRelative, CreateFolderItemKind.SUBFOLDER))
                            },
                        )
                    }
                }
                IconButton(
                    onClick = onCloseFolder,
                    modifier = Modifier.size(36.dp),
                ) {
                    Icon(Icons.Rounded.Close, contentDescription = "Close folder")
                }
            }
            if (folderRelative.isNotEmpty()) {
                TextButton(
                    onClick = { onNavigateRelative("") },
                    contentPadding = PaddingValues(horizontal = 4.dp, vertical = 0.dp),
                ) {
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
    onMove: (FileEntry) -> Unit,
    onDelete: (FileEntry) -> Unit,
) {
    items(files, key = { "file:${it.uri}:${it.relative}" }) { entry ->
        var menuExpanded by remember { mutableStateOf(false) }
        val haptics = LocalHapticFeedback.current
        val isActive = !entry.directory && activeUri != null && sameDocument(Uri.parse(activeUri), Uri.parse(entry.uri))

        Box(Modifier.fillMaxWidth()) {
            ListItem(
                headlineContent = {
                    Text(
                        text = entry.name,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        fontWeight = if (isActive) FontWeight.SemiBold else FontWeight.Normal,
                    )
                },
                leadingContent = {
                    Icon(
                        imageVector = if (entry.directory) Icons.Rounded.Folder else Icons.Rounded.Description,
                        contentDescription = null,
                        tint = if (isActive || entry.directory) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                },
                trailingContent = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        IconButton(
                            onClick = { menuExpanded = true },
                            modifier = Modifier.size(36.dp),
                        ) {
                            Icon(
                                Icons.Rounded.MoreVert,
                                contentDescription = "Actions for ${entry.name}",
                                modifier = Modifier.size(18.dp),
                            )
                        }
                        Icon(
                            imageVector = if (entry.directory) Icons.Rounded.ChevronRight else Icons.AutoMirrored.Rounded.MenuBook,
                            contentDescription = null,
                            modifier = Modifier.size(18.dp),
                        )
                    }
                },
                colors = if (isActive) {
                    ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.45f))
                } else {
                    ListItemDefaults.colors()
                },
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp)
                    .combinedClickable(
                        onClick = { onActivate(entry) },
                        onLongClick = {
                            haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                            menuExpanded = true
                        },
                    ),
            )

            DropdownMenu(
                expanded = menuExpanded,
                onDismissRequest = { menuExpanded = false },
            ) {
                DropdownMenuItem(
                    text = { Text(if (entry.directory) "Open folder" else "Open note") },
                    leadingIcon = {
                        Icon(
                            if (entry.directory) Icons.Rounded.FolderOpen else Icons.AutoMirrored.Rounded.MenuBook,
                            null,
                        )
                    },
                    onClick = {
                        menuExpanded = false
                        onActivate(entry)
                    },
                )
                if (entry.directory) {
                    HorizontalDivider()
                    DropdownMenuItem(
                        text = { Text("New Markdown note (.md)") },
                        leadingIcon = { Icon(Icons.Rounded.Description, null) },
                        onClick = {
                            menuExpanded = false
                            onCreateInFolder(CreateFolderRequest(entry.relative, CreateFolderItemKind.MARKDOWN_NOTE))
                        },
                    )
                    DropdownMenuItem(
                        text = { Text("New portable note (.smd)") },
                        leadingIcon = { Icon(Icons.Rounded.Inventory2, null) },
                        onClick = {
                            menuExpanded = false
                            onCreateInFolder(CreateFolderRequest(entry.relative, CreateFolderItemKind.PORTABLE_NOTE))
                        },
                    )
                    DropdownMenuItem(
                        text = { Text("New subfolder") },
                        leadingIcon = { Icon(Icons.Rounded.CreateNewFolder, null) },
                        onClick = {
                            menuExpanded = false
                            onCreateInFolder(CreateFolderRequest(entry.relative, CreateFolderItemKind.SUBFOLDER))
                        },
                    )
                }
                HorizontalDivider()
                DropdownMenuItem(
                    text = { Text("Rename") },
                    leadingIcon = { Icon(Icons.Rounded.Edit, null) },
                    onClick = {
                        menuExpanded = false
                        onRename(entry)
                    },
                )
                DropdownMenuItem(
                    text = { Text("Move to folder…") },
                    leadingIcon = { Icon(Icons.AutoMirrored.Rounded.DriveFileMove, null) },
                    onClick = {
                        menuExpanded = false
                        onMove(entry)
                    },
                )
                DropdownMenuItem(
                    text = { Text("Delete", color = MaterialTheme.colorScheme.error) },
                    leadingIcon = { Icon(Icons.Rounded.DeleteOutline, null, tint = MaterialTheme.colorScheme.error) },
                    onClick = {
                        menuExpanded = false
                        onDelete(entry)
                    },
                )
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
    moveTarget: FileEntry?,
    onDismissMove: () -> Unit,
    deleteTarget: FileEntry?,
    onDismissDelete: () -> Unit,
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
                Text(
                    when (kind) {
                        CreateFolderItemKind.MARKDOWN_NOTE -> "New Markdown note"
                        CreateFolderItemKind.PORTABLE_NOTE -> "New portable note"
                        CreateFolderItemKind.SUBFOLDER -> "New subfolder"
                    }
                )
            },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(
                        text = "In $targetLabel",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        FilterChip(
                            selected = kind == CreateFolderItemKind.MARKDOWN_NOTE,
                            onClick = { kind = CreateFolderItemKind.MARKDOWN_NOTE },
                            label = { Text(".md") },
                        )
                        FilterChip(
                            selected = kind == CreateFolderItemKind.PORTABLE_NOTE,
                            onClick = { kind = CreateFolderItemKind.PORTABLE_NOTE },
                            label = { Text(".smd") },
                        )
                        FilterChip(
                            selected = kind == CreateFolderItemKind.SUBFOLDER,
                            onClick = { kind = CreateFolderItemKind.SUBFOLDER },
                            label = { Text("Folder") },
                        )
                    }
                    OutlinedTextField(
                        value = rawName,
                        onValueChange = { rawName = it },
                        singleLine = true,
                        isError = validation?.isFailure == true,
                        label = {
                            Text(if (kind == CreateFolderItemKind.SUBFOLDER) "Folder name" else "Note name")
                        },
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
                            CreateFolderItemKind.MARKDOWN_NOTE -> model.createFolderNote(req.parentRelative, rawName, portable = false) {
                                if (it != null) onNoteCreated()
                            }
                            CreateFolderItemKind.PORTABLE_NOTE -> model.createFolderNote(req.parentRelative, rawName, portable = true) {
                                if (it != null) onNoteCreated()
                            }
                        }
                    },
                ) {
                    Text("Create")
                }
            },
            dismissButton = {
                TextButton(onClick = onDismissCreate) { Text("Cancel") }
            },
        )
    }

    if (renameTarget != null) {
        val currentExt = if (renameTarget.directory) "" else renameTarget.name.substringAfterLast('.', "md")
        val initialText = if (renameTarget.directory) renameTarget.name else renameTarget.name.substringBeforeLast('.')
        var rawName by remember(renameTarget) { mutableStateOf(initialText) }
        val validation = remember(rawName, renameTarget) {
            if (rawName.isBlank()) null
            else runCatching {
                validateFolderEntryName(rawName, isDirectory = renameTarget.directory, currentExtension = currentExt)
            }
        }
        AlertDialog(
            onDismissRequest = onDismissRename,
            title = { Text(if (renameTarget.directory) "Rename folder" else "Rename note") },
            text = {
                OutlinedTextField(
                    value = rawName,
                    onValueChange = { rawName = it },
                    singleLine = true,
                    isError = validation?.isFailure == true,
                    label = { Text(if (renameTarget.directory) "Folder name" else "Note name") },
                    supportingText = {
                        val err = validation?.exceptionOrNull()?.message
                        val okName = validation?.getOrNull()
                        when {
                            err != null -> Text(err, color = MaterialTheme.colorScheme.error)
                            !renameTarget.directory && okName != null -> Text("Saves as $okName")
                        }
                    },
                )
            },
            confirmButton = {
                TextButton(
                    enabled = validation?.isSuccess == true,
                    onClick = {
                        val target = renameTarget
                        onDismissRename()
                        model.renameFolderEntry(
                            entryUri = Uri.parse(target.uri),
                            entryRelative = target.relative,
                            isDirectory = target.directory,
                            requested = rawName,
                        )
                    },
                ) {
                    Text("Rename")
                }
            },
            dismissButton = {
                TextButton(onClick = onDismissRename) { Text("Cancel") }
            },
        )
    }

    if (moveTarget != null) {
        val initialParent = remember(moveTarget) { parentRelativePath(moveTarget.relative) }
        var selectedDestination by remember(moveTarget) { mutableStateOf(initialParent) }
        var expandedRelatives by remember(moveTarget) {
            mutableStateOf(ancestorRelativePaths(initialParent))
        }
        val excludeFolder = if (moveTarget.directory) moveTarget.relative else null

        LaunchedEffect(moveTarget, expandedRelatives) {
            model.loadMovePickerTargets(excludeFolderRelative = excludeFolder, expandedRelatives = expandedRelatives)
        }

        val blockedSelfMove = moveTarget.directory && isSameOrDescendantFolder(moveTarget.relative, selectedDestination)

        AlertDialog(
            onDismissRequest = onDismissMove,
            title = { Text("Move \"${moveTarget.name}\"") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        text = "Choose a destination folder within your open folder:",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Surface(
                        tonalElevation = 1.dp,
                        shape = MaterialTheme.shapes.small,
                        modifier = Modifier.fillMaxWidth().heightIn(min = 120.dp, max = 300.dp),
                    ) {
                        LazyColumn(Modifier.fillMaxWidth()) {
                            items(state.movePickerTargets, key = { "picker:${it.relative}" }) { folderItem ->
                                val selected = selectedDestination == folderItem.relative
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .clickable { selectedDestination = folderItem.relative }
                                        .padding(
                                            start = (8 + folderItem.depth * 16).dp,
                                            end = 8.dp,
                                            top = 6.dp,
                                            bottom = 6.dp,
                                        ),
                                ) {
                                    if (!folderItem.isRoot && folderItem.expandable) {
                                        IconButton(
                                            onClick = {
                                                expandedRelatives = if (folderItem.expanded) {
                                                    expandedRelatives - folderItem.relative
                                                } else {
                                                    expandedRelatives + folderItem.relative
                                                }
                                            },
                                            modifier = Modifier.size(28.dp),
                                        ) {
                                            Icon(
                                                imageVector = if (folderItem.expanded) Icons.Rounded.ExpandMore else Icons.Rounded.ChevronRight,
                                                contentDescription = if (folderItem.expanded) "Collapse" else "Expand",
                                                modifier = Modifier.size(18.dp),
                                            )
                                        }
                                    } else {
                                        Spacer(Modifier.width(28.dp))
                                    }
                                    Icon(
                                        imageVector = if (folderItem.isRoot) Icons.Rounded.FolderOpen else Icons.Rounded.Folder,
                                        contentDescription = null,
                                        tint = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                                        modifier = Modifier.size(20.dp),
                                    )
                                    Spacer(Modifier.width(8.dp))
                                    Text(
                                        text = folderItem.name,
                                        style = MaterialTheme.typography.bodyMedium,
                                        fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                                        color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                        modifier = Modifier.weight(1f),
                                    )
                                    if (selected) {
                                        Icon(
                                            Icons.Rounded.Check,
                                            contentDescription = "Selected",
                                            tint = MaterialTheme.colorScheme.primary,
                                            modifier = Modifier.size(18.dp),
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(
                    enabled = !blockedSelfMove && selectedDestination != initialParent,
                    onClick = {
                        val target = moveTarget
                        val destination = selectedDestination
                        onDismissMove()
                        model.requestMoveFolderEntry(
                            entryUri = Uri.parse(target.uri),
                            entryRelative = target.relative,
                            isDirectory = target.directory,
                            targetParentRelative = destination,
                        )
                    },
                ) {
                    Text("Move")
                }
            },
            dismissButton = {
                TextButton(onClick = onDismissMove) { Text("Cancel") }
            },
        )
    }

    state.moveImagesPrompt?.let { prompt ->
        AlertDialog(
            onDismissRequest = model::dismissMoveImagesPrompt,
            title = { Text("Linked local images") },
            text = {
                Text(
                    buildString {
                        append("\"${prompt.entryName}\" links to ${prompt.imageCount} relative local ")
                        append(if (prompt.imageCount == 1) "image or diagram" else "images or diagrams")
                        append(". Moving the note to another folder will break relative paths unless those files exist beside the new location.")
                        if (!prompt.canCopy) {
                            append("\n\nSome relative paths point outside the open folder root and cannot be copied automatically.")
                        }
                    }
                )
            },
            confirmButton = {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(
                        onClick = {
                            model.moveFolderEntry(
                                entryUri = Uri.parse(prompt.entryUri),
                                entryRelative = prompt.entryRelative,
                                isDirectory = prompt.isDirectory,
                                targetParentRelative = prompt.targetRelative,
                                copyImages = false,
                            )
                        }
                    ) {
                        Text("Move note only")
                    }
                    if (prompt.canCopy) {
                        Button(
                            onClick = {
                                model.moveFolderEntry(
                                    entryUri = Uri.parse(prompt.entryUri),
                                    entryRelative = prompt.entryRelative,
                                    isDirectory = prompt.isDirectory,
                                    targetParentRelative = prompt.targetRelative,
                                    copyImages = true,
                                )
                            }
                        ) {
                            Text("Copy images & move")
                        }
                    }
                }
            },
            dismissButton = {
                TextButton(onClick = model::dismissMoveImagesPrompt) { Text("Cancel") }
            },
        )
    }

    if (deleteTarget != null) {
        AlertDialog(
            onDismissRequest = onDismissDelete,
            title = {
                Text(if (deleteTarget.directory) "Delete folder?" else "Delete note?")
            },
            text = {
                Text(
                    if (deleteTarget.directory) {
                        "Delete folder \"${deleteTarget.name}\" and all items inside it from your device storage? Any unsaved edits in open tabs inside this folder will be preserved in closed-note recovery before closing."
                    } else {
                        "Delete \"${deleteTarget.name}\" from your device storage? Any unsaved edits in an open tab will be preserved in closed-note recovery before closing."
                    }
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        val target = deleteTarget
                        onDismissDelete()
                        model.deleteFolderEntry(
                            entryUri = Uri.parse(target.uri),
                            entryRelative = target.relative,
                            isDirectory = target.directory,
                        )
                    }
                ) {
                    Text("Delete", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = {
                TextButton(onClick = onDismissDelete) { Text("Cancel") }
            },
        )
    }
}
