import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: {},
  captureException: vi.fn(async () => undefined),
  insertFunnelEvent: vi.fn(async () => true),
  withSystem: vi.fn(async (_db: unknown, fn: (tx: unknown) => unknown) =>
    fn({})
  ),
  rateLimit: vi.fn(async () => ({
    success: true,
    remaining: 29,
    resetAt: new Date("2026-06-27T12:05:00Z"),
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
}));

vi.mock("@openpims/db/client", () => ({ db: mocks.db }));

vi.mock("@/lib/tenant-db", () => ({ withSystem: mocks.withSystem }));

vi.mock("@/lib/funnel-events-server", () => ({
  insertFunnelEvent: mocks.insertFunnelEvent,
}));

vi.mock("@/lib/error-tracking", () => ({
  captureException: mocks.captureException,
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: mocks.rateLimit,
  rateLimitResponseHeaders: mocks.rateLimitResponseHeaders,
}));

const { POST } = await import("./route");
const { JSON_REQUEST_BODY_MAX_BYTES } = await import("@/lib/request-json");

function request(body: unknown, headers: HeadersInit = {}) {
  return new Request("https://app.example.com/api/error-report", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  mocks.rateLimit.mockResolvedValue({
    success: true,
    remaining: 29,
    resetAt: new Date("2026-06-27T12:05:00Z"),
  });
});

describe("POST /api/error-report", () => {
  it("rejects oversized reports before rate limits or capture", async () => {
    const response = await POST(
      request(
        { source: "app-error", message: "boom" },
        { "content-length": String(JSON_REQUEST_BODY_MAX_BYTES + 1) }
      )
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ ok: false });
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it("rate limits by forwarded client IP before capturing", async () => {
    const response = await POST(
      request(
        {
          source: "app-error",
          message: "boom",
          stack: "stack",
          digest: "digest",
          path: "/patients/323e4567-e89b-42d3-a456-426614174000?tab=records",
          anonymousId: "123e4567-e89b-42d3-a456-426614174000",
        },
        { "x-forwarded-for": "203.0.113.10, 198.51.100.4" }
      )
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.rateLimit).toHaveBeenCalledWith({
      key: "error-report:ip:203.0.113.10",
      limit: 30,
      windowMs: 5 * 60 * 1000,
    });
    expect(mocks.captureException).toHaveBeenCalledWith({
      source: "app-error",
      message: "boom",
      stack: "stack",
      digest: "digest",
      path: "/patients/323e4567-e89b-42d3-a456-426614174000?tab=records",
    });
    expect(mocks.insertFunnelEvent).toHaveBeenCalledWith(
      {},
      {
        eventName: "client_error",
        anonymousId: "123e4567-e89b-42d3-a456-426614174000",
        source: "app-error",
        path: "/patients/:id",
        metadata: { digest: "digest" },
      }
    );
  });

  it("rejects over-limit clients without forwarding the report", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-27T12:00:15Z"));
    mocks.rateLimit.mockResolvedValueOnce({
      success: false,
      remaining: 0,
      resetAt: new Date("2026-06-27T12:05:00Z"),
    });

    const response = await POST(
      request({ source: "app-error", message: "boom" })
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("285");
    expect(response.headers.get("X-RateLimit-Limit")).toBe("30");
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(response.headers.get("X-RateLimit-Reset")).toBe(
      "2026-06-27T12:05:00.000Z"
    );
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it("fails closed if the rate limiter is unavailable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-27T12:00:15Z"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.rateLimit.mockRejectedValueOnce(new Error("db unavailable"));

    try {
      const response = await POST(
        request({ source: "global-error", message: "boom" })
      );

      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe("300");
      expect(response.headers.get("X-RateLimit-Limit")).toBe("30");
      expect(response.headers.get("X-RateLimit-Remaining")).toBe("0");
      expect(response.headers.get("X-RateLimit-Reset")).toBe(
        "2026-06-27T12:05:15.000Z"
      );
      await expect(response.json()).resolves.toEqual({ ok: false });
      expect(errorSpy).toHaveBeenCalledWith(
        "[error-report] rate limit failed:",
        expect.any(Error)
      );
      expect(mocks.captureException).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
