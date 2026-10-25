# Super MD 0.6.11

## More reliable text selection

- Dragging through text while scrolling no longer changes document zoom. Explicit Ctrl/Cmd-wheel and pinch zoom remain available; held-button wheel zoom still works on empty page space and inside plots.
- Selection keeps its presented geometry during a drag. Reduced desktop zoom also aligns horizontal positioning to avoid a Chromium issue that collapsed selection to a caret in narrow Split panes.
- Forward and backward selection is covered in Read, Live and Split at 40% and 300%, including 125% and 200% display scaling. Existing scrolling, heading navigation, wrapping and offscreen rendering are retained.

## Search or ask about selected text

- Desktop right-click menus and Android's native selection toolbar offer **Search Google** and **Ask**.
- Choose ChatGPT, Gemini or Claude under **Settings → Selected text**.
- Ask copies the complete selection, including code indentation, and opens the chosen assistant for you to paste, review and send. It never automatically submits a prompt. Google opens a search for the selection.
- Android retains the system's selection handles, Copy/Share actions and toolbar placement. Both direct and child-view selection callbacks are supported.

## Clearer menus and larger reading controls

- Reader context menus use opaque rounded surfaces and hover highlights. The stock ripple that could appear as a large circle at the top-left is removed.
- Editing actions are based on the actual clicked context; link copying and selected-text actions appear when relevant.
- Search and export panels adapt to larger displays using larger text and controls, without zooming the rest of the interface or stretching text into a bitmap.
- PDF export displays one expressive animation alongside useful status and cancellation. Accessible progress information and reduced-motion preferences remain supported.

## Compatibility and validation

All 0.6.10 diagram-sizing and earlier stability fixes are retained. Android keeps the existing upgrade certificate and uses a higher version code for in-place updates. Release gates cover Linux, Windows, Intel and Apple Silicon Mac, Android 15/16 emulator tests, production APK validation, and packaged application checks.
