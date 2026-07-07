import { test, expect, type Page } from "@playwright/test";
import path from "path";
import fs from "fs";

/**
 * Phase 0 visual baseline: capture every screen at desktop AND tablet widths
 * with a per-route report (HTTP status, console errors, empty-state signals).
 *
 * Run against a locally seeded instance:
 *   BASELINE_URL=http://localhost:3000 \
 *   BASELINE_PORTAL_TOKEN=<clients.access_token from the demo practice> \
 *   pnpm playwright test e2e/baseline-screenshots.spec.ts
 */

const BASE = process.env.BASELINE_URL ?? "http://localhost:3000";
const OUT = path.resolve(__dirname, "../docs/screenshots/baseline");
const PORTAL_TOKEN = process.env.BASELINE_PORTAL_TOKEN;
const ADMIN_EMAIL =
  process.env.BASELINE_EMAIL ?? "admin@neighborhoodvet.example.com";
const ADMIN_PASSWORD = process.env.BASELINE_PASSWORD ?? "password123";

const WIDTHS = [
  { name: "desktop", viewport: { width: 1440, height: 900 } },
  { name: "tablet", viewport: { width: 768, height: 1024 } },
] as const;

const APP_ROUTES: { slug: string; route: string }[] = [
  { slug: "dashboard", route: "/" },
  { slug: "patients", route: "/patients" },
  { slug: "clients", route: "/clients" },
  { slug: "schedule", route: "/schedule" },
  { slug: "records", route: "/records" },
  { slug: "billing", route: "/billing" },
  { slug: "inventory", route: "/inventory" },
  { slug: "inbox", route: "/inbox" },
  { slug: "whiteboard", route: "/whiteboard" },
  { slug: "controlled-substances", route: "/controlled-substances" },
  { slug: "reports", route: "/reports" },
  { slug: "settings", route: "/settings" },
  { slug: "agent", route: "/agent" },
];

const EMPTY_STATE_WORDS = [
  "No upcoming",
  "No data",
  "No records",
  "No messages",
  "No patients found",
  "No clients",
  "No results",
  "Nothing here",
  "No items",
];

interface RouteResult {
  slug: string;
  route: string;
  status: number | "nav-failed";
  consoleErrors: string[];
  emptyHits: string[];
  horizontalOverflow: boolean;
}

test.use({ baseURL: BASE });
test.describe.configure({ mode: "serial" });

async function login(page: Page): Promise<void> {
  await page.goto("/login", { waitUntil: "networkidle" });
  await page.fill("#email", ADMIN_EMAIL);
  await page.fill("#password", ADMIN_PASSWORD);
  await Promise.all([
    page.waitForURL((url) => url.pathname === "/", { timeout: 30_000 }),
    page.click('button[type="submit"]'),
  ]);
  // Dismiss first-run overlays so screenshots show the screens themselves.
  // "I'll finish later" persists journeyDismissed server-side; the cookie
  // choice persists per browser context.
  await page.waitForTimeout(1500);
  const cookieBtn = page.getByRole("button", { name: /essential only/i });
  if (await cookieBtn.isVisible().catch(() => false)) {
    await cookieBtn.click();
    await page.waitForTimeout(300);
  }
  const finishLater = page.getByText(/finish later/i).first();
  if (await finishLater.isVisible().catch(() => false)) {
    await finishLater.click();
    await page.waitForTimeout(800);
  }
}

function makeErrorCollector(page: Page): { errors: string[] } {
  const collector = { errors: [] as string[] };
  page.on("pageerror", (err) => collector.errors.push(err.message.slice(0, 300)));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (
      text.includes("Download the React DevTools") ||
      text.includes("Content-Security-Policy") ||
      text.includes("Failed to load resource: the server responded with a status of 404") // favicon etc. noise stays visible in report via pageerror only
    ) {
      return;
    }
    collector.errors.push(text.slice(0, 300));
  });
  return collector;
}

async function captureRoute(
  page: Page,
  collector: { errors: string[] },
  widthName: string,
  slug: string,
  route: string,
  results: RouteResult[]
): Promise<void> {
  const startErrors = collector.errors.length;
  const response = await page
    .goto(route, { waitUntil: "networkidle", timeout: 30_000 })
    .catch((e) => {
      collector.errors.push(`navigation error: ${String(e.message).slice(0, 200)}`);
      return null;
    });
  await page.waitForTimeout(1200);
  const bodyText =
    (await page
      .locator("main, [role=main], body")
      .first()
      .textContent()
      .catch(() => "")) ?? "";
  // Any page that forces the body wider than the viewport fails the
  // responsive bar (tables must scroll inside their own container).
  const horizontalOverflow = await page
    .evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth + 1
    )
    .catch(() => false);
  await page
    .screenshot({
      path: path.join(OUT, widthName, `${slug}.png`),
      fullPage: true,
    })
    .catch(async () => {
      // Full-page capture can fail on very tall pages; fall back to viewport.
      await page
        .screenshot({ path: path.join(OUT, widthName, `${slug}.png`) })
        .catch(() => {});
    });
  results.push({
    slug,
    route,
    status: response?.status() ?? "nav-failed",
    consoleErrors: collector.errors.slice(startErrors),
    emptyHits: EMPTY_STATE_WORDS.filter((w) => bodyText.includes(w)),
    horizontalOverflow,
  });
}

async function captureFirstRowDetail(
  page: Page,
  collector: { errors: string[] },
  widthName: string,
  listRoute: string,
  slug: string,
  urlPattern: RegExp,
  results: RouteResult[]
): Promise<void> {
  await page.goto(listRoute, { waitUntil: "networkidle" }).catch(() => {});
  await page.waitForTimeout(800);
  const firstRow = page.locator("table tbody tr").first();
  if ((await firstRow.count()) === 0) return;
  const startErrors = collector.errors.length;
  await firstRow.click();
  const navigated = await page
    .waitForURL(urlPattern, { timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!navigated) return;
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1500);
  const horizontalOverflow = await page
    .evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth + 1
    )
    .catch(() => false);
  await page
    .screenshot({
      path: path.join(OUT, widthName, `${slug}.png`),
      fullPage: true,
    })
    .catch(() => {});
  results.push({
    slug,
    route: new URL(page.url()).pathname.replace(/[a-f0-9-]{16,}/g, "[id]"),
    status: 200,
    consoleErrors: collector.errors.slice(startErrors),
    emptyHits: [],
    horizontalOverflow,
  });
}

function writeReport(widthName: string, rawResults: RouteResult[]): void {
  // Reports are committed to the (public) repo; never persist the portal
  // access token, even though it only exists in a local dev database.
  const results = PORTAL_TOKEN
    ? rawResults.map((r) => ({
        ...r,
        route: r.route.split(PORTAL_TOKEN).join("[token]"),
      }))
    : rawResults;
  fs.mkdirSync(path.join(OUT, widthName), { recursive: true });
  fs.writeFileSync(
    path.join(OUT, `report-${widthName}.json`),
    JSON.stringify(results, null, 2)
  );
  console.log(`\n=== ${widthName} route audit ===`);
  for (const r of results) {
    console.log(
      `${r.route}: HTTP ${r.status}` +
        (r.consoleErrors.length > 0 ? ` ⚠️ ${r.consoleErrors.length} error(s)` : "") +
        (r.horizontalOverflow ? " ↔️ horizontal overflow" : "") +
        (r.emptyHits.length > 0 ? ` · empty: ${r.emptyHits.join(", ")}` : "")
    );
    for (const err of r.consoleErrors) console.log(`    [err] ${err}`);
  }
}

for (const width of WIDTHS) {
  test(`baseline screenshots — ${width.name}`, async ({ page }) => {
    test.setTimeout(600_000);
    await page.setViewportSize(width.viewport);
    fs.mkdirSync(path.join(OUT, width.name), { recursive: true });

    const collector = makeErrorCollector(page);
    const results: RouteResult[] = [];

    await login(page);

    for (const { slug, route } of APP_ROUTES) {
      await captureRoute(page, collector, width.name, slug, route, results);
    }

    await captureFirstRowDetail(
      page,
      collector,
      width.name,
      "/patients",
      "patient-detail",
      /\/patients\/[a-f0-9-]{8,}/,
      results
    );
    await captureFirstRowDetail(
      page,
      collector,
      width.name,
      "/clients",
      "client-detail",
      /\/clients\/[a-f0-9-]{8,}/,
      results
    );

    if (PORTAL_TOKEN) {
      const portalPages = [
        { slug: "portal-home", route: `/portal/${PORTAL_TOKEN}` },
        { slug: "portal-book", route: `/portal/${PORTAL_TOKEN}/book` },
        { slug: "portal-messages", route: `/portal/${PORTAL_TOKEN}/messages` },
        {
          slug: "portal-appointments",
          route: `/portal/${PORTAL_TOKEN}/appointments`,
        },
        { slug: "portal-invoices", route: `/portal/${PORTAL_TOKEN}/invoices` },
      ];
      for (const { slug, route } of portalPages) {
        await captureRoute(page, collector, width.name, slug, route, results);
      }
      // Pet detail: follow the first pet link from the portal home page.
      await page
        .goto(`/portal/${PORTAL_TOKEN}`, { waitUntil: "networkidle" })
        .catch(() => {});
      const petLink = page.locator('a[href*="/pets/"]').first();
      if ((await petLink.count()) > 0) {
        const href = await petLink.getAttribute("href");
        if (href) {
          await captureRoute(
            page,
            collector,
            width.name,
            "portal-pet-detail",
            href,
            results
          );
        }
      }
    } else {
      console.log("BASELINE_PORTAL_TOKEN not set — skipping portal pages");
    }

    writeReport(width.name, results);

    const failed = results.filter((r) => r.status !== 200);
    expect(
      failed,
      `routes not returning 200: ${failed.map((r) => r.route).join(", ")}`
    ).toEqual([]);
  });
}
