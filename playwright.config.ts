import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: "./e2e", timeout: 60_000, workers: 1, use: { baseURL: "http://127.0.0.1:1420", headless: true }, webServer: { command: "npm run dev -- --host 127.0.0.1", url: "http://127.0.0.1:1420", reuseExistingServer: true }, reporter: "list" });
