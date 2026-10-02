import { copyFileSync } from "node:fs";

// Desktop and Android both package dist. Copy the authoritative project
// license after bundling instead of maintaining a second notice by hand.
copyFileSync(new URL("../LICENSE", import.meta.url), new URL("../dist/LICENSE.txt", import.meta.url));
