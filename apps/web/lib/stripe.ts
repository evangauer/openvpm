import Stripe from "stripe";

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

export async function createCheckoutSession(data: {
  invoiceId: string;
  amount: number; // in cents
  clientEmail: string;
  clientName: string;
  description: string;
  successUrl: string;
  cancelUrl: string;
  currency?: string; // ISO 4217 (lowercase), per the practice's region. Defaults to USD.
}): Promise<{ url: string | null } | null> {
  if (!stripe) {
    console.log("[Stripe] No API key configured, skipping checkout session", data);
    return null;
  }
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    mode: "payment",
    customer_email: data.clientEmail,
    line_items: [{
      price_data: {
        currency: (data.currency ?? "usd").toLowerCase(),
        product_data: { name: data.description },
        unit_amount: data.amount,
      },
      quantity: 1,
    }],
    metadata: { invoiceId: data.invoiceId },
    success_url: data.successUrl,
    cancel_url: data.cancelUrl,
  });
  return { url: session.url };
}

export async function constructWebhookEvent(
  body: string,
  signature: string,
): Promise<Stripe.Event | null> {
  if (!stripe) return null;
  return stripe.webhooks.constructEvent(
    body,
    signature,
    process.env.STRIPE_WEBHOOK_SECRET!,
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
}): Promise<{ url: string | null } | null> {
  if (!stripe) {
    console.log("[Stripe] No API key configured, skipping subscription checkout");
    return null;
  }
  const session = await stripe.checkout.sessions.create(
    buildSubscriptionCheckoutSessionParams(data)
  );
  return { url: session.url };
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
}): Stripe.Checkout.SessionCreateParams {
  const trialEnd = data.trialEnd
    ? Math.floor(new Date(data.trialEnd).getTime() / 1000)
    : undefined;
  const hasTrial = !!trialEnd || !!data.trialPeriodDays;
  return {
    mode: "subscription",
    payment_method_collection: hasTrial ? "if_required" : "always",
    // Metered prices (usage-based overage) must be added WITHOUT a quantity;
    // licensed prices (per-location) carry the active count.
    line_items: data.lineItems.map((item) =>
      item.metered
        ? { price: item.priceId }
        : { price: item.priceId, quantity: Math.max(0, item.quantity ?? 0) }
    ),
    ...(data.customerId
      ? { customer: data.customerId }
      : { customer_email: data.customerEmail ?? undefined }),
    client_reference_id: data.practiceId,
    metadata: { practiceId: data.practiceId },
    subscription_data: {
      metadata: { practiceId: data.practiceId },
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

/** Create a Stripe Billing Portal session so a practice can manage its plan. */
export async function createBillingPortalSession(data: {
  customerId: string;
  returnUrl: string;
}): Promise<{ url: string } | null> {
  if (!stripe) return null;
  const session = await stripe.billingPortal.sessions.create({
    customer: data.customerId,
    return_url: data.returnUrl,
  });
  return { url: session.url };
}

/** Verify a subscription-webhook signature using its dedicated endpoint secret. */
export async function constructSubscriptionWebhookEvent(
  body: string,
  signature: string,
): Promise<Stripe.Event | null> {
  if (!stripe) return null;
  return stripe.webhooks.constructEvent(
    body,
    signature,
    process.env.STRIPE_SUBSCRIPTION_WEBHOOK_SECRET!,
  );
}

export { stripe };
