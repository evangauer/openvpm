import {
  test as base,
  expect,
  chromium,
  webkit,
  type Page,
  type BrowserContext,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const require = createRequire(path.resolve("apps/web/package.json"));
const postgres =
  require("postgres") as typeof import("../apps/web/node_modules/postgres");
const { hash } =
  require("bcryptjs") as typeof import("../apps/web/node_modules/@types/bcryptjs");
const baseURL = process.env.OFFLINE_E2E_BASE_URL ?? "http://127.0.0.1:3457";
const passphrase = "Synthetic offline acceptance passphrase";
const fields = ["Subjective", "Objective", "Assessment", "Plan"] as const;
const sections = {
  subjective: "Synthetic history & follow-up",
  objective: "Synthetic examination <literal text>",
  assessment: "Synthetic assessment",
  plan: "Synthetic plan — review after reconnect",
};
type Clinic = {
  patientId: string;
  appointmentId: string;
  userId: string;
  email: string;
  password: string;
  secondEmail: string;
  controlToken: string;
  certificate?: string;
  sql: ReturnType<typeof postgres>;
};

const test = base.extend<{ clinic: Clinic }>({
  clinic: async ({}, use) => {
    const directory = process.env.OFFLINE_E2E_DIRECTORY;
    if (!directory)
      throw new Error(
        "Use playwright.offline.config.ts; this suite never attaches to an existing clinic.",
      );
    const { ownerUrl, controlToken } = JSON.parse(
      await readFile(path.join(directory, "fixture.json"), "utf8"),
    );
    const certificate = baseURL.startsWith("https:")
      ? await readFile(path.join(directory, "loopback-cert.pem"), "utf8")
      : undefined;
    const url = new URL(ownerUrl);
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      !/^\/openvpm_offline_e2e_[a-f0-9]{32}$/.test(url.pathname)
    ) {
      throw new Error("Unsafe offline acceptance database.");
    }
    const sql = postgres(ownerUrl, { max: 1 });
    try {
      const [database] = await sql`select current_database() as name`;
      expect(database!.name).toBe(url.pathname.slice(1));
      // Browser contexts share one loopback IP. Reset only that test-run IP
      // budget between independent cases; per-account limiting remains real.
      await sql`delete from rate_limit_buckets where key like 'login:ip:%'`;
      const suffix = randomUUID();
      const password = `Synthetic-${randomUUID()}`;
      const passwordHash = await hash(password, 10);
      const [practice] =
        await sql`insert into practices (name, timezone) values ('Synthetic offline acceptance clinic', 'UTC') returning id`;
      await sql`update practices set country = 'US', currency = 'usd', tax_rate_percent = 6.00,
        settings = '{"ambulatoryWorkspace":{"enabled":true}}'::jsonb where id = ${practice!.id}`;
      await sql`insert into services (practice_id, name, default_price, taxable) values (${practice!.id}, 'Synthetic vaccine', 20.25, true)`;
      const email = `offline-${suffix}@example.invalid`;
      const secondEmail = `offline-second-${suffix}@example.invalid`;
      const [user] =
        await sql`insert into users (practice_id, email, password_hash, name, role, is_veterinarian, email_verified_at)
        values (${practice!.id}, ${email}, ${passwordHash}, 'Synthetic Offline Clinician', 'admin', true, now()) returning id`;
      await sql`insert into users (practice_id, email, password_hash, name, role, is_veterinarian, email_verified_at)
        values (${practice!.id}, ${secondEmail}, ${passwordHash}, 'Synthetic Second Clinician', 'admin', true, now())`;
      await sql`insert into locations (practice_id, name, is_primary) values (${practice!.id}, 'Synthetic location', true)`;
      const [client] =
        await sql`insert into clients (practice_id, first_name, last_name) values (${practice!.id}, 'Synthetic', 'Owner') returning id`;
      const [patient] =
        await sql`insert into patients (practice_id, client_id, name, species)
        values (${practice!.id}, ${client!.id}, 'Synthetic Offline Patient', 'feline') returning id`;
      const [appointment] =
        await sql`insert into appointments (practice_id, patient_id, client_id, doctor_id, status, start_time, end_time)
        values (${practice!.id}, ${patient!.id}, ${client!.id}, ${user!.id}, 'scheduled', now() + interval '3 hours', now() + interval '4 hours') returning id`;
      await use({
        sql,
        email,
        secondEmail,
        password,
        controlToken,
        certificate,
        userId: user!.id,
        patientId: patient!.id,
        appointmentId: appointment!.id,
      });
    } finally {
      try {
        const response = await fetch("http://127.0.0.1:3456/reconnect", {
          method: "POST",
          headers: { authorization: `Bearer ${controlToken}` },
        });
        expect(response.ok).toBe(true);
      } finally {
        await sql.end();
      }
    }
  },
});

async function login(
  context: BrowserContext,
  clinic: Clinic,
  email = clinic.email,
) {
  const csrf = await context.request.get("/api/auth/csrf");
  expect(csrf.ok()).toBe(true);
  const { csrfToken } = await csrf.json();
  const response = await context.request.post(
    "/api/auth/callback/credentials",
    {
      form: {
        csrfToken,
        email,
        password: clinic.password,
        callbackUrl: "/",
        json: "true",
      },
    },
  );
  expect(response.ok()).toBe(true);
  const session = await context.request.get("/api/auth/session");
  expect((await session.json()).user?.email).toBe(email);
}

async function unlock(page: Page, exists = true) {
  await page.getByLabel("Field passphrase", { exact: true }).fill(passphrase);
  if (!exists)
    await page
      .getByLabel("Confirm field passphrase", { exact: true })
      .fill(passphrase);
  await page
    .getByRole("button", {
      name: exists ? "Unlock field workspace" : "Create field workspace",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", { name: "Patients on this device", exact: true }),
  ).toBeVisible();
}
async function prepare(page: Page, clinic: Clinic) {
  await login(page.context(), clinic);
  await page.goto("/offline/field.html");
  await unlock(page, false);
  await page
    .getByRole("button", { name: "Find patients", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Prepare Synthetic Offline Patient",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", { name: "Start field visit" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
    )
    .toBe(true);
}
async function issue(page: Page) {
  await page.getByRole("button", { name: "Start field visit" }).click();
  await page
    .getByRole("textbox", { name: "History", exact: true })
    .fill("Synthetic offline examination history");
  await page
    .getByRole("textbox", { name: "Plan and instructions", exact: true })
    .fill("Synthetic follow-up instructions");
  await page
    .getByRole("button", { name: "Continue to treatments", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Prepared service", exact: true })
    .selectOption({ label: "Synthetic vaccine · $20.25" });
  await page.getByRole("button", { name: "Add charge", exact: true }).click();
  await page
    .getByRole("button", { name: "Add vaccination", exact: true })
    .click();
  await page.getByLabel("Lot number", { exact: true }).fill("SYNTHETIC-LOT");
  await page
    .getByRole("button", { name: "Continue to checkout", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Payment received", exact: true })
    .selectOption("cash");
  await expect(
    page.getByRole("button", { name: "Issue field receipt", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Issue field receipt", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Print receipt / Save PDF", exact: true }),
  ).toBeEnabled();
}
async function reopen(page: Page) {
  const context = page.context();
  await page.close();
  const fresh = await context.newPage();
  const response = await fresh.goto("/offline/field.html");
  expect(response?.fromServiceWorker()).toBe(true);
  await unlock(fresh);
  return fresh;
}
async function control(clinic: Clinic, action: string) {
  const response = await fetch(`http://127.0.0.1:3456/${action}`, {
    method: "POST",
    headers: { authorization: `Bearer ${clinic.controlToken}` },
  });
  expect(response.ok).toBe(true);
  return response;
}
async function posted(clinic: Clinic) {
  return clinic.sql`select b.id, b.result, b.receipt, i.total, i.paid_amount, i.status, n.subjective, p.method, v.lot_number,
    v.administered_at, p.received_at, a.origin, n.status as note_status
    from offline_field_batches b
    join invoices i on i.id = (b.result->>'invoiceId')::uuid
    join soap_notes n on n.id = (b.result->>'noteId')::uuid
    join payments p on p.id = (b.result->>'paymentId')::uuid
    join vaccination_records v on v.id = (b.result->'vaccinationIds'->>0)::uuid
    join appointments a on a.id = (b.result->>'appointmentId')::uuid
    where b.patient_id = ${clinic.patientId}`;
}

test("sidebar field entry respects billing region while an existing receipt remains recoverable", async ({ page, clinic }, info) => {
  await prepare(page, clinic);
  await issue(page);
  await clinic.sql`update practices set country = 'GB', currency = 'gbp'
    where id = (select practice_id from users where id = ${clinic.userId})`;
  await Promise.all([
    page.waitForResponse(response => response.url().includes("offlineField.availability") && response.ok()),
    page.goto(`/patients/${clinic.patientId}`),
  ]);
  await page.getByRole("button", { name: "I'll finish later", exact: true }).click();
  await expect(page.getByRole("link", { name: "Prepare for field visit", exact: true })).toHaveCount(0);
  await openMainNavigation(page);
  await page.getByRole("button", { name: "All tools", exact: true }).click();
  const tools = page.getByRole("dialog", { name: "Tools", exact: true });
  await tools.getByRole("textbox", { name: "Search tools", exact: true }).fill("field");
  await expect(tools.getByRole("link", { name: "Open Field Visits", exact: true })).toHaveCount(0);
  await tools.getByRole("button", { name: "Close tools", exact: true }).click();
  // Hiding new preparation must not destroy a clinician's issued receipt.
  await page.goto("/offline/field.html");
  await unlock(page);
  await expect(page.getByRole("button", { name: "Print receipt / Save PDF", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Synchronize visit", exact: true }).click();
  await expect(page.getByText(/Clinic currency or tax settings changed/)).toBeVisible();
  expect(await posted(clinic)).toHaveLength(0);
  await page.screenshot({ path: info.outputPath("field-region-recovery.png"), fullPage: true });
  await clinic.sql`update practices set country = 'US', currency = 'usd'
    where id = (select practice_id from users where id = ${clinic.userId})`;
  await page.getByRole("button", { name: "Synchronize visit", exact: true }).click();
  await expect(page.getByRole("link", { name: "Review and sign online" })).toBeVisible();
  expect(await posted(clinic)).toHaveLength(1);
});

test("guided field large-animal visit retains chart weight and posts once after offline work", async ({ page, clinic }, info) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await clinic.sql`update patients set species = 'bovine' where id = ${clinic.patientId}`;
  await login(page.context(), clinic);
  await page.goto(`/patients/${clinic.patientId}`);
  await page.getByRole("button", { name: "I'll finish later", exact: true }).click();
  await page.getByRole("tab", { name: "Weight History", exact: true }).click();
  await page.getByRole("spinbutton").fill("650");
  await page.getByRole("button", { name: "Record weight", exact: true }).click();
  await expect(page.getByRole("cell", { name: "650 kg", exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("tab", { name: "Weight History", exact: true }).click();
  await expect(page.getByRole("cell", { name: "650 kg", exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("large-animal-chart-weight.png"), fullPage: true });
  await prepare(page, clinic);
  await expect(page.getByText(/bovine ·/)).toBeVisible();
  await control(clinic, "disconnect");
  await issue(page);
  const fresh = await reopen(page);
  await expect(fresh.getByRole("button", { name: "Print receipt / Save PDF", exact: true })).toBeEnabled();
  await control(clinic, "reconnect");
  await fresh.getByRole("button", { name: "Check connection", exact: true }).click();
  await expect(fresh.getByText("Clinic connected", { exact: true })).toBeVisible();
  await fresh.getByRole("button", { name: "Synchronize visit", exact: true }).click();
  await expect(fresh.getByRole("link", { name: "Review and sign online" })).toBeVisible();
  expect(await posted(clinic)).toHaveLength(1);
  const weights = await clinic.sql`select weight_kg from patient_weights where patient_id = ${clinic.patientId}`;
  expect(weights).toHaveLength(1);
  expect(Number(weights[0]!.weight_kg)).toBe(650);
  expect(errors).toEqual([]);
});

test("field visit survives cold offline reopen, prints its receipt, and posts clinical and financial records together", async ({
  page,
  clinic,
  browserName,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await prepare(page, clinic);
  if (browserName === "webkit") await control(clinic, "disconnect");
  else await page.context().setOffline(true);
  await issue(page);
  expect(await posted(clinic)).toHaveLength(0);
  page = await reopen(page);
  await page.getByRole("button", { name: "1. Notes", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "History", exact: true }),
  ).toHaveValue("Synthetic offline examination history");
  await expect(
    page.getByRole("textbox", { name: "History", exact: true }),
  ).toBeDisabled();
  await page.emulateMedia({ media: "print" });
  await expect(page.locator("#field-receipt")).toBeVisible();
  await expect(page.locator("#field-receipt")).toContainText("$21.47");
  const originalReceipt = await page.locator("#field-receipt").textContent();
  await page.screenshot({
    path: info.outputPath("offline-field-receipt.png"),
    fullPage: true,
  });
  if (browserName === "chromium")
    await page.pdf({
      path: info.outputPath("offline-field-receipt.pdf"),
      format: "A4",
    });
  await page.emulateMedia({ media: "screen" });
  await page.getByRole("button", { name: "3. Checkout", exact: true }).click();
  if (browserName === "webkit") await control(clinic, "reconnect");
  else await page.context().setOffline(false);
  await page
    .getByRole("button", { name: "Synchronize visit", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "Review and sign online" }),
  ).toBeVisible();
  const rows = await posted(clinic);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    total: "21.47",
    paid_amount: "21.47",
    status: "paid",
    method: "cash",
    lot_number: "SYNTHETIC-LOT",
    origin: "field",
    note_status: "draft",
  });
  expect(rows[0]!.subjective).toContain(
    "Synthetic offline examination history",
  );
  expect(rows[0]!.receipt.reference).toBe(rows[0]!.id);
  expect(await page.locator("#field-receipt").textContent()).toBe(
    originalReceipt,
  );
  expect(errors).toEqual([]);
});

test("a lost sync response can be retried after reopening without duplicate records", async ({
  page,
  clinic,
}) => {
  await prepare(page, clinic);
  await issue(page);
  await control(clinic, "drop-next-save");
  await page
    .getByRole("button", { name: "Synchronize visit", exact: true })
    .click();
  await expect(page.getByRole("alert")).toBeVisible();
  expect(await posted(clinic)).toHaveLength(1);
  page = await reopen(page);
  await page
    .getByRole("button", { name: "Synchronize visit", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "Review and sign online" }),
  ).toBeVisible();
  const requests: string[] = await (
    await control(clinic, "save-requests")
  ).json();
  expect(requests).toHaveLength(2);
  expect(requests[0]).toBe(requests[1]);
  expect(await posted(clinic)).toHaveLength(1);
  const [counts] =
    await clinic.sql`select (select count(*) from invoices where patient_id = ${clinic.patientId}) as invoices,
    (select count(*) from vaccination_records where patient_id = ${clinic.patientId}) as vaccines,
    (select count(*) from soap_notes where patient_id = ${clinic.patientId}) as notes`;
  expect(counts).toEqual({ invoices: "1", vaccines: "1", notes: "1" });
});

test("changed prices stop the entire posting and preserve the issued receipt", async ({
  page,
  clinic,
}) => {
  await prepare(page, clinic);
  await issue(page);
  await clinic.sql`update services set default_price = 30.00 where practice_id = (select practice_id from patients where id = ${clinic.patientId})`;
  await page
    .getByRole("button", { name: "Synchronize visit", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "charged service changed",
  );
  expect(await posted(clinic)).toHaveLength(0);
  expect(
    await clinic.sql`select id from invoices where patient_id = ${clinic.patientId}`,
  ).toHaveLength(0);
  expect(
    await clinic.sql`select id from soap_notes where patient_id = ${clinic.patientId}`,
  ).toHaveLength(0);
  await expect(page.locator("#field-receipt")).toContainText("$21.47");
  await page.getByRole("button", { name: "1. Notes", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "History", exact: true }),
  ).toBeDisabled();
});

test("an audit failure rolls every record back and a retry posts once", async ({
  page,
  clinic,
}) => {
  await prepare(page, clinic);
  await issue(page);
  const functionName = `synthetic_reject_${clinic.userId.replaceAll("-", "")}`;
  await clinic.sql.unsafe(
    `create function ${functionName}() returns trigger language plpgsql as $$ begin if new.user_id = '${clinic.userId}' and new.action = 'offline_field_synced' then raise exception 'Synthetic audit failure'; end if; return new; end $$`,
  );
  await clinic.sql.unsafe(
    `create trigger ${functionName} before insert on audit_log for each row execute function ${functionName}()`,
  );
  try {
    await page
      .getByRole("button", { name: "Synchronize visit", exact: true })
      .click();
    await expect(page.getByRole("alert")).toBeVisible();
    expect(
      await clinic.sql`select id from invoices where patient_id = ${clinic.patientId}`,
    ).toHaveLength(0);
    expect(
      await clinic.sql`select id from soap_notes where patient_id = ${clinic.patientId}`,
    ).toHaveLength(0);
    expect(
      await clinic.sql`select id from vaccination_records where patient_id = ${clinic.patientId}`,
    ).toHaveLength(0);
  } finally {
    await clinic.sql.unsafe(`drop trigger ${functionName} on audit_log`);
    await clinic.sql.unsafe(`drop function ${functionName}()`);
  }
  await page
    .getByRole("button", { name: "Synchronize visit", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "Review and sign online" }),
  ).toBeVisible();
  expect(await posted(clinic)).toHaveLength(1);
});

test("guided field preparation preserves appointment identity and shows distinct device and clinic state", async ({
  page,
  clinic,
}, info) => {
  await login(page.context(), clinic);
  await page.goto(`/patients/${clinic.patientId}`);
  await page
    .getByRole("button", { name: "I'll finish later", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "Prepare for field visit", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("patient-field-entry.png"),
    fullPage: true,
  });
  if (
    !(await page
      .getByRole("button", { name: "All tools", exact: true })
      .isVisible())
  )
    await page
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
  await page.getByRole("button", { name: "All tools", exact: true }).click();
  const tools = page.getByRole("dialog", { name: "Tools", exact: true });
  await tools
    .getByRole("radio", { name: "Focused navigation", exact: true })
    .check();
  await tools
    .getByRole("textbox", { name: "Search tools", exact: true })
    .fill("field");
  await tools
    .getByRole("button", { name: "Pin Field Visits", exact: true })
    .click();
  await tools.getByRole("button", { name: "Close tools", exact: true }).click();
  await page.getByRole("link", { name: "Field Visits", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Prepare a trusted device",
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("field-device-setup.png"),
    fullPage: true,
  });
  await page.goto(`/patients/${clinic.patientId}`);
  await page
    .getByRole("link", { name: "Prepare for field visit", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`patientId=${clinic.patientId}$`));
  await unlock(page, false);
  await expect(
    page.getByRole("button", { name: "Prepare selected patient", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start field visit", exact: true }),
  ).toHaveCount(0);
  // The selected appointment is scheduled today in the fixture clinic's UTC zone.
  await clinic.sql`update appointments set start_time = date_trunc('day', now()) + interval '12 hours',
    end_time = date_trunc('day', now()) + interval '13 hours' where id = ${clinic.appointmentId}`;
  await page.goto("/schedule");
  await page.getByRole("button", { name: /Synthetic Offline Patient/ }).click();
  await page
    .getByRole("link", { name: "Prepare for field visit", exact: true })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`appointmentId=${clinic.appointmentId}$`),
  );
  await unlock(page);
  await page.getByRole("link", { name: "Field Visits", exact: true }).click();
  await expect(page).toHaveURL(
    new RegExp(`appointmentId=${clinic.appointmentId}$`),
  );
  await page
    .getByRole("button", { name: "Prepare selected appointment", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Start field visit", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/offline\/field.html$/);
  await expect(
    page.getByRole("navigation", { name: "Clinic navigation" }),
  ).toBeVisible();
  await expect(page.getByLabel("Device save status")).toContainText(
    "Saved on this device",
  );
  await expect(page.getByLabel("Device save status")).toContainText(
    "not yet clinic records",
  );
  await control(clinic, "disconnect");
  await page
    .getByRole("button", { name: "Check connection", exact: true })
    .click();
  await expect(
    page.getByText("Clinic unreachable", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to clinic" })).toHaveCount(
    0,
  );
  await issue(page);
  await expect(
    page.getByRole("textbox", { name: "History", exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: info.outputPath("field-checkout.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "2. Treatments", exact: true })
    .click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: info.outputPath("field-treatments.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "3. Checkout", exact: true }).click();
  await control(clinic, "reconnect");
  await page
    .getByRole("button", { name: "Check connection", exact: true })
    .click();
  await expect(
    page.getByText("Clinic connected", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Synchronize visit", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "Review and sign online" }),
  ).toBeVisible();
  const rows = await posted(clinic);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.result.appointmentId).toBe(clinic.appointmentId);
  await expect(page.getByLabel("Device save status")).toContainText(
    "synced to clinic",
  );
  await page.context().clearCookies();
  await page
    .getByRole("button", { name: "Check connection", exact: true })
    .click();
  await expect(page.getByText("Sign-in needed", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Sign in online", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Device save status")).toContainText(
    "synced to clinic",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: info.outputPath("field-phone.png"),
    fullPage: true,
  });
});

async function openMainNavigation(page: Page) {
  if (
    (page.viewportSize()?.width ?? 1280) < 1024 &&
    !(await page
      .getByRole("button", { name: "All tools", exact: true })
      .isVisible())
  )
    await page
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
  await expect(
    page.getByRole("button", { name: "All tools", exact: true }),
  ).toBeVisible();
}

test("sidebar tools persist per account, stay available after unpinning, and respect roles", async ({
  page,
  clinic,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page.context(), clinic);
  await page.goto(`/patients/${clinic.patientId}`);
  await page
    .getByRole("button", { name: "I'll finish later", exact: true })
    .click();
  await openMainNavigation(page);
  await expect(
    page.getByRole("list", { name: "Full navigation" }).getByRole("link"),
  ).toHaveText([
    "Dashboard",
    "Patients",
    "Clients",
    "Schedule",
    "Records",
    "Lab Inbox",
    "Billing",
    "Inventory",
    "Inbox",
    "Recalls",
    "Care Reminders",
    "Imported History",
    "Whiteboard",
    "Agent",
    "Controlled Substances",
    "Reports",
    "Settings",
    "Field Visits",
  ]);
  await expect(
    page.getByRole("list", { name: "Pinned tools" }).getByRole("link"),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "All tools", exact: true }).click();
  const tools = page.getByRole("dialog", { name: "Tools", exact: true });
  const search = tools.getByRole("textbox", {
    name: "Search tools",
    exact: true,
  });
  await expect(search).toBeFocused();
  await expect(
    tools.getByRole("radio", { name: "Full navigation", exact: true }),
  ).toBeChecked();
  await tools
    .getByRole("radio", { name: "Focused navigation", exact: true })
    .check();
  await search.fill("no matching tool");
  await expect(tools.getByText("No tools match your search.")).toBeVisible();
  await search.fill("inventory");
  await tools
    .getByRole("button", { name: "Pin Inventory", exact: true })
    .click();
  await expect(
    tools.getByRole("button", { name: "Unpin Inventory", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await search.fill("field");
  await tools
    .getByRole("button", { name: "Pin Field Visits", exact: true })
    .click();
  await page.screenshot({
    path: info.outputPath("tools-picker.png"),
    fullPage: true,
  });
  await tools.getByRole("button", { name: "Close tools", exact: true }).click();
  await page.reload();
  await openMainNavigation(page);
  await expect(
    page.getByRole("list", { name: "Pinned tools" }).getByRole("link"),
  ).toHaveText(["Inventory", "Field Visits"]);
  await expect(
    page.getByRole("list", { name: "Core navigation" }).getByRole("link"),
  ).toHaveCount(6);
  await page.screenshot({
    path: info.outputPath("pinned-sidebar.png"),
    fullPage: true,
  });
  // Switching back restores the familiar order and retains pins for later.
  await page.getByRole("button", { name: "All tools", exact: true }).click();
  await tools
    .getByRole("radio", { name: "Full navigation", exact: true })
    .check();
  await tools.getByRole("button", { name: "Close tools", exact: true }).click();
  await page.reload();
  await openMainNavigation(page);
  await expect(
    page
      .getByRole("list", { name: "Full navigation" })
      .getByRole("link")
      .nth(1),
  ).toHaveText("Patients");
  await expect(page.getByRole("list", { name: "Pinned tools" })).toHaveCount(0);
  await page.getByRole("button", { name: "All tools", exact: true }).click();
  await expect(
    tools.getByRole("button", { name: "Unpin Inventory", exact: true }),
  ).toBeVisible();
  await tools
    .getByRole("radio", { name: "Focused navigation", exact: true })
    .check();
  await tools.getByRole("button", { name: "Close tools", exact: true }).click();
  await page
    .getByRole("button", { name: "Unpin Inventory", exact: true })
    .click();
  await expect(
    page
      .getByRole("list", { name: "Pinned tools" })
      .getByRole("link", { name: "Inventory", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "All tools", exact: true }).click();
  await tools
    .getByRole("link", { name: "Open Inventory", exact: true })
    .click();
  await expect(page).toHaveURL(/\/inventory$/);
  await openMainNavigation(page);
  await expect(
    page
      .getByLabel("Current tool", { exact: true })
      .getByRole("link", { name: "Inventory", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await clinic.sql`update users set role = 'viewer', is_veterinarian = false where email = ${clinic.secondEmail}`;
  await login(page.context(), clinic, clinic.secondEmail);
  await page.goto(`/patients/${clinic.patientId}`);
  await openMainNavigation(page);
  await expect(
    page.getByRole("list", { name: "Full navigation" }),
  ).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Pinned tools" }).getByRole("link"),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "All tools", exact: true }).click();
  await expect(
    tools.getByRole("link", { name: "Open Field Visits", exact: true }),
  ).toHaveCount(0);
  await expect(
    tools.getByRole("link", { name: "Open Reports", exact: true }),
  ).toHaveCount(0);
  await expect(
    tools.getByRole("link", {
      name: "Open Controlled Substances",
      exact: true,
    }),
  ).toHaveCount(0);
  await tools
    .getByRole("radio", { name: "Focused navigation", exact: true })
    .check();
  await tools
    .getByRole("button", { name: "Pin Inventory", exact: true })
    .click();
  await expect(
    tools.getByRole("button", { name: "Unpin Inventory", exact: true }),
  ).toBeVisible();
  await login(page.context(), clinic);
  await page.goto(`/patients/${clinic.patientId}`);
  await openMainNavigation(page);
  await expect(
    page.getByRole("list", { name: "Pinned tools" }).getByRole("link"),
  ).toHaveText(["Field Visits"]);
  expect(errors).toEqual([]);
});

test("sidebar upgrades preserve preview pins, synchronize across devices, and recover corrupt preferences", async ({
  page,
  browser,
  clinic,
}) => {
  await login(page.context(), clinic);
  await page.goto(`/patients/${clinic.patientId}`);
  await page
    .getByRole("button", { name: "I'll finish later", exact: true })
    .click();
  const [user] =
    await clinic.sql`select practice_id from users where id = ${clinic.userId}`;
  const key = `openvpm.sidebar.v1.${user!.practice_id}.${clinic.userId}`;
  await page.evaluate(
    (key) =>
      localStorage.setItem(
        key,
        JSON.stringify({ version: 1, pinned: ["/inventory"] }),
      ),
    key,
  );
  await page.reload();
  await openMainNavigation(page);
  await expect(
    page.getByRole("list", { name: "Core navigation" }).getByRole("link"),
  ).toHaveCount(6);
  await expect(
    page.getByRole("list", { name: "Pinned tools" }).getByRole("link"),
  ).toHaveText(["Inventory"]);

  // A separate browser context has no shared cookies or localStorage.
  const secondDevice = await browser.newContext({ baseURL, ignoreHTTPSErrors: true });
  await login(secondDevice, clinic);
  const peer = await secondDevice.newPage();
  try {
    await peer.goto(`/patients/${clinic.patientId}`);
    await openMainNavigation(peer);
    await expect(peer.getByRole("list", { name: "Pinned tools" }).getByRole("link")).toHaveText(["Inventory"]);
    await peer.getByRole("button", { name: "All tools", exact: true }).click();
    const tools = peer.getByRole("dialog", { name: "Tools", exact: true });
    await tools
      .getByRole("radio", { name: "Full navigation", exact: true })
      .check();
    await tools
      .getByRole("button", { name: "Close tools", exact: true })
      .click();
    await expect.poll(async () => {
      const [saved] = await clinic.sql`select sidebar_preferences from users where id = ${clinic.userId}`;
      return saved?.sidebar_preferences?.layout;
    }).toBe("full");
    await page.bringToFront();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(
      page.getByRole("list", { name: "Full navigation" }).getByRole("link"),
    ).toHaveCount(18);
  } finally {
    await secondDevice.close();
  }
  await page.evaluate(
    (key) => localStorage.setItem(key, "corrupt preference"),
    key,
  );
  await page.reload();
  await openMainNavigation(page);
  await expect(
    page.getByRole("list", { name: "Full navigation" }).getByRole("link"),
  ).toHaveCount(18);
  await expect(
    page.getByRole("link", { name: "Settings", exact: true }),
  ).toBeVisible();
});

test("sidebar retains unsent choices when another tab refreshes and the original tab closes", async ({ page, clinic }) => {
  const context = page.context();
  await login(context, clinic);
  await page.goto(`/patients/${clinic.patientId}`);
  await page.getByRole("button", { name: "I'll finish later", exact: true }).click();
  await openMainNavigation(page);
  const updates = (url: URL) => url.pathname.includes("sidebar.update");
  await context.route(updates, route => route.abort("failed"));
  await page.getByRole("button", { name: "All tools", exact: true }).click();
  const tools = page.getByRole("dialog", { name: "Tools", exact: true });
  await tools.getByRole("radio", { name: "Focused navigation", exact: true }).check();
  await tools.getByRole("button", { name: "Pin Inventory", exact: true }).click();
  await expect(page.getByText("Sidebar choices are kept on this device. Account sync will retry when connected.", { exact: true })).toBeVisible();
  const [user] = await clinic.sql`select practice_id from users where id = ${clinic.userId}`;
  const prefix = `openvpm.sidebar.v1.${user!.practice_id}.${clinic.userId}.sync-v2.pending.`;
  await expect.poll(() => page.evaluate(prefix => Object.keys(localStorage).filter(key => key.startsWith(prefix)).length, prefix)).toBe(2);

  const peer = await context.newPage();
  try {
    await peer.goto(`/patients/${clinic.patientId}`);
    await openMainNavigation(peer);
    await expect(peer.getByRole("list", { name: "Pinned tools" }).getByRole("link")).toHaveText(["Inventory"]);
    await page.close();
    await context.unroute(updates);
    await peer.reload();
    await openMainNavigation(peer);
    await expect.poll(async () => {
      const [saved] = await clinic.sql`select sidebar_preferences from users where id = ${clinic.userId}`;
      return saved?.sidebar_preferences;
    }).toEqual({ version: 1, layout: "focused", pinned: ["/inventory"] });
    await expect(peer.getByRole("list", { name: "Pinned tools" }).getByRole("link")).toHaveText(["Inventory"]);
    await expect.poll(() => peer.evaluate(prefix => Object.keys(localStorage).filter(key => key.startsWith(prefix)).length, prefix)).toBe(0);
  } finally {
    await context.unroute(updates);
    await peer.close();
  }
});

test("pinning remains usable when browser storage is blocked", async ({
  page,
  clinic,
}) => {
  await login(page.context(), clinic);
  await page.goto(`/patients/${clinic.patientId}`);
  await page
    .getByRole("button", { name: "I'll finish later", exact: true })
    .click();
  await openMainNavigation(page);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key.startsWith("openvpm.sidebar.v1."))
        throw new DOMException(
          "Synthetic blocked storage",
          "QuotaExceededError",
        );
      return original.call(this, key, value);
    };
  });
  await page.getByRole("button", { name: "All tools", exact: true }).click();
  const tools = page.getByRole("dialog", { name: "Tools", exact: true });
  await tools
    .getByRole("radio", { name: "Focused navigation", exact: true })
    .check();
  await tools
    .getByRole("button", { name: "Pin Inventory", exact: true })
    .click();
  await expect(
    page.getByText(
      "Sidebar updated for this session. Browser storage is unavailable.",
      { exact: true },
    ),
  ).toBeVisible();
  await tools.getByRole("button", { name: "Close tools", exact: true }).click();
  await expect(
    page
      .getByRole("list", { name: "Pinned tools" })
      .getByRole("link", { name: "Inventory", exact: true }),
  ).toBeVisible();
});

test("sidebar clinic-day checkout preserves readable charges and refreshes collections without reloading", async ({
  page,
  clinic,
}, info) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  const serviceName = "Comprehensive wellness examination with preventive care consultation";
  await clinic.sql`update services set name = ${serviceName}, code = 'WELLNESS-CONSULT', category = 'Preventive medicine'
    where practice_id = (select practice_id from users where id = ${clinic.userId})`;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => dialog.accept());
  await login(page.context(), clinic);
  await page.goto(`/patients/${clinic.patientId}`);
  await page.getByRole("button", { name: "I'll finish later", exact: true }).click();
  await openMainNavigation(page);
  if (process.env.OFFLINE_E2E_FIELD_VISITS_ENABLED === "false") {
    await expect(page.getByRole("link", { name: "Field Visits", exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Prepare for field visit", exact: true })).toHaveCount(0);
  }
  await page.getByRole("list", { name: "Full navigation" })
    .getByRole("link", { name: "Schedule", exact: true }).click();
  await page.getByRole("button", { name: /Synthetic Offline Patient/ }).first().click();
  await page.getByRole("link", { name: "Open visit", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/encounters/${clinic.appointmentId}`));
  await page.getByRole("button", { name: "Check in", exact: true }).click();
  await page.getByRole("button", { name: "Start exam", exact: true }).click();
  await page.getByRole("button", { name: "Search services...", exact: true }).click();
  const option = page.getByRole("option", { name: new RegExp(serviceName) });
  const name = option.getByText(serviceName, { exact: true });
  await expect(name).toBeVisible();
  expect(await name.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await option.click();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const line = page.locator("div.rounded-md").filter({
    has: page.getByRole("button", { name: `Remove ${serviceName}`, exact: true }),
  }).last();
  const description = line.getByText(serviceName, { exact: true });
  await expect(description).toBeVisible();
  expect(await description.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await line.screenshot({ path: info.outputPath("readable-visit-charge.png") });
  await page.getByRole("button", { name: "Create visit invoice", exact: true }).click();
  await expect.poll(async () => {
    const rows = await clinic.sql`select id from invoices where appointment_id = ${clinic.appointmentId}`;
    return rows.length;
  }).toBe(1);
  const [invoice] = await clinic.sql`select id from invoices where appointment_id = ${clinic.appointmentId}`;

  await page.goto(`/records/new-soap/${clinic.patientId}?appointmentId=${clinic.appointmentId}`);
  const editors = page.locator('[contenteditable="true"]');
  await expect(editors).toHaveCount(4);
  for (const [index, value] of Object.values(sections).entries()) await editors.nth(index).fill(value);
  await page.getByRole("button", { name: "Finalize SOAP note", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/encounters/${clinic.appointmentId}`));
  await page.getByLabel("Home-care instructions").fill("Synthetic home-care instructions reviewed with the owner.");
  await page.getByLabel("Prescriptions", { exact: false }).selectOption("not_needed");
  await page.locator("#closeout-follow-up").selectOption("none");
  await page.getByRole("button", { name: "Finalize clinical handoff", exact: true }).click();
  await expect(page.getByRole("heading", { name: "1. Clinical handoff finalized" })).toBeVisible();

  await page.goto(`/billing?expand=${invoice!.id}`);
  const collections = page.getByText("Collected this month", { exact: true }).locator("..");
  await expect(collections).toContainText("$0.00");
  await page.getByTitle("Mark as Sent", { exact: true }).click();
  await page.getByRole("button", { name: "Record Payment", exact: true }).click();
  await page.getByRole("button", { name: "Record Payment", exact: true }).last().click();
  await expect(collections).toContainText("$21.47");
  const [paid] = await clinic.sql`select status, paid_amount from invoices where id = ${invoice!.id}`;
  expect(paid!.status).toBe("paid");
  expect(Number(paid!.paid_amount)).toBe(21.47);
  await page.screenshot({ path: info.outputPath("collections-after-payment.png"), fullPage: true });

  await page.goto(`/encounters/${clinic.appointmentId}`);
  await page.getByLabel("Billing disposition", { exact: true }).selectOption("paid");
  await page.getByLabel("Owner handoff", { exact: true }).selectOption("verbal");
  await page.getByRole("button", { name: "Complete visit", exact: true }).click();
  await expect.poll(async () => {
    const [appointment] = await clinic.sql`select status from appointments where id = ${clinic.appointmentId}`;
    return appointment!.status;
  }).toBe("checked_out");
  expect(errors).toEqual([]);
});

test("sidebar preserves familiar navigation for every clinic staff role", async ({
  page,
  clinic,
}) => {
  const familiar = [
    "Dashboard",
    "Patients",
    "Clients",
    "Schedule",
    "Records",
    "Lab Inbox",
    "Billing",
    "Inventory",
    "Inbox",
    "Recalls",
    "Care Reminders",
    "Imported History",
    "Whiteboard",
    "Agent",
    "Controlled Substances",
    "Reports",
    "Settings",
  ];
  const restricted: Record<string, string[]> = {
    admin: [],
    veterinarian: ["Settings"],
    technician: [
      "Recalls",
      "Agent",
      "Controlled Substances",
      "Reports",
      "Settings",
    ],
    front_desk: ["Agent", "Controlled Substances", "Reports", "Settings"],
    viewer: [
      "Recalls",
      "Agent",
      "Controlled Substances",
      "Reports",
      "Settings",
    ],
  };
  for (const [role, hidden] of Object.entries(restricted)) {
    await clinic.sql`update users set role = ${role}, is_veterinarian = ${role === "veterinarian"} where email = ${clinic.secondEmail}`;
    await login(page.context(), clinic, clinic.secondEmail);
    await page.goto(`/patients/${clinic.patientId}`);
    if (role === "admin")
      await page
        .getByRole("button", { name: "I'll finish later", exact: true })
        .click();
    await openMainNavigation(page);
    await expect(
      page.getByRole("list", { name: "Full navigation" }).getByRole("link"),
    ).toHaveText(familiar.filter((label) => !hidden.includes(label)));
    // Practice admin alone must never grant clinical field preparation.
    await expect(
      page.getByRole("link", { name: "Prepare for field visit", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "All tools", exact: true }).click();
    const tools = page.getByRole("dialog", { name: "Tools", exact: true });
    await expect(
      tools.getByRole("link", { name: "Open Field Visits", exact: true }),
    ).toHaveCount(0);
    await expect(
      tools.getByRole("link", { name: "Open Reports", exact: true }),
    ).toHaveCount(hidden.includes("Reports") ? 0 : 1);
    await tools
      .getByRole("radio", { name: "Focused navigation", exact: true })
      .check();
    await tools
      .getByRole("link", { name: "Open Records", exact: true })
      .click();
    await expect(page).toHaveURL(/\/records$/);
    await openMainNavigation(page);
    await expect(
      page.getByRole("list", { name: "Core navigation" }).getByRole("link"),
    ).toHaveCount(6);
    await expect(
      page
        .getByLabel("Current tool", { exact: true })
        .getByRole("link", { name: "Records", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await page.getByRole("button", { name: "All tools", exact: true }).click();
    await tools
      .getByRole("radio", { name: "Full navigation", exact: true })
      .check();
    await tools
      .getByRole("button", { name: "Close tools", exact: true })
      .click();
  }
});
