#!/usr/bin/env node
// Read-only inventory of Vite output. Candidate files are never deleted or
// excluded from packaging; dynamic/runtime-generated URLs may evade tracing.
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const entryNames = ['android-reader.html', 'qt-reader.html'];
const htmlReferences = /<(?:script|link|img|source)[^>]+?(?:src|href)=["']([^"']+)["']/gi;
const javascriptReferences = [
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\s+[\w$*{},\s]+?\sfrom\s*["']([^"']+)["']/g,
  /\bimport\{[^;]{0,500}?\}from\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bnew\s+URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g,
];
const cssReferences = /(?:url\(\s*["']?|@import\s+["'])([^"')]+)["']?\s*\)?/gi;

function localReference(value) {
  const target = value.trim();
  return target && ['../', './', '/'].some(prefix => target.startsWith(prefix))
    ? target.split(/[?#]/, 1)[0]
    : '';
}

export async function inventory(root) {
  const base = path.resolve(root);
  const files = [];
  async function walk(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, item.name);
      if (item.isDirectory()) await walk(absolute);
      else if (item.isFile()) files.push(path.relative(base, absolute).split(path.sep).join('/'));
    }
  }
  await walk(base);
  const known = new Set(files);
  const reachedByEntry = {};
  const unresolved = {};
  for (const entry of entryNames) {
    if (!known.has(entry)) throw new Error(`Missing reader entrypoint: ${entry}`);
    const reached = new Set();
    const missing = new Set();
    const pending = [entry];
    while (pending.length) {
      const relative = pending.pop();
      if (reached.has(relative)) continue;
      reached.add(relative);
      const contents = await readFile(path.join(base, relative), 'utf8');
      const extension = path.extname(relative).toLowerCase();
      const patterns = extension === '.html' ? [htmlReferences]
        : extension === '.css' ? [cssReferences]
        : /\.(?:js|mjs|cjs)$/.test(extension) ? javascriptReferences : [];
      for (const pattern of patterns) {
        pattern.lastIndex = 0;
        for (const match of contents.matchAll(pattern)) {
          const reference = localReference(match[1]);
          if (!reference) continue;
          const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), reference));
          if (known.has(resolved)) pending.push(resolved);
          else if (!resolved.startsWith('../')) missing.add(`${relative} -> ${reference}`);
        }
      }
    }
    reachedByEntry[entry] = [...reached].sort();
    unresolved[entry] = [...missing].sort();
  }
  const sizes = {};
  for (const file of files) sizes[file] = (await stat(path.join(base, file))).size;
  const readerReachable = new Set(Object.values(reachedByEntry).flat());
  return {
    warning: 'Static reachability is an inventory aid only. Dynamic URLs and runtime asset discovery can be missed; nothing is safe to prune from this report alone.',
    entries: reachedByEntry,
    unresolvedReferences: unresolved,
    files: files.sort().map(file => ({ path: file, bytes: sizes[file], readerReachable: readerReachable.has(file), extension: path.extname(file).toLowerCase() })),
    totals: {
      fileCount: files.length,
      totalBytes: Object.values(sizes).reduce((sum, size) => sum + size, 0),
      readerReachableCount: readerReachable.size,
      readerReachableBytes: [...readerReachable].reduce((sum, file) => sum + sizes[file], 0),
      readerFonts: [...readerReachable].filter(file => /\.(?:woff2?|ttf|otf)$/i.test(file)),
    },
  };
}

export async function verifyNativeResources(distRoot, publicRoot = 'public') {
  const dist = path.resolve(distRoot);
  const publicDirectory = path.resolve(publicRoot);
  const required = [
    'LICENSE.txt',
    'THEMING.md',
    'super-md-agent-SKILL.md',
    'DIAGRAM-RENDERER-LICENSES.txt',
    'WRITING-ASSISTANCE-LICENSES.txt',
  ];
  const publicFiles = [];
  async function walk(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, item.name);
      if (item.isDirectory()) await walk(absolute);
      else if (item.isFile()) publicFiles.push(path.relative(publicDirectory, absolute).split(path.sep).join('/'));
    }
  }
  await walk(publicDirectory);
  required.push(...publicFiles);
  const missing = [];
  for (const relative of required) {
    try {
      if (!(await stat(path.join(dist, relative))).isFile()) missing.push(relative);
    } catch {
      missing.push(relative);
    }
  }
  if (missing.length) throw new Error(`Native bundle is missing required resources: ${missing.join(', ')}`);
  return { checkedCount: required.length, publicFileCount: publicFiles.length, required };
}

async function main() {
  const args = process.argv.slice(2);
  const root = args[0] || 'dist';
  const outAt = args.indexOf('--output');
  const result = await inventory(root);
  if (outAt >= 0) await writeFile(args[outAt + 1], `${JSON.stringify(result, null, 2)}\n`);
  const publicAt = args.indexOf('--public-root');
  const verification = args.includes('--verify-native') ? await verifyNativeResources(root, publicAt >= 0 ? args[publicAt + 1] : 'public') : undefined;
  const { readerFonts, ...totals } = result.totals;
  const requiredResourceCheck = verification && { checkedCount: verification.checkedCount, publicFileCount: verification.publicFileCount };
  console.log(JSON.stringify({ ...totals, readerFontCount: readerFonts.length, unresolvedReferences: Object.fromEntries(Object.entries(result.unresolvedReferences).map(([entry, refs]) => [entry, refs.length])), requiredResourceCheck }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
