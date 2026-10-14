package dev.supermd.studio

/** Fullscreen scrolling never summons controls. A deliberate tap still toggles. */
internal fun readingChromeAfterGesture(fullscreen: Boolean, visible: Boolean, scrollIntent: Boolean?, tap: Boolean): Boolean? =
    when {
        scrollIntent != null -> !fullscreen && scrollIntent
        tap -> !visible
        else -> null
    }
