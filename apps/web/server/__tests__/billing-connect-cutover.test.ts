import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createConnectAccount: vi.fn(),
  createConnectAccountLink: vi.fn(),
  retrieveConnectAccount: vi.fn(),
  lockPracticeForExternalSideEffects: vi.fn(async () => true),
}));

vi.mock("@/lib/stripe", () => ({
  createCheckoutSession: vi.fn(),
  createConnectAccount: mocks.createConnectAccount,
  createConnectAccountLink: mocks.createConnectAccountLink,
  createConnectLoginLink: vi.fn(),
  isMissingStripeConnectedAccountError: (error: unknown) => {
    if (!error || typeof error !== "object") return false;
    const value = error as { code?: unknown; statusCode?: unknown };
    return (
      value.code === "resource_missing" &&
      (value.statusCode == null || value.statusCode === 404)
    );
  },
  refundStripeCheckoutPayment: vi.fn(),
  retrieveConnectAccount: mocks.retrieveConnectAccount,
}));

vi.mock("@/lib/app-url", () => ({
  appBaseUrl: () => "https://app.openvpm.com",
}));

vi.mock("@/lib/recovery-hold", () => ({
  RECOVERY_HOLD_BLOCK_MESSAGE: "recovery hold",
  lockPracticeForExternalSideEffects: mocks.lockPracticeForExternalSideEffects,
}));

const { billingRouter } = await import("../routers/billing");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const PAYMENT_ACCOUNT_ID = "00000000-0000-0000-0000-0000000000cc";

const practice = {
  id: PRACTICE_ID,
  name: "Cutover Veterinary Clinic",
  email: "admin@example.com",
  country: "US",
};

const dormantPaymentAccount = {
  id: PAYMENT_ACCOUNT_ID,
  practiceId: PRACTICE_ID,
  provider: "stripe_connect",
  stripeAccountId: "acct_legacy_unsubmitted",
  onboardingStatus: "disabled",
  chargesEnabled: false,
  payoutsEnabled: false,
  detailsSubmitted: false,
  requirementsCurrentlyDue: ["business_type"],
  requirementsDisabledReason: "requirements.past_due",
  lastSyncedAt: new Date("2026-08-14T10:02:33.129Z"),
  createdAt: new Date("2026-08-14T10:01:29.209Z"),
  updatedAt: new Date("2026-08-14T10:02:33.129Z"),
  deletedAt: null,
};

const replacementAccount = {
  id: "acct_openvpm_pending",
  charges_enabled: false,
  payouts_enabled: false,
  details_submitted: false,
  requirements: {
    currently_due: ["business_type"],
    disabled_reason: null,
  },
};

function callerWithDb(db: Record<string, unknown>) {
  return billingRouter.createCaller({
    db,
    session: {
      user: {
        id: USER_ID,
        email: "admin@example.com",
        name: "Clinic Admin",
        role: "admin",
        practiceId: PRACTICE_ID,
      },
    },
  } as never);
}

function createDb(selectResults: unknown[][]) {
  const results = [...selectResults];
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
  const insert = vi.fn(() => {
    const builder = {
      values: vi.fn((value: unknown) => {
        insertedValues.push(value);
        return builder;
      }),
      onConflictDoUpdate: vi.fn(() => builder),
      returning: vi.fn(async () => [
        {
          ...dormantPaymentAccount,
          stripeAccountId: replacementAccount.id,
          onboardingStatus: "action_required",
          requirementsDisabledReason: null,
        },
      ]),
    };
    return builder;
  });

  const db: Record<string, unknown> = {
    select,
    insert,
    execute: vi.fn(async () => undefined),
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return { db, insert, insertedValues };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.lockPracticeForExternalSideEffects.mockResolvedValue(true);
  mocks.createConnectAccount.mockResolvedValue(replacementAccount);
  mocks.createConnectAccountLink.mockResolvedValue({
    url: "https://connect.stripe.com/setup/s/openvpm",
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Stripe Connect platform cutover", () => {
  it("reprovisions and audits an unavailable account that never became operational", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_openvpm");
    mocks.retrieveConnectAccount.mockRejectedValue({
      code: "resource_missing",
      statusCode: 404,
    });
    const { db, insertedValues } = createDb([
      [practice],
      [dormantPaymentAccount],
    ]);

    await expect(
      callerWithDb(db).createPaymentAccountOnboarding(),
    ).resolves.toEqual({
      url: "https://connect.stripe.com/setup/s/openvpm",
    });

    expect(mocks.createConnectAccount).toHaveBeenCalledWith({
      practiceId: PRACTICE_ID,
      email: "admin@example.com",
      country: "US",
      businessName: "Cutover Veterinary Clinic",
    });
    expect(mocks.createConnectAccountLink).toHaveBeenCalledWith({
      accountId: replacementAccount.id,
      refreshUrl:
        "https://app.openvpm.com/settings?tab=billing&connect=refresh",
      returnUrl: "https://app.openvpm.com/settings?tab=billing&connect=return",
    });
    expect(insertedValues).toContainEqual(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        userId: USER_ID,
        action: "stripe_connect_reprovisioned",
        entityType: "practice_payment_account",
        entityId: PAYMENT_ACCOUNT_ID,
        changes: {
          reason: "Stripe platform account reconfiguration",
          priorAccountState: "unsubmitted_and_not_operational",
          nextAccountState: "pending_onboarding",
        },
      }),
    );
  });

  it("refuses to replace an unavailable account that was ever operational", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_openvpm");
    mocks.retrieveConnectAccount.mockRejectedValue({
      code: "resource_missing",
      statusCode: 404,
    });
    const { db, insert } = createDb([
      [practice],
      [
        {
          ...dormantPaymentAccount,
          onboardingStatus: "active",
          chargesEnabled: true,
          payoutsEnabled: true,
          detailsSubmitted: true,
          requirementsDisabledReason: null,
        },
      ],
    ]);

    await expect(
      callerWithDb(db).createPaymentAccountOnboarding(),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message:
        "This clinic's existing payment account must be reviewed before reconnecting it to OpenVPM.",
    });

    expect(mocks.createConnectAccount).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("does not mistake a Stripe transport failure for a platform cutover", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_openvpm");
    mocks.retrieveConnectAccount.mockRejectedValue({
      code: "api_connection_error",
    });
    const { db, insert } = createDb([[practice], [dormantPaymentAccount]]);

    await expect(
      callerWithDb(db).createPaymentAccountOnboarding(),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });

    expect(mocks.createConnectAccount).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });
});
