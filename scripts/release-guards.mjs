import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RELEASES_BASE = "https://github.com/YashMahawa/super-md/releases";
const ALLOWED_LATEST_RELEASE_URLS = new Set([
  RELEASES_BASE,
  `${RELEASES_BASE}/latest`,
  `${RELEASES_BASE}/latest/download/SHA256SUMS`,
]);
const DEFAULT_ALLOWED_PINNED_RELEASE_URLS = new Set([
  `${RELEASES_BASE}/download/v0.5.1/super-md-demo.mp4`,
]);

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

function extractRepoReleaseUrls(text) {
  const urls = [];
  for (const match of text.matchAll(/https?:\/\/github\.com\/YashMahawa\/super-md\/releases(?:\/[^\s)"'>`]*)?/gi)) {
    urls.push(match[0].replace(/[.,;:]+$/, ""));
  }
  return urls;
}

export function validateReadmeReleaseLinks(markdown, { allowedPinnedUrls = DEFAULT_ALLOWED_PINNED_RELEASE_URLS } = {}) {
  if (typeof markdown !== "string" || markdown.length === 0) {
    throw new Error("README content must be a non-empty string");
  }
  const relativeMatch = /(?:href\s*=\s*["']|\]\(\s*<?)((?:\/YashMahawa\/super-md)?\/?(?:\.\.\/)*releases(?:\/[^\s)"'>`]*)?)/i.exec(markdown);
  if (relativeMatch) {
    throw new Error(`Use canonical latest GitHub Release URL instead of relative release link: ${relativeMatch[1]}`);
  }
  const allowedPinned = new Set(allowedPinnedUrls);
  for (const url of extractRepoReleaseUrls(markdown)) {
    if (!ALLOWED_LATEST_RELEASE_URLS.has(url) && !allowedPinned.has(url)) {
      throw new Error(`Stale or unsupported hardcoded GitHub Release URL in README: ${url}`);
    }
  }
  const headingMatch = /^## Download[ \t]*\r?$/m.exec(markdown);
  if (!headingMatch) {
    throw new Error("README.md is missing the ## Download section");
  }
  const afterHeading = markdown.slice(headingMatch.index + headingMatch[0].length);
  const nextHeading = /^## [^\r\n]+/m.exec(afterHeading);
  const downloadSection = nextHeading ? afterHeading.slice(0, nextHeading.index) : afterHeading;
  const downloadUrls = extractRepoReleaseUrls(downloadSection);
  if (!downloadUrls.includes(`${RELEASES_BASE}/latest`)) {
    throw new Error("README ## Download section must route downloads through https://github.com/YashMahawa/super-md/releases/latest");
  }
  for (const url of downloadUrls) {
    if (!ALLOWED_LATEST_RELEASE_URLS.has(url)) {
      throw new Error(`README ## Download section must not pin a release tag or asset URL: ${url}`);
    }
  }
  const versionMatch = /(?:^|[^0-9.])(v?\d+\.\d+\.\d+)(?![0-9.])/m.exec(downloadSection);
  if (versionMatch) {
    throw new Error(`README ## Download section must not hardcode release version ${versionMatch[1]}`);
  }
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, tag, input] = process.argv.slice(2);
  if (command === "versions") {
    const android = readFileSync("android/app/build.gradle.kts", "utf8");
    const rust = readFileSync("src-tauri/Cargo.toml", "utf8");
    validateReadmeReleaseLinks(readFileSync("README.md", "utf8"));
    console.log(validateVersions(tag, {
      package: JSON.parse(readFileSync("package.json", "utf8")).version,
      tauri: JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).version,
      rust: rust.match(/^version\s*=\s*"([^"]+)"/m)?.[1],
      android: android.match(/versionName\s*=\s*"([^"]+)"/)?.[1],
    }));
  } else if (command === "assets") {
    validateAssets(tag, JSON.parse(readFileSync(input, "utf8"))); console.log("All seven release packages are uploaded");
  } else if (command === "readme") {
    validateReadmeReleaseLinks(readFileSync(tag || "README.md", "utf8")); console.log("README release links route through latest release");
  } else throw new Error("Expected versions TAG, assets TAG ASSETS_JSON, or readme [README_MD]");
}
