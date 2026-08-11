import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createCheckoutSession: vi.fn(async () => ({ url: "https://stripe.example/checkout" })),
  recordAuditLog: vi.fn(async () => undefined),
  lockPracticeForExternalSideEffects: vi.fn(async () => true),
}));

vi.mock("@/lib/stripe", () => ({
  createCheckoutSession: mocks.createCheckoutSession,
}));

vi.mock("@/lib/app-url", () => ({
  appBaseUrl: () => "https://app.example.com",
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: mocks.recordAuditLog,
}));

vi.mock("@/lib/recovery-hold", () => ({
  RECOVERY_HOLD_BLOCK_MESSAGE: "recovery hold",
  lockPracticeForExternalSideEffects:
    mocks.lockPracticeForExternalSideEffects,
}));

const { billingRouter } = await import("../routers/billing");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const INVOICE_ID = "00000000-0000-0000-0000-000000000002";
const APPOINTMENT_ID = "00000000-0000-0000-0000-000000000003";

const baseInvoice = {
  id: INVOICE_ID,
  total: "100.00",
  paidAmount: "25.00",
  status: "sent",
  isEstimate: false,
  clientFirstName: "Jane",
  clientLastName: "Client",
  clientEmail: "jane@example.com",
  patientName: "Biscuit",
  currency: "usd",
};

const activePaymentAccount = {
  id: "00000000-0000-0000-0000-0000000000cc",
  practiceId: PRACTICE_ID,
  provider: "stripe_connect",
  stripeAccountId: "acct_123",
  onboardingStatus: "active",
  chargesEnabled: true,
  payoutsEnabled: true,
  detailsSubmitted: true,
  requirementsCurrentlyDue: [],
  requirementsDisabledReason: null,
  lastSyncedAt: new Date("2026-06-30T12:00:00Z"),
  createdAt: new Date("2026-06-30T12:00:00Z"),
  updatedAt: new Date("2026-06-30T12:00:00Z"),
  deletedAt: null,
};

const activeHostedPractice = {
  tier: "cloud",
  billingStatus: "active",
  trialEndsAt: null,
};

function callerWithDb(
  db: Record<string, unknown>,
  role: "admin" | "front_desk" | "veterinarian" = "front_desk"
) {
  const session = {
    user: {
      id: USER_ID,
      email: "frontdesk@example.com",
      name: "Front Desk",
      role,
      practiceId: PRACTICE_ID,
    },
  };
  return billingRouter.createCaller({ db, session } as never);
}

function thenableRows(result: unknown[]) {
  const rows = {
    limit: vi.fn(() => rows),
    for: vi.fn(async () => result),
    then: (
      resolve: (value: unknown[]) => unknown,
      reject?: (e: unknown) => unknown
    ) => Promise.resolve(result).then(resolve, reject),
  };
  return rows;
}

function createDb(selectResults: unknown[][]) {
  const results = [...selectResults];
  const select = vi.fn(() => {
    const result = results.shift() ?? [];
    const afterWhere = thenableRows(result);
    const builder = {
      from: vi.fn(() => builder),
      innerJoin: vi.fn(() => builder),
      leftJoin: vi.fn(() => builder),
      where: vi.fn(() => afterWhere),
      limit: vi.fn(async () => result),
    };
    return builder;
  });

  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    execute: vi.fn(async () => undefined),
    select,
  };

  return { db, select };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.createCheckoutSession.mockResolvedValue({
    url: "https://stripe.example/checkout",
  });
});

describe("billing card checkout", () => {
  it("does not call Stripe checkout while the practice is held", async () => {
    mocks.lockPracticeForExternalSideEffects.mockResolvedValueOnce(false);
    const { db, select } = createDb([]);

    await expect(
      callerWithDb(db).createCardPaymentCheckout({ invoiceId: INVOICE_ID }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    expect(select).not.toHaveBeenCalled();
    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("keeps card checkout limited to billing roles", async () => {
    const { db, select } = createDb([[baseInvoice]]);

    await expect(
      callerWithDb(db, "veterinarian").createCardPaymentCheckout({
        invoiceId: INVOICE_ID,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(select).not.toHaveBeenCalled();
    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("reports whether card payment checkout is configured", async () => {
    const { db } = createDb([]);

    vi.stubEnv("STRIPE_SECRET_KEY", "");
    await expect(callerWithDb(db).cardPaymentStatus()).resolves.toMatchObject({
      enabled: false,
      stripeConfigured: false,
      connectRequired: false,
    });

    vi.stubEnv("STRIPE_SECRET_KEY", "   ");
    await expect(callerWithDb(db).cardPaymentStatus()).resolves.toMatchObject({
      enabled: false,
      stripeConfigured: false,
      connectRequired: false,
    });

    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_123");
    await expect(callerWithDb(db).cardPaymentStatus()).resolves.toMatchObject({
      enabled: true,
      stripeConfigured: true,
      connectRequired: false,
      status: "not_required",
    });
  });

  it("requires an active Stripe Connect account for hosted card checkout status", async () => {
    vi.stubEnv("HOSTED_BILLING_ENABLED", "true");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_123");

    const { db } = createDb([[activePaymentAccount]]);

    await expect(callerWithDb(db).cardPaymentStatus()).resolves.toMatchObject({
      enabled: true,
      stripeConfigured: true,
      connectRequired: true,
      status: "active",
      chargesEnabled: true,
      payoutsEnabled: true,
    });
  });

  it("rejects checkout for invoices outside the current practice", async () => {
    const { db } = createDb([[]]);

    await expect(
      callerWithDb(db).createCardPaymentCheckout({ invoiceId: INVOICE_ID })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("rejects checkout for estimates", async () => {
    const { db } = createDb([[{ ...baseInvoice, isEstimate: true }]]);

    await expect(
      callerWithDb(db).createCardPaymentCheckout({ invoiceId: INVOICE_ID })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("rejects checkout for draft invoices", async () => {
    const { db } = createDb([[{ ...baseInvoice, status: "draft" }]]);

    await expect(
      callerWithDb(db).createCardPaymentCheckout({ invoiceId: INVOICE_ID })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Mark the invoice as sent before recording payment.",
    });

    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("rejects checkout until an appointment-linked visit is finalized", async () => {
    const visitInvoice = { ...baseInvoice, appointmentId: APPOINTMENT_ID };
    const { db } = createDb([
      [visitInvoice],
      [{ id: APPOINTMENT_ID }],
      [visitInvoice],
      [{ status: "draft" }],
    ]);

    await expect(
      callerWithDb(db).createCardPaymentCheckout({ invoiceId: INVOICE_ID })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message:
        "Finalize the clinical handoff before sending or collecting this visit invoice.",
    });
    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("starts Stripe Checkout for the adjusted invoice balance", async () => {
    const { db } = createDb([[baseInvoice], [{ amount: "30.00" }]]);

    await expect(
      callerWithDb(db).createCardPaymentCheckout({ invoiceId: INVOICE_ID })
    ).resolves.toEqual({ url: "https://stripe.example/checkout" });

    expect(mocks.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        invoiceId: INVOICE_ID,
        amount: 4500,
        clientEmail: "jane@example.com",
        clientName: "Jane Client",
        description: "Invoice payment for Biscuit",
        currency: "usd",
        successUrl: `https://app.example.com/billing?payment=success&invoice=${INVOICE_ID}`,
        cancelUrl: `https://app.example.com/billing?payment=cancelled&invoice=${INVOICE_ID}`,
      })
    );
  });

  it("returns appointment-linked checkout to the same visit with payment status", async () => {
    const visitInvoice = { ...baseInvoice, appointmentId: APPOINTMENT_ID };
    const { db } = createDb([
      [visitInvoice],
      [{ id: APPOINTMENT_ID }],
      [visitInvoice],
      [{ status: "completed" }],
      [],
    ]);

    await expect(
      callerWithDb(db).createCardPaymentCheckout({ invoiceId: INVOICE_ID })
    ).resolves.toEqual({ url: "https://stripe.example/checkout" });

    expect(mocks.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        successUrl:
          `https://app.example.com/encounters/${APPOINTMENT_ID}` +
          `?payment=success&invoice=${INVOICE_ID}#charge-capture`,
        cancelUrl:
          `https://app.example.com/encounters/${APPOINTMENT_ID}` +
          `?payment=cancelled&invoice=${INVOICE_ID}#charge-capture`,
      })
    );
  });

  it("starts hosted Stripe Checkout on the clinic connected account", async () => {
    vi.stubEnv("HOSTED_BILLING_ENABLED", "true");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_123");
    const { db } = createDb([
      [activeHostedPractice],
      [baseInvoice],
      [],
      [activePaymentAccount],
    ]);

    await expect(
      callerWithDb(db).createCardPaymentCheckout({ invoiceId: INVOICE_ID })
    ).resolves.toEqual({ url: "https://stripe.example/checkout" });

    expect(mocks.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        invoiceId: INVOICE_ID,
        amount: 7500,
        connectedAccountId: "acct_123",
        applicationFeeAmount: undefined,
      })
    );
  });

  it("rejects hosted card checkout until Stripe Connect setup is active", async () => {
    vi.stubEnv("HOSTED_BILLING_ENABLED", "true");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_123");
    const { db } = createDb([[activeHostedPractice], [baseInvoice], [], []]);

    await expect(
      callerWithDb(db).createCardPaymentCheckout({ invoiceId: INVOICE_ID })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("rejects checkout when credits already settle the invoice", async () => {
    const { db } = createDb([[baseInvoice], [{ amount: "75.00" }]]);

    await expect(
      callerWithDb(db).createCardPaymentCheckout({ invoiceId: INVOICE_ID })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("fails closed when Stripe is not configured", async () => {
    mocks.createCheckoutSession.mockResolvedValueOnce(null as never);
    const { db } = createDb([[baseInvoice], []]);

    await expect(
      callerWithDb(db).createCardPaymentCheckout({ invoiceId: INVOICE_ID })
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });

  it("fails closed when Stripe returns an unsafe checkout URL", async () => {
    mocks.createCheckoutSession.mockResolvedValueOnce({
      url: "https://user:pass@stripe.example/checkout",
    } as never);
    const { db } = createDb([[baseInvoice], []]);

    await expect(
      callerWithDb(db).createCardPaymentCheckout({ invoiceId: INVOICE_ID })
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });
});
