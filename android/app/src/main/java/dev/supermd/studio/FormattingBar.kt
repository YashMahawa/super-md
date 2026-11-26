package dev.supermd.studio

import android.view.KeyEvent
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.FormatListBulleted
import androidx.compose.material.icons.rounded.Code
import androidx.compose.material.icons.rounded.FormatBold
import androidx.compose.material.icons.rounded.FormatItalic
import androidx.compose.material.icons.rounded.FormatQuote
import androidx.compose.material.icons.rounded.Functions
import androidx.compose.material.icons.rounded.Link
import androidx.compose.material.icons.rounded.Title
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalMinimumInteractiveComponentSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

internal data class MarkdownFormatSpec(
    val id: String,
    val label: String,
    val shortcutHint: String,
    val icon: ImageVector,
)

internal val MARKDOWN_FORMAT_SPECS: List<MarkdownFormatSpec> = listOf(
    MarkdownFormatSpec("bold", "Bold", "Ctrl+B", Icons.Rounded.FormatBold),
    MarkdownFormatSpec("italic", "Italic", "Ctrl+I", Icons.Rounded.FormatItalic),
    MarkdownFormatSpec("inline_code", "Inline code", "Ctrl+E", Icons.Rounded.Code),
    MarkdownFormatSpec("link", "Link", "Ctrl+K", Icons.Rounded.Link),
    MarkdownFormatSpec("heading", "Heading", "Ctrl+Shift+H", Icons.Rounded.Title),
    MarkdownFormatSpec("list", "Bulleted list", "Ctrl+Shift+L", Icons.AutoMirrored.Rounded.FormatListBulleted),
    MarkdownFormatSpec("quote", "Blockquote", "Ctrl+Shift+Q", Icons.Rounded.FormatQuote),
    MarkdownFormatSpec("inline_math", "Inline math", "Ctrl+Shift+M", Icons.Rounded.Functions),
)

internal val EDITABLE_MODES = setOf("editor", "split", "live")

internal fun canTriggerHardwareFormatShortcut(
    mode: String,
    editorFocused: Boolean,
    readerReady: Boolean,
    readerOverlay: Boolean,
    modalOpen: Boolean,
): Boolean = readerReady && editorFocused && !readerOverlay && !modalOpen && mode in EDITABLE_MODES

internal fun shouldShowKeyboardFormattingBar(
    mode: String,
    imeVisible: Boolean,
    editorFocused: Boolean,
    readerReady: Boolean,
    readerOverlay: Boolean,
    modalOpen: Boolean,
): Boolean = imeVisible && canTriggerHardwareFormatShortcut(mode, editorFocused, readerReady, readerOverlay, modalOpen)

internal fun shouldCollapseChromeForLandscapeKeyboard(
    mode: String,
    imeVisible: Boolean,
    modalOpen: Boolean,
    viewportWidthDp: Float,
    viewportHeightDp: Float,
    imeBottomDp: Float = 0f,
    chromeHeightDp: Float = 0f,
): Boolean {
    if (!imeVisible || modalOpen || mode !in EDITABLE_MODES) return false
    if (viewportWidthDp <= viewportHeightDp) return false
    val remainingAfterIme = (viewportHeightDp - imeBottomDp).coerceAtLeast(0f)
    val effectiveChrome = if (chromeHeightDp > 0f) chromeHeightDp else 176f
    return viewportHeightDp < 560f || (remainingAfterIme - effectiveChrome - 44f) < 180f
}

internal fun markdownFormatActionForKey(
    keyCode: Int,
    isCtrlPressed: Boolean,
    isShiftPressed: Boolean,
    isAltPressed: Boolean,
    isMetaPressed: Boolean = false,
): String? {
    val primaryModifier = (isCtrlPressed && !isMetaPressed) || (isMetaPressed && !isCtrlPressed)
    if (!primaryModifier) return null
    if (isAltPressed) {
        return if (!isShiftPressed && keyCode == KeyEvent.KEYCODE_Q) "quote" else null
    }
    return if (!isShiftPressed) {
        when (keyCode) {
            KeyEvent.KEYCODE_B -> "bold"
            KeyEvent.KEYCODE_I -> "italic"
            KeyEvent.KEYCODE_E, KeyEvent.KEYCODE_GRAVE -> "inline_code"
            KeyEvent.KEYCODE_K -> "link"
            else -> null
        }
    } else {
        when (keyCode) {
            KeyEvent.KEYCODE_H -> "heading"
            KeyEvent.KEYCODE_L -> "list"
            KeyEvent.KEYCODE_Q -> "quote"
            KeyEvent.KEYCODE_M -> "inline_math"
            else -> null
        }
    }
}

@Composable
private fun FormatActionIconButton(
    spec: MarkdownFormatSpec,
    tint: Color,
    onFormat: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    IconButton(
        onClick = { onFormat(spec.id) },
        modifier = modifier
            .focusProperties { canFocus = false }
            .testTag("format_${spec.id}"),
    ) {
        Icon(
            imageVector = spec.icon,
            contentDescription = "${spec.label} (${spec.shortcutHint})",
            tint = tint,
        )
    }
}

@Composable
internal fun KeyboardFormattingBar(
    onFormat: (String) -> Unit,
    modifier: Modifier = Modifier,
    compact: Boolean = false,
) {
    val palette = MaterialTheme.colorScheme
    val density = LocalDensity.current
    Surface(
        color = palette.surfaceContainerLow,
        contentColor = palette.onSurface,
        modifier = modifier
            .fillMaxWidth()
            .focusProperties { canFocus = false }
            .testTag("keyboard_formatting_bar")
            .semantics { contentDescription = "Markdown formatting" },
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .focusProperties { canFocus = false },
        ) {
            HorizontalDivider(color = palette.outlineVariant.copy(alpha = 0.55f))
            BoxWithConstraints(
                modifier = Modifier
                    .fillMaxWidth()
                    .windowInsetsPadding(WindowInsets.displayCutout.only(WindowInsetsSides.Horizontal))
                    .focusProperties { canFocus = false },
            ) {
                val count = MARKDOWN_FORMAT_SPECS.size
                val buttonHeight: Dp = if (compact) 40.dp else 48.dp
                val verticalPad: Dp = if (compact) 0.dp else 2.dp
                val fullRowPx = with(density) { count * 48.dp.roundToPx() + (count - 1) * 2.dp.roundToPx() }
                val minSingleRowPx = with(density) { 312.dp.roundToPx() }
                CompositionLocalProvider(LocalMinimumInteractiveComponentSize provides 0.dp) {
                    when {
                        constraints.maxWidth >= fullRowPx -> {
                            val sidePadPx = ((constraints.maxWidth - fullRowPx) / 2).coerceIn(0, with(density) { 8.dp.roundToPx() })
                            val sidePad = with(density) { sidePadPx.toDp() }
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(horizontal = sidePad, vertical = verticalPad)
                                    .focusProperties { canFocus = false },
                                horizontalArrangement = Arrangement.spacedBy(2.dp, Alignment.CenterHorizontally),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                MARKDOWN_FORMAT_SPECS.forEach { spec ->
                                    FormatActionIconButton(
                                        spec = spec,
                                        tint = palette.onSurface,
                                        onFormat = onFormat,
                                        modifier = Modifier.size(width = 48.dp, height = buttonHeight),
                                    )
                                }
                            }
                        }
                        constraints.maxWidth >= minSingleRowPx -> {
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(vertical = verticalPad)
                                    .focusProperties { canFocus = false },
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                MARKDOWN_FORMAT_SPECS.forEach { spec ->
                                    FormatActionIconButton(
                                        spec = spec,
                                        tint = palette.onSurface,
                                        onFormat = onFormat,
                                        modifier = Modifier
                                            .weight(1f)
                                            .height(buttonHeight),
                                    )
                                }
                            }
                        }
                        !compact -> {
                            val perRow = (count + 1) / 2
                            Column(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(vertical = verticalPad)
                                    .focusProperties { canFocus = false },
                            ) {
                                MARKDOWN_FORMAT_SPECS.chunked(perRow).forEach { rowSpecs ->
                                    Row(
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .focusProperties { canFocus = false },
                                        verticalAlignment = Alignment.CenterVertically,
                                    ) {
                                        rowSpecs.forEach { spec ->
                                            FormatActionIconButton(
                                                spec = spec,
                                                tint = palette.onSurface,
                                                onFormat = onFormat,
                                                modifier = Modifier
                                                    .weight(1f)
                                                    .height(buttonHeight),
                                            )
                                        }
                                    }
                                }
                            }
                        }
                        else -> {
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .horizontalScroll(rememberScrollState())
                                    .padding(horizontal = 4.dp, vertical = verticalPad)
                                    .focusProperties { canFocus = false },
                                horizontalArrangement = Arrangement.spacedBy(2.dp, Alignment.CenterHorizontally),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                MARKDOWN_FORMAT_SPECS.forEach { spec ->
                                    FormatActionIconButton(
                                        spec = spec,
                                        tint = palette.onSurface,
                                        onFormat = onFormat,
                                        modifier = Modifier.size(width = 40.dp, height = buttonHeight),
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
