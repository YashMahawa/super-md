@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.material3.ExperimentalMaterial3ExpressiveApi::class)
package dev.supermd.studio

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
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
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties

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
