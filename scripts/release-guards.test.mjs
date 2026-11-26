import { readFileSync } from "node:fs";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  validateAssets,
  validateReadmeReleaseLinks,
  validateVersions,
  versionFromTag,
} from "./release-guards.mjs";
const names = ["Super-MD-0.3.0-arm64-release.apk", "Super.MD_0.3.0_amd64.AppImage", "Super.MD_0.3.0_amd64.deb", "Super.MD-0.3.0-1.x86_64.rpm", "Super.MD_0.3.0_x64-setup.exe", "Super.MD_0.3.0_aarch64.dmg", "Super.MD_0.3.0_x64.dmg"];
const assets = names.map((name) => ({ name, size: 100_000, state: "uploaded" }));
test("tags and platform versions must agree", () => {
  assert.equal(validateVersions("v0.3.0", { android: "0.3.0", desktop: "0.3.0" }), "0.3.0");
  for (const tag of ["main", "v0.3.0;evil", "v0.3.0-rc1", "../v0.3.0"]) assert.throws(() => versionFromTag(tag));
  assert.throws(() => validateVersions("v0.3.0", { android: "0.2.0" }));
});
test("publication requires all seven supported packages, especially the release APK", () => {
  assert.equal(validateAssets("v0.3.0", assets), true);
  for (let i = 0; i < assets.length; i++) assert.throws(() => validateAssets("v0.3.0", assets.filter((_, index) => index !== i)));
  assert.throws(() => validateAssets("v0.3.0", [{ ...assets[0], name: "app-debug.apk" }, ...assets.slice(1)]));
  assert.throws(() => validateAssets("v0.3.0", [{ ...assets[0], state: "new" }, ...assets.slice(1)]));
  assert.throws(() => validateAssets("v0.3.0", [{ ...assets[0], size: 0 }, ...assets.slice(1)]));
  assert.throws(() => validateAssets("v0.3.0", [...assets, assets[0]]));
});
test("repository README routes installer downloads through the latest GitHub Release without stale hardcoded tags", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.equal(validateReadmeReleaseLinks(readme), true);
});
test("validateReadmeReleaseLinks rejects stale hardcoded release tags, versioned binary links, and invalid latest-download paths", () => {
  const valid = [
    "# Super MD",
    "[Walkthrough](https://github.com/YashMahawa/super-md/releases/download/v0.5.1/super-md-demo.mp4)",
    "## Download",
    "Get installers from the [latest GitHub Release](https://github.com/YashMahawa/super-md/releases/latest).",
    "Checksums: [SHA256SUMS](https://github.com/YashMahawa/super-md/releases/latest/download/SHA256SUMS).",
  ].join("\n");
  assert.equal(validateReadmeReleaseLinks(valid), true);
  assert.equal(validateReadmeReleaseLinks(valid.replace(/\n/g, "\r\n")), true);

  assert.throws(
    () =>
      validateReadmeReleaseLinks(
        valid.replace(
          "https://github.com/YashMahawa/super-md/releases/latest",
          "https://github.com/YashMahawa/super-md/releases/tag/v0.6.6",
        ),
      ),
    /Stale or unsupported hardcoded GitHub Release URL/,
  );
  assert.throws(
    () =>
      validateReadmeReleaseLinks(
        `${valid}\n| Linux | [AppImage](https://github.com/YashMahawa/super-md/releases/download/v0.6.6/Super-MD_0.6.6_amd64.AppImage) |`,
      ),
    /Stale or unsupported hardcoded GitHub Release URL/,
  );
  assert.throws(
    () =>
      validateReadmeReleaseLinks(
        `${valid}\n| Linux | [AppImage](https://github.com/YashMahawa/super-md/releases/latest/download/Super-MD_amd64.AppImage) |`,
      ),
    /Stale or unsupported hardcoded GitHub Release URL/,
  );
  assert.throws(
    () =>
      validateReadmeReleaseLinks(
        `${valid}\n| Windows | [Installer](/YashMahawa/super-md/releases/download/v0.6.6/Super-MD_0.6.6_x64-setup.exe) |`,
      ),
    /relative release link/,
  );
  assert.throws(
    () => validateReadmeReleaseLinks(`${valid}\nGet **Super MD 0.6.6** now.`),
    /must not hardcode release version 0\.6\.6/,
  );
  assert.throws(
    () => validateReadmeReleaseLinks(`${valid}\n\`Super-MD_0.6.34_amd64.AppImage\``),
    /must not hardcode release version 0\.6\.34/,
  );
  assert.throws(
    () =>
      validateReadmeReleaseLinks(
        "# Super MD\n## Download\nSee [checksums](https://github.com/YashMahawa/super-md/releases/latest/download/SHA256SUMS).",
      ),
    /must route downloads through https:\/\/github\.com\/YashMahawa\/super-md\/releases\/latest/,
  );
  assert.throws(
    () =>
      validateReadmeReleaseLinks(
        `${valid}\n[Walkthrough](https://github.com/YashMahawa/super-md/releases/download/v0.5.1/super-md-demo.mp4)`,
      ),
    /must not pin a release tag or asset URL/,
  );
});
