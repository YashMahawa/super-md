package dev.supermd.studio

import android.net.Uri
import org.json.JSONObject
import java.security.MessageDigest
import java.util.UUID

data class Note(val id: String = UUID.randomUUID().toString(), val name: String = "Untitled.md", val uri: String? = null, val content: String = "", val saved: String = "", val relative: String? = null, val assetDirectory: String? = null, val assetsDirty: Boolean = false) {
    val dirty get() = content != saved || assetsDirty
    val portable get() = assetDirectory != null
    val requiresCloseConfirmation get() = if (uri == null) (content.isNotBlank() || assetsDirty) && dirty else dirty
}
internal class ExternalConflictDetectedException : RuntimeException()
internal data class OpenDocumentTarget(
    val uri: Uri,
    val externalIntentFlags: Int? = null,
    val externalCaller: ExternalIntentCaller = ExternalIntentCaller(),
)
internal const val MAX_AGENT_SNAPSHOT_BYTES = 2 * 1024 * 1024
internal enum class PortableSaveRecovery { ORIGINAL_INTACT, RESTORE_OUR_WRITE, LEAVE_CONCURRENT_BYTES }
internal fun agentContentRevision(content: String): String = MessageDigest.getInstance("SHA-256")
    .digest(content.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
internal fun portableAssetsMatch(left: JSONObject, right: JSONObject): Boolean =
    left.length() == right.length() && left.keys().asSequence().all { key -> left.optString(key) == right.optString(key) }
internal fun portableSaveSnapshotMatches(note: Note, expectedRevision: String, diskMarkdown: String, currentAssets: JSONObject, diskAssets: JSONObject): Boolean =
    agentContentRevision(note.content).equals(expectedRevision, ignoreCase = true) && diskMarkdown == note.saved && portableAssetsMatch(currentAssets, diskAssets)
internal fun portableSaveRecovery(current: ByteArray, original: ByteArray, staged: ByteArray): PortableSaveRecovery = when {
    current.contentEquals(original) -> PortableSaveRecovery.ORIGINAL_INTACT
    current.contentEquals(staged) -> PortableSaveRecovery.RESTORE_OUR_WRITE
    else -> PortableSaveRecovery.LEAVE_CONCURRENT_BYTES
}
internal fun matchesAssetWriteSnapshot(current: Note?, activeId: String, expected: Note, requireActive: Boolean = true): Boolean =
    current != null && current.id == expected.id && (!requireActive || activeId == expected.id)
        && current.content == expected.content && current.saved == expected.saved
        && current.uri == expected.uri && current.assetDirectory == expected.assetDirectory && current.portable == expected.portable
data class RecentNote(val name: String, val uri: String, val relative: String? = null, val pinned:Boolean=false)
internal fun orderedRecents(notes:List<RecentNote>)=notes.distinctBy {it.uri}.sortedByDescending {it.pinned}.take(10)
internal fun renamedRelative(relative:String?,name:String)=relative?.let {val parent=it.substringBeforeLast('/',"");if(parent.isEmpty())name else "$parent/$name"}
data class FileEntry(val name: String, val uri: String, val directory: Boolean, val relative: String)
data class OutlineHeading(val id: String, val title: String, val level: Int, val offset: Int)
private val EMPTY_NOTE = Note(id = "", name = "Super MD", content = "", saved = "")
data class StudioState(val latexAutofix:Boolean=false, val typewriterScroll:Boolean=false, val selectionAssistant:String="chatgpt", val centerLock:Boolean=true, val customTheme:String="", val activeThemeKind:String="builtin", val activeThemeId:String="", val customThemeSource:String="", val savedThemes:List<SavedThemeEntry> = emptyList(), val patternKind:String="", val patternOpacity:Float=-1f, val patternSize:Float=0f, val patternSpacing:Float=0f, val restorePosition:Boolean=true, val fullDocumentAccessibility:Boolean=false, val startup:String="restore", val imageAppearance:String="original", val svgAppearance:String="original", val imageContrast:Float=1.25f, val spellCheck:Boolean = false, val grammarCheck:Boolean = false, val accent: String = "system", val widthPercent: Float = 100f, val lineHeight: Float = 1.65f, val autosave: Boolean = true, val customFonts: List<String> = emptyList(), val readerOverlay: Boolean = false, val editorFocused: Boolean = false, val zoomCommand: Long = 0, val tabs: List<Note> = listOf(Note(name = "Welcome.md", content = sample, saved = sample)), val closedTabs: List<Note> = emptyList(), val activeId: String = "", val mode: String = "live", val fullscreen: Boolean = false, val normalZoom: Float = 100f, val fullscreenZoom: Float = 100f, val theme: String = "system", val fullscreenTheme: String = "black", val motion: Boolean = true, val font: String = "Manrope", val size: Float = 15f, val folder: String? = null, val folderRelative: String = "", val files: List<FileEntry> = emptyList(), val busy: Boolean = false, val message: String? = null, val error: String? = null, val welcomed: Boolean = false, val pdf: String = "{\"pageSize\":\"a4\",\"margin\":14,\"fontSize\":10.5,\"lineHeight\":1.4,\"paragraphSpacing\":0.65,\"fontFamily\":\"Manrope\",\"pageNumbers\":true}", val storageReport: StorageReport? = null, val storageScanning: Boolean = false, val conflictedTabIds: Set<String> = emptySet(), val blockedWriteUris: Set<String> = emptySet(), val pendingCloseNoteId: String? = null, val pendingSaveConflictNoteId: String? = null, val pendingHeading: PendingHeadingJump? = null, val folderAccessPrompt: WorkspaceFolderPrompt? = null) {
    val active get() = tabs.find { it.id == activeId } ?: tabs.firstOrNull() ?: EMPTY_NOTE
    val zoom get() = if (fullscreen) fullscreenZoom else normalZoom
    val activeConflicted get() = active.id.isNotEmpty() && active.id in conflictedTabIds
    val pendingCloseNote get() = pendingCloseNoteId?.let { id -> tabs.find { it.id == id } }
    val pendingSaveConflictNote get() = pendingSaveConflictNoteId?.let { id -> tabs.find { it.id == id } }
    fun writeNeedsAccess(id: String): Boolean {
        if (blockedWriteUris.isEmpty()) return false
        val uri = tabs.firstOrNull { it.id == id }?.uri ?: return false
        val parsed = Uri.parse(uri)
        return blockedWriteUris.any { sameDocument(Uri.parse(it), parsed) }
    }
}
val sample = """
# A clear place to think

> [!TIP] Try it, then explain it
> Your notes stay portable. Open any folder, use live or source mode, and export a properly typeset PDF offline.

## Mathematics

Inline ${'$'}e^{i\pi}+1=0${'$'} and a full display equation:

${'$'}${'$'}
\begin{pmatrix}1&2\\3&4\end{pmatrix}\qquad\int_0^1 x^2\,dx=\frac13
${'$'}${'$'}

| Topic | Formula |
|---|---|
| Gaussian | ${'$'}e^{-x^2}${'$'} |
| Circle | ${'$'}\pi r^2${'$'} |

```smd-chart
{"title":"Explore a sine wave","x":{"min":-6.28,"max":6.28},"series":[{"expression":"a * Math.sin(x)"}],"sliders":[{"name":"a","label":"Amplitude","min":0.1,"max":3,"step":0.05,"value":1}]}
```

```mermaid
flowchart LR
  Read --> Explore --> Understand
```

## Local Matplotlib

Press Run to execute this code on your device. Nothing runs automatically when opening or exporting a note.

```python
import numpy as np
import matplotlib.pyplot as plt
x = np.linspace(-4, 4, 200)
plt.plot(x, np.exp(-x*x), color="#42669e")
plt.title("Gaussian")
plt.grid(alpha=.2)
```
""".trimIndent()

fun reorderedNotes(notes: List<Note>, id: String, index: Int): List<Note> {
    val source = notes.indexOfFirst { it.id == id }
    if (source < 0 || index !in notes.indices || source == index) return notes
    return notes.toMutableList().apply { add(index, removeAt(source)) }
}
