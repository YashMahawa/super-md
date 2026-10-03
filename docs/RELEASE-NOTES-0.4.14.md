# Super MD 0.4.14

- Android reading bars overlay a fixed-size reader in both normal and fullscreen
  modes. Hiding/showing them no longer resizes the page or causes a vertical bounce.
- Fixed fullscreen applying reading width twice to the text column. Normal and
  fullscreen preserve the same width and magnification on phones and tablets.
- An unscaled start-of-note spacer protects the first heading. It stays unchanged
  when bars hide; switching compact/expanded bars preserves the reading anchor.
- Desktop fullscreen uses a compact themed bar: Contents on the left, Save,
  Export and Exit on the right. Scroll down hides it, scroll up reveals it,
  and a single reading click toggles it. Deliberate top-edge hover and keyboard
  focus keep controls accessible. Selection, Live double-click editing and
  independent image/chart gestures do not toggle the bar.
- Desktop fixed and theme-adaptive brush-S SVG branding matches Android. The
  normal desktop toolbar stays in place and no top-left app logo is reintroduced.

Verification includes actual text-column width at phone, landscape and tablet
sizes, first-heading clearance, unscaled spacing, unchanged overlay geometry,
scroll anchoring and reading gestures. The native desktop presented-pixel smoke
also checks fullscreen title clearance and PDF export. Exact-source CI, Android
API 35/36 tests, signed release verification and all installers gate publication.
No physical phone testing or laptop power action is performed.
