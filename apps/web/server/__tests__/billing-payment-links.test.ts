import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createToken: vi.fn(() => "v1.payment-token.signature"),
}));

vi.mock("@/lib/billing/invoice-payment-tokens", () => ({
  createInvoicePaymentToken: mocks.createToken,
  INVOICE_PAYMENT_TOKEN_TTL_MS: 30 * 24 * 60 * 60 * 1_000,
}));

vi.mock("@/lib/stripe", () => ({
  createCheckoutSession: vi.fn(),
  createConnectAccount: vi.fn(),
  createConnectAccountLink: vi.fn(),
  createConnectLoginLink: vi.fn(),
  isMissingStripeConnectedAccountError: vi.fn(() => false),
  refundStripeCheckoutPayment: vi.fn(),
  retrieveConnectAccount: vi.fn(),
}));

vi.mock("@/lib/recovery-hold", () => ({
  RECOVERY_HOLD_BLOCK_MESSAGE: "recovery hold",
  lockPracticeForExternalSideEffects: vi.fn(async () => true),
}));

const { billingRouter } = await import("../routers/billing");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const INVOICE_ID = "00000000-0000-0000-0000-000000000002";
const CLIENT_ID = "00000000-0000-0000-0000-000000000003";

function createDb(invoiceStatus: "draft" | "sent" | "overdue") {
  const results = [
    [{ id: PRACTICE_ID }],
    [
      {
        id: INVOICE_ID,
        clientId: CLIENT_ID,
        status: invoiceStatus,
        isEstimate: false,
        appointmentId: null,
      },
    ],
  ];
  const select = vi.fn(() => {
    const result = results.shift() ?? [];
    const builder = {
      from: vi.fn(() => builder),
      where: vi.fn(() => builder),
      limit: vi.fn(async () => result),
    };
    return builder;
  });
  const insertedValues: unknown[] = [];
  const insert = vi.fn(() => ({
    values: vi.fn(async (value: unknown) => {
      insertedValues.push(value);
    }),
  }));
  const db: Record<string, unknown> = {
    select,
    insert,
    execute: vi.fn(async () => undefined),
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return { db, insertedValues };
}

function callerWithDb(db: Record<string, unknown>) {
  return billingRouter.createCaller({
    db,
    session: {
      user: {
        id: USER_ID,
        email: "frontdesk@example.com",
        name: "Front Desk",
        role: "front_desk",
        practiceId: PRACTICE_ID,
      },
    },
  } as never);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("invoice-only payment links", () => {
  it("creates an audited, bounded relative link for a sent invoice", async () => {
    const { db, insertedValues } = createDb("sent");

    await expect(
      callerWithDb(db).createInvoicePaymentLink({ invoiceId: INVOICE_ID }),
    ).resolves.toEqual({
      path: "/pay/v1.payment-token.signature",
      expiresInDays: 30,
    });
    expect(mocks.createToken).toHaveBeenCalledWith({
      invoiceId: INVOICE_ID,
      clientId: CLIENT_ID,
      practiceId: PRACTICE_ID,
    });
    expect(insertedValues).toContainEqual(
      expect.objectContaining({
        action: "invoice_payment_link_created",
        entityId: INVOICE_ID,
        changes: {
          paymentLinkScope: "invoice_only",
          paymentLinkTtlDays: 30,
        },
      }),
    );
    expect(JSON.stringify(insertedValues)).not.toContain("payment-token");
  });

  it("does not issue a link before an invoice is sent", async () => {
    const { db, insertedValues } = createDb("draft");

    await expect(
      callerWithDb(db).createInvoicePaymentLink({ invoiceId: INVOICE_ID }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "Send the invoice before sharing its payment link.",
    });
    expect(mocks.createToken).not.toHaveBeenCalled();
    expect(insertedValues).toEqual([]);
  });
});
