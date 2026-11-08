import { test, expect } from "@playwright/test";

// Local demo server: NEXT_PUBLIC_DEMO_MODE=true. No account or lead writes.
test.describe("Demo and trial entry", () => {
  test.beforeEach(async ({ page, baseURL }) => {
    test.skip(
      process.env.DEMO_ENTRY_E2E !== "1",
      "Requires the local demo configuration",
    );
    if (
      !baseURL ||
      !["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname)
    ) {
      throw new Error("Demo entry fixtures must only run on a local server");
    }
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (!["localhost", "127.0.0.1"].includes(url.hostname))
        return route.abort();
      if (url.pathname === "/api/funnel-event")
        return route.fulfill({ json: { ok: true } });
      if (url.pathname === "/api/auth/session")
        return route.fulfill({ json: {} });
      return route.continue();
    });
  });

  test("offers roles before email, recovers from rate limiting, and signs in as the selected role", async ({
    page,
    baseURL,
  }) => {
    const calls: string[] = [];
    await page.route("**/api/demo-access", (route) => {
      calls.push("rejected");
      return route.fulfill({ status: 429, json: { ok: false } });
    });
    await page.goto("/login");
    await expect(
      page.getByRole("heading", { name: "A day in your shoes." }),
    ).toBeVisible();
    await expect(page.getByRole("textbox")).toHaveCount(0);
    for (const role of [
      "Practice Admin",
      "Veterinarian",
      "Technician",
      "Front Desk",
    ]) {
      await page.getByRole("button", { name: new RegExp(`^${role}`) }).click();
      await expect(page.getByText(role, { exact: true })).toBeVisible();
      await page
        .getByRole("button", { name: "Choose a different role" })
        .click();
    }
    await page.getByRole("button", { name: /^Front Desk/ }).click();
    await page.getByLabel("Email address").fill("invalid");
    await page
      .getByRole("button", { name: "Enter the demo", exact: true })
      .click();
    expect(calls).toEqual([]);
    await page.getByLabel("Email address").fill("review@example.test");
    await page
      .getByRole("button", { name: "Enter the demo", exact: true })
      .click();
    await expect(
      page.getByRole("alert").filter({ hasText: "Please wait" }),
    ).toBeVisible();
    await page.unroute("**/api/demo-access");
    await page.route("**/api/demo-access", (route) => {
      calls.push("accepted");
      expect(route.request().postDataJSON().email).toBe("review@example.test");
      return route.fulfill({ json: { ok: true } });
    });
    await page.route("**/api/auth/providers", (route) =>
      route.fulfill({
        json: {
          demo: {
            id: "demo",
            name: "demo",
            type: "credentials",
            signinUrl: `${baseURL}/api/auth/signin/demo`,
            callbackUrl: `${baseURL}/api/auth/callback/demo`,
          },
        },
      }),
    );
    await page.route("**/api/auth/csrf", (route) =>
      route.fulfill({ json: { csrfToken: "local-test-fixture" } }),
    );
    await page.route("**/api/auth/callback/demo", (route) => {
      calls.push("sign-in");
      expect(new URLSearchParams(route.request().postData()!).get("role")).toBe(
        "front_desk",
      );
      return route.fulfill({ json: { url: `${baseURL}/demo-start` } });
    });
    await page.route("**/demo-start*", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<html><body><h1>Local signed-in destination fixture</h1></body></html>",
      }),
    );
    await page
      .getByRole("button", { name: "Enter the demo", exact: true })
      .click();
    await expect(page).toHaveURL(/\/demo-start/);
    expect(calls).toEqual(["rejected", "accepted", "sign-in"]);
  });

});
