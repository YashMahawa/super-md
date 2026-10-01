import { defineConfig } from "vitest/config";
export default defineConfig({ test: { exclude: ["e2e/**", "scripts/**", "node_modules/**", "**/target/**", "**/build/**"], coverage: { provider: "v8", reporter: ["text", "html", "json", "lcov"], include: ["src/**/*.ts", "src/**/*.tsx"], exclude: ["src/**/*.test.ts", "src/**/*.test.tsx"] } } });
