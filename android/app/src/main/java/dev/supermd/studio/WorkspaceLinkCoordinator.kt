package dev.supermd.studio

import android.content.ContentResolver
import android.net.Uri
import android.provider.DocumentsContract
import java.io.FileNotFoundException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

internal data class SafTreeMatch(val folderUri: Uri, val rootId: String, val relativePath: String)

private class PromptWorkspaceNoteAccessException(val targetUri: Uri) : Exception()

internal class WorkspaceLinkCoordinator(
    private val resolver: ContentResolver,
    private val readerFolderIndex: ReaderFolderIndex,
    private val confirmedTreeDocumentKeys: MutableSet<String>,
    private val pendingAccessHeadings: MutableMap<String, String>,
    private val readDocumentAccess: () -> DocumentAccess,
    private val readWorkspaceLinks: () -> WorkspaceLinkCache,
    private val readState: () -> StudioState,
    private val writeState: (StudioState) -> Unit,
    private val sameDocumentUri: (String, String) -> Boolean,
    private val openNoteForDocument: (String) -> Note?,
    private val linkedAssetUri: (Note, String) -> Uri?,
    private val relativeInOpenFolder: (Uri, String?) -> String?,
    private val isDocumentAccessFailure: (Throwable) -> Boolean,
    private val requestDocumentAccess: (rawUri: String, existingNote: Note?, writing: Boolean, explicit: Boolean) -> String,
    private val openNoteInternal: suspend (
        uri: Uri,
        relative: String?,
        headingFragment: String?,
        scheduleDirtyAutosave: Boolean,
        alwaysReportError: Boolean,
        errorPrefix: String,
    ) -> JSONObject,
) {
    fun findSafTree(noteUri: Uri, allowEmbeddedTreeFallback: Boolean = false): SafTreeMatch? {
        val documentId = runCatching { DocumentsContract.getDocumentId(noteUri) }.getOrDefault("")
        val knownPathProvider = isKnownPathDocumentProvider(noteUri.authority)
        val embeddedTreeRoot = if (DocumentsContract.isTreeUri(noteUri)) {
            runCatching { DocumentsContract.getTreeDocumentId(noteUri) }.getOrNull()
        } else {
            null
        }
        val persisted = (
            resolver.persistedUriPermissions.map { StoredUriGrant(it.uri, it.isReadPermission, it.isWritePermission) } +
                TestAuthorityGrants.persistedSnapshot()
            )
            .filter { it.isReadPermission && DocumentsContract.isTreeUri(it.uri) && it.uri.authority == noteUri.authority }
            .mapNotNull { permission ->
                val root = runCatching { DocumentsContract.getTreeDocumentId(permission.uri) }.getOrNull() ?: return@mapNotNull null
                val contained = (knownPathProvider && isKnownPathContainedInTree(noteUri.authority, root, documentId)) ||
                    (allowEmbeddedTreeFallback && embeddedTreeRoot == root && (!knownPathProvider || isKnownPathContainedInTree(noteUri.authority, root, documentId))) ||
                    relativeInOpenFolder(noteUri, permission.uri.toString()) != null
                if (contained && readDocumentAccess().resolveReadableTreeRoot(permission.uri) != null) root to permission.uri else null
            }
            .maxByOrNull { it.first.length }
        val active = persisted ?: if (allowEmbeddedTreeFallback && embeddedTreeRoot != null) {
            runCatching {
                val builtTree = DocumentsContract.buildTreeDocumentUri(noteUri.authority, embeddedTreeRoot)
                val validContainment = !knownPathProvider || isKnownPathContainedInTree(noteUri.authority, embeddedTreeRoot, documentId)
                if (validContainment && readDocumentAccess().resolveReadableTreeRoot(builtTree) != null) embeddedTreeRoot to builtTree else null
            }.getOrNull()
        } else null
        val (rootId, folderUri) = active ?: return null
        val trimmed = rootId.trimEnd('/')
        val canExtractSyntactically = knownPathProvider || embeddedTreeRoot == rootId
        val relative = documentId.takeIf { canExtractSyntactically && it.startsWith("$trimmed/") }?.removePrefix("$trimmed/")
            ?: documentId.takeIf { canExtractSyntactically && rootId.endsWith(':') && it.startsWith(rootId) }?.removePrefix(rootId)?.trimStart('/')
            ?: relativeInOpenFolder(noteUri, folderUri.toString())
            ?: if (allowEmbeddedTreeFallback && embeddedTreeRoot == rootId) "" else return null
        return SafTreeMatch(folderUri, rootId, relative)
    }

    /** Resolves only an already granted tree or an individually user-selected linked file. */
    fun resolveLinkedAssetUri(note: Note, source: String): Uri {
        validateRelativeAssetSource(source)
        note.relative?.let { readerAssetPathParts(it.substringBeforeLast('/', ""), source) }
        linkedAssetUri(note, source)?.let { return it }
        val noteUri = note.uri?.let(Uri::parse) ?: throw LinkedAssetAccessRequiredException()
        val tree = findSafTree(noteUri) ?: throw LinkedAssetAccessRequiredException()
        val parts = readerAssetPathParts(tree.relativePath.substringBeforeLast('/', ""), source)
        return readerFolderIndex.resolve(resolver, note.id, tree.folderUri, tree.rootId, parts).uri
    }

    suspend fun openWorkspaceLink(
        documentPath: String,
        target: String,
        fragment: String,
        wikilink: Boolean,
        allowFolderPrompt: Boolean = true,
    ): JSONObject {
        val trimmedTarget = target.trim()
        val trimmedFragment = fragment.trim()
        require(trimmedTarget.length in 1..4096 && trimmedFragment.length <= 1024) { "Invalid workspace link" }
        val stateSnapshot = readState()
        val sourceNote = if (documentPath.isNotBlank()) {
            openNoteForDocument(documentPath) ?: run {
                val notice = "The note for this link is no longer open."
                writeState(readState().copy(busy = false, message = notice))
                return JSONObject().put("opened", false).put("message", notice)
            }
        } else {
            stateSnapshot.active
        }
        val explicitRelative = isExplicitRelativeWorkspaceTarget(trimmedTarget, wikilink)
        val openFolder = stateSnapshot.folder?.let(Uri::parse)?.let {
            readDocumentAccess().resolveReadableTreeRoot(it)?.first
        }
        val rawNoteUri = sourceNote.uri
        if (rawNoteUri.isNullOrBlank()) {
            if (explicitRelative || openFolder == null) {
                val notice = "Save this note before opening linked notes."
                writeState(readState().copy(busy = false, message = notice))
                return JSONObject().put("opened", false).put("message", notice)
            }
        }

        val sourceUri = rawNoteUri?.takeIf { it.isNotBlank() }?.let(Uri::parse)
        val resolved = try {
            withContext(Dispatchers.IO) {
                val cleaned = sanitizeWorkspaceLinkTarget(trimmedTarget)
                if (sourceUri != null && sourceUri.scheme == "file") {
                    return@withContext resolveLocalFileWorkspaceLink(sourceUri, cleaned, wikilink)!!
                }
                fun firstReadableRankedCandidate(candidates: List<WorkspaceResolvedNote>): WorkspaceResolvedNote? {
                    val access = readDocumentAccess()
                    for (candidate in candidates) {
                        canonicalTreeDocumentKey(candidate.uri)?.let(confirmedTreeDocumentKeys::add)
                        val targetUri = access.resolve(candidate.uri)
                        if (access.hasReadGrant(targetUri) &&
                            runCatching { resolver.openInputStream(targetUri)?.use { true } == true }.getOrDefault(false)
                        ) {
                            return candidate.copy(uri = targetUri)
                        }
                    }
                    return null
                }
                val treeMatch = when {
                    sourceUri != null -> findSafTree(sourceUri, allowEmbeddedTreeFallback = true)
                        ?: run {
                            val candidateTrees = readDocumentAccess()
                                .readableCandidateTrees(sourceUri.authority, openFolder)
                                .map { it.first }
                            candidateTrees.firstNotNullOfOrNull { folderUri ->
                                val rel = runCatching {
                                    readWorkspaceLinks().noteRelativeInTree(folderUri, sourceUri, knownRelative = sourceNote.relative)
                                }.getOrNull()
                                if (rel != null) SafTreeMatch(folderUri, DocumentsContract.getTreeDocumentId(folderUri), rel) else null
                            }
                        }
                    openFolder != null -> SafTreeMatch(openFolder, DocumentsContract.getTreeDocumentId(openFolder), "")
                    else -> null
                }
                if (treeMatch != null) {
                    if (!explicitRelative) {
                        val noteRel = if (sourceUri == null) null else treeMatch.relativePath
                        val ranked = runCatching {
                            readWorkspaceLinks().resolveCandidates(treeMatch.folderUri, noteRelative = noteRel, rawTarget = cleaned, wikilink = true)
                        }.getOrDefault(emptyList())
                        firstReadableRankedCandidate(ranked)?.let { return@withContext it }
                    }
                    val parentRelative = treeMatch.relativePath.substringBeforeLast('/', "")
                    val candidateLists = expandWorkspaceCandidatePaths(parentRelative, cleaned, wikilink)
                    var deniedTreeCandidate: Uri? = null
                    for (parts in candidateLists) {
                        val relJoined = parts.joinToString("/")
                        val indexedUri = try {
                            readerFolderIndex.resolve(resolver, sourceNote.id, treeMatch.folderUri, treeMatch.rootId, parts).uri
                        } catch (_: LinkedAssetAccessRequiredException) {
                            null
                        } catch (_: SecurityException) {
                            null
                        } catch (_: UnsupportedOperationException) {
                            null
                        } catch (_: FileNotFoundException) {
                            null
                        }
                        if (indexedUri != null) {
                            canonicalTreeDocumentKey(indexedUri)?.let(confirmedTreeDocumentKeys::add)
                            val targetUri = readDocumentAccess().resolve(indexedUri)
                            return@withContext WorkspaceResolvedNote(targetUri, parts.last(), relJoined)
                        }
                        val candidateDocId = if (treeMatch.rootId.endsWith(':')) {
                            "${treeMatch.rootId}$relJoined"
                        } else {
                            "${treeMatch.rootId.trimEnd('/')}/$relJoined"
                        }
                        val access = readDocumentAccess()
                        val candidateUri = access.resolve(
                            DocumentsContract.buildDocumentUriUsingTree(treeMatch.folderUri, candidateDocId),
                        )
                        if (!access.hasReadGrant(candidateUri)) {
                            if (deniedTreeCandidate == null) deniedTreeCandidate = candidateUri
                            continue
                        }
                        val readable = try {
                            resolver.openInputStream(candidateUri)?.use { true } == true
                        } catch (_: FileNotFoundException) {
                            false
                        } catch (error: Exception) {
                            if (isDocumentAccessFailure(error) && deniedTreeCandidate == null) {
                                deniedTreeCandidate = candidateUri
                            }
                            false
                        }
                        if (readable) {
                            return@withContext WorkspaceResolvedNote(candidateUri, parts.last(), relJoined)
                        }
                    }
                    if (explicitRelative && sourceUri != null) {
                        val rankedRel = runCatching {
                            readWorkspaceLinks().resolveCandidates(treeMatch.folderUri, noteRelative = treeMatch.relativePath, rawTarget = cleaned, wikilink = false)
                        }.getOrDefault(emptyList())
                        firstReadableRankedCandidate(rankedRel)?.let { return@withContext it }
                    }
                    if (deniedTreeCandidate != null) {
                        throw PromptWorkspaceNoteAccessException(deniedTreeCandidate)
                    }
                    throw WorkspaceLinkException("Linked note not found: ${Uri.decode(cleaned)}")
                }
                if (!explicitRelative && openFolder != null) {
                    val ranked = runCatching {
                        readWorkspaceLinks().resolveCandidates(openFolder, noteRelative = null, rawTarget = cleaned, wikilink = true)
                    }.getOrDefault(emptyList())
                    firstReadableRankedCandidate(ranked)?.let { return@withContext it }
                }

                val nonNullSourceUri = sourceUri ?: throw WorkspaceLinkException("Save this note before opening linked notes.")
                val candidateLists = expandWorkspaceCandidatePaths("", cleaned, wikilink)
                val documentId = runCatching { DocumentsContract.getDocumentId(nonNullSourceUri) }.getOrDefault("")
                val sep = maxOf(documentId.lastIndexOf('/'), documentId.lastIndexOf(':'))

                linkedAssetUri(sourceNote, cleaned)?.let { grantedUri ->
                    val access = readDocumentAccess()
                    val resolvedGranted = access.resolve(grantedUri)
                    val grantedReadable = access.hasReadGrant(resolvedGranted) &&
                        runCatching { resolver.openInputStream(resolvedGranted)?.use { true } == true }.getOrDefault(false)
                    if (grantedReadable) {
                        val firstParts = candidateLists.first()
                        return@withContext WorkspaceResolvedNote(resolvedGranted, firstParts.last(), firstParts.joinToString("/"))
                    }
                }

                var deniedCandidate: Uri? = null
                for (parts in candidateLists) {
                    val relJoined = parts.joinToString("/")
                    val siblingDocId = if (sep >= 0) documentId.substring(0, sep + 1) + relJoined else relJoined
                    val rawCandidate = if (documentId.isNotEmpty() && nonNullSourceUri.authority != null) {
                        DocumentsContract.buildDocumentUri(nonNullSourceUri.authority, siblingDocId)
                    } else {
                        nonNullSourceUri.buildUpon().path((nonNullSourceUri.path?.substringBeforeLast('/', "") ?: "") + "/" + relJoined).build()
                    }
                    val openMatch = readState().tabs.firstOrNull { tab ->
                        tab.uri?.let { existingUri -> sameDocumentUri(existingUri, rawCandidate.toString()) } == true
                    }?.uri?.let(Uri::parse)
                    val access = readDocumentAccess()
                    val candidateUri = access.resolve(openMatch ?: rawCandidate)
                    if (!access.hasReadGrant(candidateUri)) {
                        if (deniedCandidate == null) deniedCandidate = candidateUri
                        continue
                    }
                    val readable = try {
                        resolver.openInputStream(candidateUri)?.use { true } == true
                    } catch (_: FileNotFoundException) {
                        false
                    } catch (error: Exception) {
                        if (isDocumentAccessFailure(error) && deniedCandidate == null) {
                            deniedCandidate = candidateUri
                        }
                        false
                    }
                    if (readable) {
                        return@withContext WorkspaceResolvedNote(candidateUri, parts.last(), relJoined)
                    }
                }
                if (!explicitRelative) {
                    return@withContext null
                }
                if (deniedCandidate != null) {
                    throw PromptWorkspaceNoteAccessException(deniedCandidate)
                }
                throw WorkspaceLinkException("Linked note not found: ${Uri.decode(cleaned)}")
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (prompt: PromptWorkspaceNoteAccessException) {
            val targetStr = prompt.targetUri.toString()
            if (trimmedFragment.isNotEmpty()) pendingAccessHeadings[targetStr] = trimmedFragment
            val notice = requestDocumentAccess(targetStr, openNoteForDocument(targetStr), false, true)
            return JSONObject().put("opened", false).put("message", notice)
        } catch (security: SecurityException) {
            val msg = security.message ?: DOCUMENT_ACCESS_MESSAGE
            writeState(readState().copy(busy = false, message = msg))
            return JSONObject().put("opened", false).put("message", msg)
        } catch (error: WorkspaceLinkException) {
            val msg = error.message ?: "Invalid relative note path."
            writeState(readState().copy(busy = false, message = msg))
            return JSONObject().put("opened", false).put("message", msg)
        }

        if (resolved == null) {
            val notice = if (allowFolderPrompt) {
                "Folder permission is needed to follow links from ${sourceNote.name}. Choose its containing folder."
            } else {
                "Choose the folder containing ${sourceNote.name} to follow relative links."
            }
            val prompt = if (allowFolderPrompt && sourceUri != null) {
                WorkspaceFolderPrompt(
                    noteId = sourceNote.id,
                    noteName = sourceNote.name,
                    initialUri = sourceUri,
                    target = trimmedTarget,
                    fragment = trimmedFragment,
                    wikilink = wikilink,
                )
            } else null
            writeState(readState().copy(folderAccessPrompt = prompt, message = notice))
            return JSONObject().put("opened", false).put("promptedFolderAccess", prompt != null).put("message", notice)
        }

        return openNoteInternal(
            resolved.uri,
            resolved.relative,
            trimmedFragment,
            true,
            true,
            "Could not open linked note",
        )
    }
}
