import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rateLimit: vi.fn(async () => ({
    success: true,
    remaining: 119,
    resetAt: new Date("2026-07-01T12:15:00Z"),
  })),
  billingEnforced: vi.fn(() => false),
  hasHostedFullAccess: vi.fn(() => true),
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: mocks.rateLimit,
}));

vi.mock("@/lib/billing/plans", () => ({
  billingEnforced: mocks.billingEnforced,
  hasHostedFullAccess: mocks.hasHostedFullAccess,
}));

const { portalRouter } = await import("../routers/portal");

const TOKEN = "portal-token";
const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const CLIENT_ID = "00000000-0000-0000-0000-0000000000bb";
const INVOICE_ID = "00000000-0000-0000-0000-000000000001";
const ACTIVE_PRACTICE = [{ id: PRACTICE_ID }];

function callerWithDb(db: Record<string, unknown>) {
  return portalRouter.createCaller({
    db,
    portalSessionId: TOKEN,
    portalClient: {
      id: CLIENT_ID,
      practiceId: PRACTICE_ID,
      firstName: "Portal",
      lastName: "Client",
      email: "portal@example.test",
      phone: null,
    },
  } as never);
}

function createDb(selectResults: unknown[][]) {
  const results = [...selectResults];
  const select = vi.fn(() => {
    const result = results.shift() ?? [];
    const afterWhere = {
      limit: vi.fn(async () => result),
      orderBy: vi.fn(async () => result),
      then: (
        resolve: (value: unknown[]) => unknown,
        reject?: (error: unknown) => unknown
      ) => Promise.resolve(result).then(resolve, reject),
    };
    const builder = {
      from: vi.fn(() => builder),
      leftJoin: vi.fn(() => builder),
      where: vi.fn(() => afterWhere),
      orderBy: vi.fn(async () => result),
      limit: vi.fn(async () => result),
    };
    return builder;
  });
  const db: Record<string, unknown> = {
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
    execute: vi.fn(async () => undefined),
    select,
  };
  return { db, select };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.billingEnforced.mockReturnValue(false);
  mocks.hasHostedFullAccess.mockReturnValue(true);
});

describe("portal invoices", () => {
  it("returns active practice currency and timezone with portal invoices", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "   ");
    const { db } = createDb([
      [{ id: CLIENT_ID, practiceId: PRACTICE_ID }],
      ACTIVE_PRACTICE,
      [
        {
          currency: "cad",
          country: "CA",
          timezone: "America/Toronto",
        },
      ],
      [
        {
          id: INVOICE_ID,
          status: "sent",
          subtotal: "100.00",
          tax: "13.00",
          total: "113.00",
          paidAmount: "50.00",
          adjustedAmount: "10.00",
          dueDate: "2026-07-15",
          createdAt: new Date("2026-07-01T12:00:00Z"),
          isEstimate: false,
          patientName: "Juniper",
        },
      ],
    ]);

    await expect(callerWithDb(db).getInvoices({ token: TOKEN })).resolves.toEqual([
      expect.objectContaining({
        id: INVOICE_ID,
        currency: "cad",
        country: "CA",
        timezone: "America/Toronto",
        balanceDue: "53.00",
        onlinePaymentsEnabled: false,
      }),
    ]);
  });

  it("marks portal online payments enabled only when Stripe is configured", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", " sk_test_123 ");
    const { db } = createDb([
      [{ id: CLIENT_ID, practiceId: PRACTICE_ID }],
      ACTIVE_PRACTICE,
      [
        {
          currency: "usd",
          country: "US",
          timezone: "America/New_York",
          tier: "cloud",
          billingStatus: "active",
          trialEndsAt: null,
        },
      ],
      [
        {
          id: INVOICE_ID,
          status: "sent",
          subtotal: "100.00",
          tax: "0.00",
          total: "100.00",
          paidAmount: "0.00",
          adjustedAmount: "0.00",
          dueDate: "2026-07-15",
          createdAt: new Date("2026-07-01T12:00:00Z"),
          isEstimate: false,
          patientName: "Juniper",
        },
      ],
    ]);

    await expect(callerWithDb(db).getInvoices({ token: TOKEN })).resolves.toEqual([
      expect.objectContaining({
        id: INVOICE_ID,
        onlinePaymentsEnabled: true,
      }),
    ]);
  });

  it("hosted: advertises portal payments only with a chargeable Connect account", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", " sk_test_123 ");
    mocks.billingEnforced.mockReturnValue(true);
    mocks.hasHostedFullAccess.mockReturnValue(true);
    const invoiceRow = {
      id: INVOICE_ID,
      status: "sent",
      subtotal: "100.00",
      tax: "0.00",
      total: "100.00",
      paidAmount: "0.00",
      adjustedAmount: "0.00",
      dueDate: "2026-07-15",
      createdAt: new Date("2026-07-01T12:00:00Z"),
      isEstimate: false,
      patientName: "Juniper",
    };
    const practiceRow = {
      currency: "usd",
      country: "US",
      timezone: "America/New_York",
      tier: "cloud",
      billingStatus: "active",
      trialEndsAt: null,
    };

    const withConnect = createDb([
      [{ id: CLIENT_ID, practiceId: PRACTICE_ID }],
      ACTIVE_PRACTICE,
      [practiceRow],
      [
        {
          stripeAccountId: "acct_123",
          onboardingStatus: "active",
          chargesEnabled: true,
          payoutsEnabled: true,
        },
      ],
      [invoiceRow],
    ]);
    await expect(
      callerWithDb(withConnect.db).getInvoices({ token: TOKEN })
    ).resolves.toEqual([
      expect.objectContaining({ id: INVOICE_ID, onlinePaymentsEnabled: true }),
    ]);

    const withoutConnect = createDb([
      [{ id: CLIENT_ID, practiceId: PRACTICE_ID }],
      ACTIVE_PRACTICE,
      [practiceRow],
      [],
      [invoiceRow],
    ]);
    await expect(
      callerWithDb(withoutConnect.db).getInvoices({ token: TOKEN })
    ).resolves.toEqual([
      expect.objectContaining({ id: INVOICE_ID, onlinePaymentsEnabled: false }),
    ]);
  });

  it("does not advertise portal payments when hosted billing has gated the practice", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", " sk_test_123 ");
    mocks.billingEnforced.mockReturnValue(true);
    mocks.hasHostedFullAccess.mockReturnValue(false);
    const trialEndsAt = new Date("2026-06-01T12:00:00Z");
    const { db } = createDb([
      [{ id: CLIENT_ID, practiceId: PRACTICE_ID }],
      ACTIVE_PRACTICE,
      [
        {
          currency: "usd",
          country: "US",
          timezone: "America/New_York",
          tier: "free",
          billingStatus: "past_due",
          trialEndsAt,
        },
      ],
      [
        {
          id: INVOICE_ID,
          status: "sent",
          subtotal: "100.00",
          tax: "0.00",
          total: "100.00",
          paidAmount: "0.00",
          adjustedAmount: "0.00",
          dueDate: "2026-07-15",
          createdAt: new Date("2026-07-01T12:00:00Z"),
          isEstimate: false,
          patientName: "Juniper",
        },
      ],
    ]);

    await expect(callerWithDb(db).getInvoices({ token: TOKEN })).resolves.toEqual([
      expect.objectContaining({
        id: INVOICE_ID,
        onlinePaymentsEnabled: false,
      }),
    ]);
    expect(mocks.hasHostedFullAccess).toHaveBeenCalledWith(
      "free",
      "past_due",
      trialEndsAt,
      expect.any(Date),
      true
    );
  });

  it("rejects invoice reads when the practice becomes inactive before config lookup", async () => {
    const { db, select } = createDb([
      [{ id: CLIENT_ID, practiceId: PRACTICE_ID }],
      ACTIVE_PRACTICE,
      [],
    ]);

    await expect(callerWithDb(db).getInvoices({ token: TOKEN })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Invalid portal link",
    });

    expect(select).toHaveBeenCalledTimes(3);
  });
});
