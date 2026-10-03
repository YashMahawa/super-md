The bundled Manrope, Roboto, Noto Serif and JetBrains Mono TrueType fonts are
from google/fonts, pinned to commit 9710da1eacb3be272583c3224dcb70f9da6eadbb.
Their upstream OFL licenses are included under public/licenses and distributed
with the app. The existing static Noto Sans family is covered by OFL.txt.

Noto Emoji is pinned to google/fonts commit
8b0a1d0f5983c89bc2b93f1b5fb55f9e252744b5. Its license is distributed as
public/licenses/noto-emoji.txt. It provides portable monochrome PDF emoji
fallback when Android or another platform has no discoverable system fonts.

Reading, PDF export and PDF sharing use the same font family names. Imported
TTF/OTF fonts are stored privately by the app and passed to the local typesetter;
they are not automatically embedded in portable notes or uploaded anywhere.
