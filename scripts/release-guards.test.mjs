import { test } from "node:test";
import { strict as assert } from "node:assert";
import { validateAssets, validateVersions, versionFromTag } from "./release-guards.mjs";
const names = ["Super-MD-0.3.0-arm64-release.apk", "Super.MD_0.3.0_amd64.AppImage", "Super.MD_0.3.0_amd64.deb", "Super.MD-0.3.0-1.x86_64.rpm", "Super.MD_0.3.0_x64-setup.exe", "Super.MD_0.3.0_aarch64.dmg", "Super.MD_0.3.0_x64.dmg"];
const assets = names.map((name) => ({ name, size: 100_000, state: "uploaded" }));
test("tags and platform versions must agree", () => {
  assert.equal(validateVersions("v0.3.0", { android: "0.3.0", desktop: "0.3.0" }), "0.3.0");
  for (const tag of ["main", "v0.3.0;evil", "v0.3.0-rc1", "../v0.3.0"]) assert.throws(() => versionFromTag(tag));
  assert.throws(() => validateVersions("v0.3.0", { android: "0.2.0" }));
});
test("publication requires every package, especially the release APK", () => {
  assert.equal(validateAssets("v0.3.0", assets), true);
  for (let i = 0; i < assets.length; i++) assert.throws(() => validateAssets("v0.3.0", assets.filter((_, index) => index !== i)));
  assert.throws(() => validateAssets("v0.3.0", [{ ...assets[0], name: "app-debug.apk" }, ...assets.slice(1)]));
  assert.throws(() => validateAssets("v0.3.0", [{ ...assets[0], state: "new" }, ...assets.slice(1)]));
  assert.throws(() => validateAssets("v0.3.0", [{ ...assets[0], size: 0 }, ...assets.slice(1)]));
  assert.throws(() => validateAssets("v0.3.0", [...assets, assets[0]]));
});
