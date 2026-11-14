import "./package-skill.mjs";
import { copyFileSync,readFileSync,writeFileSync } from "node:fs";

// Desktop and Android both package dist. Copy the authoritative project
// license after bundling instead of maintaining a second notice by hand.
copyFileSync(new URL("../LICENSE", import.meta.url), new URL("../dist/LICENSE.txt", import.meta.url));
copyFileSync(new URL("../docs/THEMING.md", import.meta.url), new URL("../dist/THEMING.md", import.meta.url));
writeFileSync(new URL("../dist/super-md-agent-SKILL.md", import.meta.url), "# Super MD agent guide\n\nFor illustrated study-note authoring, install the complete super-md-skill.zip beside this file, or copy docs/skills/super-md from the project repository. The following is the connection guide, not the complete authoring skill.\n\n" + readFileSync(new URL("../docs/skills/super-md/references/agent-connection.md", import.meta.url), "utf8"));
// Preserve Pele's complete MIT and embedded Lucide ISC notices offline.
copyFileSync(new URL('../node_modules/pele/LICENSE',import.meta.url),new URL('../dist/DIAGRAM-RENDERER-LICENSES.txt',import.meta.url));
// Ship the complete notices with the offline dictionary and grammar libraries.
const dependencies=["dictionary-en","nspell","retext-repeated-words","retext-indefinite-article"];
const notices=dependencies.map(name=>`${name}\n${readFileSync(new URL(`../node_modules/${name}/license`,import.meta.url),"utf8")}`).join("\n\n");
writeFileSync(new URL("../dist/WRITING-ASSISTANCE-LICENSES.txt",import.meta.url),notices+"\n\nretext-english\n"+readFileSync(new URL("../desktop/licenses/retext-english-MIT.txt",import.meta.url),"utf8"));
