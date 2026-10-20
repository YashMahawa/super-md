# Reader accessibility

Qt desktop and Android offer an opt-in **Full document accessibility** setting
under Settings → Reading. It keeps the full Markdown document mounted instead
of unmounting offscreen blocks, and disables the reader's offscreen
`content-visibility` shortcut. This gives assistive technology and document
Find a complete semantic tree without maintaining a second hidden copy.

The setting is off by default. Keeping every rendered block alive can increase
memory use and initial rendering time for large notes; turn it on when full
screen-reader traversal or document-wide Find is more important than the
large-note memory savings. The regular outline, in-app search, heading links,
and focused-block reveal remain available in the default mode.

This opt-in has been covered by DOM tests for complete rendering and heading
navigation, but it has **not** been manually verified with TalkBack, NVDA,
Orca, or another screen reader. Before claiming assistive-technology support,
manually verify continuous reading, heading/list/table/link traversal,
footnotes and backlinks, keyboard tab/focus, browser or in-app Find, and
navigation back from results on Android and Qt desktop. Record OS, screen
reader, browser/WebView version, and note fixture size with the results.
