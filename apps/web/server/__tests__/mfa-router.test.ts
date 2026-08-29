import { afterEach, describe, expect, it, vi } from "vitest";
import { hash } from "bcryptjs";
import {
  decryptMfaSecret,
  encryptMfaSecret,
  totpCodeAt,
} from "@/lib/mfa";

const mocks = vi.hoisted(() => ({
  rateLimit: vi.fn(async () => ({
    success: true,
    remaining: 7,
    resetAt: new Date(),
  })),
}));

vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.rateLimit }));

const { mfaRouter } = await import("../routers/mfa");

function callerWithSession(db: Record<string, unknown>) {
  return mfaRouter.createCaller({
    db,
    ip: "198.51.100.20",
    session: {
      user: {
        id: "user-1",
        email: "admin@example.com",
        name: "Admin",
        role: "admin",
        practiceId: "practice-1",
        sessionVersion: 3,
      },
    },
    user: {
      id: "user-1",
      email: "admin@example.com",
      name: "Admin",
      role: "admin",
      practiceId: "practice-1",
      sessionVersion: 3,
    },
    practiceId: "practice-1",
  } as never);
}

function createMfaDb(userRow: Record<string, unknown>) {
  const selectLimit = vi.fn(async () => [userRow]);
  const selectWhere = vi.fn(() => ({ limit: selectLimit }));
  const selectInnerJoin = vi.fn(() => ({ where: selectWhere }));
  const selectFrom = vi.fn(() => ({ innerJoin: selectInnerJoin }));
  const select = vi.fn(() => ({ from: selectFrom }));
  const updateReturning = vi.fn(async () => [{ id: "user-1" }]);
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const updateSet = vi.fn((_values: Record<string, unknown>) => ({
    where: updateWhere,
  }));
  const update = vi.fn(() => ({ set: updateSet }));
  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    execute: vi.fn(async () => undefined),
    select,
    update,
  };
  return { db, updateSet, updateWhere };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  mocks.rateLimit.mockResolvedValue({
    success: true,
    remaining: 7,
    resetAt: new Date(),
  });
  vi.unstubAllEnvs();
});

describe("MFA router", () => {
  it("starts enrollment only after current-password verification", async () => {
    vi.stubEnv("MFA_ENCRYPTION_KEY", Buffer.alloc(32, 9).toString("base64"));
    const passwordHash = await hash("current-password", 4);
    const { db, updateSet } = createMfaDb({
      id: "user-1",
      email: "admin@example.com",
      passwordHash,
      sessionVersion: 3,
      mfaEnabledAt: null,
      mfaSecretEncrypted: null,
      mfaRecoveryCodeHashes: null,
      mfaPendingSecretEncrypted: null,
      mfaPendingExpiresAt: null,
      mfaLastUsedTotpCounter: null,
      practiceName: "Neighborhood Vet",
    });

    const result = await callerWithSession(db).beginEnrollment({
      password: "current-password",
    });

    expect(result.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(result.provisioningUri).toContain("otpauth://totp/");
    const pending = updateSet.mock.calls[0]?.[0] as {
      mfaPendingSecretEncrypted?: string;
      mfaPendingExpiresAt?: Date;
    };
    expect(pending.mfaPendingExpiresAt).toBeInstanceOf(Date);
    expect(decryptMfaSecret(pending.mfaPendingSecretEncrypted!)).toBe(
      result.secret,
    );
  });

  it("enables MFA with hashed recovery codes and revokes older sessions", async () => {
    vi.stubEnv("MFA_ENCRYPTION_KEY", Buffer.alloc(32, 5).toString("base64"));
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    const pending = encryptMfaSecret(secret);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const { db, updateSet } = createMfaDb({
      id: "user-1",
      email: "admin@example.com",
      passwordHash: "unused",
      sessionVersion: 3,
      mfaEnabledAt: null,
      mfaSecretEncrypted: null,
      mfaRecoveryCodeHashes: null,
      mfaPendingSecretEncrypted: pending,
      mfaPendingExpiresAt: new Date(now + 60_000),
      mfaLastUsedTotpCounter: null,
      practiceName: "Neighborhood Vet",
    });

    const result = await callerWithSession(db).confirmEnrollment({
      code: totpCodeAt(secret, now),
    });

    expect(result.recoveryCodes).toHaveLength(10);
    expect(result.sessionRevoked).toBe(true);
    const enabled = updateSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(enabled).toMatchObject({
      mfaSecretEncrypted: pending,
      mfaEnabledAt: expect.any(Date),
      mfaLastUsedTotpCounter: Math.floor(now / 30_000),
      mfaPendingSecretEncrypted: null,
      mfaPendingExpiresAt: null,
      sessionVersion: expect.anything(),
    });
    expect(enabled.mfaRecoveryCodeHashes).toEqual(
      expect.arrayContaining([expect.stringMatching(/^[0-9a-f]{64}$/)]),
    );
    expect(enabled.mfaRecoveryCodeHashes).not.toEqual(
      expect.arrayContaining(result.recoveryCodes),
    );
  });

  it("fails closed when password verification throttling is unavailable", async () => {
    vi.stubEnv("MFA_ENCRYPTION_KEY", Buffer.alloc(32, 2).toString("base64"));
    mocks.rateLimit.mockRejectedValueOnce(new Error("database unavailable"));
    const { db } = createMfaDb({});

    await expect(
      callerWithSession(db).beginEnrollment({ password: "current-password" }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });
});
