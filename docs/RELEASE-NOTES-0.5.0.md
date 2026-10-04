# Super MD 0.5.0

Python plots now work out of the box, graphs feel like a real graphing tool,
and Windows finally gets proper fullscreen. Here is what changed.

## Python that just works

- **Windows and macOS include Python.** The installers now ship a built-in
  Python with numpy and matplotlib, so Python cells and plots run without
  installing anything. "Built-in Python" is the default on a fresh install.
- **Linux finds your Python for you.** Settings > Python lists the
  interpreters and virtual environments it detects (system Python, a `.venv`
  next to your notes, pyenv, conda, virtualenvwrapper) and shows which ones
  have matplotlib. Click one to use it.
- **One-click setup.** No matplotlib anywhere? Press "Set up Python" and Super
  MD creates its own private environment and installs numpy and matplotlib.
- **Friendlier errors.** A failing cell now shows the line that broke and the
  error, not a wall of internal traceback. Missing matplotlib tells you how to
  fix it.
- Cells run inside the note's folder, so `open("data.csv")` finds files next
  to your note.
- The Run button is always available. If no Python is set up yet, it explains
  what to do instead of silently staying grey.
- Code still only runs when you press Run. Nothing runs on open or export.

## Graphs, GeoGebra style

- **The probe locks onto the curve.** Hover or touch a graph and the point
  snaps to the nearest curve and shows its real coordinates. Moving the mouse
  away from every curve shows nothing, instead of random coordinates.
- **Roots, peaks, valleys and intersections snap.** Get close to one and the
  probe locks onto it and names it, for example "Intersection, y = x^2 and y = x".
- **Every equation is labelled.** Each curve is named at the edge of the plot
  and in the legend (`y = a·sin(x)` or your own series name). Labels also
  appear in PDF exports.
- **Cleaner controls.** Sliders show their value in a chip with the range
  underneath. "Reset view" (or a double-click) brings a panned or zoomed graph
  back.
- A broken expression no longer takes the whole note down with it.

## Desktop

- **True fullscreen on Windows.** Fullscreen now hides the window buttons and
  covers the whole screen.
- **Readable title bar in dark mode on Windows.** The minimize, maximize and
  close buttons follow the app theme instead of staying black on dark.
- **Remembers your window.** Super MD reopens at the size you left it, and
  maximized if it was maximized.
- **Smoother scrolling and zooming.** Mouse-wheel scrolling is animated, and
  Ctrl + / Ctrl - zoom glides to the new size while keeping the text under the
  cursor in place.
- Snappier interface: theme colors are computed once per change instead of in
  every button, which removes small stutters when typing and switching tabs.

## Android

- **Find in note sits where it should.** The search bar now appears at the top
  of the screen, clear of the camera cutout, instead of floating mid-page.
- **Better battery life.** The reader pauses completely while the app is in the
  background, typing no longer sends the whole note back and forth on every
  keystroke, and draft recovery writes to storage less often.

## Design

- **Code blocks match your theme.** No more pure-black slabs: code uses a soft
  tonal surface with syntax colors tuned for both light and dark mode.
  Collapsible blocks get a cleaner header, and the Copy button no longer
  overlaps the border.
- New, clearer table of contents icon on desktop and Android.
- Graph legends, buttons and the Python cell toolbar follow Material 3
  Expressive shapes and motion, and respect reduced-motion settings.

## Safety and reliability

- Remote images and link previews connect only to the address that was
  checked, closing a DNS rebinding gap.
- The Python interpreter setting only accepts real Python executables.
- Python figures are size-checked before they are shown or exported.
- Pasting a malformed link into the media dialog no longer freezes it.

## Good to know

- Interactive 3D graphs stay retired; use a Python cell with matplotlib for
  3D figures.
- Checked with the desktop native tests, the shared web tests, the browser
  end-to-end suite, an offscreen desktop smoke run and an Android compile and
  unit-test pass. CI also verifies that the Windows and macOS builds' built-in
  Python renders a matplotlib 3D figure.
