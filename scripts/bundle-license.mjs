import "./package-skill.mjs";
import { copyFileSync,readFileSync,writeFileSync } from "node:fs";

// Desktop and Android both package dist. Copy the authoritative project
// license after bundling instead of maintaining a second notice by hand.
copyFileSync(new URL("../LICENSE", import.meta.url), new URL("../dist/LICENSE.txt", import.meta.url));
copyFileSync(new URL("../docs/THEMING.md", import.meta.url), new URL("../dist/THEMING.md", import.meta.url));
const skillDir = new URL("../docs/skills/super-md/", import.meta.url);
const bundledSkill = readFileSync(new URL("SKILL.md", skillDir), "utf8")
  .trimEnd()
  .replaceAll("(references/study-notes.md)", "(#exam-ready-study-notes)")
  .replaceAll("(references/visual-authoring.md)", "(#diagram-and-interaction-guide)")
  .replaceAll("(references/agent-connection.md)", "(#agent-connection)")
  + "\n\n" + readFileSync(new URL("references/study-notes.md", skillDir), "utf8").trim()
  + "\n\n" + readFileSync(new URL("references/visual-authoring.md", skillDir), "utf8").trim()
  + "\n\n# Agent connection\n\n" + readFileSync(new URL("references/agent-connection.md", skillDir), "utf8").trim()
  + "\n";
writeFileSync(new URL("../dist/super-md-agent-SKILL.md", import.meta.url), bundledSkill);
// Preserve Pele's complete MIT and embedded Lucide ISC notices offline.
copyFileSync(new URL('../node_modules/pele/LICENSE',import.meta.url),new URL('../dist/DIAGRAM-RENDERER-LICENSES.txt',import.meta.url));
// Ship the complete notices with the offline dictionary and grammar libraries.
const dependencies=["dictionary-en","nspell","retext-repeated-words","retext-indefinite-article"];
const notices=dependencies.map(name=>`${name}\n${readFileSync(new URL(`../node_modules/${name}/license`,import.meta.url),"utf8")}`).join("\n\n");
writeFileSync(new URL("../dist/WRITING-ASSISTANCE-LICENSES.txt",import.meta.url),notices+"\n\nretext-english\n"+readFileSync(new URL("../desktop/licenses/retext-english-MIT.txt",import.meta.url),"utf8"));
