import { test, expect } from "@playwright/test";
import path from "node:path";

/**
 * Manual live verification of e-sign consent v1 (not run in CI): staff
 * dispatch a consent from a patient chart, a second no-login browser context
 * signs it, and the signed PDF appears back on the dashboard.
 *
 *   ESIGN_DRILL_EMAIL=<admin email> ESIGN_DRILL_PASSWORD=<password> \
 *   ESIGN_DRILL_PATIENT=<patient uuid> \
 *   PLAYWRIGHT_BASE_URL=http://localhost:3009 \
 *   pnpm exec playwright test e2e/esign-consent-drill.spec.ts
 */

const email = process.env.ESIGN_DRILL_EMAIL ?? "";
const password = process.env.ESIGN_DRILL_PASSWORD ?? "";
const patientId = process.env.ESIGN_DRILL_PATIENT ?? "";
const shotDir = process.env.ESIGN_DRILL_SHOTS ?? "esign-drill-shots";

function shot(name: string): string {
  return path.join(shotDir, name);
}

test.describe("E-sign consent live drill", () => {
  test.skip(!email || !password || !patientId, "Set ESIGN_DRILL_* to run");

  test("dispatch, sign on a phone, see the signed PDF", async ({
    page,
    browser,
  }) => {
    test.setTimeout(120_000);

    await page.addInitScript(() => {
      const realGetItem = Storage.prototype.getItem;
      Storage.prototype.getItem = function (key: string) {
        if (typeof key === "string" && key.startsWith("ovpm.welcome.v1.")) {
          return JSON.stringify({ seenAt: "2026-01-01T00:00:00.000Z" });
        }
        return realGetItem.call(this, key);
      };
    });

    // Staff: log in and open the patient chart.
    await page.goto("/login");
    await page.waitForLoadState("networkidle");
    await page.getByLabel(/email/i).fill(email);
    await page.getByLabel(/password/i).fill(password);
    // Retry the submit if a pre-hydration click gets swallowed.
    await expect(async () => {
      if (new URL(page.url()).pathname === "/") return;
      await page.getByRole("button", { name: /sign in/i }).click();
      await page.waitForURL((url) => url.pathname === "/", { timeout: 20_000 });
    }).toPass({ timeout: 60_000 });

    await page.goto(`/patients/${patientId}`);
    await expect(
      page.getByRole("button", { name: /get signature/i })
    ).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: shot("01-chart-button.png") });

    // Dispatch: review the default text, mint the code.
    await page.getByRole("button", { name: /get signature/i }).click();
    await expect(
      page.getByRole("textbox", { name: /consent text/i })
    ).toBeVisible();
    await page.screenshot({ path: shot("02-review-text.png") });
    await page.getByRole("button", { name: /make the code/i }).click();
    await expect(
      page.getByRole("img", { name: /qr code for the consent signing link/i })
    ).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: shot("03-qr.png") });

    // Grab the signing URL shown under the QR.
    const urlText = await page
      .getByText(/\/sign\/[0-9a-f]{64}/)
      .textContent();
    const signUrl = urlText!.trim();

    // Client: open the link in a fresh context (no login), read, sign.
    const clientContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    const clientPage = await clientContext.newPage();
    await clientPage.goto(signUrl);
    await expect(
      clientPage.getByRole("button", { name: /agree and sign/i })
    ).toBeVisible({ timeout: 20_000 });
    await clientPage.screenshot({ path: shot("04-sign-page.png"), fullPage: true });

    await clientPage.getByLabel(/your full name/i).fill("Jordan Marsh");
    const canvas = clientPage.locator("canvas");
    const box = (await canvas.boundingBox())!;
    await clientPage.mouse.move(box.x + 40, box.y + 80);
    await clientPage.mouse.down();
    await clientPage.mouse.move(box.x + 120, box.y + 40, { steps: 12 });
    await clientPage.mouse.move(box.x + 200, box.y + 100, { steps: 12 });
    await clientPage.mouse.move(box.x + 280, box.y + 60, { steps: 12 });
    await clientPage.mouse.up();
    await clientPage.screenshot({ path: shot("05-signed-ink.png"), fullPage: true });

    await clientPage.getByRole("button", { name: /agree and sign/i }).click();
    await expect(clientPage.getByText(/all signed/i)).toBeVisible({
      timeout: 30_000,
    });
    await clientPage.screenshot({ path: shot("06-all-signed.png") });
    await clientContext.close();

    // Staff: the modal flips to signed with the PDF link (5s polling).
    await expect(page.getByText(/signed by jordan marsh/i)).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByRole("link", { name: /open the signed pdf/i })
    ).toBeVisible();
    await page.screenshot({ path: shot("07-dashboard-signed.png") });

    // The stored artifact really is a PDF.
    const pdfHref = await page
      .getByRole("link", { name: /open the signed pdf/i })
      .getAttribute("href");
    const pdfResponse = await page.request.get(pdfHref!);
    expect(pdfResponse.ok()).toBe(true);
    const pdfBody = await pdfResponse.body();
    expect(pdfBody.subarray(0, 4).toString()).toBe("%PDF");

    console.log(
      "ESIGN_DRILL_RESULT",
      JSON.stringify({ signUrl: signUrl.slice(0, 40) + "…", pdfBytes: pdfBody.length })
    );
  });
});
