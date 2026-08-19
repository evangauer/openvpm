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
import { withSystem, withTenant } from "../apps/web/lib/tenant-db";

/**
 * Fresh-clinic mock launch flow (2026-07-01 readiness pass).
 *
 * Simulates a brand-new clinic joining the hosted service end to end, in
 * Stripe TEST mode, against a local hosted-mode server with `stripe listen`
 * forwarding webhooks:
 *   personalized signup UI → card-free trial → email verification →
 *   billing-plan selection → Stripe Checkout (4242 card) → subscription
 *   webhook → Accounts v2 Connect onboarding attempt →
 *   clinic-day writes → client card payment via Connect checkout →
 *   patient photo upload (object storage) → cross-clinic isolation.
 *
 * Evidence (screenshots + summary.json) lands in
 * test-results/fresh-clinic-launch/.
 */

const RESULTS_DIR = path.join(process.cwd(), "test-results", "fresh-clinic-launch");
const SUMMARY_PATH = path.join(RESULTS_DIR, "summary.json");

const runId = process.env.FRESH_CLINIC_RUN_ID ?? `${Date.now()}`;
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
let browserContextSequence = 0;

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

function safeProviderEndpoint(value: string): string {
  try {
    const url = new URL(value);
    const path = url.hostname === "checkout.stripe.com" ? "/c/pay/[redacted]" : url.pathname;
    if (url.hostname === "api.stripe.com" && path.includes("/payment_pages/")) {
      return `${url.hostname}/v1/payment_pages/[redacted]`;
    }
    return `${url.hostname}${path}`;
  } catch {
    return "unparseable-provider-url";
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
  browserContextSequence += 1;
  const testIpLastOctet =
    1 + ((Number(runId.slice(-6)) + browserContextSequence) % 254);
  await context.setExtraHTTPHeaders({
    "x-forwarded-for": `198.51.100.${testIpLastOctet}`,
  });
  await context.addInitScript(() => {
    window.localStorage.setItem("openvpm.cookie-consent.v1", "essential");
  });
}

async function stopSendingAppTestHeaders(context: BrowserContext) {
  // The synthetic X-Forwarded-For value is only for the app's registration
  // rate-limit bucket. Never forward it to Stripe-hosted pages: browser-level
  // extra headers apply cross-origin and can interfere with provider requests.
  await context.setExtraHTTPHeaders({});
}

async function dismissGuidedSetup(page: Page, timeout = 3_000) {
  const finishLater = page.getByRole("button", { name: /i'll finish later/i });
  const visible = await finishLater
    .waitFor({ state: "visible", timeout })
    .then(() => true)
    .catch(() => false);
  if (visible) {
    await finishLater.click();
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 10_000 });
  }
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

  // Fresh clinics may resume the guided setup after authentication. This
  // walkthrough is specifically proving billing and clinic-day workflows, so
  // take the product's explicit safe exit and continue without changing data.
  await dismissGuidedSetup(page);
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

/** Click a visible button across the top page and embedded provider frames. */
async function clickButtonAnywhere(page: Page, name: RegExp): Promise<boolean> {
  for (const frame of page.frames()) {
    const button = frame.getByRole("button", { name }).first();
    if ((await button.count()) > 0 && (await button.isVisible().catch(() => false))) {
      await button.click({ timeout: 5_000 }).catch(() => undefined);
      return true;
    }
  }
  return false;
}

async function stripeHumanVerificationVisible(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    if (/captcha/i.test(frame.url())) return true;
    const body = await frame.locator("body").innerText().catch(() => "");
    if (
      /drag the shape into its outline|click on all objects smaller than|verification challenge/i.test(
        body
      )
    ) {
      return true;
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
  const addressFilled = await fillAnywhere(
    page,
    [
      '#billingAddressLine1, input[name="billingAddressLine1"]',
      'input[name="addressLine1"], input[name="line1"]',
      'input[autocomplete="address-line1"]',
    ],
    "123 Launch Street"
  );
  expect(addressFilled, "billing address is required for automatic tax").toBe(true);
  const cityFilled = await fillAnywhere(
    page,
    [
      '#billingLocality, input[name="billingLocality"]',
      'input[name="city"], input[name="locality"]',
      'input[autocomplete="address-level2"]',
    ],
    "San Francisco"
  );
  expect(cityFilled, "billing city is required for automatic tax").toBe(true);
  for (const frame of page.frames()) {
    const stateSelect = frame
      .locator(
        '#billingAdministrativeArea, select[name="billingAdministrativeArea"], select[name="state"], select[autocomplete="address-level1"]'
      )
      .first();
    if ((await stateSelect.count()) > 0 && (await stateSelect.isVisible().catch(() => false))) {
      await stateSelect.selectOption({ label: "California" }).catch(() => undefined);
      break;
    }
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
  test("1. card-free signup then secure checkout activates the subscription", async ({
    browser,
  }) => {
    test.setTimeout(330_000);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await suppressCookieBanner(context);
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    const providerNetworkIssues: Array<Record<string, unknown>> = [];
    page.on("requestfailed", (request) => {
      if (!isStripeUrl(request.url())) return;
      providerNetworkIssues.push({
        kind: "request-failed",
        endpoint: safeProviderEndpoint(request.url()),
        method: request.method(),
        reason: request.failure()?.errorText ?? "unknown",
      });
    });
    page.on("response", (response) => {
      if (!isStripeUrl(response.url()) || response.status() < 400) return;
      providerNetworkIssues.push({
        kind: "http-error",
        endpoint: safeProviderEndpoint(response.url()),
        method: response.request().method(),
        status: response.status(),
    });
    });

    if (process.env.REUSE_EXISTING_FRESH_CLINIC === "true") {
      await login(page, state.ownerEmail);
      const session = await page.evaluate(async () => {
        const response = await fetch("/api/auth/session", { cache: "no-store" });
        if (!response.ok) throw new Error(`Session request failed: ${response.status}`);
        return response.json() as Promise<{ user?: { practiceId?: string } }>;
      });
      expect(session.user?.practiceId, "existing clinic session must expose its tenant id").toBeTruthy();
      state.practiceId = session.user!.practiceId!;
      const [practice] = await withTenant(db, state.practiceId, (tx) =>
        tx
          .select({
            id: practices.id,
            billingStatus: practices.billingStatus,
            subscriptionTier: practices.subscriptionTier,
            stripeSubscriptionId: practices.stripeSubscriptionId,
          })
          .from(practices)
          .where(and(eq(practices.id, state.practiceId), isNull(practices.deletedAt)))
          .limit(1)
      );
      record("register", {
        reusedExistingSyntheticClinic: true,
        signedIn: true,
        billingStatus: practice?.billingStatus ?? null,
      });
      record("subscriptionCheckout", {
        completed: Boolean(practice?.stripeSubscriptionId),
        actionRequired: practice?.stripeSubscriptionId
          ? null
          : "Complete Stripe's human-verification challenge in a real browser",
      });
      await shot(page, "02-existing-card-free-trial");
      await context.close();
      test.skip(true, "Reusing the authenticated synthetic clinic after the registration rate limit");
    }

    await page.goto("/register", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);

    await page.getByRole("button", { name: /show my workflows/i }).click();
    await expect(page.getByText("Step 2 of 4")).toBeVisible();

    // Re-fill until React hydration has caught the values. Filling before
    // hydration can leave controlled fields empty.
    for (let attempt = 0; attempt < 4; attempt++) {
      await page.getByLabel(/practice name/i).fill(state.practiceName);
      await page.getByLabel(/work email/i).fill(state.ownerEmail);
      if ((await page.getByLabel(/practice name/i).inputValue()) === state.practiceName) break;
      await page.waitForTimeout(2_000);
    }
    await page.getByRole("button", { name: /see my first day/i }).click();
    await expect(page.getByText("Step 3 of 4")).toBeVisible();
    await expect(page.getByRole("heading", { name: /your first day is ready/i })).toBeVisible();
    await page.getByRole("button", { name: /secure my workspace/i }).click();
    await expect(page.getByText("Step 4 of 4")).toBeVisible();
    await page.getByLabel(/clinic country/i).selectOption("US");
    await page.getByLabel(/^password$/i).fill(password);
    const submitButton = page.getByRole("button", { name: /start my free trial/i });
    await expect(submitButton).toBeEnabled({ timeout: 5_000 });
    await shot(page, "01-register-filled");
    await submitButton.click();

    // Hosted signup grants the intended card-free trial and signs the clinic
    // straight into its workspace. Billing is connected explicitly below.
    await page.waitForURL(
      (url) => !url.pathname.startsWith("/register") && !url.pathname.startsWith("/login"),
      { timeout: 90_000 }
    );
    record("register", { cardFreeTrialEntered: true, returnedTo: page.url() });
    await shot(page, "02-card-free-trial-entered");

    // The hosted preview connects with the least-privilege application role.
    // Capture the signed-in tenant from the authenticated session before any
    // direct verification query so the E2E harness is subject to the same RLS
    // boundary as the application.
    const session = await page.evaluate(async () => {
      const response = await fetch("/api/auth/session", { cache: "no-store" });
      if (!response.ok) throw new Error(`Session request failed: ${response.status}`);
      return response.json() as Promise<{ user?: { practiceId?: string } }>;
    });
    expect(session.user?.practiceId, "signup session must expose its tenant id").toBeTruthy();
    state.practiceId = session.user!.practiceId!;

    // Email verification: Resend is not configured locally, so mint a token
    // exactly the way lib/auth-tokens.ts does (raw random hex, sha256 stored)
    // and click through /verify-email like the emailed link would. This proves
    // the product link flow, not external mailbox delivery; that remains an
    // explicit launch gate and is recorded as such below.
    const [freshUser] = await withTenant(db, state.practiceId, (tx) =>
      tx
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(and(eq(users.email, state.ownerEmail), isNull(users.deletedAt)))
        .limit(1)
    );
    expect(freshUser, "signup must have created the owner user").toBeTruthy();
    const rawToken = randomBytes(32).toString("hex");
    await withTenant(db, state.practiceId, (tx) =>
      tx.insert(authTokens).values({
        userId: freshUser!.id,
        email: freshUser!.email.toLowerCase(),
        tokenHash: createHash("sha256").update(rawToken).digest("hex"),
        type: "email_verify",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      })
    );
    state.verificationUrl = `/verify-email?token=${rawToken}`;
    await page.goto(state.verificationUrl, { waitUntil: "domcontentloaded" });
    await expect(page.getByText(/email confirmed/i)).toBeVisible({ timeout: 30_000 });
    await shot(page, "03-email-verified");
    record("emailVerification", {
      verified: true,
      delivery: "simulated-link-only",
      launchGate: "Real Gmail, Outlook, and clinic-domain delivery/header tests remain required",
    });

    await login(page, state.ownerEmail);
    await stopSendingAppTestHeaders(context);
    await shot(page, "04-first-login");

    // The clinic deliberately chooses a billing schedule and adds its card
    // after entering the trial. Stripe keeps the card; no charge is due today.
    await page.goto("/settings?tab=billing", { waitUntil: "domcontentloaded" });
    await dismissGuidedSetup(page, 10_000);
    await page.getByText("Plan & Billing", { exact: true }).click();
    await page.waitForSelector("text=Activate your account", { timeout: 30_000 });
    const monthlyCadence = page.locator(
      'input[name="billing-cadence"][value="month"]'
    );
    await monthlyCadence.evaluate((input: HTMLInputElement) => input.click());
    await expect(monthlyCadence).toBeChecked();
    await shot(page, "05-plan-and-billing-before");
    await page.getByRole("button", { name: /continue to secure checkout/i }).click();
    await page.waitForURL((url) => isStripeHostname(url.hostname), { timeout: 90_000 });
    await completeStripeCheckout(page, "06-subscription");
    const checkoutOutcome = await waitUntil(
      async () => {
        if (new URL(page.url()).pathname.startsWith("/settings")) return "returned" as const;
        if (await stripeHumanVerificationVisible(page)) return "human-verification" as const;
        return false;
      },
      { timeoutMs: 90_000, intervalMs: 1_000, label: "Checkout return or human verification" }
    ).catch((error: unknown) => {
      record("subscriptionCheckoutFailure", {
        providerPage: safeProviderEndpoint(page.url()),
        networkIssues: providerNetworkIssues.slice(-40),
      });
      throw error;
    });
    if (checkoutOutcome === "human-verification") {
      record("subscriptionCheckout", {
        completed: false,
        actionRequired: "Complete Stripe's human-verification challenge in a real browser",
        providerPage: safeProviderEndpoint(page.url()),
      });
      await shot(page, "07-subscription-human-verification-required");
      await context.close();
      test.skip(true, "Stripe Checkout requires a human-verification challenge");
    }
    await shot(page, "07-subscription-checkout-returned");
    record("subscriptionCheckout", { completed: true, returnedTo: page.url() });

    // The subscription webhook (stripe listen forwarder) must activate the practice.
    const practice = await waitUntil(
      async () => {
        const [row] = await withTenant(db, state.practiceId, (tx) =>
          tx
            .select({
              id: practices.id,
              billingStatus: practices.billingStatus,
              subscriptionTier: practices.subscriptionTier,
              stripeCustomerId: practices.stripeCustomerId,
              stripeSubscriptionId: practices.stripeSubscriptionId,
            })
            .from(practices)
            .where(and(eq(practices.id, state.practiceId), isNull(practices.deletedAt)))
            .limit(1)
        );
        return row?.stripeSubscriptionId ? row : null;
      },
      { timeoutMs: 90_000, label: "subscription webhook to set stripeSubscriptionId" }
    );
    expect(practice.id).toBe(state.practiceId);
    record("subscriptionState", practice);
    expect(["active", "trialing"]).toContain(practice.billingStatus ?? "");

    await context.close();
  });

  test("2. Stripe Connect Accounts v2 onboarding attempt", async ({ browser }) => {
    test.setTimeout(300_000);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await suppressCookieBanner(context);
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    await login(page, state.ownerEmail);
    await stopSendingAppTestHeaders(context);

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
      const [blockedAccount] = await withTenant(db, state.practiceId, (tx) =>
        tx
          .select({ id: practicePaymentAccounts.id })
          .from(practicePaymentAccounts)
          .where(
            and(
              eq(practicePaymentAccounts.practiceId, state.practiceId),
              isNull(practicePaymentAccounts.deletedAt)
            )
          )
          .limit(1)
      );
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

    // Best-effort walk through Accounts v2 test-mode onboarding for a clinic
    // with full Stripe Dashboard access. Every iteration
    // fills whatever known test fields are visible, then advances.
    const actions: string[] = [];
    let manualVerificationRequired = false;
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
      if (await clickButtonAnywhere(page, /^skip$/i)) {
        actions.push(`${step}:skip-test-verification`);
        await page.waitForTimeout(2_000);
      }
      if (await stripeHumanVerificationVisible(page)) {
        manualVerificationRequired = true;
        actions.push(`${step}:manual-human-verification-required`);
        break;
      }
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
    if (!manualVerificationRequired) {
      await page
        .waitForURL((url) => !isStripeHostname(url.hostname), { timeout: 30_000 })
        .catch(() => undefined);
    }
    await page.goto("/settings", { waitUntil: "domcontentloaded" });
    await page.getByText("Plan & Billing", { exact: true }).click();
    await page.waitForSelector("text=Client payment processing", { timeout: 20_000 });
    await page.waitForTimeout(5_000);
    await shot(page, "09-payment-settings-after");

    const [account] = await withTenant(db, state.practiceId, (tx) =>
      tx
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
        .limit(1)
    );
    record("connectAccount", {
      actions,
      manualVerificationRequired,
      account: account ?? null,
    });
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
    await stopSendingAppTestHeaders(context);

    // Client
    await page.goto("/clients/new", { waitUntil: "domcontentloaded" });
    await page.fill("#firstName", state.clientFirstName);
    await page.fill("#lastName", state.clientLastName);
    await page.fill("#email", state.clientEmail);
    await page.fill("#phone", "555-0142");
    await page.getByRole("button", { name: /^Create Client$/ }).click();
    await page.waitForURL(/\/clients\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\?.*)?$/i, {
      timeout: 60_000,
    });
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
    await page.waitForURL(/\/patients\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\?.*)?$/i, {
      timeout: 60_000,
    });
    await expect(
      page.getByRole("heading", { name: state.patientName, exact: true })
    ).toBeVisible({ timeout: 30_000 });
    await shot(page, "11-patient-created");

    const [patientRow] = await withTenant(db, state.practiceId, (tx) =>
      tx
        .select({ id: patients.id })
        .from(patients)
        .where(
          and(
            eq(patients.practiceId, state.practiceId),
            eq(patients.name, state.patientName),
            isNull(patients.deletedAt)
          )
        )
        .limit(1)
    );
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
    // Use the seeded team vaccination workflow. A fresh owner has not created
    // a provider profile yet, so doctor-required visit types must correctly
    // remain blocked from check-in.
    await page
      .locator('div:has(> label:text("Appointment Type")) select')
      .first()
      .selectOption({ label: "Vaccination (15 min)" });
    // Signup intentionally seeds a realistic sample day. Choose an explicit
    // open same-day slot so this visit can proceed through check-in and exam.
    const appointmentDate = new Date();
    const appointmentDateValue = [
      appointmentDate.getFullYear(),
      String(appointmentDate.getMonth() + 1).padStart(2, "0"),
      String(appointmentDate.getDate()).padStart(2, "0"),
    ].join("-");
    await page.locator('input[type="date"]').last().fill(appointmentDateValue);
    await page
      .locator('div:has(> label:text("Start Time")) select')
      .first()
      .selectOption("17:00");
    await page.getByRole("button", { name: /^Save$/ }).click();
    await page
      .getByRole("button", { name: "Open visit" })
      .click({ noWaitAfter: true });
    await page.waitForURL("**/encounters/**", { timeout: 60_000 });
    await page.getByRole("button", { name: "Check in" }).click();
    await expect(page.getByRole("button", { name: "Start exam" })).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole("button", { name: "Start exam" }).click();
    const writeSoapLink = page
      .getByRole("link", { name: "Write SOAP note" })
      .first();
    await expect(writeSoapLink).toBeVisible({ timeout: 20_000 });
    // Hosted signup seeds demo appointments, so assert on OUR patient's row.
    const appointmentRow = await waitUntil(
      async () => {
        const rows = await withTenant(db, state.practiceId, (tx) =>
          tx
            .select({ id: appointments.id })
            .from(appointments)
            .where(
              and(
                eq(appointments.practiceId, state.practiceId),
                eq(appointments.patientId, patientRow!.id),
                isNull(appointments.deletedAt)
              )
            )
        );
        return rows.length > 0 ? rows : null;
      },
      { timeoutMs: 20_000, label: "fresh patient appointment row in DB" }
    );
    record("appointment", { countForFreshPatient: appointmentRow.length });
    await shot(page, "12-appointment-saved");

    // SOAP note — enter through the active visit so the note is linked to the
    // clinical encounter, then populate it with the preselected template.
    await writeSoapLink.click();
    await page.waitForURL("**/records/new-soap/**", { timeout: 60_000 });
    await page.getByRole("button", { name: /apply template/i }).click();
    const finalizeSoap = page.getByRole("button", {
      name: /finalize soap note/i,
    });
    await expect(
      page.getByText(/draft still contains template prompts/i)
    ).toBeVisible();
    await expect(finalizeSoap).toBeDisabled();

    const soapEditors = page.locator(".ProseMirror");
    await expect(soapEditors).toHaveCount(4);
    const syntheticSections = [
      "Synthetic test owner reports the patient presented for a scheduled vaccination and has been eating, drinking, and acting normally.",
      "Synthetic test patient is alert and responsive. Injection site was inspected before vaccination.",
      "Synthetic test assessment: appropriate for the scheduled vaccination based on the documented visit findings.",
      "Synthetic test plan: vaccination workflow completed; owner-facing monitoring guidance and return precautions reviewed.",
    ];
    for (let index = 0; index < syntheticSections.length; index++) {
      await soapEditors.nth(index).fill(syntheticSections[index]!);
    }
    await expect(finalizeSoap).toBeEnabled({ timeout: 30_000 });
    page.once("dialog", (dialog) => dialog.accept());
    await finalizeSoap.click();
    await page.waitForURL((url) => !url.pathname.startsWith("/records/new-soap"), {
      timeout: 60_000,
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
    await page.getByRole("button", { name: "Search services..." }).click();
    await page.getByRole("textbox", { name: "Search services" }).fill("Wellness Exam");
    await page.getByRole("option", { name: /Wellness Exam/ }).click();
    await page.getByRole("button", { name: /^Add$/ }).click();
    await page.waitForSelector("text=Subtotal", { timeout: 15_000 });
    await page.getByRole("button", { name: /^Create Invoice$/ }).click();
    await page.waitForURL("**/billing", { timeout: 60_000 });
    await shot(page, "14-invoice-created");

    const rows = await withTenant(db, state.practiceId, (tx) =>
      tx
        .select({ id: invoices.id, status: invoices.status, total: invoices.total })
        .from(invoices)
        .where(and(eq(invoices.practiceId, state.practiceId), isNull(invoices.deletedAt)))
    );
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

    const [account] = await withTenant(db, state.practiceId, (tx) =>
      tx
        .select({ chargesEnabled: practicePaymentAccounts.chargesEnabled })
        .from(practicePaymentAccounts)
        .where(
          and(
            eq(practicePaymentAccounts.practiceId, state.practiceId),
            isNull(practicePaymentAccounts.deletedAt)
          )
        )
        .limit(1)
    );
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
    await stopSendingAppTestHeaders(context);

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
        const rows = await withTenant(db, state.practiceId, (tx) =>
          tx
            .select({ id: invoices.id, status: invoices.status, paidAmount: invoices.paidAmount })
            .from(invoices)
            .where(and(eq(invoices.practiceId, state.practiceId), isNull(invoices.deletedAt)))
        );
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

    const [patientRow] = await withTenant(db, state.practiceId, (tx) =>
      tx
        .select({ id: patients.id })
        .from(patients)
        .where(
          and(
            eq(patients.practiceId, state.practiceId),
            eq(patients.name, state.patientName),
            isNull(patients.deletedAt)
          )
        )
        .limit(1)
    );
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
    const uploadedPatient = await waitUntil(
      async () => {
        const [row] = await withTenant(db, state.practiceId, (tx) =>
          tx
            .select({ photoUrl: patients.photoUrl })
            .from(patients)
            .where(
              and(
                eq(patients.id, patientRow!.id),
                eq(patients.practiceId, state.practiceId),
                isNull(patients.deletedAt)
              )
            )
            .limit(1)
        );
        return row?.photoUrl ? row : null;
      },
      { timeoutMs: 20_000, label: "patient photo URL to persist" }
    );
    await expect(
      page.getByRole("img", { name: state.patientName, exact: true })
    ).toBeVisible({ timeout: 20_000 });
    await shot(page, "17-photo-uploaded");

    record("photoUpload", {
      persisted: true,
      servedThroughAuthenticatedRoute: uploadedPatient.photoUrl.startsWith("/api/files/"),
    });
    expect(uploadedPatient.photoUrl).toMatch(/^\/api\/files\//);

    await context.close();
  });

  test("6. a second clinic cannot see any fresh-clinic data", async ({ browser }) => {
    test.setTimeout(120_000);

    // Seed a minimal second clinic (verified owner) for the isolation probe.
    const otherEmail = `owner.other.${runId}@example.com`;
    const passwordHash = await bcrypt.hash(password, 10);
    const { otherPractice } = await withSystem(db, async (tx) => {
      const [createdPractice] = await tx
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
      const [createdLocation] = await tx
        .insert(locations)
        .values({ practiceId: createdPractice!.id, name: "Main Clinic", isPrimary: true })
        .returning();
      await tx.insert(users).values({
        email: otherEmail,
        passwordHash,
        name: "Dr. Isolation Probe",
        role: "admin",
        practiceId: createdPractice!.id,
        locationId: createdLocation!.id,
        emailVerifiedAt: new Date(),
      });
      return { otherPractice: createdPractice! };
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
