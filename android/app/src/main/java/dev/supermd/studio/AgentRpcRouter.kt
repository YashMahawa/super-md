package dev.supermd.studio

import android.webkit.WebView
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import org.json.JSONObject

internal data class AgentSavePrecheckFailure(val message: String, val revisionConflict: Boolean = false)

internal fun buildAgentTabJson(
    note: Note, tabId: String, revision: String, id: String? = null,
    nameOverride: String? = null, pathOverride: String? = null, uriOverride: String? = null,
    active: Boolean? = null, saved: Boolean? = null, mode: String? = null, format: String? = null,
    savedAs: Boolean? = null, closed: Boolean? = null, activeTabId: String? = null,
): JSONObject = JSONObject().apply {
    if (id != null) put("id", id)
    if (closed != null) put("closed", closed)
    if (activeTabId != null) put("activeTabId", activeTabId)
    put("tabId", tabId).put("name", nameOverride ?: note.name)
    put("path", pathOverride ?: (note.uri ?: note.id)).put("uri", uriOverride ?: (note.uri ?: JSONObject.NULL))
    if (active != null) put("active", active)
    if (saved != null) put("saved", saved)
    if (mode != null) put("mode", mode)
    if (format != null) put("format", format)
    if (savedAs != null) put("savedAs", savedAs)
    put("revision", revision)
}

internal fun validateAgentSavePrecheck(
    note: Note?, requestedFormat: String?, expectedRevision: String,
    currentRevision: String = note?.let { agentContentRevision(it.content) }.orEmpty(), saveAs: Boolean,
): AgentSavePrecheckFailure? {
    if (note == null) return AgentSavePrecheckFailure("The requested tab is not open on this device")
    val actualFormat = if (note.portable) "smd" else "md"
    if (requestedFormat != null && requestedFormat != actualFormat)
        return AgentSavePrecheckFailure("Android ${if (saveAs) "Save As" else "save"} preserves this note's $actualFormat format; converting formats is not supported")
    if (!currentRevision.equals(expectedRevision, ignoreCase = true))
        return AgentSavePrecheckFailure("Revision conflict: the note changed; read it again before saving", revisionConflict = true)
    return null
}

@Composable internal fun BindAgentRpcRouter(
    activity: MainActivity,
    model: StudioViewModel,
    state: StudioState,
    readerReady: Boolean,
    web: WebView?,
    scope: CoroutineScope,
) {
    DisposableEffect(activity, model, readerReady, web, state.tabs, state.activeId) {
        val bridge: ((JSONObject, (Any?, String?) -> Unit) -> Unit)? = if (!readerReady || web == null) null else bridge@{ incoming, reply ->
            val request = JSONObject(incoming.toString())
            val globallyQualified = request.optString("tabId")
            val rawTabId = if (globallyQualified.isNotBlank()) activity.localAgentTabId(globallyQualified) else null
            if (globallyQualified.isNotBlank() && rawTabId == null) { reply(null, "This tab belongs to a different device or workspace"); return@bridge }
            if (rawTabId != null) request.put("tabId", rawTabId)
            request.optString("expectedRevision").takeIf { it.isNotBlank() }?.let { request.put("expectedRevision", it.lowercase()) }
            fun canonicalTabId(note: Note): String = "tab:${activity.agentConfigForThisWindow()?.deviceId ?: "local"}:${activity.agentWorkspaceKey}:${note.id}"
            fun sendAgentReply(targetId: String, result: Any?, error: String?) {
                val current = model.state.value.tabs.firstOrNull { it.id == targetId }
                val knownConflict = error?.takeIf { message ->
                    message.contains("revision conflict", ignoreCase = true) ||
                        message.contains("changed since the supplied revision", ignoreCase = true) ||
                        message.contains("changed since the expected revision", ignoreCase = true)
                }
                if (knownConflict != null && current != null) {
                    reply(null, JSONObject().put("error", knownConflict).put("currentRevision", activity.agentRevision(current.content))
                        .put("sourceLength", activity.agentSourceLength(current.content)).toString())
                } else reply(result, error)
            }
            fun withSelectedTab(snapshotSafeWhenInactive: Boolean = false, action: suspend () -> Unit) {
                val target = request.optString("tabId").takeIf { it.isNotBlank() }
                if (target == null) { scope.launch { action() }; return }
                val snapshot = model.state.value.tabs.firstOrNull { it.id == target }
                if (snapshot == null) { reply(null, "The requested tab is not open on this device"); return }
                val suppliedRevision = request.optString("expectedRevision").takeIf { it.isNotBlank() }
                if (suppliedRevision != null && !activity.agentRevision(snapshot.content).equals(suppliedRevision, ignoreCase = true)) {
                    sendAgentReply(target, null, "Revision conflict: the note changed; read it again before editing")
                    return
                }
                if (model.state.value.activeId != target && snapshotSafeWhenInactive) {
                    if (request.optString("action") !in setOf("read_tab", "search_tab", "outline_tab", "list_diagrams", "get_diagram", "patch_tab")) {
                        reply(null, "This Android action requires the requested tab to be active")
                        return
                    }
                    val contentBytes = snapshot.content.toByteArray(Charsets.UTF_8)
                    if (contentBytes.size > MAX_AGENT_SNAPSHOT_BYTES) { reply(null, "This document exceeds Android's 2 MiB inactive-tab snapshot limit; activate it and retry"); return }
                    val compute = JSONObject().put("requestId", request.optString("requestId"))
                        .put("action", request.optString("action")).put("tabId", target).put("content", snapshot.content)
                    listOf("expectedRevision", "operations", "offset", "limit", "query", "context", "heading", "view", "diagramId", "caseSensitive", "wholeWord", "regex", "excludeDiagrams")
                        .forEach { key -> if (request.has(key)) compute.put(key, request.get(key)) }
                    if (request.has("expectedRevision")) compute.put("expectedRevision", request.getString("expectedRevision").lowercase())
                    activity.dispatchAgentCompute(web!!, compute) { raw, error ->
                        if (error != null) { reply(null, error); return@dispatchAgentCompute }
                        val result = raw as? JSONObject
                        if (result == null) { reply(null, "Android could not read the computed document result"); return@dispatchAgentCompute }
                        val snapshotRevision = activity.agentRevision(snapshot.content)
                        val actionName = request.optString("action")
                        if (result.optString("tabId") != target) {
                            reply(null, "The document result did not match the captured Android note snapshot")
                            return@dispatchAgentCompute
                        }
                        if (request.optString("action") == "patch_tab") {
                            val patchedContent = result.optString("patchedContent", "")
                            if (!result.optString("baseRevision").equals(snapshotRevision, ignoreCase = true) ||
                                result.optInt("baseSourceLength", -1) != activity.agentSourceLength(snapshot.content) ||
                                result.optInt("sourceLength", -1) != activity.agentSourceLength(patchedContent) ||
                                !request.optString("expectedRevision").equals(snapshotRevision, ignoreCase = true)) {
                            sendAgentReply(target, null, "Revision conflict: the note changed; read it again before editing")
                                return@dispatchAgentCompute
                            }
                            scope.launch {
                                runCatching {
                                    model.commitAgentSnapshotPatch(target, snapshotRevision, patchedContent, result.optString("revision"))
                                }.onFailure { sendAgentReply(target, null, it.message ?: "Could not save the inactive-tab patch") }
                                    .onSuccess { result.remove("patchedContent"); result.put("tabId", canonicalTabId(snapshot)); reply(result, null) }
                            }
                        } else {
                            if (!result.optString("revision").equals(snapshotRevision, ignoreCase = true) || result.optInt("sourceLength", -1) != activity.agentSourceLength(snapshot.content)) {
                                reply(null, "The document revision changed while Android was reading it; retry")
                            } else {
                                result.put("tabId", canonicalTabId(snapshot))
                                reply(result, null)
                            }
                        }
                    }
                } else if (model.state.value.activeId != target) {
                    reply(null, "The requested tab is inactive. Activate it in Super MD before using this Android reader action.")
                } else scope.launch { action() }
            }
            fun replySavedTab(target: String, nameOverride: String? = null, pathOverride: String? = null, savedAs: Boolean = false) {
                val saved = model.state.value.tabs.firstOrNull { it.id == target }
                if (saved == null) reply(null, "The note closed while it was saving")
                else reply(buildAgentTabJson(saved, canonicalTabId(saved), activity.agentRevision(saved.content),
                    nameOverride = nameOverride, pathOverride = pathOverride, uriOverride = pathOverride,
                    active = saved.id == model.state.value.activeId, saved = !saved.dirty, savedAs = if (savedAs) true else null), null)
            }
            fun withFlushedActiveTab(fallbackError: String, notifyAssetsChanged: (JSONObject) -> Boolean, mutation: suspend () -> JSONObject) = withSelectedTab {
                val flush = JSONObject(request.toString()).put("action", "flush_current")
                activity.dispatchAgentRequest(web!!, flush) { _, flushError ->
                    if (flushError != null) reply(null, flushError)
                    else scope.launch {
                        runCatching { mutation() }
                            .onSuccess { if (notifyAssetsChanged(it)) web?.evaluateJavascript("window.dispatchEvent(new Event('supermd-assets-changed'))", null); reply(it, null) }
                            .onFailure { sendAgentReply(request.optString("tabId"), null, it.message ?: fallbackError) }
                    }
                }
            }
            when (request.optString("action")) {
                "list_tabs" -> {
                    val tabs = org.json.JSONArray()
                    val liveState = model.state.value
                    liveState.tabs.take(100).forEach { note ->
                        val id = canonicalTabId(note)
                        val isActive = note.id == liveState.activeId
                        tabs.put(buildAgentTabJson(note, id, activity.agentRevision(note.content), id = id,
                            active = isActive, saved = !note.dirty, mode = if (isActive) liveState.mode else "live"))
                    }
                    reply(JSONObject().put("tabs", tabs), null)
                }
                "document_action" -> when (request.optString("documentAction")) {
                    "create" -> {
                        val options = request.optJSONObject("options")
                        val title = request.optString("titleHint").takeIf { it.isNotBlank() }
                            ?: request.optString("filename").takeIf { it.isNotBlank() }
                        val format = request.optString("format").takeIf { it.isNotBlank() }
                            ?: if (title?.endsWith(".smd", ignoreCase = true) == true) "smd" else "md"
                        model.newNote(title, request.optString("content").takeIf { request.has("content") },
                            options?.optBoolean("background", false) == true, format) { created ->
                            if (created == null) reply(null, "Super MD could not create a tab")
                            else {
                                val updated = model.state.value.tabs.firstOrNull { it.id == created.id } ?: created
                                reply(buildAgentTabJson(updated, canonicalTabId(updated), activity.agentRevision(updated.content),
                                    active = updated.id == model.state.value.activeId, format = if (updated.portable) "smd" else "md"), null)
                            }
                        }
                    }
                    "activate" -> {
                        val target = request.optString("tabId")
                        if (model.state.value.tabs.none { it.id == target }) reply(null, "The requested tab is not open on this device")
                        else {
                            model.select(target)
                            scope.launch {
                                val selected = kotlinx.coroutines.withTimeoutOrNull(5_000) { model.state.first { it.activeId == target } }
                                if (selected == null) reply(null, "Could not activate the requested open tab")
                                else {
                                    // ActiveId changes before the WebView's React tree has necessarily received
                                    // supermdLoad for the new tab. Do not report activation complete until the
                                    // live reader has acknowledged this exact native snapshot; otherwise an
                                    // immediate close can safely fail its own flush while JS still holds the
                                    // previous tab. The close barrier remains mandatory after this handshake.
                                    val readerReady = model.awaitReaderSnapshot(target)
                                    if (!readerReady) reply(null, "The requested tab is still loading in the reader; retry activation shortly")
                                    else {
                                        val note = model.state.value.tabs.firstOrNull { it.id == target }
                                        if (note == null || model.state.value.activeId != target) reply(null, "The requested tab is no longer open")
                                        else reply(buildAgentTabJson(note, canonicalTabId(note), activity.agentRevision(note.content), active = true), null)
                                    }
                                }
                            }
                        }
                    }
                    "save" -> {
                        val target = request.optString("tabId")
                        val saveAs = request.optJSONObject("options")?.optBoolean("saveAs", false) == true
                        val requestedFormat = request.optString("format").takeIf { it.isNotBlank() }
                        val note = model.state.value.tabs.firstOrNull { it.id == target }
                        val precheck = validateAgentSavePrecheck(note, requestedFormat, request.optString("expectedRevision"),
                            note?.let { activity.agentRevision(it.content) }.orEmpty(), saveAs)
                        if (precheck != null) {
                            if (precheck.revisionConflict) sendAgentReply(target, null, precheck.message)
                            else reply(null, precheck.message)
                        } else if (saveAs) {
                            model.busy(true)
                            scope.launch {
                                runCatching { model.saveAgentAs(target, request.getString("expectedRevision"), request.getString("filename")) }
                                    .onFailure { error -> model.fail("Could not save as: ${error.message}"); sendAgentReply(target, null, error.message ?: "Could not save as") }
                                    .onSuccess { (path, name) -> replySavedTab(target, nameOverride = name, pathOverride = path, savedAs = true) }
                            }
                        } else if (note!!.portable) {
                            model.busy(true)
                            scope.launch {
                                runCatching { model.saveAgentPortable(target, request.getString("expectedRevision")) }
                                    .onFailure { error -> sendAgentReply(target, null, model.reportDocumentSaveFailure(target, error, "Could not save portable note: ${error.message}")) }
                                    .onSuccess { replySavedTab(target) }
                            }
                        } else model.save(noteId = target, expectedRevision = request.optString("expectedRevision")) { error ->
                            if (error != null) sendAgentReply(target, null, error) else replySavedTab(target)
                        }
                    }
                    "close" -> {
                        val target = request.optString("tabId")
                        val note = model.state.value.tabs.firstOrNull { it.id == target }
                        val discard = request.optJSONObject("options")?.optBoolean("discardChanges", false) == true
                        if (note == null) reply(null, "The requested tab is not open on this device")
                        else if (!activity.agentRevision(note.content).equals(request.optString("expectedRevision"), ignoreCase = true)) sendAgentReply(target, null, "Revision conflict: the note changed since the supplied revision; it remains open")
                        else if (note.dirty && !discard) reply(null, "The note has unsaved changes. Set options.discardChanges=true to close it; Android will retain its recovery copy.")
                        else {
                            model.close(target, request.getString("expectedRevision"), refuseDirty = true, discardChanges = discard) { error ->
                                if (error != null) sendAgentReply(target, null, error)
                                else {
                                    val current = model.state.value
                                    val activeTabId = canonicalTabId(current.active)
                                    reply(buildAgentTabJson(current.active, activeTabId, activity.agentRevision(current.active.content),
                                        closed = true, activeTabId = activeTabId), null)
                                }
                            }
                        }
                    }
                    "open" -> { reply(null, "Use Super MD's Open action on Android, then retry the device request.") }
                    "job_status" -> reply(activity.agentExportJob(request.optString("jobId")) ?: JSONObject().put("jobId", request.optString("jobId")).put("phase", "unknown"), null)
                    "export_chunk" -> scope.launch {
                        try { reply(activity.readAgentExportChunk(request.getString("jobId"), request.optLong("offset", 0L), request.optInt("limit", 262_144)), null) }
                        catch (error: Exception) { reply(null, error.message ?: "Could not read this export chunk") }
                    }
                    else -> {
                        val action = when (request.optString("documentAction")) {
                            "latexfix" -> if (request.optJSONObject("options")?.has("repairIndices") == true) "latex_apply" else "latex_review"
                            "outline" -> "outline_tab"
                            "snapshot" -> "snapshot"
                            else -> request.optString("documentAction")
                        }
                        if (request.optString("documentAction") in setOf("latexfix", "latex_apply") && action == "latex_apply" && !request.has("repairIndices"))
                            request.optJSONObject("options")?.takeIf { it.has("repairIndices") }?.let { request.put("repairIndices", it.getJSONArray("repairIndices")) }
                        request.optJSONObject("options")?.let { options ->
                            listOf("offset", "limit").forEach { field -> if (!request.has(field) && options.has(field)) request.put(field, options.get(field)) }
                        }
                        if (request.optString("documentAction") == "export") {
                            val options = request.optJSONObject("options")
                            val requestedName = request.optString("filename").takeIf { it.isNotBlank() } ?: options?.optString("filename").orEmpty()
                            val filename = requestedName.takeIf { it.isNotBlank() }?.let { it.substringAfterLast('/').substringAfterLast('\\').replace(Regex("[\\u0000-\\u001f\\u007f]"), "").take(240) }
                                ?.takeIf { it.isNotBlank() }
                            val exportFormat = request.optString("format").takeIf { it.isNotBlank() } ?: options?.optString("format", "pdf") ?: "pdf"
                            request.put("action", "export_document").put("format", exportFormat)
                            if (filename != null) request.put("filename", filename)
                            options?.remove("filename")
                            options?.remove("format")
                        }
                        else request.put("action", action)
                        if (request.optString("action") == "snapshot") withSelectedTab { runCatching { activity.captureAgentViewport(web!!, request.optInt("width", 1200)) }.onSuccess { reply(it, null) }.onFailure { reply(null, it.message ?: "Could not capture the reading viewport") } }
                        else withSelectedTab { activity.dispatchAgentRequest(web!!, request) { result, error -> sendAgentReply(request.optString("tabId"), result, error) } }
                    }
                }
                "render_tab" -> withSelectedTab { runCatching { activity.captureAgentViewport(web!!, request.optInt("width", 1200), request.optString("imageFormat", "png")) }.onSuccess { reply(it, null) }.onFailure { reply(null, it.message ?: "Could not capture the reading viewport") } }
                "get_diagram", "get_diagram_image", "list_diagrams" -> withSelectedTab(snapshotSafeWhenInactive = true) { activity.dispatchAgentRequest(web!!, request) { result, error -> sendAgentReply(request.optString("tabId"), result, error) } }
                "replace_tab_asset" -> withFlushedActiveTab("Could not replace the portable image", { it.optBoolean("changed") }) {
                    model.replacePortableAsset(request.getString("tabId"), request.getString("assetName"), request.getString("assetPath"), request.getString("expectedRevision"))
                }
                "asset_action" -> withFlushedActiveTab("Could not use the portable image asset", { request.optString("assetAction") == "attach" }) { model.agentAssetAction(request) }
                "read_tab", "search_tab", "patch_tab", "get_context", "outline_tab", "latex_review", "latex_apply" -> withSelectedTab(snapshotSafeWhenInactive = request.optString("action") in setOf("read_tab", "search_tab", "patch_tab", "outline_tab")) { activity.dispatchAgentRequest(web!!, request) { result, error -> sendAgentReply(request.optString("tabId"), result, error) } }
                else -> reply(null, "This action is not supported by the Android live reader.")
            }
        }
        activity.setAgentRequestHandlers(bridge, null)
        onDispose { activity.setAgentRequestHandlers(null, null) }
    }
}

@Composable internal fun BindAgentUiHandler(
    activity: MainActivity,
    openKey: Any?,
    saveKey: Any?,
    model: StudioViewModel,
    onLaunchOpenPicker: () -> Unit,
) {
    DisposableEffect(activity, openKey, saveKey, model) {
        activity.setAgentUiHandler { request, reply ->
            if (request.optString("action") != "document_action") false
            else when (request.optString("documentAction")) {
                "open" -> if (request.optJSONObject("options")?.optBoolean("background", false) == true) {
                    reply(null, "Background file picking is unavailable on Android; open the file in Super MD first")
                    true
                } else {
                    onLaunchOpenPicker()
                    reply(JSONObject().put("accepted", true).put("message", "Choose a file in Android's document picker"), null)
                    true
                }
                "save" -> false
                else -> false
            }
        }
        onDispose { activity.setAgentUiHandler(null) }
    }
}
