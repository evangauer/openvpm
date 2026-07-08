import { test, expect, type Page } from "@playwright/test";
import path from "path";
import fs from "fs";

/**
 * Phase 5 dogfood: "run the clinic for a day" on a freshly registered
 * practice (Track B). Local-only driver; screenshots go to DOGFOOD_SHOTS.
 * Not part of CI — run section by section with --grep "Dogfood".
 */

const BASE = process.env.DOGFOOD_URL ?? "http://localhost:3004";
const SHOTS =
  process.env.DOGFOOD_SHOTS ??
  path.resolve(__dirname, "../.dogfood-shots");
const EMAIL = process.env.DOGFOOD_EMAIL ?? "dogfood-admin@example.com";
const PASSWORD = process.env.DOGFOOD_PASSWORD ?? "dogfood-password-1";
const PRACTICE = "Aspen Creek Animal Hospital";

test.use({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
test.describe.configure({ mode: "serial" });

let shotIndex = 0;
async function shot(page: Page, name: string) {
  fs.mkdirSync(SHOTS, { recursive: true });
  shotIndex += 1;
  await page
    .screenshot({
      path: path.join(SHOTS, `${String(shotIndex).padStart(2, "0")}-${name}.png`),
      fullPage: false,
    })
    .catch(() => {});
}

async function login(page: Page) {
  await page.goto("/login", { waitUntil: "networkidle" });
  await page.fill("#email", EMAIL);
  await page.fill("#password", PASSWORD);
  await Promise.all([
    page.waitForURL((url) => url.pathname === "/", { timeout: 30_000 }),
    page.click('button[type="submit"]'),
  ]);
  await page.waitForTimeout(1000);
  // If the wizard re-opens, park it; individual tests reopen what they need.
  const later = page.getByText(/finish later/i).first();
  if (await later.isVisible().catch(() => false)) {
    await later.click();
    await page.waitForTimeout(500);
  }
  const cookie = page.getByRole("button", { name: /essential only/i });
  if (await cookie.isVisible().catch(() => false)) await cookie.click();
}

test("Dogfood A: signup, wizard, dashboard", async ({ page }) => {
  test.setTimeout(300_000);

  await page.goto("/register", { waitUntil: "networkidle" });
  await shot(page, "register");
  await page.fill("#practiceName", PRACTICE);
  await page.fill("#email", EMAIL);
  await page.fill("#password", PASSWORD);
  await Promise.all([
    page.waitForURL((url) => url.pathname === "/", { timeout: 60_000 }),
    page.click('button[type="submit"]'),
  ]);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(2500);
  await shot(page, "after-signup");

  // Cookie banner first so it never blocks wizard buttons.
  const cookie = page.getByRole("button", { name: /essential only/i });
  if (await cookie.isVisible().catch(() => false)) await cookie.click();

  // Walk the "Make it yours" wizard by always clicking the primary action.
  for (let step = 0; step < 12; step++) {
    await page.waitForTimeout(900);
    const overlay = page.getByText(/make it yours/i).first();
    if (!(await overlay.isVisible().catch(() => false))) break;
    await shot(page, `wizard-step-${step}`);
    const actions = [
      /^continue$/i,
      /^next$/i,
      /skip for now/i,
      /^skip$/i,
      /^finish$/i,
      /^done$/i,
      /go to dashboard/i,
      /not now/i,
      /maybe later/i,
    ];
    let clicked = false;
    for (const pattern of actions) {
      const btn = page.getByRole("button", { name: pattern }).first();
      if (await btn.isEnabled().catch(() => false)) {
        await btn.click();
        clicked = true;
        break;
      }
    }
    if (!clicked) {
      // Step needs input we can't infer; bail out via finish-later.
      const later = page.getByText(/finish later/i).first();
      if (await later.isVisible().catch(() => false)) await later.click();
      break;
    }
  }
  await page.waitForTimeout(1500);
  // A tour prompt may follow the wizard; decline so the run stays scripted.
  for (const decline of [/not now/i, /skip tour/i, /maybe later/i]) {
    const btn = page.getByRole("button", { name: decline }).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
      break;
    }
  }
  await page.waitForTimeout(800);
  await shot(page, "dashboard-after-wizard");

  await expect(
    page.getByText(new RegExp(PRACTICE.split(" ")[0]!, "i")).first()
  ).toBeVisible();
});

test("Dogfood B: client, patient, appointment, whiteboard", async ({ page }) => {
  test.setTimeout(300_000);
  await login(page);

  // Client with SMS consent (idempotent: skip if Riley already exists)
  await page.goto("/clients", { waitUntil: "networkidle" });
  await page.fill('input[placeholder="Search clients..."]', "Riley");
  await page.waitForTimeout(1200);
  const rileyExists = await page
    .getByText(/riley bennett/i)
    .first()
    .isVisible()
    .catch(() => false);
  if (!rileyExists) {
    await page.getByRole("button", { name: /new client/i }).first().click();
    await page.waitForTimeout(800);
    await shot(page, "new-client-form");
    await page.getByLabel(/first name/i).fill("Riley");
    await page.getByLabel(/last name/i).fill("Bennett");
    const clientEmail = page.getByLabel(/email/i).first();
    if (await clientEmail.isVisible().catch(() => false)) {
      await clientEmail.fill("dogfood-owner@example.com");
    }
    const phone = page.getByLabel(/^phone/i).first();
    if (await phone.isVisible().catch(() => false)) {
      await phone.fill("(555) 010-7788");
    }
    const smsConsent = page.getByLabel(/text|sms/i).first();
    if (await smsConsent.isVisible().catch(() => false)) {
      await smsConsent.check().catch(() => {});
    }
    await shot(page, "new-client-filled");
    await page
      .getByRole("button", { name: /save|create client|add client/i })
      .first()
      .click();
    await page.waitForTimeout(1500);
    await shot(page, "client-created");
  }

  // Patient: dedicated /patients/new page with a client-search combobox.
  await page.goto("/patients/new", { waitUntil: "networkidle" });
  await page.fill(
    'input[placeholder="Search clients by name or email..."]',
    "Riley"
  );
  await page.waitForTimeout(1000);
  await page.getByText(/riley bennett/i).first().click();
  await page.fill("#name", "Juniper");
  await page.selectOption("#species", "canine");
  await page.fill("#breed", "Golden Retriever");
  await shot(page, "new-patient-filled");
  await page.getByRole("button", { name: /create patient/i }).click();
  await page.waitForTimeout(2000);
  await shot(page, "patient-created");

  // Appointment: patient search + slot select, submit is "Save".
  await page.goto("/schedule", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /new appointment/i }).first().click();
  await page.waitForTimeout(800);
  await page.fill('input[placeholder="Search patients..."]', "Juniper");
  await page.waitForTimeout(1000);
  await page.getByText(/juniper/i).first().click();
  await page.waitForTimeout(500);
  await shot(page, "new-appointment-filled");
  await page.getByRole("button", { name: /^save$/i }).click();
  await page.waitForTimeout(2000);
  await shot(page, "appointment-created");

  await page.goto("/whiteboard", { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  await shot(page, "whiteboard");
});

const JUNIPER_ID = process.env.DOGFOOD_PATIENT_ID ?? "";

test("Dogfood C: check-in, vitals, SOAP, problem, Rx warning, lab", async ({ page }) => {
  test.setTimeout(300_000);
  await login(page);

  // Check in the appointment from the schedule.
  await page.goto("/schedule", { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  const apptBlock = page.getByText(/juniper/i).first();
  if (await apptBlock.isVisible().catch(() => false)) {
    await apptBlock.click();
    await page.waitForTimeout(800);
    const checkIn = page.getByRole("button", { name: /check in/i }).first();
    if (await checkIn.isVisible().catch(() => false)) {
      await checkIn.click();
      await page.waitForTimeout(1200);
    }
    await shot(page, "checked-in");
  }
  await page.goto("/whiteboard", { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  await shot(page, "whiteboard-with-patient");

  // Vitals on the patient chart.
  await page.goto(`/patients/${JUNIPER_ID}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /^vitals$/i }).first().click().catch(async () => {
    await page.getByText(/^Vitals$/).first().click();
  });
  await page.waitForTimeout(800);
  await page.locator('div:has(> label:has-text("Temp (C)")) input').fill("38.4");
  await page.locator('div:has(> label:has-text("HR (bpm)")) input').fill("92");
  await page.locator('div:has(> label:has-text("Weight (kg)")) input').fill("28.5").catch(() => {});
  await shot(page, "vitals-filled");
  await page.getByRole("button", { name: /record vitals/i }).click();
  await page.waitForTimeout(1500);
  await shot(page, "vitals-recorded");

  // SOAP note (rich-text editors, one per S/O/A/P section).
  await page.goto(`/records/new-soap/${JUNIPER_ID}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const editors = page.locator('[contenteditable="true"]');
  const soapText = [
    "Owner reports Juniper has been scratching her left ear for three days.",
    "T 38.4C, HR 92. Left ear canal erythematous with dark discharge. Right ear clean.",
    "Otitis externa, left ear. R/O Malassezia vs bacterial.",
    "Ear cytology today. Start topical treatment. Recheck in 14 days.",
  ];
  const editorCount = await editors.count();
  for (let i = 0; i < Math.min(editorCount, 4); i++) {
    await editors.nth(i).click();
    await editors.nth(i).fill(soapText[i]!);
  }
  await shot(page, "soap-filled");
  await page.getByRole("button", { name: /^save/i }).first().click();
  await page.waitForTimeout(2000);
  await shot(page, "soap-saved");

  // Problem, prescription (allergy warning), lab on the records page.
  await page.goto("/records", { waitUntil: "networkidle" });
  await page.fill('input[placeholder="Search patients by name..."]', "Juniper");
  await page.waitForTimeout(1000);
  await page.getByText(/juniper/i).first().click();
  await page.waitForTimeout(800);

  await page.getByRole("button", { name: /problems/i }).first().click();
  await page.waitForTimeout(500);
  const addProblem = page.getByRole("button", { name: /add problem/i }).first();
  if (await addProblem.isVisible().catch(() => false)) {
    await addProblem.click();
    await page.waitForTimeout(400);
  }
  await page.getByPlaceholder("e.g. Chronic otitis").fill("Otitis externa (left)");
  await shot(page, "problem-filled");
  await page.getByRole("button", { name: /add problem|save/i }).last().click();
  await page.waitForTimeout(1200);

  await page.getByRole("button", { name: /prescriptions/i }).first().click();
  await page.waitForTimeout(500);
  const newRx = page.getByRole("button", { name: /new prescription/i }).first();
  if (await newRx.isVisible().catch(() => false)) {
    await newRx.click();
    await page.waitForTimeout(400);
  }
  await page.getByPlaceholder("e.g. Carprofen").fill("Penicillin");
  await page.getByPlaceholder("e.g. 75 mg").fill("250 mg");
  await page.getByPlaceholder("e.g. Every 12 hours").fill("Every 12 hours");
  await page.getByPlaceholder("e.g. 30").fill("7");
  await page.waitForTimeout(1500);
  await shot(page, "rx-allergy-warning");
  await page.getByRole("button", { name: /save prescription/i }).click();
  await page.waitForTimeout(1500);
  await shot(page, "rx-saved");

  await page.getByRole("button", { name: /lab results/i }).first().click();
  await page.waitForTimeout(500);
  const newLab = page.getByRole("button", { name: /new lab|add lab|record result/i }).first();
  if (await newLab.isVisible().catch(() => false)) {
    await newLab.click();
    await page.waitForTimeout(400);
  }
  await page.getByPlaceholder("e.g. CBC").fill("Ear cytology");
  const labValue = page.getByPlaceholder("e.g. 12.5");
  if (await labValue.isVisible().catch(() => false)) await labValue.fill("1");
  await shot(page, "lab-filled");
  await page.getByRole("button", { name: /save|record/i }).last().click();
  await page.waitForTimeout(1500);
  await shot(page, "lab-saved");
});

test("Dogfood C2: prescription with allergy warning + lab", async ({ page }) => {
  test.setTimeout(240_000);
  await login(page);

  await page.goto("/records", { waitUntil: "networkidle" });
  await page.fill('input[placeholder="Search patients by name..."]', "Juniper");
  await page.waitForTimeout(1000);
  await page.getByText(/juniper/i).first().click();
  await page.waitForTimeout(800);

  await page.getByRole("button", { name: /prescriptions/i }).first().click();
  await page.waitForTimeout(500);
  const newRx = page.getByRole("button", { name: /new prescription/i }).first();
  if (await newRx.isVisible().catch(() => false)) {
    await newRx.click();
    await page.waitForTimeout(400);
  }
  await page.getByPlaceholder("e.g. Carprofen").fill("Penicillin");
  await page.getByPlaceholder("e.g. 75 mg").fill("250 mg");
  await page.getByPlaceholder("e.g. Every 12 hours").fill("Every 12 hours");
  await page.getByPlaceholder("e.g. 30").fill("7");
  await page.waitForTimeout(1800);
  await shot(page, "rx-allergy-warning");
  // A severe-allergy match blocks saving until the clinician acknowledges.
  await page
    .locator('label:has-text("Clinician reviewed") input')
    .check();
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: /save prescription/i }).click();
  await page.waitForTimeout(1800);
  await shot(page, "rx-saved");

  await page.getByRole("button", { name: /lab results/i }).first().click();
  await page.waitForTimeout(500);
  const newLab = page
    .getByRole("button", { name: /new lab|add lab|record result/i })
    .first();
  if (await newLab.isVisible().catch(() => false)) {
    await newLab.click();
    await page.waitForTimeout(400);
  }
  await page.getByPlaceholder("e.g. CBC").fill("Ear cytology");
  const labValue = page.getByPlaceholder("e.g. 12.5");
  if (await labValue.isVisible().catch(() => false)) await labValue.fill("1");
  await shot(page, "lab-filled");
  await page.getByRole("button", { name: /save|record/i }).last().click();
  await page.waitForTimeout(1800);
  await shot(page, "lab-saved");
});
