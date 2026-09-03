import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const enabled = process.env.AMBULATORY_E2E === "1";
const patientId =
  process.env.AMBULATORY_E2E_PATIENT_ID ??
  "10000000-0000-0000-0000-000000000002";
const email =
  process.env.AMBULATORY_E2E_EMAIL ?? "sarah.chen@neighborhoodvet.example.com";
const password = process.env.AMBULATORY_E2E_PASSWORD ?? "password123";
const screenshotDir = process.env.AMBULATORY_SCREENSHOT_DIR;

test.skip(!enabled, "Set AMBULATORY_E2E=1 against an isolated synthetic DB");

function requireDisposableLocalUrl(
  raw: string | undefined,
  kind: "database" | "web",
) {
  if (!raw) {
    throw new Error(
      `${kind === "database" ? "AMBULATORY_E2E_DATABASE_URL" : "PLAYWRIGHT_BASE_URL"} is required when AMBULATORY_E2E=1`,
    );
  }
  const url = new URL(raw);
  const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (!localHosts.has(url.hostname)) {
    throw new Error(`Refusing ambulatory E2E against non-local ${kind} host`);
  }
  if (
    kind === "database" &&
    !url.pathname.slice(1).startsWith("openvpm_ambulatory_")
  ) {
    throw new Error(
      "Refusing ambulatory E2E against a database without the openvpm_ambulatory_ prefix",
    );
  }
}

if (enabled) {
  const actualDatabaseUrl = process.env.DATABASE_URL;
  const assertedDatabaseUrl = process.env.AMBULATORY_E2E_DATABASE_URL;
  requireDisposableLocalUrl(assertedDatabaseUrl, "database");
  requireDisposableLocalUrl(actualDatabaseUrl, "database");
  if (actualDatabaseUrl !== assertedDatabaseUrl) {
    throw new Error(
      "DATABASE_URL must exactly match AMBULATORY_E2E_DATABASE_URL for ambulatory E2E",
    );
  }
  requireDisposableLocalUrl(process.env.PLAYWRIGHT_BASE_URL, "web");
}

function expectedDevelopmentNoise(message: string) {
  return (
    message.includes("Download the React DevTools") ||
    message.includes("Content-Security-Policy") ||
    message.includes("Content Security Policy directive")
  );
}

async function screenshot(page: import("@playwright/test").Page, name: string) {
  if (!screenshotDir) return;
  fs.mkdirSync(screenshotDir, { recursive: true });
  await page.screenshot({
    path: path.join(screenshotDir, `${name}.png`),
    fullPage: true,
  });
}

test("runs the synthetic patient-chart to field-closeout flow", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const evidenceTag = new Date().toISOString();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !expectedDevelopmentNoise(message.text())
    ) {
      errors.push(message.text());
    }
  });
  await page.addInitScript(() => {
    window.localStorage.setItem("openvpm.cookie-consent.v1", "essential");
    window.sessionStorage.setItem("ovpm_verify_email_dismissed", "1");
  });

  await page.goto("/login", { waitUntil: "networkidle" });
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await Promise.all([
    page.waitForURL((url) => url.pathname !== "/login"),
    page.getByRole("button", { name: "Sign in" }).click(),
  ]);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/patients/${patientId}`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "Maple" })).toBeVisible();
  await expect(page.getByText("Patient snapshot")).toBeVisible();
  await expect(page.getByText("Latest weight: 1600 lb")).toBeVisible();
  await expect(page.getByText("Chronic left hind lameness")).toBeVisible();
  await expect(page.getByText("Meloxicam")).toBeVisible();
  await screenshot(page, "ambulatory-patient-desktop");

  await page.getByRole("button", { name: "Start field visit" }).click();
  await page.waitForURL(/\/encounters\/[a-f0-9-]+$/);
  await expect(page.getByText("Field visit").first()).toBeVisible();
  await expect(page.getByLabel("Temp (F)")).toBeVisible();
  await expect(page.getByLabel("Weight (lb)")).toBeVisible();
  await expect(page.getByLabel("BCS (1-5)")).toBeVisible();
  await expect(page.getByText("Finish field visit")).toBeVisible();
  await screenshot(page, "ambulatory-workspace-desktop-start");

  await page.setViewportSize({ width: 1024, height: 1366 });
  await screenshot(page, "ambulatory-workspace-ipad-start");

  await page
    .getByLabel("Subjective")
    .fill(`Synthetic appetite and gait history ${evidenceTag}.`);
  await page.getByLabel("Objective").fill("Synthetic field exam findings.");
  await page.getByLabel("Assessment").fill("Synthetic lameness assessment.");
  await page.getByLabel("Plan").fill("Synthetic treatment and follow-up plan.");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("SOAP draft saved")).toBeVisible();
  await expect(page).toHaveURL(/\/encounters\/[a-f0-9-]+$/);
  await screenshot(page, "ambulatory-workspace-ipad-draft");

  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByLabel("Subjective")).toHaveValue(
    `Synthetic appetite and gait history ${evidenceTag}.`,
  );
  await page.getByRole("button", { name: "Finalize SOAP note" }).click();
  await expect(page.getByText("SOAP note finalized")).toBeVisible();

  await page.getByLabel("Temp (F)").fill("101.5");
  const weightInput = page.getByLabel("Weight (lb)");
  await expect(weightInput).toHaveAttribute("min", "0.003");
  await expect(weightInput).toHaveAttribute("step", "0.001");
  await weightInput.fill("1600");
  expect(
    await weightInput.evaluate((input: HTMLInputElement) => ({
      valid: input.validity.valid,
      stepMismatch: input.validity.stepMismatch,
    })),
  ).toEqual({ valid: true, stepMismatch: false });
  await page.getByLabel("BCS (1-5)").fill("4");
  await page.getByRole("button", { name: "Record visit vitals" }).click();
  await expect(page.getByText("Visit vitals recorded")).toBeVisible();
  await expect(page.getByText("101.5 F").first()).toBeVisible();
  await expect(page.getByText("1600 lb").first()).toBeVisible();
  await expect(page.getByText("4 / 5").first()).toBeVisible();

  await page.getByRole("button", { name: "Add problem" }).click();
  const problemForm = page
    .getByPlaceholder("Problem or diagnosis")
    .locator("xpath=ancestor::form");
  await problemForm
    .getByPlaceholder("Problem or diagnosis")
    .fill(`Synthetic field finding ${evidenceTag}`);
  await problemForm.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Problem added")).toBeVisible();

  await page.getByRole("button", { name: "Record vaccine" }).click();
  const vaccineForm = page
    .locator('input[name="vaccineName"]')
    .locator("xpath=ancestor::form");
  await vaccineForm
    .locator('input[name="vaccineName"]')
    .fill("Synthetic field vaccine");
  await vaccineForm.getByRole("button", { name: "Save vaccination" }).click();
  await expect(page.getByText("Vaccination recorded")).toBeVisible();

  await page.getByRole("button", { name: "Prescribe" }).click();
  await page.getByLabel("Medication *").fill("Synthetic field medication");
  await page.getByLabel("Dosage *").fill("10 mL");
  await page.getByLabel("Frequency *").fill("Once daily");
  await expect(
    page.getByText("No allergy or active-medication warnings found."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save prescription" }).click();
  await expect(page.getByText("Prescription created")).toBeVisible();

  await page.getByRole("button", { name: "Review and finish" }).click();
  await expect(page.getByText("Finish field visit").first()).toBeVisible();
  await page.getByRole("button", { name: "Copy from Plan" }).click();
  await expect(page.getByText("Copied from the current Plan.")).toBeVisible();
  await page.getByLabel("Prescriptions").selectOption("prescribed");
  await page.getByLabel("Follow-up").selectOption("none");
  await page.getByRole("button", { name: "Finalize clinical handoff" }).click();
  await expect(
    page.getByText("Clinical handoff finalized").first(),
  ).toBeVisible();

  const vaccineReconciliation = page.getByLabel(
    "Reconciliation reason for Synthetic field vaccine",
  );
  await vaccineReconciliation.fill("Synthetic acceptance item — no charge");
  await page
    .getByRole("button", { name: "No charge", exact: true })
    .first()
    .click();
  await expect(vaccineReconciliation).toHaveCount(0);

  const prescriptionReconciliation = page.getByLabel(
    "Reconciliation reason for Synthetic field medication",
  );
  await prescriptionReconciliation.fill(
    "Synthetic acceptance item — no charge",
  );
  await page
    .getByRole("button", { name: "No charge", exact: true })
    .first()
    .click();
  await expect(prescriptionReconciliation).toHaveCount(0);
  await expect(
    page
      .getByText("Items requiring attention")
      .locator("..")
      .getByText("0", { exact: true }),
  ).toBeVisible();

  await page.getByLabel("Billing disposition").selectOption("no_charge");
  await page
    .getByLabel("No-charge reason")
    .fill("Synthetic no-charge workflow verification");
  await page.getByLabel("Owner handoff").selectOption("verbal");
  await page.getByRole("button", { name: "Complete visit" }).click();
  await expect(page.getByText("Visit completed safely").first()).toBeVisible();
  await screenshot(page, "ambulatory-workspace-ipad");

  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByText("Completed").first()).toBeVisible();

  expect(errors, "ambulatory flow logged unexpected browser errors").toEqual(
    [],
  );
});
