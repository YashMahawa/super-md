package dev.supermd.studio

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable internal fun rememberByteDocumentExporter(
    mimeType: String, missingStreamError: String, successMessage: String, failurePrefix: String,
    contentResolver: android.content.ContentResolver = LocalContext.current.contentResolver, onMessage: (String) -> Unit,
): (suggestedName: String, bytes: ByteArray) -> Unit {
    var pendingBytes by remember { mutableStateOf<ByteArray?>(null) }
    val currentResolver by rememberUpdatedState(contentResolver)
    val currentOnMessage by rememberUpdatedState(onMessage)
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(mimeType)) { uri ->
        val bytes = pendingBytes; pendingBytes = null
        if (uri != null && bytes != null) runCatching {
            currentResolver.openOutputStream(uri, "w")?.use { it.write(bytes); it.flush() } ?: error(missingStreamError)
        }.onSuccess { currentOnMessage(successMessage) }.onFailure { currentOnMessage("$failurePrefix: ${it.message}") }
    }
    return { suggestedName, bytes -> pendingBytes = bytes; launcher.launch(suggestedName) }
}

@Composable internal fun AgentAccessSettings(activity: MainActivity) {
    val scope = rememberCoroutineScope()
    val saved = activity.agentAccessState.currentConfig()
    var origin by remember { mutableStateOf(saved?.serverOrigin.orEmpty()) }
    var message by remember { mutableStateOf("") }
    var enabled by remember { mutableStateOf(activity.agentAccessState.enabled) }
    fun revokeThen(action: () -> Unit) {
        message = "Disconnecting and revoking previous device registrations…"
        activity.revokeAgentAccess { confirmed ->
            enabled = false
            action()
            if (!confirmed) message = "Local credentials were erased, but the relay could not confirm revocation. A previously copied device key may remain usable until the relay expires or restarts."
        }
    }
    fun joinWorkspace(text: String) {
        runCatching { activity.agentAccessState.joinPairingFile(text) }
            .onSuccess { config -> enabled = false; origin = config.serverOrigin; activity.refreshAgentRelay(); message = "This Android device joined the workspace. Switch Live Agent Access on when you want it connected. Keep the pairing file private." }
            .onFailure { message = "Could not join workspace: ${it.message}" }
    }
    val pairingExport = rememberByteDocumentExporter("application/json", "Android could not write the pairing file", "Trusted pairing file saved. Share it only with a device you trust.", "Could not save pairing file", activity.contentResolver) { message = it }
    fun createWorkspace() {
        runCatching { activity.agentAccessState.createPairingFile(origin) }
            .onSuccess { origin = activity.agentAccessState.currentConfig()?.serverOrigin.orEmpty(); activity.refreshAgentRelay(); pairingExport("SuperMD-pairing.json", it.toByteArray(Charsets.UTF_8)) }
            .onFailure { message = "Could not create workspace: ${it.message}" }
    }
    val pairingImport = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) scope.launch {
            val raw = runCatching { withContext(Dispatchers.IO) {
                activity.contentResolver.openInputStream(uri)?.use { input ->
                    val bytes = ByteArray(8 * 1024 + 1); val count = input.read(bytes)
                    require(count in 1..8 * 1024) { "Pairing file is empty or too large" }
                    String(bytes, 0, count, Charsets.UTF_8)
                } ?: error("The pairing file cannot be read")
            } }
            raw.onSuccess { text ->
                if (activity.agentAccessState.currentConfig() != null) revokeThen { joinWorkspace(text) }
                else joinWorkspace(text)
            }
                .onFailure { message = "Could not read pairing file: ${it.message}" }
        }
    }
    val guideExport = rememberByteDocumentExporter("text/markdown", "Android could not write the setup guide", "Setup instructions saved.", "Could not save setup guide", activity.contentResolver) { message = it }
    val skillExport = rememberByteDocumentExporter("application/zip", "Android could not write the skill package", "Skill package saved.", "Could not save skill package", activity.contentResolver) { message = it }
    val config = activity.agentConfigForThisWindow() ?: activity.agentAccessState.currentConfig()
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("Enter your own Super MD relay server or import a trusted pairing file. Connect an AI client to currently open tabs on this device. Access is off by default; the relay does not store notes.", style = MaterialTheme.typography.bodyMedium)
        OutlinedTextField(value = origin, onValueChange = { origin = it }, modifier = Modifier.fillMaxWidth(), singleLine = true,
            label = { Text("HTTPS relay origin") }, placeholder = { Text("https://relay.example.com") })
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Live Agent Access", style = MaterialTheme.typography.titleSmall)
                Text(if (enabled) "${activity.agentRelayState.name.lowercase().replaceFirstChar(Char::uppercase)} · reconnects while this app is open" else "Off · the device will not connect to the relay", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Switch(checked = enabled, enabled = config != null, onCheckedChange = { checked ->
                enabled = checked
                activity.agentAccessState.setEnabled(checked)
                activity.refreshAgentRelay()
            })
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            FilledTonalButton(enabled = origin.isNotBlank(), onClick = {
                if (activity.agentAccessState.currentConfig() != null) revokeThen(::createWorkspace) else createWorkspace()
            }) { Text("Create workspace & export pairing file") }
            OutlinedButton(onClick = { pairingImport.launch(arrayOf("application/json", "application/octet-stream", "text/plain")) }) { Text("Join from pairing file…") }
            OutlinedButton(enabled = config != null, onClick = {
                val file = activity.agentAccessState.currentPairingFile()
                if (file == null) message = "Create or join a workspace first"
                else pairingExport("SuperMD-pairing.json", file.toByteArray(Charsets.UTF_8))
            }) { Text("Export trusted pairing file…") }
            OutlinedButton(onClick = {
                runCatching { activity.assets.open("web/super-md-skill.zip").use { it.readBytes() } }
                    .onSuccess { bytes -> skillExport("super-md-skill.zip", bytes) }
                    .onFailure { message = "Could not load skill package: ${it.message}" }
            }) { Text("Export skill package (.zip)…") }
        }
        if (config != null) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = {
                    val clipboard = activity.getSystemService(android.content.ClipboardManager::class.java)
                    clipboard.setPrimaryClip(android.content.ClipData.newPlainText("Super MD MCP connector", config.mcpUrl))
                    message = "Private MCP connector URL copied. Share it only with the intended AI client."
                }) { Text("Copy private MCP URL") }
                TextButton(onClick = {
                    val skill = runCatching { activity.assets.open("web/super-md-agent-SKILL.md").bufferedReader().use { it.readText() } }.getOrNull()
                    guideExport("SuperMD-Live-Agent-setup.md", AgentSetupGuide.instructions(config, skill).toByteArray(Charsets.UTF_8))
                }) { Text("Save setup instructions…") }
            }
        }
        Text("The pairing file authorizes trusted devices; it is not for an AI client. Give the AI client only the private MCP URL. Each phone or open app window gets its own device key. Turning Live Agent Access off disconnects this app. Revoke removes this device from the relay and erases this device's credentials.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (config != null) TextButton(onClick = {
            message = "Disconnecting and revoking device registrations…"
            activity.revokeAgentAccess { confirmed ->
                enabled = false
                message = if (confirmed) "Live Agent access revoked on this device and the relay confirmed removal."
                    else "Local credentials were erased, but the relay could not confirm revocation. A previously copied device key may remain usable until the relay expires or restarts."
                activity.refreshAgentRelay()
            }
        }) { Text("Revoke this device's Live Agent access") }
        if (message.isNotBlank()) Text(message, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
    }
}
