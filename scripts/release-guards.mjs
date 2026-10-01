import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function versionFromTag(tag) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag || "")) throw new Error("Use a stable vMAJOR.MINOR.PATCH tag");
  return tag.slice(1);
}
export function validateVersions(tag, versions) {
  const version = versionFromTag(tag);
  for (const [platform, value] of Object.entries(versions)) if (value !== version) throw new Error(`${platform} version ${value} does not match ${tag}`);
  return version;
}
export function validateAssets(tag, assets) {
  const version = versionFromTag(tag);
  const roles = {
    "Android arm64 release": (name) => name === `Super-MD-${version}-arm64-release.apk`,
    "Linux AppImage": (name) => /_(?:amd64|x86_64)\.AppImage$/.test(name),
    "Linux Debian": (name) => /_amd64\.deb$/.test(name),
    "Linux RPM": (name) => /\.x86_64\.rpm$/.test(name),
    "Windows installer": (name) => /_x64-setup\.exe$/.test(name),
    "macOS Apple Silicon": (name) => /_aarch64\.dmg$/.test(name),
    "macOS Intel": (name) => /_x64\.dmg$/.test(name),
  };
  for (const [role, matches] of Object.entries(roles)) {
    const found = assets.filter((asset) => asset.name.includes(version) && matches(asset.name));
    if (found.length !== 1 || !Number.isSafeInteger(found[0].size) || found[0].size < 1000 || found[0].state !== "uploaded") throw new Error(`Missing, ambiguous or incomplete ${role} asset for ${tag}`);
  }
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, tag, input] = process.argv.slice(2);
  if (command === "versions") {
    const android = readFileSync("android/app/build.gradle.kts", "utf8");
    const rust = readFileSync("src-tauri/Cargo.toml", "utf8");
    console.log(validateVersions(tag, {
      package: JSON.parse(readFileSync("package.json", "utf8")).version,
      tauri: JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).version,
      rust: rust.match(/^version\s*=\s*"([^"]+)"/m)?.[1],
      android: android.match(/versionName\s*=\s*"([^"]+)"/)?.[1],
    }));
  } else if (command === "assets") {
    validateAssets(tag, JSON.parse(readFileSync(input, "utf8"))); console.log("All seven release packages are uploaded");
  } else throw new Error("Expected versions TAG or assets TAG ASSETS_JSON");
}
