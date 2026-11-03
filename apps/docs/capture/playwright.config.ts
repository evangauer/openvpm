import { defineConfig } from "@playwright/test";

// Captures guide screenshots from a locally running, freshly seeded OpenVPM.
// See capture/README.md for the full run.
export default defineConfig({
  testDir: ".",
  testMatch: "capture.spec.ts",
  timeout: 30 * 60_000,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: process.env.DOCS_CAPTURE_URL ?? "http://localhost:3100",
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    colorScheme: "light",
    locale: "en-US",
    timezoneId: process.env.TZ ?? "America/New_York",
    actionTimeout: 10_000,
  },
});
