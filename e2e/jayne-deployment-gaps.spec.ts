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
  await sql`insert into products (id, practice_id, name, category, unit_price, cost_price, stock_quantity, inventory_tracked) values (${ids.product}, ${practiceId}, ${productName}, 'medication', 1.00, 1.00, 10, true)`;
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
  await login(page, /stock dispense|editing fractional/.test(info.title));
  // Prove this server sees the freshly created random fixture before mutations.
  const response = await page.request.get(`/api/trpc/patients.getById?input=${encodeURIComponent(JSON.stringify({ json: { id: ids.patient } }))}`);
  const body = await response.json();
  expect(body.result?.data?.json?.id, "Server must use this disposable database").toBe(ids.patient);

});
test.afterEach(async ({ page }, info) => {
  await page.screenshot({ path: info.outputPath("workflow.png"), fullPage: true });
});


test("fractional prescription persists and reconciliation actions can be selected before a reason", async ({
  page,
}) => {
  await page.goto(`/encounters/${ids.visit}`);
  await page.getByRole("button", { name: "Prescribe", exact: true }).click();
  await page.getByLabel("Medication *").fill("Synthetic fractional medication");
  await page.getByLabel("Dosage *").fill("1.5 mL");
  await page.getByLabel("Frequency *").fill("Once daily");
  await page.getByLabel("Quantity", { exact: true }).fill("1.5");
  await page.getByRole("button", { name: "Save prescription" }).click();
  await expect(
    page.getByText("Prescription created", { exact: true }),
  ).toBeVisible();
  const [rx] =
    await sql`select quantity from prescriptions where appointment_id = ${ids.visit}`;
  expect(Number(rx.quantity)).toBe(1.5);
  const work = page.locator("#visit-work-reconciliation");
  await work
    .getByRole("button", { name: "Void/corrected", exact: true })
    .click();
  await expect(
    work.getByRole("button", { name: "Confirm void/correction" }),
  ).toBeDisabled();
  await work
    .getByLabel("Reconciliation reason for Synthetic fractional medication")
    .fill("Duplicate prescription recorded in error");
  await work.getByRole("button", { name: "Confirm void/correction" }).click();
  await expect(work.getByText("voided", { exact: true })).toBeVisible();
  await page.reload();
  await expect(
    page
      .locator("#visit-work-reconciliation")
      .getByText("voided", { exact: true }),
  ).toBeVisible();
  await rpc(page, "records.createPrescription", {
    patientId: ids.patient,
    appointmentId: ids.visit,
    operationId: randomUUID(),
    medicationName: "Synthetic no-charge medication",
    dosage: "0.125 mL",
    frequency: "Once daily",
    quantity: 0.125,
    startDate: new Date().toISOString().slice(0, 10),
  });
  await page.reload();
  const noCharge = page.getByRole("group", {
    name: "Performed work Synthetic no-charge medication",
    exact: true,
  });
  await noCharge
    .getByRole("button", { name: "No charge", exact: true })
    .click();
  await noCharge
    .getByLabel("Reconciliation reason for Synthetic no-charge medication")
    .fill("Included in the consultation");
  await noCharge
    .getByRole("button", { name: "Confirm no charge", exact: true })
    .click();
  await expect(noCharge.getByText("no charge", { exact: true })).toBeVisible();
});

test("inventory markup persists a selling price", async ({ page }) => {
  await page.goto("/inventory");
  await page.getByPlaceholder("Search by name or SKU...").fill(productName);
  const row = page.getByRole("row").filter({ hasText: productName });
  await row.getByTitle("Edit", { exact: true }).click();
  await page.getByLabel("Markup on cost (%)").fill("99");
  await page.getByRole("button", { name: "Apply markup" }).click();
  await page.getByRole("button", { name: "Save product", exact: true }).click();
  await expect(
    page.getByText("Product updated", { exact: true }),
  ).toBeVisible();
  const [product] =
    await sql`select unit_price, cost_price from products where id = ${ids.product}`;
  expect(product.unit_price).toBe("1.99");
  expect(product.cost_price).toBe("1.00");
});

test("fractional stock dispense, refill, and charge snapshot stay exact", async ({
  page,
}) => {
  const rx = await rpc(page, "records.createPrescription", {
    patientId: ids.patient,
    operationId: randomUUID(),
    medicationName: productName,
    dosage: "1.5 mL",
    frequency: "Once daily",
    quantity: 1.5,
    productId: ids.product,
    refillsRemaining: 1,
    startDate: new Date().toISOString().slice(0, 10),
  });
  const [product] =
    await sql`select stock_quantity from products where id = ${ids.product}`;
  expect(Number(product.stock_quantity)).toBe(8.5);
  const [queue] =
    await sql`select id, quantity from dispense_charge_queue where prescription_id = ${rx.id}`;
  expect(Number(queue.quantity)).toBe(1.5);
  const result = await rpc(page, "billing.createDispenseChargeInvoice", {
    id: queue.id,
  });
  const [line] =
    await sql`select quantity, total from invoice_items where invoice_id = ${result.invoiceId}`;
  await expect(
    sql`update invoice_items set quantity = 1.25 where invoice_id = ${result.invoiceId}`,
  ).rejects.toThrow("invalid medication dispense invoice line");
  expect(Number(line.quantity)).toBe(1.5);
  expect(line.total).toBe("2.99");
  await rpc(page, "records.recordPrescriptionRefill", {
    id: rx.id,
    operationId: randomUUID(),
  });
  const [afterRefill] =
    await sql`select stock_quantity from products where id = ${ids.product}`;
  expect(Number(afterRefill.stock_quantity)).toBe(7);
  const events =
    await sql`select quantity from prescription_events where prescription_id = ${rx.id}`;
  expect(events.length).toBe(2);
  expect(events.every((event: any) => Number(event.quantity) === 1.5)).toBe(
    true,
  );
});

test("editing fractional charge quantity retains charge editor and rounds tax", async ({
  page,
}) => {
  await rpc(page, "billing.createInvoice", {
    clientId,
    patientId: ids.patient,
    appointmentId: ids.visit,
    isEstimate: false,
    items: [
      {
        description: "Synthetic manual charge",
        quantity: 1,
        unitPrice: "1.99",
        itemType: "service",
      },
    ],
  });
  await page.goto(`/encounters/${ids.visit}`);
  await page.getByLabel("Synthetic manual charge quantity").fill("1.0001");
  await expect(
    page.getByLabel("Synthetic manual charge quantity"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Update visit invoice", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("Synthetic manual charge quantity").fill("1.5");
  await expect(
    page.getByLabel("Synthetic manual charge quantity"),
  ).toBeVisible();
  await expect(page.getByText(/Set the practice tax rate between/)).toHaveCount(
    0,
  );
  await page
    .getByRole("button", { name: "Update visit invoice", exact: true })
    .click();
  await expect(page.getByText(/Visit invoice charges updated/)).toBeVisible();
  const [line] =
    await sql`select quantity, total from invoice_items where description = 'Synthetic manual charge' and deleted_at is null and invoice_id in (select id from invoices where appointment_id = ${ids.visit})`;
  expect(Number(line.quantity)).toBe(1.5);
  expect(line.total).toBe("2.99");
});

test("delete mistaken appointment from schedule and preserve visits with evidence", async ({
  page,
}) => {
  await page.goto("/schedule");
  await page
    .getByRole("button")
    .filter({ hasText: patientName + " booking" })
    .last()
    .click();
  await page
    .getByRole("button", { name: "Delete appointment", exact: true })
    .click();
  await page
    .getByLabel("Reason for deleting appointment")
    .fill("Duplicate booking entered in error");
  await page.getByRole("button", { name: "Confirm deletion" }).click();
  await expect(
    page.getByText("Appointment deleted from the schedule", { exact: true }),
  ).toBeVisible();
  const [appointment] =
    await sql`select deleted_at from appointments where id = ${ids.booking}`;
  expect(appointment.deleted_at).not.toBeNull();
  await sql`update appointments set status = 'cancelled' where id = ${ids.visit}`;
  const response = await page.request.post("/api/trpc/appointments.delete", {
    data: {
      json: { id: ids.visit, reason: "Must preserve clinical evidence" },
    },
  });
  expect(response.ok()).toBe(false);
  const [visit] =
    await sql`select deleted_at from appointments where id = ${ids.visit}`;
  expect(visit.deleted_at).toBeNull();
});
