import { copyFileSync,readFileSync,writeFileSync } from "node:fs";

// Desktop and Android both package dist. Copy the authoritative project
// license after bundling instead of maintaining a second notice by hand.
copyFileSync(new URL("../LICENSE", import.meta.url), new URL("../dist/LICENSE.txt", import.meta.url));
// Ship the complete notices with the offline dictionary and grammar libraries.
const dependencies=["dictionary-en","nspell","retext-repeated-words","retext-indefinite-article"];
const notices=dependencies.map(name=>`${name}\n${readFileSync(new URL(`../node_modules/${name}/license`,import.meta.url),"utf8")}`).join("\n\n");
writeFileSync(new URL("../dist/WRITING-ASSISTANCE-LICENSES.txt",import.meta.url),notices+"\n\nretext-english\n"+readFileSync(new URL("../desktop/licenses/retext-english-MIT.txt",import.meta.url),"utf8"));
