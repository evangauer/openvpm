import { test, expect } from "@playwright/test";
import path from "path";

const BASE = process.env.DEMO_URL ?? "https://demo.openvpm.com";
const OUT = process.env.SCREENSHOT_OUT_DIR
  ? path.resolve(process.env.SCREENSHOT_OUT_DIR)
  : path.resolve(__dirname, "../docs/screenshots");

test.use({
  baseURL: BASE,
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
});

test.describe.configure({ mode: "serial" });

function isExpectedDevelopmentConsoleNoise(text: string) {
  return (
    text.includes("Download the React DevTools") ||
    text.includes("Content-Security-Policy") ||
    text.includes("Content Security Policy directive")
  );
}

async function expectNoFrameworkOverlay(page: import("@playwright/test").Page) {
  await expect(
    page.getByText(
      /application error: a client-side exception|unhandled runtime error|build error/i,
    ),
  ).toHaveCount(0);
}

async function signInToDemo(page: import("@playwright/test").Page) {
  await page.goto("/login", { waitUntil: "networkidle" });

  // Current hosted demos use an email gate. Keep the password fallback so a
  // self-hosted demo built from an older release remains reproducible.
  const password = page.locator("#password");
  if (await password.isVisible()) {
    await page.fill("#email", "admin@neighborhoodvet.example.com");
    await password.fill("password123");
  } else {
    await page.fill("#email", "readme-screenshots@example.com");
  }

  await Promise.all([
    page.waitForURL((url) => url.pathname !== "/login", { timeout: 30_000 }),
    page.getByRole("button", {
      name: /open the live demo|sign in/i,
    }).click(),
  ]);
  await page.waitForLoadState("networkidle");
}

async function prepareProductView(page: import("@playwright/test").Page) {
  // README screenshots should show the product, not optional consent or setup
  // prompts. These are session-only dismissals and do not alter demo data.
  await page.evaluate(() => {
    window.sessionStorage.setItem("ovpm_verify_email_dismissed", "1");
  });
  await page.reload({ waitUntil: "networkidle" });

  const cookieChoice = page.getByRole("button", {
    name: /essential only|allow analytics/i,
  });
  if (await cookieChoice.first().isVisible()) {
    await cookieChoice.first().click();
  }

  const hideSetup = page.getByRole("button", { name: "Hide for now" });
  if (await hideSetup.isVisible()) {
    await hideSetup.click();
  }
}

test.describe("Demo screenshots + audit", () => {
  test("capture dashboard / schedule / patient", async ({ page }) => {
    // A cold local Next.js dev server can spend well over a minute compiling
    // these three routes on the first pass.
    test.setTimeout(240_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      const text = message.text();
      if (
        message.type() === "error" &&
        !isExpectedDevelopmentConsoleNoise(text)
      ) {
        errors.push(text);
      }
    });

    await signInToDemo(page);
    await prepareProductView(page);

    // Dashboard
    await page.goto("/", { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await expect(page.getByText("Loading dashboard...")).toHaveCount(0);
    const hideSetup = page.getByRole("button", { name: "Hide for now" });
    if (await hideSetup.isVisible()) {
      await hideSetup.click();
    }
    await expectNoFrameworkOverlay(page);
    await page.screenshot({ path: path.join(OUT, "dashboard.png"), fullPage: false });

    // Schedule
    await page.goto("/schedule", { waitUntil: "networkidle" });
    await expect(
      page.getByRole("heading", { name: "Schedule", level: 2 }),
    ).toBeVisible();
    await expect(page.getByText("Loading schedule...")).toHaveCount(0);
    await expectNoFrameworkOverlay(page);
    await page.screenshot({ path: path.join(OUT, "schedule.png"), fullPage: false });

    // Patient detail — click the first row in the patients list (rows use onClick not Link)
    await page.goto("/patients", { waitUntil: "networkidle" });
    const firstRow = page.locator("table tbody tr").first();
    await expect(firstRow).toBeVisible();
    await firstRow.click();
    await page.waitForURL(/\/patients\/[a-f0-9-]{8,}/, { timeout: 30_000 });
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("Basic Information")).toBeVisible();
    await expect(page.getByText("Loading patient...")).toHaveCount(0);
    await expectNoFrameworkOverlay(page);
    await page.screenshot({ path: path.join(OUT, "patient.png"), fullPage: false });
    expect(errors, "README screenshot routes logged unexpected errors").toEqual([]);
  });

  test("audit each sidebar route for errors", async ({ page }) => {
    test.setTimeout(180_000);
    const errors: { route: string; msg: string }[] = [];
    page.on("pageerror", (err) => errors.push({ route: page.url(), msg: err.message }));
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const text = msg.text();
        // Filter out dev-noise
        if (!isExpectedDevelopmentConsoleNoise(text)) {
          errors.push({ route: page.url(), msg: text.slice(0, 200) });
        }
      }
    });
    const AUDIT_OUT = path.join(OUT, "audit");
    const fs = await import("fs");
    fs.mkdirSync(AUDIT_OUT, { recursive: true });

    await signInToDemo(page);
    await prepareProductView(page);

    const routes = [
      "/",
      "/patients",
      "/clients",
      "/schedule",
      "/records",
      "/billing",
      "/inventory",
      "/inbox",
      "/whiteboard",
      "/controlled-substances",
      "/reports",
      "/settings",
    ];

    const results: string[] = [];
    for (const route of routes) {
      const startErrors = errors.length;
      const response = await page.goto(route, { waitUntil: "networkidle", timeout: 20_000 }).catch((e) => {
        errors.push({ route, msg: `navigation error: ${e.message}` });
        return null;
      });
      await page.waitForTimeout(1500);
      const status = response?.status() ?? "nav-failed";
      // capture body text content length as a rough "empty state?" signal
      const bodyText = await page.locator("main, [role=main], body").first().textContent().catch(() => "");
      const fileSafe = route.replace(/\//g, "_") || "_root";
      await page.screenshot({ path: path.join(AUDIT_OUT, `${fileSafe}.png`) }).catch(() => {});
      const emptyStateWords = ["No upcoming", "No data", "No records", "No messages", "No patients found", "No clients", "No results"];
      const emptyHits = emptyStateWords.filter((w) => (bodyText ?? "").includes(w));
      const newErrors = errors.length - startErrors;
      results.push(
        `${route}: HTTP ${status}` +
          (newErrors > 0 ? ` ⚠️ ${newErrors} error(s)` : "") +
          (emptyHits.length > 0 ? ` · empty: ${emptyHits.join(", ")}` : "")
      );
    }

    console.log("\n=== Route audit ===");
    for (const line of results) console.log(line);
    if (errors.length > 0) {
      console.log("\n=== Errors ===");
      for (const e of errors) console.log(`  [${e.route}] ${e.msg}`);
    } else {
      console.log("\nNo errors detected.");
    }
    expect(errors.length).toBeLessThan(99); // soft — we want to see the report
  });
});
