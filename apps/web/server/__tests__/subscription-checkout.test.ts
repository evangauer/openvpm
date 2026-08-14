import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSubscriptionCheckoutSession: vi.fn(async () => ({
    url: "https://stripe.example/subscription-checkout",
  })),
  createBillingPortalSession: vi.fn(async () => ({
    url: "https://stripe.example/billing-portal",
  })),
  countBillableLocationsAndSeats: vi.fn(async () => ({
    locationCount: 2,
    billableSeatCount: 4,
  })),
  readBillingSyncState: vi.fn(async () => null),
  syncPracticeSubscriptionQuantities: vi.fn(),
  usageForPractice: vi.fn(async () => 0),
  recordAuditLog: vi.fn(async () => undefined),
}));

vi.mock("@/lib/stripe", () => ({
  createSubscriptionCheckoutSession: mocks.createSubscriptionCheckoutSession,
  createBillingPortalSession: mocks.createBillingPortalSession,
}));

vi.mock("@/lib/app-url", () => ({
  appBaseUrl: () => "https://app.example.com",
}));

vi.mock("@/lib/billing/subscription-sync", () => ({
  countBillableLocationsAndSeats: mocks.countBillableLocationsAndSeats,
  readBillingSyncState: mocks.readBillingSyncState,
  syncPracticeSubscriptionQuantities: mocks.syncPracticeSubscriptionQuantities,
}));

vi.mock("@/lib/billing/usage", () => ({
  usageForPractice: mocks.usageForPractice,
  currentPeriodMonth: () => "2026-06",
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: mocks.recordAuditLog,
}));

vi.mock("@/lib/tenant-db", () => ({
  withTenant: async (
    db: unknown,
    _practiceId: string,
    fn: (tx: unknown) => Promise<unknown>
  ) => fn(db),
  withSystem: async (db: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn(db),
}));

const { subscriptionRouter } = await import("../routers/subscription");
const { TRIAL_DAYS } = await import("@/lib/billing/plans");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";

function callerWithDb(db: Record<string, unknown>) {
  const session = {
    user: {
      id: USER_ID,
      email: "admin@example.com",
      name: "Admin User",
      role: "admin",
      practiceId: PRACTICE_ID,
    },
  };
  return subscriptionRouter.createCaller({ db, session } as never);
}

function createDb(selectResults: unknown[][]) {
  const results = [...selectResults];
  const select = vi.fn(() => {
    const result = results.shift() ?? [];
    const builder = {
      from: () => builder,
      where: () => builder,
      limit: () => builder,
      for: async () => result,
      then: (
        resolve: (value: unknown[]) => unknown,
        reject?: (error: unknown) => unknown,
      ) => Promise.resolve(result).then(resolve, reject),
    };
    return builder;
  });

  return {
    select,
    execute: vi.fn(async () => undefined),
    transaction: async (fn: (tx: unknown) => unknown) => fn({ select }),
  };
}

function practice(overrides: Record<string, unknown> = {}) {
  return {
    tier: "free",
    billingStatus: "none",
    trialEndsAt: null,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    email: "practice@example.com",
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.createSubscriptionCheckoutSession.mockResolvedValue({
    url: "https://stripe.example/subscription-checkout",
  });
  mocks.createBillingPortalSession.mockResolvedValue({
    url: "https://stripe.example/billing-portal",
  });
  mocks.countBillableLocationsAndSeats.mockResolvedValue({
    locationCount: 2,
    billableSeatCount: 4,
  });
  mocks.readBillingSyncState.mockResolvedValue(null);
  mocks.usageForPractice.mockResolvedValue(0);
});

describe("subscription checkout", () => {
  it("keeps active-practice invariants explicit after practice checks", () => {
    const source = readFileSync("server/routers/subscription.ts", "utf8");

    expect(source).toContain("throw practiceNotFound()");
    expect(source).toContain('tier: practice.tier ?? "free"');
    expect(source).toContain("customerId: practice.stripeCustomerId ?? undefined");
    expect(source).toContain("if (!practice.stripeCustomerId)");
    expect(source).toContain("const checkoutUrl = result?.url");
    expect(source).toContain("if (!isSafeCheckoutRedirectUrl(checkoutUrl))");
    expect(source).toContain("const portalUrl = result?.url");
    expect(source).toContain("if (!isSafeCheckoutRedirectUrl(portalUrl))");
    expect(source).not.toContain("if (!result?.url)");
    expect(source).not.toContain("if (!result)");
    expect(source).not.toContain("practice?.");
  });

  it("marks Cloud purchasable with only the location price configured", async () => {
    vi.stubEnv("HOSTED_BILLING_ENABLED", "true");
    vi.stubEnv("STRIPE_PRICE_CLOUD_LOCATION", "price_location");
    vi.stubEnv("STRIPE_PRICE_CLOUD_USER", "");

    const db = createDb([[practice()]]);
    const result = await callerWithDb(db).get();

    expect(result.billingEnforced).toBe(true);
    expect(result.plans.find((plan) => plan.tier === "cloud")).toMatchObject({
      purchasable: true,
      seatUnitPriceMonthlyUsd: 0,
    });
  });

  it("reads subscription status without syncing Stripe quantities", async () => {
    vi.stubEnv("HOSTED_BILLING_ENABLED", "true");
    vi.stubEnv("STRIPE_PRICE_CLOUD_LOCATION", "price_location");
    mocks.readBillingSyncState.mockResolvedValueOnce({
      status: "ok",
      message: "Synced 2 location(s), unlimited staff.",
      updatedAt: "2026-06-27T12:00:00.000Z",
      locationCount: 2,
      billableSeatCount: 4,
    } as never);
    const db = createDb([
      [
        practice({
          tier: "cloud",
          billingStatus: "active",
          timezone: "America/Los_Angeles",
          stripeCustomerId: "cus_123",
          stripeSubscriptionId: "sub_123",
        }),
      ],
    ]);

    await expect(callerWithDb(db).get()).resolves.toMatchObject({
      billingEnforced: true,
      hasBillingAccount: true,
      hasSubscription: true,
      locationCount: 2,
      billableSeatCount: 4,
      timezone: "America/Los_Angeles",
      billingSyncStatus: {
        status: "ok",
        message: "Synced 2 location(s), unlimited staff.",
      },
    });
    expect(mocks.syncPracticeSubscriptionQuantities).not.toHaveBeenCalled();
    expect(mocks.readBillingSyncState).toHaveBeenCalledWith(db, PRACTICE_ID);
  });

  it("rejects a second Checkout when a Stripe subscription is already connected", async () => {
    vi.stubEnv("STRIPE_PRICE_CLOUD_LOCATION", "price_location");
    const db = createDb([
      [
        practice({
          billingStatus: "trialing",
          stripeCustomerId: "cus_123",
          stripeSubscriptionId: "sub_123",
        }),
      ],
    ]);

    await expect(
      callerWithDb(db).createCheckout({ tier: "cloud" })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message:
        "A subscription is already connected. Manage it from Plan & Billing.",
    });
    expect(mocks.createSubscriptionCheckoutSession).not.toHaveBeenCalled();
    expect(mocks.countBillableLocationsAndSeats).not.toHaveBeenCalled();
  });

  it("does not call Stripe checkout or portal providers while held", async () => {
    vi.stubEnv("STRIPE_PRICE_CLOUD_LOCATION", "price_location");
    const db = createDb([
      [practice({ recoveryHold: true })],
      [practice({ stripeCustomerId: "cus_123", recoveryHold: true })],
    ]);
    const caller = callerWithDb(db);

    await expect(
      caller.createCheckout({ tier: "cloud" }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(caller.openBillingPortal()).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(mocks.createSubscriptionCheckoutSession).not.toHaveBeenCalled();
    expect(mocks.createBillingPortalSession).not.toHaveBeenCalled();
  });

  it("rejects billing reads and actions when the practice is missing or deleted", async () => {
    vi.stubEnv("STRIPE_PRICE_CLOUD_LOCATION", "price_location");
    const db = createDb([[], [], []]);
    const caller = callerWithDb(db);

    await expect(caller.get()).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    await expect(caller.createCheckout({ tier: "cloud" })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    await expect(caller.openBillingPortal()).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    expect(mocks.countBillableLocationsAndSeats).not.toHaveBeenCalled();
    expect(mocks.readBillingSyncState).not.toHaveBeenCalled();
    expect(mocks.createSubscriptionCheckoutSession).not.toHaveBeenCalled();
    expect(mocks.createBillingPortalSession).not.toHaveBeenCalled();
  });

  it("starts a card-collected trial checkout for practices without a prior trial", async () => {
    vi.stubEnv("STRIPE_PRICE_CLOUD_LOCATION", "price_location");

    const db = createDb([[practice()]]);

    await expect(
      callerWithDb(db).createCheckout({ tier: "cloud" })
    ).resolves.toEqual({ url: "https://stripe.example/subscription-checkout" });

    expect(mocks.createSubscriptionCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        lineItems: [{ priceId: "price_location", quantity: 2 }],
        practiceId: PRACTICE_ID,
        customerId: undefined,
        customerEmail: "practice@example.com",
        trialEnd: null,
        trialPeriodDays: TRIAL_DAYS,
        billingCadence: "month",
        source: "settings",
        successUrl:
          "https://app.example.com/settings?tab=billing&checkout=success&plan=month",
        cancelUrl:
          "https://app.example.com/settings?tab=billing&checkout=cancelled&plan=month",
      })
    );
  });

  it("uses the configured annual price when annual billing is selected", async () => {
    vi.stubEnv("STRIPE_PRICE_CLOUD_LOCATION", "price_monthly");
    vi.stubEnv("STRIPE_PRICE_CLOUD_LOCATION_ANNUAL", "price_annual");
    const db = createDb([[practice({ billingStatus: "trialing" })]]);

    await expect(
      callerWithDb(db).createCheckout({
        tier: "cloud",
        billingCadence: "year",
      }),
    ).resolves.toEqual({ url: "https://stripe.example/subscription-checkout" });

    expect(mocks.createSubscriptionCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        lineItems: [{ priceId: "price_annual", quantity: 2 }],
        billingCadence: "year",
        source: "settings",
      }),
    );
  });

  it("normalizes checkout billing contacts and falls back to the admin email", async () => {
    vi.stubEnv("STRIPE_PRICE_CLOUD_LOCATION", "price_location");

    const db = createDb([
      [
        practice({
          email: " Practice.Owner@Example.COM ",
        }),
      ],
      [
        practice({
          email: "   ",
        }),
      ],
    ]);
    const caller = callerWithDb(db);

    await expect(caller.createCheckout({ tier: "cloud" })).resolves.toEqual({
      url: "https://stripe.example/subscription-checkout",
    });
    await expect(caller.createCheckout({ tier: "cloud" })).resolves.toEqual({
      url: "https://stripe.example/subscription-checkout",
    });

    expect(mocks.createSubscriptionCheckoutSession).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        customerEmail: "practice.owner@example.com",
      })
    );
    expect(mocks.createSubscriptionCheckoutSession).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        customerEmail: "admin@example.com",
      })
    );
  });

  it("continues the active trial end instead of granting a fresh trial", async () => {
    vi.stubEnv("STRIPE_PRICE_CLOUD_LOCATION", "price_location");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-27T12:00:00Z"));
    const trialEndsAt = new Date("2026-07-04T12:00:00Z");
    const db = createDb([
      [
        practice({
          billingStatus: "trialing",
          trialEndsAt,
          stripeCustomerId: "cus_123",
        }),
      ],
    ]);

    await expect(
      callerWithDb(db).createCheckout({ tier: "cloud" })
    ).resolves.toEqual({ url: "https://stripe.example/subscription-checkout" });

    expect(mocks.createSubscriptionCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: "cus_123",
        trialEnd: trialEndsAt,
        trialPeriodDays: undefined,
      })
    );
  });

  it("does not restart an expired historical trial", async () => {
    vi.stubEnv("STRIPE_PRICE_CLOUD_LOCATION", "price_location");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-27T12:00:00Z"));
    const db = createDb([
      [
        practice({
          billingStatus: "trialing",
          trialEndsAt: new Date("2026-06-01T12:00:00Z"),
        }),
      ],
    ]);

    await expect(
      callerWithDb(db).createCheckout({ tier: "cloud" })
    ).resolves.toEqual({ url: "https://stripe.example/subscription-checkout" });

    expect(mocks.createSubscriptionCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        trialEnd: null,
        trialPeriodDays: undefined,
      })
    );
  });

  it("fails closed when Stripe does not return a hosted checkout URL", async () => {
    vi.stubEnv("STRIPE_PRICE_CLOUD_LOCATION", "price_location");
    mocks.createSubscriptionCheckoutSession.mockResolvedValueOnce({
      url: null,
    } as never);
    const db = createDb([[practice()]]);

    await expect(
      callerWithDb(db).createCheckout({ tier: "cloud" })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "Billing is not configured on this server.",
    });
  });

  it("fails closed when Stripe returns an unsafe hosted checkout URL", async () => {
    vi.stubEnv("STRIPE_PRICE_CLOUD_LOCATION", "price_location");
    mocks.createSubscriptionCheckoutSession.mockResolvedValueOnce({
      url: "http://stripe.example/subscription-checkout",
    } as never);
    const db = createDb([[practice()]]);

    await expect(
      callerWithDb(db).createCheckout({ tier: "cloud" })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "Billing is not configured on this server.",
    });
  });

  it("fails closed when Stripe returns an unsafe billing portal URL", async () => {
    mocks.createBillingPortalSession.mockResolvedValueOnce({
      url: "javascript:alert(1)",
    } as never);
    const db = createDb([[practice({ stripeCustomerId: "cus_123" })]]);

    await expect(callerWithDb(db).openBillingPortal()).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "Billing is not configured on this server.",
    });
  });
});
