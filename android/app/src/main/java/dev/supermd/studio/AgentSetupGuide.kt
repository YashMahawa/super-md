package dev.supermd.studio

/** Human-readable handoff shown only after the user explicitly opens Live Agent setup. */
object AgentSetupGuide {
    fun instructions(config: AgentAccessConfig): String = buildString {
        appendLine("Super MD Live Agent")
        appendLine()
        appendLine("Keep Super MD open and Live Agent Access enabled while the agent is using your tabs.")
        appendLine("Connect your AI client to this private MCP URL using Streamable HTTP:")
        appendLine(config.mcpUrl)
        appendLine()
        appendLine("Legacy SSE clients can connect at the same URL. Pairing keys and device keys belong only to Super MD and must not be copied into the AI client's configuration.")
        appendLine("If you have several paired devices online, use list_devices first and choose a deviceId before editing or exporting.")
        appendLine("Edits require the SHA-256 revision returned by read_tab. If a revision conflict appears, reread the tab and rebuild the edit.")
        appendLine("The cloud relay routes live requests only; it does not store your note contents. A free relay may need a cold start after inactivity.")
        appendLine()
        appendLine("Local desktop access can use the stdio MCP configuration in the Super MD Agent Interface guide. It works while the desktop app is running and does not need the cloud relay.")
    }
}
