import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
}));

vi.mock("@/lib/tenant-db", () => ({
  withSystem: async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn({ execute: mocks.execute }),
}));

const { computeFirstVisitConversion } =
  await import("../first-visit-conversion");

describe("first-visit conversion report", () => {
  it("uses one mature opportunity denominator and preserves unknown source", async () => {
    mocks.execute
      .mockResolvedValueOnce({
        rows: [
          {
            totalFirstVisits: 12,
            awaitingMaturity: 2,
            alreadyCardedAtVisit: 3,
            matureOpportunities: 7,
            convertedWithin24Hours: 2,
            convertedWithin72Hours: 4,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { source: "first_visit_email", count: 2 },
          { source: null, count: 1 },
          { source: "not-allowlisted", count: 1 },
        ],
      });

    await expect(
      computeFirstVisitConversion(
        {} as never,
        30,
        new Date("2026-08-11T12:00:00.000Z"),
      ),
    ).resolves.toMatchObject({
      maturityHours: 72,
      totalFirstVisits: 12,
      awaitingMaturity: 2,
      alreadyCardedAtVisit: 3,
      matureOpportunities: 7,
      convertedWithin24Hours: 2,
      convertedWithin72Hours: 4,
      conversionRate24Hours: 2 / 7,
      conversionRate72Hours: 4 / 7,
      sourceBreakdown: {
        first_visit_email: 2,
        unknown: 2,
      },
    });
  });

  it("returns zero-safe rates for an empty cohort", async () => {
    mocks.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await computeFirstVisitConversion({} as never, 30);
    expect(result.conversionRate24Hours).toBe(0);
    expect(result.conversionRate72Hours).toBe(0);
    expect(result.sourceBreakdown.unknown).toBe(0);
  });

  it("pins the mature, non-demo, signed post-visit cohort contract", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../first-visit-conversion.ts", import.meta.url)),
      "utf8",
    );
    for (const invariant of [
      "a.status = 'checked_out'",
      "vc.status = 'completed'",
      "analyticsExcluded",
      "appointmentIds",
      "se.endpoint = 'subscription'",
      "se.evidence_kind = 'subscription_checkout_completed'",
      "se.event_created_at > fv.first_visit_at",
      "first_visit_at <= ${maturityCutoff}",
      "first_checkout_after <= first_visit_at + interval '24 hours'",
      "first_checkout_after <= first_visit_at + interval '72 hours'",
    ]) {
      expect(source).toContain(invariant);
    }
  });
});
