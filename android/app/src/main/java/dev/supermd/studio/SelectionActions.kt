package dev.supermd.studio

import java.net.URLEncoder

/** Fixed destinations. Never send a prompt via an unverified auto-submit URL. */
internal object SelectionActions {
    val assistants = listOf("chatgpt" to "ChatGPT", "gemini" to "Gemini", "claude" to "Claude")
    fun provider(value: String?) = value?.takeIf { candidate -> assistants.any { it.first == candidate } } ?: "chatgpt"
    fun label(value: String) = assistants.first { it.first == provider(value) }.second
    data class Target(val url: String, val copy: Boolean, val message: String)
    fun target(action: String, raw: String, provider: String): Target {
        require(raw.isNotBlank()) { "Select some text first." }
        require(raw.length <= 1_000_000) { "Select a smaller excerpt." }
        val text = raw.replace('\u2029', '\n')
        if (action == "google") {
            val url = "https://www.google.com/search?q=" + URLEncoder.encode(text, "UTF-8")
            require(url.length <= 8000) { "This selection is too long for a search URL. Select a smaller excerpt." }
            return Target(url, false, "Searching Google for the selected text.")
        }
        require(action == "assistant" && assistants.any { it.first == provider }) { "Unknown selection action or assistant." }
        val url = when (provider) {
            "gemini" -> "https://gemini.google.com/app"
            "claude" -> "https://claude.ai/new"
            else -> "https://chatgpt.com/"
        }
        return Target(url, true, "Selected text copied. Paste it into ${label(provider)}, review it, then send.")
    }
}
