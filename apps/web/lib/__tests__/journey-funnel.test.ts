import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const mocks = vi.hoisted(() => {
  const executeResults: unknown[][] = [];
  const execute = vi.fn(async (_query: unknown) => executeResults.shift() ?? []);
  const db = { execute };
  return {
    db,
    execute,
    executeResults,
    withSystem: vi.fn(
      async (database: unknown, fn: (tx: unknown) => Promise<unknown>) =>
        fn(database)
    ),
  };
});

vi.mock("@/lib/tenant-db", () => ({ withSystem: mocks.withSystem }));

const { computeJourneyFunnel } = await import("@/lib/admin/journey-funnel");

afterEach(() => {
  vi.clearAllMocks();
  mocks.executeResults.length = 0;
});

describe("computeJourneyFunnel", () => {
  it("builds weekly cohorts, abandonment counts, and client error totals", async () => {
    mocks.executeResults.push(
      [
        {
          weekStart: "2026-07-27",
          visitors: "20",
          demos: "8",
          registrations: "5",
          activated: "2",
          paymentMethodCollected: "1",
          firstPositivePayment: "1",
          leftBeforeTrying: "12",
          demoAbandoned: "3",
          registrationAbandoned: "3",
          activationAbandoned: "1",
          paymentAbandoned: "0",
        },
      ],
      [{ historicalUnknown: "2", repairableGap: "1" }],
      [{ count: "4" }]
    );

    const result = await computeJourneyFunnel(mocks.db as never, 30);

    expect(result.weeks).toEqual([
      {
        weekStart: "2026-07-27",
        visitors: 20,
        demos: 8,
        registrations: 5,
        activated: 2,
        paymentMethodCollected: 1,
        firstPositivePayment: 1,
      },
    ]);
    expect(result.totals).toMatchObject({
      visitors: 20,
      demos: 8,
      registrations: 5,
      activated: 2,
      paymentMethodCollected: 1,
      firstPositivePayment: 1,
      leftBeforeTrying: 12,
      demoAbandoned: 3,
      registrationAbandoned: 3,
      activationAbandoned: 1,
      paymentAbandoned: 0,
      unattributedRegistrations: 3,
      historicalUnattributedRegistrations: 2,
      repairableAttributionGaps: 1,
      clientErrors: 4,
      demoRate: 0.4,
      registrationRate: 0.25,
      activationRate: 0.4,
      paymentMethodRate: 0.5,
      positivePaymentRate: 1,
    });
    expect(mocks.execute).toHaveBeenCalledTimes(3);
    const errorSql = new PgDialect().sqlToQuery(
      mocks.execute.mock.calls[2]![0] as SQL,
    ).sql;
    expect(errorSql.match(/select count\(\*\)::int as count/g)).toHaveLength(1);
    expect(errorSql).toMatch(
      /select count\(\*\)::int as count\s+from funnel_events\s+where event_name = 'client_error'/,
    );
  });

  it("returns safe zero rates when no journey has started", async () => {
    mocks.executeResults.push([], [], []);
    const result = await computeJourneyFunnel(mocks.db as never, 7);
    expect(result.totals).toMatchObject({
      visitors: 0,
      demos: 0,
      registrations: 0,
      activated: 0,
      paymentMethodCollected: 0,
      firstPositivePayment: 0,
      clientErrors: 0,
      demoRate: 0,
      registrationRate: 0,
      activationRate: 0,
      paymentMethodRate: 0,
      positivePaymentRate: 0,
    });
  });

  it("uses true first-touch and exact stage clocks for mature stalls", () => {
    const source = readFileSync("lib/admin/journey-funnel.ts", "utf8");

    expect(source).toContain("export const ABANDONMENT_GRACE_DAYS = 7");
    expect(source).toContain("with first_touch_all_time as (");
    expect(source).toMatch(
      /first_touch_all_time[\s\S]*'demo_gate_submitted'/,
    );
    expect(source).not.toContain(
      "fe.created_at >= ${windowStart}::timestamptz",
    );
    expect(source).toContain(
      "where cohort_at >= ${windowStart}::timestamptz",
    );
    expect(source).toContain("select min(demo.created_at) as demo_at");
    expect(source).toContain("demo.created_at >= ft.cohort_at");
    expect(source).toContain("s.cohort_at < ${abandonedBefore}::timestamptz");
    expect(source).toContain("s.demo_at < ${abandonedBefore}::timestamptz");
    expect(source).toContain("s.registered_at < ${abandonedBefore}::timestamptz");
    expect(source).toContain("s.activation_at < ${abandonedBefore}::timestamptz");
    expect(source).toContain("s.payment_method_at < ${abandonedBefore}::timestamptz");
    expect(source).toContain("s.stripe_subscription_id is not null");
    expect(source).toContain("s.billing_status = 'trialing'");
    expect(source).toContain("s.trial_ends_at > ${now.toISOString()}::timestamptz");
  });

  it("keeps the client-error aggregate as one valid select statement", () => {
    const source = readFileSync("lib/admin/journey-funnel.ts", "utf8");
    const errorQuery = source.match(
      /const errorsResult = await tx\.execute\(sql`([\s\S]*?)`\);/,
    )?.[1];

    expect(errorQuery).toBeDefined();
    expect(errorQuery?.match(/select count\(\*\)::int as count/g)).toHaveLength(1);
    expect(errorQuery).toMatch(
      /select count\(\*\)::int as count\s+from funnel_events\s+where event_name = 'client_error'/,
    );
  });
});
