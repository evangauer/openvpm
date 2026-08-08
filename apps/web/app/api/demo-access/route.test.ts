import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
      fn({ insert }),
    ),
    demoModeEnabled: vi.fn(() => true),
    createDemoAccessToken: vi.fn(() => "signed-demo-token"),
    rateLimit: vi.fn(async () => ({
      success: true,
      remaining: 4,
      resetAt: new Date("2026-08-06T19:00:00Z"),
    })),
    fetchFunnel: vi.fn(),
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

const ANONYMOUS_ID = "00000000-0000-4000-8000-000000000001";

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

beforeEach(() => {
  vi.stubGlobal("fetch", mocks.fetchFunnel);
  mocks.fetchFunnel.mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), { status: 202 }),
  );
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
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
    const response = await POST(
      request({ email: " Vet@Clinic.COM ", anonymousId: ANONYMOUS_ID }),
    );

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
      }),
    );
    expect(response.headers.get("set-cookie")).toContain(
      "openvpm_demo_access=signed-demo-token",
    );
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("Secure");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.fetchFunnel).toHaveBeenCalledWith(
      new URL("https://app.openvpm.com/api/funnel-event"),
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://demo.openvpm.com",
        },
      }),
    );
    const funnelBody = JSON.parse(
      String(mocks.fetchFunnel.mock.calls[0]?.[1]?.body),
    );
    expect(funnelBody).toMatchObject({
      eventId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      anonymousId: ANONYMOUS_ID,
      name: "demo_gate_submitted",
      source: "demo",
      path: "/login",
    });
    expect(JSON.stringify(funnelBody)).not.toContain("vet@clinic.com");
  });

  it("keeps access immediate when production funnel recording is unavailable", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mocks.fetchFunnel.mockRejectedValueOnce(new Error("funnel unavailable"));

    try {
      const response = await POST(
        request({ email: "vet@clinic.com", anonymousId: ANONYMOUS_ID }),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toContain(
        "openvpm_demo_access=signed-demo-token",
      );
      expect(errorSpy).toHaveBeenCalledWith(
        "[demo-access] funnel capture failed:",
        expect.any(Error),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("does not exist outside the isolated demo deployment", async () => {
    mocks.demoModeEnabled.mockReturnValue(false);

    const response = await POST(request({ email: "vet@clinic.com" }));

    expect(response.status).toBe(404);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.fetchFunnel).not.toHaveBeenCalled();
  });

  it.each([
    { email: "not-an-email" },
    { email: "x".repeat(256) + "@example.com" },
    { email: "vet@clinic.com", anonymousId: "not-a-uuid" },
    { unexpected: "field" },
  ])("rejects invalid input before rate limiting", async (body) => {
    const response = await POST(request(body));

    expect(response.status).toBe(400);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.fetchFunnel).not.toHaveBeenCalled();
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
    expect(mocks.fetchFunnel).not.toHaveBeenCalled();
  });

  it("fails closed when durable rate limiting is unavailable", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mocks.rateLimit.mockRejectedValueOnce(new Error("database unavailable"));

    try {
      const response = await POST(request({ email: "vet@clinic.com" }));

      expect(response.status).toBe(503);
      expect(mocks.withSystem).not.toHaveBeenCalled();
      expect(mocks.fetchFunnel).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("does not record gate acceptance when a demo token cannot be created", async () => {
    mocks.createDemoAccessToken.mockReturnValueOnce(null as never);

    const response = await POST(
      request({ email: "vet@clinic.com", anonymousId: ANONYMOUS_ID }),
    );

    expect(response.status).toBe(503);
    expect(mocks.onConflictDoUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.fetchFunnel).not.toHaveBeenCalled();
  });
});
