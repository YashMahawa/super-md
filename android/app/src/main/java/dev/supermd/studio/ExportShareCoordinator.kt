package dev.supermd.studio

import android.app.Application
import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.util.Base64
import androidx.core.content.FileProvider
import androidx.documentfile.provider.DocumentFile
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

internal class ExportShareCoordinator(
    private val app: Application, private val scope: CoroutineScope,
    private val media: MediaStorage, private val fonts: FontLibrary,
    private val documentAccess: DocumentAccess, private val documentWrites: Mutex,
    private val autosavePending: MutableSet<String>, private val savedPortableAssets: ConcurrentHashMap<String, JSONObject>,
    private val readState: () -> StudioState, private val updateState: (StudioState) -> Unit,
    private val changeState: ((StudioState) -> StudioState) -> Unit,
    private val busy: (Boolean) -> Unit, private val fail: (String) -> Unit,
    private val noteLocation: () -> String,
    private val readPortableSaveAsNoteId: () -> String?, private val writePortableSaveAsNoteId: (String?) -> Unit,
    private val readPortableForceOverwrite: () -> Boolean, private val writePortableForceOverwrite: (Boolean) -> Unit,
    private val readCloseAfterSaveNoteId: () -> String?, private val writeCloseAfterSaveNoteId: (String?) -> Unit,
    private val readListedRelative: () -> String,
    private val diskMatchesBaseline: (Uri, Note) -> Boolean, private val recordPortableBaseline: (String, String?) -> Unit,
    private val resolveDisplayName: (Uri) -> String?, private val resolveOpenFolderRelativeOnIo: (Uri) -> String?,
    private val rememberNote: (Note) -> Unit, private val listFolder: (Uri, String) -> Job,
    private val closeNote: (String) -> Unit, private val markAssetsDirty: (String) -> Unit,
    private val editNote: (String, String) -> Unit, private val clearReaderFolderIndex: () -> Unit,
) {
    var outputUri: Uri? = null
    var pdfDestinationIsNew: Boolean = false
    var portableOutput: Uri? = null
    var portableDestinationIsNew: Boolean = false
    var shareReady: ((Intent) -> Unit)? = null
    private var shareFile: File? = null
    private val resolver get() = app.contentResolver

    fun clearShareFile() { shareFile = null }
    fun setPdfDestination(uri: Uri) { outputUri = uri; pdfDestinationIsNew = true }
    fun setPortableDestination(uri: Uri) { portableOutput = uri; portableDestinationIsNew = true }

    fun pdfExportCancelled() {
        shareFile = null
        outputUri = null
        updateState(readState().copy(busy = false, message = "PDF export cancelled"))
    }

    fun prepareShare(format: String): Boolean {
        val state = readState()
        if (state.busy || format !in listOf("pdf", "smd", "md", "mdzip")) return false
        val folder = File(app.cacheDir, "share/${UUID.randomUUID()}").apply { mkdirs() }
        val filename = if (format == "mdzip") ExportFilename.suggestedName(state.active.name, NativeExportFormat.MARKDOWN).removeSuffix(".md") + ".zip"
            else ExportFilename.suggestedName(state.active.name, NativeExportFormat.fromShareFormat(format))
        val file = File(folder, filename)
        shareFile = file
        busy(true)
        when (format) {
            "pdf" -> { outputUri = Uri.fromFile(file); pdfDestinationIsNew = false }
            "smd" -> { portableOutput = Uri.fromFile(file); portableDestinationIsNew = false }
        }
        return true
    }

    fun prepareMarkdownExport(sharing: Boolean, archive: Boolean): Boolean {
        if (readState().busy) return false
        shareFile = null
        if (sharing) return prepareShare(if (archive) "mdzip" else "md")
        busy(true)
        return true
    }

    suspend fun shareMarkdown(id: String, content: String, assets: JSONObject, archive: Boolean) {
        val note = readState().tabs.firstOrNull { it.id == id } ?: error("The export note is no longer open")
        val filename = ExportFilename.suggestedName(note.name, NativeExportFormat.MARKDOWN)
        val shared = shareFile
        val companions = mutableListOf<File>()
        val output = withContext(Dispatchers.IO) {
            MarkdownExport(app, filename, content, assets).use { bundle ->
                if (shared == null) bundle.save(noteLocation(), archive)
                else {
                    require(shared.extension == if (archive) "zip" else "md") { "The share format changed; try again" }
                    if (archive) shared.outputStream().use(bundle::writeZip)
                    else {
                        for ((path, item) in bundle.files) {
                            val target = File(shared.parentFile, path)
                            check(target.parentFile!!.mkdirs() || target.parentFile!!.isDirectory)
                            item.first.copyTo(target, overwrite = false)
                            companions += target
                        }
                        bundle.markdown.copyTo(shared, overwrite = false)
                    }
                    Uri.fromFile(shared) to shared.name
                }
            }
        }
        if (shared != null) finishShare(output.first, companions)
        else updateState(readState().copy(busy = false, message = "Exported ${output.second}${if (noteLocation().isBlank()) " to Downloads/Super MD" else " to your configured folder"}"))
    }

    private fun finishShare(target: Uri, companions: List<File> = emptyList()): Boolean {
        val file = shareFile ?: return false
        if (target != Uri.fromFile(file)) return false
        val uri = FileProvider.getUriForFile(app, "${app.packageName}.share", file)
        val mime = if (file.extension == "zip") "application/zip" else NativeExportFormat.fromShareFormat(file.extension).mimeType
        val send = if (companions.isEmpty()) Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri)
            else Intent(Intent.ACTION_SEND_MULTIPLE).setType("*/*").putParcelableArrayListExtra(Intent.EXTRA_STREAM, arrayListOf(uri).apply {
                companions.forEach { add(FileProvider.getUriForFile(app, "${app.packageName}.share", it)) }
            })
        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION).apply {
            clipData = ClipData.newUri(app.contentResolver, file.name, uri).also { clip ->
                companions.forEach { clip.addItem(ClipData.Item(FileProvider.getUriForFile(app, "${app.packageName}.share", it))) }
            }
        }
        shareFile = null
        updateState(readState().copy(busy = false, message = "Share copy ready"))
        shareReady?.invoke(send) ?: error("The share screen is no longer open. Your copy is still in the app cache.")
        return true
    }

    /** Validate the new SAF target before opening it for output; never rename an existing note URI. */
    fun prepareExportDestination(uri: Uri, format: NativeExportFormat, allowRename: Boolean): Uri {
        if (uri.scheme != "content") {
            val name = uri.lastPathSegment ?: ""
            require(ExportFilename.suffixMatches(name, format)) { "The destination name must end in .${format.extension}" }
            return uri
        }
        fun metadata(target: Uri) = ExportDocumentMetadata(
            resolver.query(target, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                val column = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (column >= 0 && cursor.moveToFirst()) cursor.getString(column)?.takeIf(String::isNotBlank) else null
            },
            resolver.getType(target),
        )
        var target = uri
        ExportDestinationPolicy.validate(metadata(target), format, allowRename) { correctedName ->
            val renamed = runCatching { DocumentsContract.renameDocument(resolver, target, correctedName) }.getOrNull()
            if (renamed == null) null else {
                // Keep the provider-returned URI; some providers move documents
                // to a different document ID when renaming.
                target = renamed
                metadata(target)
            }
        }
        if (target != uri) {
            if (uri == outputUri) outputUri = target
            if (uri == portableOutput) portableOutput = target
        }
        return target
    }

    fun verifyExportHeader(file: File, format: NativeExportFormat) {
        val prefix = file.inputStream().use { input ->
            val buffer = ByteArray(64)
            var length = 0
            while (length < buffer.size) {
                val read = input.read(buffer, length, buffer.size - length)
                if (read <= 0) break
                length += read
            }
            buffer.copyOf(length)
        }
        require(ExportFilename.hasExpectedHeader(prefix, format)) {
            "The generated ${format.extension.uppercase()} did not have its expected file signature."
        }
    }

    fun copyAttachments(note: Note, destination: Uri, destinationTree: Uri? = null) {
        val sources = JSONArray(markdownImageSourcesJson(note.content))
        val local = (0 until sources.length()).map { sources.getString(it) }.distinct().mapNotNull { source -> media.local(source, note.assetDirectory)?.let { source to it } }
        if (local.isEmpty()) return
        val tree = destinationTree ?: readState().folder?.let(Uri::parse) ?: error("Images need a containing folder permission. Choose a folder destination or export a single portable .smd file instead.")
        val rootId = DocumentsContract.getTreeDocumentId(tree)
        val targetId = DocumentsContract.getDocumentId(destination)
        require(targetId.startsWith("$rootId/")) { "Open the destination folder, or export a portable .fmd file to include images." }
        val parent = targetId.removePrefix("$rootId/").substringBeforeLast('/', "")
        var directory = DocumentFile.fromTreeUri(app, tree) ?: error("Restore folder permission")
        parent.split('/').filter { it.isNotEmpty() }.forEach { directory = directory.findFile(it) ?: error("Destination folder disappeared") }
        val assets = directory.findFile("assets") ?: directory.createDirectory("assets") ?: error("Cannot create image folder")
        require(assets.isDirectory)
        local.forEach { (source, file) ->
            val name = source.substringAfter('/')
            val existing = assets.findFile(name)
            if (existing != null) {
                val bytes = resolver.openInputStream(existing.uri)?.use { readLimited(it, 25_000_000) }
                require(bytes != null && bytes.contentEquals(file.readBytes())) { "A different image already exists at assets/$name; use FMD export instead." }
            } else {
                val type = media.data(file).substringAfter("data:").substringBefore(';')
                val target = assets.createFile(type, name) ?: error("Cannot create image $name")
                resolver.openOutputStream(target.uri, "wt")?.use { output -> file.inputStream().use { it.copyTo(output) } } ?: error("Cannot write image")
            }
        }
        clearReaderFolderIndex()
    }

    suspend fun writePortable(id: String, content: String, assets: JSONObject, save: Boolean, originalContent: String) {
        var closeTargetId: String? = null
        withContext(Dispatchers.IO) { documentWrites.withLock {
            val rebindId = if (!save) readPortableSaveAsNoteId() else null
            val effectiveId = rebindId ?: id
            val note = readState().tabs.find { it.id == effectiveId } ?: error("The note is no longer open")
            val target = if (save) note.uri?.let { documentAccess.resolve(Uri.parse(it), writing = true) } else portableOutput
            require(target != null) { "Choose a portable file destination" }
            val force = readPortableForceOverwrite()
            writePortableForceOverwrite(false)
            if (save && !force && !diskMatchesBaseline(target, note)) {
                autosavePending.remove(effectiveId)
                withContext(Dispatchers.Main) {
                    changeState { s -> s.copy(busy = false, conflictedTabIds = s.conflictedTabIds + effectiveId, pendingSaveConflictNoteId = effectiveId) }
                }
                return@withLock
            }
            val destination = if (save) target else prepareExportDestination(target, NativeExportFormat.PORTABLE_SMD, allowRename = portableDestinationIsNew)
            val staged = File(app.cacheDir, "fmd-${UUID.randomUUID()}.tmp")
            var materializedDirectory: String? = null
            try {
                // Reuse existing extracted assets when unchanged; otherwise materialize only changed/new assets
                // before writing the archive so new assets are Base64-decoded once rather than twice.
                val rebinding = save || rebindId != null
                val nextDirectory = if (rebinding) {
                    val reuseExisting = save && rebindId == null && note.assetDirectory != null &&
                        media.hasExactLocalPortableAssets(note.assetDirectory, assets)
                    if (reuseExisting) note.assetDirectory!!
                    else media.materializePortableDirectory(assets, reuseFromDirectory = note.assetDirectory).also { materializedDirectory = it }
                } else null
                staged.outputStream().use { media.writeFmd(it, content, assets, savedPortableAssets[effectiveId]) }
                verifyExportHeader(staged, NativeExportFormat.PORTABLE_SMD)
                resolver.openOutputStream(destination, "wt")?.use { output -> staged.inputStream().use { it.copyTo(output) } } ?: error("Cannot write portable file")
                documentAccess.persist(destination)
                val savedName = if (rebindId != null) resolveDisplayName(destination) ?: ExportFilename.suggestedName(note.name, NativeExportFormat.PORTABLE_SMD) else note.name
                val openRel = if (rebinding) resolveOpenFolderRelativeOnIo(destination) else null
                withContext(Dispatchers.Main) {
                    if (rebinding) {
                        portableOutput = null; portableDestinationIsNew = false; writePortableSaveAsNoteId(null)
                        autosavePending.remove(effectiveId)
                        recordPortableBaseline(effectiveId, nextDirectory!!)
                        changeState { s ->
                            s.copy(
                                tabs = s.tabs.map {
                                    if (it.id == effectiveId) it.copy(
                                        name = if (rebindId != null) savedName else it.name,
                                        content = if (it.content == originalContent) content else it.content,
                                        saved = content, assetsDirty = false, uri = destination.toString(),
                                        relative = openRel ?: it.relative, assetDirectory = nextDirectory,
                                    ) else it
                                },
                                conflictedTabIds = s.conflictedTabIds - effectiveId,
                                pendingSaveConflictNoteId = s.pendingSaveConflictNoteId?.takeUnless { it == effectiveId },
                                busy = false, message = if (rebindId != null) "Saved" else "Portable note saved",
                            )
                        }
                        materializedDirectory = null
                        readState().tabs.find { it.id == effectiveId }?.let(rememberNote)
                        if (openRel != null) readState().folder?.let { listFolder(Uri.parse(it), readListedRelative()) }
                        if (readCloseAfterSaveNoteId() == effectiveId) { writeCloseAfterSaveNoteId(null); closeTargetId = effectiveId }
                    } else {
                        portableOutput = null; portableDestinationIsNew = false
                        if (!finishShare(destination)) updateState(readState().copy(busy = false, message = "Portable .smd exported"))
                    }
                }
            } finally {
                materializedDirectory?.let { File(app.filesDir, "portable-assets/$it").deleteRecursively() }
                staged.delete()
            }
        } }
        closeTargetId?.let(closeNote)
    }

    fun importDropped(uris: List<Uri>, id: String, result: (JSONArray?) -> Unit): Job = scope.launch {
        if (uris.isEmpty()) {
            updateState(readState().copy(message = MediaStorage.UNSUPPORTED_DROP_IMAGE_MESSAGE))
            result(null); return@launch
        }
        try {
            val batch = withContext(Dispatchers.IO) { media.importDroppedUris(uris) }
            val images = batch.images
            if (images.length() == 0) {
                updateState(readState().copy(message = MediaStorage.UNSUPPORTED_DROP_IMAGE_MESSAGE))
                result(null); return@launch
            }
            markAssetsDirty(id)
            if (batch.skippedCount > 0) {
                val skippedMessage = if (batch.skippedCount == 1) "Skipped 1 unsupported file; only PNG, JPEG, GIF, WebP, AVIF, and SVG images were imported."
                    else "Skipped ${batch.skippedCount} unsupported files; only PNG, JPEG, GIF, WebP, AVIF, and SVG images were imported."
                updateState(readState().copy(message = skippedMessage))
            }
            if (readState().active.id == id) result(images)
            else {
                val insertion = (0 until images.length()).joinToString("\n\n") { i ->
                    val image = images.getJSONObject(i)
                    "![${image.getString("alt").replace("[", "\\[").replace("]", "\\]")}](<${image.getString("source")}>)"
                }
                readState().tabs.find { it.id == id }?.let { editNote(id, it.content + "\n\n" + insertion + "\n") }
                result(null)
            }
        } catch (error: Exception) {
            fail("Could not insert image: ${error.message}")
            result(null)
        }
    }

    suspend fun export(
        content: String, options: String, assets: JSONObject,
        destination: Uri? = outputUri, job: PdfExportJob? = null,
        onPublishing: (suspend (PdfExportJob) -> Unit)? = null,
    ) = withContext(Dispatchers.IO + NonCancellable) {
        val target = destination ?: error("Choose a PDF destination first")
        val outputTarget = prepareExportDestination(target, NativeExportFormat.PDF, allowRename = target == outputUri && pdfDestinationIsNew)
        val staging = File(app.cacheDir, "pdf-${UUID.randomUUID()}").apply { mkdirs() }
        try {
            val assetDir = File(staging, "assets").apply { mkdirs() }
            assets.keys().forEach { key -> require(Regex("[a-zA-Z0-9_.-]+").matches(key)); File(assetDir, key).writeBytes(Base64.decode(assets.getString(key), Base64.DEFAULT)) }
            fonts.addPdfFonts(JSONObject(options).optString("fontFamily"), assetDir)
            val output = File(staging, "document.pdf")
            val error = PdfEngine.export(content, options, assetDir.absolutePath, output.absolutePath)
            if (error.isNotEmpty()) error(error)
            verifyExportHeader(output, NativeExportFormat.PDF)
            if (job != null) {
                check(job.beginPublishing()) { "PDF export cancelled" }
                onPublishing?.invoke(job)
            }
            resolver.openOutputStream(outputTarget, "wt")?.use { stream -> output.inputStream().use { it.copyTo(stream) } } ?: error("Cannot write PDF destination")
            job?.succeed()
            withContext(Dispatchers.Main) { if (!finishShare(outputTarget)) updateState(readState().copy(busy = false, message = "PDF exported")); outputUri = null; pdfDestinationIsNew = false }
        } catch (error: Exception) {
            job?.fail()
            throw error
        } finally { staging.deleteRecursively() }
    }
}
