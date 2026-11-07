import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  outputDir: "outputs/jayne-hosted-followup/test-results",
  testMatch: "jayne-hosted-followup.spec.ts",
  workers: 1,
  timeout: 120_000,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 900 } } },
    {
      name: "iphone-webkit",
      use: { ...devices["iPhone 13"], browserName: "webkit" },
    },
  ],
  reporter: [
    ["list"],
    [
      "html",
      { outputFolder: "outputs/jayne-hosted-followup/report", open: "never" },
    ],
  ],
});
