import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPhosphorDeprecations, verifyPhosphorIcons } from './verify-phosphor-icons.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = path.join(repositoryRoot, 'scripts', 'verify-phosphor-icons.mjs');
const temporaryRoots = [];

function posixPath(...segments) {
  return path.join(...segments).split(path.sep).join('/');
}

async function createFixture(sourceText) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'supermd-phosphor-guard-'));
  temporaryRoots.push(root);
  const sourcePath = path.join(root, 'fixture.tsx');
  const tsconfigPath = path.join(root, 'tsconfig.json');
  await writeFile(sourcePath, sourceText, 'utf8');
  await writeFile(
    tsconfigPath,
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          lib: ['ES2022', 'DOM', 'DOM.Iterable'],
          module: 'ESNext',
          moduleResolution: 'Bundler',
          jsx: 'react-jsx',
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          types: [],
          paths: {
            '@phosphor-icons/react': [posixPath(repositoryRoot, 'node_modules/@phosphor-icons/react/dist/index.d.ts')],
            '@phosphor-icons/react/*': [posixPath(repositoryRoot, 'node_modules/@phosphor-icons/react/*')],
            react: [posixPath(repositoryRoot, 'node_modules/@types/react/index.d.ts')],
            'react/jsx-runtime': [posixPath(repositoryRoot, 'node_modules/@types/react/jsx-runtime.d.ts')],
          },
        },
        files: ['fixture.tsx'],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return { root, tsconfigPath };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it('verifies zero deprecated Phosphor icon diagnostics across the frontend project', () => {
  const result = verifyPhosphorIcons({
    tsconfigPath: path.join(repositoryRoot, 'tsconfig.json'),
    basePath: repositoryRoot,
  });
  assert.ok(result.checkedFileCount > 0);
  assert.deepEqual(result.findings, []);
});

it('allows supported *Icon exports alongside non-icon deprecated DOM and React APIs', async () => {
  const { root, tsconfigPath } = await createFixture([
    'import { type FormEvent } from "react";',
    'import { ArrowLeftIcon, FunctionIcon, IconContext, type Icon } from "@phosphor-icons/react";',
    '/** @deprecated Local helper deprecation out of scope */',
    'function legacyHelper(icon: Icon) { return icon; }',
    'export function Sample(event?: FormEvent) {',
    '  const range = document.caretRangeFromPoint?.(0, 0);',
    '  void event; void range; void IconContext;',
    '  const Chosen = legacyHelper(FunctionIcon);',
    '  return <><ArrowLeftIcon size={18} /><Chosen size={18} /></>;',
    '}',
    '',
  ].join('\n'));

  const result = verifyPhosphorIcons({ tsconfigPath, basePath: root });
  assert.equal(result.checkedFileCount, 1);
  assert.deepEqual(result.findings, []);
});

it('rejects bare named, unused, aliased, type-only, namespace, destructured, and re-exported deprecated icons', async () => {
  const { root, tsconfigPath } = await createFixture([
    'import { ArrowLeft, BookOpen, Function as FunctionIcon, type Sparkle } from "@phosphor-icons/react";',
    'import * as Icons from "@phosphor-icons/react";',
    'export { CaretDown } from "@phosphor-icons/react";',
    'export type DeprecatedIconType = typeof Sparkle;',
    'const { FilePdf: PdfAlias } = Icons;',
    'export function BrokenView() {',
    '  void BookOpen;',
    '  return <><ArrowLeft size={18} /><FunctionIcon size={18} /><Icons.X size={16} /><PdfAlias size={16} /></>;',
    '}',
    '',
  ].join('\n'));

  const { findings } = findPhosphorDeprecations({ tsconfigPath, basePath: root });
  const messages = findings.map((item) => item.message);
  assert.ok(messages.some((msg) => msg.includes("'ArrowLeft' is deprecated.")));
  assert.ok(messages.some((msg) => msg.includes("'BookOpen' is deprecated.")));
  assert.ok(messages.some((msg) => msg.includes("'Function' is deprecated.")));
  assert.ok(messages.some((msg) => msg.includes("'FunctionIcon' is deprecated.")));
  assert.ok(messages.some((msg) => msg.includes("'Sparkle' is deprecated.")));
  assert.ok(messages.some((msg) => msg.includes("'CaretDown' is deprecated.")));
  assert.ok(messages.some((msg) => msg.includes("'FilePdf' is deprecated.")));
  assert.ok(messages.some((msg) => msg.includes("'X' is deprecated.")));

  assert.throws(() => verifyPhosphorIcons({ tsconfigPath, basePath: root }), /deprecated @phosphor-icons\/react/);

  const cli = spawnSync(process.execPath, [scriptPath, tsconfigPath], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /fixture\.tsx:1:10 - error TS6385: 'ArrowLeft' is deprecated\./);
  assert.match(cli.stderr, /supported \*Icon export/);
});

it('fails with a non-zero exit code even when a deprecated bare icon is only imported and not yet referenced', async () => {
  const { root, tsconfigPath } = await createFixture(
    'import { FolderOpen } from "@phosphor-icons/react";\nexport const ready = true;\n',
  );
  const cli = spawnSync(process.execPath, [scriptPath, tsconfigPath], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /'FolderOpen' is deprecated\./);
});
