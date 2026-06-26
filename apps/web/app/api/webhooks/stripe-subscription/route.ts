import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
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

/**
 * Stripe webhook for hosted-SaaS subscriptions — a SEPARATE endpoint from the
 * client-invoice webhook (different signing secret). Keeps the two Stripe
 * surfaces isolated so neither can spoof the other.
 */
export async function POST(req: NextRequest) {
  const body = await req.text();
  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 });
  }

  let event: Stripe.Event | null;
  try {
    event = await constructSubscriptionWebhookEvent(body, signature);
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
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object as Stripe.Checkout.Session;
        const practiceId = s.client_reference_id ?? s.metadata?.practiceId ?? null;
        const subscriptionId =
          typeof s.subscription === "string"
            ? s.subscription
            : (s.subscription?.id ?? null);
        if (practiceId && s.customer) {
          await withSystem(db, (tx) =>
            tx
              .update(practices)
              .set({
                stripeCustomerId:
                  typeof s.customer === "string" ? s.customer : s.customer!.id,
                stripeSubscriptionId: subscriptionId,
              })
              .where(eq(practices.id, practiceId))
          );
        }
        if (practiceId && subscriptionId) {
          await withSystem(db, (tx) =>
            syncPracticeSubscriptionQuantities({
              db: tx,
              practiceId,
              subscriptionId,
            })
          );
        }
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated": {
        await applySubscription(event.data.object as Stripe.Subscription);
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const practiceId = sub.metadata?.practiceId;
        if (practiceId) {
          await withSystem(db, (tx) =>
            tx
              .update(practices)
              .set({
                subscriptionTier: "free",
                billingStatus: "canceled",
                stripeSubscriptionId: null,
              })
              .where(eq(practices.id, practiceId))
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
          const practice = await practiceForCustomer(customerId);
          if (practice?.email) {
            const to = practice.email;
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
                  periodLabel: invoicePeriodLabel(inv),
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
          await withSystem(db, (tx) =>
            tx
              .update(practices)
              .set({ billingStatus: "past_due" })
              .where(eq(practices.stripeCustomerId, customerId))
          );
          await alertOps(
            "Subscription payment failed",
            `Stripe customer ${customerId} had a failed subscription payment; marked past_due.`,
          );
          const practice = await practiceForCustomer(customerId);
          if (practice?.email) {
            const to = practice.email;
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
                  nextRetryDate: formatUnixDate(inv.next_payment_attempt),
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
async function applySubscription(sub: Stripe.Subscription) {
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

  await withSystem(db, (tx) =>
    tx
      .update(practices)
      .set({
        ...(tier ? { subscriptionTier: tier } : {}),
        billingStatus: normalizeBillingStatus(sub.status),
        stripeSubscriptionId: sub.id,
        ...(customerId ? { stripeCustomerId: customerId } : {}),
        trialEndsAt: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
      })
      .where(eq(practices.id, practiceId))
  );
  await withSystem(db, (tx) =>
    syncPracticeSubscriptionQuantities({
      db: tx,
      practiceId,
      subscriptionId: sub.id,
    })
  );
}

/** Look up a practice's id / email / name by its Stripe customer id. */
async function practiceForCustomer(customerId: string) {
  const [p] = await withSystem(db, (tx) =>
    tx
      .select({
        id: practices.id,
        email: practices.email,
        name: practices.name,
      })
      .from(practices)
      .where(eq(practices.stripeCustomerId, customerId))
      .limit(1),
  );
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

function formatUnixDate(sec: number | null | undefined): string | undefined {
  if (!sec) return undefined;
  return new Date(sec * 1000).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function invoicePeriodLabel(inv: Stripe.Invoice): string {
  const s = formatUnixDate(inv.period_start);
  const e = formatUnixDate(inv.period_end);
  if (s && e) return `${s} – ${e}`;
  return e ?? s ?? "";
}
