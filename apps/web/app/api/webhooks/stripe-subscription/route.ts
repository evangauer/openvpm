import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { db } from "@openpims/db/client";
import { practices } from "@openpims/db";
import { constructSubscriptionWebhookEvent, stripe } from "@/lib/stripe";
import {
  tierForStripePrice,
  normalizeBillingStatus,
} from "@/lib/billing/plans";
import { alertOps } from "@/lib/alerts";
import { withSystem } from "@/lib/tenant-db";
import { sendPaymentReceiptEmail, sendPaymentFailedEmail } from "@/lib/email";
import { sendLifecycleEmail } from "@/lib/email-lifecycle";
import { enqueueSubscriptionLifecycleEmail } from "@/lib/billing/lifecycle-email-outbox";
import {
  attachStripeEventPractice,
  authorizeStripeSubscriptionSync,
  claimStripeEvent,
  lockStripeSubscriptionReconciliationOutcome,
  resolveStripeSubscriptionReconciliation,
  type StripeConversionEvidenceInput,
} from "@/lib/billing/stripe-events";
import { runDurableSubscriptionQuantitySync } from "@/lib/billing/stripe-subscription-quantity-sync";
import { billingContactEmail } from "@/lib/billing/contact";
import { readRequestTextWithLimit } from "@/lib/request-json";
import {
  STRIPE_WEBHOOK_BODY_MAX_BYTES,
  stripeWebhookContentLengthTooLarge,
} from "@/lib/stripe-webhook-limits";
import { projectStripeConversionMilestonesForEvent } from "@/lib/conversion-milestones";
import { reconcileSubscriptionCheckoutWebhook } from "@/lib/billing/subscription-checkout-attempts";

class UnmanagedStripeSubscriptionError extends Error {
  constructor(subscriptionId: string) {
    super(`Stripe subscription ${subscriptionId} is not managed by OpenVPM.`);
    this.name = "UnmanagedStripeSubscriptionError";
  }
}

type SubscriptionPreparation =
  | { state: "duplicate" }
  | {
      state: "authorized";
      practiceId: string;
      revision: number;
      subscriptionId: string;
      subscription: Stripe.Subscription;
    }
  | null;

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
  let preparation: SubscriptionPreparation;
  try {
    preparation = await prepareSubscriptionReconciliation(
      event,
      conversionEvidence,
    );
    if (preparation?.state === "duplicate") {
      return (await runDurableSubscriptionQuantitySync(event.id))
        ? NextResponse.json({ received: true })
        : NextResponse.json(
            { error: "Subscription quantity reconciliation deferred" },
            { status: 503, headers: { "Retry-After": "300" } },
          );
    }
  } catch (err) {
    if (err instanceof UnmanagedStripeSubscriptionError) {
      console.info(
        `[Stripe Subscription Webhook] ignored unmanaged event type=${event.type}`,
      );
      return NextResponse.json({ received: true, ignored: true });
    }
    console.error("[Stripe Subscription Webhook] authorization error:", err);
    await alertOps(
      "Subscription webhook authorization error",
      `Event ${event.type} remains retryable: ${err instanceof Error ? err.message : String(err)}`,
    );
    return NextResponse.json({ error: "Handler error" }, { status: 500 });
  }
  const postCommitEffects: Array<() => Promise<unknown>> = [];
  try {
    await withSystem(db, async (tx) => {
      const claimed = preparation
        ? true
        : await claimStripeEvent(tx, {
            eventId: event.id,
            endpoint: "subscription",
            eventType: event.type,
            ...(conversionEvidence ? { evidence: conversionEvidence } : {}),
          });
      if (!claimed) return;
      if (
        preparation?.state === "authorized" &&
        !(await lockStripeSubscriptionReconciliationOutcome(tx, {
          eventId: event.id,
          expectedRevision: preparation.revision,
        }))
      ) {
        throw new Error(
          "Subscription reconciliation authorization was superseded.",
        );
      }
      const authorized =
        preparation?.state === "authorized" ? preparation : null;
      let queueQuantitySync = false;

      switch (event.type) {
        case "checkout.session.completed": {
          const s = event.data.object as Stripe.Checkout.Session;
          const metadataPracticeId = s.metadata?.practiceId ?? null;
          const practiceId =
            s.client_reference_id &&
            metadataPracticeId &&
            s.client_reference_id !== metadataPracticeId
              ? null
              : (s.client_reference_id ?? metadataPracticeId);
          const subscriptionId =
            typeof s.subscription === "string"
              ? s.subscription
              : (s.subscription?.id ?? null);
          const checkoutCustomerId =
            typeof s.customer === "string"
              ? s.customer
              : (s.customer?.id ?? null);
          const durableAttemptId = s.metadata?.checkoutAttemptId?.trim();
          if (durableAttemptId) {
            const checkoutReconciliation =
              await reconcileSubscriptionCheckoutWebhook(tx, {
                attemptId: durableAttemptId,
                practiceId,
                providerSessionId: s.id,
                providerExpiresAt: new Date(s.expires_at * 1000),
                status: "completed",
                customerId: checkoutCustomerId,
                subscriptionId,
                occurredAt: new Date(event.created * 1000),
              });
            if ("reason" in checkoutReconciliation) {
              throw new Error(
                `Durable subscription Checkout completion ${checkoutReconciliation.outcome}:${checkoutReconciliation.reason}.`,
              );
            }
          }
          let activePracticeId: string | null = null;
          if (practiceId && s.customer) {
            const customerId = checkoutCustomerId!;
            const [practice] = await tx
              .update(practices)
              .set({
                stripeCustomerId: customerId,
                stripeSubscriptionId: subscriptionId,
              })
              .where(
                and(
                  eq(practices.id, practiceId),
                  isNull(practices.deletedAt),
                  eq(practices.recoveryHold, false),
                  or(
                    isNull(practices.stripeQuantitySyncLeaseToken),
                    lte(
                      practices.stripeQuantitySyncLeaseExpiresAt,
                      sql`clock_timestamp()`,
                    ),
                  ),
                  eq(
                    practices.stripeSubscriptionSyncRevision,
                    authorized!.revision,
                  ),
                  or(
                    isNull(practices.stripeCustomerId),
                    eq(practices.stripeCustomerId, customerId),
                  ),
                  subscriptionId
                    ? or(
                        isNull(practices.stripeSubscriptionId),
                        eq(practices.stripeSubscriptionId, subscriptionId),
                      )
                    : isNull(practices.stripeSubscriptionId),
                ),
              )
              .returning({ id: practices.id });
            activePracticeId = practice?.id ?? null;
          }
          if (!activePracticeId) {
            throw new Error(
              "Checkout identity authorization was superseded or conflicted.",
            );
          }
          if (activePracticeId && conversionEvidence) {
            await attachStripeEventPractice(tx, {
              eventId: event.id,
              endpoint: "subscription",
              practiceId: activePracticeId,
            });
          }
          if (activePracticeId && subscriptionId) {
            // Checkout is itself a signed, authoritative link between the
            // practice and subscription. Apply the current Stripe state now so
            // access never depends on customer.subscription.* event ordering.
            const subscription = authorized?.subscription;
            if (!subscription || subscription.id !== subscriptionId) {
              throw new Error("Checkout subscription snapshot is unavailable.");
            }
            const appliedPractice = await applySubscription(
              tx,
              subscription,
              activePracticeId,
              authorized!.revision,
            );
            if (!appliedPractice) {
              throw new Error("Checkout subscription persistence conflicted.");
            }
            queueQuantitySync =
              normalizeBillingStatus(subscription.status) !== "canceled";
            if (
              appliedPractice &&
              normalizeBillingStatus(subscription.status) === "active"
            ) {
              const practice = await practiceById(tx, appliedPractice.id);
              const to = billingContactEmail(practice?.email);
              if (practice && to) {
                const dedupeKey = `lc:confirmed:${subscription.id}`;
                await enqueueSubscriptionLifecycleEmail(tx, {
                  practiceId: practice.id,
                  practiceName: practice.name ?? "your practice",
                  recipient: to,
                  kind: "subscription_confirmed",
                  subscriptionId: subscription.id,
                  subscriptionGeneration:
                    appliedPractice.subscriptionGeneration,
                  dedupeKey,
                });
              }
            }
          }
          break;
        }

        case "checkout.session.expired": {
          const s = event.data.object as Stripe.Checkout.Session;
          const metadataPracticeId = s.metadata?.practiceId ?? null;
          const practiceId =
            s.client_reference_id &&
            metadataPracticeId &&
            s.client_reference_id !== metadataPracticeId
              ? null
              : (s.client_reference_id ?? metadataPracticeId);
          const durableAttemptId = s.metadata?.checkoutAttemptId?.trim();
          if (durableAttemptId) {
            const checkoutReconciliation =
              await reconcileSubscriptionCheckoutWebhook(tx, {
                attemptId: durableAttemptId,
                practiceId,
                providerSessionId: s.id,
                providerExpiresAt: new Date(s.expires_at * 1000),
                status: "expired",
                occurredAt: new Date(event.created * 1000),
              });
            if ("reason" in checkoutReconciliation) {
              throw new Error(
                `Durable subscription Checkout expiration ${checkoutReconciliation.outcome}:${checkoutReconciliation.reason}.`,
              );
            }
          }
          break;
        }

        case "customer.subscription.created":
        case "customer.subscription.updated": {
          const eventSubscription = event.data.object as Stripe.Subscription;
          const currentSubscription = authorized?.subscription;
          if (
            !currentSubscription ||
            currentSubscription.id !== eventSubscription.id
          ) {
            throw new Error("Subscription snapshot is unavailable.");
          }
          const applied = await applySubscription(
            tx,
            currentSubscription,
            authorized!.practiceId,
            authorized!.revision,
          );
          if (!applied) {
            throw new Error("Subscription persistence conflicted.");
          }
          queueQuantitySync =
            normalizeBillingStatus(currentSubscription.status) !== "canceled";
          break;
        }

        case "customer.subscription.deleted": {
          const sub = event.data.object as Stripe.Subscription;
          const practiceId = await resolvePracticeIdForSubscription(tx, sub);
          if (practiceId) {
            const [canceledPractice] = await tx
              .update(practices)
              .set({
                subscriptionTier: "free",
                billingStatus: "canceled",
                stripeSubscriptionId: null,
                subscriptionGeneration: sql`${practices.subscriptionGeneration} + 1`,
                stripeSubscriptionSyncRevision: sql`${practices.stripeSubscriptionSyncRevision} + 1`,
              })
              .where(
                and(
                  eq(practices.id, practiceId),
                  eq(practices.stripeSubscriptionId, sub.id),
                  isNull(practices.deletedAt),
                  eq(practices.recoveryHold, false),
                  or(
                    isNull(practices.stripeQuantitySyncLeaseToken),
                    lte(
                      practices.stripeQuantitySyncLeaseExpiresAt,
                      sql`clock_timestamp()`,
                    ),
                  ),
                ),
              )
              .returning({
                id: practices.id,
                subscriptionGeneration: practices.subscriptionGeneration,
              });
            if (canceledPractice) {
              const practice = await practiceById(tx, canceledPractice.id);
              const to = billingContactEmail(practice?.email);
              if (practice && to) {
                const dedupeKey = `lc:canceled:${sub.id}`;
                await enqueueSubscriptionLifecycleEmail(tx, {
                  practiceId: practice.id,
                  practiceName: practice.name ?? "your practice",
                  recipient: to,
                  kind: "subscription_canceled",
                  subscriptionId: sub.id,
                  subscriptionGeneration:
                    canceledPractice.subscriptionGeneration,
                  dedupeKey,
                });
              }
            } else {
              const [blockedByQuantitySync] = await tx
                .select({ id: practices.id })
                .from(practices)
                .where(
                  and(
                    eq(practices.id, practiceId),
                    eq(practices.stripeSubscriptionId, sub.id),
                    isNotNull(practices.stripeQuantitySyncLeaseToken),
                    sql`${practices.stripeQuantitySyncLeaseExpiresAt} > clock_timestamp()`,
                  ),
                )
                .limit(1);
              if (blockedByQuantitySync) {
                throw new Error(
                  "Subscription cancellation conflicted with active reconciliation.",
                );
              }
            }
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
              // A successful subscription charge is a second authoritative
              // self-healing point if a subscription-created/updated event was
              // omitted or arrived out of order.
              const subscription = authorized?.subscription;
              if (!subscription || subscription.id !== subscriptionId) {
                throw new Error(
                  "Paid-invoice subscription snapshot is unavailable.",
                );
              }
              const applied = await applySubscription(
                tx,
                subscription,
                authorized!.practiceId,
                authorized!.revision,
              );
              if (!applied) {
                throw new Error(
                  "Paid-invoice subscription persistence conflicted.",
                );
              }
              subscriptionPracticeId = applied.id;
              queueQuantitySync =
                normalizeBillingStatus(subscription.status) !== "canceled";
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
              const dedupeKey = `lc:receipt:${inv.id}`;
              postCommitEffects.push(() =>
                sendLifecycleEmail({
                  practiceId: practice.id,
                  to,
                  emailType: "receipt",
                  dedupeKey,
                  category: "transactional",
                  send: () =>
                    sendPaymentReceiptEmail({
                      to,
                      practiceName,
                      amount: formatMoney(inv.amount_paid, inv.currency),
                      periodLabel: invoicePeriodLabel(inv, practice.timezone),
                      invoiceUrl: inv.hosted_invoice_url ?? undefined,
                      idempotencyKey: dedupeKey,
                    }),
                }),
              );
            }
          }
          break;
        }

        case "invoice.payment_failed": {
          const inv = event.data.object as Stripe.Invoice;
          const subscriptionId = subscriptionIdForInvoice(inv);
          if (subscriptionId) {
            const subscription = authorized?.subscription;
            if (!subscription || subscription.id !== subscriptionId) {
              throw new Error(
                "Failed-invoice subscription snapshot is unavailable.",
              );
            }
            const authoritativeStatus = normalizeBillingStatus(
              subscription.status,
            );
            const applied = await applySubscription(
              tx,
              subscription,
              authorized!.practiceId,
              authorized!.revision,
            );
            if (!applied) {
              throw new Error(
                "Failed-invoice subscription persistence conflicted.",
              );
            }
            const practiceId = applied.id;
            queueQuantitySync = authoritativeStatus !== "canceled";
            const practice = practiceId
              ? await practiceById(tx, practiceId)
              : null;
            const to = billingContactEmail(practice?.email);
            if (practice && to && authoritativeStatus === "past_due") {
              const practiceName = practice.name ?? "your practice";
              const dedupeKey = `lc:dunning:${inv.id}:${inv.attempt_count ?? 0}`;
              postCommitEffects.push(() =>
                sendLifecycleEmail({
                  practiceId: practice.id,
                  to,
                  emailType: "dunning",
                  dedupeKey,
                  category: "transactional",
                  stillEligible: async (emailTx) => {
                    const [current] = await emailTx
                      .select({ id: practices.id })
                      .from(practices)
                      .where(
                        and(
                          eq(practices.id, practice.id),
                          eq(practices.billingStatus, "past_due"),
                          eq(practices.stripeSubscriptionId, subscriptionId),
                          isNull(practices.deletedAt),
                        ),
                      )
                      .limit(1);
                    return Boolean(current);
                  },
                  send: () =>
                    sendPaymentFailedEmail({
                      to,
                      practiceName,
                      amount: formatMoney(inv.amount_due, inv.currency),
                      nextRetryDate: formatUnixDate(
                        inv.next_payment_attempt,
                        practice.timezone,
                      ),
                      idempotencyKey: dedupeKey,
                    }),
                }),
              );
            }
          }
          break;
        }

        default:
          // Ignore other event types.
          break;
      }
      if (authorized) {
        const resolved = await resolveStripeSubscriptionReconciliation(tx, {
          eventId: event.id,
          expectedRevision: authorized.revision,
          outcome: "applied",
          queueQuantitySync,
        });
        if (!resolved) {
          throw new Error("Subscription reconciliation outcome CAS was lost.");
        }
      }
    });
    for (const effect of postCommitEffects) {
      await effect();
    }
  } catch (err) {
    if (err instanceof UnmanagedStripeSubscriptionError) {
      console.info(
        `[Stripe Subscription Webhook] ignored unmanaged event type=${event.type}`,
      );
      return NextResponse.json({ received: true, ignored: true });
    }
    console.error("[Stripe Subscription Webhook] handler error:", err);
    await alertOps(
      "Subscription webhook handler error",
      `Event ${event.type} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return NextResponse.json({ error: "Handler error" }, { status: 500 });
  }

  if (!(await runDurableSubscriptionQuantitySync(event.id))) {
    return NextResponse.json(
      { error: "Subscription quantity reconciliation deferred" },
      { status: 503, headers: { "Retry-After": "300" } },
    );
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

/**
 * Authorize a specific provider read in a short transaction, perform the read
 * without any database lock, then bind the snapshot to the signed event and
 * DB-issued practice revision before the persistence transaction starts.
 */
async function prepareSubscriptionReconciliation(
  event: Stripe.Event,
  evidence?: StripeConversionEvidenceInput,
): Promise<SubscriptionPreparation> {
  let subscriptionId: string | null = null;
  let signedCustomerId: string | null = null;
  let signedPracticeId: string | null = null;
  let routingSubscription: Stripe.Subscription | null = null;

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const clientPracticeId = session.client_reference_id?.trim() || null;
    const metadataPracticeId = session.metadata?.practiceId?.trim() || null;
    if (
      clientPracticeId &&
      metadataPracticeId &&
      clientPracticeId !== metadataPracticeId
    ) {
      throw new Error("Checkout session has conflicting practice identifiers.");
    }
    signedPracticeId = clientPracticeId ?? metadataPracticeId;
    subscriptionId =
      typeof session.subscription === "string"
        ? session.subscription
        : (session.subscription?.id ?? null);
    signedCustomerId =
      typeof session.customer === "string"
        ? session.customer
        : (session.customer?.id ?? null);
    if (!signedPracticeId || !subscriptionId) return null;
  } else if (
    event.type === "customer.subscription.created" ||
    event.type === "customer.subscription.updated"
  ) {
    routingSubscription = event.data.object as Stripe.Subscription;
    subscriptionId = routingSubscription.id;
    signedCustomerId = subscriptionCustomerId(routingSubscription);
  } else if (
    event.type === "invoice.payment_failed" ||
    (event.type === "invoice.payment_succeeded" &&
      ((event.data.object as Stripe.Invoice).amount_paid ?? 0) > 0)
  ) {
    const invoice = event.data.object as Stripe.Invoice;
    subscriptionId = subscriptionIdForInvoice(invoice);
    if (!subscriptionId) return null;
    signedCustomerId =
      typeof invoice.customer === "string"
        ? invoice.customer
        : (invoice.customer?.id ?? null);
    routingSubscription = {
      id: subscriptionId,
      customer: invoice.customer,
      metadata: invoice.parent?.subscription_details?.metadata ?? {},
    } as unknown as Stripe.Subscription;
  } else {
    return null;
  }

  const authorization = await withSystem(db, async (tx) => {
    const practiceId =
      signedPracticeId ??
      (await resolvePracticeIdForSubscription(tx, routingSubscription!));
    const result = await authorizeStripeSubscriptionSync(tx, {
      eventId: event.id,
      eventType: event.type,
      practiceId,
      subscriptionId: subscriptionId!,
      ...(evidence ? { evidence } : {}),
    });
    return result.state === "duplicate"
      ? result
      : {
          state: "authorized" as const,
          practiceId,
          revision: result.revision,
        };
  });
  if (authorization.state === "duplicate") return authorization;
  if (!stripe) {
    throw new Error("Stripe is unavailable for subscription reconciliation.");
  }

  // Network boundary: no withSystem transaction is open here.
  const authoritative = await stripe.subscriptions.retrieve(subscriptionId);
  if (authoritative.id !== subscriptionId) {
    throw new Error("Stripe returned a different subscription identity.");
  }
  const authoritativeCustomerId = subscriptionCustomerId(authoritative);
  if (
    signedCustomerId &&
    authoritativeCustomerId &&
    signedCustomerId !== authoritativeCustomerId
  ) {
    throw new Error(
      "Stripe subscription customer conflicts with signed event.",
    );
  }
  const authoritativePracticeId =
    authoritative.metadata?.practiceId?.trim() || null;
  if (
    authoritativePracticeId &&
    authoritativePracticeId !== authorization.practiceId
  ) {
    throw new Error(
      "Stripe subscription practice conflicts with authorization.",
    );
  }
  return {
    state: "authorized",
    practiceId: authorization.practiceId,
    revision: authorization.revision,
    subscriptionId,
    subscription: authoritative,
  };
}

/** Apply a subscription's tier/status/trial through one shared mapping path. */
async function applySubscription(
  tx: typeof db,
  sub: Stripe.Subscription,
  practiceIdHint?: string | null,
  expectedRevision?: number,
): Promise<{ id: string; subscriptionGeneration: number } | null> {
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
  const terminalWithoutSubscriptionIdentity = billingStatus === "canceled";
  const storedSubscriptionId = terminalWithoutSubscriptionIdentity
    ? null
    : sub.id;

  const [practice] = await tx
    .update(practices)
    .set({
      ...(tier ? { subscriptionTier: tier } : {}),
      billingStatus,
      stripeSubscriptionId: storedSubscriptionId,
      subscriptionGeneration: sql`${practices.subscriptionGeneration} + case
        when ${practices.billingStatus} is distinct from ${billingStatus}
          or ${practices.stripeSubscriptionId} is distinct from ${storedSubscriptionId}
        then 1 else 0 end`,
      ...(customerId ? { stripeCustomerId: customerId } : {}),
      trialEndsAt: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
    })
    .where(
      and(
        eq(practices.id, practiceId),
        isNull(practices.deletedAt),
        eq(practices.recoveryHold, false),
        or(
          isNull(practices.stripeQuantitySyncLeaseToken),
          lte(
            practices.stripeQuantitySyncLeaseExpiresAt,
            sql`clock_timestamp()`,
          ),
        ),
        or(
          isNull(practices.stripeSubscriptionId),
          eq(practices.stripeSubscriptionId, sub.id),
        ),
        ...(expectedRevision !== undefined
          ? [eq(practices.stripeSubscriptionSyncRevision, expectedRevision)]
          : []),
      ),
    )
    .returning({
      id: practices.id,
      subscriptionGeneration: practices.subscriptionGeneration,
    });
  if (!practice) {
    console.warn(
      "[Stripe Subscription Webhook] subscription for missing/deleted practice:",
      sub.id,
      practiceId,
    );
    return null;
  }
  return practice;
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

  if (matches.length === 0) {
    throw new UnmanagedStripeSubscriptionError(sub.id);
  }
  if (matches.length > 1) {
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
