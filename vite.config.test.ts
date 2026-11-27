import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import {
  buildHtmlEntries,
  htmlCspPlugin,
  mermaidSandboxPlugin,
  renderSandboxDocument,
  stripLegacyMathFontFallbacks,
  woff2MathFontsPlugin,
} from './vite.config';

const originalTauriPlatform = process.env.TAURI_ENV_PLATFORM;

afterEach(() => {
  if (originalTauriPlatform === undefined) {
    delete process.env.TAURI_ENV_PLATFORM;
  } else {
    process.env.TAURI_ENV_PLATFORM = originalTauriPlatform;
  }
});

function runHtmlCspTransform(html: string, filename: string, command: 'build' | 'serve') {
  const plugin = htmlCspPlugin();
  const configResolved = plugin.configResolved;
  if (typeof configResolved === 'function') {
    configResolved.call({} as never, { command } as never);
  }
  const hook = plugin.transformIndexHtml;
  if (!hook || typeof hook === 'function') {
    throw new Error('Expected object transformIndexHtml hook');
  }
  return hook.handler.call({} as never, html, { filename, path: filename } as never);
}

it('keeps native Vite builds limited to the Android and Qt reader entrypoints', () => {
  expect(buildHtmlEntries('native')).toEqual({
    reader: 'android-reader.html',
    qtReader: 'qt-reader.html',
  });
});

it('preserves the existing app, Android and Qt entrypoints in the default build', () => {
  expect(buildHtmlEntries('production')).toEqual({
    app: 'index.html',
    reader: 'android-reader.html',
    qtReader: 'qt-reader.html',
  });
  expect(buildHtmlEntries('development')).toEqual(buildHtmlEntries('production'));
});

it('embeds an HTML5-normalized SHA-256 CSP digest for the Mermaid sandbox bundle', () => {
  const doc = renderSandboxDocument('const tag = "</script>";\r\nconsole.log(tag);\0');
  const scriptBody = doc.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
  expect(scriptBody).not.toContain('\r');
  expect(scriptBody).not.toContain('\0');
  expect(scriptBody).toContain('<\\/script>');
  const expectedDigest = createHash('sha256').update(scriptBody, 'utf8').digest('base64');
  expect(doc).toContain(`script-src 'sha256-${expectedDigest}' 'wasm-unsafe-eval'`);
});

it('strips duplicate meta CSP only from index.html during Tauri platform builds', () => {
  const indexHtml = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const qtHtml = readFileSync(new URL('./qt-reader.html', import.meta.url), 'utf8');
  const androidHtml = readFileSync(new URL('./android-reader.html', import.meta.url), 'utf8');

  delete process.env.TAURI_ENV_PLATFORM;
  expect(runHtmlCspTransform(indexHtml, '/repo/index.html', 'build')).toContain(
    'http-equiv="Content-Security-Policy"',
  );

  process.env.TAURI_ENV_PLATFORM = 'windows';
  expect(runHtmlCspTransform(indexHtml, 'C:\\repo\\index.html', 'build')).not.toContain(
    'Content-Security-Policy',
  );
  expect(runHtmlCspTransform(qtHtml, 'C:\\repo\\qt-reader.html', 'build')).toContain(
    'http-equiv="Content-Security-Policy"',
  );
  expect(runHtmlCspTransform(androidHtml, 'C:\\repo\\android-reader.html', 'build')).toContain(
    'http-equiv="Content-Security-Policy"',
  );
});

it('hashes CRLF inline preamble scripts with HTML5 LF normalization during vite serve', () => {
  delete process.env.TAURI_ENV_PLATFORM;
  const sample = [
    '<!doctype html><html><head>',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; connect-src \'self\'">',
    '<script type="module">window.__vite_plugin_react_preamble_installed__ = true;\r\n</script>',
    '</head><body></body></html>',
  ].join('\r\n');

  const transformed = String(runHtmlCspTransform(sample, '/repo/index.html', 'serve'));
  const expectedDigest = createHash('sha256')
    .update('window.__vite_plugin_react_preamble_installed__ = true;\n', 'utf8')
    .digest('base64');
  expect(transformed).toContain(`'sha256-${expectedDigest}'`);
  expect(transformed).toContain('ws://127.0.0.1:1420 ws://localhost:1420');
});

it('strips legacy .woff and .ttf fallback sources from KaTeX @font-face rules while preserving .woff2', () => {
  const katexCss = readFileSync(new URL('./node_modules/katex/dist/katex.min.css', import.meta.url), 'utf8');
  const pruned = stripLegacyMathFontFallbacks(katexCss);
  const faces = pruned.match(/@font-face\s*\{[^}]*\}/g) ?? [];
  expect(faces.length).toBe(20);
  for (const face of faces) {
    expect(face).toMatch(/\.woff2(?=[?#"'\s)]|$)/);
    expect(face).not.toMatch(/\.(?:woff|ttf)(?=[?#"'\s)]|$)/);
  }
  const plugin = woff2MathFontsPlugin();
  const transform = typeof plugin.transform === 'function' ? plugin.transform : plugin.transform?.handler;
  expect(transform?.call({} as never, katexCss, '/app/node_modules/katex/dist/katex.min.css')).toEqual({
    code: pruned,
    map: null,
  });
  expect(transform?.call({} as never, katexCss, '/app/src/styles.css')).toBeNull();
});

it('caches the Mermaid sandbox bundle across dev-server requests and invalidates on sandbox source changes', async () => {
  let buildCount = 0;
  const plugin = mermaidSandboxPlugin(async () => `window.__sandboxGen = ${++buildCount};`);
  const watcherHandlers = new Map<string, Array<(filePath: string) => void>>();
  let middleware: ((req: { url?: string; method?: string }, res: Record<string, unknown>, next: (err?: unknown) => void) => Promise<void>) | null = null;

  const configureServer = typeof plugin.configureServer === 'function' ? plugin.configureServer : plugin.configureServer?.handler;
  configureServer?.call(
    {} as never,
    {
      watcher: {
        on(event: string, cb: (filePath: string) => void) {
          watcherHandlers.set(event, [...(watcherHandlers.get(event) ?? []), cb]);
        },
      },
      middlewares: {
        use(fn: typeof middleware) {
          middleware = fn;
        },
      },
    } as never,
  );

  const requestRoute = async (url: string) => {
    let body = '';
    const headers = new Map<string, string>();
    await middleware!(
      { url, method: 'GET' },
      {
        statusCode: 0,
        setHeader(k: string, v: string) {
          headers.set(k, v);
        },
        end(chunk?: string) {
          body = chunk ?? '';
        },
      },
      (err) => {
        if (err) throw err;
      },
    );
    return { body, contentType: headers.get('Content-Type') };
  };

  const firstHtml = await requestRoute('/@mermaid-sandbox.html');
  const secondScript = await requestRoute('/@mermaid-sandbox.js');
  expect(buildCount).toBe(1);
  expect(firstHtml.contentType).toContain('text/html');
  expect(firstHtml.body).toContain('window.__sandboxGen = 1;');
  expect(secondScript.contentType).toContain('application/javascript');
  expect(secondScript.body).toBe('window.__sandboxGen = 1;');

  // Unrelated file edits keep the cached Mermaid sandbox bundle warm.
  for (const cb of watcherHandlers.get('change') ?? []) {
    cb('/repo/src/components/PythonCell.tsx');
  }
  const thirdScript = await requestRoute('/@mermaid-sandbox.js');
  expect(buildCount).toBe(1);
  expect(thirdScript.body).toBe('window.__sandboxGen = 1;');

  // Editing a mermaidSandbox source file invalidates the cache on next request.
  for (const cb of watcherHandlers.get('change') ?? []) {
    cb('/repo/src/mermaidSandboxWorker.ts');
  }
  const fourthScript = await requestRoute('/@mermaid-sandbox.js');
  expect(buildCount).toBe(2);
  expect(fourthScript.body).toBe('window.__sandboxGen = 2;');
});

it('keeps cached build B and recorded watch inputs when an invalidated in-flight build A settles later', async () => {
  type BuildResult = { script: string; inputs?: string[] };
  type DeferredBuild = {
    promise: Promise<BuildResult>;
    resolve: (value: BuildResult) => void;
    reject: (reason?: unknown) => void;
  };

  const createDeferred = (): DeferredBuild => {
    let resolve!: (value: BuildResult) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<BuildResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

  const setupHarness = () => {
    const builds: DeferredBuild[] = [];
    const plugin = mermaidSandboxPlugin(() => {
      const deferred = createDeferred();
      builds.push(deferred);
      return deferred.promise;
    });
    const watcherHandlers = new Map<string, Array<(filePath: string) => void>>();
    let middleware:
      | ((
          req: { url?: string; method?: string },
          res: Record<string, unknown>,
          next: (err?: unknown) => void,
        ) => Promise<void>)
      | null = null;

    const configureServer =
      typeof plugin.configureServer === 'function' ? plugin.configureServer : plugin.configureServer?.handler;
    configureServer?.call(
      {} as never,
      {
        watcher: {
          on(event: string, cb: (filePath: string) => void) {
            watcherHandlers.set(event, [...(watcherHandlers.get(event) ?? []), cb]);
          },
        },
        middlewares: {
          use(fn: typeof middleware) {
            middleware = fn;
          },
        },
      } as never,
    );

    const emitChange = (filePath: string) => {
      for (const cb of watcherHandlers.get('change') ?? []) {
        cb(filePath);
      }
    };

    const requestRoute = async (url: string) => {
      let body = '';
      await middleware!(
        { url, method: 'GET' },
        {
          statusCode: 0,
          setHeader() {},
          end(chunk?: string) {
            body = chunk ?? '';
          },
        },
        (err) => {
          if (err) throw err;
        },
      );
      return body;
    };

    return { builds, emitChange, requestRoute };
  };

  // Case 1: Held warm-up build A is invalidated, build B succeeds and caches, then obsolete A rejects.
  {
    const { builds, emitChange, requestRoute } = setupHarness();
    expect(builds).toHaveLength(1); // warm-up build A held in flight

    emitChange('/repo/src/mermaidSandboxEntry.ts');

    const pendingB = requestRoute('/@mermaid-sandbox.js');
    expect(builds).toHaveLength(2);
    builds[1].resolve({
      script: 'window.__sandboxGen = "B";',
      inputs: ['/repo/src/currentDepB.ts'],
    });
    expect(await pendingB).toBe('window.__sandboxGen = "B";');

    // Obsolete build A rejects later — must not evict cached build B or start a third build.
    builds[0].reject(new Error('obsolete warm-up build A failed'));
    await new Promise((r) => setTimeout(r, 0));

    expect(await requestRoute('/@mermaid-sandbox.js')).toBe('window.__sandboxGen = "B";');
    const htmlB = await requestRoute('/@mermaid-sandbox.html');
    expect(builds).toHaveLength(2);
    const expectedDigest = createHash('sha256')
      .update('window.__sandboxGen = "B";', 'utf8')
      .digest('base64');
    expect(htmlB).toContain(`script-src 'sha256-${expectedDigest}' 'wasm-unsafe-eval'`);
  }

  // Case 1b: Held warm-up build A is invalidated and resolves BEFORE build B is requested.
  {
    const { builds, emitChange, requestRoute } = setupHarness();
    expect(builds).toHaveLength(1);

    emitChange('/repo/src/mermaidSandboxEntry.ts');
    builds[0].resolve({
      script: 'window.__sandboxGen = "A-before-B";',
      inputs: ['/repo/src/obsoleteDepA.ts'],
    });
    await new Promise((r) => setTimeout(r, 0));

    const pendingB = requestRoute('/@mermaid-sandbox.js');
    expect(builds).toHaveLength(2);
    builds[1].resolve({
      script: 'window.__sandboxGen = "B-fresh";',
      inputs: ['/repo/src/currentDepB.ts'],
    });
    expect(await pendingB).toBe('window.__sandboxGen = "B-fresh";');

    emitChange('/repo/src/obsoleteDepA.ts');
    expect(await requestRoute('/@mermaid-sandbox.js')).toBe('window.__sandboxGen = "B-fresh";');
    expect(builds).toHaveLength(2);
  }

  // Case 2: Held warm-up build A is invalidated, build B succeeds, then obsolete A resolves with stale watch inputs.
  {
    const { builds, emitChange, requestRoute } = setupHarness();
    expect(builds).toHaveLength(1);

    emitChange('/repo/src/mermaidSandboxEntry.ts');

    const pendingB = requestRoute('/@mermaid-sandbox.js');
    expect(builds).toHaveLength(2);
    builds[1].resolve({
      script: 'window.__sandboxGen = "B";',
      inputs: ['/repo/src/currentDepB.ts'],
    });
    expect(await pendingB).toBe('window.__sandboxGen = "B";');

    builds[0].resolve({
      script: 'window.__sandboxGen = "A-stale";',
      inputs: ['/repo/src/obsoleteDepA.ts'],
    });
    await new Promise((r) => setTimeout(r, 0));

    // Stale watch input from obsolete build A must not invalidate cached build B.
    emitChange('/repo/src/obsoleteDepA.ts');
    expect(await requestRoute('/@mermaid-sandbox.js')).toBe('window.__sandboxGen = "B";');
    expect(builds).toHaveLength(2);

    // Watch input recorded by current build B still invalidates and triggers build C.
    emitChange('/repo/src/currentDepB.ts');
    const pendingC = requestRoute('/@mermaid-sandbox.js');
    expect(builds).toHaveLength(3);
    builds[2].resolve({
      script: 'window.__sandboxGen = "C";',
      inputs: ['/repo/src/currentDepC.ts'],
    });
    expect(await pendingC).toBe('window.__sandboxGen = "C";');

    // If the current build itself fails, the failed promise is cleared so the next request retries.
    emitChange('/repo/src/currentDepC.ts');
    const pendingD = requestRoute('/@mermaid-sandbox.js');
    expect(builds).toHaveLength(4);
    builds[3].reject(new Error('transient esbuild failure'));
    await expect(pendingD).rejects.toThrow('transient esbuild failure');

    const pendingE = requestRoute('/@mermaid-sandbox.js');
    expect(builds).toHaveLength(5);
    builds[4].resolve({ script: 'window.__sandboxGen = "E";' });
    expect(await pendingE).toBe('window.__sandboxGen = "E";');

    // Prior watch inputs from build C are cleared once build E succeeds without inputs.
    emitChange('/repo/src/currentDepC.ts');
    expect(await requestRoute('/@mermaid-sandbox.js')).toBe('window.__sandboxGen = "E";');
    expect(builds).toHaveLength(5);
  }

  // Case 3: Synchronous invalidation inside buildSandboxScript before returning its promise cannot cache obsolete build A.
  {
    let triggerSyncInvalidation = false;
    let emitChangeRef: ((filePath: string) => void) | null = null;
    const builds: DeferredBuild[] = [];
    const plugin = mermaidSandboxPlugin(() => {
      const deferred = createDeferred();
      builds.push(deferred);
      if (triggerSyncInvalidation) {
        triggerSyncInvalidation = false;
        emitChangeRef?.('/repo/src/mermaidSandboxEntry.ts');
      }
      return deferred.promise;
    });
    const watcherHandlers = new Map<string, Array<(filePath: string) => void>>();
    let middleware:
      | ((
          req: { url?: string; method?: string },
          res: Record<string, unknown>,
          next: (err?: unknown) => void,
        ) => Promise<void>)
      | null = null;
    const configureServer =
      typeof plugin.configureServer === 'function' ? plugin.configureServer : plugin.configureServer?.handler;
    configureServer?.call(
      {} as never,
      {
        watcher: {
          on(event: string, cb: (filePath: string) => void) {
            watcherHandlers.set(event, [...(watcherHandlers.get(event) ?? []), cb]);
          },
        },
        middlewares: {
          use(fn: typeof middleware) {
            middleware = fn;
          },
        },
      } as never,
    );
    emitChangeRef = (filePath: string) => {
      for (const cb of watcherHandlers.get('change') ?? []) {
        cb(filePath);
      }
    };
    const requestRoute = async (url: string) => {
      let body = '';
      await middleware!(
        { url, method: 'GET' },
        {
          statusCode: 0,
          setHeader() {},
          end(chunk?: string) {
            body = chunk ?? '';
          },
        },
        (err) => {
          if (err) throw err;
        },
      );
      return body;
    };

    // Invalidate warm-up build 0, then trigger synchronous invalidation during build 1 setup.
    emitChangeRef('/repo/src/mermaidSandboxEntry.ts');
    builds[0].reject(new Error('warm-up cancelled'));
    triggerSyncInvalidation = true;
    const pendingSyncInvalidated = requestRoute('/@mermaid-sandbox.js');
    expect(builds).toHaveLength(2);

    // Because build 1 was synchronously invalidated, a concurrent request starts fresh build 2 and caches it.
    const pendingFresh = requestRoute('/@mermaid-sandbox.js');
    expect(builds).toHaveLength(3);
    builds[2].resolve({ script: 'window.__sandboxGen = "fresh";', inputs: ['/repo/src/freshDep.ts'] });
    expect(await pendingFresh).toBe('window.__sandboxGen = "fresh";');

    // When obsolete build 1 rejects later, the in-flight request whose build was invalidated
    // recovers onto cached build 2 without starting a fourth build or evicting build 2.
    builds[1].reject(new Error('obsolete sync-invalidated build failed'));
    expect(await pendingSyncInvalidated).toBe('window.__sandboxGen = "fresh";');

    expect(await requestRoute('/@mermaid-sandbox.js')).toBe('window.__sandboxGen = "fresh";');
    expect(builds).toHaveLength(3);
  }

  // Case 4: In-flight request awaiting build A when source invalidates receives build B even if obsolete A resolves stale or rejects.
  {
    const { builds, emitChange, requestRoute } = setupHarness();
    const pendingBeforeInvalidate = requestRoute('/@mermaid-sandbox.js');
    expect(builds).toHaveLength(1);

    emitChange('/repo/src/mermaidSandboxWorker.ts');
    builds[0].resolve({ script: 'window.__sandboxGen = "stale-A";', inputs: ['/repo/src/staleDep.ts'] });
    await new Promise((r) => setTimeout(r, 0));

    // Middleware automatically starts build B instead of serving stale build A.
    expect(builds).toHaveLength(2);
    builds[1].resolve({ script: 'window.__sandboxGen = "fresh-B";', inputs: ['/repo/src/freshDepB.ts'] });
    expect(await pendingBeforeInvalidate).toBe('window.__sandboxGen = "fresh-B";');
    expect(builds).toHaveLength(2);
  }
});

it('isolates middleware responses across concurrent HTML/JS/HEAD requests, pass-through routes, aborted responses, and separate dev servers', async () => {
  type BuildResult = { script: string; inputs?: string[] };
  let resolveShared!: (value: BuildResult) => void;
  let buildCalls = 0;
  const plugin = mermaidSandboxPlugin(() => {
    buildCalls += 1;
    if (buildCalls === 1) {
      return new Promise<BuildResult>((res) => {
        resolveShared = res;
      });
    }
    return Promise.resolve({ script: `window.__sandboxGen = ${buildCalls};` });
  });

  const attachServer = () => {
    const watcherHandlers = new Map<string, Array<(filePath: string) => void>>();
    let middleware:
      | ((
          req: { url?: string; method?: string },
          res: Record<string, unknown>,
          next: (err?: unknown) => void,
        ) => Promise<void>)
      | null = null;
    const configureServer =
      typeof plugin.configureServer === 'function' ? plugin.configureServer : plugin.configureServer?.handler;
    configureServer?.call(
      {} as never,
      {
        watcher: {
          on(event: string, cb: (filePath: string) => void) {
            watcherHandlers.set(event, [...(watcherHandlers.get(event) ?? []), cb]);
          },
        },
        middlewares: {
          use(fn: typeof middleware) {
            middleware = fn;
          },
        },
      } as never,
    );
    return {
      middleware: middleware!,
      emitChange(filePath: string) {
        for (const cb of watcherHandlers.get('change') ?? []) {
          cb(filePath);
        }
      },
    };
  };

  const server1 = attachServer();
  expect(buildCalls).toBe(1);

  // Pass-through route and unsupported method do not touch response state or start extra builds.
  for (const req of [
    { url: '/index.html', method: 'GET' },
    { url: '/@mermaid-sandbox.js', method: 'POST' },
  ]) {
    let nextCalled = false;
    let nextErr: unknown;
    let touched = false;
    await server1.middleware(
      req,
      {
        statusCode: 204,
        setHeader() {
          touched = true;
        },
        end() {
          touched = true;
        },
      },
      (err) => {
        nextCalled = true;
        nextErr = err;
      },
    );
    expect(nextCalled).toBe(true);
    expect(nextErr).toBeUndefined();
    expect(touched).toBe(false);
  }
  expect(buildCalls).toBe(1);

  const invoke = (
    mw: typeof server1.middleware,
    url: string,
    method: string,
    extraRes: Record<string, unknown> = {},
  ) => {
    const headers = new Map<string, string>();
    let body: string | undefined;
    let ended = false;
    let nextArgs: unknown[] | null = null;
    const res: Record<string, unknown> = {
      statusCode: 0,
      headersSent: false,
      writableEnded: false,
      destroyed: false,
      setHeader(k: string, v: string) {
        headers.set(k, v);
      },
      end(chunk?: string) {
        ended = true;
        body = chunk;
        res.writableEnded = true;
      },
      ...extraRes,
    };
    const done = mw({ url, method }, res, (...args: unknown[]) => {
      nextArgs = args;
    }).then(() => ({ statusCode: res.statusCode, headers, body, ended, nextArgs }));
    return { res, done };
  };

  // Concurrent HTML, JS, HEAD, and an already-ended client share the single in-flight build without cross-talk.
  const htmlReq = invoke(server1.middleware, '/@mermaid-sandbox.html?t=1', 'GET');
  const jsReq = invoke(server1.middleware, '/@mermaid-sandbox.js?t=1', 'GET');
  const headReq = invoke(server1.middleware, '/@mermaid-sandbox.html', 'HEAD');
  const abortedReq = invoke(server1.middleware, '/@mermaid-sandbox.js', 'GET');
  abortedReq.res.writableEnded = true;

  resolveShared({ script: 'window.__isolated = 1;' });
  const [htmlRes, jsRes, headRes, abortedRes] = await Promise.all([
    htmlReq.done,
    jsReq.done,
    headReq.done,
    abortedReq.done,
  ]);
  expect(buildCalls).toBe(1);

  expect(htmlRes.statusCode).toBe(200);
  expect(htmlRes.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
  expect(htmlRes.headers.get('Cache-Control')).toBe('no-store');
  expect(htmlRes.body).toContain('<script>window.__isolated = 1;</script>');
  expect(htmlRes.nextArgs).toBeNull();

  expect(jsRes.statusCode).toBe(200);
  expect(jsRes.headers.get('Content-Type')).toBe('application/javascript; charset=utf-8');
  expect(jsRes.headers.get('Cache-Control')).toBe('no-store');
  expect(jsRes.body).toBe('window.__isolated = 1;');
  expect(jsRes.nextArgs).toBeNull();

  expect(headRes.statusCode).toBe(200);
  expect(headRes.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
  expect(headRes.headers.get('Cache-Control')).toBe('no-store');
  expect(headRes.ended).toBe(true);
  expect(headRes.body).toBeUndefined();

  // Aborted/ended response is untouched and does not invoke next(error).
  expect(abortedRes.statusCode).toBe(0);
  expect(abortedRes.headers.size).toBe(0);
  expect(abortedRes.ended).toBe(false);
  expect(abortedRes.nextArgs).toBeNull();

  // A second dev server attached to the same plugin has its own scoped dev cache.
  const server2 = attachServer();
  expect(buildCalls).toBe(2);
  const server2Res = await invoke(server2.middleware, '/@mermaid-sandbox.js', 'GET').done;
  expect(server2Res.body).toBe('window.__sandboxGen = 2;');
  const server1Cached = await invoke(server1.middleware, '/@mermaid-sandbox.js', 'GET').done;
  expect(server1Cached.body).toBe('window.__isolated = 1;');
  expect(buildCalls).toBe(2);
});
