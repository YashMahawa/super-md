import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { discoverNodeScriptTests, runNodeScriptTests } from './run-node-tests.mjs';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, '..');

test('discovers every standalone scripts/*.test.mjs suite including report-web-assets.test.mjs in deterministic order', () => {
  const discovered = discoverNodeScriptTests(scriptsDir).map(file =>
    path.relative(scriptsDir, file).split(path.sep).join('/'),
  );
  const expected = [
    'benchmark-document-analysis.test.mjs',
    'benchmark-installed-reader.test.mjs',
    'measure-command.test.mjs',
    'native-frontend-artifact.test.mjs',
    'release-guards.test.mjs',
    'report-web-assets.test.mjs',
    'run-node-tests.test.mjs',
    'verify-phosphor-icons.test.mjs',
    'wait-native-frontend-artifacts.test.mjs',
  ];
  for (const suite of expected) {
    assert.ok(discovered.includes(suite), `Expected ${suite} to be discovered, got ${discovered.join(', ')}`);
  }
  assert.deepEqual(discovered, [...discovered].sort());
});

test('walks nested directories, skips node_modules and hidden directories, and fails closed when empty', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'supermd-node-test-discovery-'));
  try {
    assert.throws(() => discoverNodeScriptTests(root), /No standalone Node \*\.test\.mjs suites found/);

    await mkdir(path.join(root, 'nested'), { recursive: true });
    await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    await mkdir(path.join(root, '.hidden'), { recursive: true });
    await writeFile(path.join(root, 'helper.mjs'), 'export const x = 1;\n');
    await writeFile(path.join(root, 'zeta.test.mjs'), '');
    await writeFile(path.join(root, 'nested', 'alpha.test.mjs'), '');
    await writeFile(path.join(root, 'node_modules', 'pkg', 'ignored.test.mjs'), '');
    await writeFile(path.join(root, '.hidden', 'secret.test.mjs'), '');

    const relative = discoverNodeScriptTests(root).map(file =>
      path.relative(root, file).split(path.sep).join('/'),
    );
    assert.deepEqual(relative, ['nested/alpha.test.mjs', 'zeta.test.mjs']);

    const calls = [];
    const outcome = runNodeScriptTests({
      rootDir: root,
      execPath: '/custom/node',
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0, signal: null };
      },
    });
    assert.equal(outcome.exitCode, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, '/custom/node');
    assert.equal(calls[0].args[0], '--test');
    assert.equal(calls[0].args.length, 3);
    assert.equal(Boolean(calls[0].options.shell), false);

    const failed = runNodeScriptTests({
      rootDir: root,
      spawn: () => ({ status: null, signal: 'SIGTERM' }),
    });
    assert.equal(failed.exitCode, 1);
    assert.equal(failed.signal, 'SIGTERM');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('package.json default test targets shipping smd-core manifest and CI preserves artifact, release, and pixel gates', async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.test, /\bvitest run\b/);
  assert.match(pkg.scripts.test, /cargo test --manifest-path smd-core\/Cargo\.toml/);
  assert.doesNotMatch(pkg.scripts.test, /src-tauri/);
  assert.equal(pkg.scripts['test:scripts'], 'node scripts/run-node-tests.mjs');

  const ci = await readFile(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(ci, /run:\s*npm run test:scripts/);
  assert.match(ci, /run:\s*npm test\b/);
  // Exact-source artifact, release, and presented-pixel gates remain intact.
  assert.match(ci, /\n  test:\n    needs: native_frontend\n/);
  assert.match(ci, /native-frontend-artifact\.mjs create dist/);
  assert.match(ci, /native-frontend-artifact\.mjs verify dist/);
  assert.match(ci, /report-web-assets\.mjs dist --verify-native --public-root public/);
  assert.match(ci, /check_packaged\.py "\$binary" "\$version" --graphics software/);
  assert.match(ci, /:app:connectedDebugAndroidTest/);
  assert.match(ci, /name:\s*All release tests passed/);
});
