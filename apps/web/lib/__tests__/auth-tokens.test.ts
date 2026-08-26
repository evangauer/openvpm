import { createHash } from "crypto";
import { describe, expect, it, vi } from "vitest";
import {
  cleanupExpiredAuthArtifacts,
  consumeAuthToken,
  createAuthToken,
} from "../auth-tokens";

function includesValue(
  value: unknown,
  needle: unknown,
  seen = new WeakSet<object>()
): boolean {
  if (Object.is(value, needle)) return true;
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.some((item) => includesValue(item, needle, seen));
  }

  const candidate = value as { queryChunks?: unknown[]; value?: unknown };
  if (Object.prototype.hasOwnProperty.call(candidate, "value")) {
    return Object.is(candidate.value, needle);
  }
  if (Array.isArray(candidate.queryChunks)) {
    return candidate.queryChunks.some((item) =>
      includesValue(item, needle, seen)
    );
  }

  return Object.values(value as Record<string, unknown>).some((item) =>
    includesValue(item, needle, seen)
  );
}

function consumeDb(rows: Array<{ userId: string; email: string }>) {
  const returning = vi.fn(async () => rows);
  const where = vi.fn((_condition: unknown) => ({ returning }));
  const set = vi.fn((_values: Record<string, unknown>) => ({ where }));
  const update = vi.fn(() => ({ set }));
  const select = vi.fn(() => {
    throw new Error("consumeAuthToken should not select before claiming");
  });
  return {
    db: { update, select },
    update,
    set,
    where,
    returning,
  };
}

function issueDb() {
  const insertedRows: Record<string, unknown>[] = [];
  const updateWhere = vi.fn(async (_condition: unknown) => undefined);
  const updateSet = vi.fn((_values: Record<string, unknown>) => ({
    where: updateWhere,
  }));
  const update = vi.fn(() => ({ set: updateSet }));
  const insertValues = vi.fn((row: Record<string, unknown>) => {
    insertedRows.push(row);
  });
  const insert = vi.fn(() => ({ values: insertValues }));

  return {
    db: { update, insert },
    update,
    updateSet,
    updateWhere,
    insert,
    insertValues,
    insertedRows,
  };
}

function cleanupDb(rowCounts: number[]) {
  const returningMocks: Array<ReturnType<typeof vi.fn>> = [];
  const whereMocks: Array<ReturnType<typeof vi.fn>> = [];
  const deleteTable = vi.fn((_table: unknown) => {
    const index = returningMocks.length;
    const returning = vi.fn(async () =>
      Array.from({ length: rowCounts[index] ?? 0 }, (_, id) => ({ id }))
    );
    const where = vi.fn((_condition: unknown) => ({ returning }));
    returningMocks.push(returning);
    whereMocks.push(where);
    return { where };
  });

  return {
    db: { delete: deleteTable },
    deleteTable,
    whereMocks,
    returningMocks,
  };
}

describe("createAuthToken", () => {
  it("can write through a provided DB handle for signup transactions", async () => {
    const fake = issueDb();

    const raw = await createAuthToken({
      db: fake.db as never,
      userId: "00000000-0000-0000-0000-000000000001",
      email: "Owner@Clinic.test",
      type: "email_verify",
      now: new Date("2026-06-12T00:00:00Z"),
    });

    expect(raw).toMatch(/^[0-9a-f]{64}$/);
    const row = fake.insertedRows[0];
    if (!row) throw new Error("Expected token row to be inserted");
    expect(row).toMatchObject({
      userId: "00000000-0000-0000-0000-000000000001",
      email: "owner@clinic.test",
      type: "email_verify",
    });
    expect(row.tokenHash).not.toBe(raw);
    expect(row.expiresAt).toEqual(new Date("2026-06-13T00:00:00Z"));
    expect(fake.update).not.toHaveBeenCalled();
  });

  it("supersedes previous unused unexpired tokens for the same user and type", async () => {
    const fake = issueDb();
    const now = new Date("2026-06-12T00:00:00Z");

    await createAuthToken({
      db: fake.db as never,
      userId: "00000000-0000-0000-0000-000000000001",
      email: "Owner@Clinic.test",
      type: "password_reset",
      now,
    });

    expect(fake.update).toHaveBeenCalledTimes(1);
    expect(fake.updateSet).toHaveBeenCalledWith({ usedAt: now });
    const condition = fake.updateWhere.mock.calls[0]?.[0];
    expect(includesValue(condition, "00000000-0000-0000-0000-000000000001")).toBe(
      true
    );
    expect(includesValue(condition, "password_reset")).toBe(true);
    expect(includesValue(condition, now)).toBe(true);
    expect(fake.insertValues).toHaveBeenCalledTimes(1);
  });
});

describe("consumeAuthToken", () => {
  it("claims a matching unused token atomically with a conditional update", async () => {
    const raw = "a".repeat(64);
    const tokenHash = createHash("sha256").update(raw).digest("hex");
    const now = new Date("2026-06-12T12:00:00Z");
    const fake = consumeDb([
      {
        userId: "00000000-0000-0000-0000-000000000001",
        email: "owner@clinic.test",
      },
    ]);

    const result = await consumeAuthToken(raw, "password_reset", {
      now,
      db: fake.db as never,
    });

    expect(result).toEqual({
      userId: "00000000-0000-0000-0000-000000000001",
      email: "owner@clinic.test",
    });
    expect(fake.update).toHaveBeenCalledTimes(1);
    expect(fake.set).toHaveBeenCalledWith({ usedAt: now });
    expect(includesValue(fake.where.mock.calls[0]?.[0], tokenHash)).toBe(true);
    expect(includesValue(fake.where.mock.calls[0]?.[0], "password_reset")).toBe(
      true
    );
    expect(includesValue(fake.where.mock.calls[0]?.[0], now)).toBe(true);
    expect(fake.returning).toHaveBeenCalledTimes(1);
  });

  it("returns null when the atomic claim finds no unused unexpired token", async () => {
    const fake = consumeDb([]);

    await expect(
      consumeAuthToken("b".repeat(64), "invite", {
        now: new Date("2026-06-12T12:00:00Z"),
        db: fake.db as never,
      })
    ).resolves.toBeNull();

    expect(fake.update).toHaveBeenCalledTimes(1);
    expect(fake.returning).toHaveBeenCalledTimes(1);
  });
});

describe("cleanupExpiredAuthArtifacts", () => {
  it("deletes expired auth and portal session artifacts", async () => {
    const cutoff = new Date("2026-06-28T04:45:00Z");
    const fake = cleanupDb([2, 3, 1, 4]);

    await expect(
      cleanupExpiredAuthArtifacts({ now: cutoff, db: fake.db as never })
    ).resolves.toEqual({
      authTokensDeleted: 2,
      sessionsDeleted: 3,
      verificationTokensDeleted: 1,
      portalSessionsDeleted: 4,
      deleted: 10,
      cutoff,
    });

    expect(fake.deleteTable).toHaveBeenCalledTimes(4);
    expect(fake.returningMocks).toHaveLength(4);
    for (const where of fake.whereMocks) {
      expect(includesValue(where.mock.calls[0]?.[0], cutoff)).toBe(true);
    }
  });
});
