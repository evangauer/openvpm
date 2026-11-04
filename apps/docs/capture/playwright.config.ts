import { defineConfig } from "@playwright/test";

// Captures guide screenshots from a locally running, freshly seeded OpenVPM.
// See capture/README.md for the full run.
const baseURL = process.env.DOCS_CAPTURE_URL ?? "http://localhost:3100";

// The run changes data (it turns on a calendar feed and uploads a document),
// so it only ever points at an app on this machine.
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname)) {
  throw new Error(`Refusing to capture from ${baseURL}. Captures only run against a local, seeded OpenVPM.`);
}

export default defineConfig({
  testDir: ".",
  testMatch: "capture.spec.ts",
  timeout: 30 * 60_000,
  workers: 1,
  reporter: "list",
  use: {
    baseURL,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    colorScheme: "light",
    locale: "en-US",
    timezoneId: process.env.TZ ?? "America/New_York",
    actionTimeout: 10_000,
  },
});
