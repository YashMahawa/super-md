package dev.supermd.studio

import android.app.Application
import android.content.ContentResolver
import android.net.Uri
import android.provider.DocumentsContract
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.util.UUID

internal class SafFolderMutationCoordinator(
    private val app: Application,
    private val scope: CoroutineScope,
    private val resolver: ContentResolver,
    private val media: MediaStorage,
    private val readDocumentAccess: () -> DocumentAccess,
    private val documentWrites: Mutex,
    private val confirmedTreeDocumentKeys: MutableSet<String>,
    private val openRequests: OpenRequestGate,
    private val readWorkspaceLinks: () -> WorkspaceLinkCache,
    private val readState: () -> StudioState,
    private val writeState: (StudioState) -> Unit,
    private val fail: (String) -> Unit,
    private val verifyExportHeader: (File, NativeExportFormat) -> Unit,
    private val listFolder: (Uri, String) -> Job,
    private val performReaderBarrier: suspend (String, () -> Unit) -> Boolean,
    private val retainOpenedNote: (Note, Boolean) -> String,
) {
    fun createFolderNote(
        parentRelative: String,
        rawName: String,
        portable: Boolean = false,
        onComplete: ((Note?) -> Unit)? = null,
    ) {
        val folderRaw = readState().folder
        if (folderRaw.isNullOrBlank()) {
            fail("Open a folder first to create a folder note")
            onComplete?.invoke(null)
            return
        }
        openRequests.invalidate()
        val expectedActiveId = readState().active.id
        scope.launch {
            var createdDirCleanup: String? = null
            try {
                val fileName = validateFolderEntryName(
                    rawName = rawName,
                    isDirectory = false,
                    currentExtension = if (portable) "smd" else "md",
                )
                val cleanParent = normalizeRelativePath(parentRelative)
                val folderUri = Uri.parse(folderRaw)
                val createdNote = withContext(Dispatchers.IO) {
                    documentWrites.withLock {
                        val pass = SafProjectionPass(resolver)
                        val resolvedParent = resolveSafParentDirectory(readDocumentAccess(), pass, folderUri, cleanParent)
                        confirmedTreeDocumentKeys.addAll(pass.confirmedTreeKeys)
                        require(findDuplicateProjectedChild(resolvedParent.children, resolvedParent.treeUri, fileName) == null) {
                            "'$fileName' already exists in this folder"
                        }
                        val mime = if (portable) "application/vnd.supermd.smd" else "text/markdown"
                        val staged = if (portable) File(app.cacheDir, "create-smd-${UUID.randomUUID()}.smd") else null
                        try {
                            val assetDir = if (staged != null) {
                                staged.outputStream().use { media.writeFmd(it, "", JSONObject()) }
                                verifyExportHeader(staged, NativeExportFormat.PORTABLE_SMD)
                                staged.inputStream().use(media::openFmd).directory.also { createdDirCleanup = it }
                            } else null
                            val rawCreatedUri = DocumentsContract.createDocument(resolver, resolvedParent.parentDocumentUri, mime, fileName)
                                ?: error("The selected folder could not create '$fileName'")
                            val createdUri = canonicalTreeScopedUri(resolvedParent.treeUri, rawCreatedUri)
                            try {
                                resolver.openOutputStream(createdUri, "wt")?.use { out ->
                                    staged?.inputStream()?.use { it.copyTo(out) }
                                    out.flush()
                                } ?: error("Could not write to '$fileName'")
                            } catch (writeError: Exception) {
                                runCatching { DocumentsContract.deleteDocument(resolver, createdUri) }
                                throw writeError
                            }
                            readDocumentAccess().persist(createdUri)
                            canonicalTreeDocumentKey(createdUri)?.let(confirmedTreeDocumentKeys::add)
                            val actualName = (querySingleDocumentMetadata(resolver, createdUri) as? ProviderMetadata.Found)
                                ?.name?.takeIf { it.isNotBlank() } ?: fileName
                            Note(
                                name = actualName,
                                uri = createdUri.toString(),
                                content = "",
                                saved = "",
                                relative = childRelativePath(cleanParent, actualName),
                                assetDirectory = assetDir,
                            )
                        } finally {
                            staged?.delete()
                        }
                    }
                }
                createdDirCleanup = null
                readWorkspaceLinks().invalidate()
                // Expand and display the parent folder before activating the tab so state.files and folderRelative are already in sync.
                listFolder(folderUri, cleanParent).join()
                val accepted = performReaderBarrier(expectedActiveId) {
                    retainOpenedNote(createdNote, true)
                }
                if (!accepted) {
                    retainOpenedNote(createdNote, false)
                }
                writeState(readState().copy(message = "Created ${createdNote.name}"))
                onComplete?.invoke(createdNote)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                createdDirCleanup?.let { File(app.filesDir, "portable-assets/$it").deleteRecursively() }
                fail("Could not create note: ${error.message}")
                onComplete?.invoke(null)
            }
        }
    }

    fun createSubfolder(
        parentRelative: String,
        rawName: String,
        onComplete: ((FileEntry?) -> Unit)? = null,
    ) {
        val folderRaw = readState().folder
        if (folderRaw.isNullOrBlank()) {
            fail("Open a folder first to create a subfolder")
            onComplete?.invoke(null)
            return
        }
        scope.launch {
            try {
                val folderName = validateFolderEntryName(rawName, isDirectory = true)
                val cleanParent = normalizeRelativePath(parentRelative)
                val folderUri = Uri.parse(folderRaw)
                val entry = withContext(Dispatchers.IO) {
                    documentWrites.withLock {
                        val pass = SafProjectionPass(resolver)
                        val resolvedParent = resolveSafParentDirectory(readDocumentAccess(), pass, folderUri, cleanParent)
                        confirmedTreeDocumentKeys.addAll(pass.confirmedTreeKeys)
                        require(findDuplicateProjectedChild(resolvedParent.children, resolvedParent.treeUri, folderName) == null) {
                            "'$folderName' already exists in this folder"
                        }
                        val rawCreatedUri = DocumentsContract.createDocument(
                            resolver,
                            resolvedParent.parentDocumentUri,
                            DocumentsContract.Document.MIME_TYPE_DIR,
                            folderName,
                        ) ?: error("The selected folder could not create '$folderName'")
                        val createdUri = canonicalTreeScopedUri(resolvedParent.treeUri, rawCreatedUri)
                        val actualName = (querySingleDocumentMetadata(resolver, createdUri) as? ProviderMetadata.Found)
                            ?.name?.takeIf { it.isNotBlank() } ?: folderName
                        FileEntry(actualName, createdUri.toString(), true, childRelativePath(cleanParent, actualName))
                    }
                }
                readWorkspaceLinks().invalidate()
                listFolder(folderUri, cleanParent).join()
                writeState(readState().copy(message = "Created folder ${entry.name}"))
                onComplete?.invoke(entry)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                fail("Could not create subfolder: ${error.message}")
                onComplete?.invoke(null)
            }
        }
    }
}
