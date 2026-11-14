import { defineConfig, devices } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

// Each invocation owns its server, database and private fixture manifest.
const runDirectory =
  process.env.OFFLINE_E2E_DIRECTORY ??
  path.join(tmpdir(), `openvpm-offline-${randomUUID()}`);
process.env.OFFLINE_E2E_DIRECTORY = runDirectory;
const baseURL =
  process.env.OFFLINE_E2E_SERVER_MODE === "production"
    ? "https://127.0.0.1:3457"
    : "http://127.0.0.1:3457";
process.env.OFFLINE_E2E_BASE_URL = baseURL;

export default defineConfig({
  testDir: "./e2e",
  testMatch: ["offline-workspace.spec.ts", "offline-field.spec.ts"],
  outputDir:
    process.env.OFFLINE_E2E_ARTIFACT_DIRECTORY ??
    path.join(runDirectory, "results"),
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL,
    // Synthetic clinics and appointment dates use UTC. Keep the browser on the
    // same day even when the developer's machine crosses local/UTC midnight.
    timezoneId: "UTC",
    serviceWorkers: "allow",
    ignoreHTTPSErrors: true, // Only the disposable loopback certificate.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args: baseURL.startsWith("https:")
            ? ["--ignore-certificate-errors"]
            : [],
        },
      },
    },
    {
      name: "webkit-ipad",
      use: { ...devices["iPad Pro 11"], browserName: "webkit" },
    },
    {
      name: "chromium-phone",
      testMatch: "offline-field.spec.ts",
      grep: /sidebar|pinning remains|guided field/,
      use: {
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        launchOptions: {
          args: baseURL.startsWith("https:")
            ? ["--ignore-certificate-errors"]
            : [],
        },
      },
    },
  ],
  webServer: {
    command: "node e2e/offline/server.mjs",
    url: `${baseURL}/api/auth/csrf`,
    reuseExistingServer: false,
    ignoreHTTPSErrors: true,
    timeout:
      process.env.OFFLINE_E2E_SERVER_MODE === "production" ? 300_000 : 180_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 15_000 },
  },
});
