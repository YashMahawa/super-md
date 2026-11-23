package dev.supermd.studio

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Rect
import android.net.Uri
import android.view.ActionMode
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.webkit.WebView
import android.widget.Toast
import org.json.JSONTokener

/** Adds to the OS selection toolbar while preserving WebView's native handles. */
internal class SelectionReaderWebView(context: Context, private val model: StudioViewModel) : WebView(context) {
    private fun wrap(callback: ActionMode.Callback): ActionMode.Callback =
        if (callback is SelectionActionCallback) callback else SelectionActionCallback(callback,
            { SelectionActions.label(model.state.value.selectionAssistant) }, ::selectedAction)

    override fun startActionMode(callback: ActionMode.Callback): ActionMode? = super.startActionMode(wrap(callback))
    override fun startActionMode(callback: ActionMode.Callback, type: Int): ActionMode? = super.startActionMode(wrap(callback), type)
    // Chromium can start selection through its child content view instead of
    // the WebView itself. Both routes must keep the native callback wrapped.
    override fun startActionModeForChild(child: View, callback: ActionMode.Callback): ActionMode? = super.startActionModeForChild(child, wrap(callback))
    override fun startActionModeForChild(child: View, callback: ActionMode.Callback, type: Int): ActionMode? = super.startActionModeForChild(child, wrap(callback), type)

    private fun selectedAction(action: String, mode: ActionMode) {
        val noteId = model.state.value.active.id
        val provider = model.state.value.selectionAssistant
        // Read before finishing ActionMode, which can clear the native range.
        // Textarea selection uses its own offsets rather than window.Selection.
        evaluateJavascript("(() => { const e=document.activeElement; return e instanceof HTMLTextAreaElement || e instanceof HTMLInputElement ? e.value.slice(e.selectionStart || 0,e.selectionEnd || 0) : window.getSelection()?.toString() || ''; })()") { raw ->
            if (getTag(R.id.reader_destroyed_tag) == true || model.state.value.active.id != noteId) return@evaluateJavascript
            try {
                val text = runCatching { JSONTokener(raw).nextValue() as? String }.getOrNull().orEmpty().replace('\u2029','\n')
                val target = SelectionActions.target(action, text, provider)
                if (target.copy) context.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("Selected text", text))
                mode.finish()
                try {
                    context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(target.url)))
                    Toast.makeText(context, target.message, Toast.LENGTH_LONG).show()
                } catch (_: android.content.ActivityNotFoundException) {
                    model.fail("Could not open your browser." + if (target.copy) " The selected text is copied." else "")
                } catch (_: SecurityException) {
                    model.fail("Your device blocked opening the browser." + if (target.copy) " The selected text is copied." else "")
                }
            } catch (error: IllegalArgumentException) {
                model.fail(error.message ?: "Could not use the selected text.")
            }
        }
    }
}

/** Preserve the platform callback, including floating-toolbar anchor geometry. */
internal class SelectionActionCallback(
    private val original: ActionMode.Callback,
    private val assistantLabel: () -> String,
    private val selectedAction: (String, ActionMode) -> Unit,
) : ActionMode.Callback2() {
    override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
        if (!original.onCreateActionMode(mode, menu)) return false
        update(menu)
        return true
    }
    override fun onPrepareActionMode(mode: ActionMode, menu: Menu): Boolean {
        val changed = original.onPrepareActionMode(mode, menu)
        return update(menu) || changed
    }
    private fun update(menu: Menu): Boolean {
        var changed = false
        if (menu.findItem(SEARCH) == null) { menu.add(GROUP, SEARCH, 100, "Search Google").setShowAsAction(MenuItem.SHOW_AS_ACTION_IF_ROOM); changed = true }
        val title = "Ask ${assistantLabel()}…"
        if (menu.findItem(ASK)?.title != title) changed = true
        val ask = menu.findItem(ASK) ?: menu.add(GROUP, ASK, 101, "")
        ask.title = title
        ask.setShowAsAction(MenuItem.SHOW_AS_ACTION_IF_ROOM)
        return changed
    }
    override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean = when (item.itemId) {
        SEARCH -> { selectedAction("google", mode); true }
        ASK -> { selectedAction("assistant", mode); true }
        else -> original.onActionItemClicked(mode, item)
    }
    override fun onDestroyActionMode(mode: ActionMode) = original.onDestroyActionMode(mode)
    override fun onGetContentRect(mode: ActionMode, view: View, outRect: Rect) {
        if (original is ActionMode.Callback2) original.onGetContentRect(mode, view, outRect)
        else super.onGetContentRect(mode, view, outRect)
    }
    companion object {
        private const val GROUP = 0x534d4400
        internal const val SEARCH = GROUP + 1
        internal const val ASK = GROUP + 2
    }
}
