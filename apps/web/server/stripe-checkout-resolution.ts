import { createHash } from "node:crypto";
import { auditLog } from "@openpims/db";
import type { Database } from "@openpims/db/client";
import { refundInvalidStripeCheckoutPayment } from "@/lib/stripe";

export type StripeCheckoutResolution = Awaited<
  ReturnType<typeof refundInvalidStripeCheckoutPayment>
>;

function resolutionAuditId(externalId: string): string {
  const digest = createHash("sha256")
    .update(`openvpm:stripe-checkout-resolution:${externalId}`)
    .digest("hex");
  const variant = ((Number.parseInt(digest[16]!, 16) & 0x3) | 0x8).toString(16);

  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `5${digest.slice(13, 16)}`,
    `${variant}${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");
}

/**
 * Resolve an invalid invoice Checkout and durably record the result.
 *
 * The caller must pass its active webhook transaction. Stripe runs before the
 * audit insert, so a failed DB commit can be retried safely: the external call
 * uses a stable Stripe idempotency key and the audit row uses a deterministic
 * primary key. A retry therefore converges on one external resolution and one
 * durable, truthful final-state record without requiring another migration.
 */
export async function resolveInvalidInvoiceCheckout(
  db: Database,
  input: {
    eventId: string;
    endpoint: "client-invoice" | "client-invoice-connect";
    externalId: string;
    sessionId: string;
    invoiceId?: string | null;
    practiceId?: string | null;
    connectedAccountId?: string | null;
    amountCents: number;
    reason: string;
  }
): Promise<StripeCheckoutResolution> {
  const resolution = await refundInvalidStripeCheckoutPayment({
    externalId: input.externalId,
    amountCents: input.amountCents,
    idempotencyKey: `invalid:${input.externalId}`,
  });
  const refunded = resolution.outcome === "refunded" ? resolution : null;
  const auditId = resolutionAuditId(input.externalId);

  await db
    .insert(auditLog)
    .values({
      id: auditId,
      practiceId: input.practiceId ?? null,
      action: "stripe_checkout_invalid_resolved",
      entityType: "stripe_checkout_resolution",
      entityId: auditId,
      changes: {
        eventId: input.eventId,
        endpoint: input.endpoint,
        sessionId: input.sessionId,
        externalId: input.externalId,
        invoiceId: input.invoiceId ?? null,
        practiceId: input.practiceId ?? null,
        connectedAccountId: input.connectedAccountId ?? null,
        reason: input.reason,
        outcome: resolution.outcome,
        refundId: refunded?.refundId ?? null,
        refundAmountCents: refunded?.amountCents ?? null,
        checkoutAmountCents: input.amountCents,
      },
    })
    .onConflictDoNothing({ target: auditLog.id });

  return resolution;
}
