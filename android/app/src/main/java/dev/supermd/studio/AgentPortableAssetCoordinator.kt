package dev.supermd.studio

import android.app.Application
import android.content.ContentResolver
import android.net.Uri
import android.util.Base64
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

internal fun interface StagedPortableRecoveryWriter {
    suspend fun write(
        target: Uri,
        markdown: String,
        savedBaselineMarkdown: String,
        updatedAssets: JSONObject,
        baselineAssets: JSONObject,
        diskChangedMessage: String,
        writeFailureMessage: String,
        prepareBeforeWrite: () -> Unit,
        recheckSnapshotBeforeWrite: () -> Unit,
        commitOnSuccess: suspend () -> Unit,
    )
}

internal class AgentPortableAssetCoordinator(
    private val app: Application,
    private val resolver: ContentResolver,
    private val media: MediaStorage,
    private val documentWrites: Mutex,
    private val readState: () -> StudioState,
    private val change: ((StudioState) -> StudioState) -> Unit,
    private val remember: (Note) -> Unit,
    private val resolveReaderAsset: (String, String) -> Pair<String, ReaderAssetSource>,
    private val verifyExportHeader: (File, NativeExportFormat) -> Unit,
    private val invalidateNoteAssets: (String) -> Unit,
    private val recordPortableBaseline: (String, String?) -> Unit,
    private val stagedPortableRecoveryWriter: StagedPortableRecoveryWriter,
) {
    /** Replace one image inside a saved portable note, without changing Markdown or other assets. */
    suspend fun replacePortableAsset(
        id: String,
        assetName: String,
        replacementPath: String,
        expectedRevision: String,
    ): JSONObject = withContext(Dispatchers.IO) {
        documentWrites.withLock {
            val note = readState().tabs.find { it.id == id } ?: error("The document is no longer open")
            require(readState().activeId == id) { "Select the target tab before replacing its image" }
            val revision = agentContentRevision(note.content)
            require(revision.equals(expectedRevision, ignoreCase = true)) { "The document changed; read it again before replacing an image" }
            require(note.portable && note.uri != null && note.saved == note.content) { "Image replacement requires a saved, unchanged portable .smd note" }
            val sourceList = JSONArray(markdownImageSourcesJson(note.content))
            val linkedAssets = (0 until sourceList.length()).map { sourceList.getString(it) }.distinct().filter(media::validKey)
            val resolvedAssetName = linkedAssets.firstOrNull { source ->
                source == assetName || MessageDigest.getInstance("SHA-256").digest(source.toByteArray(Charsets.UTF_8)).joinToString("") { byte -> "%02x".format(byte) } == assetName
            } ?: error("The image ID is not linked from the current note")
            require(replacementPath.length in 1..4096 && !replacementPath.startsWith("/") && !replacementPath.contains('\\')) {
                "Choose an image path inside the note folder or an app-authorized asset folder"
            }
            val target = media.local(resolvedAssetName, note.assetDirectory) ?: error("Image asset is not present in this portable note")
            val old = media.readerAsset(target)
            val (_, incoming) = resolveReaderAsset(note.id, replacementPath)
            require(incoming.mime == old.mime) { "Replacement must keep the current image type and extension" }
            require(incoming.size in 1..BoundedAssetInputStream.MAX_READER_ASSET_BYTES) { "Replacement image must be at most 25 MB" }
            val incomingBytes = incoming.open().use { readLimited(it, 25_000_000) }
            val backup = target.readBytes()
            require(backup.size <= 25_000_000) { "Current image exceeds 25 MB" }
            val temporaryAsset = File(target.parentFile, ".${target.name}.${UUID.randomUUID()}.tmp")
            val backupAsset = File(target.parentFile, ".${target.name}.${UUID.randomUUID()}.bak")
            val stagedNote = File(app.cacheDir, "agent-asset-${UUID.randomUUID()}.smd.gz")
            val noteUri = Uri.parse(note.uri)
            var replaced = false
            var diskAssets: String? = null
            try {
                // Refuse to overwrite a portable file whose saved bytes changed outside this app.
                val disk = resolver.openInputStream(noteUri)?.use(media::openFmd) ?: error("Cannot read the current portable note")
                diskAssets = disk.directory
                require(disk.markdown == note.saved) { "The portable note's Markdown changed on disk; reopen it before replacement" }
                val sources = JSONArray(markdownImageSourcesJson(note.content))
                (0 until sources.length()).map { sources.getString(it) }.distinct().filter(media::validKey).forEach { source ->
                    val currentFile = media.local(source, note.assetDirectory) ?: error("An open image is missing: $source")
                    val diskFile = media.local(source, disk.directory) ?: error("The saved note no longer contains image $source")
                    require(currentFile.readBytes().contentEquals(diskFile.readBytes())) { "The portable note's images changed on disk; reopen it before replacement" }
                }
                require((media.local(resolvedAssetName, disk.directory) ?: error("The saved note no longer contains this image")).readBytes().contentEquals(backup)) {
                    "The portable note's image changed on disk; reopen it before replacement"
                }
                val previousModified = target.lastModified()
                val stagedAssetStream = temporaryAsset.outputStream()
                stagedAssetStream.use { it.write(incomingBytes); it.fd.sync() }
                check(target.renameTo(backupAsset)) { "Could not safely stage the current image" }
                check(temporaryAsset.renameTo(target)) { backupAsset.renameTo(target); error("Could not stage the replacement image") }
                replaced = true
                media.invalidateLocalAsset(target)
                if (!backup.contentEquals(incomingBytes) && target.lastModified() == previousModified && previousModified > 0L) {
                    target.setLastModified(maxOf(System.currentTimeMillis(), previousModified + 1_000L))
                    media.invalidateLocalAsset(target)
                }
                stagedNote.outputStream().use { media.writeLocalPortable(it, note.content, note.assetDirectory) }
                verifyExportHeader(stagedNote, NativeExportFormat.PORTABLE_SMD)
                resolver.openOutputStream(noteUri, "wt")?.use { output -> stagedNote.inputStream().use { it.copyTo(output) } }
                    ?: error("Cannot save the updated portable note")
                withContext(Dispatchers.Main) {
                    invalidateNoteAssets(id)
                    recordPortableBaseline(id, note.assetDirectory)
                    change { state -> state.copy(tabs = state.tabs.map { if (it.id == id) it.copy(saved = it.content, assetsDirty = false) else it }, conflictedTabIds = state.conflictedTabIds - id, busy = false, message = "Portable image replaced") }
                    readState().tabs.find { it.id == id }?.let(remember)
                }
                backupAsset.delete()
                JSONObject().put("tabId", id).put("assetName", resolvedAssetName).put("assetId", assetName).put("revision", revision).put("changed", !backup.contentEquals(incomingBytes)).put("saved", true)
            } catch (error: Exception) {
                if (replaced) {
                    target.delete()
                    backupAsset.renameTo(target)
                    media.invalidateLocalAsset(target)
                }
                throw error
            } finally {
                temporaryAsset.delete(); backupAsset.delete(); stagedNote.delete()
                diskAssets?.let { File(app.filesDir, "portable-assets/$it").deleteRecursively() }
            }
        }
    }

    /** Read original embedded assets or add one model-supplied image to a saved portable note. */
    suspend fun agentAssetAction(request: JSONObject): JSONObject = withContext(Dispatchers.IO) {
        val id = request.getString("tabId")
        val action = request.getString("assetAction")
        documentWrites.withLock {
            require(action in setOf("list", "source", "attach")) { "Unsupported asset action" }
            val note = readState().tabs.find { it.id == id } ?: error("The document is no longer open")
            val revision = agentContentRevision(note.content)
            require(revision.equals(request.getString("expectedRevision"), ignoreCase = true)) { "The document changed; read it again before using an asset" }
            val directory = note.assetDirectory
            if (action == "list") {
                val page = media.portableAssetPage(directory, request.optInt("offset", 0), request.optInt("limit", 50))
                return@withLock JSONObject().put("tabId", id).put("revision", revision)
                    .put("assets", page.getJSONArray("assets")).put("total", page.getInt("total"))
                    .put("nextOffset", page.opt("nextOffset") ?: JSONObject.NULL)
            }
            if (action == "source") {
                val name = media.resolvePortableAssetName(directory, request.getString("assetName"))
                    ?: error("Asset is not present in the current note")
                val (mime, bytes) = media.portableAssetBytes(directory, name, 1_048_576)
                return@withLock JSONObject().put("tabId", id).put("revision", revision).put("assetName", name)
                    .put("mimeType", mime).put("bytes", bytes.size)
                    .put("sha256", MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) })
                    .put("body", Base64.encodeToString(bytes, Base64.NO_WRAP))
            }
            require(readState().activeId == id) { "Select the target tab before attaching its image" }
            require(note.portable && note.uri != null && note.saved == note.content) { "Attaching an image requires a saved, unchanged portable .smd note" }
            val rawName = request.getString("assetName")
            val filename = rawName.removePrefix("assets/")
            require(isValidPortableAssetFilename(filename)) { "Asset name must be a simple filename" }
            val mime = request.getString("mimeType").substringBefore(';').lowercase()
            require(mime in setOf("image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/svg+xml")) { "Unsupported image type" }
            val extension = filename.substringAfterLast('.', "").lowercase()
            val normalizedName = if (extension.isEmpty()) "$filename.${when (mime) { "image/png" -> "png"; "image/jpeg" -> "jpg"; "image/gif" -> "gif"; "image/webp" -> "webp"; "image/avif" -> "avif"; else -> "svg" }}" else filename
            require(isValidPortableAssetFilename(normalizedName)) { "Asset name must be a simple filename" }
            require(media.assetMime(normalizedName) == mime) { "Asset extension must match its image type" }
            val encoded = request.getString("body")
            require(encoded.length <= 1_400_000 && encoded.length % 4 == 0) { "Asset body must be at most 1 MiB" }
            val incomingBytes = Base64.decode(encoded, Base64.DEFAULT)
            require(incomingBytes.size in 1..1_048_576 && Base64.encodeToString(incomingBytes, Base64.NO_WRAP) == encoded) { "Asset body must be canonical base64 and at most 1 MiB" }
            fun currentNote(): Note? = readState().tabs.find { it.id == id }
            fun requireSameSnapshot(active: Boolean = true) {
                val latest = currentNote() ?: error("The document is no longer open")
                require(matchesAssetWriteSnapshot(latest, readState().activeId, note, requireActive = active) && latest.assetDirectory == directory) {
                    "The document changed while the image was being attached; no changes were saved"
                }
            }
            requireSameSnapshot()
            val currentAssets = media.portableAssets(directory)
            val newKey = "assets/$normalizedName"
            require(!currentAssets.has(newKey)) { "An asset with that name already exists" }
            val newData = media.portableImageData(mime, incomingBytes)
            val updated = JSONObject()
            currentAssets.keys().forEach { key -> updated.put(key, currentAssets.getString(key)) }
            updated.put(newKey, newData)
            val uri = Uri.parse(note.uri)
            var openedDir: String? = null
            try {
                stagedPortableRecoveryWriter.write(
                    target = uri,
                    markdown = note.content,
                    savedBaselineMarkdown = note.saved,
                    updatedAssets = updated,
                    baselineAssets = currentAssets,
                    diskChangedMessage = "The portable note changed on disk; reopen it before attaching an image",
                    writeFailureMessage = "Cannot save the updated portable note",
                    prepareBeforeWrite = {
                        openedDir = media.materializePortableDirectory(
                            updated,
                            reuseFromDirectory = directory,
                            predecodedBytes = mapOf(newKey to (mime to incomingBytes)),
                        )
                    },
                    recheckSnapshotBeforeWrite = ::requireSameSnapshot,
                    commitOnSuccess = {
                        requireSameSnapshot()
                        val writtenSource = note.content
                        val writtenDirectory = openedDir ?: error("The updated portable note was not staged")
                        val committed = withContext(Dispatchers.Main) {
                            val latest = readState().tabs.find { it.id == id }
                            val matches = latest != null && latest.content == writtenSource
                                && matchesAssetWriteSnapshot(latest, readState().activeId, note) && latest.assetDirectory == directory
                            if (!matches) return@withContext false
                            invalidateNoteAssets(id)
                            recordPortableBaseline(id, writtenDirectory)
                            change { state -> state.copy(tabs = state.tabs.map {
                                if (it.id == id && it.content == writtenSource && it.uri == note.uri && it.assetDirectory == directory)
                                    it.copy(saved = writtenSource, assetsDirty = false, assetDirectory = writtenDirectory) else it
                            }, conflictedTabIds = state.conflictedTabIds - id, busy = false, message = "Portable image attached") }
                            readState().tabs.find { it.id == id }?.let(remember)
                            true
                        }
                        if (!committed) {
                            error("The document changed while the image was being attached; the new draft was preserved")
                        }
                    },
                )
                JSONObject().put("tabId", id).put("assetName", newKey).put("mimeType", mime)
                    .put("bytes", incomingBytes.size)
                    .put("sha256", MessageDigest.getInstance("SHA-256").digest(incomingBytes).joinToString("") { "%02x".format(it) })
                    .put("revision", revision).put("saved", true).put("changed", true)
            } finally {
                openedDir?.takeIf { it != readState().tabs.find { tab -> tab.id == id }?.assetDirectory }
                    ?.let { File(app.filesDir, "portable-assets/$it").deleteRecursively() }
            }
        }
    }
}
