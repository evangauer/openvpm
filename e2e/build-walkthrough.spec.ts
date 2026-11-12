import { test, expect } from "@playwright/test";

// Run with a local hosted-mode server and an annual price fixture. These tests
// only exercise the walkthrough; they do not register or start checkout.
test.describe("Hosted build walkthrough regressions", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(process.env.BUILD_WALKTHROUGH_E2E !== "1", "Requires local hosted configuration");
    await page.route("**/api/funnel-event", route => route.fulfill({ status: 200, body: "{}" }));
    await page.addInitScript(() => {
      localStorage.setItem("openvpm.cookie-consent.v1", "essential");
      if (!localStorage.getItem("openvpm_build_v1")) {
        localStorage.setItem("openvpm_build_v1", JSON.stringify({ scene: 8, state: {
          practiceType: "mobile", currentSystem: "paper", clinicName: "Synthetic clinic",
          brandColor: "#0d9488", services: [{ name: "House-Call Exam", price: 135, on: true }, { name: "Trip Fee", price: 45, on: false }],
        } }));
      }
    });
  });

  test("keeps annual billing when navigating back and reloading", async ({ page }) => {
    await page.goto("/start");
    const annual = page.getByRole("radio", { name: /annual/i });
    await annual.click();
    await expect(annual).toHaveAttribute("aria-checked", "true");
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await page.getByRole("button", { name: "See my clinic", exact: true }).click();
    await expect(annual).toHaveAttribute("aria-checked", "true");
    await page.reload();
    await expect(annual).toHaveAttribute("aria-checked", "true");
  });

  test("explains expired resume links and retains the local clinic", async ({ page }) => {
    await page.route("**/api/growth/build-resume?*", route => route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"Link expired"}' }));
    await page.goto("/start?resume=expired-synthetic-token");
    await expect(page.getByRole("alert").filter({ hasText: "saved-progress link" })).toContainText("expired");
    await expect(page.getByText("Synthetic clinic", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("radio", { name: /monthly/i })).toBeVisible();
  });
});
