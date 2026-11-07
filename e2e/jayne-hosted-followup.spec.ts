import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
const enabled = process.env.JAYNE_HOSTED_E2E === "1";
test.skip(
  !enabled,
  "Requires an explicitly provisioned synthetic hosted practice",
);
test.describe.configure({ mode: "serial" });
let fixture: any;
let ids: any;
let productName: string;
let projectName: string;
async function query(page: Page, procedure: string, input: unknown) {
  const response = await page.request.get(
    `/api/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`,
  );
  const body = await response.json();
  expect(body.error, JSON.stringify(body)).toBeUndefined();
  return body.result.data.json;
}
test.beforeAll(async ({}, info) => {
  if (!enabled) return;
  fixture = JSON.parse(readFileSync(process.env.JAYNE_HOSTED_FIXTURE!, "utf8"));
  projectName = info.project.name;
  ids = fixture.cases[projectName];
  productName = ids.productName;
  if (
    !fixture.email.endsWith("@example.invalid") ||
    !fixture.practice ||
    !ids.patient
  )
    throw new Error("Synthetic fixture required");
});
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("openvpm.cookie-consent.v1", "essential");
    sessionStorage.setItem("ovpm_verify_email_dismissed", "1");
  });
  if (process.env.JAYNE_PREVIEW_ACCESS_URL)
    await page.goto(process.env.JAYNE_PREVIEW_ACCESS_URL);
  await page.goto("/login");
  await page.getByLabel("Email").fill(fixture.email);
  await page.getByLabel("Password").fill(fixture.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => url.pathname !== "/login");
  const patient = await query(page, "patients.getById", { id: ids.patient });
  expect(patient.id).toBe(ids.patient);
  expect(patient.name).toContain("Synthetic followup");
});
test.afterEach(async ({ page }, info) => {
  await page.screenshot({
    path: info.outputPath("hosted-workflow.png"),
    fullPage: true,
    animations: "disabled",
  });
});

async function prescriptionForm(page: Page) {
  await page.goto(`/records?patientId=${ids.patient}&tab=prescriptions&new=1`);
  await page
    .getByPlaceholder("e.g. Carprofen")
    .fill("Synthetic follow-up medication");
  await page.getByPlaceholder("e.g. 75 mg").fill("1.5 mL");
  await page.getByPlaceholder("e.g. Every 12 hours").fill("Once daily");
  await page
    .getByRole("combobox", { name: "Inventory item", exact: true })
    .click();
  await page
    .getByPlaceholder("Search inventory by name or SKU...")
    .fill(productName);
  await page.getByRole("option").filter({ hasText: productName }).click();
}

test("large catalog supports browsing, remote search, no matches, selection and saved fractional charge", async ({
  page,
}) => {
  await page.goto(`/encounters/${ids.visit}`);
  await page
    .getByRole("button", { name: "Search services...", exact: true })
    .click();
  await expect(
    page.getByRole("option").filter({ hasText: "AAA catalog 0050" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Load more products", exact: true })
    .click();
  await expect(
    page.getByRole("option").filter({ hasText: "AAA catalog 0100" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Load more products", exact: true })
    .click();
  await expect(
    page.getByRole("option").filter({ hasText: "AAA catalog 0150" }),
  ).toBeVisible();
  const search = page.getByRole("textbox", {
    name: "Search services",
    exact: true,
  });
  await search.fill("not-a-real-product-xyz");
  await expect(
    page.getByText('No services match "not-a-real-product-xyz".'),
  ).toBeVisible();
  await search.fill("AAA catalog 0826");
  const option = page
    .getByRole("option")
    .filter({ hasText: "AAA catalog 0826" });
  await expect(option).toBeVisible();
  await option.click();
  await expect(
    page.getByRole("button", { name: "AAA catalog 0826", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Charge quantity", { exact: true }).fill("1.5");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page
    .getByRole("button", { name: /Save.*invoice|Create.*invoice/i })
    .click();
  await expect
    .poll(async () => {
      const rows = await query(page, "billing.listInvoices", {
        appointmentId: ids.visit,
        limit: 25,
        offset: 0,
      });
      if (!rows.items[0]) return null;
      const invoice = await query(page, "billing.getInvoice", {
        id: rows.items[0].id,
      });
      return {
        quantity: invoice.items.find(
          (item: any) => item.description === "AAA catalog 0826",
        )?.quantity,
        subtotal: invoice.subtotal,
        tax: invoice.tax,
        total: invoice.total,
      };
    })
    .toEqual({ quantity: 1.5, subtotal: "2.99", tax: "0.24", total: "3.23" });
  await page.reload();
  await expect(
    page.getByLabel("AAA catalog 0826 quantity", { exact: true }),
  ).toHaveValue("1.5");
});

test("low stock explains blocked quantities and fractional stock correction enables actual prescribing", async ({
  page,
  context,
}) => {
  await prescriptionForm(page);
  const quantity = page.getByLabel("Prescription quantity", { exact: true });
  const save = page.getByRole("button", {
    name: "Save Prescription",
    exact: true,
  });
  await quantity.fill("1");
  await expect(save).toBeEnabled();
  for (const value of ["1.5", "2"]) {
    await quantity.fill(value);
    await expect(save).toBeDisabled();
    await expect(
      page.getByText("Cannot save this quantity against the recorded stock.", {
        exact: false,
      }),
    ).toBeVisible();
  }
  await quantity.fill("0.125");
  await expect(save).toBeEnabled();
  await quantity.fill("1.5");
  const inventory = await context.newPage();
  await inventory.goto("/inventory");
  await inventory
    .getByPlaceholder("Search by name or SKU...")
    .fill(productName);
  await inventory
    .getByRole("button", {
      name: `Adjust stock for ${productName}`,
      exact: true,
    })
    .click();
  await inventory.getByLabel("Stock adjustment quantity").fill("0.5");
  await inventory
    .getByPlaceholder(/reason/i)
    .fill("Synthetic reviewed count correction");
  await inventory.getByRole("button", { name: "Add", exact: true }).click();
  await expect(
    inventory.getByText("Stock adjusted", { exact: true }),
  ).toBeVisible();
  await page.bringToFront();
  await page
    .getByRole("button", { name: "Refresh stock", exact: true })
    .click();
  await expect(
    page.getByText("1.5 inventory units available.", { exact: false }),
  ).toBeVisible();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(
    page.getByText("Prescription created", { exact: true }),
  ).toBeVisible();
  const prescriptions = await query(page, "records.listPrescriptions", {
    patientId: ids.patient,
  });
  expect(
    prescriptions.some(
      (rx: any) => rx.productId === ids.product && Number(rx.quantity) === 1.5,
    ),
  ).toBe(true);
  const product = await query(page, "inventory.getById", { id: ids.product });
  expect(Number(product.stockQuantity)).toBe(0);
  await page.reload();
  await expect(
    page.getByText("Synthetic follow-up medication", { exact: true }).first(),
  ).toBeVisible();
  await prescriptionForm(page);
  await quantity.fill("0.001");
  await expect(save).toBeDisabled();
  await expect(
    page.getByText("0 inventory units available.", { exact: false }),
  ).toBeVisible();
});

test("untracked medication requires reviewed fractional opening stock, then dispenses exactly", async ({
  page,
  context,
}) => {
  ids = { ...ids, product: fixture.cases[projectName].untracked };
  productName = fixture.cases[projectName].untrackedName;
  await prescriptionForm(page);
  await page.getByLabel("Prescription quantity", { exact: true }).fill("0.125");
  await expect(
    page.getByText("Stock tracking has not been set up for this item.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save Prescription", exact: true }),
  ).toBeDisabled();
  const inventory = await context.newPage();
  await inventory.goto("/inventory");
  await inventory
    .getByPlaceholder("Search by name or SKU...")
    .fill(productName);
  await inventory
    .getByRole("button", {
      name: `Start stock tracking for ${productName}`,
      exact: true,
    })
    .click();
  await inventory.getByLabel("Opening units").fill("0.125");
  await inventory
    .getByRole("button", { name: "Start tracking", exact: true })
    .click();
  await expect(
    inventory.getByText("Stock tracking started", { exact: true }),
  ).toBeVisible();
  await page.bringToFront();
  await page
    .getByRole("button", { name: "Refresh stock", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Save Prescription", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Save Prescription", exact: true })
    .click();
  await expect(
    page.getByText("Prescription created", { exact: true }),
  ).toBeVisible();
  const product = await query(page, "inventory.getById", { id: ids.product });
  expect(Number(product.stockQuantity)).toBe(0);
  const prescriptions = await query(page, "records.listPrescriptions", {
    patientId: ids.patient,
  });
  expect(
    prescriptions.some(
      (rx: any) =>
        rx.productId === ids.product && Number(rx.quantity) === 0.125,
    ),
  ).toBe(true);
});
