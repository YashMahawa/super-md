// Import official Material Symbols Rounded. Pinned source and Apache-2.0 are
// bundled; no font download or network access is required by the installed app.
import { mkdirSync, writeFileSync } from "node:fs";
const commit = "737e3324305806514d7909874fa1818ae1808232";
const names = {SidebarSimple:"side_navigation", Plus:"add", File:"description",
  FolderOpen:"folder_open", FloppyDisk:"save", MagnifyingGlass:"search",
  Image:"image", GearSix:"settings", Export:"ios_share", ShareNetwork:"share",
  ArrowsOut:"open_in_full", X:"close", Bug:"bug_report", Undo:"undo", Redo:"redo",
  CaretDown:"expand_more", Check:"check", Fullscreen:"fullscreen", FullscreenExit:"fullscreen_exit"};
mkdirSync("desktop/icons",{recursive:true});
for (const [name, symbol] of Object.entries(names)) {
  const url = `https://raw.githubusercontent.com/google/material-design-icons/${commit}/symbols/web/${symbol}/materialsymbolsrounded/${symbol}_wght600_24px.svg`;
  const response = await fetch(url);
  if (!response.ok) throw Error(`Official icon download failed: ${symbol} (${response.status})`);
  const svg = await response.text();
  if (!svg.startsWith("<svg ") || !svg.includes('viewBox="0 -960 960 960"')) throw Error(`Invalid SVG: ${symbol}`);
  writeFileSync(`desktop/icons/${name}.svg`, svg);
  console.log(`${name}: Material Symbols Rounded, weight 600`);
}
