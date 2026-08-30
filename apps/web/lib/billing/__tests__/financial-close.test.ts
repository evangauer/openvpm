import { describe, expect, it, vi } from "vitest";
import {
  closeFinancialDay,
  isFinancialBusinessDate,
  loadFinancialDayStatement,
} from "../financial-close";

const PRACTICE_ID = "00000000-0000-0000-0000-000000000001";
const ADMIN_ID = "00000000-0000-0000-0000-000000000002";
const CLOSE_ID = "00000000-0000-0000-0000-000000000003";

function statementRow(overrides: Record<string, unknown> = {}) {
  return {
    businessDate: "2026-03-08",
    timezone: "America/New_York",
    databaseNow: "2026-03-10T12:00:00.000Z",
    startAt: "2026-03-08T05:00:00.000Z",
    cutoffAt: "2026-03-09T04:00:00.000Z",
    paymentCount: "3",
    grossReceiptsCents: "12500",
    refundsCents: "2500",
    netReceiptsCents: "10000",
    cashCents: "4000",
    checkCents: "0",
    cardAndOnlineCents: "6000",
    otherCents: "0",
    processorGrossCents: "6000",
    processorFeeCents: "180",
    applicationFeeCents: "120",
    clinicNetCents: "5700",
    paidOutCents: "5700",
    openDisputeCents: "1000",
    unreconciledPaymentCount: "0",
    unresolvedRefundCount: "0",
    unreconciledPayoutCount: "0",
    existingCloseId: null,
    closedAt: null,
    ...overrides,
  };
}

function executeOnly(row: Record<string, unknown>) {
  return { execute: vi.fn(async () => [row]) } as never;
}

function databaseForClose(row: Record<string, unknown>, close: unknown) {
  const returning = vi.fn(async () => [close]);
  const values = vi.fn(() => ({ returning }));
  const insert = vi.fn(() => ({ values }));
  const execute = vi
    .fn()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ id: PRACTICE_ID }])
    .mockResolvedValueOnce([row]);
  return {
    database: { execute, insert } as never,
    execute,
    insert,
    values,
    returning,
  };
}

describe("financial clinic-day close", () => {
  it.each([
    ["2026-02-28", true],
    ["2028-02-29", true],
    ["2026-02-29", false],
    ["2026-04-31", false],
    ["2026-1-01", false],
    ["not-a-date", false],
  ])("validates real ISO business dates (%s)", (value, expected) => {
    expect(isFinancialBusinessDate(value)).toBe(expected);
  });

  it("maps one database snapshot and preserves DST clinic-day bounds", async () => {
    const statement = await loadFinancialDayStatement(
      executeOnly(statementRow()),
      PRACTICE_ID,
      "2026-03-08",
    );

    expect(statement).toMatchObject({
      businessDate: "2026-03-08",
      timezone: "America/New_York",
      paymentCount: 3,
      grossReceiptsCents: 12_500,
      refundsCents: 2_500,
      netReceiptsCents: 10_000,
      processorGrossCents: 6_000,
      clinicNetCents: 5_700,
      unreconciledCount: 0,
      canClose: true,
      blocker: null,
    });
    expect(statement.startAt.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(statement.cutoffAt.toISOString()).toBe("2026-03-09T04:00:00.000Z");
  });

  it("returns an explicit unresolved-evidence breakdown", async () => {
    const statement = await loadFinancialDayStatement(
      executeOnly(
        statementRow({
          unreconciledPaymentCount: "2",
          unresolvedRefundCount: "1",
          unreconciledPayoutCount: "3",
        }),
      ),
      PRACTICE_ID,
      "2026-03-08",
    );

    expect(statement).toMatchObject({
      unreconciledPaymentCount: 2,
      unresolvedRefundCount: 1,
      unreconciledPayoutCount: 3,
      unreconciledCount: 6,
      canClose: false,
      blocker: "unreconciled_items",
    });
  });

  it("uses immutable stored values for an already-closed day", async () => {
    const statement = await loadFinancialDayStatement(
      executeOnly(
        statementRow({
          existingCloseId: CLOSE_ID,
          closedAt: "2026-03-10T12:01:00.000Z",
          grossReceiptsCents: "7777",
          refundsCents: "777",
          netReceiptsCents: "7000",
        }),
      ),
      PRACTICE_ID,
      "2026-03-08",
    );

    expect(statement).toMatchObject({
      existingCloseId: CLOSE_ID,
      grossReceiptsCents: 7_777,
      blocker: "already_closed",
      canClose: false,
      unreconciledCount: 0,
    });
  });

  it("fails closed on an invalid accounting identity", async () => {
    await expect(
      loadFinancialDayStatement(
        executeOnly(statementRow({ netReceiptsCents: "9999" })),
        PRACTICE_ID,
        "2026-03-08",
      ),
    ).rejects.toThrow("accounting identity");
  });

  it("rejects unfinished and unreconciled clinic days before insert", async () => {
    const unfinished = databaseForClose(
      statementRow({ databaseNow: "2026-03-09T03:59:59.999Z" }),
      {},
    );
    await expect(
      closeFinancialDay(unfinished.database, {
        practiceId: PRACTICE_ID,
        closedBy: ADMIN_ID,
        businessDate: "2026-03-08",
      }),
    ).rejects.toMatchObject({
      reason: "day_not_ended",
    });
    expect(unfinished.insert).not.toHaveBeenCalled();

    const unresolved = databaseForClose(
      statementRow({ unreconciledPaymentCount: "1" }),
      {},
    );
    await expect(
      closeFinancialDay(unresolved.database, {
        practiceId: PRACTICE_ID,
        closedBy: ADMIN_ID,
        businessDate: "2026-03-08",
      }),
    ).rejects.toMatchObject({
      reason: "unreconciled_items",
    });
    expect(unresolved.insert).not.toHaveBeenCalled();
  });

  it("inserts the exact reconciled snapshot", async () => {
    const close = { id: CLOSE_ID, practiceId: PRACTICE_ID };
    const harness = databaseForClose(statementRow(), close);

    await expect(
      closeFinancialDay(harness.database, {
        practiceId: PRACTICE_ID,
        closedBy: ADMIN_ID,
        businessDate: "2026-03-08",
      }),
    ).resolves.toEqual({ created: true, close });
    expect(harness.values).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        businessDate: "2026-03-08",
        closedBy: ADMIN_ID,
        paymentCount: 3,
        grossReceiptsCents: 12_500,
        refundsCents: 2_500,
        netReceiptsCents: 10_000,
        processorGrossCents: 6_000,
        unreconciledCount: 0,
      }),
    );
  });

  it("replays an existing immutable close without a second insert", async () => {
    const close = { id: CLOSE_ID, practiceId: PRACTICE_ID };
    const limit = vi.fn(async () => [close]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const insert = vi.fn();
    const execute = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: PRACTICE_ID }])
      .mockResolvedValueOnce([
        statementRow({ existingCloseId: CLOSE_ID, closedAt: new Date() }),
      ]);

    await expect(
      closeFinancialDay({ execute, select, insert } as never, {
        practiceId: PRACTICE_ID,
        closedBy: ADMIN_ID,
        businessDate: "2026-03-08",
      }),
    ).resolves.toEqual({ created: false, close });
    expect(insert).not.toHaveBeenCalled();
  });
});
