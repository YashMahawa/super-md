// Mechanical conversion of the same pinned Material Symbols used by Qt.
// Preserve path geometry; translate Google's negative-Y viewBox into Android's.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
const names = {SidebarSimple:"sidebar",Plus:"add",File:"file",FolderOpen:"folder_open",FloppyDisk:"save",MagnifyingGlass:"search",Image:"image",GearSix:"settings",Export:"export",ShareNetwork:"share",ArrowsOut:"open_window",X:"close",Bug:"bug",CaretDown:"expand",Check:"check",Fullscreen:"fullscreen",FullscreenExit:"fullscreen_exit"};
mkdirSync("android/app/src/main/res/drawable", {recursive:true});
for (const [source, target] of Object.entries(names)) {
  const svg = readFileSync(`desktop/icons/${source}.svg`, "utf8");
  const paths = [...svg.matchAll(/<path d="([^"]+)"\s*\/?\s*>/g)];
  if (!svg.includes('viewBox="0 -960 960 960"') || !paths.length) throw Error(`Unsupported icon geometry: ${source}`);
  writeFileSync(`android/app/src/main/res/drawable/symbol_${target}.xml`, `<?xml version="1.0" encoding="utf-8"?>\n<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="24dp" android:height="24dp" android:viewportWidth="960" android:viewportHeight="960">\n  <group android:translateY="960">\n${paths.map(path => `    <path android:fillColor="#FF000000" android:pathData="${path[1]}" />`).join("\n")}\n  </group>\n</vector>\n`);
}
mkdirSync("android/app/src/main/assets/licenses", {recursive:true});
copyFileSync("desktop/licenses/Material-Symbols-Apache-2.0.txt", "android/app/src/main/assets/licenses/Material-Symbols-Apache-2.0.txt");
console.log("Android and desktop now share 17 Material Symbols Rounded (weight 600)");
