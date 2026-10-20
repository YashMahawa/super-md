import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNativeFrontendManifest, verifyNativeFrontendManifest } from './native-frontend-artifact.mjs';

const temporaryRoots = [];
const sourceSha = 'a'.repeat(40);

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'supermd-native-artifact-'));
  temporaryRoots.push(root);
  const dist = path.join(root, 'dist');
  const lock = path.join(root, 'package-lock.json');
  const manifest = path.join(root, 'manifest.json');
  await mkdir(dist);
  await writeFile(path.join(dist, 'android-reader.html'), '<script type="module" src="assets/reader.js"></script>');
  await writeFile(path.join(dist, 'qt-reader.html'), '<script type="module" src="assets/reader.js"></script>');
  await mkdir(path.join(dist, 'assets'));
  await writeFile(path.join(dist, 'assets/reader.js'), 'export {};');
  await writeFile(lock, '{"lockfileVersion":3}\n');
  return { distRoot: dist, packageLockPath: lock, manifestPath: manifest };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it('creates and verifies an exact-source, lockfile-bound file inventory', async () => {
  const files = await fixture();
  const value = await createNativeFrontendManifest({ distRoot: files.distRoot, packageLockPath: files.packageLockPath, sourceSha });
  await writeFile(files.manifestPath, `${JSON.stringify(value)}\n`);
  assert.equal(value.sourceSha, sourceSha);
  assert.equal(value.files.length, 3);
  assert.deepEqual((await verifyNativeFrontendManifest({ ...files, expectedSourceSha: sourceSha })), {
    sourceSha,
    fileCount: 3,
  });
});

it('rejects source, package-lock, modified, missing, and unexpected files', async () => {
  const files = await fixture();
  const value = await createNativeFrontendManifest({ distRoot: files.distRoot, packageLockPath: files.packageLockPath, sourceSha });
  await writeFile(files.manifestPath, JSON.stringify(value));
  await assert.rejects(verifyNativeFrontendManifest({ ...files, expectedSourceSha: 'b'.repeat(40) }), /source mismatch/);

  await writeFile(files.packageLockPath, '{"changed":true}\n');
  await assert.rejects(verifyNativeFrontendManifest({ ...files, expectedSourceSha: sourceSha }), /package-lock identity mismatch/);
  await writeFile(files.packageLockPath, '{"lockfileVersion":3}\n');

  await writeFile(path.join(files.distRoot, 'assets/reader.js'), 'export const changed = true;');
  await assert.rejects(verifyNativeFrontendManifest({ ...files, expectedSourceSha: sourceSha }), /inventory or checksum mismatch/);
  await writeFile(path.join(files.distRoot, 'assets/reader.js'), 'export {};');
  await writeFile(path.join(files.distRoot, 'unexpected.txt'), 'unexpected');
  await assert.rejects(verifyNativeFrontendManifest({ ...files, expectedSourceSha: sourceSha }), /inventory or checksum mismatch/);
  await rm(path.join(files.distRoot, 'unexpected.txt'));
  await rm(path.join(files.distRoot, 'qt-reader.html'));
  await assert.rejects(verifyNativeFrontendManifest({ ...files, expectedSourceSha: sourceSha }), /inventory or checksum mismatch/);
});

it('rejects an incomplete manifest and source identifiers that are not full commit SHAs', async () => {
  const files = await fixture();
  await assert.rejects(createNativeFrontendManifest({ distRoot: files.distRoot, packageLockPath: files.packageLockPath, sourceSha: 'abc' }), /full 40-character/);
  const value = await createNativeFrontendManifest({ distRoot: files.distRoot, packageLockPath: files.packageLockPath, sourceSha });
  value.entrypoints = ['index.html'];
  await writeFile(files.manifestPath, JSON.stringify(value));
  await assert.rejects(verifyNativeFrontendManifest({ ...files, expectedSourceSha: sourceSha }), /entrypoint manifest mismatch/);
});
