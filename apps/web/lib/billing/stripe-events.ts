import type { Database } from "@openpims/db/client";
import { stripeEvents } from "@openpims/db";

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
  }
): Promise<boolean> {
  const rows = await db
    .insert(stripeEvents)
    .values({
      eventId: opts.eventId,
      endpoint: opts.endpoint,
      eventType: opts.eventType,
    })
    .onConflictDoNothing()
    .returning({ eventId: stripeEvents.eventId });

  return rows.length > 0;
}
