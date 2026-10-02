// Generate existing Phosphor glyphs, not custom icon paths. MIT license is bundled.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as icons from "@phosphor-icons/react";
import { mkdirSync, writeFileSync } from "node:fs";
const names = ["SidebarSimple", "Plus", "File", "FolderOpen", "FloppyDisk", "MagnifyingGlass", "Image", "GearSix", "Export", "ShareNetwork", "ArrowsOut", "X", "MathOperations", "CaretDown", "Check"];
mkdirSync("desktop/icons",{recursive:true});
for (const name of names) writeFileSync(`desktop/icons/${name}.svg`,renderToStaticMarkup(createElement(icons[`${name}Icon`],{weight:"regular",size:24,color:"#000000"})));
