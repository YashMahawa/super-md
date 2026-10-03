# Gestures and LaTeX repair

Read/Live uses page magnification. Layout is calculated at the selected reading
width (80% by default), then magnified without rewrapping paragraphs. Zoomed pages
can scroll horizontally. Native chrome stays fixed. Source mode scales editor text.

| Area | Gesture | Result |
| --- | --- | --- |
| Document | Pinch / Ctrl-wheel / held-left-button wheel | Focal page zoom |
| Document | Two-finger movement | Pan the magnified page |
| Graph canvas | Left drag / two-finger movement | Pan camera |
| Graph canvas | Pinch / Ctrl-wheel / held-left-button wheel | Focal graph zoom |
| Graph controls/title | Pinch / Ctrl-wheel | Document zoom, not camera zoom |
| 3D canvas | Shift-drag / arrow keys | Rotate camera |
| Image viewer | Drag / two-finger movement | Pan image |
| Image viewer | Pinch / Ctrl-wheel / mouse wheel | Focal image zoom |

Qt provides native pixel deltas for touchpad movement; ordinary wheel notches
remain document scrolling over plots. Browser DOM events do not reliably expose
device identity, so other hosts use fine-pixel/horizontal-delta heuristics for
trackpad movement. Ctrl/Meta always disambiguates zoom. A high-resolution mouse
can look like a touchpad in a browser; no universal device-identification claim.

Fix LaTeX runs the same code on Android and desktop. Changes are suggestions, not
an automatic rewrite. Validated proposals cover explicit delimiters, padding,
missing dollar signs around clear standalone or inline TeX, unfinished fences,
selected environments and at most two missing closing braces. The review lists
exact source changes, with Undo/Redo available after applying.

Currency, code, links, image source and HTML are protected. Ambiguous sentences,
unknown commands, missing fraction arguments and arbitrary TeX macros are not
guessed. Spaces inside dollar delimiters are legal in the parser; trimming them
is a compatibility normalization, not proof that whitespace caused a failure.

Implementation references:

- [KaTeX delimiters and ignored code tags](https://katex.org/docs/autorender.html)
- [KaTeX validation, trust and resource limits](https://katex.org/docs/options)
- [Markdown math grammar](https://github.com/micromark/micromark-extension-math)
- [Qt wheel pixel deltas](https://doc.qt.io/qt-6/qml-qtquick-wheelevent.html)
- [Qt WheelHandler input devices](https://doc.qt.io/qt-6/qml-qtquick-wheelhandler.html)
