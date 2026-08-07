import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const executeResults: unknown[][] = [];
  const execute = vi.fn(async () => executeResults.shift() ?? []);
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
          cardAdded: "1",
          paid: "1",
          leftBeforeTrying: "12",
          demoAbandoned: "3",
          registrationAbandoned: "3",
          activationAbandoned: "1",
          cardAbandoned: "0",
        },
      ],
      [{ count: "2" }],
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
        cardAdded: 1,
        paid: 1,
      },
    ]);
    expect(result.totals).toMatchObject({
      visitors: 20,
      demos: 8,
      registrations: 5,
      activated: 2,
      cardAdded: 1,
      paid: 1,
      leftBeforeTrying: 12,
      demoAbandoned: 3,
      registrationAbandoned: 3,
      activationAbandoned: 1,
      cardAbandoned: 0,
      unattributedRegistrations: 2,
      clientErrors: 4,
      demoRate: 0.4,
      registrationRate: 0.25,
      activationRate: 0.4,
      cardRate: 0.5,
      paidRate: 1,
    });
    expect(mocks.execute).toHaveBeenCalledTimes(3);
  });

  it("returns safe zero rates when no journey has started", async () => {
    mocks.executeResults.push([], [], []);
    const result = await computeJourneyFunnel(mocks.db as never, 7);
    expect(result.totals).toMatchObject({
      visitors: 0,
      demos: 0,
      registrations: 0,
      activated: 0,
      cardAdded: 0,
      paid: 0,
      clientErrors: 0,
      demoRate: 0,
      registrationRate: 0,
      activationRate: 0,
      cardRate: 0,
      paidRate: 0,
    });
  });
});
