import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const returnedResetAt = new Date("2026-06-27T12:01:00Z");
  const returning = vi.fn(async () => [{ count: 1, resetAt: returnedResetAt }]);
  const onConflictDoUpdate = vi.fn(() => ({ returning }));
  const insertValues = vi.fn(() => ({ onConflictDoUpdate }));
  const insert = vi.fn(() => ({ values: insertValues }));
  const deleteReturning = vi.fn(async () => [
    { key: "login:ip:203.0.113.10" },
    { key: "portal-read:token" },
  ]);
  const deleteWhere = vi.fn(() => ({ returning: deleteReturning }));
  const deleteFn = vi.fn(() => ({ where: deleteWhere }));
  const tx = { insert, delete: deleteFn };
  return {
    db: {},
    tx,
    insertValues,
    deleteReturning,
    deleteWhere,
    returnedResetAt,
    withSystem: vi.fn(async (_db: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx)
    ),
  };
});

vi.mock("@openpims/db/client", () => ({
  db: mocks.db,
}));

vi.mock("@/lib/tenant-db", () => ({
  withSystem: mocks.withSystem,
}));

const {
  RATE_LIMIT_KEY_MAX_LENGTH,
  cleanupExpiredRateLimitBuckets,
  normalizeRateLimitKey,
  rateLimit,
  rateLimitResponseHeaders,
  rateLimitRetryAfterSeconds,
} = await import("../rate-limit");

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("durable rate limit keys", () => {
  it("keeps short keys unchanged", () => {
    expect(normalizeRateLimitKey("portal-checkout:token")).toBe(
      "portal-checkout:token"
    );
  });

  it("bounds long keys deterministically for the bucket primary key", () => {
    const longKey = `portal-checkout:ip:${"2001:db8::".repeat(80)}`;
    const normalized = normalizeRateLimitKey(longKey);

    expect(normalized).toHaveLength(RATE_LIMIT_KEY_MAX_LENGTH);
    expect(normalized).toContain(":sha256:");
    expect(normalized).toBe(normalizeRateLimitKey(longKey));
    expect(normalized).not.toBe(
      normalizeRateLimitKey(`${longKey}:different`)
    );
  });

  it("writes normalized keys to the durable bucket table", async () => {
    const now = new Date("2026-06-27T12:00:00Z");
    const longKey = `portal-read:${"x".repeat(500)}`;

    await expect(
      rateLimit({ key: longKey, limit: 5, windowMs: 60_000, now })
    ).resolves.toEqual({
      success: true,
      remaining: 4,
      resetAt: mocks.returnedResetAt,
    });

    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        key: normalizeRateLimitKey(longKey),
        count: 1,
      })
    );
    expect(normalizeRateLimitKey(longKey).length).toBeLessThanOrEqual(
      RATE_LIMIT_KEY_MAX_LENGTH
    );
  });

  it("cleans up expired durable buckets using the supplied cutoff", async () => {
    const now = new Date("2026-06-27T12:00:00Z");

    await expect(cleanupExpiredRateLimitBuckets({ now })).resolves.toEqual({
      deleted: 2,
      cutoff: now,
    });

    expect(mocks.withSystem).toHaveBeenCalledTimes(1);
    expect(mocks.deleteWhere).toHaveBeenCalledTimes(1);
    expect(mocks.deleteReturning).toHaveBeenCalledWith(
      expect.objectContaining({ key: expect.anything() })
    );
  });

  it("builds reset-aware public 429 headers", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-27T12:00:15Z"));
    const resetAt = new Date("2026-06-27T12:01:00Z");

    expect(
      rateLimitRetryAfterSeconds(resetAt, new Date("2026-06-27T12:00:15Z"))
    ).toBe(45);
    expect(rateLimitResponseHeaders(30, { remaining: 0, resetAt })).toEqual({
      "Retry-After": "45",
      "X-RateLimit-Limit": "30",
      "X-RateLimit-Remaining": "0",
      "X-RateLimit-Reset": "2026-06-27T12:01:00.000Z",
    });
  });
});
