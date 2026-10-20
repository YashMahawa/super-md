#!/usr/bin/env node
// Opt-in Linux integration check for Qt WebEngine renderer recovery.
// Example source run:
//   node desktop/test_reader_crash_recovery_integration.mjs \
//     --binary desktop/.venv/bin/python --entrypoint desktop/main.py
// Installed executable run: pass --binary /absolute/path/to/super-md and omit
// --entrypoint. This test creates only a synthetic note and an isolated
// --test-state app, and kills only the identified renderer child of that app.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { WebSocket } from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const defaultPython = path.join(here, ".venv", "bin", "python");
const defaultEntry = path.join(here, "main.py");
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${name} needs a value`);
  return args[index + 1];
}
const binary = path.resolve(option("--binary", defaultPython));
const entrypointArg = option("--entrypoint", path.extname(binary) === ".py" ? "" : (binary === path.resolve(defaultPython) ? defaultEntry : ""));
const entrypoint = entrypointArg ? path.resolve(entrypointArg) : "";
const timeoutMs = Math.min(120_000, Math.max(30_000, Number(option("--timeout-ms", "90000"))));
if (!fs.existsSync(binary) || (entrypoint && !fs.existsSync(entrypoint))) throw new Error("Binary or entrypoint does not exist");
if (process.platform !== "linux") throw new Error("This disposable renderer-kill harness currently requires Linux /proc");

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
class CDPConnection {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 0;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.socket.once("open", resolve);
      this.socket.once("error", reject);
    });
    this.socket.on("message", raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "CDP command failed"));
      else pending.resolve(message.result || {});
    });
    this.socket.on("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("CDP connection closed"));
      }
      this.pending.clear();
    });
  }

  async send(method, params = {}, timeoutMs = 8000) {
    await this.ready;
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }), error => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  close() {
    try { this.socket.close(); } catch { /* The socket may already be closed. */ }
  }
}

async function waitFor(description, predicate, timeout = 20_000, interval = 100) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) { lastError = error; }
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError}` : ""}`);
}

function procInfo(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 2).trim().split(/\s+/); // Starts at proc stat field 3.
    return {
      pid,
      ppid: Number(fields[1]),
      startTime: fields[19],
      state: fields[0],
      argv: fs.readFileSync(`/proc/${pid}/cmdline`).toString().split("\0").filter(Boolean),
    };
  } catch { return null; }
}

function ownedDescendants(rootPid) {
  const all = [];
  for (const name of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const info = procInfo(Number(name));
    if (info) all.push(info);
  }
  const owned = new Map([[rootPid, procInfo(rootPid)]]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const info of all) {
      if (!owned.has(info.pid) && owned.has(info.ppid)) {
        owned.set(info.pid, info);
        changed = true;
      }
    }
  }
  owned.delete(rootPid);
  return [...owned.values()].filter(Boolean);
}

let browserCdp;
const rawPageCdps = new Map();
let rawTargetDiagnostics = [];
async function rendererChild(appPid) {
  // Qt sets process titles and can erase --type from /proc/cmdline. Obtain
  // roles from the loopback browser CDP connection, then verify ancestry and
  // kernel start time independently before terminating any process.
  const roles=await browserCdp.send("SystemInfo.getProcessInfo");
  const rendererPids=new Set(roles.processInfo.filter(info=>info.type==='renderer').map(info=>Number(info.id)));
  const renderers = ownedDescendants(appPid).filter(info => rendererPids.has(info.pid));
  if (renderers.length !== 1) {
    const types=ownedDescendants(appPid).map(info=>({pid:info.pid,ppid:info.ppid,type:info.argv.find(arg=>arg.startsWith('--type='))??'unknown'}));
    throw new Error(`Expected exactly one owned Qt renderer child; found ${renderers.length}; descendants=${JSON.stringify(types)}`);
  }
  return renderers[0];
}

async function killIdentifiedRenderer(appPid, renderer) {
  const current = procInfo(renderer.pid);
  const role=await rendererChild(appPid);
  if (!current || current.startTime !== renderer.startTime || role.pid!==current.pid || role.startTime!==current.startTime) {
    throw new Error("Identified renderer exited or changed identity before termination");
  }
  const descendants = ownedDescendants(appPid);
  if (!descendants.some(item => item.pid === current.pid && item.startTime === renderer.startTime)) {
    throw new Error("Renderer is no longer a descendant of the disposable app");
  }
  process.kill(current.pid, "SIGKILL");
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "supermd-renderer-recovery-"));
const notePath = path.join(tempRoot, "synthetic-recovery.md");
const pythonMarker = path.join(tempRoot, "python-ran.txt");
const latestTitle = "Latest acknowledged native edit";
const paragraphs = Array.from({ length: 100 }, (_, i) => `Recovery fixture paragraph ${i + 1}. ${"Synthetic reader content for scroll restoration. ".repeat(5)}`).join("\n\n");
const content = [
  "# Initial synthetic title",
  "",
  "A disposable renderer recovery fixture.",
  "",
  paragraphs,
  "",
  "## Python must remain inert",
  "",
  "```python",
  `from pathlib import Path; Path(${JSON.stringify(pythonMarker)}).write_text("unexpected execution")`,
  "```",
  "",
].join("\n");
fs.writeFileSync(notePath, content, "utf8");
const portServer = await import("node:net").then(({ createServer }) => new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    server.close(error => error ? reject(error) : resolve(port));
  });
}));
const logPath = path.join(tempRoot, "qt-app.log");
const logFd = fs.openSync(logPath, "w");
const appArgs = [
  ...(entrypoint ? [entrypoint] : []),
  notePath,
  "--test-state",
  "--safe-graphics",
  "--quit-after",
  "180000",
];
const app = spawn(binary, appArgs, {
  cwd: repo,
  env: {
    ...process.env,
    TMPDIR: tempRoot,
    QT_QPA_PLATFORM: "offscreen",
    QTWEBENGINE_REMOTE_DEBUGGING: `127.0.0.1:${portServer}`,
  },
  stdio: ["ignore", logFd, logFd],
});
let appStartTime;
app.once("spawn", () => { appStartTime = procInfo(app.pid)?.startTime; });
fs.closeSync(logFd);
let browser;
let passed = false;
let recoveredRendererPid = null;

function appIsAlive() {
  const current = procInfo(app.pid);
  return !!current && (!appStartTime || current.startTime === appStartTime);
}

async function readyReader() {
  return waitFor("a ready Qt reader CDP target", async () => {
    if (!appIsAlive()) throw new Error(`Disposable Qt app exited (${app.exitCode ?? "signal"})`);
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (!page.url().includes("qt-reader.html") || page.isClosed()) continue;
        try {
          if (await page.evaluate(() => !!document.querySelector(".android-reading") && !!document.querySelector("h1") && !!window.SuperMD)) return page;
        } catch { /* A crashed CDP target may remain listed while Qt remounts it. */ }
      }
    }
    return null;
  }, 25_000);
}

async function rawReaderState() {
  const targets = await (await fetch(`http://127.0.0.1:${portServer}/json/list`)).json();
  const candidates = targets.filter(item => item.type === "page" && item.url.includes("qt-reader.html") && item.webSocketDebuggerUrl);
  const candidateIds = new Set(candidates.map(item => item.id));
  for (const [id, client] of rawPageCdps) {
    if (!candidateIds.has(id)) { client.close(); rawPageCdps.delete(id); }
  }
  rawTargetDiagnostics = [];
  let lastUsableState = null;
  for (const target of candidates) {
    let client = rawPageCdps.get(target.id);
    if (!client) {
      client = new CDPConnection(target.webSocketDebuggerUrl);
      rawPageCdps.set(target.id, client);
    }
    try {
      const response = await client.send("Runtime.evaluate", {
        expression: `(() => { const root = document.querySelector(".android-reading"); const heading = document.querySelector("h1"); return { ready: !!(root && heading && window.SuperMD), title: heading?.textContent?.trim() || "", scrollTop: root?.scrollTop ?? -1, text: root?.textContent || document.body?.textContent || "", pythonOutputs: document.querySelectorAll(".python-cell .cell-output").length }; })()`,
        returnByValue: true,
        awaitPromise: true,
      });
      const state = response.result?.value || null;
      rawTargetDiagnostics.push({
        id: target.id,
        ready: !!state?.ready,
        title: state?.title || "",
        textContainsSyntheticTitle: !!state?.text?.includes(latestTitle),
        textLength: state?.text?.length || 0,
        scrollTop: Number.isFinite(state?.scrollTop) ? state.scrollTop : null,
      });
      if (state?.ready) return state;
      if (state) lastUsableState = state;
    } catch (error) {
      client.close();
      rawPageCdps.delete(target.id);
      rawTargetDiagnostics.push({ id: target.id, error: String(error) });
    }
  }
  return lastUsableState;
}

try {
  await waitFor("loopback Qt WebEngine CDP endpoint", async () => {
    if (!appIsAlive()) throw new Error(`Qt app exited early; see ${logPath}`);
    try {
      const response = await fetch(`http://127.0.0.1:${portServer}/json/version`);
      return response.ok ? response.json() : null;
    } catch { return null; }
  }, 30_000);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${portServer}`, { timeout: 15_000, noDefaults:true });
  const version = await (await fetch(`http://127.0.0.1:${portServer}/json/version`)).json();
  browserCdp = new CDPConnection(version.webSocketDebuggerUrl);
  const page = await readyReader();

  // Make a real Live-mode edit and save through the native acknowledged flush
  // barrier. The note file is inside this test's private temp directory.
  await page.locator(".live-block").first().dblclick();
  const editor = page.getByRole("textbox", { name: "Edit Markdown block" });
  await editor.waitFor({ state: "visible", timeout: 10_000 });
  await editor.fill(`# ${latestTitle}`);
  await editor.press("Escape");
  await page.getByRole("heading", { name: latestTitle, level: 1 }).waitFor({ timeout: 10_000 });
  await page.keyboard.press("Control+s");
  await waitFor("native save of acknowledged synthetic text", () => {
    try { return fs.readFileSync(notePath, "utf8").includes(latestTitle); } catch { return false; }
  }, 15_000);

  const beforeTop = await page.evaluate(async () => {
    const root = document.querySelector(".android-reading");
    if (!root) return -1;
    root.scrollTop = Math.min(1400, root.scrollHeight - root.clientHeight - 1);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    window.supermdSavePosition?.();
    return root.scrollTop;
  });
  if (beforeTop < 300) throw new Error(`Synthetic fixture did not provide enough scroll range (${beforeTop})`);
  await sleep(1100); // Native reading_position is intentionally debounced.

  const oldRenderer = await waitFor("the owned Qt renderer process", () => {
    return rendererChild(app.pid);
  }, 10_000);
  // Detach Playwright before the intentional renderer kill. Its target watcher
  // treats Qt's renderer replacement as an unrecoverable Playwright crash.
  await browser.close();
  browser = null;
  await killIdentifiedRenderer(app.pid, oldRenderer);
  await waitFor("the terminated renderer process to exit", () => {
    const current = procInfo(oldRenderer.pid);
    return !current || current.startTime !== oldRenderer.startTime || current.state === "Z";
  }, 10_000);

  // Poll the recreated Qt target over raw CDP. Playwright's browser-level
  // watcher is deliberately disconnected so it cannot turn target recovery
  // into a test-runner assertion.
  const recoveredState = await waitFor("recovered reader DOM on a live Qt renderer", async () => {
    if (!appIsAlive()) throw new Error("Disposable Qt app exited during renderer recovery");
    const state = await rawReaderState();
    return state?.ready && state.title === latestTitle ? state : null;
  }, 25_000).catch(error => {
    throw new Error(`${error}; target states=${JSON.stringify(rawTargetDiagnostics)}`);
  });
  await sleep(900); // Let the native readingLocation restoration timers settle.
  const settledState = await waitFor("settled recovered reader state", async () => {
    const state = await rawReaderState();
    return state?.ready && state.title === latestTitle ? state : null;
  }, 8_000);
  if (!recoveredState?.text.includes(latestTitle)) throw new Error(`Latest acknowledged native text did not recover; target state=${JSON.stringify(rawTargetDiagnostics)}`);
  const afterTop = settledState?.scrollTop ?? -1;
  if (afterTop < 0 || Math.abs(afterTop - beforeTop) > Math.max(180, beforeTop * 0.12)) {
    throw new Error(`Reading position did not recover: before=${beforeTop}, after=${afterTop}`);
  }
  if (fs.existsSync(pythonMarker)) throw new Error("Python fixture ran during renderer recovery");
  if (settledState?.pythonOutputs) throw new Error("Python output appeared without an explicit run");
  if (!settledState?.text.includes(latestTitle)) throw new Error("Latest acknowledged native text did not recover");
  const recoveredRenderer = await rendererChild(app.pid);
  recoveredRendererPid = recoveredRenderer.pid;
  if (recoveredRenderer.pid === oldRenderer.pid && recoveredRenderer.startTime === oldRenderer.startTime) throw new Error("The terminated renderer process was not replaced");
  passed = true;
  console.log(JSON.stringify({
    ok: true,
    appPid: app.pid,
    terminatedRendererPid: oldRenderer.pid,
    recoveredRendererPid,
    acknowledgedTextRecovered: true,
    readingPositionBefore: beforeTop,
    readingPositionAfter: afterTop,
    pythonExecuted: false,
  }));
} catch (error) {
  try{console.error('Owned CDP targets:',JSON.stringify(await(await fetch(`http://127.0.0.1:${portServer}/json/list`)).json()));}catch{}
  const tail = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").slice(-5000) : "";
  console.error(`Qt renderer recovery integration failed: ${error.stack || error}\nOwned app log tail:\n${tail}`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const client of rawPageCdps.values()) client.close();
  rawPageCdps.clear();
  browserCdp?.close();
  const ownedAtShutdown = appIsAlive() ? ownedDescendants(app.pid) : [];
  const stillOwned = info => {
    const current = procInfo(info.pid);
    return !!current && current.startTime === info.startTime && current.state !== "Z";
  };
  // Revalidate every previously-owned process identity before signaling it.
  for (const child of [...ownedAtShutdown].reverse()) {
    if (stillOwned(child)) { try { process.kill(child.pid, "SIGTERM"); } catch { /* It exited between checks. */ } }
  }
  if (appIsAlive()) {
    try { process.kill(app.pid, "SIGTERM"); } catch { /* It exited between checks. */ }
    await waitFor("disposable Qt app shutdown", () => !appIsAlive(), 8_000, 100).catch(() => {});
  }
  const remainingChildren = () => ownedAtShutdown.filter(stillOwned);
  if (remainingChildren().length) {
    await waitFor("owned Qt child shutdown", () => remainingChildren().length === 0, 3_000, 100).catch(() => {});
  }
  if (appIsAlive() || remainingChildren().length) {
    for (const child of [...remainingChildren()].reverse()) {
      if (stillOwned(child)) { try { process.kill(child.pid, "SIGKILL"); } catch { /* It exited between checks. */ } }
    }
    if (appIsAlive()) {
      // This is the exact child process spawned above, never a global app name.
      try { process.kill(app.pid, "SIGKILL"); } catch { /* It exited between checks. */ }
    }
  }
  if (passed && fs.existsSync(pythonMarker)) process.exitCode = 1;
  // Preserve logs/fixture if any previously owned process survived cleanup.
  if (!appIsAlive() && remainingChildren().length === 0) fs.rmSync(tempRoot, { recursive: true, force: true });
  else console.error(`Disposable app cleanup incomplete; retained fixture at ${tempRoot}`);
}
