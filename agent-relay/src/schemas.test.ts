import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { z } from "zod";
import { buildServer, TOOL_INPUT_SCHEMAS } from "./index.js";

const EXPECTED_TOOLS = [
  "list_devices",
  "list_tabs",
  "read_tab",
  "search_tab",
  "patch_tab",
  "render_tab",
  "view_current",
  "diagram_action",
  "replace_tab_asset",
  "asset_action",
  "document_action",
] as const;

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const tsconfigPath = path.join(projectRoot, "tsconfig.json");

function normalizeSlashes(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function isIntentionalLegacySseTransportDeprecation(sf: ts.SourceFile, diag: ts.DiagnosticWithLocation): boolean {
  if (diag.code !== 6385) return false;
  const file = normalizeSlashes(sf.fileName);
  const message = ts.flattenDiagnosticMessageText(diag.messageText, " ");
  const relatedFiles = (diag.relatedInformation ?? []).map((info) => normalizeSlashes(info.file?.fileName ?? ""));
  if (file.endsWith("/src/index.ts") && message === "'SSEServerTransport' is deprecated.") {
    return relatedFiles.length > 0 && relatedFiles.every((rel) => rel.includes("/@modelcontextprotocol/server-legacy/"));
  }
  if (file.endsWith("/src/relay.test.ts") && message === "'SSEClientTransport' is deprecated.") {
    return relatedFiles.length > 0 && relatedFiles.every((rel) => rel.includes("/@modelcontextprotocol/client/"));
  }
  return false;
}

function collectDeprecationDiagnostics(service: ts.LanguageService, fileNames: readonly string[]): string[] {
  const failures: string[] = [];
  for (const fileName of fileNames) {
    if (fileName.endsWith(".d.ts") || fileName.endsWith(".d.mts") || normalizeSlashes(fileName).includes("/node_modules/")) continue;
    for (const diag of service.getSuggestionDiagnostics(fileName)) {
      if (!diag.reportsDeprecated) continue;
      if (isIntentionalLegacySseTransportDeprecation(diag.file, diag)) continue;
      const pos = diag.file.getLineAndCharacterOfPosition(diag.start);
      const relPath = normalizeSlashes(path.relative(projectRoot, diag.file.fileName));
      failures.push(`${relPath}:${pos.line + 1}:${pos.character + 1} TS${diag.code}: ${ts.flattenDiagnosticMessageText(diag.messageText, " ")}`);
    }
  }
  return failures;
}

test("all 11 MCP tool schemas and shared primitives initialize once at startup and are reused across requests", () => {
  assert.equal(Object.isFrozen(TOOL_INPUT_SCHEMAS), true);
  assert.deepEqual(Object.keys(TOOL_INPUT_SCHEMAS).sort(), [...EXPECTED_TOOLS].sort());

  for (const name of EXPECTED_TOOLS) {
    const schema = TOOL_INPUT_SCHEMAS[name];
    assert.ok(schema instanceof z.ZodObject, `${name} must use a prebuilt z.object schema`);
    assert.ok("~standard" in schema && typeof schema["~standard"].validate === "function", `${name} must satisfy StandardSchemaV1`);
    assert.ok(typeof schema["~standard"].jsonSchema?.input === "function", `${name} must satisfy StandardJSONSchemaV1`);
  }

  // Verify shared field primitives are initialized once and shared across tool schemas.
  const sharedDeviceId = TOOL_INPUT_SCHEMAS.list_tabs.shape.deviceId;
  for (const name of ["read_tab", "search_tab", "patch_tab", "render_tab", "view_current", "diagram_action", "replace_tab_asset", "asset_action", "document_action"] as const) {
    assert.equal(TOOL_INPUT_SCHEMAS[name].shape.deviceId, sharedDeviceId, `${name} must reuse shared deviceId primitive`);
  }

  const sharedRequiredTabId = TOOL_INPUT_SCHEMAS.search_tab.shape.tabId;
  for (const name of ["patch_tab", "render_tab", "diagram_action", "replace_tab_asset", "asset_action"] as const) {
    assert.equal(TOOL_INPUT_SCHEMAS[name].shape.tabId, sharedRequiredTabId, `${name} must reuse shared required tabId primitive`);
  }

  const sharedOptionalTabId = TOOL_INPUT_SCHEMAS.read_tab.shape.tabId;
  for (const name of ["view_current", "document_action"] as const) {
    assert.equal(TOOL_INPUT_SCHEMAS[name].shape.tabId, sharedOptionalTabId, `${name} must reuse shared optional tabId primitive`);
  }

  const sharedRequiredRevision = TOOL_INPUT_SCHEMAS.patch_tab.shape.expectedRevision;
  for (const name of ["replace_tab_asset", "asset_action"] as const) {
    assert.equal(TOOL_INPUT_SCHEMAS[name].shape.expectedRevision, sharedRequiredRevision, `${name} must reuse shared required expectedRevision primitive`);
  }
  assert.equal(TOOL_INPUT_SCHEMAS.diagram_action.shape.expectedRevision, TOOL_INPUT_SCHEMAS.document_action.shape.expectedRevision);

  assert.equal(TOOL_INPUT_SCHEMAS.read_tab.shape.offset, TOOL_INPUT_SCHEMAS.search_tab.shape.offset);
  assert.equal(TOOL_INPUT_SCHEMAS.read_tab.shape.offset, TOOL_INPUT_SCHEMAS.diagram_action.shape.offset);
  assert.equal(TOOL_INPUT_SCHEMAS.read_tab.shape.limit, TOOL_INPUT_SCHEMAS.diagram_action.shape.limit);
  assert.equal(TOOL_INPUT_SCHEMAS.read_tab.shape.limit, TOOL_INPUT_SCHEMAS.asset_action.shape.limit);
  assert.equal(TOOL_INPUT_SCHEMAS.render_tab.shape.width, TOOL_INPUT_SCHEMAS.view_current.shape.width);
  assert.equal(TOOL_INPUT_SCHEMAS.render_tab.shape.width, TOOL_INPUT_SCHEMAS.diagram_action.shape.width);
  assert.equal(TOOL_INPUT_SCHEMAS.render_tab.shape.quality, TOOL_INPUT_SCHEMAS.view_current.shape.quality);
  assert.equal(TOOL_INPUT_SCHEMAS.render_tab.shape.quality, TOOL_INPUT_SCHEMAS.diagram_action.shape.quality);

  // Verify buildServer reuses the exact prebuilt schema instances across Streamable HTTP requests without raw-shape wrapping.
  const firstServer = buildServer();
  const secondServer = buildServer();
  const firstRegistered = (firstServer as unknown as { _registeredTools: Record<string, { inputSchema?: unknown }> })._registeredTools;
  const secondRegistered = (secondServer as unknown as { _registeredTools: Record<string, { inputSchema?: unknown }> })._registeredTools;

  assert.deepEqual(Object.keys(firstRegistered).sort(), [...EXPECTED_TOOLS].sort());
  assert.deepEqual(Object.keys(secondRegistered).sort(), [...EXPECTED_TOOLS].sort());
  for (const name of EXPECTED_TOOLS) {
    assert.equal(firstRegistered[name]?.inputSchema, TOOL_INPUT_SCHEMAS[name], `${name} on first server must reference prebuilt schema directly`);
    assert.equal(secondRegistered[name]?.inputSchema, TOOL_INPUT_SCHEMAS[name], `${name} on second server must reference prebuilt schema directly`);
  }
});

test("TypeScript compiler reports zero deprecation diagnostics across agent-relay and rejects deprecated declarations", () => {
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  assert.equal(configFile.error, undefined, "tsconfig.json must parse cleanly");
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, projectRoot);
  assert.deepEqual(parsed.errors, []);

  const compilerOptions: ts.CompilerOptions = { ...parsed.options, noEmit: true };
  let activeFiles: string[] = [...parsed.fileNames];
  const overrides = new Map<string, { version: number; content: string }>();
  const serviceHost: ts.LanguageServiceHost = {
    getScriptFileNames: () => activeFiles,
    getScriptVersion: (fileName) => String(overrides.get(path.resolve(fileName))?.version ?? 1),
    getScriptSnapshot: (fileName) => {
      const override = overrides.get(path.resolve(fileName));
      const content = override ? override.content : ts.sys.readFile(fileName);
      return content !== undefined ? ts.ScriptSnapshot.fromString(content) : undefined;
    },
    getCurrentDirectory: () => projectRoot,
    getCompilationSettings: () => compilerOptions,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: (fileName) => overrides.has(path.resolve(fileName)) || ts.sys.fileExists(fileName),
    readFile: (fileName) => overrides.get(path.resolve(fileName))?.content ?? ts.sys.readFile(fileName),
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath,
  };
  const service = ts.createLanguageService(serviceHost, ts.createDocumentRegistry());
  try {
    const baseProgram = service.getProgram();
    assert.ok(baseProgram, "TypeScript LanguageService must build a program");

    const preEmit = ts.getPreEmitDiagnostics(baseProgram);
    assert.deepEqual(
      preEmit.map((d) => ts.flattenDiagnosticMessageText(d.messageText, " ")),
      [],
      "strict TypeScript build must report zero pre-emit errors",
    );
    assert.deepEqual(
      collectDeprecationDiagnostics(service, parsed.fileNames),
      [],
      "agent-relay source must reference zero deprecated declarations or tool registration overloads",
    );

    // Negative check: verify the guard immediately catches both deprecated raw-shape tool registration (TS6387)
    // and references to @deprecated declarations (TS6385).
    const syntheticFile = path.join(projectRoot, "src", "__deprecation_probe__.ts");
    const syntheticSource = [
      'import { McpServer } from "@modelcontextprotocol/server";',
      'import { type SSEServerTransportOptions } from "@modelcontextprotocol/server-legacy/sse";',
      'import { z } from "zod";',
      '/** @deprecated Do not call legacyHelper. */',
      'function legacyHelper(): number { return 1; }',
      'export function probe(server: McpServer, opts?: SSEServerTransportOptions): number {',
      '  server.registerTool("raw_zero", { inputSchema: {} }, async () => ({ content: [] }));',
      '  server.registerTool("raw_field", { inputSchema: { tabId: z.string() } }, async ({ tabId }) => ({ content: [{ type: "text" as const, text: tabId }] }));',
      '  void opts;',
      '  return legacyHelper();',
      '}',
    ].join("\n");

    overrides.set(path.resolve(syntheticFile), { version: 2, content: syntheticSource });
    activeFiles = [...parsed.fileNames, syntheticFile];
    const probeDeprecations = collectDeprecationDiagnostics(service, [syntheticFile]);
    assert.equal(probeDeprecations.length, 5, `expected 5 deprecation diagnostics in negative fixture, got: ${probeDeprecations.join("; ")}`);
    assert.equal(probeDeprecations.filter((line) => line.includes("TS6385")).length, 2, "must catch deprecated type/symbol references");
    assert.equal(probeDeprecations.filter((line) => line.includes("TS6387")).length, 3, "must catch deprecated raw-shape registerTool and function signatures");

    // Compatibility check: verify strict compilation succeeds even if the deprecated ZodRawShape registerTool overload
    // is removed from @modelcontextprotocol/server's type declarations.
    overrides.delete(path.resolve(syntheticFile));
    activeFiles = [...parsed.fileNames];
    const mcpDtsFile = baseProgram
      .getSourceFiles()
      .find((sf) => normalizeSlashes(sf.fileName).includes("/@modelcontextprotocol/server/dist/") && sf.text.includes("registerTool<InputArgs extends ZodRawShape"));
    assert.ok(mcpDtsFile, "located @modelcontextprotocol/server declaration file with ZodRawShape registerTool overload");
    const strippedMcpDts = mcpDtsFile.text.replace(
      /registerTool<InputArgs extends ZodRawShape[\s\S]*?cb: LegacyToolCallback<InputArgs>\): RegisteredTool;/,
      "",
    );
    assert.notEqual(strippedMcpDts, mcpDtsFile.text, "deprecated ZodRawShape registerTool overload was stripped for forward-compatibility test");

    overrides.set(path.resolve(mcpDtsFile.fileName), { version: 2, content: strippedMcpDts });
    const forwardCompatProgram = service.getProgram();
    assert.ok(forwardCompatProgram);
    assert.deepEqual(
      ts.getPreEmitDiagnostics(forwardCompatProgram).map((d) => ts.flattenDiagnosticMessageText(d.messageText, " ")),
      [],
      "agent-relay must compile cleanly with zero strict errors when deprecated ZodRawShape registerTool overload is removed",
    );
  } finally {
    service.dispose();
  }
});
