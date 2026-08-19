import Stripe from "stripe";
import { createHash } from "node:crypto";
import { isSafeCheckoutRedirectUrl } from "@/lib/checkout-redirect";
import {
  stripeBillingPortalConfigurationId,
  stripeConnectV2WebhookSecret,
  stripeConnectWebhookSecret,
  stripeExpectedAccountId,
  stripeRuntimeModeCheck,
  stripeSecretKey,
  stripeSubscriptionPaymentMethodConfigurationId,
  stripeSubscriptionWebhookSecret,
  stripeWebhookSecret,
} from "@/lib/stripe-config";
import { envFlagEnabled } from "@/lib/env-bool";
import type { BillingCadence } from "@/lib/billing/catalog";

export const STRIPE_TAX_ENABLED_ENV = "STRIPE_TAX_ENABLED";
export const STRIPE_CONNECT_V2_ENABLED_ENV = "STRIPE_CONNECT_V2_ENABLED";
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
  params?: unknown,
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
const STRIPE_ACCOUNT_IDENTITY_CACHE_MS = 5 * 60 * 1000;
let stripeAccountVerifiedAt = 0;
let stripeAccountVerificationPromise: Promise<void> | null = null;

type StripeAccountIdentityFailure =
  | "unconfigured"
  | "unsafe_mode"
  | "mismatch"
  | "failed";

class StripeAccountIdentityError extends Error {
  constructor(readonly failure: StripeAccountIdentityFailure) {
    super(`Stripe account identity ${failure}.`);
    this.name = "StripeAccountIdentityError";
  }
}

export interface StripeAccountIdentityCheck {
  ok: boolean;
  detail: string;
}

/**
 * Fail closed before any Stripe mutation unless the credential is proven to
 * belong to the account explicitly configured for this deployment. Successful
 * checks are cached briefly to avoid adding an account lookup to every request.
 */
export async function requireVerifiedStripeAccount(): Promise<Stripe> {
  const expectedAccountId = stripeExpectedAccountId();
  if (!stripe || !expectedAccountId) {
    throw new StripeAccountIdentityError("unconfigured");
  }
  if (!stripeRuntimeModeCheck().ok) {
    throw new StripeAccountIdentityError("unsafe_mode");
  }

  if (Date.now() - stripeAccountVerifiedAt < STRIPE_ACCOUNT_IDENTITY_CACHE_MS) {
    return stripe;
  }

  if (!stripeAccountVerificationPromise) {
    stripeAccountVerificationPromise = (async () => {
      const account = await stripe.accounts.retrieveCurrent();
      if (account.id !== expectedAccountId) {
        throw new StripeAccountIdentityError("mismatch");
      }
      stripeAccountVerifiedAt = Date.now();
    })().finally(() => {
      stripeAccountVerificationPromise = null;
    });
  }

  try {
    await stripeAccountVerificationPromise;
  } catch (error) {
    if (error instanceof StripeAccountIdentityError) throw error;
    throw new StripeAccountIdentityError("failed");
  }
  return stripe;
}

/**
 * Verify that the configured credential belongs to the explicitly expected
 * platform account. The public health endpoint intentionally returns only a
 * bounded result, never either account identifier.
 */
export async function verifyStripeAccountIdentity(): Promise<StripeAccountIdentityCheck> {
  try {
    await requireVerifiedStripeAccount();
    const runtime = stripeRuntimeModeCheck();
    return {
      ok: true,
      detail: runtime.deployment
        ? `Stripe ${runtime.mode}-mode account identity verified`
        : "Stripe account identity verified",
    };
  } catch (error) {
    const failure =
      error instanceof StripeAccountIdentityError ? error.failure : "failed";
    return {
      ok: false,
      detail:
        failure === "unconfigured"
          ? "Stripe account identity is not fully configured"
          : failure === "unsafe_mode"
            ? "Stripe credential mode does not match this deployment"
          : failure === "mismatch"
            ? "Stripe account identity does not match"
            : "Stripe account identity verification failed",
    };
  }
}

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
    console.warn(
      "[Stripe] No API key configured; checkout session unavailable",
    );
    return null;
  }
  await requireVerifiedStripeAccount();
  const params = buildInvoiceCheckoutSessionParams(data);
  const session = await stripe.checkout.sessions.create(params, {
    idempotencyKey: stripeIdempotencyKey(
      "invoice-checkout",
      data.invoiceId,
      params,
    ),
    ...(data.connectedAccountId
      ? { stripeAccount: data.connectedAccountId }
      : {}),
  });
  return { url: stripeCheckoutRedirectUrl(session.url) };
}

function checkoutAccountOptions(connectedAccountId?: string) {
  return connectedAccountId ? { stripeAccount: connectedAccountId } : undefined;
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
  expectedApplicationFeeAmount?: number;
}): Promise<{
  amountCapturedCents: number;
  applicationFeeAmountCents: number;
}> {
  if (!stripe) {
    throw new Error("Stripe is not configured; cannot capture card payment.");
  }
  await requireVerifiedStripeAccount();
  if (!Number.isInteger(data.amountCents) || data.amountCents <= 0) {
    throw new Error("Stripe capture amount must be a positive integer.");
  }

  const accountOptions = checkoutAccountOptions(data.connectedAccountId);
  const current = accountOptions
    ? await stripe.paymentIntents.retrieve(
        data.paymentIntentId,
        {},
        accountOptions,
      )
    : await stripe.paymentIntents.retrieve(data.paymentIntentId);

  const originalApplicationFee = data.expectedApplicationFeeAmount ?? 0;
  if (
    data.connectedAccountId &&
    (!Number.isInteger(data.expectedApplicationFeeAmount) ||
      originalApplicationFee <= 0)
  ) {
    throw new Error(
      "Stripe Connect authorization does not contain the expected OpenVPM application fee.",
    );
  }

  const applicationFeeForAmount = (capturedAmount: number) =>
    data.connectedAccountId &&
    originalApplicationFee > 0 &&
    current.amount > 0 &&
    capturedAmount > 1
      ? Math.min(
          Math.floor((originalApplicationFee * capturedAmount) / current.amount),
          capturedAmount - 1,
        )
      : 0;

  // A transaction may fail after Stripe accepted the capture. On retry, use
  // Stripe's authoritative captured amount instead of attempting a new charge.
  if (current.status === "succeeded") {
    const capturedApplicationFee = current.application_fee_amount ?? 0;
    if (
      data.connectedAccountId &&
      capturedApplicationFee !== applicationFeeForAmount(current.amount_received)
    ) {
      throw new Error(
        "Stripe Connect capture does not contain the expected proportional OpenVPM application fee.",
      );
    }
    return {
      amountCapturedCents: current.amount_received,
      applicationFeeAmountCents: capturedApplicationFee,
    };
  }
  if (current.status !== "requires_capture") {
    throw new Error(
      `Stripe Checkout authorization is not capturable: ${current.status}`,
    );
  }

  const amountToCapture = Math.min(data.amountCents, current.amount_capturable);
  if (amountToCapture <= 0) {
    throw new Error("Stripe Checkout authorization has no capturable amount.");
  }
  if (
    data.connectedAccountId &&
    current.application_fee_amount !== originalApplicationFee
  ) {
    throw new Error(
      "Stripe Connect authorization does not contain the expected OpenVPM application fee.",
    );
  }
  const proportionalApplicationFee = applicationFeeForAmount(amountToCapture);
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
        captureParams,
      ),
      ...(accountOptions ?? {}),
    },
  );
  const capturedApplicationFee = captured.application_fee_amount ?? 0;
  if (
    data.connectedAccountId &&
    capturedApplicationFee !== proportionalApplicationFee
  ) {
    throw new Error(
      "Stripe Connect capture did not preserve the expected proportional OpenVPM application fee.",
    );
  }
  return {
    amountCapturedCents: captured.amount_received,
    applicationFeeAmountCents: capturedApplicationFee,
  };
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
  await requireVerifiedStripeAccount();

  const accountOptions = checkoutAccountOptions(parsed.connectedAccountId);
  const session = accountOptions
    ? await stripe.checkout.sessions.retrieve(
        parsed.sessionId,
        {},
        accountOptions,
      )
    : await stripe.checkout.sessions.retrieve(parsed.sessionId);
  const paymentIntentId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : session.payment_intent?.id;
  if (!paymentIntentId) {
    throw new Error(
      `Stripe Checkout session has no payment intent: ${parsed.sessionId}`,
    );
  }
  const paymentIntent =
    typeof session.payment_intent === "object" && session.payment_intent
      ? session.payment_intent
      : accountOptions
        ? await stripe.paymentIntents.retrieve(
            paymentIntentId,
            {},
            accountOptions,
          )
        : await stripe.paymentIntents.retrieve(paymentIntentId);

  if (paymentIntent.status === "requires_capture") {
    await stripe.paymentIntents.cancel(
      paymentIntentId,
      { cancellation_reason: "abandoned" },
      {
        idempotencyKey: stripeIdempotencyKey(
          "invalid-checkout-cancel",
          data.idempotencyKey,
        ),
        ...(accountOptions ?? {}),
      },
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
      `Stripe Checkout payment is not ready to resolve: ${paymentIntent.status}`,
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
      ...(parsed.connectedAccountId ? { refund_application_fee: true } : {}),
    },
    {
      idempotencyKey: stripeIdempotencyKey(
        "invalid-checkout-refund",
        data.idempotencyKey,
      ),
      ...(accountOptions ?? {}),
    },
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
 * `stripe:connect:<acct>:checkout:<session>` is a Connect direct charge.
 * Returns null for non-Stripe payments (cash, check, manual).
 */
export function parseStripeCheckoutExternalId(
  externalId: string | null | undefined,
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

export interface StripeCheckoutSettlementEvidence {
  connectedAccountId: string;
  checkoutSessionId: string;
  paymentIntentId: string;
  chargeId: string;
  balanceTransactionId: string;
  currency: string;
  grossAmountCents: number;
  processorFeeCents: number;
  applicationFeeCents: number;
  clinicNetCents: number;
  balanceStatus: "pending" | "available";
  availableOn: Date | null;
}

/**
 * Read Stripe's authoritative balance transaction for a Connect direct charge.
 * The returned identity is persisted with the local payment so a clinic can
 * prove gross = Stripe fee + OpenVPM fee + clinic proceeds.
 */
export async function retrieveStripeCheckoutSettlement(data: {
  connectedAccountId: string;
  checkoutSessionId: string;
  paymentIntentId: string;
  expectedGrossCents: number;
  expectedApplicationFeeCents: number;
}): Promise<StripeCheckoutSettlementEvidence> {
  if (!stripe) {
    throw new Error("Stripe is not configured; cannot reconcile settlement.");
  }
  await requireVerifiedStripeAccount();
  const accountOptions = { stripeAccount: data.connectedAccountId };
  const paymentIntent = await stripe.paymentIntents.retrieve(
    data.paymentIntentId,
    { expand: ["latest_charge.balance_transaction"] },
    accountOptions,
  );
  if (
    paymentIntent.status !== "succeeded" ||
    paymentIntent.amount_received !== data.expectedGrossCents
  ) {
    throw new Error("Stripe settlement gross does not match captured payment.");
  }
  if (
    paymentIntent.application_fee_amount !==
    data.expectedApplicationFeeCents
  ) {
    throw new Error("Stripe settlement application fee does not match policy.");
  }

  let charge =
    typeof paymentIntent.latest_charge === "object"
      ? paymentIntent.latest_charge
      : null;
  const chargeId =
    typeof paymentIntent.latest_charge === "string"
      ? paymentIntent.latest_charge
      : paymentIntent.latest_charge?.id;
  if (!chargeId) {
    throw new Error("Stripe settlement is missing its charge identity.");
  }
  if (!charge || "deleted" in charge) {
    charge = await stripe.charges.retrieve(
      chargeId,
      { expand: ["balance_transaction"] },
      accountOptions,
    );
  }
  if ("deleted" in charge) {
    throw new Error("Stripe settlement charge was deleted.");
  }

  let balanceTransaction =
    typeof charge.balance_transaction === "object"
      ? charge.balance_transaction
      : null;
  const balanceTransactionId =
    typeof charge.balance_transaction === "string"
      ? charge.balance_transaction
      : charge.balance_transaction?.id;
  if (!balanceTransactionId) {
    throw new Error("Stripe settlement is missing its balance transaction.");
  }
  if (!balanceTransaction) {
    balanceTransaction = await stripe.balanceTransactions.retrieve(
      balanceTransactionId,
      {},
      accountOptions,
    );
  }

  const applicationFeeCents = data.expectedApplicationFeeCents;
  const processorFeeCents = balanceTransaction.fee - applicationFeeCents;
  const clinicNetCents = balanceTransaction.net;
  const currency = balanceTransaction.currency.toLowerCase();
  if (
    balanceTransaction.amount !== data.expectedGrossCents ||
    processorFeeCents < 0 ||
    clinicNetCents < 0 ||
    balanceTransaction.amount !==
      processorFeeCents + applicationFeeCents + clinicNetCents ||
    !/^[a-z]{3}$/.test(currency) ||
    (balanceTransaction.status !== "pending" &&
      balanceTransaction.status !== "available")
  ) {
    throw new Error("Stripe settlement balance identity is inconsistent.");
  }

  return {
    connectedAccountId: data.connectedAccountId,
    checkoutSessionId: data.checkoutSessionId,
    paymentIntentId: paymentIntent.id,
    chargeId,
    balanceTransactionId,
    currency,
    grossAmountCents: balanceTransaction.amount,
    processorFeeCents,
    applicationFeeCents,
    clinicNetCents,
    balanceStatus: balanceTransaction.status,
    availableOn: Number.isInteger(balanceTransaction.available_on)
      ? new Date(balanceTransaction.available_on * 1000)
      : null,
  };
}

/**
 * Refund a card payment recorded from a Checkout session. Throws on any
 * Stripe failure — a refund the staff believes happened must never silently
 * not happen. Returns null when the payment is not a Stripe payment.
 */
export interface StripeRefundEvidence {
  refundId: string;
  connectedAccountId?: string;
  amountCents: number;
  currency: string;
  status: "pending" | "requires_action" | "succeeded" | "failed" | "canceled";
  balanceTransactionId: string | null;
  balanceAmountCents: number | null;
  balanceFeeCents: number | null;
  balanceNetCents: number | null;
  providerCreatedAt: Date;
}

async function normalizeStripeRefundEvidence(
  refund: Stripe.Refund,
  accountOptions: Stripe.RequestOptions | undefined,
  connectedAccountId?: string,
  expectedAmountCents?: number,
): Promise<StripeRefundEvidence> {
  const allowedStatuses = new Set<StripeRefundEvidence["status"]>([
    "pending",
    "requires_action",
    "succeeded",
    "failed",
    "canceled",
  ]);
  if (
    (expectedAmountCents !== undefined &&
      refund.amount !== expectedAmountCents) ||
    !/^[a-z]{3}$/.test(refund.currency.toLowerCase()) ||
    !refund.status ||
    !allowedStatuses.has(refund.status as StripeRefundEvidence["status"]) ||
    !Number.isInteger(refund.created)
  ) {
    throw new Error("Stripe refund evidence is incomplete or inconsistent.");
  }
  let balanceTransaction =
    typeof refund.balance_transaction === "object"
      ? refund.balance_transaction
      : null;
  const balanceTransactionId =
    typeof refund.balance_transaction === "string"
      ? refund.balance_transaction
      : refund.balance_transaction?.id ?? null;
  if (balanceTransactionId && !balanceTransaction) {
    balanceTransaction = await stripe!.balanceTransactions.retrieve(
      balanceTransactionId,
      {},
      accountOptions,
    );
  }
  if (
    balanceTransaction &&
    (balanceTransaction.amount !== -refund.amount ||
      balanceTransaction.net !==
        balanceTransaction.amount - balanceTransaction.fee)
  ) {
    throw new Error("Stripe refund balance identity is inconsistent.");
  }

  return {
    refundId: refund.id,
    ...(connectedAccountId ? { connectedAccountId } : {}),
    amountCents: refund.amount,
    currency: refund.currency.toLowerCase(),
    status: refund.status as StripeRefundEvidence["status"],
    balanceTransactionId,
    balanceAmountCents: balanceTransaction?.amount ?? null,
    balanceFeeCents: balanceTransaction?.fee ?? null,
    balanceNetCents: balanceTransaction?.net ?? null,
    providerCreatedAt: new Date(refund.created * 1000),
  };
}

export async function refundStripeCheckoutPayment(data: {
  externalId: string | null | undefined;
  amountCents: number;
  /** Stable local refund identity, e.g. refund:payment:<payment UUID>. */
  idempotencyKey?: string;
}): Promise<StripeRefundEvidence | null> {
  const parsed = parseStripeCheckoutExternalId(data.externalId);
  if (!parsed) return null;
  if (!stripe) {
    throw new Error("Stripe is not configured; cannot refund a card payment.");
  }
  await requireVerifiedStripeAccount();

  const accountOptions = parsed.connectedAccountId
    ? { stripeAccount: parsed.connectedAccountId }
    : undefined;
  const session = accountOptions
    ? await stripe.checkout.sessions.retrieve(
        parsed.sessionId,
        {},
        accountOptions,
      )
    : await stripe.checkout.sessions.retrieve(parsed.sessionId);
  const paymentIntent =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : session.payment_intent?.id;
  if (!paymentIntent) {
    throw new Error(
      `Stripe Checkout session has no payment intent to refund: ${parsed.sessionId}`,
    );
  }

  const params: Stripe.RefundCreateParams = {
    payment_intent: paymentIntent,
    amount: data.amountCents,
    expand: ["balance_transaction"],
    // On Connect direct charges, return the platform fee too so the clinic is
    // never out of pocket for an OpenVPM fee after refunding its client.
    ...(parsed.connectedAccountId ? { refund_application_fee: true } : {}),
  };
  const refund = await stripe.refunds.create(params, {
    idempotencyKey: stripeIdempotencyKey(
      "refund",
      data.idempotencyKey ?? parsed.sessionId,
    ),
    ...(parsed.connectedAccountId
      ? { stripeAccount: parsed.connectedAccountId }
      : {}),
  });
  return normalizeStripeRefundEvidence(
    refund,
    accountOptions,
    parsed.connectedAccountId,
    data.amountCents,
  );
}

/** Refresh an existing connected-account refund after a Stripe lifecycle event. */
export async function retrieveStripeRefundEvidence(data: {
  connectedAccountId: string;
  refundId: string;
}): Promise<StripeRefundEvidence> {
  if (!stripe) {
    throw new Error("Stripe is not configured; cannot reconcile refund.");
  }
  await requireVerifiedStripeAccount();
  const accountOptions = { stripeAccount: data.connectedAccountId };
  const refund = await stripe.refunds.retrieve(
    data.refundId,
    { expand: ["balance_transaction"] },
    accountOptions,
  );
  return normalizeStripeRefundEvidence(
    refund,
    accountOptions,
    data.connectedAccountId,
  );
}

export interface StripePayoutReconciliationEvidence {
  connectedAccountId: string;
  payoutId: string;
  currency: string;
  amountCents: number;
  status: "pending" | "in_transit" | "paid" | "failed" | "canceled";
  automatic: boolean;
  reconciliationComplete: boolean;
  balanceTransactionIds: string[];
  arrivalAt: Date;
  providerCreatedAt: Date;
  failureCode: string | null;
  failureMessage: string | null;
}

/**
 * Retrieve a connected account payout plus the exact balance transactions
 * assigned to it. Mapping is exposed only after Stripe marks reconciliation
 * complete; pending mappings are never guessed from dates or amounts.
 */
export async function retrieveStripePayoutReconciliation(data: {
  connectedAccountId: string;
  payoutId: string;
}): Promise<StripePayoutReconciliationEvidence> {
  if (!stripe) {
    throw new Error("Stripe is not configured; cannot reconcile payout.");
  }
  await requireVerifiedStripeAccount();
  const accountOptions = { stripeAccount: data.connectedAccountId };
  const payout = await stripe.payouts.retrieve(data.payoutId, {}, accountOptions);
  const allowedStatuses = new Set<
    StripePayoutReconciliationEvidence["status"]
  >(["pending", "in_transit", "paid", "failed", "canceled"]);
  const currency = payout.currency.toLowerCase();
  if (
    payout.amount <= 0 ||
    !Number.isInteger(payout.amount) ||
    !allowedStatuses.has(
      payout.status as StripePayoutReconciliationEvidence["status"],
    ) ||
    !/^[a-z]{3}$/.test(currency) ||
    !Number.isInteger(payout.arrival_date) ||
    !Number.isInteger(payout.created)
  ) {
    throw new Error("Stripe payout evidence is incomplete or inconsistent.");
  }

  const reconciliationComplete = payout.reconciliation_status === "completed";
  const balanceTransactionIds: string[] = [];
  if (reconciliationComplete) {
    for await (const transaction of stripe.balanceTransactions.list(
      { payout: payout.id, limit: 100 },
      accountOptions,
    )) {
      balanceTransactionIds.push(transaction.id);
    }
  }

  return {
    connectedAccountId: data.connectedAccountId,
    payoutId: payout.id,
    currency,
    amountCents: payout.amount,
    status: payout.status as StripePayoutReconciliationEvidence["status"],
    automatic: payout.automatic,
    reconciliationComplete,
    balanceTransactionIds,
    arrivalAt: new Date(payout.arrival_date * 1000),
    providerCreatedAt: new Date(payout.created * 1000),
    failureCode: payout.failure_code ?? null,
    failureMessage: payout.failure_message ?? null,
  };
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
  const paymentIntentData: Stripe.Checkout.SessionCreateParams.PaymentIntentData =
    {
      metadata,
      capture_method: "manual",
    };
  if (data.applicationFeeAmount && data.applicationFeeAmount > 0) {
    metadata.openvpmApplicationFeeAmount = String(data.applicationFeeAmount);
    paymentIntentData.application_fee_amount = data.applicationFeeAmount;
  }

  return {
    mode: "payment",
    integration_identifier: INVOICE_CHECKOUT_INTEGRATION_IDENTIFIER,
    customer_email: checkoutCustomerEmail(data.clientEmail),
    client_reference_id: data.invoiceId,
    line_items: [
      {
        price_data: {
          currency: (data.currency ?? "usd").toLowerCase(),
          product_data: { name: data.description },
          unit_amount: data.amount,
        },
        quantity: 1,
      },
    ],
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
  return stripe.webhooks.constructEvent(body, signature, endpointSecret);
}

// ── Stripe Connect (clinic-owned client invoice payments) ─────────────────

export async function createConnectAccount(data: {
  practiceId: string;
  email?: string | null;
  country?: string | null;
  businessName?: string | null;
}): Promise<Stripe.V2.Core.Account | null> {
  if (!stripe || !envFlagEnabled(STRIPE_CONNECT_V2_ENABLED_ENV)) return null;
  await requireVerifiedStripeAccount();

  return stripe.v2.core.accounts.create(
    {
      contact_email: checkoutCustomerEmail(data.email),
      display_name: data.businessName ?? undefined,
      dashboard: "full",
      identity: {
        country: (data.country ?? "US").toLowerCase(),
      },
      configuration: {
        merchant: {
          capabilities: {
            card_payments: { requested: true },
          },
        },
      },
      defaults: {
        currency: "usd",
        locales: ["en-US"],
        responsibilities: {
          fees_collector: "stripe",
          losses_collector: "stripe",
        },
        profile: {
          product_description: "Veterinary clinic client invoice payments",
        },
      },
      include: ["configuration.merchant", "identity", "requirements"],
      metadata: {
        practiceId: data.practiceId,
        source: "openvpm_client_payments",
      },
    },
    {
      idempotencyKey: stripeIdempotencyKey("connect-account", data.practiceId),
    },
  );
}

export async function retrieveConnectAccount(
  accountId: string,
): Promise<Stripe.V2.Core.Account | null> {
  if (!stripe) return null;
  await requireVerifiedStripeAccount();
  return stripe.v2.core.accounts.retrieve(accountId, {
    include: ["configuration.merchant", "identity", "requirements"],
  });
}

/** Stripe v1 returns resource_missing and v2 returns not_found for accounts outside this platform. */
export function isMissingStripeConnectedAccountError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: unknown;
    statusCode?: unknown;
    raw?: { code?: unknown; statusCode?: unknown };
  };
  const code = candidate.code ?? candidate.raw?.code;
  const statusCode = candidate.statusCode ?? candidate.raw?.statusCode;
  return (
    (code === "resource_missing" || code === "not_found") &&
    (statusCode == null || statusCode === 404)
  );
}

export async function createConnectAccountLink(data: {
  accountId: string;
  refreshUrl: string;
  returnUrl: string;
}): Promise<{ url: string | null } | null> {
  if (!stripe || !envFlagEnabled(STRIPE_CONNECT_V2_ENABLED_ENV)) return null;
  await requireVerifiedStripeAccount();
  const accountLink = await stripe.v2.core.accountLinks.create({
    account: data.accountId,
    use_case: {
      type: "account_onboarding",
      account_onboarding: {
        configurations: ["merchant"],
        collection_options: {
          fields: "eventually_due",
          future_requirements: "include",
        },
        refresh_url: data.refreshUrl,
        return_url: data.returnUrl,
      },
    },
  });
  return { url: stripeCheckoutRedirectUrl(accountLink.url) };
}

export async function createConnectLoginLink(
  accountId: string,
): Promise<{ url: string | null } | null> {
  if (!stripe) return null;
  await requireVerifiedStripeAccount();
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
  return stripe.webhooks.constructEvent(body, signature, endpointSecret);
}

export async function constructConnectV2EventNotification(
  body: string,
  signature: string,
): Promise<Stripe.V2.Core.EventNotification | null> {
  if (!stripe) return null;
  const endpointSecret = stripeConnectV2WebhookSecret();
  if (!endpointSecret) return null;
  await requireVerifiedStripeAccount();
  return stripe.parseEventNotification(body, signature, endpointSecret);
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
      "[Stripe] No API key configured; subscription checkout unavailable",
    );
    return null;
  }
  await requireVerifiedStripeAccount();
  const params = buildSubscriptionCheckoutSessionParams(data);
  const session = await stripe.checkout.sessions.create(params, {
    idempotencyKey: stripeIdempotencyKey(
      "subscription-checkout",
      data.practiceId,
      params,
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
  const paymentMethodConfiguration =
    stripeSubscriptionPaymentMethodConfigurationId();
  return {
    mode: "subscription",
    integration_identifier: SUBSCRIPTION_CHECKOUT_INTEGRATION_IDENTIFIER,
    ...(paymentMethodConfiguration
      ? { payment_method_configuration: paymentMethodConfiguration }
      : {}),
    // The pinned Payment Method Configuration is the durable card + ACH policy.
    // These exclusions remain as defense in depth while Stripe dynamically
    // ranks the eligible methods inside that configuration.
    excluded_payment_method_types: EXCLUDED_SUBSCRIPTION_PAYMENT_METHODS,
    // Hosted trials must collect a payment method up front so Stripe can charge
    // automatically at trial end instead of creating an uncollectible account.
    payment_method_collection: "always",
    // Metered prices (usage-based overage) must be added WITHOUT a quantity;
    // licensed prices (per-location) carry the active count.
    line_items: data.lineItems.map((item) =>
      item.metered
        ? { price: item.priceId }
        : { price: item.priceId, quantity: Math.max(0, item.quantity ?? 0) },
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
  customerId?: string | null,
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
  await requireVerifiedStripeAccount();
  const configuration = stripeBillingPortalConfigurationId();
  const session = await stripe.billingPortal.sessions.create({
    customer: data.customerId,
    return_url: data.returnUrl,
    ...(configuration ? { configuration } : {}),
  });
  return { url: stripeCheckoutRedirectUrl(session.url) };
}

export interface SubscriptionCadenceSnapshot {
  currentCadence: BillingCadence | null;
  scheduledCadence: BillingCadence | null;
  effectiveAt: string | null;
}

const OPENVPM_ANNUAL_CHANGE = "monthly_to_annual_at_renewal";

function stripeResourceId(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (
    value &&
    typeof value === "object" &&
    "id" in value &&
    typeof (value as { id?: unknown }).id === "string"
  ) {
    return (value as { id: string }).id;
  }
  return null;
}

function annualPhaseForSchedule(
  schedule: Stripe.SubscriptionSchedule,
  practiceId: string,
  annualPriceId: string,
): Stripe.SubscriptionSchedule.Phase | null {
  if (
    schedule.metadata?.practiceId !== practiceId ||
    schedule.metadata?.openvpmCadenceChange !== OPENVPM_ANNUAL_CHANGE
  ) {
    return null;
  }

  return (
    schedule.phases.find((phase) =>
      phase.items.some(
        (item) => stripeResourceId(item.price) === annualPriceId,
      ),
    ) ?? null
  );
}

function schedulePhaseToUpdateParams(
  phase: Stripe.SubscriptionSchedule.Phase,
): Stripe.SubscriptionScheduleUpdateParams.Phase {
  if (
    phase.add_invoice_items.length > 0 ||
    phase.application_fee_percent !== null ||
    phase.billing_thresholds !== null ||
    phase.discounts.length > 0 ||
    phase.on_behalf_of !== null ||
    phase.transfer_data !== null ||
    phase.items.some(
      (item) => item.billing_thresholds !== null || item.discounts.length > 0,
    )
  ) {
    throw new Error(
      "This subscription has custom Stripe billing rules. Contact OpenVPM support before changing its schedule.",
    );
  }

  const items = phase.items.map((item) => {
    const price = stripeResourceId(item.price);
    if (!price) {
      throw new Error("Stripe returned a subscription item without a price.");
    }
    const taxRates = item.tax_rates
      ?.map(stripeResourceId)
      .filter((id): id is string => !!id);
    return {
      price,
      ...(item.quantity !== undefined ? { quantity: item.quantity } : {}),
      ...(item.metadata ? { metadata: item.metadata } : {}),
      ...(taxRates?.length ? { tax_rates: taxRates } : {}),
    };
  });
  const defaultTaxRates = phase.default_tax_rates
    ?.map(stripeResourceId)
    .filter((id): id is string => !!id);
  const paymentMethod = stripeResourceId(phase.default_payment_method);
  const automaticTax = phase.automatic_tax
    ? {
        enabled: phase.automatic_tax.enabled,
        ...(phase.automatic_tax.liability
          ? {
              liability: {
                type: phase.automatic_tax.liability.type,
                ...(stripeResourceId(phase.automatic_tax.liability.account)
                  ? {
                      account: stripeResourceId(
                        phase.automatic_tax.liability.account,
                      )!,
                    }
                  : {}),
              },
            }
          : {}),
      }
    : undefined;
  const invoiceSettings = phase.invoice_settings
    ? {
        ...(phase.invoice_settings.account_tax_ids
          ? {
              account_tax_ids: phase.invoice_settings.account_tax_ids
                .map(stripeResourceId)
                .filter((id): id is string => !!id),
            }
          : {}),
        ...(phase.invoice_settings.custom_fields
          ? { custom_fields: phase.invoice_settings.custom_fields }
          : {}),
        ...(phase.invoice_settings.days_until_due !== null
          ? { days_until_due: phase.invoice_settings.days_until_due }
          : {}),
        ...(phase.invoice_settings.description !== null
          ? { description: phase.invoice_settings.description }
          : {}),
        ...(phase.invoice_settings.footer !== null
          ? { footer: phase.invoice_settings.footer }
          : {}),
        ...(phase.invoice_settings.issuer
          ? {
              issuer: {
                type: phase.invoice_settings.issuer.type,
                ...(stripeResourceId(phase.invoice_settings.issuer.account)
                  ? {
                      account: stripeResourceId(
                        phase.invoice_settings.issuer.account,
                      )!,
                    }
                  : {}),
              },
            }
          : {}),
      }
    : undefined;

  return {
    items,
    start_date: phase.start_date,
    end_date: phase.end_date,
    ...(automaticTax ? { automatic_tax: automaticTax } : {}),
    ...(phase.billing_cycle_anchor
      ? { billing_cycle_anchor: phase.billing_cycle_anchor }
      : {}),
    ...(phase.collection_method
      ? { collection_method: phase.collection_method }
      : {}),
    ...(phase.currency ? { currency: phase.currency } : {}),
    ...(paymentMethod ? { default_payment_method: paymentMethod } : {}),
    ...(defaultTaxRates?.length
      ? { default_tax_rates: defaultTaxRates }
      : {}),
    ...(phase.description !== null ? { description: phase.description } : {}),
    ...(invoiceSettings ? { invoice_settings: invoiceSettings } : {}),
    ...(phase.metadata ? { metadata: phase.metadata } : {}),
    proration_behavior: "none",
    ...(phase.trial ? { trial: true } : {}),
    ...(phase.trial_end !== null ? { trial_end: phase.trial_end } : {}),
  };
}

async function retrieveVerifiedSubscription(data: {
  subscriptionId: string;
  customerId: string;
  practiceId: string;
}): Promise<Stripe.Subscription> {
  const stripeClient = await requireVerifiedStripeAccount();
  const subscription = await stripeClient.subscriptions.retrieve(
    data.subscriptionId,
  );
  if (
    stripeResourceId(subscription.customer) !== data.customerId ||
    subscription.metadata.practiceId !== data.practiceId
  ) {
    throw new Error(
      "The Stripe subscription does not belong to this clinic. No billing change was made.",
    );
  }
  return subscription;
}

/** Provider-truth cadence state for the clinic's existing hosted subscription. */
export async function readSubscriptionCadenceSnapshot(data: {
  subscriptionId: string;
  customerId: string;
  practiceId: string;
  monthlyPriceId?: string;
  annualPriceId?: string;
}): Promise<SubscriptionCadenceSnapshot> {
  const subscription = await retrieveVerifiedSubscription(data);
  const currentCadence = subscription.items.data.some(
    (item) => item.price.id === data.annualPriceId,
  )
    ? "year"
    : subscription.items.data.some(
          (item) => item.price.id === data.monthlyPriceId,
        )
      ? "month"
      : null;
  const scheduleId = stripeResourceId(subscription.schedule);
  if (!scheduleId || !data.annualPriceId) {
    return { currentCadence, scheduledCadence: null, effectiveAt: null };
  }
  const stripeClient = await requireVerifiedStripeAccount();
  const schedule = await stripeClient.subscriptionSchedules.retrieve(scheduleId);
  const annualPhase = annualPhaseForSchedule(
    schedule,
    data.practiceId,
    data.annualPriceId,
  );
  return {
    currentCadence,
    scheduledCadence: annualPhase ? "year" : null,
    effectiveAt: annualPhase
      ? new Date(annualPhase.start_date * 1000).toISOString()
      : null,
  };
}

/**
 * Move an ordinary OpenVPM monthly subscription to annual at its next renewal.
 * Stripe Subscription Schedules avoid an immediate interval-change invoice.
 */
export async function scheduleSubscriptionAnnualAtRenewal(data: {
  subscriptionId: string;
  customerId: string;
  practiceId: string;
  monthlyPriceId: string;
  annualPriceId: string;
  locationCount: number;
}): Promise<{ effectiveAt: string; alreadyScheduled: boolean }> {
  const stripeClient = await requireVerifiedStripeAccount();
  const subscription = await retrieveVerifiedSubscription(data);
  if (subscription.status !== "active" && subscription.status !== "trialing") {
    throw new Error(
      "Resolve the subscription's payment status before changing its billing schedule.",
    );
  }
  if (
    subscription.items.data.some((item) => item.price.id === data.annualPriceId)
  ) {
    throw new Error("This clinic is already billed annually.");
  }
  if (
    !subscription.items.data.some((item) => item.price.id === data.monthlyPriceId)
  ) {
    throw new Error(
      "The connected Stripe subscription is not an OpenVPM monthly plan.",
    );
  }

  const existingScheduleId = stripeResourceId(subscription.schedule);
  if (existingScheduleId) {
    const existing = await stripeClient.subscriptionSchedules.retrieve(
      existingScheduleId,
    );
    const annualPhase = annualPhaseForSchedule(
      existing,
      data.practiceId,
      data.annualPriceId,
    );
    if (!annualPhase) {
      throw new Error(
        "This subscription already has another Stripe schedule. Contact OpenVPM support before changing it.",
      );
    }
    return {
      effectiveAt: new Date(annualPhase.start_date * 1000).toISOString(),
      alreadyScheduled: true,
    };
  }

  const created = await stripeClient.subscriptionSchedules.create(
    { from_subscription: data.subscriptionId },
    {
      idempotencyKey: stripeIdempotencyKey(
        "subscription-annual-schedule-create",
        data.practiceId,
        {
          subscriptionId: data.subscriptionId,
          annualPriceId: data.annualPriceId,
        },
      ),
    },
  );
  const currentPhase = created.current_phase
    ? created.phases.find(
        (phase) =>
          phase.start_date === created.current_phase?.start_date &&
          phase.end_date === created.current_phase?.end_date,
      )
    : created.phases.at(-1);
  if (!currentPhase) {
    throw new Error("Stripe did not return the current subscription phase.");
  }

  const currentParams = schedulePhaseToUpdateParams(currentPhase);
  currentParams.items = currentParams.items.map((item) =>
    item.price === data.monthlyPriceId
      ? { ...item, quantity: Math.max(1, data.locationCount) }
      : item,
  );
  const futureParams: Stripe.SubscriptionScheduleUpdateParams.Phase = {
    ...currentParams,
    items: [
      {
        price: data.annualPriceId,
        quantity: Math.max(1, data.locationCount),
      },
    ],
    start_date: currentPhase.end_date,
    end_date: undefined,
    duration: { interval: "year", interval_count: 1 },
    description: "OpenVPM Cloud — annual",
    metadata: {
      ...(currentPhase.metadata ?? {}),
      practiceId: data.practiceId,
      billingCadence: "year",
      source: "settings",
      openvpmCadenceChange: OPENVPM_ANNUAL_CHANGE,
    },
    trial: undefined,
    trial_end: undefined,
    proration_behavior: "none",
  };
  const updated = await stripeClient.subscriptionSchedules.update(
    created.id,
    {
      end_behavior: "release",
      metadata: {
        ...(created.metadata ?? {}),
        practiceId: data.practiceId,
        openvpmCadenceChange: OPENVPM_ANNUAL_CHANGE,
      },
      phases: [currentParams, futureParams],
      proration_behavior: "none",
    },
    {
      idempotencyKey: stripeIdempotencyKey(
        "subscription-annual-schedule-update",
        data.practiceId,
        {
          scheduleId: created.id,
          annualPriceId: data.annualPriceId,
          locationCount: Math.max(1, data.locationCount),
        },
      ),
    },
  );
  const annualPhase = annualPhaseForSchedule(
    updated,
    data.practiceId,
    data.annualPriceId,
  );
  if (!annualPhase) {
    throw new Error("Stripe did not confirm the scheduled annual phase.");
  }
  return {
    effectiveAt: new Date(annualPhase.start_date * 1000).toISOString(),
    alreadyScheduled: false,
  };
}

/** Keep both the live monthly phase and its future annual phase location-safe. */
export async function syncOpenVpmAnnualScheduleLocationQuantity(data: {
  subscription: Stripe.Subscription;
  practiceId: string;
  monthlyPriceId?: string;
  annualPriceId?: string;
  locationCount: number;
}): Promise<"none" | "updated"> {
  const scheduleId = stripeResourceId(data.subscription.schedule);
  if (!scheduleId) return "none";
  if (!data.monthlyPriceId || !data.annualPriceId) {
    throw new Error("OpenVPM monthly and annual Stripe prices are required.");
  }
  const stripeClient = await requireVerifiedStripeAccount();
  const schedule = await stripeClient.subscriptionSchedules.retrieve(scheduleId);
  const annualPhase = annualPhaseForSchedule(
    schedule,
    data.practiceId,
    data.annualPriceId,
  );
  if (!annualPhase) {
    throw new Error(
      "Subscription quantity sync stopped because Stripe has an unrecognized schedule.",
    );
  }
  const phases = schedule.phases
    .filter((phase) => phase.end_date > Math.floor(Date.now() / 1000))
    .map((phase) => {
      const params = schedulePhaseToUpdateParams(phase);
      params.items = params.items.map((item) =>
        item.price === data.monthlyPriceId || item.price === data.annualPriceId
          ? { ...item, quantity: Math.max(1, data.locationCount) }
          : item,
      );
      return params;
    });
  await stripeClient.subscriptionSchedules.update(
    schedule.id,
    {
      end_behavior: schedule.end_behavior,
      metadata: schedule.metadata ?? {},
      phases,
      proration_behavior: "none",
    },
    {
      idempotencyKey: stripeIdempotencyKey(
        "subscription-schedule-location-sync",
        data.practiceId,
        {
          scheduleId: schedule.id,
          locationCount: Math.max(1, data.locationCount),
        },
      ),
    },
  );
  return "updated";
}

/** Verify a subscription-webhook signature using its dedicated endpoint secret. */
export async function constructSubscriptionWebhookEvent(
  body: string,
  signature: string,
): Promise<Stripe.Event | null> {
  if (!stripe) return null;
  const endpointSecret = stripeSubscriptionWebhookSecret();
  if (!endpointSecret) return null;
  return stripe.webhooks.constructEvent(body, signature, endpointSecret);
}

export { stripe };

function stripeCheckoutRedirectUrl(value: unknown): string | null {
  return isSafeCheckoutRedirectUrl(value) ? value : null;
}

function checkoutCustomerEmail(
  email: string | null | undefined,
): string | undefined {
  const normalized = email?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}
