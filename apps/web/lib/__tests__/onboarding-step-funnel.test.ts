import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const results: unknown[][] = [];
  const db = {
    execute: vi.fn(async () => results.shift() ?? []),
  };
  return {
    db,
    results,
    withSystem: vi.fn(
      async (database: unknown, fn: (tx: unknown) => Promise<unknown>) =>
        fn(database),
    ),
  };
});

vi.mock("@/lib/tenant-db", () => ({
  withSystem: mocks.withSystem,
}));

const { computeOnboardingStepFunnel, ONBOARDING_STALL_DAYS } =
  await import("@/lib/admin/onboarding-step-funnel");

afterEach(() => {
  vi.clearAllMocks();
  mocks.results.length = 0;
});

describe("onboarding step funnel", () => {
  it("aggregates signup cohorts with sequential step rates and stalled counts", async () => {
    mocks.results.push(
      [
        {
          weekStart: "2026-07-27",
          signups: "4",
          intentCompleted: "3",
          basicsCompleted: "2",
          dataCompleted: "1",
          allSetCompleted: "1",
          stalledBeforeIntent: "1",
          stalledAtBasics: "1",
          stalledAtData: "1",
          stalledAtAllSet: "0",
        },
        {
          weekStart: "2026-08-03",
          signups: 2,
          intentCompleted: 1,
          basicsCompleted: 1,
          dataCompleted: 0,
          allSetCompleted: 0,
          stalledBeforeIntent: 0,
          stalledAtBasics: 0,
          stalledAtData: 0,
          stalledAtAllSet: 0,
        },
      ],
      [
        {
          fullyInstrumentedPractices: "2",
          partiallyInstrumentedPractices: "1",
          historicalInferredPractices: "2",
          noStepEvidencePractices: "1",
        },
      ],
    );

    const result = await computeOnboardingStepFunnel(mocks.db as never, 30);

    expect(result.days).toBe(30);
    expect(result.stallDays).toBe(ONBOARDING_STALL_DAYS);
    expect(result.weeks).toHaveLength(2);
    expect(result.totals).toMatchObject({
      signups: 6,
      intentCompleted: 4,
      basicsCompleted: 3,
      dataCompleted: 1,
      allSetCompleted: 1,
      stalledBeforeIntent: 1,
      stalledAtBasics: 1,
      stalledAtData: 1,
      stalledAtAllSet: 0,
      intentCompletionRate: 4 / 6,
      basicsCompletionRate: 3 / 4,
      dataCompletionRate: 1 / 3,
      allSetCompletionRate: 1,
    });
    expect(result.dataQuality).toEqual({
      fullyInstrumentedPractices: 2,
      partiallyInstrumentedPractices: 1,
      historicalInferredPractices: 2,
      noStepEvidencePractices: 1,
    });
    expect(mocks.withSystem).toHaveBeenCalledWith(
      mocks.db,
      expect.any(Function),
    );
  });

  it("returns zero rates and quality counts for an empty cohort", async () => {
    mocks.results.push([], []);

    const result = await computeOnboardingStepFunnel(mocks.db as never, 7);

    expect(result.totals).toEqual({
      signups: 0,
      intentCompleted: 0,
      basicsCompleted: 0,
      dataCompleted: 0,
      allSetCompleted: 0,
      stalledBeforeIntent: 0,
      stalledAtBasics: 0,
      stalledAtData: 0,
      stalledAtAllSet: 0,
      intentCompletionRate: 0,
      basicsCompletionRate: 0,
      dataCompletionRate: 0,
      allSetCompletionRate: 0,
    });
    expect(result.dataQuality).toEqual({
      fullyInstrumentedPractices: 0,
      partiallyInstrumentedPractices: 0,
      historicalInferredPractices: 0,
      noStepEvidencePractices: 0,
    });
  });

  it("keeps cohort and abandonment evidence privacy-safe and fail-closed", () => {
    const source = readFileSync(
      new URL("../admin/onboarding-step-funnel.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("p.deleted_at is null");
    expect(source).toContain(
      "p.settings ->> 'analyticsExcluded' is distinct from 'true'",
    );
    expect(source).toContain("pcm.milestone = 'registered'");
    expect(source).toContain(
      "date_trunc('week', p.created_at at time zone 'UTC')",
    );
    expect(source).toContain("and s.basics_done and s.data_done");
    expect(source).toContain("pg_input_is_valid");
    expect(source).toContain("between r.created_at and statement_timestamp()");
    expect(source).toContain("b.bounded_basics_at >= b.exact_intent_at");
    expect(source).toContain("b.bounded_data_at >= b.exact_basics_at");
    expect(source).toContain("d.bounded_all_set_at >= d.exact_data_at");
    expect(source).toContain("), false) as intent_done");
    expect(source).toContain("), false) as legacy_evidence");
    expect(source).toContain("'branding', 'team', 'agent', 'phone', 'billing'");
    expect(source).toContain("'alongside', 'replace', 'explore', 'self_host'");
    expect(source).toContain("and r.journey_step_raw in");
    expect(source).toContain("p.settings -> 'onboardingState'");
    expect(source).toContain("from migration_runs mr");
    expect(source).toContain("mr.status = 'committed'");
    expect(source).toContain("s.exact_intent_at is not null");
    expect(source).toContain("s.exact_basics_at is not null");
    expect(source).toContain("s.exact_data_at is not null");
    expect(source).not.toContain("email");
    expect(source).not.toContain("patient");
    expect(source).not.toContain("client_name");
    expect(source).not.toContain("practice_name");
  });
});
