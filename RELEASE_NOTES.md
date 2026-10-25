# Super MD 0.6.12

## Theme styling guide inside the app

- Settings → Custom theme → Authoring guide now opens an offline popup in the reading area instead of launching a browser.
- The guide follows the active theme, renders headings, tables and code clearly, and fits desktop and phone displays.
- Copy the complete Markdown guide for an AI assistant, or copy individual examples. Native clipboard access avoids hidden WebView permission prompts.
- Close with the close button, Escape or Android Back. The note and its reading position remain intact; scrolling the guide does not move the note beneath it.

## Optional LaTeX autofix on paste

- Enable **LaTeX autofix on paste** in Settings → Writing assistance. It is off by default on desktop and Android.
- Source, Split and Live editors repair validated delimiter and brace mistakes in pasted formulas. Undo/Redo treats the repaired paste as one edit.
- Existing valid formulas, ordinary prose, currency, code and links are protected. Unsupported or ambiguous commands remain available for manual review with Fix LaTeX.
- Paste examines bounded surrounding context rather than reparsing a whole large note. Image and file pastes retain their existing behavior.

All 0.6.11 selection, context menu, search and export improvements are retained. Android uses the existing signing identity and a higher version code for in-place updates.
