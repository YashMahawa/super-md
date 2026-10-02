package dev.supermd.studio

import androidx.compose.animation.core.spring
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/** Long press takes ownership of a drag; ordinary swipes still scroll the row.
 * Stable keys preserve each tab's gesture node while its position changes. */
@Composable fun NoteTabs(notes: List<Note>, active: String, motion: Boolean, select: (String) -> Unit, close: (String) -> Unit, reorder: (String, Int) -> Unit, newNote: () -> Unit) {
    val scroll = rememberLazyListState()
    val bounds = remember { mutableStateMapOf<String, Rect>() }
    var viewport by remember { mutableStateOf(Rect.Zero) }
    var dragging by remember { mutableStateOf<String?>(null) }
    var dragX by remember { mutableFloatStateOf(0f) }
    var grip by remember { mutableFloatStateOf(0f) }
    val currentNotes by rememberUpdatedState(notes)
    val move by rememberUpdatedState(reorder)
    val haptics = LocalHapticFeedback.current
    val edge = with(LocalDensity.current) { 48.dp.toPx() }
    LaunchedEffect(dragging) {
        while (dragging != null) {
            withFrameNanos { }
            val delta = when { dragX < viewport.left + edge -> -12f; dragX > viewport.right - edge -> 12f; else -> 0f }
            if (delta != 0f) scroll.scrollBy(delta)
        }
    }
    LazyRow(state = scroll, modifier = Modifier.fillMaxWidth().onGloballyPositioned { viewport = it.boundsInRoot() }, contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
        items(notes, key = { it.id }) { note ->
            DisposableEffect(note.id) { onDispose { bounds.remove(note.id) } }
            Surface(color = if (note.id == active) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surfaceContainerLow, shape = RoundedCornerShape(20.dp), modifier = Modifier
                .animateItem(fadeInSpec = null, fadeOutSpec = null, placementSpec = if (motion && dragging != note.id) spring(dampingRatio = .85f, stiffness = 500f) else null)
                .onGloballyPositioned { bounds[note.id] = it.boundsInRoot() }
                .graphicsLayer { shadowElevation = if (dragging == note.id) 8.dp.toPx() else 0f }
                .semantics { customActions = listOf(
                    CustomAccessibilityAction("Move tab left") { val index = currentNotes.indexOfFirst { it.id == note.id }; if (index > 0) move(note.id, index - 1); index > 0 },
                    CustomAccessibilityAction("Move tab right") { val index = currentNotes.indexOfFirst { it.id == note.id }; if (index < currentNotes.lastIndex) move(note.id, index + 1); index < currentNotes.lastIndex }
                ) }
                .pointerInput(note.id) {
                    detectDragGesturesAfterLongPress(onDragStart = { offset ->
                        grip = offset.x; dragX = (bounds[note.id]?.left ?: 0f) + grip; dragging = note.id
                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                    }, onDragEnd = { dragging = null }, onDragCancel = { dragging = null }, onDrag = { change, amount ->
                        change.consume(); dragX += amount.x
                        val target = bounds.entries.filter { it.key != note.id }.minByOrNull { kotlin.math.abs(it.value.center.x - dragX) }
                        if (target != null && dragX in target.value.left..target.value.right) {
                            val index = currentNotes.indexOfFirst { it.id == target.key }
                            if (index >= 0) move(note.id, index)
                        }
                    })
                }) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    TextButton(onClick = { select(note.id) }, contentPadding = PaddingValues(start = 16.dp, end = 4.dp), modifier = Modifier.widthIn(max = 220.dp)) { Text((if (note.dirty) "• " else "") + note.name, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                    IconButton(onClick = { close(note.id) }, modifier = Modifier.size(48.dp)) { Icon(painterResource(R.drawable.symbol_close), "Close ${note.name}", Modifier.size(20.dp)) }
                }
            }
        }
        item("new-tab") { IconButton(onClick = newNote) { Icon(painterResource(R.drawable.symbol_add), "New tab") } }
    }
}
