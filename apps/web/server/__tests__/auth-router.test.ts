import { afterEach, describe, expect, it, vi } from "vitest";
import { users } from "@openpims/db";

const mocks = vi.hoisted(() => ({
  rateLimit: vi.fn(async () => ({
    success: true,
    remaining: 4,
    resetAt: new Date(),
  })),
  createAuthToken: vi.fn(async () => "token-123"),
  consumeAuthToken: vi.fn(),
  sendPasswordResetEmail: vi.fn(async () => ({ success: true })),
  sendTrackedVerificationEmail: vi.fn(
    async (): Promise<{
      success: boolean;
      provider: "resend" | "console";
      outcome: "accepted" | "definite_failure" | "outcome_unknown";
      possiblySent: boolean;
      evidencePersisted: boolean;
    }> => ({
      success: true,
      provider: "resend",
      outcome: "accepted",
      possiblySent: false,
      evidencePersisted: true,
    }),
  ),
  sendWelcomeEmail: vi.fn(async () => ({ success: true })),
  createSubscriptionCheckoutSession: vi.fn(async () => ({
    url: "https://stripe.example/signup-checkout",
  })),
  seedPractice: vi.fn(async () => undefined),
  seedDemoData: vi.fn(async () => ({})),
  billingEnforced: vi.fn(() => false),
  noCardTrialEnabled: vi.fn(() => false),
  recordAuditLog: vi.fn(async () => undefined),
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: mocks.rateLimit,
}));

vi.mock("@/lib/auth-tokens", () => ({
  createAuthToken: mocks.createAuthToken,
  consumeAuthToken: mocks.consumeAuthToken,
}));

vi.mock("@/lib/email", () => ({
  sendPasswordResetEmail: mocks.sendPasswordResetEmail,
  sendWelcomeEmail: mocks.sendWelcomeEmail,
}));

vi.mock("@/lib/auth-email-delivery", () => ({
  sendTrackedVerificationEmail: mocks.sendTrackedVerificationEmail,
}));

vi.mock("@/lib/onboarding/defaults", () => ({
  seedPractice: mocks.seedPractice,
  seedDemoData: mocks.seedDemoData,
}));

vi.mock("@/lib/billing/plans", () => ({
  billingEnforced: mocks.billingEnforced,
  noCardTrialEnabled: mocks.noCardTrialEnabled,
  trialEndsAtFrom: (from = new Date()) =>
    new Date(from.getTime() + 14 * 24 * 60 * 60 * 1000),
  cloudCheckoutPriceIds: () => ({
    locationPriceId: process.env.STRIPE_PRICE_CLOUD_LOCATION || undefined,
  }),
  cloudMeteredPriceIds: () => ({
    aiOveragePriceId: process.env.STRIPE_PRICE_AI_OVERAGE || undefined,
    smsOveragePriceId: process.env.STRIPE_PRICE_SMS_OVERAGE || undefined,
  }),
  TRIAL_DAYS: 14,
}));

vi.mock("@/lib/stripe", () => ({
  createSubscriptionCheckoutSession: mocks.createSubscriptionCheckoutSession,
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: mocks.recordAuditLog,
}));

const { authRouter } = await import("../routers/auth");

function sqlIncludesValue(
  value: unknown,
  needle: unknown,
  seen = new WeakSet<object>(),
): boolean {
  if (Object.is(value, needle)) {
    return true;
  }

  if (!value || typeof value !== "object") {
    return false;
  }

  if (seen.has(value)) {
    return false;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.some((item) => sqlIncludesValue(item, needle, seen));
  }

  const candidate = value as { queryChunks?: unknown[]; value?: unknown };
  if (Object.prototype.hasOwnProperty.call(candidate, "value")) {
    return Object.is(candidate.value, needle);
  }
  if (Array.isArray(candidate.queryChunks)) {
    return candidate.queryChunks.some((item) =>
      sqlIncludesValue(item, needle, seen),
    );
  }

  return Object.values(value as Record<string, unknown>).some((item) =>
    sqlIncludesValue(item, needle, seen),
  );
}

function callerWithDb(db: Record<string, unknown>) {
  return authRouter.createCaller({ db, session: null } as never);
}

function callerWithSession(db: Record<string, unknown>) {
  return authRouter.createCaller({
    db,
    session: {
      user: {
        id: "user-1",
        email: "admin@example.com",
        name: "Admin",
        role: "admin",
        practiceId: "practice-1",
      },
    },
  } as never);
}

function createSelectDb(selectResults: unknown[][]) {
  const results = [...selectResults];
  const selectLimit = vi.fn(async () => results.shift() ?? []);
  const selectWhere = vi.fn((_condition: unknown) => ({ limit: selectLimit }));
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));

  let transactionDepth = 0;
  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => {
      transactionDepth += 1;
      try {
        return await fn(db);
      } finally {
        transactionDepth -= 1;
      }
    },
    execute: vi.fn(async () => undefined),
    select,
  };

  return {
    db,
    selectWhere,
    isInTransaction: () => transactionDepth > 0,
  };
}

function createRegistrationDb(opts?: { insertRows?: unknown[] }) {
  const selectLimit = vi.fn(async () => []);
  const selectWhere = vi.fn((_condition: unknown) => ({ limit: selectLimit }));
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));

  const insertRows = opts?.insertRows
    ? [...opts.insertRows]
    : [
        { id: "practice-1" },
        { id: "location-1" },
        { id: "user-1", email: "owner@example.com", name: "Dr Owner" },
      ];
  const insertValues = vi.fn((_values: unknown) => ({
    returning: vi.fn(async () => [insertRows.shift()]),
  }));
  const insert = vi.fn(() => ({ values: insertValues }));

  const updateWhere = vi.fn(async () => undefined);
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  let transactionDepth = 0;
  const transaction = vi.fn(async (fn: (tx: unknown) => unknown) => {
    transactionDepth += 1;
    try {
      return await fn(db);
    } finally {
      transactionDepth -= 1;
    }
  });
  const db: Record<string, unknown> = {
    transaction,
    execute: vi.fn(async () => undefined),
    select,
    insert,
    update,
  };

  return {
    db,
    insertValues,
    updateSet,
    transaction,
    isInTransaction: () => transactionDepth > 0,
  };
}

function createAuthUpdateDb(opts?: { returningRows?: unknown[][] }) {
  const returningRows = opts?.returningRows
    ? [...opts.returningRows]
    : [[{ id: "user-1" }]];
  const updateReturning = vi.fn(async () => returningRows.shift() ?? []);
  const updateWhere = vi.fn((_condition: unknown) => ({
    returning: updateReturning,
  }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    update,
    execute: vi.fn(async () => undefined),
  };

  return {
    db,
    updateWhere,
    updateSet,
    updateReturning,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.rateLimit.mockResolvedValue({
    success: true,
    remaining: 4,
    resetAt: new Date(),
  });
  mocks.billingEnforced.mockReturnValue(false);
  mocks.noCardTrialEnabled.mockReturnValue(false);
  mocks.createAuthToken.mockResolvedValue("token-123");
  mocks.sendTrackedVerificationEmail.mockResolvedValue({
    success: true,
    provider: "resend",
    outcome: "accepted",
    possiblySent: false,
    evidencePersisted: true,
  });
  mocks.createSubscriptionCheckoutSession.mockResolvedValue({
    url: "https://stripe.example/signup-checkout",
  });
  vi.unstubAllEnvs();
});

describe("auth router input validation", () => {
  it("rejects invalid public auth inputs before side effects", async () => {
    const { db } = createSelectDb([]);
    const caller = callerWithDb(db);

    await expect(
      caller.register({
        name: " ".repeat(4),
        email: "owner@example.com",
        password: "password123",
        practiceName: "Neighborhood Veterinary",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      caller.register({
        email: "owner@example.com",
        password: "p".repeat(129),
        practiceName: "Neighborhood Veterinary",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      caller.register({
        email: `${"a".repeat(250)}@example.com`,
        password: "password123",
        practiceName: "Neighborhood Veterinary",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      caller.register({
        email: "owner@example.com",
        password: "password123",
        practiceName: " ".repeat(4),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      caller.register({
        email: "owner@example.com",
        password: "password123",
        practiceName: "Neighborhood Veterinary",
        onboardingDraft: {
          logoName: "l".repeat(121),
        },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      caller.register({
        email: "owner@example.com",
        password: "password123",
        practiceName: "Neighborhood Veterinary",
        acquisition: { source: "<script>" },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      caller.requestPasswordReset({
        email: `${"b".repeat(250)}@example.com`,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      caller.resetPassword({
        token: "a".repeat(64),
        password: "p".repeat(129),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(db.select).not.toHaveBeenCalled();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.consumeAuthToken).not.toHaveBeenCalled();
  });

  it("normalizes signup text and email before writing", async () => {
    const { db, insertValues, updateSet, transaction } = createRegistrationDb();

    await expect(
      callerWithDb(db).register({
        name: "  Dr Owner  ",
        email: "  Owner@Example.COM  ",
        password: "password123",
        practiceName: "  Neighborhood Veterinary  ",
        locationName: "  North Clinic  ",
        onboardingDraft: {
          logoName: "  Neighborhood  ",
          brandColor: "#AABBCC",
          teamMembers: [
            {
              name: "  Tech One  ",
              email: "  Tech@One.EXAMPLE.COM  ",
              role: "technician",
            },
          ],
        },
        acquisition: {
          source: "  homepage_hero  ",
          medium: "website",
          campaign: "summer_launch",
        },
      }),
    ).resolves.toMatchObject({
      id: "user-1",
      email: "owner@example.com",
    });

    expect(transaction).toHaveBeenCalled();
    expect(insertValues).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        name: "Neighborhood Veterinary",
        email: "owner@example.com",
      }),
    );
    expect(insertValues).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        practiceId: "practice-1",
        name: "North Clinic",
      }),
    );
    expect(insertValues).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        email: "owner@example.com",
        name: "Dr Owner",
        role: "admin",
        practiceId: "practice-1",
      }),
    );
    expect(updateSet).toHaveBeenCalledWith({
      settings: {
        acquisition: {
          source: "homepage_hero",
          medium: "website",
          campaign: "summer_launch",
          capturedAt: expect.any(String),
        },
        onboardingDraft: {
          logoName: "Neighborhood",
          brandColor: "#aabbcc",
          teamMembers: [
            {
              name: "Tech One",
              email: "tech@one.example.com",
              role: "technician",
            },
          ],
        },
      },
    });
  });

  it("fails signup before setup side effects when core account bootstrap returns no user", async () => {
    const { db, insertValues, transaction, updateSet } = createRegistrationDb({
      insertRows: [{ id: "practice-1" }, { id: "location-1" }, undefined],
    });

    await expect(
      callerWithDb(db).register({
        email: "owner@example.com",
        password: "password123",
        practiceName: "Neighborhood Veterinary",
      }),
    ).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "Account setup failed.",
    });

    expect(transaction).toHaveBeenCalled();
    expect(insertValues).toHaveBeenCalledTimes(3);
    expect(mocks.seedPractice).not.toHaveBeenCalled();
    expect(mocks.seedDemoData).not.toHaveBeenCalled();
    expect(mocks.createAuthToken).not.toHaveBeenCalled();
    expect(mocks.sendTrackedVerificationEmail).not.toHaveBeenCalled();
    expect(mocks.sendWelcomeEmail).not.toHaveBeenCalled();
    expect(mocks.createSubscriptionCheckoutSession).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("fails hosted signup before account writes when checkout pricing is not configured", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    const { db, insertValues, updateSet } = createRegistrationDb();

    await expect(
      callerWithDb(db).register({
        email: "owner@example.com",
        password: "password123",
        practiceName: "Neighborhood Veterinary",
      }),
    ).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message:
        "Hosted billing is not configured. Please contact support to finish signup.",
    });

    expect(insertValues).not.toHaveBeenCalled();
    expect(mocks.createSubscriptionCheckoutSession).not.toHaveBeenCalled();
    expect(mocks.seedPractice).not.toHaveBeenCalled();
    expect(mocks.seedDemoData).not.toHaveBeenCalled();
    expect(mocks.createAuthToken).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("fails hosted signup before setup side effects when checkout cannot be created", async () => {
    vi.stubEnv("STRIPE_PRICE_CLOUD_LOCATION", "price_location");
    mocks.billingEnforced.mockReturnValue(true);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { db, insertValues, transaction, updateSet, isInTransaction } =
      createRegistrationDb();
    mocks.createSubscriptionCheckoutSession.mockImplementationOnce(async () => {
      expect(isInTransaction()).toBe(true);
      throw new Error("stripe unavailable");
    });

    await expect(
      callerWithDb(db).register({
        email: "owner@example.com",
        password: "password123",
        practiceName: "Neighborhood Veterinary",
      }),
    ).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: "Could not start hosted billing checkout. Please try again.",
    });

    expect(transaction).toHaveBeenCalled();
    expect(insertValues).toHaveBeenCalledTimes(3);
    expect(mocks.createSubscriptionCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        lineItems: [{ priceId: "price_location", quantity: 1 }],
        practiceId: "practice-1",
        customerEmail: "owner@example.com",
      }),
    );
    expect(mocks.seedPractice).not.toHaveBeenCalled();
    expect(mocks.seedDemoData).not.toHaveBeenCalled();
    expect(mocks.createAuthToken).not.toHaveBeenCalled();
    expect(mocks.sendTrackedVerificationEmail).not.toHaveBeenCalled();
    expect(mocks.sendWelcomeEmail).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      "[register] subscription checkout failed:",
      expect.any(Error),
    );
    consoleError.mockRestore();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("creates hosted signup checkout without granting a no-card trial", async () => {
    vi.stubEnv("STRIPE_PRICE_CLOUD_LOCATION", "price_location");
    vi.stubEnv("STRIPE_PRICE_SMS_OVERAGE", "price_sms");
    mocks.billingEnforced.mockReturnValue(true);
    const { db, insertValues, isInTransaction } = createRegistrationDb();
    mocks.createSubscriptionCheckoutSession.mockImplementationOnce(async () => {
      expect(isInTransaction()).toBe(true);
      return { url: "https://stripe.example/signup-checkout" };
    });

    await expect(
      callerWithDb(db).register({
        email: "owner@example.com",
        password: "password123",
        practiceName: "Neighborhood Veterinary",
      }),
    ).resolves.toMatchObject({
      id: "user-1",
      email: "owner@example.com",
      verificationRequired: true,
      checkoutUrl: "https://stripe.example/signup-checkout",
    });

    const practiceInsert = insertValues.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(practiceInsert).toMatchObject({
      name: "Neighborhood Veterinary",
      email: "owner@example.com",
    });
    expect(practiceInsert).not.toHaveProperty("billingStatus");
    expect(practiceInsert).not.toHaveProperty("trialEndsAt");

    // Checkout shows one clean product: the metered overage items are added
    // to the subscription server-side after creation, never at checkout.
    expect(mocks.createSubscriptionCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        lineItems: [{ priceId: "price_location", quantity: 1 }],
        practiceId: "practice-1",
        customerEmail: "owner@example.com",
        trialPeriodDays: 14,
        successUrl: "http://localhost:3000/login?checkout=success",
        cancelUrl: "http://localhost:3000/login?checkout=cancelled",
      }),
    );
  });

  it("grants a card-free trial at signup without any Stripe checkout", async () => {
    vi.stubEnv("STRIPE_PRICE_CLOUD_LOCATION", "price_location");
    mocks.billingEnforced.mockReturnValue(true);
    mocks.noCardTrialEnabled.mockReturnValue(true);
    const { db, insertValues, isInTransaction } = createRegistrationDb();
    mocks.createAuthToken.mockImplementationOnce(async () => {
      expect(isInTransaction()).toBe(true);
      return "token-123";
    });
    mocks.sendTrackedVerificationEmail.mockImplementationOnce(async () => {
      expect(isInTransaction()).toBe(false);
      return {
        success: true,
        provider: "resend",
        outcome: "accepted",
        possiblySent: false,
        evidencePersisted: true,
      };
    });
    mocks.sendWelcomeEmail.mockImplementationOnce(async () => {
      expect(isInTransaction()).toBe(false);
      return { success: true };
    });

    await expect(
      callerWithDb(db).register({
        email: "owner@example.com",
        password: "password123",
        practiceName: "Neighborhood Veterinary",
      }),
    ).resolves.toMatchObject({
      id: "user-1",
      email: "owner@example.com",
      verificationRequired: true,
      verificationEmailSent: true,
      verificationEmailPossiblySent: false,
      verificationEmailPreviewed: false,
      verificationEmailProvider: "resend",
      onboardingRequired: true,
      checkoutUrl: undefined,
    });

    const practiceInsert = insertValues.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(practiceInsert).toMatchObject({
      name: "Neighborhood Veterinary",
      subscriptionTier: "cloud",
      billingStatus: "trialing",
    });
    expect(practiceInsert.trialEndsAt).toBeInstanceOf(Date);
    // Card-free trial never touches Stripe Checkout.
    expect(mocks.createSubscriptionCheckoutSession).not.toHaveBeenCalled();
    expect(mocks.sendTrackedVerificationEmail).toHaveBeenCalledWith({
      practiceId: "practice-1",
      userId: "user-1",
      source: "registration",
      to: "owner@example.com",
      name: "Dr Owner",
      verifyUrl: "http://localhost:3000/verify-email?token=token-123",
      db,
    });
  });

  it("reports a console verification preview without claiming registration email delivery", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    mocks.noCardTrialEnabled.mockReturnValue(true);
    const { db } = createRegistrationDb();
    mocks.sendTrackedVerificationEmail.mockResolvedValueOnce({
      success: true,
      provider: "console",
      outcome: "accepted",
      possiblySent: false,
      evidencePersisted: true,
    });

    await expect(
      callerWithDb(db).register({
        email: "owner@example.com",
        password: "password123",
        practiceName: "Neighborhood Veterinary",
      }),
    ).resolves.toMatchObject({
      verificationRequired: true,
      verificationEmailSent: false,
      verificationEmailPossiblySent: false,
      verificationEmailPreviewed: true,
      verificationEmailProvider: "console",
    });
  });

  it("rejects hosted signup when Stripe returns an unsafe checkout URL", async () => {
    vi.stubEnv("STRIPE_PRICE_CLOUD_LOCATION", "price_location");
    mocks.billingEnforced.mockReturnValue(true);
    const { db, insertValues, updateSet, transaction } = createRegistrationDb();
    mocks.createSubscriptionCheckoutSession.mockResolvedValueOnce({
      url: "http://stripe.example/signup-checkout",
    } as never);

    await expect(
      callerWithDb(db).register({
        email: "owner@example.com",
        password: "password123",
        practiceName: "Neighborhood Veterinary",
      }),
    ).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: "Could not start hosted billing checkout. Please try again.",
    });

    expect(transaction).toHaveBeenCalled();
    expect(insertValues).toHaveBeenCalledTimes(3);
    expect(mocks.seedPractice).not.toHaveBeenCalled();
    expect(mocks.seedDemoData).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });
});

describe("auth router email normalization", () => {
  it("normalizes duplicate-registration rate-limit keys and lookups", async () => {
    const { db, selectWhere } = createSelectDb([
      [{ id: "user-1", email: "admin@example.com" }],
    ]);

    await expect(
      callerWithDb(db).register({
        email: "Admin@Example.COM",
        password: "password123",
        practiceName: "Neighborhood Veterinary",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Email already registered",
    });

    expect(mocks.rateLimit).toHaveBeenCalledWith({
      key: "register:admin@example.com",
      limit: 5,
      windowMs: 3600000,
    });
    expect(
      sqlIncludesValue(selectWhere.mock.calls[0]?.[0], "admin@example.com"),
    ).toBe(true);
  });

  it("normalizes password-reset rate-limit keys and account lookups", async () => {
    const { db, selectWhere } = createSelectDb([
      [{ id: "user-1", email: "admin@example.com", name: "Admin" }],
    ]);

    await expect(
      callerWithDb(db).requestPasswordReset({ email: "Admin@Example.COM" }),
    ).resolves.toEqual({ ok: true });

    expect(mocks.rateLimit).toHaveBeenCalledWith({
      key: "pwreset:admin@example.com",
      limit: 5,
      windowMs: 3600000,
    });
    expect(
      sqlIncludesValue(selectWhere.mock.calls[0]?.[0], "admin@example.com"),
    ).toBe(true);
    expect(
      sqlIncludesValue(selectWhere.mock.calls[0]?.[0], users.deletedAt),
    ).toBe(true);
    expect(mocks.createAuthToken).toHaveBeenCalledWith({
      userId: "user-1",
      email: "admin@example.com",
      type: "password_reset",
      db,
    });
  });
});

describe("authenticated verification resend", () => {
  const unverifiedUser = {
    id: "user-1",
    email: "admin@example.com",
    name: "Admin",
    emailVerifiedAt: null,
  };

  it("rejects logged-out callers before account lookup", async () => {
    const { db } = createSelectDb([]);

    await expect(callerWithDb(db).resendVerification()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(db.select).not.toHaveBeenCalled();
  });

  it("binds resend to the signed-in account and reports provider acceptance", async () => {
    const { db, selectWhere, isInTransaction } = createSelectDb([
      [unverifiedUser],
    ]);
    mocks.createAuthToken.mockImplementationOnce(async () => {
      expect(isInTransaction()).toBe(true);
      return "token-123";
    });
    mocks.sendTrackedVerificationEmail.mockImplementationOnce(async () => {
      expect(isInTransaction()).toBe(false);
      return {
        success: true,
        provider: "resend",
        outcome: "accepted",
        possiblySent: false,
        evidencePersisted: true,
      };
    });

    await expect(callerWithSession(db).resendVerification()).resolves.toEqual({
      ok: true,
      alreadyVerified: false,
      verificationEmailSent: true,
      possiblySent: false,
      verificationEmailPreviewed: false,
      verificationEmailProvider: "resend",
      message: "Verification email sent. Check your inbox and spam folder.",
    });

    const condition = selectWhere.mock.calls[0]?.[0];
    expect(sqlIncludesValue(condition, "user-1")).toBe(true);
    expect(sqlIncludesValue(condition, "practice-1")).toBe(true);
    expect(sqlIncludesValue(condition, users.deletedAt)).toBe(true);
    expect(mocks.rateLimit).toHaveBeenCalledWith({
      key: "verifyresend:admin@example.com",
      limit: 5,
      windowMs: 3600000,
    });
    expect(mocks.createAuthToken).toHaveBeenCalledWith({
      userId: "user-1",
      email: "admin@example.com",
      type: "email_verify",
      db,
    });
    expect(mocks.sendTrackedVerificationEmail).toHaveBeenCalledWith({
      practiceId: "practice-1",
      userId: "user-1",
      source: "authenticated_resend",
      to: "admin@example.com",
      name: "Admin",
      verifyUrl: "http://localhost:3000/verify-email?token=token-123",
      db,
    });
  });

  it("does not send another message after the account is verified", async () => {
    const { db } = createSelectDb([
      [
        {
          ...unverifiedUser,
          emailVerifiedAt: new Date("2026-08-09T12:00:00Z"),
        },
      ],
    ]);

    await expect(callerWithSession(db).resendVerification()).resolves.toEqual({
      ok: true,
      alreadyVerified: true,
      verificationEmailSent: false,
      possiblySent: false,
      verificationEmailPreviewed: false,
      verificationEmailProvider: null,
      message: "Your email is already verified.",
    });
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.createAuthToken).not.toHaveBeenCalled();
    expect(mocks.sendTrackedVerificationEmail).not.toHaveBeenCalled();
  });

  it("reports provider rejection without claiming the email was sent", async () => {
    const { db } = createSelectDb([[unverifiedUser]]);
    mocks.sendTrackedVerificationEmail.mockResolvedValueOnce({
      success: false,
      provider: "resend",
      outcome: "definite_failure",
      possiblySent: false,
      evidencePersisted: true,
    });

    await expect(callerWithSession(db).resendVerification()).resolves.toEqual({
      ok: true,
      alreadyVerified: false,
      verificationEmailSent: false,
      possiblySent: false,
      verificationEmailPreviewed: false,
      verificationEmailProvider: "resend",
      message:
        "The email provider did not accept the verification email. Please try again later.",
    });
  });

  it("tells users to check their inbox when the provider outcome is unknown", async () => {
    const { db } = createSelectDb([[unverifiedUser]]);
    mocks.sendTrackedVerificationEmail.mockResolvedValueOnce({
      success: false,
      provider: "resend",
      outcome: "outcome_unknown",
      possiblySent: true,
      evidencePersisted: true,
    });

    const result = await callerWithSession(db).resendVerification();

    expect(result).toMatchObject({
      verificationEmailSent: false,
      possiblySent: true,
      verificationEmailProvider: "resend",
    });
    expect(result.message).toMatch(/may have been sent/i);
    expect(result.message).not.toMatch(/try again|retry/i);
  });

  it("reports console preview semantics without claiming an email was sent", async () => {
    const { db } = createSelectDb([[unverifiedUser]]);
    mocks.sendTrackedVerificationEmail.mockResolvedValueOnce({
      success: true,
      provider: "console",
      outcome: "accepted",
      possiblySent: false,
      evidencePersisted: true,
    });

    await expect(callerWithSession(db).resendVerification()).resolves.toEqual({
      ok: true,
      alreadyVerified: false,
      verificationEmailSent: false,
      possiblySent: false,
      verificationEmailPreviewed: true,
      verificationEmailProvider: "console",
      message:
        "Verification email preview generated in the server console. No email was sent.",
    });
  });

  it("fails closed when the resend limiter is unavailable", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { db } = createSelectDb([[unverifiedUser]]);
    mocks.rateLimit.mockRejectedValueOnce(new Error("rate limiter down"));

    try {
      await expect(
        callerWithSession(db).resendVerification(),
      ).rejects.toMatchObject({
        code: "TOO_MANY_REQUESTS",
        message: "Too many requests. Please try again later.",
      });
      expect(consoleError).toHaveBeenCalledWith(
        "[auth.resendVerification] rate limit failed:",
        expect.any(Error),
      );
      expect(mocks.createAuthToken).not.toHaveBeenCalled();
      expect(mocks.sendTrackedVerificationEmail).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("auth router rate-limit failure guards", () => {
  it.each([
    {
      label: "registration",
      logContext: "register",
      expectedMessage:
        "Too many registration attempts. Please try again later.",
      call: (caller: ReturnType<typeof callerWithDb>) =>
        caller.register({
          email: "owner@example.com",
          password: "password123",
          practiceName: "Neighborhood Veterinary",
        }),
    },
    {
      label: "password reset",
      logContext: "requestPasswordReset",
      expectedMessage: "Too many requests. Please try again later.",
      call: (caller: ReturnType<typeof callerWithDb>) =>
        caller.requestPasswordReset({ email: "owner@example.com" }),
    },
  ])(
    "fails closed for $label when the durable limiter is unavailable",
    async ({ call, expectedMessage, logContext }) => {
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const { db } = createSelectDb([]);
      mocks.rateLimit.mockRejectedValueOnce(new Error("rate limiter down"));

      try {
        await expect(call(callerWithDb(db))).rejects.toMatchObject({
          code: "TOO_MANY_REQUESTS",
          message: expectedMessage,
        });

        expect(consoleError).toHaveBeenCalledWith(
          `[auth.${logContext}] rate limit failed:`,
          expect.any(Error),
        );
        expect(db.select).not.toHaveBeenCalled();
        expect(mocks.createAuthToken).not.toHaveBeenCalled();
        expect(mocks.sendTrackedVerificationEmail).not.toHaveBeenCalled();
        expect(mocks.sendPasswordResetEmail).not.toHaveBeenCalled();
        expect(mocks.sendWelcomeEmail).not.toHaveBeenCalled();
        expect(mocks.createSubscriptionCheckoutSession).not.toHaveBeenCalled();
      } finally {
        consoleError.mockRestore();
      }
    },
  );
});

describe("auth router token validation", () => {
  const validToken = "a".repeat(64);

  it("rejects malformed public auth tokens before consuming them", async () => {
    const { db } = createSelectDb([]);
    const caller = callerWithDb(db);

    await expect(
      caller.verifyEmail({ token: "not-a-token" }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      caller.resetPassword({ token: "b".repeat(65), password: "password123" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.acceptInvite({
        token: "../".repeat(1024),
        password: "password123",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(mocks.consumeAuthToken).not.toHaveBeenCalled();
  });

  it("accepts issued 64-hex tokens for verification, reset, and invite flows", async () => {
    const { db, updateWhere } = createAuthUpdateDb({
      returningRows: [
        [{ id: "user-1" }],
        [{ id: "user-1" }],
        [{ id: "user-1" }],
      ],
    });
    mocks.consumeAuthToken.mockResolvedValue({
      userId: "user-1",
      email: "owner@example.com",
    });
    const caller = callerWithDb(db);

    await expect(caller.verifyEmail({ token: validToken })).resolves.toEqual({
      ok: true,
    });
    await expect(
      caller.resetPassword({ token: validToken, password: "password123" }),
    ).resolves.toEqual({ ok: true });
    await expect(
      caller.acceptInvite({ token: validToken, password: "password123" }),
    ).resolves.toEqual({ ok: true });

    expect(mocks.consumeAuthToken).toHaveBeenCalledWith(
      validToken,
      "email_verify",
      { db },
    );
    expect(mocks.consumeAuthToken).toHaveBeenCalledWith(
      validToken,
      "password_reset",
      { db },
    );
    expect(mocks.consumeAuthToken).toHaveBeenCalledWith(validToken, "invite", {
      db,
    });
    for (const call of updateWhere.mock.calls) {
      expect(sqlIncludesValue(call[0], users.deletedAt)).toBe(true);
    }
  });

  it("rejects issued auth tokens when the target user is deleted", async () => {
    const { db, updateWhere } = createAuthUpdateDb({
      returningRows: [[], [], []],
    });
    mocks.consumeAuthToken.mockResolvedValue({
      userId: "user-1",
      email: "owner@example.com",
    });
    const caller = callerWithDb(db);

    await expect(
      caller.verifyEmail({ token: validToken }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "This verification link is invalid or has expired.",
    });
    await expect(
      caller.resetPassword({ token: validToken, password: "password123" }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "This reset link is invalid or has expired.",
    });
    await expect(
      caller.acceptInvite({ token: validToken, password: "password123" }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "This invite link is invalid or has expired.",
    });

    for (const call of updateWhere.mock.calls) {
      expect(sqlIncludesValue(call[0], users.deletedAt)).toBe(true);
    }
  });
});
