import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class FinancialCloseBlockedError extends Error {
    constructor(
      readonly reason: "day_not_ended" | "unreconciled_items",
      readonly statement: unknown,
    ) {
      super("Clinic day cannot close.");
    }
  }
  return {
    FinancialCloseBlockedError,
    loadFinancialDayStatement: vi.fn(async () => ({
      businessDate: "2026-03-08",
      canClose: true,
    })),
    closeFinancialDay: vi.fn(async () => ({
      created: true,
      close: { id: "00000000-0000-0000-0000-000000000003" },
    })),
  };
});

vi.mock("@/lib/billing/financial-close", () => ({
  FinancialCloseBlockedError: mocks.FinancialCloseBlockedError,
  isFinancialBusinessDate: (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return (
      !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  },
  loadFinancialDayStatement: mocks.loadFinancialDayStatement,
  closeFinancialDay: mocks.closeFinancialDay,
}));
vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn(async () => undefined),
}));
vi.mock("@/lib/tenant-db", () => ({
  withTenant: vi.fn(
    async (
      database: unknown,
      _practiceId: string,
      fn: (tx: unknown) => Promise<unknown>,
    ) => fn(database),
  ),
  withSystem: vi.fn(
    async (database: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      fn(database),
  ),
}));
vi.mock("@/lib/stripe", () => ({
  createCheckoutSession: vi.fn(),
  createConnectAccount: vi.fn(),
  createConnectAccountLink: vi.fn(),
  createConnectLoginLink: vi.fn(),
  refundStripeCheckoutPayment: vi.fn(),
  retrieveConnectAccount: vi.fn(),
}));
vi.mock("@/lib/recovery-hold", () => ({
  RECOVERY_HOLD_BLOCK_MESSAGE: "recovery hold",
  lockPracticeForExternalSideEffects: vi.fn(async () => true),
}));

const { billingRouter } = await import("../routers/billing");

const PRACTICE_ID = "00000000-0000-0000-0000-000000000001";
const USER_ID = "00000000-0000-0000-0000-000000000002";

function database(closes: unknown[] = []) {
  const limit = vi.fn(async () => closes);
  const orderBy = vi.fn(() => ({ limit }));
  const where = vi.fn(() => ({ orderBy }));
  const from = vi.fn(() => ({ where }));
  return {
    select: vi.fn(() => ({ from })),
    execute: vi.fn(async () => []),
  };
}

function caller(role: "admin" | "front_desk" = "admin", db = database()) {
  return billingRouter.createCaller({
    db,
    session: {
      user: {
        id: USER_ID,
        email: "close-operator@example.invalid",
        name: "Close operator",
        role,
        practiceId: PRACTICE_ID,
      },
    },
  } as never);
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.loadFinancialDayStatement.mockResolvedValue({
    businessDate: "2026-03-08",
    canClose: true,
  });
  mocks.closeFinancialDay.mockResolvedValue({
    created: true,
    close: { id: "00000000-0000-0000-0000-000000000003" },
  });
});

describe("financial close billing API", () => {
  it("lets authenticated staff inspect only their tenant day", async () => {
    await expect(
      caller("front_desk").financialDayStatement({
        businessDate: "2026-03-08",
      }),
    ).resolves.toMatchObject({ businessDate: "2026-03-08" });
    expect(mocks.loadFinancialDayStatement).toHaveBeenCalledWith(
      expect.anything(),
      PRACTICE_ID,
      "2026-03-08",
    );
  });

  it("rejects malformed and impossible dates before database work", async () => {
    await expect(
      caller().financialDayStatement({ businessDate: "2026-02-29" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mocks.loadFinancialDayStatement).not.toHaveBeenCalled();
  });

  it("limits close history and scopes the query to the session database", async () => {
    const rows = [{ id: "close-1" }, { id: "close-2" }];
    const db = database(rows);
    await expect(
      caller("front_desk", db).listFinancialCloses({ limit: 2 }),
    ).resolves.toEqual(rows);
  });

  it("allows only an admin to create the tenant close", async () => {
    await expect(
      caller("admin").closeFinancialDay({ businessDate: "2026-03-08" }),
    ).resolves.toMatchObject({ created: true });
    expect(mocks.closeFinancialDay).toHaveBeenCalledWith(expect.anything(), {
      practiceId: PRACTICE_ID,
      closedBy: USER_ID,
      businessDate: "2026-03-08",
    });

    await expect(
      caller("front_desk").closeFinancialDay({
        businessDate: "2026-03-08",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("maps a close blocker to a safe precondition response", async () => {
    mocks.closeFinancialDay.mockRejectedValueOnce(
      new mocks.FinancialCloseBlockedError("unreconciled_items", {}),
    );
    await expect(
      caller().closeFinancialDay({ businessDate: "2026-03-08" }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "Clinic day cannot close.",
    });
  });
});
