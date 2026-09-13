import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";

// Run only against a fresh local server pointed at a disposable seeded DB.
// PATIENT_DOCUMENTS_E2E=1 DATABASE_URL=... PATIENT_DOCUMENTS_E2E_DATABASE_URL=...
// PLAYWRIGHT_BASE_URL=http://localhost:3501
// PLAYWRIGHT_WEB_SERVER_COMMAND="pnpm --filter @openpims/web exec next dev -p 3501"
// pnpm exec playwright test e2e/patient-documents.spec.ts --workers=1
const enabled = process.env.PATIENT_DOCUMENTS_E2E === "1";
const email = process.env.PATIENT_DOCUMENTS_E2E_EMAIL ?? "sarah.chen@neighborhoodvet.example.com";
const password = process.env.PATIENT_DOCUMENTS_E2E_PASSWORD ?? "password123";
const patientId = process.env.PATIENT_DOCUMENTS_E2E_PATIENT_ID ?? randomUUID();
const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
const databaseUrl = process.env.PATIENT_DOCUMENTS_E2E_DATABASE_URL;

if (enabled) {
  if (!databaseUrl || process.env.DATABASE_URL !== databaseUrl) {
    throw new Error("DATABASE_URL must exactly match PATIENT_DOCUMENTS_E2E_DATABASE_URL");
  }
  const storage = new URL(process.env.S3_ENDPOINT ?? "http://invalid.test");
  if (!localHosts.has(storage.hostname) || process.env.FILE_STORAGE_PROVIDER === "vercel_blob") {
    throw new Error("Patient documents E2E requires local S3-compatible storage");
  }
  if (/^(1|true|yes|on)$/i.test(process.env.FILE_REPLICA_ENABLED ?? "")) {
    const replica = new URL(process.env.FILE_REPLICA_S3_ENDPOINT ?? "http://invalid.test");
    if (!localHosts.has(replica.hostname) || process.env.FILE_REPLICA_PROVIDER === "vercel_blob") {
      throw new Error("Patient documents E2E replicas must also use local storage");
    }
  }
  const db = new URL(databaseUrl);
  const web = new URL(process.env.PLAYWRIGHT_BASE_URL ?? "http://invalid.test");
  if (!localHosts.has(db.hostname) || !localHosts.has(web.hostname)) {
    throw new Error("Patient documents E2E requires local database and web hosts");
  }
  if (!/^openvpm_patient_documents_[a-zA-Z0-9_]+$/.test(db.pathname.slice(1))) {
    throw new Error("Patient documents E2E requires an openvpm_patient_documents_ disposable database");
  }
}

test.skip(!enabled, "Set PATIENT_DOCUMENTS_E2E=1 with an isolated synthetic database");
test.describe.configure({ mode: "serial" });
let viewerEmail: string;
let foreignPatientId: string | undefined;

async function login(page: Page, account = email) {
  await page.addInitScript(() => {
    localStorage.setItem("openvpm.cookie-consent.v1", "essential");
    sessionStorage.setItem("ovpm_verify_email_dismissed", "1");
  });
  await page.goto("/login", { waitUntil: "networkidle" });
  await page.getByLabel("Email").fill(account);
  await page.getByLabel("Password").fill(password);
  await Promise.all([
    page.waitForURL((url) => url.pathname !== "/login", { timeout: 60_000 }),
    page.getByRole("button", { name: "Sign in", exact: true }).click(),
  ]);
  for (const name of [/skip for now/i, /finish later/i, /hide for now/i]) {
    const button = page.getByRole("button", { name }).first();
    if (await button.isVisible()) await button.click();
  }
}

function pdf(name = `synthetic-report-${randomUUID()}.pdf`) {
  // Minimal synthetic PDF bytes: no clinical or personal information.
  return { name, mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n") };
}

test.beforeAll(async () => {
  if (!enabled) return;
  const require = createRequire(path.resolve("packages/db/package.json"));
  const sql = require("postgres")(databaseUrl, { max: 1 });
  try {
    const [database] = await sql`select current_database() as name`;
    expect(database.name).toBe(new URL(databaseUrl!).pathname.slice(1));
    const [staff] = await sql`select id, practice_id, password_hash from users where email = ${email} and deleted_at is null`;
    expect(staff, "Seeded clinician must exist").toBeTruthy();
    if (!process.env.PATIENT_DOCUMENTS_E2E_PATIENT_ID) {
      const [owner] = await sql`select id from clients where practice_id = ${staff.practice_id} and deleted_at is null limit 1`;
      expect(owner, "Synthetic clinic must have a client").toBeTruthy();
      await sql`insert into patients (id, practice_id, client_id, name, species) values (${patientId}, ${staff.practice_id}, ${owner.id}, 'Document validation patient', 'canine')`;
    }
    const [patient] = await sql`select id from patients where id = ${patientId} and practice_id = ${staff.practice_id} and deleted_at is null`;
    expect(patient, "Synthetic patient must belong to the seeded clinician").toBeTruthy();
    viewerEmail = `document-viewer-${randomUUID()}@example.test`;
    await sql`insert into users (email, password_hash, name, role, practice_id, email_verified_at) values (${viewerEmail}, ${staff.password_hash}, 'Synthetic document viewer', 'viewer', ${staff.practice_id}, now())`;
    const [foreign] = await sql`select id from patients where practice_id <> ${staff.practice_id} and deleted_at is null limit 1`;
    foreignPatientId = foreign?.id;
    if (!foreignPatientId) {
      const [practice] = await sql`insert into practices (name) values ('Synthetic document isolation clinic') returning id`;
      const [client] = await sql`insert into clients (practice_id, first_name, last_name) values (${practice.id}, 'Synthetic', 'Document isolation owner') returning id`;
      const [patient] = await sql`insert into patients (practice_id, client_id, name, species) values (${practice.id}, ${client.id}, 'Synthetic isolated patient', 'canine') returning id`;
      foreignPatientId = patient.id;
    }
  } finally {
    await sql.end();
  }
});

async function capture(page: Page, info: TestInfo, name: string) {
  const dir = process.env.PATIENT_DOCUMENTS_SCREENSHOT_DIR ?? info.outputDir;
  await mkdir(dir, { recursive: true });
  const screenshotPath = path.join(dir, `${name}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await info.attach(name, { path: screenshotPath, contentType: "image/png" });
}

test("uploads a lab PDF from the patient chart and downloads the exact stored bytes", async ({ page }, info) => {
  test.setTimeout(120_000);
  await login(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/patients/${patientId}`, { waitUntil: "networkidle" });
  await page.getByRole("tab", { name: "Documents", exact: true }).click();
  const file = pdf();
  await page.getByLabel("Document category").selectOption("lab-results");
  await page.getByLabel("File", { exact: true }).setInputFiles(file);
  await page.getByRole("button", { name: "Upload document", exact: true }).click();
  await expect(page.getByText("Lab report attached", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Lab reports \(/ }).click();
  const row = page.locator("li").filter({ hasText: file.name });
  await expect(row).toHaveCount(1);
  const downloadUrl = await row.getByRole("link", { name: "Download", exact: true }).getAttribute("href");
  const stored = await page.request.get(downloadUrl!);
  expect(stored.status()).toBe(200);
  expect(stored.headers()["content-type"]).toContain("application/pdf");
  expect(await stored.body()).toEqual(file.buffer);
  await info.attach("stored-synthetic-report.pdf", { body: await stored.body(), contentType: "application/pdf" });
  await capture(page, info, "patient-documents-desktop-uploaded");
  await page.setViewportSize({ width: 390, height: 844 });
  await capture(page, info, "patient-documents-mobile-uploaded");
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("tab", { name: "Documents", exact: true }).click();
  await expect(page.locator("li").filter({ hasText: file.name })).toHaveCount(1);
});

test("replays one idempotency key without another attachment and rejects changed contents", async ({ page }) => {
  await login(page);
  const file = pdf();
  const key = randomUUID();
  const options = { headers: { "Idempotency-Key": key }, multipart: { file, category: "documents", patientId } };
  const first = await page.request.post("/api/upload", options);
  expect(first.status()).toBe(201);
  const location = await first.json();
  const replay = await page.request.post("/api/upload", options);
  expect(replay.status()).toBe(200);
  expect(await replay.json()).toEqual(location);
  expect(await (await page.request.get(location.url)).body()).toEqual(file.buffer);
  const conflict = await page.request.post("/api/upload", {
    ...options,
    multipart: { ...options.multipart, file: { ...file, buffer: Buffer.from("%PDF-1.4\nchanged") } },
  });
  expect(conflict.status()).toBe(409);
  await page.goto(`/patients/${patientId}`, { waitUntil: "networkidle" });
  await page.getByRole("tab", { name: "Documents", exact: true }).click();
  await expect(page.locator("li").filter({ hasText: file.name })).toHaveCount(1);
});

test("rejects viewer uploads and hides the upload action", async ({ page }) => {
  await login(page, viewerEmail);
  const response = await page.request.post("/api/upload", {
    headers: { "Idempotency-Key": randomUUID() },
    multipart: { file: pdf(), category: "documents", patientId },
  });
  expect(response.status()).toBe(403);
  await page.goto(`/patients/${patientId}`, { waitUntil: "networkidle" });
  await page.getByRole("tab", { name: "Documents", exact: true }).click();
  await expect(page.getByRole("button", { name: "Upload document", exact: true })).toHaveCount(0);
});

test("rejects attaching a document to another practice's patient", async ({ page }) => {
  expect(foreignPatientId, "Cross-practice patient fixture must exist").toBeTruthy();
  await login(page);
  const response = await page.request.post("/api/upload", {
    headers: { "Idempotency-Key": randomUUID() },
    multipart: { file: pdf(), category: "documents", patientId: foreignPatientId! },
  });
  expect(response.status()).toBe(404);
});
