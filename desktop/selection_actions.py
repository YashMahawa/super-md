"""Explicit selection actions, with fixed destinations and bounded URL payloads.

Do not execute note text, accept arbitrary URL templates, truncate selections,
or assume a provider's web UI can prefill without submitting automatically.
"""
from urllib.parse import urlencode

ASSISTANTS = {"chatgpt": "ChatGPT", "gemini": "Gemini", "claude": "Claude"}
HOMES = {"chatgpt": "https://chatgpt.com/", "gemini": "https://gemini.google.com/app", "claude": "https://claude.ai/new"}


def selection_target(action, text, assistant="chatgpt"):
    if not isinstance(text, str) or not text.strip():
        raise ValueError("Select some text first.")
    if len(text) > 1_000_000:
        raise ValueError("Select a smaller excerpt.")
    text = text.replace("\u2029", "\n")
    if action == "google":
        url = "https://www.google.com/search?" + urlencode({"q": text})
        if len(url) > 8000:
            raise ValueError("This selection is too long for a search URL. Select a smaller excerpt.")
        return url, False, "Searching Google for the selected text."
    if action != "assistant" or not isinstance(assistant,str) or assistant not in ASSISTANTS:
        raise ValueError("Unknown selection action or assistant.")
    label, home = ASSISTANTS[assistant], HOMES[assistant]
    # No verified prefill-only contract for these web destinations. Do not
    # assume a q= link leaves a prompt unsubmitted or truncate long excerpts.
    return home, True, f"Selected text copied. Paste it into {label}, review it, then send."
