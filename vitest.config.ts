import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins: [
    {
      name: "supermd-mermaid-sandbox-vitest",
      resolveId(id) {
        return id === "virtual:mermaid-sandbox-url" ? "\0virtual:mermaid-sandbox-url" : null;
      },
      load(id) {
        return id === "\0virtual:mermaid-sandbox-url"
          ? 'export const sandboxScriptUrl = undefined; export default "about:blank";'
          : null;
      },
    },
  ],
  test: { exclude: ["e2e/**", "scripts/**", "agent-relay/**", "**/node_modules/**", "**/target/**", "**/build/**"], coverage: { provider: "v8", reporter: ["text", "html", "json", "lcov"], include: ["src/**/*.ts", "src/**/*.tsx"], exclude: ["src/**/*.test.ts", "src/**/*.test.tsx"] } },
});
