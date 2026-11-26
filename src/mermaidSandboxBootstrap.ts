export const HOST_BRIDGE_GLOBALS = [
  "SuperMD",
  "qt",
  "QWebChannel",
  "__TAURI__",
  "__TAURI_INTERNALS__",
  "__TAURI_IPC__",
  "isTauri",
] as const;

export function scrubSandboxHostBridges(scope: Record<string, unknown>): void {
  for (const key of HOST_BRIDGE_GLOBALS) {
    let existing: unknown;
    try {
      existing = scope[key];
    } catch {
      existing = undefined;
    }

    let deleted = false;
    try {
      deleted = Reflect.deleteProperty(scope, key);
    } catch {
      deleted = false;
    }

    // Some WebView hosts (such as Windows WebView2 initialization scripts) define
    // bridge containers as non-configurable properties on window. Neutralize their
    // own methods/fields when the outer binding cannot be deleted.
    if ((!deleted || key in scope) && existing && (typeof existing === "object" || typeof existing === "function")) {
      const container = existing as Record<PropertyKey, unknown>;
      let keys: PropertyKey[] = [];
      try {
        keys = Reflect.ownKeys(container);
      } catch {
        keys = [];
      }
      for (const prop of keys) {
        try {
          Reflect.deleteProperty(container, prop);
        } catch {
          // Ignore non-configurable inner properties.
        }
        try {
          Object.defineProperty(container, prop, {
            value: undefined,
            writable: false,
            configurable: false,
            enumerable: false,
          });
        } catch {
          // Best-effort lockdown.
        }
      }
    }

    try {
      Object.defineProperty(scope, key, {
        value: undefined,
        writable: false,
        configurable: false,
        enumerable: false,
      });
    } catch {
      // Non-configurable host property was already scrubbed in place above.
    }
  }
}
