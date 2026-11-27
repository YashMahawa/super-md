package dev.supermd.studio

import android.content.ContentResolver
import android.content.SharedPreferences
import android.net.Uri
import android.provider.DocumentsContract
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

internal class SafWorkspaceCoordinator(
    private val owner: StudioViewModel, private val scope: CoroutineScope,
    private val prefs: SharedPreferences, private val windowPrefs: SharedPreferences,
    private val resolver: ContentResolver, private val readDocumentAccess: () -> DocumentAccess,
    private val confirmedTreeDocumentKeys: MutableSet<String>,
    private val readState: () -> StudioState, private val writeState: (StudioState) -> Unit,
    private val changeState: ((StudioState) -> StudioState) -> Unit,
    private val readListedRelative: () -> String, private val writeListedRelative: (String) -> Unit,
    private val readListFolderSeq: () -> Long, private val writeListFolderSeq: (Long) -> Unit,
    private val readListFolderJob: () -> Job?, private val writeListFolderJob: (Job?) -> Unit,
    private val readRecent: () -> List<RecentNote>, private val storeRecent: (List<RecentNote>) -> Unit,
    private val applyWorkspaceFolder: suspend (Uri) -> Unit,
    private val fail: (String) -> Unit, private val sameDocumentUri: (String, String) -> Boolean,
    private val liveViewModels: () -> List<StudioViewModel>,
    private val readVmState: (StudioViewModel) -> StudioState,
    private val changeVmState: (StudioViewModel, (StudioState) -> StudioState) -> Unit,
    private val readVmListFolderSeq: (StudioViewModel) -> Long,
    private val readVmListedRelative: (StudioViewModel) -> String,
    private val readVmSeededFind: (StudioViewModel) -> PendingSeededFind?,
    private val writeVmSeededFind: (StudioViewModel, PendingSeededFind?) -> Unit,
    private val refreshVmFolderSearchIfActive: (StudioViewModel) -> Unit,
) {
    fun setFolder(uri: Uri): Job = scope.launch {
        try { applyWorkspaceFolder(uri) } catch (error: Exception) { fail("Could not open folder: ${error.message}") }
    }

    fun closeFolder() {
        owner.workspaceLinks.invalidate()
        writeListFolderSeq(readListFolderSeq() + 1)
        readListFolderJob()?.cancel()
        writeListedRelative("")
        windowPrefs.edit().putBoolean("folderMigrated", true).remove("folder").remove("folderRelative").apply()
        changeState { it.copy(folder = null, folderRelative = "", files = emptyList()) }
    }

    fun navigateFolderUp(): Boolean {
        val folderUri = readState().folder ?: return false
        val current = normalizeFolderRelative(readListedRelative())
        if (current.isEmpty()) return false
        val parent = parentFolderRelative(current)
        listFolder(Uri.parse(folderUri), parent)
        return true
    }

    fun listFolder(uri: Uri, relative: String): Job {
        val seq = readListFolderSeq() + 1
        writeListFolderSeq(seq)
        val invalidPath = hasInvalidSafFolderRelative(relative)
        val requestedRelative = if (invalidPath) readListedRelative() else normalizeFolderRelative(relative)
        if (!invalidPath) {
            writeListedRelative(requestedRelative)
            val updated = readState().copy(folderRelative = requestedRelative)
            writeState(updated)
            if (updated.folder != null) {
                windowPrefs.edit().putBoolean("folderMigrated", true).putString("folderRelative", requestedRelative).apply()
            }
        }
        readListFolderJob()?.cancel()
        return scope.launch {
            try {
                require(!invalidPath) { "Invalid folder path" }
                val targetFolder = Uri.parse(readState().folder ?: uri.toString())
                val pass = SafProjectionPass(resolver)
                val listing = withContext(Dispatchers.IO) {
                    listSafFolderListing(resolver, readDocumentAccess(), targetFolder, requestedRelative, pass)
                }
                confirmedTreeDocumentKeys.addAll(pass.confirmedTreeKeys)
                if (seq == readListFolderSeq() && readState().folder != null) {
                    writeListedRelative(listing.effectiveRelative)
                    if (listing.effectiveRelative != requestedRelative) {
                        windowPrefs.edit().putBoolean("folderMigrated", true).putString("folderRelative", listing.effectiveRelative).apply()
                    }
                    writeState(readState().copy(folderRelative = listing.effectiveRelative, files = listing.entries))
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                if (seq == readListFolderSeq()) fail("Could not list folder: ${error.message}")
            }
        }.also(writeListFolderJob)
    }

    fun relativeInOpenFolder(uri: Uri, folderTreeRaw: String? = readState().folder): String? {
        val treeRaw = folderTreeRaw?.takeIf { it.isNotBlank() } ?: return null
        val treeUri = runCatching { Uri.parse(treeRaw) }.getOrNull() ?: return null
        if (uri.scheme != "content" || treeUri.scheme != "content" || uri.authority != treeUri.authority) return null
        if (!DocumentsContract.isTreeUri(treeUri)) return null

        if (isKnownPathDocumentProvider(treeUri.authority)) {
            return knownPathRelativeInTree(uri, treeUri)
        }

        // For non-ExternalStorage SAF providers, COLUMN_DOCUMENT_ID is opaque.
        // Only reuse provider-confirmed relative paths from the open folder state, open tabs, or recents.
        for (vm in liveViewModels()) {
            val vmState = readVmState(vm)
            val vmFolder = vmState.folder
            if (vmFolder != null && sameDocumentUri(vmFolder, treeRaw)) {
                vmState.files.firstOrNull { sameDocument(Uri.parse(it.uri), uri) }?.let { entry ->
                    return normalizeRelativePath(entry.relative).takeIf { it.isNotEmpty() }
                }
                vmState.tabs.firstOrNull {
                    it.uri != null && !it.relative.isNullOrBlank() && sameDocument(Uri.parse(it.uri), uri)
                }?.relative?.let { rel ->
                    return normalizeRelativePath(rel).takeIf { it.isNotEmpty() }
                }
            }
        }
        readRecent().firstOrNull {
            !it.relative.isNullOrBlank() && sameDocument(Uri.parse(it.uri), uri)
        }?.relative?.let { rel ->
            return normalizeRelativePath(rel).takeIf { it.isNotEmpty() }
        }
        return null
    }

    fun resolveOpenFolderRelativeOnIo(uri: Uri, folderTreeRaw: String? = readState().folder): String? {
        relativeInOpenFolder(uri, folderTreeRaw)?.let { return it }
        val treeRaw = folderTreeRaw?.takeIf { it.isNotBlank() } ?: return null
        val folderUri = runCatching { Uri.parse(treeRaw) }.getOrNull() ?: return null
        val pass = SafProjectionPass(resolver)
        val found = findRelativeInSafTree(
            pass = pass,
            documentAccess = readDocumentAccess(),
            folderUri = folderUri,
            targetUri = uri,
            preferredDirRelative = readListedRelative(),
        )
        if (pass.confirmedTreeKeys.isNotEmpty()) {
            confirmedTreeDocumentKeys.addAll(pass.confirmedTreeKeys)
        }
        return found
    }

    fun trackedEntriesInOpenFolder(
        folderTreeUri: Uri,
        projectedRelativeByDocId: Map<String, String> = emptyMap(),
    ): Map<String, String> {
        val result = linkedMapOf<String, String>()
        val folderAuthority = folderTreeUri.authority
        fun record(rawUri: String?, fallbackRelative: String? = null) {
            if (rawUri.isNullOrBlank()) return
            val parsed = runCatching { Uri.parse(rawUri) }.getOrNull() ?: return
            val docId = if (parsed.scheme == "content" && parsed.authority == folderAuthority) {
                runCatching { DocumentsContract.getDocumentId(parsed) }.getOrNull()
            } else null
            val rel = (if (docId != null) projectedRelativeByDocId[docId] else null)
                ?: relativeInOpenFolder(parsed, folderTreeUri.toString())
                ?: fallbackRelative?.let(::normalizeRelativePath)?.takeIf { it.isNotEmpty() }
                ?: return
            result.putIfAbsent(rawUri, rel)
        }
        liveViewModels().forEach { vm ->
            readVmState(vm).tabs.forEach { tab -> record(tab.uri, tab.relative) }
            readVmSeededFind(vm)?.targetUri?.let { seedUri -> record(seedUri, null) }
        }
        readRecent().forEach { recent -> record(recent.uri, recent.relative) }
        runCatching {
            val positions = JSONObject(prefs.getString("readingPositions", "{}") ?: "{}")
            positions.keys().forEach { uriKey -> record(uriKey, null) }
        }
        runCatching {
            val grants = JSONArray(prefs.getString("linkedAssetGrants", "[]") ?: "[]")
            for (i in 0 until grants.length()) {
                record(grants.optJSONObject(i)?.optString("document"), null)
            }
        }
        return result
    }

    fun updatePersistedMetadata(transformUri: (String) -> String?) {
        val editor = prefs.edit()
        var changed = false
        val oldPositions = runCatching { JSONObject(prefs.getString("readingPositions", "{}") ?: "{}") }.getOrDefault(JSONObject())
        if (oldPositions.length() > 0) {
            val nextPositions = JSONObject()
            var updated = false
            for (key in oldPositions.keys()) {
                val value = oldPositions.optJSONObject(key) ?: continue
                val mapped = transformUri(key)
                if (mapped == null) updated = true
                else {
                    if (mapped != key) updated = true
                    if (!nextPositions.has(mapped)) nextPositions.put(mapped, value)
                }
            }
            if (updated) { editor.putString("readingPositions", nextPositions.toString()); changed = true }
        }
        val oldGrants = runCatching { JSONArray(prefs.getString("linkedAssetGrants", "[]") ?: "[]") }.getOrDefault(JSONArray())
        if (oldGrants.length() > 0) {
            val nextGrants = JSONArray()
            var updated = false
            for (i in 0 until oldGrants.length()) {
                val record = oldGrants.optJSONObject(i) ?: continue
                val doc = record.optString("document")
                val mapped = if (doc.isNotBlank()) transformUri(doc) else doc
                if (mapped == null) updated = true
                else {
                    if (mapped != doc) updated = true
                    nextGrants.put(if (mapped != doc) JSONObject(record.toString()).put("document", mapped) else record)
                }
            }
            if (updated) { editor.putString("linkedAssetGrants", nextGrants.toString()); changed = true }
        }
        if (changed) editor.apply()
    }

    fun remapPersistedMetadata(remaps: List<UriRemap>) {
        if (remaps.isEmpty()) return
        updatePersistedMetadata { raw -> remaps.firstOrNull { sameDocumentUri(raw, it.oldUri) }?.newUri ?: raw }
    }

    fun applyUriRemaps(
        remaps: List<UriRemap>,
        oldFolderPrefix: String? = null,
        newFolderPrefix: String? = null,
        folderTreeRaw: String? = null,
        statusMessage: String? = null,
        preRenameFolderState: Map<StudioViewModel, Pair<Long, String>> = emptyMap(),
    ) {
        if (remaps.isEmpty() && oldFolderPrefix == null) return
        remapPersistedMetadata(remaps)

        val currentRecents = readRecent()
        val updatedRecents = currentRecents.map { item ->
            val matched = remaps.firstOrNull { sameDocumentUri(item.uri, it.oldUri) }
            when {
                matched != null -> item.copy(
                    name = matched.newName ?: item.name,
                    uri = matched.newUri,
                    relative = matched.newRelative ?: item.relative,
                )
                oldFolderPrefix != null && newFolderPrefix != null && matchesRelativePrefix(item.relative, oldFolderPrefix) ->
                    item.copy(relative = remapRelativePrefix(item.relative, oldFolderPrefix, newFolderPrefix))
                else -> item
            }
        }
        if (updatedRecents != currentRecents) {
            storeRecent(updatedRecents)
        }

        liveViewModels().forEach { vm ->
            vm.workspaceLinks.invalidate()
            if (oldFolderPrefix != null) vm.readerFolderIndex.clear()
            changeVmState(vm) { currentState ->
                val nextTabs = currentState.tabs.map { tab ->
                    val tabUri = tab.uri
                    val matched = if (tabUri != null) remaps.firstOrNull { sameDocumentUri(tabUri, it.oldUri) } else null
                    when {
                        matched != null -> tab.copy(
                            name = matched.newName ?: tab.name,
                            uri = matched.newUri,
                            relative = matched.newRelative ?: tab.relative,
                        )
                        oldFolderPrefix != null && newFolderPrefix != null && matchesRelativePrefix(tab.relative, oldFolderPrefix) ->
                            tab.copy(relative = remapRelativePrefix(tab.relative, oldFolderPrefix, newFolderPrefix))
                        else -> tab
                    }
                }
                val nextMsg = if (vm === owner && statusMessage != null) statusMessage else currentState.message
                currentState.copy(tabs = nextTabs, message = nextMsg)
            }
            val vmState = readVmState(vm)
            val vmFolder = vmState.folder
            if (vmFolder != null && (folderTreeRaw == null || sameDocumentUri(vmFolder, folderTreeRaw))) {
                val preRename = preRenameFolderState[vm]
                val currentRel = if (preRename != null && readVmListFolderSeq(vm) == preRename.first) {
                    preRename.second
                } else {
                    vmState.folderRelative.ifEmpty { readVmListedRelative(vm) }
                }
                val nextListed = if (oldFolderPrefix != null && newFolderPrefix != null && matchesRelativePrefix(currentRel, oldFolderPrefix)) {
                    remapRelativePrefix(currentRel, oldFolderPrefix, newFolderPrefix).orEmpty()
                } else {
                    currentRel
                }
                vm.listFolder(Uri.parse(vmFolder), nextListed)
            }
            readVmSeededFind(vm)?.let { seed ->
                val seedUri = seed.targetUri
                if (!seedUri.isNullOrBlank()) {
                    val remappedSeed = remaps.firstOrNull { sameDocumentUri(seedUri, it.oldUri) }
                    if (remappedSeed != null) {
                        writeVmSeededFind(vm, seed.copy(targetUri = remappedSeed.newUri))
                    }
                }
            }
            refreshVmFolderSearchIfActive(vm)
        }
    }
}
