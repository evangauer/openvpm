import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import type Stripe from "stripe";
import { db } from "@openpims/db/client";
import { practices } from "@openpims/db";
import { constructSubscriptionWebhookEvent } from "@/lib/stripe";
import { tierForStripePrice, normalizeBillingStatus } from "@/lib/billing/plans";
import { syncPracticeSubscriptionQuantities } from "@/lib/billing/subscription-sync";
import { alertOps } from "@/lib/alerts";
import { withSystem } from "@/lib/tenant-db";
import {
  sendPaymentReceiptEmail,
  sendPaymentFailedEmail,
} from "@/lib/email";
import { sendLifecycleEmail } from "@/lib/email-lifecycle";
import { claimStripeEvent } from "@/lib/billing/stripe-events";
import { billingContactEmail } from "@/lib/billing/contact";
import { readRequestTextWithLimit } from "@/lib/request-json";
import {
  STRIPE_WEBHOOK_BODY_MAX_BYTES,
  stripeWebhookContentLengthTooLarge,
} from "@/lib/stripe-webhook-limits";

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
    STRIPE_WEBHOOK_BODY_MAX_BYTES
  );
  if (!body.ok) {
    return payloadTooLargeResponse();
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 });
  }

  let event: Stripe.Event | null;
  try {
    event = await constructSubscriptionWebhookEvent(body.text, signature);
  } catch (err) {
    console.error("[Stripe Subscription Webhook] signature verification failed:", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }
  if (!event) {
    return NextResponse.json(
      { error: "Webhook verification failed or Stripe not configured" },
      { status: 400 },
    );
  }

  try {
    await withSystem(db, async (tx) => {
      const claimed = await claimStripeEvent(tx, {
        eventId: event.id,
        endpoint: "subscription",
        eventType: event.type,
      });
      if (!claimed) return;

      switch (event.type) {
        case "checkout.session.completed": {
          const s = event.data.object as Stripe.Checkout.Session;
          const practiceId = s.client_reference_id ?? s.metadata?.practiceId ?? null;
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
              .where(and(eq(practices.id, practiceId), isNull(practices.deletedAt)))
              .returning({ id: practices.id });
            activePracticeId = practice?.id ?? null;
          } else if (practiceId) {
            const [practice] = await tx
              .select({ id: practices.id })
              .from(practices)
              .where(and(eq(practices.id, practiceId), isNull(practices.deletedAt)))
              .limit(1);
            activePracticeId = practice?.id ?? null;
          }
          if (activePracticeId && subscriptionId) {
            await syncPracticeSubscriptionQuantities({
              db: tx,
              practiceId: activePracticeId,
              subscriptionId,
            });
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
          const practiceId = sub.metadata?.practiceId;
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
            const practice = await practiceForCustomer(tx, customerId);
            const to = billingContactEmail(practice?.email);
            if (practice && to) {
              const practiceName = practice.name ?? "your practice";
              await sendLifecycleEmail({
                practiceId: practice.id,
                to,
                emailType: "receipt",
                dedupeKey: `lc:receipt:${inv.id}`,
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

    return NextResponse.json({ received: true });
  } catch (err) {
    console.error("[Stripe Subscription Webhook] handler error:", err);
    await alertOps(
      "Subscription webhook handler error",
      `Event ${event.type} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return NextResponse.json({ error: "Handler error" }, { status: 500 });
  }
}

/** Apply a subscription's tier/status/trial to its practice (via metadata.practiceId). */
async function applySubscription(tx: typeof db, sub: Stripe.Subscription) {
  const practiceId = sub.metadata?.practiceId;
  if (!practiceId) {
    console.warn("[Stripe Subscription Webhook] subscription without practiceId metadata:", sub.id);
    return;
  }
  const tier =
    sub.items?.data
      ?.map((item) => tierForStripePrice(item.price?.id))
      .find(Boolean) ?? null;
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;

  const [practice] = await tx
    .update(practices)
    .set({
      ...(tier ? { subscriptionTier: tier } : {}),
      billingStatus: normalizeBillingStatus(sub.status),
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
    return;
  }
  await syncPracticeSubscriptionQuantities({
    db: tx,
    practiceId: practice.id,
    subscriptionId: sub.id,
  });
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

function invoicePeriodLabel(inv: Stripe.Invoice, timeZone?: string | null): string {
  const s = formatUnixDate(inv.period_start, timeZone);
  const e = formatUnixDate(inv.period_end, timeZone);
  if (s && e) return `${s} – ${e}`;
  return e ?? s ?? "";
}
