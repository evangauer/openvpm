import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Restore drill (run manually, not in CI): registers a fresh practice on a
 * fresh database and restores a real practice backup through the Settings UI,
 * timing each phase. Point PLAYWRIGHT_BASE_URL at a dev server whose
 * DATABASE_URL is an empty, freshly-migrated database, and set
 * RESTORE_DRILL_BACKUP to the backup JSON path.
 *
 *   RESTORE_DRILL_BACKUP=/path/to/backup.json \
 *   PLAYWRIGHT_BASE_URL=http://localhost:3009 \
 *   pnpm exec playwright test e2e/restore-drill.spec.ts
 */

const backupPath = process.env.RESTORE_DRILL_BACKUP ?? "";
const shotDir = process.env.RESTORE_DRILL_SHOTS ?? "restore-drill-shots";
const drillEmail = `drill-admin-${Date.now()}@openpims.dev`;
const drillPassword = "DrillRestore123!";

function shot(name: string): string {
  return path.join(shotDir, name);
}

test.describe("Restore drill", () => {
  test.skip(!backupPath, "Set RESTORE_DRILL_BACKUP to run the drill");

  test("fresh practice restores a real backup through the UI", async ({ page }) => {
    test.setTimeout(180_000);
    const timings: Record<string, number> = {};

    // Keep the first-login welcome overlay closed for the drill: report the
    // welcome as already seen for any user id (it is keyed per user).
    await page.addInitScript(() => {
      const realGetItem = Storage.prototype.getItem;
      Storage.prototype.getItem = function (key: string) {
        if (typeof key === "string" && key.startsWith("ovpm.welcome.v1.")) {
          return JSON.stringify({ seenAt: "2026-01-01T00:00:00.000Z" });
        }
        return realGetItem.call(this, key);
      };
    });

    // Phase 1: register a fresh practice on the empty database.
    let t = Date.now();
    await page.goto("/register");
    await page.getByLabel(/practice name/i).fill("Restore Drill Clinic");
    await page.getByLabel(/work email/i).fill(drillEmail);
    await page.getByLabel(/password/i).fill(drillPassword);
    await page.getByRole("button", { name: /create workspace/i }).click();
    await expect(page).toHaveURL(
      (url) => url.pathname === "/" || url.pathname.startsWith("/login"),
      { timeout: 45_000 }
    );
    if (page.url().includes("/login")) {
      await page.getByLabel(/email/i).fill(drillEmail);
      await page.getByLabel(/password/i).fill(drillPassword);
      await page.getByRole("button", { name: /sign in/i }).click();
      await expect(page).toHaveURL((url) => url.pathname === "/", {
        timeout: 30_000,
      });
    }
    timings.registerMs = Date.now() - t;
    await page.screenshot({ path: shot("01-fresh-practice.png"), fullPage: false });

    // Dismiss the first-login welcome overlay whenever it appears (it can
    // auto-open again on a fresh page load).
    const dismissWelcome = async () => {
      const dialog = page.getByRole("dialog", { name: /welcome to openvpm/i });
      if (await dialog.isVisible({ timeout: 8_000 }).catch(() => false)) {
        await dialog.getByRole("button", { name: /skip for now/i }).click();
        await expect(dialog).not.toBeVisible({ timeout: 10_000 });
      }
    };
    await dismissWelcome();

    // Phase 2: Settings → Data → upload backup → automatic dry run.
    t = Date.now();
    await page.goto("/settings");
    await dismissWelcome();
    await page.getByRole("button", { name: /^data$/i }).click();
    await expect(
      page.getByRole("heading", { name: /restore full backup/i })
    ).toBeVisible({ timeout: 15_000 });

    // New practices are seeded with sample pets, and the restore requires an
    // empty practice — remove the sample data first (part of the runbook).
    await page.getByRole("button", { name: /remove sample data/i }).click();
    await expect(page.getByText(/sample data removed/i)).toBeVisible({
      timeout: 20_000,
    });

    await page.setInputFiles('input[type="file"][accept*="json"]', backupPath);
    await expect(page.getByText("Verified", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    timings.dryRunMs = Date.now() - t;
    await expect(page.getByText(/rows detected/i)).toBeVisible();
    await page
      .getByRole("heading", { name: /restore full backup/i })
      .scrollIntoViewIfNeeded();
    await page.screenshot({ path: shot("02-dry-run-verified.png"), fullPage: true });

    // Phase 3: confirm fresh practice and run the live restore.
    await page
      .getByRole("checkbox", {
        name: /I confirm this practice has no live clients/i,
      })
      .click();
    await expect(
      page.getByRole("button", { name: /restore into fresh practice/i })
    ).toBeEnabled({ timeout: 10_000 });
    t = Date.now();
    await page
      .getByRole("button", { name: /restore into fresh practice/i })
      .click();
    await expect(page.getByText(/^Restored [\d,]+ rows$/).first()).toBeVisible({
      timeout: 60_000,
    });
    timings.restoreMs = Date.now() - t;
    const restoredText = await page
      .getByText(/^Restored [\d,]+ rows$/)
      .first()
      .textContent();
    await page.screenshot({ path: shot("03-restore-complete.png"), fullPage: true });

    // Phase 4: verify the clinic's data is really back, using rows from the
    // backup itself so the drill works with any practice's backup file.
    const backup = JSON.parse(readFileSync(backupPath, "utf8")) as {
      clients: { firstName: string; lastName: string }[];
      patients: { id: string; name: string }[];
    };
    const firstClient = backup.clients[0];
    const firstPatient = backup.patients[0];

    await page.goto("/clients");
    await expect(
      page
        .getByText(new RegExp(`${firstClient.firstName}\\s+${firstClient.lastName}`, "i"))
        .first()
    ).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: shot("04-clients-restored.png"), fullPage: false });

    await page.goto(`/patients/${firstPatient.id}`);
    await expect(
      page.getByText(new RegExp(firstPatient.name, "i")).first()
    ).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: shot("05-patient-chart.png"), fullPage: true });

    console.log("RESTORE_DRILL_RESULT", JSON.stringify({ ...timings, restoredText }));
  });
});
