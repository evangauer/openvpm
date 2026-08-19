import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { loadFinancialDaySummary } from "../financial-close";

function row(overrides: Record<string, unknown> = {}) {
  return {
    timezone: "America/New_York",
    startAt: "2026-08-17T04:00:00.000Z",
    cutoffAt: "2026-08-18T04:00:00.000Z",
    paymentCount: 4,
    grossReceiptsCents: 20000,
    refundsCents: 1000,
    netReceiptsCents: 19000,
    cashCents: 5000,
    checkCents: 2000,
    cardAndOnlineCents: 12000,
    otherCents: 0,
    processorGrossCents: 10000,
    processorFeeCents: 290,
    applicationFeeCents: 25,
    clinicNetCents: 9685,
    paidOutCents: 0,
    openDisputeCents: 0,
    unreconciledCount: 0,
    ...overrides,
  };
}

describe("financial clinic-day summaries", () => {
  it("returns integer minor-unit totals with both accounting identities", async () => {
    const execute = vi.fn(async () => [row()]);

    await expect(
      loadFinancialDaySummary(
        { execute } as never,
        "00000000-0000-4000-8000-000000000001",
        "2026-08-17",
      ),
    ).resolves.toMatchObject({
      businessDate: "2026-08-17",
      timezone: "America/New_York",
      grossReceiptsCents: 20000,
      refundsCents: 1000,
      netReceiptsCents: 19000,
      processorGrossCents: 10000,
      processorFeeCents: 290,
      applicationFeeCents: 25,
      clinicNetCents: 9685,
      unreconciledCount: 0,
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("fails closed when report rows do not balance", async () => {
    const execute = vi.fn(async () => [row({ clinicNetCents: 9700 })]);

    await expect(
      loadFinancialDaySummary(
        { execute } as never,
        "00000000-0000-4000-8000-000000000001",
        "2026-08-17",
      ),
    ).rejects.toThrow("accounting identity failed");
  });

  it("rejects malformed dates before touching the database", async () => {
    const execute = vi.fn();

    await expect(
      loadFinancialDaySummary(
        { execute } as never,
        "00000000-0000-4000-8000-000000000001",
        "08/17/2026",
      ),
    ).rejects.toThrow("YYYY-MM-DD");
    expect(execute).not.toHaveBeenCalled();
  });

  it("uses clinic-time boundaries and counts missing Stripe evidence", () => {
    const source = readFileSync("lib/billing/financial-close.ts", "utf8");

    expect(source).toContain("at time zone p.timezone");
    expect(source).toContain("pay.received_at >= b.start_at");
    expect(source).toContain("pay.received_at < b.cutoff_at");
    expect(source).toContain("pr.external_id like 'stripe:connect:%'");
    expect(source).toContain("and s.id is null");
    expect(source).toContain("payment_processor_refunds");
    expect(source).toContain("r.id is null or r.status <> 'succeeded'");
    expect(source).toContain("payment_processor_payouts");
    expect(source).toContain("p.status = 'paid'");
    expect(source).toContain("payment_disputes");
  });
});
