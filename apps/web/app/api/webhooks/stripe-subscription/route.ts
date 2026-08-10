import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull, or } from "drizzle-orm";
import type Stripe from "stripe";
import { db } from "@openpims/db/client";
import { practices } from "@openpims/db";
import { constructSubscriptionWebhookEvent, stripe } from "@/lib/stripe";
import {
  tierForStripePrice,
  normalizeBillingStatus,
} from "@/lib/billing/plans";
import { syncPracticeSubscriptionQuantities } from "@/lib/billing/subscription-sync";
import { alertOps } from "@/lib/alerts";
import { withSystem } from "@/lib/tenant-db";
import { sendPaymentReceiptEmail, sendPaymentFailedEmail } from "@/lib/email";
import { sendLifecycleEmail } from "@/lib/email-lifecycle";
import {
  attachStripeEventPractice,
  claimStripeEvent,
  type StripeConversionEvidenceInput,
} from "@/lib/billing/stripe-events";
import { billingContactEmail } from "@/lib/billing/contact";
import { readRequestTextWithLimit } from "@/lib/request-json";
import {
  STRIPE_WEBHOOK_BODY_MAX_BYTES,
  stripeWebhookContentLengthTooLarge,
} from "@/lib/stripe-webhook-limits";
import { projectStripeConversionMilestonesForEvent } from "@/lib/conversion-milestones";

function payloadTooLargeResponse() {
  return NextResponse.json(
    { error: "Stripe webhook payload too large" },
    { status: 413 },
  );
}

/**
 * Stripe webhook for hosted-SaaS subscriptions — a SEPARATE endpoint from the
 * client-invoice webhook (different signing secret). Keeps the two Stripe
 * surfaces isolated so neither can spoof the other.
 */
export async function POST(req: NextRequest) {
  if (stripeWebhookContentLengthTooLarge(req.headers)) {
    return payloadTooLargeResponse();
  }

  const body = await readRequestTextWithLimit(
    req,
    STRIPE_WEBHOOK_BODY_MAX_BYTES,
  );
  if (!body.ok) {
    return payloadTooLargeResponse();
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json(
      { error: "Missing stripe-signature header" },
      { status: 400 },
    );
  }

  let event: Stripe.Event | null;
  try {
    event = await constructSubscriptionWebhookEvent(body.text, signature);
  } catch (err) {
    console.error(
      "[Stripe Subscription Webhook] signature verification failed:",
      err,
    );
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }
  if (!event) {
    return NextResponse.json(
      { error: "Webhook verification failed or Stripe not configured" },
      { status: 400 },
    );
  }

  const conversionEvidence = conversionEvidenceForEvent(event);
  try {
    await withSystem(db, async (tx) => {
      const claimed = await claimStripeEvent(tx, {
        eventId: event.id,
        endpoint: "subscription",
        eventType: event.type,
        ...(conversionEvidence ? { evidence: conversionEvidence } : {}),
      });
      if (!claimed) return;

      switch (event.type) {
        case "checkout.session.completed": {
          const s = event.data.object as Stripe.Checkout.Session;
          const practiceId =
            s.client_reference_id ?? s.metadata?.practiceId ?? null;
          const subscriptionId =
            typeof s.subscription === "string"
              ? s.subscription
              : (s.subscription?.id ?? null);
          let activePracticeId: string | null = null;
          if (practiceId && s.customer) {
            const [practice] = await tx
              .update(practices)
              .set({
                stripeCustomerId:
                  typeof s.customer === "string" ? s.customer : s.customer!.id,
                stripeSubscriptionId: subscriptionId,
              })
              .where(
                and(eq(practices.id, practiceId), isNull(practices.deletedAt)),
              )
              .returning({ id: practices.id });
            activePracticeId = practice?.id ?? null;
          } else if (practiceId) {
            const [practice] = await tx
              .select({ id: practices.id })
              .from(practices)
              .where(
                and(eq(practices.id, practiceId), isNull(practices.deletedAt)),
              )
              .limit(1);
            activePracticeId = practice?.id ?? null;
          }
          if (activePracticeId && conversionEvidence) {
            await attachStripeEventPractice(tx, {
              eventId: event.id,
              endpoint: "subscription",
              practiceId: activePracticeId,
            });
          }
          if (activePracticeId && subscriptionId) {
            if (!stripe) {
              throw new Error(
                "Stripe is unavailable while reconciling Checkout.",
              );
            }
            // Checkout is itself a signed, authoritative link between the
            // practice and subscription. Apply the current Stripe state now so
            // access never depends on customer.subscription.* event ordering.
            const subscription =
              await stripe.subscriptions.retrieve(subscriptionId);
            await applySubscription(tx, subscription, activePracticeId);
          }
          break;
        }

        case "customer.subscription.created":
        case "customer.subscription.updated": {
          await applySubscription(tx, event.data.object as Stripe.Subscription);
          break;
        }

        case "customer.subscription.deleted": {
          const sub = event.data.object as Stripe.Subscription;
          const practiceId = await resolvePracticeIdForSubscription(tx, sub);
          if (practiceId) {
            await tx
              .update(practices)
              .set({
                subscriptionTier: "free",
                billingStatus: "canceled",
                stripeSubscriptionId: null,
              })
              .where(
                and(
                  eq(practices.id, practiceId),
                  eq(practices.stripeSubscriptionId, sub.id),
                  isNull(practices.deletedAt),
                ),
              );
          }
          break;
        }

        case "invoice.payment_succeeded": {
          const inv = event.data.object as Stripe.Invoice;
          const customerId =
            typeof inv.customer === "string" ? inv.customer : inv.customer?.id;
          // Only a real (non-$0) charge warrants a receipt — skip the $0 invoice
          // Stripe emits at trial start.
          if (customerId && (inv.amount_paid ?? 0) > 0) {
            const subscriptionId = subscriptionIdForInvoice(inv);
            let subscriptionPracticeId: string | null = null;
            if (subscriptionId) {
              if (!stripe) {
                throw new Error(
                  "Stripe is unavailable while reconciling a paid invoice.",
                );
              }
              // A successful subscription charge is a second authoritative
              // self-healing point if a subscription-created/updated event was
              // omitted or arrived out of order.
              const subscription =
                await stripe.subscriptions.retrieve(subscriptionId);
              subscriptionPracticeId = await applySubscription(
                tx,
                subscription,
              );
            }
            const practice = subscriptionPracticeId
              ? await practiceById(tx, subscriptionPracticeId)
              : subscriptionId
                ? null
                : await practiceForCustomer(tx, customerId);
            if (practice && conversionEvidence) {
              await attachStripeEventPractice(tx, {
                eventId: event.id,
                endpoint: "subscription",
                practiceId: practice.id,
              });
            }
            const to = billingContactEmail(practice?.email);
            if (practice && to) {
              const practiceName = practice.name ?? "your practice";
              await sendLifecycleEmail({
                practiceId: practice.id,
                to,
                emailType: "receipt",
                dedupeKey: `lc:receipt:${inv.id}`,
                category: "transactional",
                send: () =>
                  sendPaymentReceiptEmail({
                    to,
                    practiceName,
                    amount: formatMoney(inv.amount_paid, inv.currency),
                    periodLabel: invoicePeriodLabel(inv, practice.timezone),
                    invoiceUrl: inv.hosted_invoice_url ?? undefined,
                  }),
              });
            }
          }
          break;
        }

        case "invoice.payment_failed": {
          const inv = event.data.object as Stripe.Invoice;
          const customerId =
            typeof inv.customer === "string" ? inv.customer : inv.customer?.id;
          if (customerId) {
            await tx
              .update(practices)
              .set({ billingStatus: "past_due" })
              .where(
                and(
                  eq(practices.stripeCustomerId, customerId),
                  isNull(practices.deletedAt),
                ),
              );
            await alertOps(
              "Subscription payment failed",
              `Stripe customer ${customerId} had a failed subscription payment; marked past_due.`,
            );
            const practice = await practiceForCustomer(tx, customerId);
            const to = billingContactEmail(practice?.email);
            if (practice && to) {
              const practiceName = practice.name ?? "your practice";
              await sendLifecycleEmail({
                practiceId: practice.id,
                to,
                emailType: "dunning",
                // One dunning email per Stripe retry attempt.
                dedupeKey: `lc:dunning:${inv.id}:${inv.attempt_count ?? 0}`,
                category: "transactional",
                send: () =>
                  sendPaymentFailedEmail({
                    to,
                    practiceName,
                    amount: formatMoney(inv.amount_due, inv.currency),
                    nextRetryDate: formatUnixDate(
                      inv.next_payment_attempt,
                      practice.timezone,
                    ),
                  }),
              });
            }
          }
          break;
        }

        default:
          // Ignore other event types.
          break;
      }
    });
  } catch (err) {
    console.error("[Stripe Subscription Webhook] handler error:", err);
    await alertOps(
      "Subscription webhook handler error",
      `Event ${event.type} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return NextResponse.json({ error: "Handler error" }, { status: 500 });
  }

  if (conversionEvidence) {
    try {
      await projectStripeConversionMilestonesForEvent(db, event.id);
    } catch (error) {
      // Billing and the allowlisted signed evidence have already committed.
      // Local reconciliation will repair this projection without Stripe calls.
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        "[Stripe Subscription Webhook] conversion projection failed:",
        error,
      );
      await alertOps(
        "Subscription conversion projection failed",
        `Event ${event.id} will be retried from local evidence: ${message}`,
      );
    }
  }

  return NextResponse.json({ received: true });
}

/** Apply a subscription's tier/status/trial through one shared mapping path. */
async function applySubscription(
  tx: typeof db,
  sub: Stripe.Subscription,
  practiceIdHint?: string | null,
): Promise<string | null> {
  const practiceId = await resolvePracticeIdForSubscription(
    tx,
    sub,
    practiceIdHint,
  );
  const tier =
    sub.items?.data
      ?.map((item) => tierForStripePrice(item.price?.id))
      .find(Boolean) ?? null;
  const customerId =
    typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
  const billingStatus = normalizeBillingStatus(sub.status);

  const [practice] = await tx
    .update(practices)
    .set({
      ...(tier ? { subscriptionTier: tier } : {}),
      billingStatus,
      stripeSubscriptionId: sub.id,
      ...(customerId ? { stripeCustomerId: customerId } : {}),
      trialEndsAt: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
    })
    .where(and(eq(practices.id, practiceId), isNull(practices.deletedAt)))
    .returning({ id: practices.id });
  if (!practice) {
    console.warn(
      "[Stripe Subscription Webhook] subscription for missing/deleted practice:",
      sub.id,
      practiceId,
    );
    return null;
  }
  await syncPracticeSubscriptionQuantities({
    db: tx,
    practiceId: practice.id,
    subscriptionId: sub.id,
  });
  return practice.id;
}

function conversionEvidenceForEvent(
  event: Stripe.Event,
): StripeConversionEvidenceInput | undefined {
  const eventCreatedAt = stripeEventCreatedAt(event.created);
  if (!eventCreatedAt) return undefined;

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const subscriptionId =
      typeof session.subscription === "string"
        ? session.subscription
        : (session.subscription?.id ?? null);
    if (
      !session.id ||
      session.mode !== "subscription" ||
      session.payment_method_collection !== "always" ||
      !subscriptionId
    ) {
      return undefined;
    }
    return {
      eventCreatedAt,
      objectId: session.id,
      evidenceKind: "subscription_checkout_completed",
    };
  }

  if (event.type === "invoice.payment_succeeded") {
    const invoice = event.data.object as Stripe.Invoice;
    const amountCents = invoice.amount_paid ?? 0;
    const currency = normalizedCurrency(invoice.currency);
    if (
      !invoice.id ||
      amountCents <= 0 ||
      !currency ||
      !subscriptionIdForInvoice(invoice)
    ) {
      return undefined;
    }
    return {
      eventCreatedAt,
      objectId: invoice.id,
      evidenceKind: "positive_subscription_invoice_paid",
      amountCents,
      currency,
    };
  }

  return undefined;
}

function stripeEventCreatedAt(created: number | null | undefined): Date | null {
  if (!Number.isFinite(created) || (created ?? -1) < 0) return null;
  const date = new Date(created! * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizedCurrency(
  currency: string | null | undefined,
): string | null {
  const normalized = currency?.trim().toLowerCase();
  return normalized && /^[a-z]{3}$/.test(normalized) ? normalized : null;
}

/**
 * Resolve a Stripe subscription to exactly one active practice.
 *
 * App-created subscriptions carry metadata.practiceId. Checkout may also pass
 * its signed client_reference_id as a hint. Older/manual subscriptions can be
 * recovered only when their stored subscription/customer identity maps to one
 * practice, and a customer fallback may never replace a different stored
 * subscription. Ambiguous/unmapped events throw so Stripe retries and ops is
 * alerted by the route-level handler instead of silently acknowledging drift.
 */
async function resolvePracticeIdForSubscription(
  tx: typeof db,
  sub: Stripe.Subscription,
  practiceIdHint?: string | null,
): Promise<string> {
  const metadataPracticeId = sub.metadata?.practiceId?.trim() || null;
  const hintedPracticeId = practiceIdHint?.trim() || null;
  if (
    metadataPracticeId &&
    hintedPracticeId &&
    metadataPracticeId !== hintedPracticeId
  ) {
    throw new Error(
      `Stripe subscription ${sub.id} has conflicting practice identifiers.`,
    );
  }
  if (metadataPracticeId || hintedPracticeId) {
    return metadataPracticeId ?? hintedPracticeId!;
  }

  const customerId = subscriptionCustomerId(sub);
  const identity = customerId
    ? or(
        eq(practices.stripeSubscriptionId, sub.id),
        eq(practices.stripeCustomerId, customerId),
      )
    : eq(practices.stripeSubscriptionId, sub.id);
  const matches = await tx
    .select({
      id: practices.id,
      stripeSubscriptionId: practices.stripeSubscriptionId,
    })
    .from(practices)
    .where(and(identity, isNull(practices.deletedAt)))
    .limit(2);

  if (matches.length !== 1) {
    throw new Error(
      `Stripe subscription ${sub.id} could not be mapped unambiguously to a practice.`,
    );
  }
  const match = matches[0]!;
  if (match.stripeSubscriptionId && match.stripeSubscriptionId !== sub.id) {
    throw new Error(
      `Stripe customer fallback for ${sub.id} conflicts with an existing subscription.`,
    );
  }
  return match.id;
}

function subscriptionCustomerId(sub: Stripe.Subscription): string | null {
  return typeof sub.customer === "string"
    ? sub.customer
    : (sub.customer?.id ?? null);
}

function subscriptionIdForInvoice(inv: Stripe.Invoice): string | null {
  const subscription = inv.parent?.subscription_details?.subscription;
  return typeof subscription === "string"
    ? subscription
    : (subscription?.id ?? null);
}

/** Look up a practice's id / email / name by its Stripe customer id. */
async function practiceForCustomer(tx: typeof db, customerId: string) {
  const [p] = await tx
    .select({
      id: practices.id,
      email: practices.email,
      name: practices.name,
      timezone: practices.timezone,
    })
    .from(practices)
    .where(
      and(
        eq(practices.stripeCustomerId, customerId),
        isNull(practices.deletedAt),
      ),
    )
    .limit(1);
  return p ?? null;
}

/** Read billing contact details for an already-authoritatively resolved clinic. */
async function practiceById(tx: typeof db, practiceId: string) {
  const [practice] = await tx
    .select({
      id: practices.id,
      email: practices.email,
      name: practices.name,
      timezone: practices.timezone,
    })
    .from(practices)
    .where(and(eq(practices.id, practiceId), isNull(practices.deletedAt)))
    .limit(1);
  return practice ?? null;
}

function formatMoney(
  cents: number | null | undefined,
  currency: string | null | undefined,
): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: (currency ?? "usd").toUpperCase(),
  }).format((cents ?? 0) / 100);
}

function formatUnixDate(
  sec: number | null | undefined,
  timeZone?: string | null,
): string | undefined {
  if (!sec) return undefined;
  const options: Intl.DateTimeFormatOptions = {
    timeZone: timeZone?.trim() || "UTC",
    month: "long",
    day: "numeric",
    year: "numeric",
  };
  const date = new Date(sec * 1000);
  try {
    return date.toLocaleDateString("en-US", options);
  } catch {
    return date.toLocaleDateString("en-US", { ...options, timeZone: "UTC" });
  }
}

function invoicePeriodLabel(
  inv: Stripe.Invoice,
  timeZone?: string | null,
): string {
  const s = formatUnixDate(inv.period_start, timeZone);
  const e = formatUnixDate(inv.period_end, timeZone);
  if (s && e) return `${s} – ${e}`;
  return e ?? s ?? "";
}
