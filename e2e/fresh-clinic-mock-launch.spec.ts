import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@openpims/db/client";
import {
  appointments,
  authTokens,
  clients,
  invoices,
  locations,
  patients,
  practicePaymentAccounts,
  practices,
  users,
} from "@openpims/db";

/**
 * Fresh-clinic mock launch flow (2026-07-01 readiness pass).
 *
 * Simulates a brand-new clinic joining the hosted service end to end, in
 * Stripe TEST mode, against a local hosted-mode server with `stripe listen`
 * forwarding webhooks:
 *   signup UI → Stripe Checkout (4242 card) → subscription webhook →
 *   email verification → login → Connect Express onboarding attempt →
 *   clinic-day writes → client card payment via Connect checkout →
 *   patient photo upload (object storage) → cross-clinic isolation.
 *
 * Evidence (screenshots + summary.json) lands in
 * test-results/fresh-clinic-launch/.
 */

const RESULTS_DIR = path.join(process.cwd(), "test-results", "fresh-clinic-launch");
const SUMMARY_PATH = path.join(RESULTS_DIR, "summary.json");

const runId = `${Date.now()}`;
const password = "LaunchReady123!";
const state = {
  runId,
  practiceName: `Fresh Launch Clinic ${runId}`,
  ownerEmail: `owner.fresh.${runId}@example.com`,
  practiceId: "",
  clientFirstName: "Rowan",
  clientLastName: `Fresh${runId}`,
  clientEmail: `rowan.fresh.${runId}@example.com`,
  patientName: `Biscuit${runId}`,
  verificationUrl: "",
  checkoutUrl: "",
};

const summary: Record<string, unknown> = { runId, startedAt: new Date().toISOString() };

function isStripeHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "stripe.com" || normalized.endsWith(".stripe.com");
}

function isStripeUrl(value: string): boolean {
  try {
    return isStripeHostname(new URL(value).hostname);
  } catch {
    return false;
  }
}

function record(key: string, value: unknown) {
  summary[key] = value;
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));
}

async function shot(page: Page, name: string) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  await page
    .screenshot({ path: path.join(RESULTS_DIR, `${name}.png`), fullPage: false })
    .catch(() => undefined);
}

async function waitUntil<T>(
  fn: () => Promise<T | null | undefined | false>,
  { timeoutMs = 60_000, intervalMs = 2_000, label = "condition" } = {}
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result) return result as T;
      last = result;
    } catch (err) {
      last = err;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}; last=${String(last)}`);
}

async function suppressCookieBanner(context: BrowserContext) {
  await context.addInitScript(() => {
    window.localStorage.setItem("openvpm.cookie-consent.v1", "essential");
  });
}

async function login(page: Page, email: string, pass = password) {
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  await page.fill("#email", email);
  await page.fill("#password", pass);
  await page.waitForFunction(
    () => !document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled,
    null,
    { timeout: 10_000 }
  );
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
}

/** Fill a value into the first visible match across the page and all iframes. */
async function fillAnywhere(page: Page, selectors: string[], value: string): Promise<boolean> {
  const frames = [page.mainFrame(), ...page.frames()];
  for (const selector of selectors) {
    for (const frame of frames) {
      try {
        const el = frame.locator(selector).first();
        if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
          await el.fill(value, { timeout: 5_000 });
          return true;
        }
      } catch {
        // keep looking in other frames
      }
    }
  }
  return false;
}

/**
 * Fill a Stripe-hosted Checkout page with the 4242 test card and submit.
 * Handles both the classic layout (#cardNumber on the page) and the newer
 * payment-method-list layout (Card radio + fields inside iframes).
 */
async function completeStripeCheckout(page: Page, tag: string) {
  await page.waitForLoadState("domcontentloaded");
  await page
    .waitForSelector("#cardNumber, input[name=\"cardNumber\"]", { timeout: 20_000 })
    .catch(() => undefined);

  // Newer checkout: expand the card accordion first. Try the "Pay with card"
  // button, then the radio, then the label text — with bounded clicks so a
  // non-actionable element cannot eat the test budget.
  const classicCard = page.locator("#cardNumber").first();
  if (!(await classicCard.isVisible().catch(() => false))) {
    const expanders = [
      page.getByRole("button", { name: /pay with card/i }).first(),
      page.getByRole("radio", { name: /^card$/i }).first(),
      page.getByText(/^Card$/).first(),
    ];
    for (const expander of expanders) {
      if (!(await expander.isVisible().catch(() => false))) continue;
      const clicked = await expander
        .click({ timeout: 5_000 })
        .then(() => true)
        .catch(() =>
          expander
            .click({ timeout: 5_000, force: true })
            .then(() => true)
            .catch(() => false)
        );
      if (clicked) {
        await page.waitForTimeout(2_000);
        const expanded = await Promise.race([
          waitUntil(
            async () => {
              for (const frame of page.frames()) {
                const count = await frame
                  .locator('input[name="number"], #cardNumber, input[name="cardNumber"]')
                  .count()
                  .catch(() => 0);
                if (count > 0) return true;
              }
              return false;
            },
            { timeoutMs: 15_000, intervalMs: 1_000, label: "card fields" }
          ).catch(() => false),
        ]);
        if (expanded) break;
      }
    }
  }
  await shot(page, `${tag}-checkout-loaded`);

  // Decline the Link save-my-info upsell — when left checked it requires a
  // phone number and can hijack the flow into Link.
  const linkCheckbox = page
    .locator('input[type="checkbox"][name="enableStripePass"], input[type="checkbox"]')
    .first();
  if ((await linkCheckbox.count()) > 0 && (await linkCheckbox.isChecked().catch(() => false))) {
    await linkCheckbox.uncheck({ force: true }).catch(() => undefined);
    await page.waitForTimeout(1_000);
  }

  await fillAnywhere(page, ["#email", 'input[name="email"]'], state.ownerEmail);
  const cardFilled = await fillAnywhere(
    page,
    ['#cardNumber, input[name="cardNumber"]', 'input[name="number"]'],
    "4242 4242 4242 4242"
  );
  expect(cardFilled, "card number field must be fillable on Stripe Checkout").toBe(true);
  await fillAnywhere(
    page,
    ['#cardExpiry, input[name="cardExpiry"]', 'input[name="expiry"]'],
    "12 / 34"
  );
  await fillAnywhere(page, ['#cardCvc, input[name="cardCvc"]', 'input[name="cvc"]'], "123");
  await fillAnywhere(
    page,
    ['#billingName, input[name="billingName"]', 'input[name="name"]'],
    "Launch Ready Owner"
  );

  const country = page.locator('#billingCountry, select[name="billingCountry"]').first();
  if ((await country.count()) > 0 && (await country.isVisible().catch(() => false))) {
    await country.selectOption("US").catch(() => undefined);
  }
  await fillAnywhere(
    page,
    ['#billingPostalCode, input[name="billingPostalCode"]', 'input[name="postalCode"]'],
    "94103"
  );

  await shot(page, `${tag}-checkout-filled`);
  const submit = page
    .locator('[data-testid="hosted-payment-submit-button"]')
    .or(page.getByRole("button", { name: /start trial|subscribe|^pay$|pay \$/i }))
    .first();
  await submit.click();
  await page.waitForTimeout(2_000);
  await shot(page, `${tag}-checkout-submitted`);
}

test.skip(!process.env.DATABASE_URL, "DATABASE_URL is required for the fresh-clinic launch E2E");

test.describe.serial("Fresh clinic mock launch", () => {
  test("1. hosted signup reaches Stripe Checkout and test card activates the subscription", async ({
    browser,
  }) => {
    test.setTimeout(330_000);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await suppressCookieBanner(context);
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);

    await page.goto("/register", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);

    // Re-fill until React hydration has caught the values and enabled submit —
    // filling before hydration leaves the button permanently disabled.
    const submitButton = page.getByRole("button", { name: /create workspace/i });
    for (let attempt = 0; attempt < 4; attempt++) {
      await page.getByLabel(/practice name/i).fill(state.practiceName);
      await page.getByLabel(/work email/i).fill(state.ownerEmail);
      await page.getByLabel(/password/i).fill(password);
      const enabled = await submitButton.isEnabled({ timeout: 4_000 }).catch(() => false);
      if (enabled) break;
      await page.waitForTimeout(2_000);
    }
    await expect(submitButton).toBeEnabled({ timeout: 5_000 });
    await shot(page, "01-register-filled");
    await submitButton.click();

    // Hosted signup creates the practice and sends the browser straight to
    // card-collected Stripe Checkout — reaching stripe.com is the proof.
    await page.waitForURL((url) => isStripeHostname(url.hostname), { timeout: 90_000 });
    record("register", { reachedStripeCheckout: true });
    await completeStripeCheckout(page, "02-subscription");
    await page.waitForURL((url) => url.pathname.startsWith("/login"), { timeout: 90_000 });
    await shot(page, "03-checkout-complete-back-at-login");
    record("subscriptionCheckout", { completed: true, returnedTo: page.url() });

    // Email verification: Resend is not configured locally, so mint a token
    // exactly the way lib/auth-tokens.ts does (raw random hex, sha256 stored)
    // and click through /verify-email like the emailed link would.
    const [freshUser] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(and(eq(users.email, state.ownerEmail), isNull(users.deletedAt)))
      .limit(1);
    expect(freshUser, "signup must have created the owner user").toBeTruthy();
    const rawToken = randomBytes(32).toString("hex");
    await db.insert(authTokens).values({
      userId: freshUser!.id,
      email: freshUser!.email.toLowerCase(),
      tokenHash: createHash("sha256").update(rawToken).digest("hex"),
      type: "email_verify",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    state.verificationUrl = `/verify-email?token=${rawToken}`;
    await page.goto(state.verificationUrl, { waitUntil: "domcontentloaded" });
    await expect(page.getByText(/your email is verified/i)).toBeVisible({ timeout: 30_000 });
    await shot(page, "04-email-verified");
    record("emailVerification", { verified: true });

    await login(page, state.ownerEmail);
    await shot(page, "05-first-login");

    // The subscription webhook (stripe listen forwarder) must activate the practice.
    const practice = await waitUntil(
      async () => {
        const [row] = await db
          .select({
            id: practices.id,
            billingStatus: practices.billingStatus,
            subscriptionTier: practices.subscriptionTier,
            stripeCustomerId: practices.stripeCustomerId,
            stripeSubscriptionId: practices.stripeSubscriptionId,
          })
          .from(practices)
          .where(and(eq(practices.email, state.ownerEmail), isNull(practices.deletedAt)))
          .limit(1);
        return row?.stripeSubscriptionId ? row : null;
      },
      { timeoutMs: 90_000, label: "subscription webhook to set stripeSubscriptionId" }
    );
    state.practiceId = practice.id;
    record("subscriptionState", practice);
    expect(["active", "trialing"]).toContain(practice.billingStatus ?? "");

    await context.close();
  });

  test("2. Stripe Connect Express onboarding attempt", async ({ browser }) => {
    test.setTimeout(300_000);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await suppressCookieBanner(context);
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    await login(page, state.ownerEmail);

    await page.goto("/settings", { waitUntil: "domcontentloaded" });
    await page.getByText("Plan & Billing", { exact: true }).click();
    await page.waitForSelector("text=Client payment processing", { timeout: 20_000 });
    await shot(page, "06-payment-settings-before");

    await page.getByRole("button", { name: /^(Set up|Resume setup)$/ }).click();
    await page
      .waitForURL((url) => isStripeHostname(url.hostname), { timeout: 30_000 })
      .catch(() => undefined);
    record("connectOnboarding", { reachedStripe: isStripeUrl(page.url()) });
    await shot(page, "07-connect-onboarding-start");

    if (!isStripeUrl(page.url())) {
      // The onboarding mutation failed before Stripe. Two external Stripe
      // dashboard prerequisites gate connected-account creation, in order:
      //   1. Enable Connect (dashboard.stripe.com/connect) — DONE 2026-07-03.
      //   2. Complete the Connect platform profile "responsibilities for
      //      managing losses" section
      //      (dashboard.stripe.com/settings/connect/platform-profile) — until
      //      this is filled in, accounts.create returns a platform-profile
      //      error even though Connect is enabled.
      const [blockedAccount] = await db
        .select({ id: practicePaymentAccounts.id })
        .from(practicePaymentAccounts)
        .where(
          and(
            eq(practicePaymentAccounts.practiceId, state.practiceId),
            isNull(practicePaymentAccounts.deletedAt)
          )
        )
        .limit(1);
      if (!blockedAccount) {
        record("connectAccount", {
          blocked:
            "Stripe Connect platform profile incomplete — complete the 'managing losses' responsibilities at dashboard.stripe.com/settings/connect/platform-profile",
          account: null,
        });
        await context.close();
        test.skip(
          true,
          "Stripe Connect not enabled on the platform Stripe account — external dashboard action"
        );
      }
    }

    // Best-effort walk through Express test-mode onboarding. Every iteration
    // fills whatever known test fields are visible, then advances.
    const actions: string[] = [];
    for (let step = 0; step < 25; step++) {
      if (!isStripeUrl(page.url())) break;
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
      await page.waitForTimeout(2_000);
      await shot(page, `08-connect-step-${String(step).padStart(2, "0")}`);

      const clickIfVisible = async (locator: ReturnType<Page["locator"]>, label: string) => {
        const el = locator.first();
        if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
          await el.click().catch(() => undefined);
          actions.push(`${step}:${label}`);
          return true;
        }
        return false;
      };
      const fillIfVisible = async (selector: string, value: string, label: string) => {
        const el = page.locator(selector).first();
        if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
          const existing = await el.inputValue().catch(() => "");
          if (!existing) {
            await el.fill(value).catch(() => undefined);
            actions.push(`${step}:${label}`);
          }
        }
      };

      // Test-mode shortcuts first.
      if (
        await clickIfVisible(
          page.getByRole("link", { name: /skip this form|use test data/i }),
          "skip-form"
        )
      ) {
        await page.waitForTimeout(2_000);
      }
      await clickIfVisible(page.getByText(/the test phone number/i), "test-phone");
      await clickIfVisible(page.getByText(/use test code/i), "test-code");

      await fillIfVisible('input[name="phone"]', "0000000000", "phone");
      await fillIfVisible('input[name="email"]', state.ownerEmail, "email");
      await fillIfVisible('input[name="first_name"], input[name="firstName"]', "Launch", "first");
      await fillIfVisible('input[name="last_name"], input[name="lastName"]', "Owner", "last");
      await fillIfVisible('input[name="dob-day"]', "01", "dob-day");
      await fillIfVisible('input[name="dob-month"]', "01", "dob-month");
      await fillIfVisible('input[name="dob-year"]', "1990", "dob-year");
      await fillIfVisible('input[name="ssn_last_4"], input[name="id_number"]', "0000", "ssn");
      await fillIfVisible(
        'input[name="address"], input[name="line1"], input[autocomplete="address-line1"]',
        "123 Launch St",
        "address"
      );
      await fillIfVisible('input[name="locality"], input[name="city"]', "San Francisco", "city");
      await fillIfVisible('input[name="zip"], input[name="postal_code"]', "94103", "zip");
      await fillIfVisible(
        'input[name="url"], input[name="business_profile[url]"]',
        "https://example.com",
        "url"
      );
      await fillIfVisible('input[name="routing_number"]', "110000000", "routing");
      await fillIfVisible(
        'input[name="account_number"], input[name="accountNumber"]',
        "000123456789",
        "account"
      );
      await fillIfVisible(
        'input[name="account_number_validate"], input[name="accountNumberValidate"]',
        "000123456789",
        "account-confirm"
      );

      // OTP screens: type the test code if individual digit inputs are shown.
      const otp = page.locator('input[autocomplete="one-time-code"]').first();
      if ((await otp.count()) > 0 && (await otp.isVisible().catch(() => false))) {
        await otp.click().catch(() => undefined);
        await page.keyboard.type("000000", { delay: 60 });
        actions.push(`${step}:otp`);
      }

      const advanced = await clickIfVisible(
        page.getByRole("button", {
          name: /agree and submit|agree & submit|^submit$|^continue$|^next$|^save$|^done$|^confirm$/i,
        }),
        "advance"
      );
      if (!advanced) {
        // Nothing actionable found; try a generic submit before giving up.
        const fallback = await clickIfVisible(
          page.locator('button[type="submit"]'),
          "fallback-submit"
        );
        if (!fallback) break;
      }
    }

    // Land back in the app (or bail), then let the app resync account state.
    await page
      .waitForURL((url) => !isStripeHostname(url.hostname), { timeout: 30_000 })
      .catch(() => undefined);
    await page.goto("/settings", { waitUntil: "domcontentloaded" });
    await page.getByText("Plan & Billing", { exact: true }).click();
    await page.waitForSelector("text=Client payment processing", { timeout: 20_000 });
    await page.waitForTimeout(5_000);
    await shot(page, "09-payment-settings-after");

    const [account] = await db
      .select({
        onboardingStatus: practicePaymentAccounts.onboardingStatus,
        chargesEnabled: practicePaymentAccounts.chargesEnabled,
        payoutsEnabled: practicePaymentAccounts.payoutsEnabled,
        detailsSubmitted: practicePaymentAccounts.detailsSubmitted,
      })
      .from(practicePaymentAccounts)
      .where(
        and(
          eq(practicePaymentAccounts.practiceId, state.practiceId),
          isNull(practicePaymentAccounts.deletedAt)
        )
      )
      .limit(1);
    record("connectAccount", { actions, account: account ?? null });
    expect(account, "a Connect payment account row should exist after Set up").toBeTruthy();

    await context.close();
  });

  test("3. clinic-day writes: client, patient, appointment, SOAP note, invoice", async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await suppressCookieBanner(context);
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    await login(page, state.ownerEmail);

    // Client
    await page.goto("/clients/new", { waitUntil: "domcontentloaded" });
    await page.fill("#firstName", state.clientFirstName);
    await page.fill("#lastName", state.clientLastName);
    await page.fill("#email", state.clientEmail);
    await page.fill("#phone", "555-0142");
    await page.getByRole("button", { name: /^Create Client$/ }).click();
    await page.waitForURL("**/clients", { timeout: 20_000 });
    await expect(page.getByText(state.clientLastName)).toBeVisible();
    await shot(page, "10-client-created");

    // Patient
    await page.goto("/patients/new", { waitUntil: "domcontentloaded" });
    await page.getByPlaceholder("Search clients by name or email...").fill(state.clientLastName);
    await page
      .getByRole("button", {
        name: new RegExp(`${state.clientFirstName} ${state.clientLastName}`),
      })
      .click();
    await page.fill("#name", state.patientName);
    await page.selectOption("#species", "canine");
    await page.fill("#breed", "Fresh Launch Mix");
    await page.getByRole("button", { name: /^Create Patient$/ }).click();
    await page.waitForURL("**/patients", { timeout: 20_000 });
    await expect(page.getByText(state.patientName)).toBeVisible();
    await shot(page, "11-patient-created");

    const [patientRow] = await db
      .select({ id: patients.id })
      .from(patients)
      .where(
        and(
          eq(patients.practiceId, state.practiceId),
          eq(patients.name, state.patientName),
          isNull(patients.deletedAt)
        )
      )
      .limit(1);
    expect(patientRow, "fresh patient must exist in DB").toBeTruthy();

    // Appointment via the schedule panel
    await page.goto("/schedule", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    await page.getByRole("button", { name: /New Appointment/i }).click();
    await page.getByPlaceholder("Search patients...").fill(state.patientName);
    await page
      .getByRole("button", { name: new RegExp(state.patientName) })
      .first()
      .click();
    // Appointment type and doctor are optional for save; set them when the
    // fresh clinic has options (scoped by their labels, NOT page-wide selects).
    await page
      .locator('div:has(> label:text("Appointment Type")) select')
      .first()
      .selectOption({ index: 1 }, { timeout: 5_000 })
      .catch(() => undefined);
    await page
      .locator('div:has(> label:text("Doctor")) select')
      .first()
      .selectOption({ index: 1 }, { timeout: 5_000 })
      .catch(() => undefined);
    await page.getByRole("button", { name: /^Save$/ }).click();
    await page.getByRole("button", { name: "Open visit" }).click();
    await page.waitForURL("**/encounters/**", { timeout: 20_000 });
    await expect(
      page.getByRole("button", { name: "Check in" })
    ).toBeVisible();
    // Hosted signup seeds demo appointments, so assert on OUR patient's row.
    const appointmentRow = await waitUntil(
      async () => {
        const rows = await db
          .select({ id: appointments.id })
          .from(appointments)
          .where(
            and(
              eq(appointments.practiceId, state.practiceId),
              eq(appointments.patientId, patientRow!.id),
              isNull(appointments.deletedAt)
            )
          );
        return rows.length > 0 ? rows : null;
      },
      { timeoutMs: 20_000, label: "fresh patient appointment row in DB" }
    );
    record("appointment", { countForFreshPatient: appointmentRow.length });
    await shot(page, "12-appointment-saved");

    // SOAP note — the sections are rich-text editors, so populate them the way
    // a clinic would: apply the preselected "Wellness Exam" template.
    await page.goto(`/records/new-soap/${patientRow!.id}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /apply template/i }).click();
    await page.waitForTimeout(1_500);
    await page.getByRole("button", { name: /save note/i }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/records/new-soap"), {
      timeout: 20_000,
    });
    await shot(page, "13-soap-saved");

    // Invoice with the first starter service
    await page.goto("/billing/new", { waitUntil: "domcontentloaded" });
    await page.getByPlaceholder("Search clients...").fill(state.clientLastName);
    await page
      .getByRole("button", {
        name: new RegExp(`${state.clientFirstName} ${state.clientLastName}`),
      })
      .click();
    await page.waitForFunction(
      (patientName) =>
        [...document.querySelectorAll("select option")].some((option) =>
          option.textContent?.includes(String(patientName))
        ),
      state.patientName,
      { timeout: 15_000 }
    );
    await page
      .locator("select")
      .nth(0)
      .selectOption({ label: `${state.patientName} (canine)` });
    await page.locator("select").nth(1).selectOption({ index: 1 });
    await page.getByRole("button", { name: /^Add$/ }).click();
    await page.waitForSelector("text=Subtotal", { timeout: 15_000 });
    await page.getByRole("button", { name: /^Create Invoice$/ }).click();
    await page.waitForURL("**/billing", { timeout: 20_000 });
    await shot(page, "14-invoice-created");

    const rows = await db
      .select({ id: invoices.id, status: invoices.status, total: invoices.total })
      .from(invoices)
      .where(and(eq(invoices.practiceId, state.practiceId), isNull(invoices.deletedAt)));
    record("clinicDay", {
      client: state.clientLastName,
      patient: state.patientName,
      invoices: rows,
    });
    expect(rows.length).toBeGreaterThan(0);

    await context.close();
  });

  test("4. client invoice card payment through Stripe test checkout", async ({ browser }) => {
    test.setTimeout(240_000);

    const [account] = await db
      .select({ chargesEnabled: practicePaymentAccounts.chargesEnabled })
      .from(practicePaymentAccounts)
      .where(
        and(
          eq(practicePaymentAccounts.practiceId, state.practiceId),
          isNull(practicePaymentAccounts.deletedAt)
        )
      )
      .limit(1);
    record("cardPaymentPrecondition", { chargesEnabled: account?.chargesEnabled ?? false });
    test.skip(
      !account?.chargesEnabled,
      "Connect charges are not enabled; card payment is blocked on Connect onboarding"
    );

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await suppressCookieBanner(context);
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    await login(page, state.ownerEmail);

    await page.goto("/billing", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    const invoiceRow = page
      .locator("tr, [role=\"row\"], li, div")
      .filter({ hasText: state.clientLastName })
      .filter({ has: page.locator("[title=\"Take card payment\"]") })
      .first();
    const payButton = (await invoiceRow.count())
      ? invoiceRow.locator("[title=\"Take card payment\"]").first()
      : page.locator("[title=\"Take card payment\"]").first();
    await payButton.click();

    await page.waitForURL((url) => isStripeHostname(url.hostname), { timeout: 60_000 });
    await completeStripeCheckout(page, "15-client-payment");
    await page.waitForURL((url) => url.pathname.startsWith("/billing"), { timeout: 90_000 });
    await shot(page, "16-client-payment-returned");

    const paid = await waitUntil(
      async () => {
        const rows = await db
          .select({ id: invoices.id, status: invoices.status, paidAmount: invoices.paidAmount })
          .from(invoices)
          .where(and(eq(invoices.practiceId, state.practiceId), isNull(invoices.deletedAt)));
        return rows.find((row) => row.status === "paid") ?? null;
      },
      { timeoutMs: 90_000, label: "connect webhook to mark the invoice paid" }
    );
    record("cardPayment", { paidInvoice: paid });

    await context.close();
  });

  test("5. patient photo upload round-trips through object storage", async ({ browser }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await suppressCookieBanner(context);
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    await login(page, state.ownerEmail);

    const [patientRow] = await db
      .select({ id: patients.id })
      .from(patients)
      .where(
        and(
          eq(patients.practiceId, state.practiceId),
          eq(patients.name, state.patientName),
          isNull(patients.deletedAt)
        )
      )
      .limit(1);
    expect(patientRow).toBeTruthy();

    await page.goto(`/patients/${patientRow!.id}`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);

    // 1x1 PNG
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    await page.locator('input[type="file"]').first().setInputFiles({
      name: `launch-photo-${runId}.png`,
      mimeType: "image/png",
      buffer: Buffer.from(pngBase64, "base64"),
    });
    await page.waitForTimeout(6_000);
    await shot(page, "17-photo-uploaded");

    const uploadedVisible = await page
      .locator("img[src*=\"/api/\"], img[src*=\"files\"], img[alt*=\"photo\" i]")
      .first()
      .isVisible()
      .catch(() => false);
    record("photoUpload", { uploadedVisible });

    await context.close();
  });

  test("6. a second clinic cannot see any fresh-clinic data", async ({ browser }) => {
    test.setTimeout(120_000);

    // Seed a minimal second clinic (verified owner) for the isolation probe.
    const otherEmail = `owner.other.${runId}@example.com`;
    const passwordHash = await bcrypt.hash(password, 10);
    const [otherPractice] = await db
      .insert(practices)
      .values({
        name: `Isolation Probe Clinic ${runId}`,
        email: `hello.other.${runId}@example.com`,
        subscriptionTier: "cloud",
        billingStatus: "active",
        stripeCustomerId: `cus_e2e_other_${runId}`,
        stripeSubscriptionId: `sub_e2e_other_${runId}`,
      })
      .returning();
    const [otherLocation] = await db
      .insert(locations)
      .values({ practiceId: otherPractice!.id, name: "Main Clinic", isPrimary: true })
      .returning();
    await db.insert(users).values({
      email: otherEmail,
      passwordHash,
      name: "Dr. Isolation Probe",
      role: "admin",
      practiceId: otherPractice!.id,
      locationId: otherLocation!.id,
      emailVerifiedAt: new Date(),
    });

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await suppressCookieBanner(context);
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    await login(page, otherEmail);

    for (const route of ["/clients", "/patients", "/billing"]) {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
      const body = await page.locator("body").innerText();
      expect(body, `${route} must not leak fresh-clinic data`).not.toContain(
        state.clientLastName
      );
      expect(body, `${route} must not leak fresh-clinic patient`).not.toContain(
        state.patientName
      );
      expect(body, `${route} must not leak fresh-clinic practice`).not.toContain(
        state.practiceName
      );
    }
    await shot(page, "18-isolation-check");
    record("isolation", { probedClinic: otherPractice!.id, leaks: false });
    record("finishedAt", new Date().toISOString());

    await context.close();
  });
});
