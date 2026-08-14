import { test, expect } from "@playwright/test";

test.describe("Registration & First-Time Setup", () => {
  const uniqueEmail = `test-${Date.now()}@openpims.dev`;

  test("can register a new practice and reach hosted checkout or the app", async ({ page }) => {
    test.setTimeout(60_000);
    await page.addInitScript(() => {
      window.localStorage.setItem("openvpm.cookie-consent.v1", "essential");
    });

    await page.goto("/register");

    await page.getByLabel(/practice name/i).fill("Test Animal Hospital");
    await page.getByLabel(/work email/i).fill(uniqueEmail);
    await page.getByLabel(/password/i).fill("TestPassword123!");

    await page.getByRole("button", { name: /create workspace/i }).click();

    // Hosted Cloud with Stripe configured sends the practice to card-collected
    // Checkout first. Self-hosted or unconfigured local billing lands directly
    // in the app or on login.
    await expect(page).toHaveURL(
      (url) =>
        url.hostname === "stripe.com" ||
        url.hostname.endsWith(".stripe.com") ||
        url.hostname === "stripe.test" ||
        url.hostname.endsWith(".stripe.test") ||
        url.pathname === "/" ||
        url.pathname.startsWith("/login"),
      { timeout: 45_000 }
    );
  });
});
