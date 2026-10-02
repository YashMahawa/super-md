The bundled Manrope, Roboto, Noto Serif and JetBrains Mono TrueType fonts are
from google/fonts, pinned to commit 9710da1eacb3be272583c3224dcb70f9da6eadbb.
Their upstream OFL licenses are included under public/licenses and distributed
with the app. The existing static Noto Sans family is covered by OFL.txt.

Reading, PDF export and PDF sharing use the same font family names. Imported
TTF/OTF fonts are stored privately by the app and passed to the local typesetter;
they are not automatically embedded in portable notes or uploaded anywhere.
