import { test, expect } from "@playwright/test";

test.describe("Authentication", () => {
  test("redirects unauthenticated users to login", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
  });

  test("login page renders correctly", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "OpenVPM" })).toBeVisible();
    await expect(page.getByText(/sign in to your practice/i)).toBeVisible();
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.getByLabel(/password/i)).toBeVisible();
  });

  test("register page renders correctly", async ({ page }) => {
    await page.goto("/register");
    await expect(
      page.getByRole("heading", { name: /create your workspace/i })
    ).toBeVisible();
    await expect(page.getByLabel(/practice name/i)).toBeVisible();
  });

  test("shows validation error on empty login", async ({ page }) => {
    await page.goto("/login");
    // Client-side validation keeps the submit button disabled until required
    // credentials are present.
    await expect(page.getByRole("button", { name: /sign in/i })).toBeDisabled();
    const emailInput = page.getByLabel(/email/i);
    await expect(emailInput).toBeVisible();
  });
});
