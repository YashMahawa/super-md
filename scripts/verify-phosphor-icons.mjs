#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const defaultRepositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function createFormatHost(basePath) {
  return {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => basePath,
    getNewLine: () => '\n',
  };
}

function normalizeSlashes(filePath) {
  return filePath.split(path.sep).join('/').replace(/\\/g, '/');
}

function findNodeAtPosition(node, position, sourceFile) {
  let match = node;
  node.forEachChild((child) => {
    if (child.getStart(sourceFile) <= position && position < child.getEnd()) {
      match = findNodeAtPosition(child, position, sourceFile);
    }
  });
  return match;
}

function bindingElementTargetSymbol(bindingElement, checker) {
  if (!ts.isObjectBindingPattern(bindingElement.parent)) return undefined;
  const propertyNode = bindingElement.propertyName ?? bindingElement.name;
  if (!ts.isIdentifier(propertyNode) && !ts.isStringLiteralLike(propertyNode)) return undefined;
  return checker.getTypeAtLocation(bindingElement.parent).getProperty(propertyNode.text);
}

function resolveTargetDeclarations(symbol, checker) {
  const declarations = new Set();
  const visited = new Set();
  const queue = symbol ? [symbol] : [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);

    for (const decl of current.declarations ?? []) {
      if (ts.isBindingElement(decl)) {
        const bound = bindingElementTargetSymbol(decl, checker);
        if (bound && !visited.has(bound)) queue.push(bound);
        continue;
      }
      if (
        ts.isImportSpecifier(decl) ||
        ts.isImportClause(decl) ||
        ts.isNamespaceImport(decl) ||
        ts.isExportSpecifier(decl)
      ) {
        continue;
      }
      declarations.add(decl);
    }

    if (current.flags & ts.SymbolFlags.Alias) {
      try {
        const aliased = checker.getAliasedSymbol(current);
        if (aliased && !visited.has(aliased)) queue.push(aliased);
      } catch {
        // Ignore unresolvable alias symbols; pre-emit diagnostics catch broken imports.
      }
    }
  }

  return [...declarations];
}

function isPhosphorDeclaration(declaration) {
  return normalizeSlashes(declaration.getSourceFile().fileName).includes('/@phosphor-icons/');
}

function resolveSymbolForDiagnosticNode(node, checker) {
  if (ts.isImportSpecifier(node)) {
    return checker.getSymbolAtLocation(node.propertyName ?? node.name);
  }
  if (node.parent && ts.isImportSpecifier(node.parent)) {
    return checker.getSymbolAtLocation(node.parent.propertyName ?? node.parent.name);
  }
  if (ts.isExportSpecifier(node)) {
    return checker.getExportSpecifierLocalTargetSymbol(node) ?? checker.getSymbolAtLocation(node.propertyName ?? node.name);
  }
  if (node.parent && ts.isExportSpecifier(node.parent)) {
    return checker.getExportSpecifierLocalTargetSymbol(node.parent) ?? checker.getSymbolAtLocation(node.parent.propertyName ?? node.parent.name);
  }
  if (node.parent && ts.isBindingElement(node.parent)) {
    return bindingElementTargetSymbol(node.parent, checker) ?? checker.getSymbolAtLocation(node);
  }
  return checker.getSymbolAtLocation(node);
}

function loadParsedConfigs(entryConfigPath, basePath, visited = new Set()) {
  const resolvedPath = path.resolve(basePath, entryConfigPath);
  const canonicalKey = normalizeSlashes(resolvedPath);
  if (visited.has(canonicalKey)) return [];
  visited.add(canonicalKey);

  const formatHost = createFormatHost(basePath);
  const configFile = ts.readConfigFile(resolvedPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(ts.formatDiagnostics([configFile.error], formatHost).trim());
  }

  const configDir = path.dirname(resolvedPath);
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, configDir, undefined, resolvedPath);
  if (parsed.errors.length > 0) {
    throw new Error(ts.formatDiagnostics(parsed.errors, formatHost).trim());
  }

  const configs = [];
  if (parsed.fileNames.length > 0) {
    configs.push({ configPath: resolvedPath, parsed });
  }
  for (const reference of parsed.projectReferences ?? []) {
    const referenceConfigPath = ts.resolveProjectReferencePath(reference);
    configs.push(...loadParsedConfigs(referenceConfigPath, configDir, visited));
  }
  return configs;
}

export function findPhosphorDeprecations({
  tsconfigPath = path.join(defaultRepositoryRoot, 'tsconfig.json'),
  basePath = defaultRepositoryRoot,
} = {}) {
  const resolvedBase = path.resolve(basePath);
  const formatHost = createFormatHost(resolvedBase);
  const configs = loadParsedConfigs(tsconfigPath, resolvedBase);
  if (configs.length === 0) {
    throw new Error(`No TypeScript source files matched by ${tsconfigPath}`);
  }

  const findings = [];
  const seenLocations = new Set();
  let checkedFileCount = 0;

  for (const { parsed } of configs) {
    const program = ts.createProgram({
      rootNames: parsed.fileNames,
      options: parsed.options,
    });

    const preEmit = ts.getPreEmitDiagnostics(program);
    if (preEmit.length > 0) {
      throw new Error(ts.formatDiagnostics(preEmit, formatHost).trim());
    }

    const checker = program.getTypeChecker();

    for (const sourceFile of program.getSourceFiles()) {
      const normalizedFile = normalizeSlashes(sourceFile.fileName);
      if (sourceFile.isDeclarationFile || normalizedFile.includes('/node_modules/')) continue;
      checkedFileCount += 1;

      const relativeFile = normalizeSlashes(path.relative(resolvedBase, sourceFile.fileName));

      for (const diagnostic of program.getSuggestionDiagnostics(sourceFile)) {
        if (!diagnostic.reportsDeprecated || diagnostic.start === undefined) continue;
        const node = findNodeAtPosition(sourceFile, diagnostic.start, sourceFile);
        const symbol = resolveSymbolForDiagnosticNode(node, checker);
        const targetDeclarations = resolveTargetDeclarations(symbol, checker);
        if (!targetDeclarations.some(isPhosphorDeclaration)) continue;

        const { line, character } = sourceFile.getLineAndCharacterOfPosition(diagnostic.start);
        const key = `${normalizedFile}:${line + 1}:${character + 1}`;
        if (seenLocations.has(key)) continue;
        seenLocations.add(key);

        findings.push({
          file: relativeFile,
          line: line + 1,
          column: character + 1,
          code: diagnostic.code,
          message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
        });
      }

      sourceFile.forEachChild((statement) => {
        if (!ts.isExportDeclaration(statement) || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
          return;
        }
        for (const specifier of statement.exportClause.elements) {
          const symbol =
            checker.getExportSpecifierLocalTargetSymbol(specifier) ??
            checker.getSymbolAtLocation(specifier.propertyName ?? specifier.name);
          const targetDeclarations = resolveTargetDeclarations(symbol, checker);
          if (!targetDeclarations.some((decl) => isPhosphorDeclaration(decl) && Boolean(ts.getJSDocDeprecatedTag(decl)))) {
            continue;
          }
          const targetNode = specifier.propertyName ?? specifier.name;
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(targetNode.getStart(sourceFile));
          const key = `${normalizedFile}:${line + 1}:${character + 1}`;
          if (seenLocations.has(key)) continue;
          seenLocations.add(key);

          findings.push({
            file: relativeFile,
            line: line + 1,
            column: character + 1,
            code: 6385,
            message: `'${targetNode.getText(sourceFile)}' is deprecated.`,
          });
        }
      });
    }
  }

  return { checkedFileCount, findings };
}

export function formatPhosphorDeprecations(findings) {
  const lines = findings.map(
    (item) => `${item.file}:${item.line}:${item.column} - error TS${item.code}: ${item.message} (use the supported *Icon export from @phosphor-icons/react)`,
  );
  lines.push(`Found ${findings.length} deprecated @phosphor-icons/react reference${findings.length === 1 ? '' : 's'}.`);
  return lines.join('\n');
}

export function verifyPhosphorIcons(options = {}) {
  const result = findPhosphorDeprecations(options);
  if (result.findings.length > 0) {
    throw new Error(formatPhosphorDeprecations(result.findings));
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [tsconfigArg] = process.argv.slice(2);
    const result = verifyPhosphorIcons(
      tsconfigArg ? { tsconfigPath: tsconfigArg, basePath: process.cwd() } : undefined,
    );
    console.log(`phosphor_icons_verified files=${result.checkedFileCount} deprecated=0`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
