#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [candidatePath] = process.argv.slice(2);
if (!candidatePath) throw new Error('Pass the absolute path to the installed tsc-ts launcher');
const baselinePath = path.join(repository, 'node_modules', 'typescript', 'bin', 'tsc');
const candidate = path.resolve(candidatePath);

function run(compilerPath, args, cwd) {
  const result = spawnSync(process.execPath, [compilerPath, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout.replace(/\r\n/g, '\n'),
    stderr: result.stderr.replace(/\r\n/g, '\n'),
  };
}

const baselineBuild = run(baselinePath, ['-b', '--pretty', 'false'], repository);
const candidateBuild = run(candidate, ['-b', '--pretty', 'false'], repository);
assert.equal(baselineBuild.status, 0, `TypeScript 5.9 baseline failed:\n${baselineBuild.stdout}${baselineBuild.stderr}`);
assert.equal(candidateBuild.status, 0, `tsc-ts project build failed:\n${candidateBuild.stdout}${candidateBuild.stderr}`);
assert.equal(candidateBuild.stdout, baselineBuild.stdout, 'Project build output differs from TypeScript 5.9');
assert.equal(candidateBuild.stderr, baselineBuild.stderr, 'Project build diagnostics differ from TypeScript 5.9');

const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'supermd-tsc-ts-canary-'));
try {
  await writeFile(path.join(fixtureRoot, 'broken.ts'), [
    'interface User { id: number }',
    "const user: User = { id: 'wrong' };",
    "import { absent } from './missing-module.js';",
    'export const value: number = absent;',
    '',
  ].join('\n'));
  await writeFile(path.join(fixtureRoot, 'tsconfig.json'), `${JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      skipLibCheck: true,
      types: [],
    },
    files: ['broken.ts'],
  }, null, 2)}\n`);
  const baselineDiagnostics = run(baselinePath, ['-p', 'tsconfig.json', '--pretty', 'false'], fixtureRoot);
  const candidateDiagnostics = run(candidate, ['-p', 'tsconfig.json', '--pretty', 'false'], fixtureRoot);
  assert.notEqual(baselineDiagnostics.status, 0, 'Negative fixture unexpectedly passed on TypeScript 5.9');
  assert.notEqual(candidateDiagnostics.status, 0, 'Negative fixture unexpectedly passed on tsc-ts');
  assert.equal(candidateDiagnostics.stdout, baselineDiagnostics.stdout, 'Negative fixture diagnostics differ from TypeScript 5.9');
  assert.equal(candidateDiagnostics.stderr, baselineDiagnostics.stderr, 'Negative fixture stderr differs from TypeScript 5.9');
  assert.match(candidateDiagnostics.stdout, /error TS2322:/);
  assert.match(candidateDiagnostics.stdout, /error TS2307:/);
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

console.log('tsc-ts canary matches TypeScript 5.9 project success and representative diagnostics');
