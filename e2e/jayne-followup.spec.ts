import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";

const enabled = process.env.JAYNE_GAPS_E2E === "1";
const databaseUrl = process.env.JAYNE_GAPS_E2E_DATABASE_URL;
test.skip(
  !enabled,
  "Requires an explicitly selected disposable local clinic database",
);
test.describe.configure({ mode: "serial" });
const ids = {
  patient: randomUUID(),
  bookingPatient: randomUUID(),
  visit: randomUUID(),
  booking: randomUUID(),
  product: randomUUID(),
};
const productName = `Synthetic Jayne medication ${ids.product.slice(0, 8)} per mL`;
const patientName = `Synthetic Jayne ${ids.patient.slice(0, 8)}`;
let sql: any;
let practiceId: string;
let clientId: string;
const require = createRequire(path.resolve("packages/db/package.json"));

async function rpc(page: Page, procedure: string, input: unknown) {
  const response = await page.request.post(`/api/trpc/${procedure}`, {
    data: { json: input },
  });
  const body = await response.json();
  expect(body.error, JSON.stringify(body)).toBeUndefined();
  return body.result.data.json;
}
async function login(page: Page, admin = false) {
  await page.addInitScript(() => {
    localStorage.setItem("openvpm.cookie-consent.v1", "essential");
    sessionStorage.setItem("ovpm_verify_email_dismissed", "1");
  });
  await page.goto("/login");
  await page
    .getByLabel("Email")
    .fill(
      admin
        ? "admin@neighborhoodvet.example.com"
        : "sarah.chen@neighborhoodvet.example.com",
    );
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => url.pathname !== "/login");
}
test.beforeAll(async () => {
  if (!enabled) return;
  const url = new URL(databaseUrl!);
  const base = new URL(process.env.PLAYWRIGHT_BASE_URL!);
  if (
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    !["localhost", "127.0.0.1"].includes(base.hostname) ||
    !url.pathname.startsWith("/openvpm_jayne_") ||
    process.env.DATABASE_URL !== databaseUrl
  )
    throw new Error(
      "Use a matching disposable local openvpm_jayne_ database and server",
    );
  sql = require("postgres")(databaseUrl, { max: 1 });
  const [user] =
    await sql`select id, practice_id from users where email = 'sarah.chen@neighborhoodvet.example.com'`;
  practiceId = user.practice_id;
  const [client] =
    await sql`select id from clients where practice_id = ${practiceId} and deleted_at is null limit 1`;
  clientId = client.id;
  const [location] =
    await sql`select id from locations where practice_id = ${practiceId} limit 1`;
  await sql`update practices set settings = settings || '{"ambulatoryWorkspace":{"enabled":true}}'::jsonb, tax_rate_percent = 8 where id = ${practiceId}`;
  await sql`insert into patients (id, practice_id, client_id, name, species) values (${ids.patient}, ${practiceId}, ${clientId}, ${patientName}, 'canine')`;
  await sql`insert into patients (id, practice_id, client_id, name, species) values (${ids.bookingPatient}, ${practiceId}, ${clientId}, ${patientName + " booking"}, 'canine')`;
  await sql`insert into products (id, practice_id, name, category, unit_price, cost_price, stock_quantity, inventory_tracked) values (${ids.product}, ${practiceId}, ${productName}, 'medication', 1.99, 1.00, 1, true)`;
  await sql`insert into products (practice_id, name, unit_price, stock_quantity, inventory_tracked, reorder_point)
    select ${practiceId}, 'AAA catalog ' || lpad(n::text, 4, '0'), 1.99, 0, false, null from generate_series(1,826) n where not exists (select 1 from products p where p.practice_id=${practiceId} and p.name='AAA catalog ' || lpad(n::text, 4, '0'))`;
  for (const [id, status] of [
    [ids.visit, "in_exam"],
    [ids.booking, "scheduled"],
  ]) {
    await sql`insert into appointments (id, practice_id, patient_id, client_id, doctor_id, location_id, status, origin, start_time, end_time, notes) values (${id}, ${practiceId}, ${id === ids.visit ? ids.patient : ids.bookingPatient}, ${clientId}, ${user.id}, ${location.id}, ${status}, ${id === ids.visit ? "field" : "scheduled"}, date_trunc('day', now()) + interval '16 hours', date_trunc('day', now()) + interval '16 hours 30 minutes', 'Synthetic Jayne regression')`;
  }
});
test.afterAll(async () => {
  if (sql) await sql.end();
});
test.beforeEach(async ({ page }, info) => {
  await login(page, true);
  // Prove this server sees the freshly created random fixture before mutations.
  const response = await page.request.get(
    `/api/trpc/patients.getById?input=${encodeURIComponent(JSON.stringify({ json: { id: ids.patient } }))}`,
  );
  const body = await response.json();
  expect(
    body.result?.data?.json?.id,
    "Server must use this disposable database",
  ).toBe(ids.patient);
});
test.afterEach(async ({ page }, info) => {
  await page.screenshot({
    path: info.outputPath("workflow.png"),
    fullPage: true,
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
      const rows =
        await sql`select ii.quantity from invoice_items ii join invoices i on i.id=ii.invoice_id where i.appointment_id=${ids.visit} and ii.description='AAA catalog 0826'`;
      return Number(rows[0]?.quantity);
    })
    .toBe(1.5);
  await page.reload();
  await expect(page.getByLabel("AAA catalog 0826 quantity", { exact: true })).toHaveValue("1.5");
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
  const [rx] =
    await sql`select quantity from prescriptions where patient_id=${ids.patient} and product_id=${ids.product}`;
  expect(Number(rx.quantity)).toBe(1.5);
  const [product] =
    await sql`select stock_quantity from products where id=${ids.product}`;
  expect(Number(product.stock_quantity)).toBe(0);
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

test("untracked medication requires reviewed fractional opening stock, then dispenses exactly", async ({ page, context }) => {
  // Setup only: production imported products commonly have untracked stock.
  await sql`update products set inventory_tracked=false, stock_quantity=0, reorder_point=null, lot_number=null, expiration_date=null where id=${ids.product}`;
  await prescriptionForm(page);
  await page.getByLabel("Prescription quantity", { exact: true }).fill("0.125");
  await expect(page.getByText("Stock tracking has not been set up for this item.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save Prescription", exact: true })).toBeDisabled();
  const inventory = await context.newPage();
  await inventory.goto("/inventory");
  await inventory.getByPlaceholder("Search by name or SKU...").fill(productName);
  await inventory.getByRole("button", { name: `Start stock tracking for ${productName}`, exact: true }).click();
  await inventory.getByLabel("Opening units").fill("0.125");
  await inventory.getByRole("button", { name: "Start tracking", exact: true }).click();
  await expect(inventory.getByText("Stock tracking started", { exact: true })).toBeVisible();
  await page.bringToFront();
  await page.getByRole("button", { name: "Refresh stock", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save Prescription", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Save Prescription", exact: true }).click();
  await expect(page.getByText("Prescription created", { exact: true })).toBeVisible();
  const [product] = await sql`select stock_quantity from products where id=${ids.product}`;
  expect(Number(product.stock_quantity)).toBe(0);
  const rows = await sql`select quantity from prescriptions where patient_id=${ids.patient} and product_id=${ids.product} order by created_at desc`;
  expect(Number(rows[0].quantity)).toBe(0.125);
});

test("charge search discards stale responses and recovers after network failure", async ({ page }) => {
  await page.goto(`/encounters/${ids.visit}`);
  await page.getByRole("button", { name: "Search services...", exact: true }).click();
  const search = page.getByRole("textbox", { name: "Search services", exact: true });
  await page.route("**/api/trpc/billing.searchProducts*", async (route) => {
    if (decodeURIComponent(route.request().url()).includes('AAA catalog 0001')) {
      await new Promise(resolve => setTimeout(resolve, 800));
    }
    await route.continue();
  });
  await search.fill("AAA catalog 0001");
  await search.fill("AAA catalog 0826");
  await expect(page.getByRole("option").filter({ hasText: "AAA catalog 0826" })).toBeVisible();
  await expect(page.getByRole("option").filter({ hasText: "AAA catalog 0001" })).toHaveCount(0);
  await page.unroute("**/api/trpc/billing.searchProducts*");
  await page.route("**/api/trpc/billing.searchProducts*", route => route.abort());
  await search.fill("AAA catalog 0825");
  await expect(page.getByRole("button", { name: "Retry products", exact: true })).toBeVisible({ timeout: 30_000 });
  await page.unroute("**/api/trpc/billing.searchProducts*");
  await page.getByRole("button", { name: "Retry products", exact: true }).click();
  await expect(page.getByRole("option").filter({ hasText: "AAA catalog 0825" })).toBeVisible();
  await search.press("ArrowDown");
  await search.press("Enter");
  await expect(page.getByRole("button", { name: "AAA catalog 0825", exact: true })).toBeVisible();
});
