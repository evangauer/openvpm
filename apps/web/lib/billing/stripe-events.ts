import type { Database } from "@openpims/db/client";
import { stripeEvents } from "@openpims/db";

/**
 * Claim a Stripe webhook event inside the caller's transaction.
 *
 * Returns false for duplicate event ids, allowing webhook handlers to skip
 * money/subscription side effects without treating Stripe redelivery as an error.
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
