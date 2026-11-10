import { test as base, expect, type Page, type BrowserContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(path.resolve("apps/web/package.json"));
const postgres = require("postgres") as typeof import("../apps/web/node_modules/postgres");
const { hash } = require("bcryptjs") as typeof import("../apps/web/node_modules/@types/bcryptjs");
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
  sql: ReturnType<typeof postgres>;
};

const test = base.extend<{ clinic: Clinic }>({
  clinic: async ({}, use) => {
    const directory = process.env.OFFLINE_E2E_DIRECTORY;
    if (!directory) throw new Error("Use playwright.offline.config.ts; this suite never attaches to an existing clinic.");
    const { ownerUrl, controlToken } = JSON.parse(await readFile(path.join(directory, "fixture.json"), "utf8"));
    const url = new URL(ownerUrl);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
        !/^\/openvpm_offline_e2e_[a-f0-9]{32}$/.test(url.pathname)) {
      throw new Error("Unsafe offline acceptance database.");
    }
    const sql = postgres(ownerUrl, { max: 1 });
    try {
      const [database] = await sql`select current_database() as name`;
      expect(database!.name).toBe(url.pathname.slice(1));
      const suffix = randomUUID();
      const password = `Synthetic-${randomUUID()}`;
      const passwordHash = await hash(password, 10);
      const [practice] = await sql`insert into practices (name, timezone) values ('Synthetic offline acceptance clinic', 'UTC') returning id`;
      const email = `offline-${suffix}@example.invalid`;
      const secondEmail = `offline-second-${suffix}@example.invalid`;
      const [user] = await sql`insert into users (practice_id, email, password_hash, name, role, is_veterinarian, email_verified_at)
        values (${practice!.id}, ${email}, ${passwordHash}, 'Synthetic Offline Clinician', 'veterinarian', true, now()) returning id`;
      await sql`insert into users (practice_id, email, password_hash, name, role, is_veterinarian, email_verified_at)
        values (${practice!.id}, ${secondEmail}, ${passwordHash}, 'Synthetic Second Clinician', 'veterinarian', true, now())`;
      await sql`insert into locations (practice_id, name, is_primary) values (${practice!.id}, 'Synthetic location', true)`;
      const [client] = await sql`insert into clients (practice_id, first_name, last_name) values (${practice!.id}, 'Synthetic', 'Owner') returning id`;
      const [patient] = await sql`insert into patients (practice_id, client_id, name, species)
        values (${practice!.id}, ${client!.id}, 'Synthetic Offline Patient', 'feline') returning id`;
      const [appointment] = await sql`insert into appointments (practice_id, patient_id, client_id, doctor_id, status, start_time, end_time)
        values (${practice!.id}, ${patient!.id}, ${client!.id}, ${user!.id}, 'in_exam', now(), now() + interval '30 minutes') returning id`;
      await use({ sql, email, secondEmail, password, controlToken, userId: user!.id, patientId: patient!.id, appointmentId: appointment!.id });
    } finally {
      try {
        const response = await fetch("http://127.0.0.1:3456/reconnect", { method: "POST", headers: { authorization: `Bearer ${controlToken}` } });
        expect(response.ok).toBe(true);
      } finally {
        await sql.end();
      }
    }
  },
});

async function login(context: BrowserContext, clinic: Clinic, email = clinic.email) {
  const csrf = await context.request.get("/api/auth/csrf");
  expect(csrf.ok()).toBe(true);
  const { csrfToken } = await csrf.json();
  const response = await context.request.post("/api/auth/callback/credentials", {
    form: { csrfToken, email, password: clinic.password, callbackUrl: "/", json: "true" },
  });
  expect(response.ok()).toBe(true);
  const session = await context.request.get("/api/auth/session");
  expect((await session.json()).user?.email).toBe(email);
}

function target(clinic: Clinic) {
  return `/offline/index.html#patientId=${clinic.patientId}&appointmentId=${clinic.appointmentId}`;
}
async function unlock(page: Page, exists = true) {
  await page.getByLabel("Workspace passphrase", { exact: true }).fill(passphrase);
  if (!exists) await page.getByLabel("Confirm passphrase", { exact: true }).fill(passphrase);
  await page.getByRole("button", { name: exists ? "Unlock workspace" : "Create encrypted workspace", exact: true }).click();
  await expect(page.getByRole("button", { name: "Lock workspace", exact: true })).toBeVisible();
}
async function prepare(page: Page, clinic: Clinic, fromOnlineEditor = false) {
  await login(page.context(), clinic);
  if (fromOnlineEditor) {
    await page.goto(`/records/new-soap/${clinic.patientId}?appointmentId=${clinic.appointmentId}`);
    await page.getByRole("link", { name: "Make available offline", exact: true }).click();
  } else await page.goto(target(clinic));
  await unlock(page, false);
  await page.getByRole("button", { name: "Prepare selected chart", exact: true }).click();
  await expect(page.getByText("Chart saved for offline use. Bookmark this workspace before you disconnect.", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Subjective", exact: true })).toBeEditable();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await expect(page.locator("#main-content")).toHaveCSS("padding-left", "24px");
}
async function edit(page: Page, values: Partial<typeof sections> = sections) {
  for (const field of fields) {
    const value = values[field.toLowerCase() as keyof typeof sections];
    if (value !== undefined) await page.getByRole("textbox", { name: field, exact: true }).fill(value);
  }
  await expect(page.getByRole("status").filter({ hasText: /^Encrypted device copy saved$/ })).toBeVisible();
}
async function expectNote(clinic: Clinic, values: Partial<typeof sections>, revision = 1) {
  await expect.poll(async () => {
    const rows = await clinic.sql`select subjective, objective, assessment, plan, revision, status from soap_notes where appointment_id = ${clinic.appointmentId}`;
    return rows.map((row) => ({ ...row }));
  }).toEqual([expect.objectContaining({ ...values, revision, status: "draft" })]);
}
async function expectNoNote(clinic: Clinic) {
  expect(await clinic.sql`select id from soap_notes where appointment_id = ${clinic.appointmentId}`).toHaveLength(0);
}
async function saved(page: Page) {
  await page.getByRole("button", { name: "Save draft online", exact: true }).click();
  await expect(page.getByText("Draft saved to OpenVPM. Review and sign it in the online visit editor.", { exact: true })).toBeVisible();
}
async function reopen(page: Page) {
  const context = page.context();
  await page.close();
  const fresh = await context.newPage();
  const response = await fresh.goto("/offline/index.html");
  expect(response?.fromServiceWorker()).toBe(true);
  await unlock(fresh);
  return fresh;
}

async function originAvailable(clinic: Clinic, available: boolean) {
  const response = await fetch(`http://127.0.0.1:3456/${available ? "reconnect" : "disconnect"}`, {
    method: "POST", headers: { authorization: `Bearer ${clinic.controlToken}` },
  });
  expect(response.ok).toBe(true);
  if (!available) await expect(fetch("http://127.0.0.1:3457/api/auth/csrf")).rejects.toThrow();
}

test("cold offline reopening retains all SOAP sections and saves one exact draft after reconnecting", async ({ page, clinic, browserName }, info) => {
  const errors: string[] = [];
  page.context().on("page", (opened) => opened.on("pageerror", (error) => errors.push(error.message)));
  page.on("pageerror", (error) => errors.push(error.message));
  await prepare(page, clinic, true);
  // The server has no note before the clinician explicitly saves it.
  await expectNoNote(clinic);
  if (browserName === "webkit") await originAvailable(clinic, false);
  else await page.context().setOffline(true);
  await edit(page);
  page = await reopen(page);
  await expect(page).toHaveTitle(/Offline workspace/i);
  // Cached CSS must survive alongside HTML/JS; a bare text shell is not ready.
  await expect(page.locator("#main-content")).toHaveCSS("padding-left", "24px");
  for (const field of fields) {
    await expect(page.getByRole("textbox", { name: field, exact: true })).toHaveText(sections[field.toLowerCase() as keyof typeof sections]);
  }
  if (browserName === "webkit") {
    await page.getByRole("button", { name: "Save draft online", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("could not be reached");
  } else await expect(page.getByRole("button", { name: "Save draft online", exact: true })).toBeDisabled();
  await expectNoNote(clinic);
  await page.screenshot({ path: info.outputPath("offline-reopened.png"), fullPage: true });
  if (browserName === "webkit") await originAvailable(clinic, true);
  else await page.context().setOffline(false);
  await saved(page);
  const html = Object.fromEntries(await Promise.all(fields.map(async (field) => [field.toLowerCase(), await page.getByRole("textbox", { name: field, exact: true }).innerHTML()])));
  await expectNote(clinic, html);
  await page.getByRole("link", { name: "Review online visit", exact: true }).click();
  for (const [index, field] of fields.entries()) {
    await expect(page.getByRole("textbox", { name: "SOAP note section", exact: true }).nth(index)).toHaveText(sections[field.toLowerCase() as keyof typeof sections]);
  }
  expect(errors).toEqual([]);
});

test("a committed save with a lost response retries the same request after reopening without duplication", async ({ page, clinic }) => {
  await prepare(page, clinic);
  await edit(page, { subjective: "Synthetic lost-response note" });
  const expected = { subjective: await page.getByRole("textbox", { name: "Subjective", exact: true }).innerHTML() };
  const armed = await fetch("http://127.0.0.1:3456/drop-next-save", {
    method: "POST", headers: { authorization: `Bearer ${clinic.controlToken}` },
  });
  expect(armed.ok).toBe(true);
  await page.getByRole("button", { name: "Save draft online", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry draft save", exact: true })).toBeEnabled();
  await expect(page.getByRole("textbox", { name: "Subjective", exact: true })).toHaveAttribute("contenteditable", "false");
  await expectNote(clinic, expected);
  page = await reopen(page);
  await expect(page.getByRole("textbox", { name: "Subjective", exact: true })).toHaveText("Synthetic lost-response note");
  await page.getByRole("button", { name: "Retry draft save", exact: true }).click();
  await expect(page.getByText("Draft saved to OpenVPM. Review and sign it in the online visit editor.", { exact: true })).toBeVisible();
  const recorded = await fetch("http://127.0.0.1:3456/save-requests", {
    method: "POST", headers: { authorization: `Bearer ${clinic.controlToken}` },
  });
  expect(recorded.ok).toBe(true);
  const requests: string[] = await recorded.json();
  expect(requests).toHaveLength(2);
  expect(requests[1]).toBe(requests[0]);
  await expectNote(clinic, expected);
});

for (const finalize of [false, true]) {
  test(`a ${finalize ? "signed note" : "newer server draft"} preserves local text for explicit review`, async ({ page, browser, clinic }, info) => {
    await prepare(page, clinic);
    await page.context().setOffline(true);
    await edit(page, { plan: "Synthetic local plan to preserve" });
    const second = await browser.newContext({ baseURL: "http://127.0.0.1:3457" });
    try {
      const online = await second.newPage();
      await prepare(online, { ...clinic, email: clinic.secondEmail });
      await edit(online, { plan: "Synthetic newer online plan" });
      const serverHtml = await online.getByRole("textbox", { name: "Plan", exact: true }).innerHTML();
      await saved(online);
      if (finalize) {
        const [note] = await clinic.sql`select id, revision from soap_notes where appointment_id = ${clinic.appointmentId}`;
        const response = await second.request.post("/api/trpc/records.finalizeSoapNote", {
          data: { json: { patientId: clinic.patientId, appointmentId: clinic.appointmentId, noteId: note!.id, expectedRevision: note!.revision } },
          headers: { origin: "http://127.0.0.1:3457" },
        });
        expect(response.ok(), await response.text()).toBe(true);
      }
      await page.context().setOffline(false);
      await page.getByRole("button", { name: "Save draft online", exact: true }).click();
      await expect(page.getByRole("heading", { name: finalize ? "This visit was signed online" : "A newer draft is on the server", exact: true })).toBeVisible();
      await expect(page.getByRole("textbox", { name: "Plan", exact: true })).toHaveText("Synthetic local plan to preserve");
      await page.getByText("Show server note", { exact: true }).click();
      await expect(page.getByText("Synthetic newer online plan", { exact: true })).toBeVisible();
      await page.screenshot({ path: info.outputPath("preserved-conflict.png"), fullPage: true });
      page = await reopen(page);
      await expect(page.getByRole("textbox", { name: "Plan", exact: true })).toHaveText("Synthetic local plan to preserve");
      await expect(page.getByRole("button", { name: "Review conflict online", exact: true })).toBeDisabled();
      const rows = await clinic.sql`select plan, status from soap_notes where appointment_id = ${clinic.appointmentId}`;
      expect(rows.map((row) => ({ ...row }))).toEqual([{ plan: serverHtml, status: finalize ? "finalized" : "draft" }]);
    } finally {
      await second.close();
    }
  });
}

test("a stale tab cannot overwrite the winning encrypted draft or submit its stale text", async ({ page, clinic }) => {
  await prepare(page, clinic);
  const stale = await page.context().newPage();
  await stale.goto("/offline/index.html");
  await unlock(stale);
  // Unlocking itself advances the vault revision. Reload the winning tab first.
  page = await reopen(page);
  await edit(page, { subjective: "Synthetic winning tab" });
  await stale.getByRole("textbox", { name: "Subjective", exact: true }).fill("Synthetic stale tab");
  await expect(stale.getByRole("alert")).toContainText("changed in another tab");
  await expect(stale.getByRole("button", { name: "Save draft online", exact: true })).toBeDisabled();
  await expect(stale.getByRole("textbox", { name: "Subjective", exact: true })).toHaveText("Synthetic stale tab");
  await expectNoNote(clinic);
  await stale.close();
  page = await reopen(page);
  await expect(page.getByRole("textbox", { name: "Subjective", exact: true })).toHaveText("Synthetic winning tab");
  const expected = { subjective: await page.getByRole("textbox", { name: "Subjective", exact: true }).innerHTML() };
  await saved(page);
  await expectNote(clinic, expected);
});

test("expired offline authorization locks charts while retaining drafts for renewed online access", async ({ page, clinic, browserName }) => {
  await prepare(page, clinic);
  await edit(page, { subjective: "Synthetic retained expired draft" });
  if (browserName === "webkit") await originAvailable(clinic, false);
  else await page.context().setOffline(true);
  await page.clock.setFixedTime(new Date(Date.now() + 25 * 3_600_000));
  await page.reload();
  await page.getByLabel("Workspace passphrase", { exact: true }).fill(passphrase);
  await page.getByRole("button", { name: "Unlock workspace", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Connect and sign in");
  await expect(page.getByRole("textbox", { name: "Subjective", exact: true })).toHaveCount(0);
  await expectNoNote(clinic);
  await page.clock.setFixedTime(new Date());
  if (browserName === "webkit") await originAvailable(clinic, true);
  else await page.context().setOffline(false);
  await unlock(page);
  await expect(page.getByRole("textbox", { name: "Subjective", exact: true })).toHaveText("Synthetic retained expired draft");
  const expected = { subjective: await page.getByRole("textbox", { name: "Subjective", exact: true }).innerHTML() };
  await saved(page);
  await expectNote(clinic, expected);
});

test("changing the signed-in account locks the workspace and preserves the owner's draft", async ({ page, clinic }) => {
  await prepare(page, clinic);
  await edit(page, { subjective: "Synthetic original owner draft" });
  await login(page.context(), clinic, clinic.secondEmail);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByRole("heading", { name: "Unlock your saved charts", exact: true })).toBeVisible();
  await page.getByLabel("Workspace passphrase", { exact: true }).fill(passphrase);
  await page.getByRole("button", { name: "Unlock workspace", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Sign in as the person who prepared");
  await expectNoNote(clinic);
  await login(page.context(), clinic);
  await unlock(page);
  await expect(page.getByRole("textbox", { name: "Subjective", exact: true })).toHaveText("Synthetic original owner draft");
  const expected = { subjective: await page.getByRole("textbox", { name: "Subjective", exact: true }).innerHTML() };
  await saved(page);
  await expectNote(clinic, expected);
});

test("a failed IndexedDB write keeps unsaved text visible and leaves the prior encrypted copy recoverable", async ({ page, clinic }) => {
  await prepare(page, clinic);
  await edit(page, { subjective: "Synthetic last durable draft" });
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      const request = put.apply(this, args);
      if (this.transaction.db.name === "openvpm-offline-workspace-v1") this.transaction.abort();
      return request;
    };
  });
  await page.getByRole("textbox", { name: "Subjective", exact: true }).fill("Synthetic newer text still in this tab");
  await expect(page.getByRole("alert")).toContainText("Unable to save the device draft. Keep this tab open.");
  await expect(page.getByText("Device copy needs attention", { exact: true })).toBeVisible();
  await expect(page.getByText("Encrypted device copy saved", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Subjective", exact: true })).toHaveText("Synthetic newer text still in this tab");
  await expect(page.getByRole("button", { name: "Save draft online", exact: true })).toBeDisabled();
  await expectNoNote(clinic);
  const recovery = await page.context().newPage();
  await recovery.goto("/offline/index.html");
  await unlock(recovery);
  await expect(recovery.getByRole("textbox", { name: "Subjective", exact: true })).toHaveText("Synthetic last durable draft");
  // Do not close the failed tab until the clinician's in-memory text is checked.
  await expect(page.getByRole("textbox", { name: "Subjective", exact: true })).toHaveText("Synthetic newer text still in this tab");
});

test("unavailable device storage cannot report a prepared or saved workspace", async ({ page, clinic }) => {
  await login(page.context(), clinic);
  await page.addInitScript(() => {
    Object.defineProperty(window, "indexedDB", {
      get() { throw new DOMException("Synthetic storage denied", "SecurityError"); },
    });
  });
  await page.goto(target(clinic));
  await expect(page.getByRole("alert")).toContainText("Synthetic storage denied");
  await page.getByLabel("Workspace passphrase", { exact: true }).fill(passphrase);
  await page.getByLabel("Confirm passphrase", { exact: true }).fill(passphrase);
  await page.getByRole("button", { name: "Create encrypted workspace", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Synthetic storage denied");
  await expect(page.getByRole("button", { name: "Lock workspace", exact: true })).toHaveCount(0);
  await expectNoNote(clinic);
});
