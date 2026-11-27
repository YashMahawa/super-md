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
    private val app: Application, private val scope: CoroutineScope,
    private val resolver: ContentResolver, private val media: MediaStorage,
    private val readDocumentAccess: () -> DocumentAccess, private val resolveVerifiedWriteDestination: (Uri) -> Uri,
    private val documentWrites: Mutex,
    private val confirmedTreeDocumentKeys: MutableSet<String>, private val openRequests: OpenRequestGate,
    private val readWorkspaceLinks: () -> WorkspaceLinkCache,
    private val readState: () -> StudioState, private val writeState: (StudioState) -> Unit,
    private val changeState: ((StudioState) -> StudioState) -> Unit, private val fail: (String) -> Unit,
    private val verifyExportHeader: (File, NativeExportFormat) -> Unit, private val listFolder: (Uri, String) -> Job,
    private val performReaderBarrier: suspend (String, () -> Unit) -> Boolean,
    private val retainOpenedNote: (Note, Boolean) -> String,
    private val relativeInOpenFolder: (Uri) -> String?, private val resolveOpenFolderRelativeOnIo: (Uri) -> String?,
    private val rememberNote: (Note) -> Unit,
    private val snapshotPreRenameFolderState: () -> Map<StudioViewModel, Pair<Long, String>>,
    private val trackedEntriesInOpenFolder: (Uri, Map<String, String>) -> Map<String, String>,
    private val applyUriRemaps: (List<UriRemap>, String?, String?, String?, String?, Map<StudioViewModel, Pair<Long, String>>) -> Unit,
) {
    fun rename(
        id: String, requested: String, showGlobalError: Boolean = true, onResult: (Boolean, String?) -> Unit = { _, _ -> },
    ): Job = scope.launch {
        val note = readState().tabs.find { it.id == id } ?: run {
            onResult(false, "Note is no longer open")
            return@launch
        }
        try {
            val hasSavedTarget = note.uri != null
            val existingExt = noteExtension(note.name)
            val extension = when {
                existingExt.isNotEmpty() -> existingExt
                hasSavedTarget -> ""
                note.portable -> "smd"
                else -> "md"
            }
            val name = validateFolderEntryName(requested, isDirectory = false, currentExtension = extension, hasSavedTarget = hasSavedTarget)
            if (name == note.name) {
                onResult(true, null)
                return@launch
            }
            val existingUri = note.uri
            if (existingUri == null) {
                changeState { s -> s.copy(tabs = s.tabs.map { if (it.id == id) it.copy(name = name) else it }) }
                onResult(true, null)
                return@launch
            }
            val parsedUri = Uri.parse(existingUri)
            val openFolderRel = note.relative
                ?: relativeInOpenFolder(parsedUri)
                ?: if (readState().folder != null) withContext(Dispatchers.IO) { resolveOpenFolderRelativeOnIo(parsedUri) } else null
            if (openFolderRel != null && readState().folder != null) {
                performRenameFolderEntry(parsedUri, openFolderRel, isDirectory = false, validatedName = name)
                onResult(true, null)
                return@launch
            }
            val renamedUri = withContext(Dispatchers.IO) {
                documentWrites.withLock {
                    val target = resolveVerifiedWriteDestination(parsedUri)
                    val rawRenamed = DocumentsContract.renameDocument(resolver, target, name)
                        ?: error("This provider does not support renaming. Use Save as instead.")
                    val hadConfirmedSource = listOfNotNull(
                        canonicalTreeDocumentKey(parsedUri),
                        canonicalTreeDocumentKey(target),
                    ).any(confirmedTreeDocumentKeys::remove)
                    val canScopeToTargetTree = DocumentsContract.isTreeUri(target) &&
                        !DocumentsContract.isTreeUri(rawRenamed) &&
                        (hadConfirmedSource || isKnownPathContainedInTree(
                            target.authority,
                            runCatching { DocumentsContract.getTreeDocumentId(target) }.getOrDefault(""),
                            runCatching { DocumentsContract.getDocumentId(rawRenamed) }.getOrDefault(""),
                        ))
                    val effectiveRenamed = if (canScopeToTargetTree) {
                        canonicalTreeScopedUri(target, rawRenamed)
                    } else {
                        rawRenamed
                    }
                    readDocumentAccess().persist(effectiveRenamed)
                    if (hadConfirmedSource) {
                        canonicalTreeDocumentKey(effectiveRenamed)?.let(confirmedTreeDocumentKeys::add)
                    }
                    effectiveRenamed.toString()
                }
            }
            val newRelative = renamedRelative(note.relative, name)
            applyUriRemaps(listOf(UriRemap(existingUri, renamedUri, name, note.relative, newRelative)), null, null, null, "Renamed to $name", emptyMap())
            readState().tabs.find { it.id == id }?.let(rememberNote)
            onResult(true, null)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            val msg = error.message ?: "Could not rename note"
            if (showGlobalError) fail("Could not rename note: $msg")
            onResult(false, msg)
        }
    }

    fun createFolderNote(
        parentRelative: String, rawName: String, portable: Boolean = false, onComplete: ((Note?) -> Unit)? = null,
    ) {
        val currentState = readState()
        val folderRaw = currentState.folder
        if (folderRaw.isNullOrBlank()) {
            fail("Open a folder first to create a folder note")
            onComplete?.invoke(null)
            return
        }
        openRequests.invalidate()
        val expectedActiveId = currentState.active.id
        scope.launch {
            var createdDirCleanup: String? = null
            try {
                val fileName = validateFolderEntryName(rawName = rawName, isDirectory = false, currentExtension = if (portable) "smd" else "md")
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
                                name = actualName, uri = createdUri.toString(), content = "", saved = "",
                                relative = childRelativePath(cleanParent, actualName), assetDirectory = assetDir,
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
                val accepted = performReaderBarrier(expectedActiveId) { retainOpenedNote(createdNote, true) }
                if (!accepted) retainOpenedNote(createdNote, false)
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
        parentRelative: String, rawName: String, onComplete: ((FileEntry?) -> Unit)? = null,
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
                            resolver, resolvedParent.parentDocumentUri, DocumentsContract.Document.MIME_TYPE_DIR, folderName,
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

    fun renameFolderEntry(
        entryUri: Uri, entryRelative: String, isDirectory: Boolean, requested: String,
        showGlobalError: Boolean = true, onResult: (Boolean, String?) -> Unit = { _, _ -> },
    ): Job = scope.launch {
        try {
            val cleanRelative = normalizeRelativePath(entryRelative)
            val currentName = cleanRelative.substringAfterLast('/')
            val currentExt = if (isDirectory) "" else noteExtension(currentName)
            val validatedName = validateFolderEntryName(
                rawName = requested, isDirectory = isDirectory, currentExtension = currentExt, hasSavedTarget = !isDirectory,
            )
            if (validatedName == currentName) {
                onResult(true, null)
                return@launch
            }
            performRenameFolderEntry(entryUri, cleanRelative, isDirectory, validatedName)
            onResult(true, null)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            val msg = error.message ?: "Could not rename"
            if (showGlobalError) fail("Could not rename: $msg")
            onResult(false, msg)
        }
    }

    suspend fun performRenameFolderEntry(
        entryUri: Uri, cleanRelative: String, isDirectory: Boolean, validatedName: String,
    ) {
        val folderRaw = readState().folder ?: error("No folder is open")
        val folderUri = Uri.parse(folderRaw)
        val parentRel = parentRelativePath(cleanRelative)
        val currentName = cleanRelative.substringAfterLast('/')
        val preRenameFolderState = snapshotPreRenameFolderState()

        val (actualNewName, actualNewRelative, remaps) = withContext(Dispatchers.IO) {
            documentWrites.withLock {
                val pass = SafProjectionPass(resolver)
                val resolvedParent = resolveSafParentDirectory(readDocumentAccess(), pass, folderUri, parentRel)
                confirmedTreeDocumentKeys.addAll(pass.confirmedTreeKeys)
                require(findDuplicateProjectedChild(resolvedParent.children, resolvedParent.treeUri, validatedName, ignoreUri = entryUri) == null) {
                    "'$validatedName' already exists in this folder"
                }

                val entryDocId = runCatching { DocumentsContract.getDocumentId(entryUri) }.getOrNull()
                val projectedTarget = resolvedParent.children.firstOrNull { child ->
                    !child.isVirtual && child.isDirectory == isDirectory &&
                        ((entryDocId != null && child.documentId == entryDocId) || child.displayName == currentName)
                }
                val confirmedEntryTreeUri = projectedTarget?.let {
                    DocumentsContract.buildDocumentUriUsingTree(resolvedParent.treeUri, it.documentId)
                }
                if (confirmedEntryTreeUri != null && !isDirectory) {
                    canonicalTreeDocumentKey(confirmedEntryTreeUri)?.let(confirmedTreeDocumentKeys::add)
                }

                val beforeSubtreeNodes = if (isDirectory && projectedTarget != null) {
                    collectSafSubtree(pass, resolvedParent.treeUri, projectedTarget.documentId, cleanRelative)
                } else emptyList()
                confirmedTreeDocumentKeys.addAll(pass.confirmedTreeKeys)
                val beforeRelativeByDocId = beforeSubtreeNodes.associate { it.documentId to it.relativePath }
                val trackedBefore = if (isDirectory) trackedEntriesInOpenFolder(resolvedParent.treeUri, beforeRelativeByDocId) else emptyMap()

                val targetForRename = confirmedEntryTreeUri ?: resolveVerifiedWriteDestination(entryUri)
                val rawRenamedUri = DocumentsContract.renameDocument(resolver, targetForRename, validatedName)
                    ?: error("This storage provider does not support renaming")
                val confirmedInOpenTree = confirmedEntryTreeUri != null ||
                    isKnownPathContainedInTree(
                        resolvedParent.treeUri.authority,
                        resolvedParent.rootDocumentId,
                        runCatching { DocumentsContract.getDocumentId(rawRenamedUri) }.getOrDefault(""),
                    )
                val renamedUri = if (confirmedInOpenTree) {
                    canonicalTreeScopedUri(resolvedParent.treeUri, rawRenamedUri)
                } else {
                    rawRenamedUri
                }
                readDocumentAccess().persist(renamedUri)
                val finalName = (querySingleDocumentMetadata(resolver, renamedUri) as? ProviderMetadata.Found)
                    ?.name?.takeIf { it.isNotBlank() } ?: validatedName
                val finalRelative = childRelativePath(parentRel, finalName)

                if (!isDirectory) {
                    confirmedEntryTreeUri?.let(::canonicalTreeDocumentKey)?.let(confirmedTreeDocumentKeys::remove)
                    canonicalTreeDocumentKey(entryUri)?.let(confirmedTreeDocumentKeys::remove)
                    if (confirmedInOpenTree) {
                        canonicalTreeDocumentKey(renamedUri)?.let(confirmedTreeDocumentKeys::add)
                    }
                    Triple(finalName, finalRelative, listOf(UriRemap(entryUri.toString(), renamedUri.toString(), finalName, cleanRelative, finalRelative)))
                } else {
                    beforeSubtreeNodes.filter { !it.isDirectory }.forEach { oldNode ->
                        canonicalTreeDocumentKey(oldNode.treeDocumentUri)?.let(confirmedTreeDocumentKeys::remove)
                    }
                    val afterPass = SafProjectionPass(resolver)
                    val renamedDirDocId = runCatching { DocumentsContract.getDocumentId(renamedUri) }.getOrNull()
                    val afterSubtreeNodes = if (renamedDirDocId != null) {
                        collectSafSubtree(afterPass, resolvedParent.treeUri, renamedDirDocId, finalRelative)
                    } else {
                        val refreshedParent = resolveSafParentDirectory(readDocumentAccess(), afterPass, resolvedParent.treeUri, parentRel)
                        val refreshedDir = refreshedParent.children.firstOrNull { it.isDirectory && !it.isVirtual && it.displayName == finalName }
                        if (refreshedDir != null) collectSafSubtree(afterPass, resolvedParent.treeUri, refreshedDir.documentId, finalRelative) else emptyList()
                    }
                    confirmedTreeDocumentKeys.addAll(afterPass.confirmedTreeKeys)
                    val afterByRelative = afterSubtreeNodes.associateBy { it.relativePath }

                    val childRemaps = trackedBefore.mapNotNull { (oldUri, oldRel) ->
                        if (!matchesRelativePrefix(oldRel, cleanRelative)) return@mapNotNull null
                        val updatedRel = remapRelativePrefix(oldRel, cleanRelative, finalRelative) ?: return@mapNotNull null
                        val afterNode = afterByRelative[updatedRel] ?: return@mapNotNull null
                        if (!afterNode.isDirectory) {
                            readDocumentAccess().persist(afterNode.treeDocumentUri)
                            canonicalTreeDocumentKey(afterNode.treeDocumentUri)?.let(confirmedTreeDocumentKeys::add)
                        }
                        UriRemap(oldUri, afterNode.treeDocumentUri.toString(), afterNode.displayName, oldRel, updatedRel)
                    }
                    Triple(finalName, finalRelative, childRemaps)
                }
            }
        }

        applyUriRemaps(
            remaps, if (isDirectory) cleanRelative else null, if (isDirectory) actualNewRelative else null,
            folderRaw, "Renamed to $actualNewName", preRenameFolderState,
        )
    }
}
