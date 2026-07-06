import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const selectResults: unknown[][] = [];
  const select = vi.fn(() => {
    const result = selectResults.shift() ?? [];
    const afterWhere = {
      limit: vi.fn(async () => result),
      then: (
        resolve: (value: unknown[]) => unknown,
        reject?: (error: unknown) => unknown
      ) => Promise.resolve(result).then(resolve, reject),
    };
    return {
      from: vi.fn(() => ({
        where: vi.fn(() => afterWhere),
      })),
    };
  });
  const updateWhere = vi.fn(async () => undefined);
  const update = vi.fn(() => ({
    set: vi.fn(() => ({
      where: updateWhere,
    })),
  }));

  return {
    db: { select, update },
    selectResults,
    rateLimit: vi.fn(async () => ({
      success: true,
      remaining: 599,
      resetAt: new Date("2026-06-27T12:00:00Z"),
    })),
    rateLimitResponseHeaders: vi.fn(
      (
        limit: number,
        result: { remaining: number; resetAt: Date }
      ): Record<string, string> => ({
        "Retry-After": String(
          Math.max(1, Math.ceil((result.resetAt.getTime() - Date.now()) / 1000))
        ),
        "X-RateLimit-Limit": String(limit),
        "X-RateLimit-Remaining": String(result.remaining),
        "X-RateLimit-Reset": result.resetAt.toISOString(),
      })
    ),
    bcryptCompare: vi.fn(async () => false),
    bcryptHash: vi.fn(async () => "hashed-key"),
    billingEnforced: vi.fn(() => false),
    hasHostedFullAccess: vi.fn(() => true),
    withSystem: vi.fn(async (_db: unknown, fn: (tx: unknown) => unknown) =>
      fn({ select, update })
    ),
  };
});

vi.mock("@openpims/db/client", () => ({
  db: mocks.db,
}));

vi.mock("@/lib/tenant-db", () => ({
  withSystem: mocks.withSystem,
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: mocks.rateLimit,
  rateLimitResponseHeaders: mocks.rateLimitResponseHeaders,
}));

vi.mock("@/lib/billing/plans", () => ({
  billingEnforced: mocks.billingEnforced,
  hasHostedFullAccess: mocks.hasHostedFullAccess,
}));

vi.mock("bcryptjs", () => ({
  default: {
    compare: mocks.bcryptCompare,
    hash: mocks.bcryptHash,
  },
}));

const { authenticateApiKey } = await import("../api-auth");
const apiAuthSource = readFileSync(new URL("../api-auth.ts", import.meta.url), "utf8");

const INVALID_SHAPED_KEY = "ovpm_AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const VALID_SHAPED_KEY = "ovpm_ZyXwVuTsRqPoNmLkJiHgFeDcBa987654";
const ACTIVE_PRACTICE = [
  {
    tier: "cloud",
    billingStatus: "active",
    trialEndsAt: null,
  },
];

function apiRequest(key = "ovpm_invalid") {
  return new Request("https://openvpm.test/api/v1/clients", {
    headers: {
      authorization: `Bearer ${key}`,
      "x-forwarded-for": "203.0.113.10, 198.51.100.5",
    },
  });
}

function apiRequestWithoutKey() {
  return new Request("https://openvpm.test/api/v1/clients", {
    headers: {
      "x-forwarded-for": "203.0.113.10, 198.51.100.5",
    },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  mocks.selectResults.length = 0;
  mocks.rateLimit.mockResolvedValue({
    success: true,
    remaining: 599,
    resetAt: new Date("2026-06-27T12:00:00Z"),
  });
  mocks.bcryptCompare.mockResolvedValue(false);
  mocks.billingEnforced.mockReturnValue(false);
  mocks.hasHostedFullAccess.mockReturnValue(true);
});

describe("authenticateApiKey", () => {
  it("rate-limits missing API keys before returning unauthorized", async () => {
    const result = await authenticateApiKey(
      apiRequestWithoutKey(),
      "clients:read"
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      await expect(result.response.json()).resolves.toEqual({
        error: {
          message:
            "Missing API key. Send 'Authorization: Bearer <key>' or 'X-API-Key'.",
        },
      });
    }
    expect(mocks.rateLimit).toHaveBeenCalledWith({
      key: "apikey-auth:203.0.113.10",
      limit: 1200,
      windowMs: 60000,
    });
    expect(mocks.db.select).not.toHaveBeenCalled();
    expect(mocks.bcryptCompare).not.toHaveBeenCalled();
  });

  it("blocks missing API keys when the auth-attempt bucket is over limit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-27T12:00:15Z"));
    mocks.rateLimit.mockResolvedValueOnce({
      success: false,
      remaining: 0,
      resetAt: new Date("2026-06-27T12:01:00Z"),
    });

    const result = await authenticateApiKey(
      apiRequestWithoutKey(),
      "clients:read"
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(429);
      expect(result.response.headers.get("Retry-After")).toBe("45");
      expect(result.response.headers.get("X-RateLimit-Limit")).toBe("1200");
      expect(result.response.headers.get("X-RateLimit-Remaining")).toBe("0");
      expect(result.response.headers.get("X-RateLimit-Reset")).toBe(
        "2026-06-27T12:01:00.000Z"
      );
      await expect(result.response.json()).resolves.toEqual({
        error: { message: "Too many API key authentication attempts." },
      });
    }
    expect(mocks.rateLimit).toHaveBeenCalledWith({
      key: "apikey-auth:203.0.113.10",
      limit: 1200,
      windowMs: 60000,
    });
    expect(mocks.db.select).not.toHaveBeenCalled();
    expect(mocks.bcryptCompare).not.toHaveBeenCalled();
  });

  it.each([
    { label: "wrong prefix", key: "not_ovpm_key" },
    { label: "restored disabled prefix", key: "disabled-restored" },
    { label: "too short", key: "ovpm_short" },
    { label: "invalid characters", key: "ovpm_valid<script>" },
    { label: "oversized", key: `ovpm_${"a".repeat(500)}` },
  ])(
    "rejects $label API keys after attempt throttling without lookup or bcrypt",
    async ({ key }) => {
      const result = await authenticateApiKey(apiRequest(key), "clients:read");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(401);
        await expect(result.response.json()).resolves.toEqual({
          error: { message: "Invalid API key." },
        });
      }
      expect(mocks.rateLimit).toHaveBeenCalledWith({
        key: "apikey-auth:203.0.113.10",
        limit: 1200,
        windowMs: 60000,
      });
      expect(mocks.db.select).not.toHaveBeenCalled();
      expect(mocks.bcryptCompare).not.toHaveBeenCalled();
    }
  );

  it("rate-limits presented API keys before lookup or bcrypt comparison", async () => {
    mocks.rateLimit.mockResolvedValueOnce({
      success: false,
      remaining: 0,
      resetAt: new Date("2026-06-27T12:01:00Z"),
    });

    const result = await authenticateApiKey(
      apiRequest(INVALID_SHAPED_KEY),
      "clients:read"
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(429);
      await expect(result.response.json()).resolves.toEqual({
        error: { message: "Too many API key authentication attempts." },
      });
    }
    expect(mocks.rateLimit).toHaveBeenCalledWith({
      key: "apikey-auth:203.0.113.10",
      limit: 1200,
      windowMs: 60000,
    });
    expect(mocks.db.select).not.toHaveBeenCalled();
    expect(mocks.bcryptCompare).not.toHaveBeenCalled();
  });

  it("still returns unauthorized for invalid keys under the attempt limit", async () => {
    mocks.selectResults.push([
      {
        id: "key_123",
        practiceId: "practice_123",
        keyHash: "stored-hash",
        scopes: ["clients:read"],
      },
    ]);
    mocks.bcryptCompare.mockResolvedValueOnce(false);

    const result = await authenticateApiKey(
      apiRequest(INVALID_SHAPED_KEY),
      "clients:read"
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      await expect(result.response.json()).resolves.toEqual({
        error: { message: "Invalid API key." },
      });
    }
    expect(mocks.rateLimit).toHaveBeenCalledTimes(1);
    expect(mocks.bcryptCompare).toHaveBeenCalledWith(
      INVALID_SHAPED_KEY,
      "stored-hash"
    );
  });

  it("keeps the per-key request bucket for valid keys", async () => {
    mocks.selectResults.push([
      {
        id: "key_123",
        practiceId: "practice_123",
        keyHash: "stored-hash",
        scopes: ["clients:read"],
      },
    ]);
    mocks.selectResults.push(ACTIVE_PRACTICE);
    mocks.bcryptCompare.mockResolvedValueOnce(true);

    const result = await authenticateApiKey(
      apiRequest(VALID_SHAPED_KEY),
      "clients:read"
    );

    expect(result).toEqual({
      ok: true,
      ctx: {
        practiceId: "practice_123",
        apiKeyId: "key_123",
        scopes: ["clients:read"],
      },
    });
    expect(mocks.rateLimit).toHaveBeenNthCalledWith(1, {
      key: "apikey-auth:203.0.113.10",
      limit: 1200,
      windowMs: 60000,
    });
    expect(mocks.rateLimit).toHaveBeenNthCalledWith(2, {
      key: "apikey:key_123",
      limit: 600,
      windowMs: 60000,
    });
  });

  it("returns documented rate-limit headers when a valid key is over limit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-27T12:00:20Z"));
    mocks.selectResults.push([
      {
        id: "key_123",
        practiceId: "practice_123",
        keyHash: "stored-hash",
        scopes: ["clients:read"],
      },
    ]);
    mocks.selectResults.push(ACTIVE_PRACTICE);
    mocks.bcryptCompare.mockResolvedValueOnce(true);
    mocks.rateLimit
      .mockResolvedValueOnce({
        success: true,
        remaining: 1199,
        resetAt: new Date("2026-06-27T12:01:00Z"),
      })
      .mockResolvedValueOnce({
        success: false,
        remaining: 0,
        resetAt: new Date("2026-06-27T12:01:05Z"),
      });

    const result = await authenticateApiKey(
      apiRequest(VALID_SHAPED_KEY),
      "clients:read"
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(429);
      expect(result.response.headers.get("Retry-After")).toBe("45");
      expect(result.response.headers.get("X-RateLimit-Limit")).toBe("600");
      expect(result.response.headers.get("X-RateLimit-Remaining")).toBe("0");
      expect(result.response.headers.get("X-RateLimit-Reset")).toBe(
        "2026-06-27T12:01:05.000Z"
      );
      await expect(result.response.json()).resolves.toEqual({
        error: { message: "Rate limit exceeded." },
      });
    }
    expect(mocks.rateLimit).toHaveBeenNthCalledWith(1, {
      key: "apikey-auth:203.0.113.10",
      limit: 1200,
      windowMs: 60000,
    });
    expect(mocks.rateLimit).toHaveBeenNthCalledWith(2, {
      key: "apikey:key_123",
      limit: 600,
      windowMs: 60000,
    });
    expect(mocks.db.update).not.toHaveBeenCalled();
  });

  it("returns a shaped error when the per-key request limiter is unavailable", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.selectResults.push([
      {
        id: "key_123",
        practiceId: "practice_123",
        keyHash: "stored-hash",
        scopes: ["clients:read"],
      },
    ]);
    mocks.selectResults.push(ACTIVE_PRACTICE);
    mocks.bcryptCompare.mockResolvedValueOnce(true);
    mocks.rateLimit
      .mockResolvedValueOnce({
        success: true,
        remaining: 1199,
        resetAt: new Date("2026-06-27T12:00:00Z"),
      })
      .mockRejectedValueOnce(new Error("rate store unavailable"));

    try {
      const result = await authenticateApiKey(
        apiRequest(VALID_SHAPED_KEY),
        "clients:read"
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(500);
        await expect(result.response.json()).resolves.toEqual({
          error: { message: "Internal error" },
        });
      }
      expect(mocks.rateLimit).toHaveBeenNthCalledWith(1, {
        key: "apikey-auth:203.0.113.10",
        limit: 1200,
        windowMs: 60000,
      });
      expect(mocks.rateLimit).toHaveBeenNthCalledWith(2, {
        key: "apikey:key_123",
        limit: 600,
        windowMs: 60000,
      });
      expect(mocks.db.update).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledWith(
        "[api-auth] per-key rate limit failed:",
        expect.any(Error)
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("rejects valid keys when the owning practice is missing or deleted", async () => {
    mocks.selectResults.push([
      {
        id: "key_123",
        practiceId: "practice_123",
        keyHash: "stored-hash",
        scopes: ["clients:read"],
      },
    ]);
    mocks.selectResults.push([]);
    mocks.bcryptCompare.mockResolvedValueOnce(true);

    const result = await authenticateApiKey(
      apiRequest(VALID_SHAPED_KEY),
      "clients:read"
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      await expect(result.response.json()).resolves.toEqual({
        error: { message: "Invalid API key." },
      });
    }
    expect(mocks.rateLimit).toHaveBeenCalledTimes(1);
    expect(mocks.db.update).not.toHaveBeenCalled();
  });

  it("treats deleted-practice keys as invalid before exposing scope failures", async () => {
    mocks.selectResults.push([
      {
        id: "key_123",
        practiceId: "practice_123",
        keyHash: "stored-hash",
        scopes: ["patients:read"],
      },
    ]);
    mocks.selectResults.push([]);
    mocks.bcryptCompare.mockResolvedValueOnce(true);

    const result = await authenticateApiKey(
      apiRequest(VALID_SHAPED_KEY),
      "clients:read"
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      await expect(result.response.json()).resolves.toEqual({
        error: { message: "Invalid API key." },
      });
    }
    expect(mocks.rateLimit).toHaveBeenCalledTimes(1);
    expect(mocks.db.select).toHaveBeenCalledTimes(2);
    expect(mocks.db.update).not.toHaveBeenCalled();
  });

  it("still rejects active-practice keys that lack the required scope", async () => {
    mocks.selectResults.push([
      {
        id: "key_123",
        practiceId: "practice_123",
        keyHash: "stored-hash",
        scopes: ["patients:read"],
      },
    ]);
    mocks.selectResults.push(ACTIVE_PRACTICE);
    mocks.bcryptCompare.mockResolvedValueOnce(true);

    const result = await authenticateApiKey(
      apiRequest(VALID_SHAPED_KEY),
      "clients:read"
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      await expect(result.response.json()).resolves.toEqual({
        error: { message: "API key missing required scope: clients:read" },
      });
    }
    expect(mocks.rateLimit).toHaveBeenCalledTimes(1);
    expect(mocks.db.select).toHaveBeenCalledTimes(2);
    expect(mocks.db.update).not.toHaveBeenCalled();
  });

  it("checks hosted write scopes against the verified practice row", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    mocks.selectResults.push([
      {
        id: "key_123",
        practiceId: "practice_123",
        keyHash: "stored-hash",
        scopes: ["appointments:write"],
      },
    ]);
    mocks.selectResults.push(ACTIVE_PRACTICE);
    mocks.bcryptCompare.mockResolvedValueOnce(true);

    const result = await authenticateApiKey(
      apiRequest(VALID_SHAPED_KEY),
      "appointments:write"
    );

    expect(result.ok).toBe(true);
    expect(mocks.hasHostedFullAccess).toHaveBeenCalledWith(
      "cloud",
      "active",
      null
    );
    expect(apiAuthSource).toContain("practice.tier");
    expect(apiAuthSource).not.toContain("practice?.tier");
    expect(apiAuthSource).not.toContain("practice?.billingStatus");
    expect(apiAuthSource).not.toContain("practice?.trialEndsAt");
  });
});
