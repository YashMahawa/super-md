#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

export const NATIVE_FRONTEND_MODE = 'native';
export const NATIVE_FRONTEND_ENTRIES = ['android-reader.html', 'qt-reader.html'];

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function inventoryFiles(root) {
  const base = path.resolve(root);
  const files = [];
  async function walk(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, item.name);
      if (item.isSymbolicLink()) throw new Error(`Unexpected symbolic link in frontend artifact: ${path.relative(base, absolute)}`);
      if (item.isDirectory()) {
        await walk(absolute);
      } else if (item.isFile()) {
        const relative = path.relative(base, absolute).split(path.sep).join('/');
        const details = await lstat(absolute);
        files.push({ path: relative, bytes: details.size, sha256: await hashFile(absolute) });
      } else {
        throw new Error(`Unsupported frontend artifact entry: ${path.relative(base, absolute)}`);
      }
    }
  }
  await walk(base);
  return files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

async function hashLockfile(packageLockPath) {
  return hashFile(path.resolve(packageLockPath));
}

function validCommitSha(value) {
  return typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);
}

export async function createNativeFrontendManifest({ distRoot, packageLockPath, sourceSha }) {
  if (!validCommitSha(sourceSha)) throw new Error('Expected a full 40-character source commit SHA');
  const files = await inventoryFiles(distRoot);
  for (const entry of NATIVE_FRONTEND_ENTRIES) {
    if (!files.some(file => file.path === entry)) throw new Error(`Native frontend artifact is missing entrypoint ${entry}`);
  }
  return {
    schemaVersion: 1,
    sourceSha: sourceSha.toLowerCase(),
    packageLockSha256: await hashLockfile(packageLockPath),
    buildMode: NATIVE_FRONTEND_MODE,
    entrypoints: NATIVE_FRONTEND_ENTRIES,
    files,
  };
}

export async function verifyNativeFrontendManifest({ distRoot, packageLockPath, manifestPath, expectedSourceSha }) {
  if (!validCommitSha(expectedSourceSha)) throw new Error('Expected a full 40-character checkout SHA');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const expectedKeys = ['buildMode', 'entrypoints', 'files', 'packageLockSha256', 'schemaVersion', 'sourceSha'];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
      || JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error('Native frontend artifact manifest fields are incomplete or unexpected');
  }
  if (manifest?.schemaVersion !== 1 || manifest?.buildMode !== NATIVE_FRONTEND_MODE) {
    throw new Error('Unsupported native frontend artifact manifest');
  }
  if (manifest.sourceSha !== expectedSourceSha.toLowerCase()) {
    throw new Error(`Native frontend source mismatch: artifact ${manifest.sourceSha}, checkout ${expectedSourceSha}`);
  }
  if (manifest.packageLockSha256 !== await hashLockfile(packageLockPath)) {
    throw new Error('Native frontend package-lock identity mismatch');
  }
  if (JSON.stringify(manifest.entrypoints) !== JSON.stringify(NATIVE_FRONTEND_ENTRIES)) {
    throw new Error('Native frontend entrypoint manifest mismatch');
  }
  const actualFiles = await inventoryFiles(distRoot);
  if (JSON.stringify(manifest.files) !== JSON.stringify(actualFiles)) {
    throw new Error('Native frontend artifact file inventory or checksum mismatch');
  }
  for (const entry of NATIVE_FRONTEND_ENTRIES) {
    if (!actualFiles.some(file => file.path === entry)) throw new Error(`Native frontend artifact is missing entrypoint ${entry}`);
  }
  return { sourceSha: manifest.sourceSha, fileCount: actualFiles.length };
}

async function main() {
  const [operation, distRoot = 'dist', manifestPath, expectedSha] = process.argv.slice(2);
  if (!['create', 'verify'].includes(operation) || !manifestPath) {
    throw new Error('Usage: native-frontend-artifact.mjs create <dist> <manifest> | verify <dist> <manifest> [expected-sha]');
  }
  const sourceSha = expectedSha || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (operation === 'create') {
    const manifest = await createNativeFrontendManifest({ distRoot, packageLockPath: 'package-lock.json', sourceSha });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    console.log(`native_frontend_manifest_created source=${manifest.sourceSha} files=${manifest.files.length}`);
    return;
  }
  const result = await verifyNativeFrontendManifest({ distRoot, packageLockPath: 'package-lock.json', manifestPath, expectedSourceSha: sourceSha });
  console.log(`native_frontend_manifest_verified source=${result.sourceSha} files=${result.fileCount}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
