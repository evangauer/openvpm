import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  alertOps: vi.fn(async () => undefined),
}));

vi.mock("@/lib/alerts", () => ({
  alertOps: mocks.alertOps,
}));

const { settingsRouter } = await import("../routers/settings");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";

function callerWithDb(db: Record<string, unknown>, role = "admin") {
  const session = {
    user: {
      id: USER_ID,
      email: "admin@example.com",
      name: "Admin",
      role,
      practiceId: PRACTICE_ID,
    },
  };
  return settingsRouter.createCaller({ db, session } as never);
}

function createDb(opts?: {
  settings?: Record<string, unknown>;
  practiceName?: string;
}) {
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => [
          {
            name: opts?.practiceName ?? "Neighborhood Veterinary",
            settings: opts?.settings ?? {},
          },
        ]),
      })),
    })),
  }));

  const updateWhere = vi.fn(() => ({
    then: (resolve: (value: undefined) => unknown) =>
      Promise.resolve(undefined).then(resolve),
  }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    execute: vi.fn(async () => undefined),
    select,
    update,
  };

  return { db, updateSet };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("settings account deletion request", () => {
  it("records an admin deletion request and alerts ops for manual review", async () => {
    const { db, updateSet } = createDb({
      settings: { brandColor: "#0f766e" },
    });

    await expect(
      callerWithDb(db).requestAccountDeletion({
        contactEmail: "OWNER@EXAMPLE.COM ",
        reason: " Closing the practice ",
        confirmExportDownloaded: true,
        confirmManualReview: true,
      }),
    ).resolves.toMatchObject({
      status: "requested",
      requestedByUserId: USER_ID,
      requestedByEmail: "admin@example.com",
      contactEmail: "owner@example.com",
      reason: "Closing the practice",
      retentionReviewRequired: true,
    });

    expect(updateSet).toHaveBeenCalledWith({
      // The request is merged in SQL against the latest JSON document so a
      // concurrent migration marker cannot be overwritten.
      settings: expect.anything(),
    });
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "Account deletion requested",
      expect.stringContaining("manualRetentionReviewRequired=true"),
    );
  });

  it("is idempotent once a deletion review is already requested", async () => {
    const existing = {
      status: "requested" as const,
      requestedAt: "2026-06-27T12:00:00.000Z",
      requestedByUserId: USER_ID,
      requestedByEmail: "admin@example.com",
      requestedByName: "Admin",
      contactEmail: "owner@example.com",
      reason: null,
      retentionReviewRequired: true as const,
    };
    const { db, updateSet } = createDb({
      settings: { accountDeletionRequest: existing },
    });

    await expect(
      callerWithDb(db).requestAccountDeletion({
        contactEmail: "owner@example.com",
        confirmExportDownloaded: true,
        confirmManualReview: true,
      }),
    ).resolves.toEqual(existing);

    expect(updateSet).not.toHaveBeenCalled();
    expect(mocks.alertOps).not.toHaveBeenCalled();
  });

  it("requires both safety confirmations", async () => {
    const { db, updateSet } = createDb();

    await expect(
      callerWithDb(db).requestAccountDeletion({
        contactEmail: "owner@example.com",
        confirmExportDownloaded: true,
        confirmManualReview: false,
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(updateSet).not.toHaveBeenCalled();
    expect(mocks.alertOps).not.toHaveBeenCalled();
  });

  it("rejects overlong contact email and reason before DB work", async () => {
    const { db, updateSet } = createDb();

    await expect(
      callerWithDb(db).requestAccountDeletion({
        contactEmail: `${"a".repeat(244)}@example.com`,
        confirmExportDownloaded: true,
        confirmManualReview: true,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).requestAccountDeletion({
        contactEmail: "owner@example.com",
        reason: "x".repeat(1001),
        confirmExportDownloaded: true,
        confirmManualReview: true,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(updateSet).not.toHaveBeenCalled();
    expect(mocks.alertOps).not.toHaveBeenCalled();
  });

  it("does not allow non-admin staff to request account deletion", async () => {
    const { db, updateSet } = createDb();

    await expect(
      callerWithDb(db, "front_desk").requestAccountDeletion({
        contactEmail: "owner@example.com",
        confirmExportDownloaded: true,
        confirmManualReview: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(updateSet).not.toHaveBeenCalled();
    expect(mocks.alertOps).not.toHaveBeenCalled();
  });
});
