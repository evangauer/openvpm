import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refundInvalidStripeCheckoutPayment: vi.fn(),
}));

vi.mock("@/lib/stripe", () => ({
  refundInvalidStripeCheckoutPayment:
    mocks.refundInvalidStripeCheckoutPayment,
}));

const { resolveInvalidInvoiceCheckout } = await import(
  "../stripe-checkout-resolution"
);
const { auditLog } = await import("@openpims/db");

function auditDb() {
  const onConflictDoNothing = vi.fn(async () => undefined);
  const values = vi.fn((_value: unknown) => ({ onConflictDoNothing }));
  const insert = vi.fn(() => ({ values }));
  return { db: { insert }, insert, values, onConflictDoNothing };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("invalid Stripe Checkout resolution ledger", () => {
  it("persists refund outcome and context with one stable audit identity", async () => {
    mocks.refundInvalidStripeCheckoutPayment.mockResolvedValue({
      outcome: "refunded",
      refundId: "re_123",
      amountCents: 4200,
    });
    const first = auditDb();
    const second = auditDb();
    const baseInput = {
      endpoint: "client-invoice-connect" as const,
      externalId: "stripe:connect:acct_123:checkout:cs_123",
      sessionId: "cs_123",
      invoiceId: "00000000-0000-0000-0000-000000000001",
      practiceId: "00000000-0000-0000-0000-000000000002",
      connectedAccountId: "acct_123",
      amountCents: 5000,
      reason: "invoice_void",
    };

    await resolveInvalidInvoiceCheckout(first.db as never, {
      ...baseInput,
      eventId: "evt_first",
    });
    await resolveInvalidInvoiceCheckout(second.db as never, {
      ...baseInput,
      eventId: "evt_retry",
    });

    expect(mocks.refundInvalidStripeCheckoutPayment).toHaveBeenNthCalledWith(
      1,
      {
        externalId: baseInput.externalId,
        amountCents: 5000,
        idempotencyKey: `invalid:${baseInput.externalId}`,
      }
    );
    const firstAudit = first.values.mock.calls[0]![0] as Record<string, any>;
    const retryAudit = second.values.mock.calls[0]![0] as Record<string, any>;
    expect(firstAudit.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(retryAudit.id).toBe(firstAudit.id);
    expect(firstAudit.entityId).toBe(firstAudit.id);
    expect(firstAudit).toEqual(
      expect.objectContaining({
        practiceId: baseInput.practiceId,
        action: "stripe_checkout_invalid_resolved",
        entityType: "stripe_checkout_resolution",
        changes: {
          eventId: "evt_first",
          endpoint: "client-invoice-connect",
          sessionId: "cs_123",
          externalId: baseInput.externalId,
          invoiceId: baseInput.invoiceId,
          practiceId: baseInput.practiceId,
          connectedAccountId: "acct_123",
          reason: "invoice_void",
          outcome: "refunded",
          refundId: "re_123",
          refundAmountCents: 4200,
          checkoutAmountCents: 5000,
        },
      })
    );
    expect(first.onConflictDoNothing).toHaveBeenCalledWith({
      target: auditLog.id,
    });
    expect(second.onConflictDoNothing).toHaveBeenCalledWith({
      target: auditLog.id,
    });
  });
});
