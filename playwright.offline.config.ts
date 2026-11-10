import { defineConfig, devices } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

// Each invocation owns its server, database and private fixture manifest.
const runDirectory = process.env.OFFLINE_E2E_DIRECTORY ?? path.join(tmpdir(), `openvpm-offline-${randomUUID()}`);
process.env.OFFLINE_E2E_DIRECTORY = runDirectory;
const baseURL = "http://127.0.0.1:3457";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "offline-workspace.spec.ts",
  outputDir: process.env.OFFLINE_E2E_ARTIFACT_DIRECTORY ?? path.join(runDirectory, "results"),
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL,
    serviceWorkers: "allow",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit-ipad", use: { ...devices["iPad Pro 11"], browserName: "webkit" } },
  ],
  webServer: {
    command: "node e2e/offline/server.mjs",
    url: `${baseURL}/api/auth/csrf`,
    reuseExistingServer: false,
    timeout: 180_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 15_000 },
  },
});
