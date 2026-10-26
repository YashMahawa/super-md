# Super MD 0.6.13

## Selection and input

- Starting a text selection in blank space above a paragraph anchors to the following line, rather than selecting an earlier heading. Read, Live and Split share the fix, including large notes that render in sections.
- Hold the left mouse button still and scroll to zoom. Once a text drag begins, wheel scrolling and edge scrolling extend the selection without zooming.
- Desktop Ctrl/Command+C copies the selected Markdown source even after a toolbar has taken focus. Dragging selected text to another app also carries Markdown, including formatting, links and formulas.
- Find focuses the typing field immediately on desktop and Android, including repeated opens. Android explicitly restores WebView focus after closing the menu and respects the hardware keyboard preference.
- Desktop Settings now lists editable keyboard shortcuts, validates conflicts, and offers a reset button. Native text fields retain their own editing commands.
- Android keeps the new-tab plus visible beside the scrollable tabs and reveals the active tab after selection, renaming or a width change, keeping its close control accessible.
- The desktop context menu includes Reload. It acknowledges pending edits and preserves the note's view state before recreating the reader.

## Scrolling and export

- Touchpad input is combined once per display frame, preserving the complete scroll distance. Zoom easing follows elapsed time so it behaves consistently across refresh rates, with no idle animation loop.
- Dialogs use bounded sizes instead of growing with the monitor. Export progress uses a compact card with the expressive animation beside its status text; accessible progress and cancellation remain available.
- Android PDF export has one progress owner, preventing the native loading surface from covering the reader's progress card.
- Long PDF table labels can hyphenate within narrow columns instead of overlapping the next cell. Text size and table column proportions are preserved.

Existing LaTeX autofix, custom theme guide, portable formats and signing identity are retained. Android's version code increases for in-place updates.
