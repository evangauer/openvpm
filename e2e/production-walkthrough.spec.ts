import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

/**
 * Full visual walkthrough + route audit of a data-rich seeded clinic
 * (Neighborhood Veterinary). Captures a full-page screenshot of every screen
 * plus key detail pages, and records per-route HTTP status, console/page
 * errors, and empty-state signals into a JSON summary for review.
 *
 * Run against the local hosted app:
 *   PLAYWRIGHT_BASE_URL=http://localhost:3003 pnpm exec playwright test \
 *     e2e/production-walkthrough.spec.ts --reporter=line --workers=1
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3003";
const OUT = path.resolve(__dirname, "../test-results", process.env.WALKTHROUGH_OUT ?? "walkthrough");
const ADMIN_EMAIL = process.env.WALKTHROUGH_EMAIL ?? "admin@neighborhoodvet.example.com";
const ADMIN_PASSWORD = process.env.WALKTHROUGH_PASSWORD ?? "password123";

test.use({
  baseURL: BASE,
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 1,
});

test.describe.configure({ mode: "serial" });

type RouteResult = {
  name: string;
  route: string;
  status: number | string;
  errors: string[];
  emptyHits: string[];
  bodyChars: number;
  shot: string;
};

const EMPTY_WORDS = [
  "No upcoming",
  "No data",
  "No records",
  "No messages",
  "No patients found",
  "No clients",
  "No results",
  "Nothing here",
  "No appointments",
  "No invoices",
  "Coming soon",
];

test("visual walkthrough + route audit of a seeded clinic", async ({ page }) => {
  test.setTimeout(300_000);
  fs.mkdirSync(OUT, { recursive: true });

  const errors: { route: string; msg: string }[] = [];
  page.on("pageerror", (err) => errors.push({ route: page.url(), msg: err.message }));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (
      text.includes("Download the React DevTools") ||
      text.includes("Content-Security-Policy") ||
      text.includes("favicon")
    )
      return;
    errors.push({ route: page.url(), msg: text.slice(0, 240) });
  });

  await page.addInitScript(() => {
    window.localStorage.setItem("openvpm.cookie-consent.v1", "essential");
  });

  // Login
  await page.goto("/login", { waitUntil: "networkidle" });
  await page.fill("#email", ADMIN_EMAIL);
  await page.fill("#password", ADMIN_PASSWORD);
  await Promise.all([
    page.waitForURL((url) => url.pathname === "/", { timeout: 30_000 }),
    page.click('button[type="submit"]'),
  ]);
  await page.waitForLoadState("networkidle");

  const results: RouteResult[] = [];

  async function capture(name: string, route: string, prep?: (p: Page) => Promise<void>) {
    const startErrors = errors.length;
    let status: number | string = "n/a";
    if (route) {
      const response = await page
        .goto(route, { waitUntil: "networkidle", timeout: 25_000 })
        .catch((e) => {
          errors.push({ route, msg: `navigation error: ${e.message}` });
          return null;
        });
      status = response?.status() ?? "nav-failed";
    }
    await page.waitForTimeout(1500);
    if (prep) await prep(page).catch((e) => errors.push({ route, msg: `prep: ${e.message}` }));
    await page.waitForTimeout(600);
    const bodyText =
      (await page.locator("main, [role=main], body").first().textContent().catch(() => "")) ?? "";
    const shot = `${name}.png`;
    await page.screenshot({ path: path.join(OUT, shot), fullPage: true }).catch(() => {});
    results.push({
      name,
      route: route || page.url(),
      status,
      errors: errors.slice(startErrors).map((e) => e.msg),
      emptyHits: EMPTY_WORDS.filter((w) => bodyText.includes(w)),
      bodyChars: bodyText.length,
      shot,
    });
  }

  // Every sidebar screen
  await capture("01-dashboard", "/");
  await capture("02-schedule", "/schedule");
  await capture("03-clients", "/clients");
  await capture("04-patients", "/patients");
  await capture("05-records", "/records");
  await capture("06-billing", "/billing");
  await capture("07-inventory", "/inventory");
  await capture("08-inbox", "/inbox");
  await capture("09-whiteboard", "/whiteboard");
  await capture("10-controlled-substances", "/controlled-substances");
  await capture("11-reports", "/reports");
  await capture("12-settings", "/settings");

  // Detail pages — click the first row where lists use onClick, not links.
  await capture("13-patient-detail", "/patients", async (p) => {
    const row = p.locator("table tbody tr").first();
    if ((await row.count()) > 0) {
      await row.click();
      await p.waitForURL(/\/patients\/[a-f0-9-]{8,}/, { timeout: 15_000 }).catch(() => undefined);
      await p.waitForLoadState("networkidle").catch(() => undefined);
    }
  });
  await capture("14-client-detail", "/clients", async (p) => {
    const row = p.locator("table tbody tr").first();
    if ((await row.count()) > 0) {
      await row.click();
      await p.waitForURL(/\/clients\/[a-f0-9-]{8,}/, { timeout: 15_000 }).catch(() => undefined);
      await p.waitForLoadState("networkidle").catch(() => undefined);
    }
  });
  await capture("15-invoice-detail", "/billing", async (p) => {
    const row = p.locator("table tbody tr").first();
    if ((await row.count()) > 0) {
      await row.click();
      await p.waitForLoadState("networkidle").catch(() => undefined);
    }
  });

  // Settings tabs (Plan & Billing especially, for the $79 + Connect surface)
  await capture("16-settings-billing", "/settings", async (p) => {
    const tab = p.getByText("Plan & Billing", { exact: true });
    if ((await tab.count()) > 0) {
      await tab.click();
      await p.waitForTimeout(1500);
    }
  });

  // New Appointment panel (schedule create flow)
  await capture("17-new-appointment", "/schedule", async (p) => {
    const btn = p.getByRole("button", { name: /New Appointment/i });
    if ((await btn.count()) > 0) {
      await btn.first().click();
      await p.waitForTimeout(1000);
    }
  });

  fs.writeFileSync(
    path.join(OUT, "summary.json"),
    JSON.stringify(
      {
        base: BASE,
        capturedAt: new Date().toISOString(),
        routes: results,
        totalErrors: errors.length,
        errorList: errors.map((e) => `[${e.route}] ${e.msg}`),
      },
      null,
      2
    )
  );

  console.log("\n=== Walkthrough route audit ===");
  for (const r of results) {
    console.log(
      `${r.name} (${r.route}): HTTP ${r.status}` +
        (r.errors.length ? ` ⚠️ ${r.errors.length} err` : "") +
        (r.emptyHits.length ? ` · empty: ${r.emptyHits.join(", ")}` : "") +
        ` · ${r.bodyChars} chars`
    );
  }
  if (errors.length) {
    console.log("\n=== Errors ===");
    for (const e of errors) console.log(`  [${e.route}] ${e.msg}`);
  } else {
    console.log("\nNo console/page errors detected.");
  }

  // Soft assertion: we want the report regardless, but fail loudly on a crash storm.
  expect(errors.length).toBeLessThan(50);
});
