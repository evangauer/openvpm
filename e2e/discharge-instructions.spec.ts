import { expect, test, type Page } from "@playwright/test";

const path = "/tools/discharge-instructions";
const clinicalEmail = process.env.DISCHARGE_DRILL_CLINICAL_EMAIL;
const frontDeskEmail = process.env.DISCHARGE_DRILL_FRONT_DESK_EMAIL;
const password = process.env.DISCHARGE_DRILL_PASSWORD;

async function signIn(page: Page, email: string) {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password!);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("keeps the requested handout destination through sign-in", async ({
  page,
}) => {
  await page.goto(path);
  await expect(page).toHaveURL(
    (url) => url.pathname === "/login" && url.searchParams.get("next") === path,
  );
});

test("creates and reviews a chartless handout, copies the edited text, and prints only the handout", async ({
  page,
  context,
  baseURL,
}) => {
  test.skip(
    !clinicalEmail || !password,
    "Requires a local clinical staff fixture",
  );
  await page.goto("/login?next=/schedule");
  await signIn(page, clinicalEmail!);
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "Discharge instructions" }).click();
  await expect(page).toHaveURL((url) => url.pathname === path);
  const leaked: string[] = [];
  page.on("request", (request) => {
    if ((request.url() + (request.postData() ?? "")).includes("Clover-QA"))
      leaked.push(request.url());
  });
  await expect(
    page.getByRole("button", { name: "Review handout" }),
  ).toBeDisabled();
  await page.getByLabel("Patient name").fill("Clover-QA");
  await page
    .getByLabel("Home care")
    .fill("Keep today's paper handout.\n\nBring it to the next visit.");
  await page.getByLabel("Follow-up").fill("Call on Friday.");
  await page.getByRole("button", { name: "Review handout" }).click();
  const handout = page.getByRole("article", { name: "Owner handout" });
  await expect(handout).toContainText("Clover-QA");
  await expect(handout.getByText("When to call the clinic")).toHaveCount(0);
  await page.getByRole("button", { name: "Edit instructions" }).click();
  await page.getByLabel("Follow-up").fill("Call on Monday.");
  await page.getByRole("button", { name: "Review handout" }).click();
  // Browser clipboard permission can stay pending. The user must still be
  // looking at the same patient's reviewed handout when copy succeeds.
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: () =>
          new Promise<void>((resolve) =>
            window.addEventListener("resolve-copy", () => resolve(), {
              once: true,
            }),
          ),
      },
    });
  });
  await page.getByRole("button", { name: "Copy instructions" }).click();
  await expect(
    page.getByRole("button", { name: "Edit instructions" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Start another handout" }),
  ).toBeDisabled();
  await page.evaluate(() => {
    window.dispatchEvent(new Event("resolve-copy"));
    Reflect.deleteProperty(navigator, "clipboard");
  });
  await expect(
    page.getByRole("button", { name: "Edit instructions" }),
  ).toBeEnabled();
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(baseURL!).origin,
  });
  await page.getByRole("button", { name: "Copy instructions" }).click();
  await expect(page.getByRole("status")).toContainText("Copied.");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("Discharge instructions for Clover-QA");
  expect(copied).toContain("Follow-up\nCall on Monday.");
  expect(copied).not.toContain("Friday");
  await page.evaluate(() => {
    window.print = () =>
      document.body.setAttribute("data-print-called", "true");
  });
  await page.getByRole("button", { name: "Print handout" }).click();
  await expect(page.locator("body")).toHaveAttribute(
    "data-print-called",
    "true",
  );
  await page.emulateMedia({ media: "print" });
  await expect(handout).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Return to your practice" }),
  ).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Edit instructions" }),
  ).toBeHidden();
  await page.emulateMedia({ media: "screen" });
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    }),
  );
  await page.getByRole("button", { name: "Copy instructions" }).click();
  await expect(
    page.getByRole("textbox", { name: "Instructions to copy" }),
  ).toHaveValue(copied);
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toMatch(/Leaving clears/);
    await dialog.dismiss();
  });
  await page.getByRole("link", { name: "Return to your practice" }).click();
  await expect(handout).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Start another handout" }).click();
  await expect(page.getByLabel("Patient name")).toHaveValue("");
  await expect(page.getByLabel("Follow-up")).toHaveValue("");
  expect(leaked).toEqual([]);
});

test("protects direct access for a front-desk account", async ({ page }) => {
  test.skip(
    !frontDeskEmail || !password,
    "Requires a local front-desk fixture",
  );
  await page.goto(path);
  await signIn(page, frontDeskEmail!);
  await expect(
    page.getByText(
      "A veterinarian, technician, or practice administrator can prepare a handout.",
    ),
  ).toBeVisible();
  await expect(page.getByLabel("Home care")).toHaveCount(0);
});
