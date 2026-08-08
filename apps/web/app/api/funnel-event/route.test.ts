import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: {},
  tx: {},
  insertFunnelEvent: vi.fn(async () => true),
  withSystem: vi.fn(async (_db: unknown, fn: (tx: unknown) => unknown) =>
    fn({})
  ),
  rateLimit: vi.fn(async () => ({
    success: true,
    remaining: 119,
    resetAt: new Date("2026-08-07T12:05:00Z"),
  })),
}));

vi.mock("@openpims/db/client", () => ({ db: mocks.db }));
vi.mock("@/lib/tenant-db", () => ({ withSystem: mocks.withSystem }));
vi.mock("@/lib/funnel-events-server", () => ({
  insertFunnelEvent: mocks.insertFunnelEvent,
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return { ...actual, rateLimit: mocks.rateLimit };
});

const { OPTIONS, POST } = await import("./route");

function request(body: unknown, origin = "https://openvpm.com") {
  return new Request("https://app.openvpm.com/api/funnel-event", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      "x-forwarded-for": "203.0.113.10",
    },
    body: JSON.stringify(body),
  });
}

const validEvent = {
  eventId: "223e4567-e89b-42d3-a456-426614174000",
  anonymousId: "123e4567-e89b-42d3-a456-426614174000",
  name: "visit",
  source: "homepage",
  path: "/patients/323e4567-e89b-42d3-a456-426614174000?tab=records",
  props: {
    placement: "hero",
    unsafe_key: "removed because public metadata is allowlisted",
    "bad-key": "removed",
    long: "x".repeat(201),
  },
};

afterEach(() => {
  vi.clearAllMocks();
  mocks.rateLimit.mockResolvedValue({
    success: true,
    remaining: 119,
    resetAt: new Date("2026-08-07T12:05:00Z"),
  });
});

describe("/api/funnel-event", () => {
  it("accepts a privacy-bounded first-party event with CORS", async () => {
    const response = await POST(request(validEvent));

    expect(response.status).toBe(202);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://openvpm.com"
    );
    expect(mocks.rateLimit).toHaveBeenCalledWith({
      key: "funnel-event:ip:203.0.113.10",
      limit: 120,
      windowMs: 5 * 60 * 1000,
    });
    expect(mocks.insertFunnelEvent).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        id: validEvent.eventId,
        eventName: "visit",
        anonymousId: validEvent.anonymousId,
        source: "homepage",
        path: "/patients/:id",
        origin: "https://openvpm.com",
        metadata: {
          placement: "hero",
        },
      })
    );
  });

  it("rejects untrusted origins before writing", async () => {
    const response = await POST(request(validEvent, "https://evil.example"));
    expect(response.status).toBe(403);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.insertFunnelEvent).not.toHaveBeenCalled();
  });

  it("rejects malformed or unknown events", async () => {
    const response = await POST(request({ ...validEvent, name: "email" }));
    expect(response.status).toBe(400);
    expect(mocks.insertFunnelEvent).not.toHaveBeenCalled();
  });

  it("answers trusted preflight requests", async () => {
    const response = await OPTIONS(
      new Request("https://app.openvpm.com/api/funnel-event", {
        method: "OPTIONS",
        headers: { origin: "https://openvpm.com" },
      })
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://openvpm.com"
    );
  });

  it("accepts events from the hosted demo origin", async () => {
    const response = await POST(
      request(
        {
          ...validEvent,
          name: "demo_gate_viewed",
          path: "/login",
          source: undefined,
        },
        "https://demo.openvpm.com"
      )
    );

    expect(response.status).toBe(202);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://demo.openvpm.com"
    );
    expect(mocks.insertFunnelEvent).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        eventName: "demo_gate_viewed",
        origin: "https://demo.openvpm.com",
        path: "/login",
      })
    );
  });
});
