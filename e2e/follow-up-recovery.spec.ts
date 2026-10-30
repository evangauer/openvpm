import { expect, test, type Page } from "@playwright/test";
import { isApprovedRehearsalDatabase } from "../test-support/rehearsal-database";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";

// Follow-up recovery after a cancelled follow-up appointment, end to end.
// Runs only against a fresh local server whose DATABASE_URL is an already
// created, already migrated openvpm_followup_test_ database:
//
// FOLLOWUP_RECOVERY_E2E=1
// FOLLOWUP_RECOVERY_E2E_DATABASE_URL=<same value as DATABASE_URL>
// PLAYWRIGHT_BASE_URL=http://127.0.0.1:<port>
// PLAYWRIGHT_WEB_SERVER_COMMAND="pnpm --filter @openpims/web exec next dev -p <port>"
// pnpm exec playwright test e2e/follow-up-recovery.spec.ts --workers=1
//
// The fixture creates its own clinic, staff login, and patient with random
// identifiers, then proves the server sees that patient before any app
// mutation. No screenshots or traces are written by this spec.
const enabled = process.env.FOLLOWUP_RECOVERY_E2E === "1";
const databaseUrl = process.env.FOLLOWUP_RECOVERY_E2E_DATABASE_URL;
const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

let databaseName = "";
if (enabled) {
  if (!databaseUrl || process.env.DATABASE_URL !== databaseUrl) {
    throw new Error(
      "DATABASE_URL must exactly match FOLLOWUP_RECOVERY_E2E_DATABASE_URL",
    );
  }
  const db = new URL(databaseUrl);
  const web = new URL(process.env.PLAYWRIGHT_BASE_URL ?? "http://invalid.test");
  if (!loopbackHosts.has(db.hostname) || !loopbackHosts.has(web.hostname)) {
    throw new Error("Follow-up recovery E2E requires loopback database and web hosts");
  }
  databaseName = decodeURIComponent(db.pathname.slice(1));
  if (!/^openvpm_followup_test_[A-Za-z0-9_]+$/.test(databaseName) && !isApprovedRehearsalDatabase(databaseName)) {
    throw new Error("Follow-up recovery E2E requires a synthetic test database or an explicitly approved release rehearsal");
  }
}

test.skip(!enabled, "Set FOLLOWUP_RECOVERY_E2E=1 with an isolated synthetic database");
test.describe.configure({ mode: "serial" });

const run = randomUUID().slice(0, 8);
const password = randomBytes(18).toString("base64url");
const email = `followup-recovery-${run}@example.invalid`;
const patientName = `Synthetic Recovery ${run}`;
const timeZone = "America/New_York";
const ids = {
  practice: randomUUID(),
  location: randomUUID(),
  staff: randomUUID(),
  client: randomUUID(),
  patient: randomUUID(),
  visit: randomUUID(),
  original: randomUUID(),
  replacement: randomUUID(),
  closeout: randomUUID(),
};
const DAY = 86_400_000;
const startAt = (offsetDays: number, hourUtc: number) => {
  const value = new Date(Date.now() + offsetDays * DAY);
  value.setUTCHours(hourUtc, 0, 0, 0);
  return value;
};
const times = {
  visit: startAt(-1, 15),
  original: startAt(7, 15),
  replacement: startAt(10, 16),
};
const dateLabel = (value: Date) =>
  value.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone,
  });

let sql: any;

test.beforeAll(async () => {
  if (!enabled) return;
  const requireFromDb = createRequire(path.resolve("packages/db/package.json"));
  const requireFromWeb = createRequire(path.resolve("apps/web/package.json"));
  const bcrypt = requireFromWeb("bcryptjs");
  sql = requireFromDb("postgres")(databaseUrl, { max: 1 });

  // Verify the live connection before any fixture mutation.
  const [current] = await sql`select current_database() as name`;
  expect(current.name).toBe(databaseName);

  const passwordHash = await bcrypt.hash(password, 10);
  await sql.begin(async (tx: any) => {
    await tx`insert into practices (id, name, timezone) values (${ids.practice}, ${`Synthetic Follow-up Clinic ${run}`}, ${timeZone})`;
    await tx`insert into locations (id, practice_id, name, is_primary) values (${ids.location}, ${ids.practice}, 'Main', true)`;
    await tx`insert into users (id, email, password_hash, name, role, practice_id, email_verified_at) values (${ids.staff}, ${email}, ${passwordHash}, 'Synthetic Front Desk', 'front_desk', ${ids.practice}, now())`;
    await tx`insert into clients (id, practice_id, first_name, last_name) values (${ids.client}, ${ids.practice}, 'Synthetic', ${`Owner ${run}`})`;
    await tx`insert into patients (id, practice_id, client_id, name, species) values (${ids.patient}, ${ids.practice}, ${ids.client}, ${patientName}, 'canine')`;
    for (const [id, start, status] of [
      [ids.visit, times.visit, "checked_out"],
      [ids.original, times.original, "scheduled"],
      [ids.replacement, times.replacement, "scheduled"],
    ] as const) {
      await tx`insert into appointments (id, practice_id, location_id, patient_id, client_id, status, start_time, end_time, notes) values (${id}, ${ids.practice}, ${ids.location}, ${ids.patient}, ${ids.client}, ${status}, ${start}, ${new Date(start.getTime() + 30 * 60_000)}, 'Synthetic follow-up recovery regression')`;
    }
    // A signed, completed visit whose clinician booked the follow-up.
    await tx`insert into visit_closeouts (
        id, practice_id, appointment_id, status, discharge_instructions,
        prescription_disposition, follow_up_disposition, follow_up_appointment_id,
        follow_up_scheduled_at, documentation_exception_reason,
        clinical_finalized_at, clinical_finalized_by, clinical_finalizer_name,
        charge_disposition, no_charge_reason, handoff_method, completed_at,
        completed_by, revision
      ) values (
        ${ids.closeout}, ${ids.practice}, ${ids.visit}, 'completed',
        'Synthetic discharge instructions.', 'not_needed', 'scheduled',
        ${ids.original}, ${times.original}, 'Synthetic fixture',
        now(), ${ids.staff}, 'Synthetic Clinician',
        'no_charge', 'Synthetic fixture', 'verbal', now(), ${ids.staff}, 2
      )`;
  });
});

test.afterAll(async () => {
  if (sql) await sql.end({ timeout: 2 });
});

async function login(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("openvpm.cookie-consent.v1", "essential");
    sessionStorage.setItem("ovpm_verify_email_dismissed", "1");
  });
  await page.goto("/login", { waitUntil: "networkidle" });
  await page.getByLabel("Email").fill(email);
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

async function rpc(page: Page, procedure: string, input: unknown) {
  const response = await page.request.post(`/api/trpc/${procedure}`, {
    data: { json: input },
  });
  const body = await response.json();
  expect(body.error, JSON.stringify(body)).toBeUndefined();
  return body.result.data.json;
}

// Collect browser errors so a passing flow also proves the app stayed healthy.
function collectAppErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    // A missing static asset (for example a favicon) is not an app error.
    if (/Failed to load resource: .*404/.test(text)) return;
    errors.push(`console: ${text}`);
  });
  return errors;
}

async function expectEncounterPage(page: Page) {
  await page.waitForURL(`**/encounters/${ids.visit}*`);
  expect(new URL(page.url()).pathname).toBe(`/encounters/${ids.visit}`);
  await expect(page).toHaveTitle(/OpenVPM/);
  // No Next.js error overlay.
  await expect(
    page.locator("[data-nextjs-dialog], [data-nextjs-dialog-overlay]"),
  ).toHaveCount(0);
}

function queueItem(page: Page) {
  return page
    .getByTestId("pending-follow-up")
    .filter({ hasText: patientName });
}

async function signedFollowUp() {
  const [row] = await sql`
    select follow_up_disposition, follow_up_appointment_id, follow_up_scheduled_at,
           follow_up_due_date, follow_up_assigned_to, clinical_finalized_at,
           amendment_history, follow_up_resolution, follow_up_resolution_appointment_id,
           revision
    from visit_closeouts where id = ${ids.closeout}`;
  return row;
}

test("a cancelled follow-up returns to the clinic team, is rebooked, and returns when the rebooking is cancelled", async ({
  page,
}) => {
  test.setTimeout(120_000);
  // Vercel analytics is unavailable in the local production preview.
  await page.route("**/_vercel/insights/script.js", route => route.fulfill({ status: 200, contentType: "application/javascript", body: "/* synthetic analytics stub */" }));
  await page.route("**/api/funnel-event", route => route.fulfill({ status: 204 }));
  const appErrors = collectAppErrors(page);
  await login(page);

  // Prove this server reads the freshly created random fixture before any
  // app mutation.
  const probe = await page.request.get(
    `/api/trpc/patients.getById?input=${encodeURIComponent(
      JSON.stringify({ json: { id: ids.patient } }),
    )}`,
  );
  const probeBody = await probe.json();
  expect(
    probeBody.result?.data?.json?.id,
    "Server must use this disposable database",
  ).toBe(ids.patient);
  const signedBefore = await signedFollowUp();

  await page.goto("/", { waitUntil: "networkidle" });
  await expect(
    page.getByRole("heading", { name: "Follow-up work queue" }),
  ).toBeVisible();
  await expect(queueItem(page)).toHaveCount(0);

  await rpc(page, "appointments.updateStatus", {
    id: ids.original,
    status: "cancelled",
  });

  await page.reload({ waitUntil: "networkidle" });
  const cancelled = queueItem(page);
  await expect(cancelled).toHaveCount(1);
  await expect(cancelled).toContainText("Cancelled appointment");
  await expect(cancelled).toContainText(dateLabel(times.original));
  await expect(cancelled).toContainText("Clinic team");
  await expect(cancelled).not.toContainText("due ");

  await cancelled.getByRole("link", { name: "Rebook follow-up" }).click();
  await expectEncounterPage(page);
  const panel = page.getByTestId("follow-up-resolution-panel");
  await expect(
    panel.getByRole("heading", { name: "Follow-up needs rebooking" }),
  ).toBeVisible();
  await expect(panel).toContainText("Cancelled appointment");
  await expect(panel).toContainText("Assigned to clinic team");
  await panel.getByLabel("Resolution").selectOption("scheduled");
  await panel
    .getByLabel("Scheduled appointment")
    .selectOption(ids.replacement);
  await panel.getByRole("button", { name: "Resolve follow-up" }).click();
  await expect(
    page.getByText("Follow-up obligation resolved with attribution"),
  ).toBeVisible();
  // The saved outcome stays visible on the visit after the queue clears.
  await expect(panel.getByText("Resolved as scheduled")).toBeVisible();
  await expect(panel.getByText(/Synthetic Front Desk ·/)).toBeVisible();
  await expect(panel.getByText(/· Scheduled /)).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Resolve follow-up" }),
  ).toHaveCount(0);
  await page.reload({ waitUntil: "networkidle" });
  await expectEncounterPage(page);
  await expect(panel.getByText("Resolved as scheduled")).toBeVisible();

  const relinked = await signedFollowUp();
  expect(relinked).toMatchObject({
    follow_up_resolution: "scheduled",
    follow_up_resolution_appointment_id: ids.replacement,
    revision: signedBefore.revision + 1,
  });
  // The signed handoff is unchanged.
  for (const field of [
    "follow_up_disposition",
    "follow_up_appointment_id",
    "follow_up_scheduled_at",
    "follow_up_due_date",
    "follow_up_assigned_to",
    "clinical_finalized_at",
    "amendment_history",
  ]) {
    expect(relinked[field]).toEqual(signedBefore[field]);
  }

  await page.goto("/", { waitUntil: "networkidle" });
  await expect(
    page.getByRole("heading", { name: "Follow-up work queue" }),
  ).toBeVisible();
  await expect(queueItem(page)).toHaveCount(0);

  await rpc(page, "appointments.updateStatus", {
    id: ids.replacement,
    status: "cancelled",
  });
  await page.reload({ waitUntil: "networkidle" });
  const returned = queueItem(page);
  await expect(returned).toHaveCount(1);
  await expect(returned).toContainText("Cancelled appointment");
  await expect(returned).toContainText(dateLabel(times.replacement));

  await returned.getByRole("link", { name: "Rebook follow-up" }).click();
  await expectEncounterPage(page);
  await expect(
    panel.getByRole("heading", { name: "Follow-up needs rebooking" }),
  ).toBeVisible();
  await expect(
    panel.getByText(/Previously rebooked by Synthetic Front Desk/),
  ).toBeVisible();
  await expect(panel.getByLabel("Resolution")).toBeVisible();

  // Leave the recovery form on screen and check it fits the viewport width.
  await panel.scrollIntoViewIfNeeded();
  await expect(panel).toBeInViewport();
  const box = await panel.boundingBox();
  const viewport = page.viewportSize();
  expect(box, "Recovery panel must be laid out").not.toBeNull();
  expect(viewport, "Viewport size must be known").not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);

  expect(appErrors, appErrors.join("\n")).toEqual([]);
});
