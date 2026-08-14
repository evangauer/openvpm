import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
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
  users,
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
};

test.skip(!process.env.DATABASE_URL, "DATABASE_URL is required for seeded multi-clinic E2E");

test.describe("Multi-clinic launch readiness", () => {
  test("supports isolated clinic-day workflows and clinic-owned payment setup", async ({
    browser,
  }) => {
    test.setTimeout(120_000);

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
      expected: ["Client payment processing", "Ready", "Card payments", "Enabled", "Payouts", "Enabled"],
    });

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
    await assertPaymentSetup(setupPage, {
      status: "Setup Needed",
      expected: [
        "Client payment processing",
        "Setup Needed",
        "Set up",
        "Card payments",
        "Disabled",
        "Payouts",
        "Pending",
      ],
    });

    await setupPage.goto("/clients", { waitUntil: "domcontentloaded" });
    await setupPage.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
    await expect(setupPage.getByText(createdClientLastName)).toHaveCount(0);

    await setupPage.goto("/patients", { waitUntil: "domcontentloaded" });
    await setupPage.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
    await expect(setupPage.getByText(createdPatientName)).toHaveCount(0);

    await setupPage.goto("/billing", { waitUntil: "domcontentloaded" });
    await setupPage.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
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
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.waitForFunction(
    () => !document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled,
    null,
    { timeout: 10_000 }
  );
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 20_000,
  });
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
}

async function assertClinicRoutes(
  page: Page,
  clinic: SeededClinic,
  forbiddenClinic: SeededClinic
) {
  const routes = ["/", "/schedule", "/clients", "/patients", "/billing"];

  for (const route of routes) {
    const response = await page.goto(route, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
    expect(response?.status(), `${clinic.name} ${route}`).toBe(200);
    const body = await page.locator("body").innerText();
    for (const expected of expectedClinicText(route, clinic)) {
      expect(body, `${clinic.name} ${route} should include ${expected}`).toContain(expected);
    }
    expect(body).not.toContain(forbiddenClinic.client.lastName);
    expect(body).not.toContain(forbiddenClinic.client.patientName);
  }
}

function expectedClinicText(route: string, clinic: SeededClinic): string[] {
  if (route === "/schedule") return [clinic.client.patientName];
  if (route === "/clients") return [clinic.client.lastName];
  if (route === "/patients") return [clinic.client.lastName, clinic.client.patientName];
  if (route === "/billing") return [clinic.client.lastName];
  return [clinic.client.patientName];
}

async function assertPaymentSetup(
  page: Page,
  options: { status: string; expected: string[] }
) {
  await page.goto("/settings", { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  await page.getByText("Plan & Billing", { exact: true }).click();
  await page.waitForSelector("text=Client payment processing", {
    timeout: 15_000,
  });
  await page.waitForFunction(
    () => !document.body.innerText.includes("Loading client payment status"),
    null,
    { timeout: 15_000 }
  );

  const body = await page.locator("body").innerText();
  for (const expected of options.expected) {
    expect(body, `${options.status} payment setup should show ${expected}`).toContain(expected);
  }
}

async function createClientPatientAndInvoice(
  page: Page,
  data: {
    firstName: string;
    lastName: string;
    email: string;
    patientName: string;
  }
) {
  await page.goto("/clients/new", { waitUntil: "domcontentloaded" });
  await page.fill("#firstName", data.firstName);
  await page.fill("#lastName", data.lastName);
  await page.fill("#email", data.email);
  await page.fill("#phone", "555-4200");
  await page.getByRole("button", { name: /^Create Client$/ }).click();
  await page.waitForURL("**/clients", { timeout: 20_000 });
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  await expect(page.getByText(data.lastName)).toBeVisible();

  await page.goto("/patients/new", { waitUntil: "domcontentloaded" });
  const clientSearch = page.getByPlaceholder("Search clients by name or email...");
  await clientSearch.fill(data.lastName);
  await page.getByRole("button", { name: new RegExp(`${data.firstName} ${data.lastName}`) }).click();
  await page.fill("#name", data.patientName);
  await page.selectOption("#species", "canine");
  await page.fill("#breed", "Launch Readiness Mix");
  await page.getByRole("button", { name: /^Create Patient$/ }).click();
  await page.waitForURL("**/patients", { timeout: 20_000 });
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  await expect(page.getByText(data.patientName)).toBeVisible();

  await page.goto("/billing/new", { waitUntil: "domcontentloaded" });
  await page.getByPlaceholder("Search clients...").fill(data.lastName);
  await page.getByRole("button", { name: new RegExp(`${data.firstName} ${data.lastName}`) }).click();
  await page.waitForFunction(
    (patientName) =>
      [...document.querySelectorAll("select option")].some((option) =>
        option.textContent?.includes(String(patientName))
      ),
    data.patientName,
    { timeout: 15_000 }
  );
  await page.locator("select").nth(0).selectOption({ label: `${data.patientName} (canine)` });
  await page.locator("select").nth(1).selectOption({ label: "Wellness Exam - $65.00" });
  await page.getByRole("button", { name: /^Add$/ }).click();
  await page.waitForSelector("text=Subtotal", { timeout: 15_000 });
  await page.getByRole("button", { name: /^Create Invoice$/ }).click();
  await page.waitForURL("**/billing", { timeout: 20_000 });
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
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

    seeded.push({ ...config, practiceId: practice.id });
  }

  return seeded;
}
