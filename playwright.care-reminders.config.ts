import { defineConfig } from "@playwright/test";

const baseURL = "http://127.0.0.1:3107";
const secret =
  process.env.NEXTAUTH_SECRET ??
  "playwright-care-reminder-bulk-outreach-secret";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "care-reminder-bulk-outreach.spec.ts",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  use: { baseURL },
  webServer: {
    command: "pnpm --filter @openpims/web exec next dev -p 3107",
    url: baseURL,
    timeout: 180_000,
    reuseExistingServer: false,
    env: {
      ...process.env,
      NEXTAUTH_SECRET: secret,
      NEXTAUTH_URL: baseURL,
      CARE_REMINDER_BULK_E2E: "1",
      DATABASE_URL:
        process.env.DATABASE_URL ??
        "postgres://openvpm:openvpm@127.0.0.1:5432/openvpm_playwright",
    },
  },
});
