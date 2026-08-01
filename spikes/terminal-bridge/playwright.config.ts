import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/e2e",
  timeout: 150_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4174",
    channel: "chrome",
    headless: true,
    viewport: { width: 1280, height: 900 },
    launchOptions: { args: ["--js-flags=--expose-gc"] },
  },
  webServer: {
    command: "npm run start -- --cwd ../.. --fixture --port 4174 --buffer-bytes 1048576",
    url: "http://127.0.0.1:4174/spike/diagnostics",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
