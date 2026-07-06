import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/billing/subscription-sync", () => ({
  syncPracticeSubscriptionQuantities: vi.fn(async () => ({
    status: "ok",
    message: "synced",
    updatedAt: new Date("2026-06-07T00:00:00Z").toISOString(),
    locationCount: 1,
    billableSeatCount: 2,
  })),
}));

const { settingsRouter } = await import("../routers/settings");
const { syncPracticeSubscriptionQuantities } = await import(
  "@/lib/billing/subscription-sync"
);

function callerWithDb(db: Record<string, unknown>) {
  const session = {
    user: {
      id: "00000000-0000-0000-0000-000000000001",
      email: "admin@example.com",
      name: "Admin",
      role: "admin",
      practiceId: "00000000-0000-0000-0000-0000000000aa",
    },
  };
  return settingsRouter.createCaller({ db, session } as never);
}

function baseDb(extra: Record<string, unknown>) {
  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    execute: async () => undefined,
    ...extra,
  };
  return db;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("settings staff billing sync", () => {
  it("syncs subscription quantities after creating staff", async () => {
    const selectResults = [
      [{ id: "00000000-0000-0000-0000-0000000000aa" }],
      [],
    ];
    const db = baseDb({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => selectResults.shift() ?? []),
          })),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(async () => [
            {
              id: "00000000-0000-0000-0000-000000000002",
              name: "Taylor",
              email: "taylor@example.com",
              role: "front_desk",
            },
          ]),
        })),
      })),
    });

    await callerWithDb(db).createUser({
      name: "Taylor",
      email: "taylor@example.com",
      password: "password123",
      role: "front_desk",
    });

    expect(syncPracticeSubscriptionQuantities).toHaveBeenCalledWith({
      db,
      practiceId: "00000000-0000-0000-0000-0000000000aa",
    });
  });

  it("syncs subscription quantities after deactivating staff", async () => {
    const selectResults = [
      [{ id: "00000000-0000-0000-0000-000000000002", role: "front_desk" }],
      [],
    ];
    const db = baseDb({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => selectResults.shift() ?? []),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn(async () => [
              { id: "00000000-0000-0000-0000-000000000002" },
            ]),
          })),
        })),
      })),
    });

    await callerWithDb(db).deactivateUser({
      id: "00000000-0000-0000-0000-000000000002",
    });

    expect(syncPracticeSubscriptionQuantities).toHaveBeenCalledWith({
      db,
      practiceId: "00000000-0000-0000-0000-0000000000aa",
    });
  });
});
