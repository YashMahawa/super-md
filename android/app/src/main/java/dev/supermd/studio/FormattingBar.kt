package dev.supermd.studio

import android.view.KeyEvent
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxWidth
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
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
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

private val EDITABLE_MODES = setOf("editor", "split", "live")

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
internal fun KeyboardFormattingBar(
    onFormat: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val palette = MaterialTheme.colorScheme
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
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .windowInsetsPadding(WindowInsets.displayCutout.only(WindowInsetsSides.Horizontal))
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = 8.dp, vertical = 2.dp)
                    .focusProperties { canFocus = false },
                horizontalArrangement = Arrangement.spacedBy(2.dp, Alignment.CenterHorizontally),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                MARKDOWN_FORMAT_SPECS.forEach { spec ->
                    IconButton(
                        onClick = { onFormat(spec.id) },
                        modifier = Modifier
                            .size(48.dp)
                            .focusProperties { canFocus = false }
                            .testTag("format_${spec.id}"),
                    ) {
                        Icon(
                            imageVector = spec.icon,
                            contentDescription = "${spec.label} (${spec.shortcutHint})",
                            tint = palette.onSurface,
                        )
                    }
                }
            }
        }
    }
}
