import type { Database } from "@openpims/db/client";
import { stripeEvents } from "@openpims/db";
import { and, eq, isNull, or } from "drizzle-orm";

export type StripeConversionEvidenceInput = {
  eventCreatedAt: Date;
  objectId: string;
  evidenceKind:
    | "subscription_checkout_completed"
    | "positive_subscription_invoice_paid";
  amountCents?: number | null;
  currency?: string | null;
};

/**
 * Claim a Stripe webhook event inside the caller's transaction.
 *
 * Returns false for a duplicate event-id/endpoint pair, allowing each Stripe
 * surface to inspect shared event types independently while still making
 * redelivery to the same endpoint idempotent.
 */
export async function claimStripeEvent(
  db: Database,
  opts: {
    eventId: string;
    endpoint: "client-invoice" | "client-invoice-connect" | "subscription";
    eventType: string;
    evidence?: StripeConversionEvidenceInput;
  }
): Promise<boolean> {
  const rows = await db
    .insert(stripeEvents)
    .values({
      eventId: opts.eventId,
      endpoint: opts.endpoint,
      eventType: opts.eventType,
      ...(opts.evidence
        ? {
            eventCreatedAt: opts.evidence.eventCreatedAt,
            objectId: opts.evidence.objectId,
            evidenceKind: opts.evidence.evidenceKind,
            amountCents: opts.evidence.amountCents ?? null,
            currency: opts.evidence.currency ?? null,
          }
        : {}),
    })
    .onConflictDoNothing()
    .returning({ eventId: stripeEvents.eventId });

  return rows.length > 0;
}

/**
 * Attach a verified Stripe claim to the active practice resolved by the
 * authoritative webhook transaction. The row is not externally visible and
 * stores no customer/contact payload.
 */
export async function attachStripeEventPractice(
  db: Database,
  opts: {
    eventId: string;
    endpoint: "subscription";
    practiceId: string;
  },
): Promise<void> {
  const rows = await db
    .update(stripeEvents)
    .set({ practiceId: opts.practiceId })
    .where(
      and(
        eq(stripeEvents.eventId, opts.eventId),
        eq(stripeEvents.endpoint, opts.endpoint),
        or(
          isNull(stripeEvents.practiceId),
          eq(stripeEvents.practiceId, opts.practiceId),
        ),
      ),
    )
    .returning({ eventId: stripeEvents.eventId });

  if (rows.length !== 1) {
    throw new Error(
      `Stripe event ${opts.eventId} is missing or already belongs to a different practice.`,
    );
  }
}
