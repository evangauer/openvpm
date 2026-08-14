import { afterEach, describe, it, expect, vi } from "vitest";

vi.mock("@/lib/alerts", () => ({
  alertOps: vi.fn(async () => undefined),
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn(async () => undefined),
}));

import { appRouter } from "../routers/_app";

// Build a tRPC caller with a fake session. The db is a throwing proxy: any
// resolver that reaches the database fails loudly — so a passing query proves
// the guard let it through to a db-free path, and a FORBIDDEN proves the guard
// short-circuited before the resolver.
function callerFor(role: string, dbOverride?: Record<string, unknown>) {
  const session = {
    user: {
      id: "00000000-0000-0000-0000-000000000001",
      email: "u@example.com",
      name: "U",
      role,
      practiceId: "00000000-0000-0000-0000-0000000000aa",
    },
  };
  // Minimal db mock: transaction() runs its callback with the same object and
  // execute() is a no-op (for the RLS set_config call). Any real table access
  // (.select/.insert/...) is undefined → throws, so a db-free resolver passing
  // proves the guard let it through, and FORBIDDEN proves it short-circuited.
  const db: Record<string, unknown> = dbOverride ?? {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    execute: async () => undefined,
  };
  return appRouter.createCaller({ db, session } as never);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("viewer read-only guard", () => {
  it("allows queries for a viewer", async () => {
    const caller = callerFor("viewer");
    // dosing.formulary is a query with no DB access.
    const res = await caller.dosing.formulary();
    expect(res.drugs.length).toBeGreaterThan(0);
  });

  it("blocks mutations for a viewer with FORBIDDEN (before the resolver)", async () => {
    const caller = callerFor("viewer");
    await expect(
      caller.clients.create({ firstName: "A", lastName: "B" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("does not block queries for non-viewer roles", async () => {
    const caller = callerFor("front_desk");
    const res = await caller.dosing.formulary();
    expect(res.drugs.length).toBeGreaterThan(0);
  });

  it("blocks hosted terminal-unpaid accounts from protected mutations before resolver writes", async () => {
    vi.stubEnv("HOSTED_BILLING_ENABLED", "true");
    // The read-only guard now runs inside withTenant (a transaction) so the
    // practice lookup is RLS-scoped. The tx exposes execute() (for the
    // set_config RLS call) and the select() chain returning a lapsed practice.
    const tx: Record<string, unknown> = {
      execute: async () => undefined,
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                tier: "cloud",
                billingStatus: "unpaid",
                trialEndsAt: null,
              },
            ],
          }),
        }),
      }),
    };
    const db: Record<string, unknown> = {
      transaction: async (fn: (t: unknown) => unknown) => fn(tx),
      execute: async () => undefined,
    };
    const caller = callerFor("front_desk", db);
    await expect(
      caller.clients.create({ firstName: "A", lastName: "B" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("fails closed when hosted mutation guard cannot find the active practice", async () => {
    vi.stubEnv("HOSTED_BILLING_ENABLED", "true");
    const tx: Record<string, unknown> = {
      execute: async () => undefined,
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [],
          }),
        }),
      }),
    };
    const db: Record<string, unknown> = {
      transaction: async (fn: (t: unknown) => unknown) => fn(tx),
      execute: async () => undefined,
    };
    const caller = callerFor("front_desk", db);

    await expect(
      caller.clients.create({ firstName: "A", lastName: "B" }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });
  });

  it("allows hosted lapsed admins to request account deletion review", async () => {
    vi.stubEnv("HOSTED_BILLING_ENABLED", "true");

    const selectResults = [
      [
        {
          tier: "cloud",
          billingStatus: "past_due",
          trialEndsAt: null,
        },
      ],
      [
        {
          name: "Neighborhood Veterinary",
          settings: {},
        },
      ],
    ];
    const select = vi.fn(() => {
      const result = selectResults.shift() ?? [];
      return {
        from: () => ({
          where: () => ({
            limit: async () => result,
          }),
        }),
      };
    });
    const updateSet = vi.fn(() => ({
      where: () => ({
        then: (resolve: (value: undefined) => unknown) =>
          Promise.resolve(undefined).then(resolve),
      }),
    }));
    const tx: Record<string, unknown> = {
      execute: async () => undefined,
      select,
      update: () => ({ set: updateSet }),
    };
    const db: Record<string, unknown> = {
      transaction: async (fn: (t: unknown) => unknown) => fn(tx),
      execute: async () => undefined,
    };

    const caller = callerFor("admin", db);

    await expect(
      caller.settings.requestAccountDeletion({
        contactEmail: "owner@example.com",
        confirmExportDownloaded: true,
        confirmManualReview: true,
      }),
    ).resolves.toMatchObject({
      status: "requested",
      contactEmail: "owner@example.com",
      retentionReviewRequired: true,
    });

    expect(updateSet).toHaveBeenCalled();
  });
});
