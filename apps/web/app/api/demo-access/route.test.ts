import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const onConflictDoUpdate = vi.fn(async () => undefined);
  const values = vi.fn(() => ({ onConflictDoUpdate }));
  const insert = vi.fn(() => ({ values }));

  return {
    db: {},
    tx: { insert },
    insert,
    values,
    onConflictDoUpdate,
    withSystem: vi.fn(async (_db: unknown, fn: (tx: unknown) => unknown) =>
      fn({ insert })
    ),
    demoModeEnabled: vi.fn(() => true),
    createDemoAccessToken: vi.fn(() => "signed-demo-token"),
    rateLimit: vi.fn(async () => ({
      success: true,
      remaining: 4,
      resetAt: new Date("2026-08-06T19:00:00Z"),
    })),
  };
});

vi.mock("@openpims/db/client", () => ({ db: mocks.db }));
vi.mock("@/lib/tenant-db", () => ({ withSystem: mocks.withSystem }));
vi.mock("@/lib/demo-access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/demo-access")>();
  return {
    ...actual,
    createDemoAccessToken: mocks.createDemoAccessToken,
    demoModeEnabled: mocks.demoModeEnabled,
  };
});
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return { ...actual, rateLimit: mocks.rateLimit };
});

const { POST } = await import("./route");

function request(body: unknown, headers: HeadersInit = {}) {
  return new Request("https://demo.openvpm.com/api/demo-access", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.10, 198.51.100.4",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.demoModeEnabled.mockReturnValue(true);
  mocks.createDemoAccessToken.mockReturnValue("signed-demo-token");
  mocks.rateLimit.mockResolvedValue({
    success: true,
    remaining: 4,
    resetAt: new Date("2026-08-06T19:00:00Z"),
  });
});

describe("POST /api/demo-access", () => {
  it("captures a normalized lead and returns a signed HttpOnly cookie", async () => {
    const response = await POST(request({ email: " Vet@Clinic.COM " }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.rateLimit).toHaveBeenNthCalledWith(1, {
      key: "demo-access:ip:203.0.113.10",
      limit: 12,
      windowMs: 60 * 60 * 1000,
    });
    expect(mocks.rateLimit).toHaveBeenNthCalledWith(2, {
      key: expect.stringMatching(/^demo-access:email:[a-f0-9]{64}$/),
      limit: 5,
      windowMs: 60 * 60 * 1000,
    });
    expect(mocks.values).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "vet@clinic.com",
        emailHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      })
    );
    expect(response.headers.get("set-cookie")).toContain(
      "openvpm_demo_access=signed-demo-token"
    );
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("Secure");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("does not exist outside the isolated demo deployment", async () => {
    mocks.demoModeEnabled.mockReturnValue(false);

    const response = await POST(request({ email: "vet@clinic.com" }));

    expect(response.status).toBe(404);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.withSystem).not.toHaveBeenCalled();
  });

  it.each([
    { email: "not-an-email" },
    { email: "x".repeat(256) + "@example.com" },
    { unexpected: "field" },
  ])("rejects invalid input before rate limiting", async (body) => {
    const response = await POST(request(body));

    expect(response.status).toBe(400);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.withSystem).not.toHaveBeenCalled();
  });

  it("uses the lower email limit in 429 response headers", async () => {
    mocks.rateLimit
      .mockResolvedValueOnce({
        success: true,
        remaining: 11,
        resetAt: new Date("2026-08-06T19:00:00Z"),
      })
      .mockResolvedValueOnce({
        success: false,
        remaining: 0,
        resetAt: new Date("2026-08-06T19:00:00Z"),
      });

    const response = await POST(request({ email: "vet@clinic.com" }));

    expect(response.status).toBe(429);
    expect(response.headers.get("x-ratelimit-limit")).toBe("5");
    expect(mocks.withSystem).not.toHaveBeenCalled();
  });

  it("fails closed when durable rate limiting is unavailable", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.rateLimit.mockRejectedValueOnce(new Error("database unavailable"));

    try {
      const response = await POST(request({ email: "vet@clinic.com" }));

      expect(response.status).toBe(503);
      expect(mocks.withSystem).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
