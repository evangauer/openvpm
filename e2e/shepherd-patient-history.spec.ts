import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";

// Opt in with a disposable loopback database and a local preview:
// SHEPHERD_HISTORY_E2E=1
// DATABASE_URL=postgresql://postgres@127.0.0.1:5432/openvpm_shepherd_history_synthetic
// SHEPHERD_HISTORY_E2E_DATABASE_URL must equal DATABASE_URL
// PLAYWRIGHT_BASE_URL=http://127.0.0.1:3000
const enabled = process.env.SHEPHERD_HISTORY_E2E === "1";
const databaseUrl = process.env.SHEPHERD_HISTORY_E2E_DATABASE_URL;
const appUrl = new URL(process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000");

if (enabled) {
  if (!databaseUrl || process.env.DATABASE_URL !== databaseUrl) {
    throw new Error("DATABASE_URL must exactly match SHEPHERD_HISTORY_E2E_DATABASE_URL");
  }
  const db = new URL(databaseUrl);
  if (!["127.0.0.1", "localhost"].includes(db.hostname) || !["127.0.0.1", "localhost", "[::1]"].includes(appUrl.hostname)) {
    throw new Error("Shepherd history browser tests require loopback");
  }
  if (!/^openvpm_shepherd_history_[A-Za-z0-9_]+$/.test(db.pathname.slice(1))) {
    throw new Error("Shepherd history browser tests require an openvpm_shepherd_history_ database");
  }
}

function adaptedHistory() {
  const script = `
    import { adaptShepherdHistory } from "./lib/import/shepherd-history-adapter.ts";
    const history = adaptShepherdHistory(${JSON.stringify(syntheticBundle())}, new Date("2025-01-01T00:00:00Z"));
    process.stdout.write(JSON.stringify({
      historicalAppointments: history.historicalAppointments,
      externalPrescriptions: history.externalPrescriptions,
      externalPrescriptionFills: history.externalPrescriptionFills,
      externalLabReports: history.externalLabReports,
      externalLabObservations: history.externalLabObservations,
    }));
  `;
  const result = spawnSync(
    "pnpm",
    ["--filter", "@openpims/web", "exec", "tsx", "--eval", script],
    { encoding: "utf8", cwd: path.resolve(".") },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || "Could not adapt the synthetic Shepherd bundle");
  }
  return JSON.parse(result.stdout) as {
    historicalAppointments: Array<Record<string, string | undefined>>;
    externalPrescriptions: Array<Record<string, string | undefined>>;
    externalPrescriptionFills: Array<Record<string, string | undefined>>;
    externalLabReports: Array<Record<string, string | undefined>>;
    externalLabObservations: Array<Record<string, string | undefined>>;
  };
}

function syntheticBundle() {
  return {
    client: [{ id: "owner-1", firstname: "Synthetic", lastname: "Owner" }],
    patient: [{ id: "patient-1", name: "Synthetic Canary" }],
    client_patient: [{ clientid: "owner-1", patientid: "patient-1" }],
    appointment: [
      {
        id: "visit-1",
        startdate: "2024-01-10T14:00:00Z",
        enddate: "2024-01-10T14:30:00Z",
        appointmenttypeid: "type-1",
        appointmentstatusid: "status-1",
        visitreason: "Synthetic wellness",
      },
    ],
    appointment_patient: [{ appointmentid: "visit-1", patientid: "patient-1" }],
    appointment_type: [{ id: "type-1", name: "Wellness" }],
    appointment_status: [{ id: "status-1", name: "Completed" }],
    product: [{ id: "product-1", name: "Medication Alpha" }],
    prescription: [
      {
        id: "rx-1",
        patientid: "patient-1",
        productid: "product-1",
        direction: "Historical directions only",
        datecreated: "2024-01-10T14:20:00Z",
        iswritten: "true",
      },
    ],
    refill: [
      {
        id: "fill-1",
        prescriptionid: "rx-1",
        datefilled: "2024-02-01T10:00:00Z",
        quantitydispensed: "1",
      },
    ],
    lab_order: [
      {
        id: "lab-scalar",
        patientid: "patient-1",
        datecreated: "2024-01-10T14:15:00Z",
        orderid: "LAB-S",
        testname: "ALT",
        resultvalue: "42",
        resultunit: "U/L",
        referencerange: "10-40",
        resultflag: "H",
      },
      {
        id: "lab-unlinked",
        datecreated: "2024-01-11T14:15:00Z",
        orderid: "LAB-U",
        testname: "ALT",
        resultvalue: "9",
      },
    ],
    invoice: [
      {
        id: "invoice-1",
        clientid: "owner-1",
        dateissued: "2024-01-10T15:00:00Z",
        subtotal: "10",
        tax: "0",
        discount: "0",
        total: "10",
        balance: "0",
        isinvoice: "true",
      },
    ],
  };
}

test.skip(!enabled, "Set SHEPHERD_HISTORY_E2E=1 with a disposable loopback database");
test.describe.configure({ mode: "serial" });

let patientId = "";
let email = "";
const password = `synthetic-${randomUUID()}`;

async function dismiss(page: Page) {
  for (const name of [/skip for now/i, /finish later/i, /hide for now/i, /I'll finish later/i]) {
    const button = page.getByRole("button", { name }).first();
    if (await button.isVisible()) await button.click();
  }
}

test.beforeAll(async () => {
  if (!enabled) return;
  const require = createRequire(path.resolve("packages/db/package.json"));
  const postgres = require("postgres");
  const bcrypt = require("bcryptjs");
  const sql = postgres(databaseUrl, { max: 1 });
  const history = adaptedHistory();
  const practiceId = randomUUID();
  const userId = randomUUID();
  const clientId = randomUUID();
  patientId = randomUUID();
  email = `shepherd-history-${randomUUID().slice(0, 8)}@example.invalid`;
  const passwordHash = await bcrypt.hash(password, 10);
  const fingerprint = (value: string) =>
    createHash("sha256").update(`synthetic:${value}`).digest("hex");
  try {
    await sql.begin(async (tx: typeof sql) => {
      await tx`insert into practices (id, name, timezone) values (${practiceId}, 'Synthetic Shepherd Clinic', 'America/New_York')`;
      await tx`insert into locations (practice_id, name, is_primary) values (${practiceId}, 'Main', true)`;
      await tx`insert into users (id, practice_id, name, email, password_hash, role, email_verified_at)
        values (${userId}, ${practiceId}, 'Synthetic Clinician', ${email}, ${passwordHash}, 'veterinarian', now())`;
      await tx`insert into clients (id, practice_id, first_name, last_name, external_source, external_id)
        values (${clientId}, ${practiceId}, 'Synthetic', 'Owner', 'shepherd', 'owner-1')`;
      await tx`insert into patients (id, practice_id, client_id, name, species, external_source, external_id)
        values (${patientId}, ${practiceId}, ${clientId}, 'Synthetic Canary', 'canine', 'shepherd', 'patient-1')`;
      for (const visit of history.historicalAppointments) {
        await tx`insert into historical_appointments
          (id, practice_id, patient_id, client_id, started_at, ended_at, status, appointment_type, reason, external_source, external_id, import_fingerprint)
          values (${randomUUID()}, ${practiceId}, ${patientId}, ${clientId}, ${visit.startedAt}, ${visit.endedAt}, ${visit.status}, ${visit.appointmentType ?? null}, ${visit.reason ?? null}, 'shepherd', ${visit.externalAppointmentId}, ${fingerprint(visit.externalAppointmentId)})`;
      }
      for (const prescription of history.externalPrescriptions) {
        const id = randomUUID();
        await tx`insert into external_prescriptions
          (id, practice_id, patient_id, medication_name, directions, prescribed_at, status, external_source, external_id, import_fingerprint)
          values (${id}, ${practiceId}, ${patientId}, ${prescription.medicationName}, ${prescription.directions ?? null}, ${prescription.prescribedAt ?? null}, ${prescription.status}, 'shepherd', ${prescription.externalPrescriptionId}, ${fingerprint(prescription.externalPrescriptionId)})`;
        for (const fill of history.externalPrescriptionFills.filter(
          (row) => row.externalPrescriptionId === prescription.externalPrescriptionId,
        )) {
          await tx`insert into external_prescription_fills
            (id, practice_id, prescription_id, filled_at, quantity_dispensed, external_source, external_id, import_fingerprint)
            values (${randomUUID()}, ${practiceId}, ${id}, ${fill.filledAt ?? null}, ${fill.quantityDispensed ?? null}, 'shepherd', ${fill.externalFillId}, ${fingerprint(fill.externalFillId)})`;
        }
      }
      for (const report of history.externalLabReports) {
        const id = randomUUID();
        await tx`insert into external_lab_reports
          (id, practice_id, patient_id, attribution_status, order_name, resulted_at, status, external_source, external_id, import_fingerprint)
          values (${id}, ${practiceId}, ${report.externalPatientId ? patientId : null}, ${report.attributionStatus}, ${report.orderName ?? null}, ${report.resultedAt ?? null}, ${report.status}, 'shepherd', ${report.externalLabReportId}, ${fingerprint(report.externalLabReportId)})`;
        for (const observation of history.externalLabObservations.filter(
          (row) => row.externalLabReportId === report.externalLabReportId,
        )) {
          await tx`insert into external_lab_observations
            (id, practice_id, report_id, name, value, unit, reference_range, flag, external_source, external_id, import_fingerprint)
            values (${randomUUID()}, ${practiceId}, ${id}, ${observation.name}, ${observation.value ?? null}, ${observation.unit ?? null}, ${observation.referenceRange ?? null}, ${observation.flag ?? null}, 'shepherd', ${observation.externalObservationId}, ${fingerprint(observation.externalObservationId)})`;
        }
      }
    });
  } finally {
    await sql.end();
  }
});

test("imported Shepherd history shows on the patient chart and stays historical", async ({ page }) => {
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
  await dismiss(page);
  await page.goto(`/patients/${patientId}`, { waitUntil: "networkidle" });
  await dismiss(page);
  const history = page.getByTestId("shepherd-chart-history");
  await expect(history.getByText("Imported from Shepherd").first()).toBeVisible();
  await expect(history).toContainText("Synthetic wellness");
  await expect(history).toContainText("Medication Alpha");
  await expect(history).toContainText("cannot be dispensed or refilled");
  await expect(history).toContainText("not on the calendar");
  await expect(history).toContainText("ALT");
  await expect(history).toContainText("42");
  await expect(history).not.toContainText("LAB-U");
  await expect(history).not.toContainText("invoice");
  await page.getByRole("tab", { name: "Appointments", exact: true }).click();
  await expect(page.getByRole("region", { name: "Imported visits" })).toContainText(
    "Synthetic wellness",
  );
  await expect(page.getByText("No appointments yet")).toBeVisible();
});
