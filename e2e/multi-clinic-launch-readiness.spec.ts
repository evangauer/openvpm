import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@openpims/db/client";
import {
  appointmentTypes,
  appointments,
  clients,
  invoiceItems,
  invoices,
  locations,
  patients,
  practicePaymentAccounts,
  practices,
  rooms,
  services,
  soapNotes,
  users,
  vitalSigns,
  visitCloseouts,
} from "@openpims/db";

const password = "password123";

type ClinicConfig = {
  slug: string;
  name: string;
  ownerName: string;
  ownerEmail: string;
  paymentReady: boolean;
  client: {
    firstName: string;
    lastName: string;
    email: string;
    patientName: string;
  };
};

type SeededClinic = ClinicConfig & {
  practiceId: string;
  patientId: string;
  appointmentId: string;
};

test.skip(
  !process.env.DATABASE_URL,
  "DATABASE_URL is required for seeded multi-clinic E2E",
);
test.skip(
  process.env.HOSTED_BILLING_ENABLED?.trim().toLowerCase() !== "true",
  "HOSTED_BILLING_ENABLED=true is required for hosted payment readiness E2E",
);

test.describe("Multi-clinic launch readiness", () => {
  test("supports isolated clinic-day workflows and clinic-owned payment setup", async ({
    browser,
  }) => {
    test.setTimeout(360_000);

    const runId = `${Date.now()}-${randomUUID()}`;
    const clinics = await seedClinics(runId);
    const readyClinic = clinics[0]!;
    const setupClinic = clinics[1]!;

    const readyContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    await suppressCookieBanner(readyContext);
    const readyPage = await readyContext.newPage();
    await login(readyPage, readyClinic.ownerEmail);

    await assertClinicRoutes(readyPage, readyClinic, setupClinic);
    await assertPaymentSetup(readyPage, {
      status: "Ready",
      expected: [
        "Client payment processing",
        "Ready",
        "Card payments",
        "Enabled",
        "Payouts",
        "Enabled",
      ],
    });
    await completeGoldenVisit(readyPage, readyClinic);

    const createdClientLastName = `Browser${runId}`;
    const createdPatientName = `Pilot${runId}`;
    await createClientPatientAndInvoice(readyPage, {
      firstName: "Launch",
      lastName: createdClientLastName,
      email: `launch.browser.${runId}@example.com`,
      patientName: createdPatientName,
    });

    await expect(readyPage.getByText(createdClientLastName)).toBeVisible();
    await readyContext.close();

    const setupContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    await suppressCookieBanner(setupContext);
    const setupPage = await setupContext.newPage();
    await login(setupPage, setupClinic.ownerEmail);

    await assertClinicRoutes(setupPage, setupClinic, readyClinic);
    const stripeConfigured = Boolean(process.env.STRIPE_SECRET_KEY?.trim());
    await assertPaymentSetup(setupPage, {
      status: "Setup Needed",
      expected: [
        "Client payment processing",
        "Setup Needed",
        ...(stripeConfigured ? ["Set up"] : ["Stripe API", "Missing"]),
        "Card payments",
        "Disabled",
        "Payouts",
        "Pending",
      ],
    });

    await setupPage.goto("/clients", { waitUntil: "domcontentloaded" });
    await setupPage
      .waitForLoadState("networkidle", { timeout: 10_000 })
      .catch(() => undefined);
    await expect(setupPage.getByText(createdClientLastName)).toHaveCount(0);

    await setupPage.goto("/patients", { waitUntil: "domcontentloaded" });
    await setupPage
      .waitForLoadState("networkidle", { timeout: 10_000 })
      .catch(() => undefined);
    await expect(setupPage.getByText(createdPatientName)).toHaveCount(0);

    await setupPage.goto("/billing", { waitUntil: "domcontentloaded" });
    await setupPage
      .waitForLoadState("networkidle", { timeout: 10_000 })
      .catch(() => undefined);
    await expect(setupPage.getByText(createdClientLastName)).toHaveCount(0);

    await setupContext.close();
  });
});

async function suppressCookieBanner(context: BrowserContext) {
  await context.addInitScript(() => {
    window.localStorage.setItem("openvpm.cookie-consent.v1", "essential");
  });
}

async function login(page: Page, email: string) {
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  await page
    .waitForLoadState("networkidle", { timeout: 10_000 })
    .catch(() => undefined);
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.waitForFunction(
    () =>
      !document.querySelector<HTMLButtonElement>('button[type="submit"]')
        ?.disabled,
    null,
    { timeout: 10_000 },
  );
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 20_000,
  });
  await page
    .waitForLoadState("networkidle", { timeout: 10_000 })
    .catch(() => undefined);
  await dismissOnboardingJourney(page);
}

async function dismissOnboardingJourney(page: Page) {
  const dialog = page.getByRole("dialog", {
    name: /A platform truly built for your clinic/i,
  });
  if (!(await dialog.isVisible({ timeout: 5_000 }).catch(() => false))) return;

  await dialog.getByRole("button", { name: /I'll finish later/i }).click();
  await expect(dialog).not.toBeVisible({ timeout: 15_000 });
}

async function assertClinicRoutes(
  page: Page,
  clinic: SeededClinic,
  forbiddenClinic: SeededClinic,
) {
  const routes = ["/", "/schedule", "/clients", "/patients", "/billing"];

  for (const route of routes) {
    const response = await page.goto(route, { waitUntil: "domcontentloaded" });
    await page
      .waitForLoadState("networkidle", { timeout: 10_000 })
      .catch(() => undefined);
    expect(response?.status(), `${clinic.name} ${route}`).toBe(200);
    const body = page.locator("body");
    for (const expected of expectedClinicText(route, clinic)) {
      await expect(
        body,
        `${clinic.name} ${route} should include ${expected}`,
      ).toContainText(expected, { timeout: 30_000 });
    }
    const settledBody = await body.innerText();
    expect(settledBody).not.toContain(forbiddenClinic.client.lastName);
    expect(settledBody).not.toContain(forbiddenClinic.client.patientName);
  }
}

function expectedClinicText(route: string, clinic: SeededClinic): string[] {
  if (route === "/schedule") return [clinic.client.patientName];
  if (route === "/clients") return [clinic.client.lastName];
  if (route === "/patients")
    return [clinic.client.lastName, clinic.client.patientName];
  if (route === "/billing") return [clinic.client.lastName];
  return [clinic.client.patientName];
}

async function assertPaymentSetup(
  page: Page,
  options: { status: string; expected: string[] },
) {
  await page.goto("/settings", { waitUntil: "domcontentloaded" });
  await page
    .waitForLoadState("networkidle", { timeout: 10_000 })
    .catch(() => undefined);
  await page.getByText("Plan & Billing", { exact: true }).click();
  await page.waitForSelector("text=Client payment processing", {
    timeout: 15_000,
  });
  await page.waitForFunction(
    () => !document.body.innerText.includes("Loading client payment status"),
    null,
    { timeout: 15_000 },
  );

  const body = await page.locator("body").innerText();
  for (const expected of options.expected) {
    expect(
      body,
      `${options.status} payment setup should show ${expected}`,
    ).toContain(expected);
  }
}

async function completeGoldenVisit(page: Page, clinic: SeededClinic) {
  await page.goto(`/encounters/${clinic.appointmentId}`, {
    waitUntil: "domcontentloaded",
  });
  await page
    .waitForLoadState("networkidle", { timeout: 10_000 })
    .catch(() => undefined);
  await expect(
    page.getByRole("heading", { name: clinic.client.patientName }),
  ).toBeVisible();

  await page.getByRole("button", { name: /^Check in$/ }).click();
  await expect(page.getByRole("button", { name: /^Start exam$/ })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole("button", { name: /^Start exam$/ }).click();
  const writeSoap = page
    .getByRole("link", { name: /^Write SOAP note$/ })
    .first();
  await expect(writeSoap).toBeVisible({
    timeout: 15_000,
  });

  await page.locator('input[name="temperatureC"]').fill("38.4");
  await page.locator('input[name="heartRateBpm"]').fill("92");
  await page.locator('input[name="respiratoryRateBpm"]').fill("24");
  await page.locator('input[name="weightKg"]').fill("18.5");
  await expect(page).toHaveURL(
    new RegExp(`/encounters/${clinic.appointmentId}$`),
  );
  await page.getByRole("button", { name: /^Record visit vitals$/ }).click();
  await expect
    .poll(
      async () => {
        const rows = await db
          .select({ id: vitalSigns.id })
          .from(vitalSigns)
          .where(
            and(
              eq(vitalSigns.appointmentId, clinic.appointmentId),
              eq(vitalSigns.practiceId, clinic.practiceId),
              isNull(vitalSigns.deletedAt),
            ),
          );
        return rows.length;
      },
      { timeout: 15_000 },
    )
    .toBe(1);
  await expect(page).toHaveURL(
    new RegExp(`/encounters/${clinic.appointmentId}$`),
  );

  await writeSoap.click();
  await page.waitForURL("**/records/new-soap/**", { timeout: 20_000 });
  const editors = page.locator('[contenteditable="true"]');
  await expect(editors).toHaveCount(4);
  const sections = [
    "Owner reports no new concerns during this synthetic wellness visit.",
    "Synthetic exam: bright, alert, responsive; recorded vitals reviewed.",
    "Routine wellness examination without abnormal findings.",
    "Continue preventive care and return for the next scheduled wellness visit.",
  ];
  for (let index = 0; index < sections.length; index += 1) {
    await editors.nth(index).fill(sections[index]!);
  }
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: /^Finalize SOAP note$/ }).click();
  await page.waitForURL(`**/encounters/${clinic.appointmentId}`, {
    timeout: 20_000,
  });

  await page
    .locator("#closeout-diagnosis")
    .fill("Routine wellness examination");
  await page
    .locator("#closeout-instructions")
    .fill(
      "Continue the current diet and preventive-care schedule. Call with any concerns.",
    );
  await page.locator("#closeout-prescriptions").selectOption("not_needed");
  await page.locator("#closeout-follow-up").selectOption("none");
  await page
    .getByRole("button", { name: /^Finalize clinical handoff$/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "Clinical handoff finalized" }),
  ).toBeVisible({ timeout: 20_000 });

  await page
    .locator("#closeout-charge-state")
    .selectOption("accounts_receivable");
  await page.locator("#closeout-handoff").selectOption("verbal");
  await page.getByRole("button", { name: /^Complete visit$/ }).click();
  await expect(
    page.getByText("Visit completed with a durable closeout."),
  ).toBeVisible({
    timeout: 20_000,
  });

  const [appointment, closeout, soap, vitals] = await Promise.all([
    db
      .select({ status: appointments.status })
      .from(appointments)
      .where(
        and(
          eq(appointments.id, clinic.appointmentId),
          eq(appointments.practiceId, clinic.practiceId),
          isNull(appointments.deletedAt),
        ),
      ),
    db
      .select({
        status: visitCloseouts.status,
        chargeDisposition: visitCloseouts.chargeDisposition,
        handoffMethod: visitCloseouts.handoffMethod,
        completedAt: visitCloseouts.completedAt,
      })
      .from(visitCloseouts)
      .where(
        and(
          eq(visitCloseouts.appointmentId, clinic.appointmentId),
          eq(visitCloseouts.practiceId, clinic.practiceId),
          isNull(visitCloseouts.deletedAt),
        ),
      ),
    db
      .select({ status: soapNotes.status, finalizedAt: soapNotes.finalizedAt })
      .from(soapNotes)
      .where(
        and(
          eq(soapNotes.appointmentId, clinic.appointmentId),
          eq(soapNotes.practiceId, clinic.practiceId),
          isNull(soapNotes.deletedAt),
        ),
      ),
    db
      .select({ temperatureC: vitalSigns.temperatureC })
      .from(vitalSigns)
      .where(
        and(
          eq(vitalSigns.appointmentId, clinic.appointmentId),
          eq(vitalSigns.practiceId, clinic.practiceId),
          isNull(vitalSigns.deletedAt),
        ),
      ),
  ]);

  expect(appointment).toEqual([{ status: "checked_out" }]);
  expect(closeout).toEqual([
    expect.objectContaining({
      status: "completed",
      chargeDisposition: "accounts_receivable",
      handoffMethod: "verbal",
      completedAt: expect.any(Date),
    }),
  ]);
  expect(soap).toEqual([
    expect.objectContaining({
      status: "finalized",
      finalizedAt: expect.any(Date),
    }),
  ]);
  expect(vitals).toEqual([{ temperatureC: "38.4" }]);
}

async function createClientPatientAndInvoice(
  page: Page,
  data: {
    firstName: string;
    lastName: string;
    email: string;
    patientName: string;
  },
) {
  await page.goto("/clients/new", { waitUntil: "domcontentloaded" });
  await page.fill("#firstName", data.firstName);
  await page.fill("#lastName", data.lastName);
  await page.fill("#email", data.email);
  await page.fill("#phone", "555-4200");
  await page.getByRole("button", { name: /^Create Client$/ }).click();
  await page.waitForURL(
    (url) =>
      url.pathname.startsWith("/clients/") && url.pathname !== "/clients/new",
    { timeout: 20_000 },
  );
  await page
    .waitForLoadState("networkidle", { timeout: 10_000 })
    .catch(() => undefined);
  await expect(
    page.getByRole("heading", {
      name: `${data.firstName} ${data.lastName}`,
    }),
  ).toBeVisible();

  await page.goto("/patients/new", { waitUntil: "domcontentloaded" });
  const clientSearch = page.getByPlaceholder(
    "Search clients by name or email...",
  );
  await clientSearch.fill(data.lastName);
  await page
    .getByRole("button", {
      name: new RegExp(`${data.firstName} ${data.lastName}`),
    })
    .click();
  await page.fill("#name", data.patientName);
  await page.selectOption("#species", "canine");
  await page.fill("#breed", "Launch Readiness Mix");
  await page.getByRole("button", { name: /^Create Patient$/ }).click();
  await page.waitForURL(
    (url) =>
      url.pathname.startsWith("/patients/") && url.pathname !== "/patients/new",
    { timeout: 20_000 },
  );
  await page
    .waitForLoadState("networkidle", { timeout: 10_000 })
    .catch(() => undefined);
  await expect(
    page.getByRole("heading", { name: data.patientName }),
  ).toBeVisible();

  await page.goto("/billing/new", { waitUntil: "domcontentloaded" });
  await page.getByPlaceholder("Search clients...").fill(data.lastName);
  await page
    .getByRole("button", {
      name: new RegExp(`${data.firstName} ${data.lastName}`),
    })
    .click();
  await page.waitForFunction(
    (patientName) =>
      [...document.querySelectorAll("select option")].some((option) =>
        option.textContent?.includes(String(patientName)),
      ),
    data.patientName,
    { timeout: 15_000 },
  );
  await page
    .locator("select")
    .nth(0)
    .selectOption({ label: `${data.patientName} (canine)` });
  await page.getByRole("button", { name: "Search services..." }).click();
  await page
    .getByRole("textbox", { name: "Search services" })
    .fill("Wellness Exam");
  await page.getByRole("option", { name: /Wellness Exam/ }).click();
  await page.getByRole("button", { name: /^Add$/ }).click();
  await page.waitForSelector("text=Subtotal", { timeout: 15_000 });
  await page.getByRole("button", { name: /^Create Invoice$/ }).click();
  await page.waitForURL("**/billing", { timeout: 20_000 });
  await page
    .waitForLoadState("networkidle", { timeout: 10_000 })
    .catch(() => undefined);
}

async function seedClinics(runId: string): Promise<SeededClinic[]> {
  const passwordHash = await bcrypt.hash(password, 10);
  const now = new Date();
  const start = new Date();
  start.setHours(9, 0, 0, 0);
  const end = new Date(start);
  end.setMinutes(end.getMinutes() + 30);

  const clinicConfigs: ClinicConfig[] = [
    {
      slug: `pine-${runId}`,
      name: `E2E Pine Hollow ${runId}`,
      ownerName: "Dr. Avery Morgan",
      ownerEmail: `owner.pine.${runId}@example.com`,
      paymentReady: true,
      client: {
        firstName: "Maya",
        lastName: `Ortiz${runId}`,
        email: `maya.ortiz.${runId}@example.com`,
        patientName: `Juniper${runId}`,
      },
    },
    {
      slug: `cedar-${runId}`,
      name: `E2E Cedar Sage ${runId}`,
      ownerName: "Dr. Elise Bennett",
      ownerEmail: `owner.cedar.${runId}@example.com`,
      paymentReady: false,
      client: {
        firstName: "Theo",
        lastName: `Brooks${runId}`,
        email: `theo.brooks.${runId}@example.com`,
        patientName: `Hazel${runId}`,
      },
    },
  ];

  const seeded: SeededClinic[] = [];

  for (const config of clinicConfigs) {
    const [practice] = await db
      .insert(practices)
      .values({
        name: config.name,
        email: `hello.${config.slug}@example.com`,
        phone: "555-0199",
        subscriptionTier: "cloud",
        billingStatus: "active",
        stripeCustomerId: `cus_e2e_${config.slug}`,
        stripeSubscriptionId: `sub_e2e_${config.slug}`,
        settings: {
          onboardingState: {
            lastStepId: config.paymentReady ? "launch-check" : "payments",
            journeyDismissed: true,
          },
        },
      })
      .returning();

    const [location] = await db
      .insert(locations)
      .values({
        practiceId: practice.id,
        name: "Main Clinic",
        isPrimary: true,
      })
      .returning();

    const [user] = await db
      .insert(users)
      .values({
        email: config.ownerEmail,
        passwordHash,
        name: config.ownerName,
        role: "admin",
        isVeterinarian: true,
        practiceId: practice.id,
        locationId: location.id,
        emailVerifiedAt: now,
      })
      .returning();

    const [appointmentType] = await db
      .insert(appointmentTypes)
      .values({
        practiceId: practice.id,
        name: "Wellness Exam",
        durationMinutes: 30,
        color: "#0f766e",
      })
      .returning();

    const [room] = await db
      .insert(rooms)
      .values({
        practiceId: practice.id,
        locationId: location.id,
        name: "Exam Room 1",
        type: "exam",
      })
      .returning();

    const [service] = await db
      .insert(services)
      .values({
        practiceId: practice.id,
        name: "Wellness Exam",
        code: "E2E-WELL",
        category: "Launch Readiness",
        defaultPrice: "65.00",
      })
      .returning();

    const [client] = await db
      .insert(clients)
      .values({
        practiceId: practice.id,
        firstName: config.client.firstName,
        lastName: config.client.lastName,
        email: config.client.email,
        phone: "555-0101",
        preferredContactMethod: "sms",
        smsConsent: true,
        smsConsentAt: now,
        smsConsentSource: "intake",
        smsConsentDisclosure: "E2E launch readiness consent.",
      })
      .returning();

    const [patient] = await db
      .insert(patients)
      .values({
        practiceId: practice.id,
        clientId: client.id,
        name: config.client.patientName,
        species: "canine",
        breed: "Launch Readiness Mix",
        sex: "female_spayed",
        status: "active",
      })
      .returning();

    const [appointment] = await db
      .insert(appointments)
      .values({
        practiceId: practice.id,
        startTime: start,
        endTime: end,
        typeId: appointmentType.id,
        patientId: patient.id,
        clientId: client.id,
        doctorId: user.id,
        roomId: room.id,
        status: "confirmed",
        notes: `E2E launch readiness ${config.slug}`,
      })
      .returning();

    const [invoice] = await db
      .insert(invoices)
      .values({
        practiceId: practice.id,
        clientId: client.id,
        patientId: patient.id,
        appointmentId: appointment.id,
        status: "sent",
        subtotal: "65.00",
        tax: "5.20",
        total: "70.20",
        dueDate: now.toISOString().slice(0, 10),
      })
      .returning();

    await db.insert(invoiceItems).values({
      invoiceId: invoice.id,
      description: "Wellness Exam",
      quantity: 1,
      unitPrice: "65.00",
      total: "65.00",
      itemType: "service",
      itemId: service.id,
    });

    if (config.paymentReady) {
      await db.insert(practicePaymentAccounts).values({
        practiceId: practice.id,
        provider: "stripe_connect",
        stripeAccountId: `acct_e2e_${runId}`,
        onboardingStatus: "active",
        chargesEnabled: true,
        payoutsEnabled: true,
        detailsSubmitted: true,
        requirementsCurrentlyDue: [],
        lastSyncedAt: now,
      });
    }

    seeded.push({
      ...config,
      practiceId: practice.id,
      patientId: patient.id,
      appointmentId: appointment.id,
    });
  }

  return seeded;
}
