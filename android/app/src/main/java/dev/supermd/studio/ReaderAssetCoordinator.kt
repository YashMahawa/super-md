package dev.supermd.studio

import android.content.ContentResolver
import android.content.Context
import android.content.SharedPreferences
import android.net.Uri
import android.util.Base64
import java.io.File
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

internal class ReaderAssetCoordinator(
    private val context: Context,
    private val prefs: SharedPreferences,
    private val resolver: ContentResolver,
    private val documentAccess: () -> DocumentAccess,
    private val media: MediaStorage,
    private val readerFolderIndex: ReaderFolderIndex,
    private val readerCapabilities: MutableSet<ReaderAssetCapabilities>,
    private val readState: () -> StudioState,
    private val sameDocumentUri: (String, String) -> Boolean,
    private val noteForAsset: (String) -> Note,
    private val resolveLinkedAssetUri: (Note, String) -> Uri,
    private val openWorkspaceLink: suspend (documentPath: String, target: String, fragment: String, wikilink: Boolean) -> JSONObject,
) {
    private fun resolveAuthorizedAssetUri(rawUri: Uri): Uri {
        ExternalDocumentEntryGuard.validateUserAuthorizedDocumentUri(context, rawUri)
        return if (rawUri.scheme.equals("content", ignoreCase = true)) {
            val resolved = documentAccess().resolve(rawUri)
            ExternalDocumentEntryGuard.requireUserAuthorizedContentReadPermission(
                context = context,
                uri = resolved,
                documentAccess = documentAccess(),
                allowExportedNonSafPickerProvider = true,
            )
            resolved
        } else {
            rawUri
        }
    }

    private fun openAuthorizedAssetStream(uri: Uri) =
        ExternalDocumentEntryGuard.openVerifiedUserAuthorizedInputStream(
            context = context,
            resolver = resolver,
            uri = uri,
            documentAccess = documentAccess(),
            allowExportedNonSafPickerProvider = true,
        )

    fun attachReaderCapabilities(capabilities: ReaderAssetCapabilities) {
        readerCapabilities += capabilities
    }

    fun detachReaderCapabilities(capabilities: ReaderAssetCapabilities) {
        readerCapabilities -= capabilities
    }

    fun invalidateNoteAssets(noteId: String) {
        readerFolderIndex.clearNote(noteId)
        readerCapabilities.forEach { it.clearNote(noteId) }
    }

    fun invalidateAllNoteAssets() {
        readerFolderIndex.clear()
        readerCapabilities.forEach { it.clear() }
    }

    fun matchesReaderAssetNote(noteId: String, target: ReaderAssetTarget? = null): Boolean {
        val note = readState().tabs.firstOrNull { it.id == noteId } ?: return false
        if (target == null) return true
        return note.uri == target.noteUri && note.relative == target.noteRelative && note.assetDirectory == target.assetDirectory
    }

    fun linkedAssetUri(note: Note, source: String): Uri? = runCatching {
        val grants = JSONArray(prefs.getString("linkedAssetGrants", "[]"))
        (0 until minOf(grants.length(), 256)).asSequence().map { grants.getJSONObject(it) }
            .firstOrNull { record -> record.optString("source") == source && sameDocumentUri(record.optString("document"), note.uri ?: note.id) }
            ?.getString("uri")?.let(Uri::parse)
    }.getOrNull()

    fun rememberLinkedAsset(note: Note, source: String, uri: Uri) {
        val previous = runCatching { JSONArray(prefs.getString("linkedAssetGrants", "[]")) }.getOrDefault(JSONArray())
        val records = JSONArray().put(JSONObject().put("document", note.uri ?: note.id).put("source", source).put("uri", uri.toString()))
        for (i in 0 until minOf(previous.length(), 255)) {
            val record = previous.optJSONObject(i) ?: continue
            if (!(record.optString("source") == source && sameDocumentUri(record.optString("document"), note.uri ?: note.id))) records.put(record)
        }
        prefs.edit().putString("linkedAssetGrants", records.toString()).apply()
    }

    suspend fun openRelativeNote(documentPath: String, target: String, heading: String? = null): JSONObject =
        openWorkspaceLink(documentPath, target, heading.orEmpty(), false)

    suspend fun textAsset(document: String, source: String): JSONObject = withContext(Dispatchers.IO) {
        require(Uri.decode(source).substringBefore('?').substringBefore('#').substringAfterLast('.').lowercase() in setOf("mmd", "mermaid")) { "Choose a Mermaid source file" }
        val uri = resolveAuthorizedAssetUri(resolveLinkedAssetUri(noteForAsset(document), source))
        val bytes = ExternalDocumentEntryGuard.admitUserAuthorizedUri(
            context = context,
            resolver = resolver,
            uri = uri,
            documentAccess = documentAccess(),
            allowExportedNonSafPickerProvider = true,
            deniedMessage = "Cannot read diagram source",
        ).use { admitted ->
            if (admitted.uri.scheme.equals("content", ignoreCase = true)) {
                querySafAssetMetadata(resolver, admitted.uri)
            }
            admitted.openInputStream().use { readLimited(it, 2_000_000) }
        }
        val text = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes)).toString()
        JSONObject().put("text", text)
    }

    suspend fun asset(document: String, source: String): String = withContext(Dispatchers.IO) {
        val note = noteForAsset(document)
        media.localTarget(source, note.assetDirectory, note.uri, note.relative)?.let { return@withContext media.data(it.file) }
        val uri = resolveAuthorizedAssetUri(resolveLinkedAssetUri(note, source))
        val (meta, bytes) = ExternalDocumentEntryGuard.admitUserAuthorizedUri(
            context = context,
            resolver = resolver,
            uri = uri,
            documentAccess = documentAccess(),
            allowExportedNonSafPickerProvider = true,
            deniedMessage = "Cannot read image",
        ).use { admitted ->
            val metadata = if (admitted.uri.scheme.equals("content", ignoreCase = true)) {
                querySafAssetMetadata(resolver, admitted.uri)
            } else {
                SafAssetMetadata(admitted.uri.path?.let { File(it).name }, null, -1L, 0L)
            }
            if (metadata.size >= 0L) require(metadata.size <= BoundedAssetInputStream.MAX_READER_ASSET_BYTES) { "Image exceeds 25 MB" }
            metadata to admitted.openInputStream().use { readLimited(it, 25_000_000) }
        }
        val mime = media.imageMime(meta.displayName ?: Uri.decode(source).substringAfterLast('/'), meta.mimeType)
        "data:$mime;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
    }

    fun resolveReaderAsset(document: String, source: String): Pair<String, ReaderAssetSource> {
        val note = noteForAsset(document)
        media.localTarget(source, note.assetDirectory, note.uri, note.relative)?.let { return note.id to media.readerAsset(it) }
        val uri = resolveAuthorizedAssetUri(resolveLinkedAssetUri(note, source))
        val meta = if (uri.scheme.equals("content", ignoreCase = true)) {
            querySafAssetMetadata(resolver, uri)
        } else {
            ExternalDocumentEntryGuard.openSafeRegularFileHandle(context, uri).use { handle ->
                val rawFile = File(handle.rawPath)
                SafAssetMetadata(rawFile.name, null, -1L, 0L)
            }
        }
        if (meta.size >= 0L) require(meta.size <= BoundedAssetInputStream.MAX_READER_ASSET_BYTES) { "Image exceeds 25 MB" }
        val open = { openAuthorizedAssetStream(uri) }
        val mime = media.imageMime(meta.displayName ?: Uri.decode(source).substringAfterLast('/'), meta.mimeType)
        val identity = "${note.id}|$source|$uri"
        val fingerprint = readerAssetFingerprint(identity, meta.size, meta.lastModified, open)
        val target = ReaderAssetTarget.SafDocument(uri, identity, note.uri, note.relative, note.assetDirectory)
        return note.id to ReaderAssetSource(mime, fingerprint, meta.size, open, target)
    }

    /** Revalidates open-note ownership and target metadata without repeating folder path walks. */
    fun openReaderAsset(capability: ReaderAssetCapability): OpenReaderAsset {
        val target = capability.target
            ?: return openReaderAsset(capability.noteId, capability.source, capability.fingerprint)
        val note = readState().tabs.find { it.id == capability.noteId } ?: error("The image's document is no longer open")
        require(note.uri == target.noteUri && note.relative == target.noteRelative && note.assetDirectory == target.assetDirectory) {
            "The image's document moved; reload the document image"
        }
        return when (target) {
            is ReaderAssetTarget.LocalFile -> {
                val current = media.readerAsset(target)
                require(current.fingerprint == capability.fingerprint && current.mime == capability.mime) {
                    "The image changed; reload the document image"
                }
                require(current.size <= BoundedAssetInputStream.MAX_READER_ASSET_BYTES) { "Image exceeds 25 MB" }
                OpenReaderAsset(current.mime, current.fingerprint, current.open())
            }
            is ReaderAssetTarget.SafDocument -> {
                val verifiedUri = resolveAuthorizedAssetUri(target.uri)
                val meta = if (verifiedUri.scheme.equals("content", ignoreCase = true)) {
                    querySafAssetMetadata(resolver, verifiedUri) { IllegalStateException("Image not found") }
                } else {
                    ExternalDocumentEntryGuard.openSafeRegularFileHandle(context, verifiedUri).use { handle ->
                        SafAssetMetadata(File(handle.rawPath).name, null, -1L, 0L)
                    }
                }
                if (meta.size >= 0L) require(meta.size <= BoundedAssetInputStream.MAX_READER_ASSET_BYTES) { "Image exceeds 25 MB" }
                val mime = media.imageMime(meta.displayName ?: Uri.decode(capability.source).substringAfterLast('/'), meta.mimeType)
                val open = { openAuthorizedAssetStream(verifiedUri) }
                val currentFingerprint = readerAssetFingerprint(target.identity, meta.size, meta.lastModified, open)
                require(currentFingerprint == capability.fingerprint && mime == capability.mime) {
                    "The image changed; reload the document image"
                }
                OpenReaderAsset(mime, currentFingerprint, open())
            }
        }
    }

    /** Fallback when opening a capability created without a retained target. */
    fun openReaderAsset(noteId: String, source: String, expectedFingerprint: String): OpenReaderAsset {
        val note = readState().tabs.find { it.id == noteId } ?: error("The image's document is no longer open")
        val (_, current) = resolveReaderAsset(note.id, source)
        require(current.fingerprint == expectedFingerprint) { "The image changed; reload the document image" }
        if (current.size >= 0L) require(current.size <= BoundedAssetInputStream.MAX_READER_ASSET_BYTES) { "Image exceeds 25 MB" }
        return OpenReaderAsset(current.mime, current.fingerprint, current.open())
    }
}
