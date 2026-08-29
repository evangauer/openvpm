import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  latest: [] as Array<{
    completedAt: Date;
    status: "ok" | "degraded" | "failed";
    practices: number;
    primaryVerified: number;
    primaryFailed: number;
    replicaRequired: boolean;
    replicaVerified: number;
    replicaFailed: number;
  }>,
  insertValues: vi.fn(async () => undefined),
}));

vi.mock("@openpims/db/client", () => ({ db: {} }));

vi.mock("@/lib/tenant-db", () => ({
  withSystem: vi.fn(async (_db: unknown, fn: (tx: unknown) => unknown) =>
    fn({
      insert: vi.fn(() => ({ values: mocks.insertValues })),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(async () => mocks.latest),
          })),
        })),
      })),
    }),
  ),
}));

const { checkBackupRunFreshness, recordBackupRunEvidence } =
  await import("./run-evidence");

afterEach(() => {
  mocks.latest = [];
  vi.clearAllMocks();
});

function completeRun(overrides: Partial<(typeof mocks.latest)[number]> = {}) {
  return {
    completedAt: new Date("2026-08-29T10:00:00.000Z"),
    status: "ok" as const,
    practices: 2,
    primaryVerified: 2,
    primaryFailed: 0,
    replicaRequired: false,
    replicaVerified: 0,
    replicaFailed: 0,
    ...overrides,
  };
}

describe("backup run evidence", () => {
  it("persists only the supplied aggregate evidence", async () => {
    const evidence = {
      startedAt: new Date("2026-08-29T09:00:00.000Z"),
      completedAt: new Date("2026-08-29T10:00:00.000Z"),
      runDateUtc: "2026-08-29",
      status: "ok" as const,
      practices: 2,
      primaryVerified: 2,
      primaryFailed: 0,
      oversized: 0,
      nearLimit: 0,
      maxExportBytes: 500,
      replicaEnabled: false,
      replicaRequired: false,
      replicaVerified: 0,
      replicaFailed: 0,
    };

    await recordBackupRunEvidence(evidence);

    expect(mocks.insertValues).toHaveBeenCalledWith(evidence);
  });

  it("rejects absent or stale evidence", async () => {
    await expect(
      checkBackupRunFreshness(new Date("2026-08-29T12:00:00.000Z")),
    ).resolves.toEqual({
      ok: false,
      detail: "No durable backup run evidence exists",
    });

    mocks.latest = [completeRun()];
    await expect(
      checkBackupRunFreshness(new Date("2026-08-31T00:00:01.000Z")),
    ).resolves.toEqual({
      ok: false,
      detail: "Latest backup run evidence is stale",
    });
  });

  it("requires every primary backup to be verified", async () => {
    mocks.latest = [
      completeRun({
        status: "degraded",
        primaryVerified: 1,
        primaryFailed: 1,
      }),
    ];

    await expect(
      checkBackupRunFreshness(new Date("2026-08-29T12:00:00.000Z")),
    ).resolves.toEqual({
      ok: false,
      detail: "1/2 primary backups verified; 1 failed",
    });
  });

  it("accepts a fresh complete primary run", async () => {
    mocks.latest = [completeRun()];

    await expect(
      checkBackupRunFreshness(new Date("2026-08-29T12:00:00.000Z")),
    ).resolves.toEqual({
      ok: true,
      detail: "2/2 primary backups verified in the latest run",
    });
  });

  it("also requires complete independent evidence when replicas are required", async () => {
    mocks.latest = [
      completeRun({
        replicaRequired: true,
        replicaVerified: 1,
        replicaFailed: 1,
      }),
    ];

    await expect(
      checkBackupRunFreshness(new Date("2026-08-29T12:00:00.000Z")),
    ).resolves.toEqual({
      ok: false,
      detail: "1/2 required independent backups verified; 1 failed",
    });
  });
});
