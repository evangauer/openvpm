import { defineConfig } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
const webServerCommand =
  process.env.PLAYWRIGHT_WEB_SERVER_COMMAND ??
  "pnpm dev --filter=@openpims/web";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  webServer: {
    command: webServerCommand,
    url: baseURL,
    // The ambulatory acceptance spec mutates a disposable clinical record and
    // must never attach to a pre-existing server with an unknown DATABASE_URL.
    reuseExistingServer:
      process.env.AMBULATORY_E2E === "1" ? false : !process.env.CI,
    timeout: 30000,
  },
});
