import Stripe from "stripe";
import { createHash } from "node:crypto";
import { isSafeCheckoutRedirectUrl } from "@/lib/checkout-redirect";
import {
  stripeConnectWebhookSecret,
  stripeSecretKey,
  stripeSubscriptionWebhookSecret,
  stripeWebhookSecret,
} from "@/lib/stripe-config";
import { envFlagEnabled } from "@/lib/env-bool";
import type { BillingCadence } from "@/lib/billing/catalog";

export const STRIPE_TAX_ENABLED_ENV = "STRIPE_TAX_ENABLED";
export const INVOICE_CHECKOUT_CAPTURE_MODE = "manual_v1";
export const STRIPE_API_VERSION = "2026-07-29.dahlia";
export const INVOICE_CHECKOUT_INTEGRATION_IDENTIFIER =
  "openvpm_invoice_jqkzrmnp";
export const SUBSCRIPTION_CHECKOUT_INTEGRATION_IDENTIFIER =
  "openvpm_subscription_vhtxcsla";
const EXCLUDED_SUBSCRIPTION_PAYMENT_METHODS: Stripe.Checkout.SessionCreateParams.ExcludedPaymentMethodType[] =
  ["amazon_pay", "cashapp", "klarna"];

function stripeIdempotencyKey(
  scope: string,
  identity: string,
  params?: unknown
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(params ?? identity))
    .digest("hex")
    .slice(0, 32);
  return `openvpm:${scope}:${identity}:${digest}`.slice(0, 255);
}

const configuredStripeSecretKey = stripeSecretKey();
const stripe = configuredStripeSecretKey
  ? new Stripe(configuredStripeSecretKey, { apiVersion: STRIPE_API_VERSION })
  : null;

export async function createCheckoutSession(data: {
  invoiceId: string;
  amount: number; // in cents
  clientEmail?: string | null;
  clientName: string;
  description: string;
  successUrl: string;
  cancelUrl: string;
  currency?: string; // ISO 4217 (lowercase), per the practice's region. Defaults to USD.
  connectedAccountId?: string | null;
  applicationFeeAmount?: number;
}): Promise<{ url: string | null } | null> {
  if (!stripe) {
    console.warn("[Stripe] No API key configured; checkout session unavailable");
    return null;
  }
  const params = buildInvoiceCheckoutSessionParams(data);
  const session = await stripe.checkout.sessions.create(params, {
    idempotencyKey: stripeIdempotencyKey(
      "invoice-checkout",
      data.invoiceId,
      params
    ),
    ...(data.connectedAccountId
      ? { stripeAccount: data.connectedAccountId }
      : {}),
  });
  return { url: stripeCheckoutRedirectUrl(session.url) };
}

function checkoutAccountOptions(connectedAccountId?: string) {
  return connectedAccountId
    ? { stripeAccount: connectedAccountId }
    : undefined;
}

/**
 * Capture a Checkout authorization only after the webhook has locked and
 * revalidated the invoice's live balance. Partial capture releases the unused
 * authorization, so a stale Checkout session can never overpay the invoice.
 */
export async function captureStripeCheckoutAuthorization(data: {
  paymentIntentId: string;
  amountCents: number;
  checkoutSessionId: string;
  connectedAccountId?: string;
}): Promise<{ amountCapturedCents: number }> {
  if (!stripe) {
    throw new Error("Stripe is not configured; cannot capture card payment.");
  }
  if (!Number.isInteger(data.amountCents) || data.amountCents <= 0) {
    throw new Error("Stripe capture amount must be a positive integer.");
  }

  const accountOptions = checkoutAccountOptions(data.connectedAccountId);
  const current = accountOptions
    ? await stripe.paymentIntents.retrieve(
        data.paymentIntentId,
        {},
        accountOptions
      )
    : await stripe.paymentIntents.retrieve(data.paymentIntentId);

  // A transaction may fail after Stripe accepted the capture. On retry, use
  // Stripe's authoritative captured amount instead of attempting a new charge.
  if (current.status === "succeeded") {
    return { amountCapturedCents: current.amount_received };
  }
  if (current.status !== "requires_capture") {
    throw new Error(
      `Stripe Checkout authorization is not capturable: ${current.status}`
    );
  }

  const amountToCapture = Math.min(
    data.amountCents,
    current.amount_capturable
  );
  if (amountToCapture <= 0) {
    throw new Error("Stripe Checkout authorization has no capturable amount.");
  }
  const originalApplicationFee = current.application_fee_amount ?? 0;
  const proportionalApplicationFee =
    data.connectedAccountId &&
    originalApplicationFee > 0 &&
    current.amount > 0 &&
    amountToCapture > 1
      ? Math.min(
          Math.floor(
            (originalApplicationFee * amountToCapture) / current.amount
          ),
          amountToCapture - 1
        )
      : 0;
  const overrideApplicationFee =
    Boolean(data.connectedAccountId) && originalApplicationFee > 0;
  const captureParams: Stripe.PaymentIntentCaptureParams = {
    amount_to_capture: amountToCapture,
    ...(overrideApplicationFee
      ? { application_fee_amount: proportionalApplicationFee }
      : {}),
  };
  const captured = await stripe.paymentIntents.capture(
    data.paymentIntentId,
    captureParams,
    {
      idempotencyKey: stripeIdempotencyKey(
        "invoice-capture",
        data.checkoutSessionId,
        captureParams
      ),
      ...(accountOptions ?? {}),
    }
  );
  return { amountCapturedCents: captured.amount_received };
}

/**
 * Resolve a Checkout payment that can no longer be attributed safely. Manual
 * authorizations are canceled immediately; legacy automatic-capture sessions
 * are refunded with stable idempotency.
 */
export async function refundInvalidStripeCheckoutPayment(data: {
  externalId: string;
  amountCents: number;
  idempotencyKey: string;
}): Promise<
  | { outcome: "authorization_canceled" }
  | { outcome: "no_funds" }
  | { outcome: "refunded"; refundId: string; amountCents: number }
> {
  const parsed = parseStripeCheckoutExternalId(data.externalId);
  if (!parsed) {
    throw new Error("Invalid Stripe Checkout payment identity.");
  }
  if (!stripe) {
    throw new Error("Stripe is not configured; cannot resolve card payment.");
  }

  const accountOptions = checkoutAccountOptions(parsed.connectedAccountId);
  const session = accountOptions
    ? await stripe.checkout.sessions.retrieve(
        parsed.sessionId,
        {},
        accountOptions
      )
    : await stripe.checkout.sessions.retrieve(parsed.sessionId);
  const paymentIntentId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : session.payment_intent?.id;
  if (!paymentIntentId) {
    throw new Error(
      `Stripe Checkout session has no payment intent: ${parsed.sessionId}`
    );
  }
  const paymentIntent =
    typeof session.payment_intent === "object" && session.payment_intent
      ? session.payment_intent
      : accountOptions
        ? await stripe.paymentIntents.retrieve(
            paymentIntentId,
            {},
            accountOptions
          )
        : await stripe.paymentIntents.retrieve(paymentIntentId);

  if (paymentIntent.status === "requires_capture") {
    await stripe.paymentIntents.cancel(
      paymentIntentId,
      { cancellation_reason: "abandoned" },
      {
        idempotencyKey: stripeIdempotencyKey(
          "invalid-checkout-cancel",
          data.idempotencyKey
        ),
        ...(accountOptions ?? {}),
      }
    );
    return { outcome: "authorization_canceled" };
  }
  if (
    paymentIntent.status === "canceled" ||
    paymentIntent.status === "requires_payment_method"
  ) {
    return { outcome: "no_funds" };
  }
  if (paymentIntent.status !== "succeeded") {
    throw new Error(
      `Stripe Checkout payment is not ready to resolve: ${paymentIntent.status}`
    );
  }

  // An invalid Checkout must be reversed in full. Session.amount_total is
  // nullable and webhook payloads can be stale, while the PaymentIntent is
  // Stripe's authoritative record of money actually captured.
  const refundableCents = paymentIntent.amount_received;
  if (refundableCents <= 0) {
    return { outcome: "no_funds" };
  }
  const refund = await stripe.refunds.create(
    {
      payment_intent: paymentIntentId,
      amount: refundableCents,
      ...(parsed.connectedAccountId
        ? { refund_application_fee: true }
        : {}),
    },
    {
      idempotencyKey: stripeIdempotencyKey(
        "invalid-checkout-refund",
        data.idempotencyKey
      ),
      ...(accountOptions ?? {}),
    }
  );
  return {
    outcome: "refunded",
    refundId: refund.id,
    amountCents: refundableCents,
  };
}

/**
 * Parse a payments.external_id written by the checkout webhooks.
 * `stripe:checkout:<session>` is a platform charge (self-host / legacy);
 * `stripe:connect:<acct>:checkout:<session>` is a Connect destination charge.
 * Returns null for non-Stripe payments (cash, check, manual).
 */
export function parseStripeCheckoutExternalId(
  externalId: string | null | undefined
): { sessionId: string; connectedAccountId?: string } | null {
  if (!externalId) return null;
  const connect = externalId.match(/^stripe:connect:([^:]+):checkout:(.+)$/);
  if (connect) {
    return { connectedAccountId: connect[1]!, sessionId: connect[2]! };
  }
  const platform = externalId.match(/^stripe:checkout:(.+)$/);
  if (platform) {
    return { sessionId: platform[1]! };
  }
  return null;
}

/**
 * Refund a card payment recorded from a Checkout session. Throws on any
 * Stripe failure — a refund the staff believes happened must never silently
 * not happen. Returns null when the payment is not a Stripe payment.
 */
export async function refundStripeCheckoutPayment(data: {
  externalId: string | null | undefined;
  amountCents: number;
  /** Stable local refund identity, e.g. refund:payment:<payment UUID>. */
  idempotencyKey?: string;
}): Promise<{ refundId: string } | null> {
  const parsed = parseStripeCheckoutExternalId(data.externalId);
  if (!parsed) return null;
  if (!stripe) {
    throw new Error("Stripe is not configured; cannot refund a card payment.");
  }

  const accountOptions = parsed.connectedAccountId
    ? { stripeAccount: parsed.connectedAccountId }
    : undefined;
  const session = accountOptions
    ? await stripe.checkout.sessions.retrieve(
        parsed.sessionId,
        {},
        accountOptions
      )
    : await stripe.checkout.sessions.retrieve(parsed.sessionId);
  const paymentIntent =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : session.payment_intent?.id;
  if (!paymentIntent) {
    throw new Error(
      `Stripe Checkout session has no payment intent to refund: ${parsed.sessionId}`
    );
  }

  const params: Stripe.RefundCreateParams = {
    payment_intent: paymentIntent,
    amount: data.amountCents,
    // On Connect destination charges, return the platform fee too so the
    // clinic is never out of pocket for a refund.
    ...(parsed.connectedAccountId ? { refund_application_fee: true } : {}),
  };
  const refund = await stripe.refunds.create(params, {
    idempotencyKey: stripeIdempotencyKey(
      "refund",
      data.idempotencyKey ?? parsed.sessionId
    ),
    ...(parsed.connectedAccountId
      ? { stripeAccount: parsed.connectedAccountId }
      : {}),
  });

  return { refundId: refund.id };
}

export function buildInvoiceCheckoutSessionParams(data: {
  invoiceId: string;
  amount: number;
  clientEmail?: string | null;
  clientName: string;
  description: string;
  successUrl: string;
  cancelUrl: string;
  currency?: string;
  connectedAccountId?: string | null;
  applicationFeeAmount?: number;
}): Stripe.Checkout.SessionCreateParams {
  const metadata: Record<string, string> = {
    invoiceId: data.invoiceId,
    captureMode: INVOICE_CHECKOUT_CAPTURE_MODE,
    source: data.connectedAccountId
      ? "client_invoice_connect"
      : "client_invoice",
  };
  if (data.connectedAccountId) {
    metadata.stripeConnectAccountId = data.connectedAccountId;
  }
  const paymentIntentData: Stripe.Checkout.SessionCreateParams.PaymentIntentData = {
    metadata,
    capture_method: "manual",
  };
  if (data.applicationFeeAmount && data.applicationFeeAmount > 0) {
    paymentIntentData.application_fee_amount = data.applicationFeeAmount;
  }

  return {
    mode: "payment",
    integration_identifier: INVOICE_CHECKOUT_INTEGRATION_IDENTIFIER,
    customer_email: checkoutCustomerEmail(data.clientEmail),
    client_reference_id: data.invoiceId,
    line_items: [{
      price_data: {
        currency: (data.currency ?? "usd").toLowerCase(),
        product_data: { name: data.description },
        unit_amount: data.amount,
      },
      quantity: 1,
    }],
    metadata,
    payment_intent_data: paymentIntentData,
    success_url: data.successUrl,
    cancel_url: data.cancelUrl,
  };
}

export async function constructWebhookEvent(
  body: string,
  signature: string,
): Promise<Stripe.Event | null> {
  if (!stripe) return null;
  const endpointSecret = stripeWebhookSecret();
  if (!endpointSecret) return null;
  return stripe.webhooks.constructEvent(
    body,
    signature,
    endpointSecret,
  );
}

// ── Stripe Connect (clinic-owned client invoice payments) ─────────────────

export async function createConnectAccount(data: {
  practiceId: string;
  email?: string | null;
  country?: string | null;
  businessName?: string | null;
}): Promise<Stripe.Account | null> {
  if (!stripe) return null;

  return stripe.accounts.create(
    {
      // Controller-based account matching our completed platform profile:
      // Stripe carries negative-balance liability and ongoing compliance, the
      // clinic pays standard Stripe processing fees, and onboarding is
      // Stripe-hosted. The dashboard must be "full" — Stripe requires platform
      // fee-collection and loss liability for the Express dashboard, so under
      // this profile the clinic gets its own full Stripe Dashboard (which also
      // fits the promise that practices own their Stripe account outright).
      controller: {
        losses: { payments: "stripe" },
        fees: { payer: "account" },
        stripe_dashboard: { type: "full" },
        requirement_collection: "stripe",
      },
      country: (data.country ?? "US").toUpperCase(),
      email: checkoutCustomerEmail(data.email),
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      business_profile: data.businessName
        ? { name: data.businessName }
        : undefined,
      metadata: {
        practiceId: data.practiceId,
        source: "openvpm_client_payments",
      },
    },
    {
      idempotencyKey: stripeIdempotencyKey(
        "connect-account",
        data.practiceId
      ),
    }
  );
}

export async function retrieveConnectAccount(
  accountId: string
): Promise<Stripe.Account | null> {
  if (!stripe) return null;
  return stripe.accounts.retrieve(accountId);
}

export async function createConnectAccountLink(data: {
  accountId: string;
  refreshUrl: string;
  returnUrl: string;
}): Promise<{ url: string | null } | null> {
  if (!stripe) return null;
  const accountLink = await stripe.accountLinks.create({
    account: data.accountId,
    refresh_url: data.refreshUrl,
    return_url: data.returnUrl,
    type: "account_onboarding",
  });
  return { url: stripeCheckoutRedirectUrl(accountLink.url) };
}

export async function createConnectLoginLink(
  accountId: string
): Promise<{ url: string | null } | null> {
  if (!stripe) return null;
  const loginLink = await stripe.accounts.createLoginLink(accountId);
  return { url: stripeCheckoutRedirectUrl(loginLink.url) };
}

export async function constructConnectWebhookEvent(
  body: string,
  signature: string,
): Promise<Stripe.Event | null> {
  if (!stripe) return null;
  const endpointSecret = stripeConnectWebhookSecret();
  if (!endpointSecret) return null;
  return stripe.webhooks.constructEvent(
    body,
    signature,
    endpointSecret,
  );
}

// ── Hosted-SaaS subscriptions (separate surface from client invoicing) ──────

/**
 * Create a Checkout Session for a recurring plan subscription. The practiceId is
 * stamped on both the session and the subscription metadata so the webhook can
 * map the resulting subscription back to a practice.
 */
export async function createSubscriptionCheckoutSession(data: {
  lineItems: Array<{ priceId: string; quantity?: number; metered?: boolean }>;
  practiceId: string;
  customerId?: string | null;
  customerEmail?: string | null;
  successUrl: string;
  cancelUrl: string;
  trialEnd?: Date | string | null;
  trialPeriodDays?: number;
  billingCadence?: BillingCadence;
  source?: "signup" | "settings";
}): Promise<{ url: string | null } | null> {
  if (!stripe) {
    console.warn(
      "[Stripe] No API key configured; subscription checkout unavailable"
    );
    return null;
  }
  const params = buildSubscriptionCheckoutSessionParams(data);
  const session = await stripe.checkout.sessions.create(params, {
    idempotencyKey: stripeIdempotencyKey(
      "subscription-checkout",
      data.practiceId,
      params
    ),
  });
  return { url: stripeCheckoutRedirectUrl(session.url) };
}

export function buildSubscriptionCheckoutSessionParams(data: {
  lineItems: Array<{ priceId: string; quantity?: number; metered?: boolean }>;
  practiceId: string;
  customerId?: string | null;
  customerEmail?: string | null;
  successUrl: string;
  cancelUrl: string;
  trialEnd?: Date | string | null;
  trialPeriodDays?: number;
  billingCadence?: BillingCadence;
  source?: "signup" | "settings";
}): Stripe.Checkout.SessionCreateParams {
  const trialEnd = data.trialEnd
    ? Math.floor(new Date(data.trialEnd).getTime() / 1000)
    : undefined;
  const hasTrial = !!trialEnd || !!data.trialPeriodDays;
  const billingCadence = data.billingCadence ?? "month";
  const metadata = {
    practiceId: data.practiceId,
    billingCadence,
    source: data.source ?? "settings",
  };
  return {
    mode: "subscription",
    integration_identifier: SUBSCRIPTION_CHECKOUT_INTEGRATION_IDENTIFIER,
    // Keep the clinic subscription checkout to cards (including card wallets
    // such as Apple Pay and Link) and U.S. bank accounts. Stripe still chooses
    // the eligible methods dynamically; only the explicitly unwanted methods
    // are removed.
    excluded_payment_method_types: EXCLUDED_SUBSCRIPTION_PAYMENT_METHODS,
    // Hosted trials must collect a card up front so Stripe can charge
    // automatically at trial end instead of creating an uncollectible account.
    payment_method_collection: "always",
    // Metered prices (usage-based overage) must be added WITHOUT a quantity;
    // licensed prices (per-location) carry the active count.
    line_items: data.lineItems.map((item) =>
      item.metered
        ? { price: item.priceId }
        : { price: item.priceId, quantity: Math.max(0, item.quantity ?? 0) }
    ),
    ...(data.customerId
      ? { customer: data.customerId }
      : { customer_email: checkoutCustomerEmail(data.customerEmail) }),
    client_reference_id: data.practiceId,
    metadata,
    ...subscriptionTaxCheckoutParams(data.customerId),
    subscription_data: {
      description: `OpenVPM Cloud — ${
        billingCadence === "year" ? "annual" : "monthly"
      }`,
      metadata,
      ...(hasTrial
        ? {
            trial_settings: {
              end_behavior: { missing_payment_method: "cancel" },
            },
          }
        : {}),
      ...(trialEnd
        ? { trial_end: trialEnd }
        : data.trialPeriodDays
          ? { trial_period_days: data.trialPeriodDays }
          : {}),
    },
    success_url: data.successUrl,
    cancel_url: data.cancelUrl,
  };
}

function subscriptionTaxCheckoutParams(
  customerId?: string | null
): Partial<Stripe.Checkout.SessionCreateParams> {
  if (!envFlagEnabled(STRIPE_TAX_ENABLED_ENV)) {
    return {};
  }

  return {
    automatic_tax: { enabled: true },
    tax_id_collection: { enabled: true, required: "if_supported" },
    ...(customerId
      ? { customer_update: { address: "auto", name: "auto" } }
      : {}),
  };
}

/** Create a Stripe Billing Portal session so a practice can manage its plan. */
export async function createBillingPortalSession(data: {
  customerId: string;
  returnUrl: string;
}): Promise<{ url: string | null } | null> {
  if (!stripe) return null;
  const session = await stripe.billingPortal.sessions.create({
    customer: data.customerId,
    return_url: data.returnUrl,
  });
  return { url: stripeCheckoutRedirectUrl(session.url) };
}

/** Verify a subscription-webhook signature using its dedicated endpoint secret. */
export async function constructSubscriptionWebhookEvent(
  body: string,
  signature: string,
): Promise<Stripe.Event | null> {
  if (!stripe) return null;
  const endpointSecret = stripeSubscriptionWebhookSecret();
  if (!endpointSecret) return null;
  return stripe.webhooks.constructEvent(
    body,
    signature,
    endpointSecret,
  );
}

export { stripe };

function stripeCheckoutRedirectUrl(value: unknown): string | null {
  return isSafeCheckoutRedirectUrl(value) ? value : null;
}

function checkoutCustomerEmail(email: string | null | undefined): string | undefined {
  const normalized = email?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}
