#!/usr/bin/env node
// Portably discovers and runs all standalone Node (*.test.mjs) suites under
// scripts/ without relying on shell glob expansion or Node CLI glob support.
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));

export function discoverNodeScriptTests(rootDir = DEFAULT_SCRIPTS_DIR) {
  const base = path.resolve(rootDir);
  const discovered = [];

  function walk(directory) {
    const entries = readdirSync(directory, { withFileTypes: true })
      .slice()
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.test.mjs')) {
        discovered.push(fullPath);
      }
    }
  }

  walk(base);
  discovered.sort((left, right) => {
    const leftRel = path.relative(base, left).split(path.sep).join('/');
    const rightRel = path.relative(base, right).split(path.sep).join('/');
    return leftRel < rightRel ? -1 : leftRel > rightRel ? 1 : 0;
  });

  if (discovered.length === 0) {
    throw new Error(`No standalone Node *.test.mjs suites found under ${base}`);
  }
  return discovered;
}

export function runNodeScriptTests({
  rootDir = DEFAULT_SCRIPTS_DIR,
  execPath = process.execPath,
  spawn = nodeSpawnSync,
} = {}) {
  const files = discoverNodeScriptTests(rootDir);
  const result = spawn(execPath, ['--test', ...files], { stdio: 'inherit' });
  if (result.error) throw result.error;
  const exitCode = typeof result.status === 'number' ? result.status : 1;
  return { files, exitCode, signal: result.signal ?? null };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { exitCode } = runNodeScriptTests({
      rootDir: process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_SCRIPTS_DIR,
    });
    process.exitCode = exitCode;
  } catch (error) {
    console.error(error?.stack ?? String(error));
    process.exitCode = 1;
  }
}
