import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => {
  const selectResults: unknown[][] = [];
  const tx = {
    select: vi.fn(() => {
      const rows = selectResults.shift() ?? [];
      const builder: Record<string, unknown> = {};
      builder.from = vi.fn(() => builder);
      builder.leftJoin = vi.fn(() => builder);
      builder.where = vi.fn(() =>
        Object.assign(Promise.resolve(rows), {
          limit: vi.fn(async () => rows),
        })
      );
      return builder;
    }),
  };
  return {
    selectResults,
    tx,
    withSystem: vi.fn(async (_db: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx)
    ),
    rateLimit: vi.fn(async () => ({
      success: true,
      remaining: 10,
      resetAt: new Date("2026-07-08T13:00:00Z"),
    })),
  };
});

vi.mock("@openpims/db/client", () => ({ db: {} }));
vi.mock("@/lib/tenant-db", () => ({ withSystem: mocks.withSystem }));
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return {
    rateLimit: mocks.rateLimit,
    rateLimitResponseHeaders: actual.rateLimitResponseHeaders,
  };
});

const { GET } = await import("./route");

const TOKEN = "ab".repeat(32);

function request(path: string): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`);
}

function call(tokenParam: string) {
  return GET(request(`/api/calendar/${tokenParam}`), {
    params: Promise.resolve({ token: tokenParam }),
  });
}

const practiceRow = {
  id: "00000000-0000-0000-0000-0000000000aa",
  name: "Aspen Creek Animal Hospital",
  timezone: "America/Denver",
};

const appointmentRow = {
  id: "appt-1",
  startTime: new Date("2026-07-08T15:00:00Z"),
  endTime: new Date("2026-07-08T15:30:00Z"),
  updatedAt: new Date("2026-07-08T01:00:00Z"),
  status: "confirmed",
  patientName: "Biscuit",
  typeName: "Wellness Exam",
  roomName: "Exam 1",
  doctorName: "Sarah Chen",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.selectResults.length = 0;
});

describe("GET /api/calendar/[token]", () => {
  it("404s on malformed tokens before doing any work", async () => {
    for (const bad of ["short", "Z".repeat(64), "../etc", `${TOKEN}x`]) {
      const res = await call(bad);
      expect(res.status).toBe(404);
    }
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.withSystem).not.toHaveBeenCalled();
  });

  it("404s generically on an unknown token (no validity oracle)", async () => {
    mocks.selectResults.push([]); // practice lookup miss
    const res = await call(TOKEN);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("429s with rate-limit headers when a limit trips", async () => {
    mocks.rateLimit.mockResolvedValueOnce({
      success: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 60_000),
    });
    const res = await call(TOKEN);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(mocks.withSystem).not.toHaveBeenCalled();
  });

  it("serves the practice feed as text/calendar", async () => {
    mocks.selectResults.push([practiceRow], [appointmentRow]);
    const res = await call(TOKEN);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/calendar");
    const body = await res.text();
    expect(body).toContain("BEGIN:VCALENDAR");
    expect(body).toContain("UID:appt-appt-1@openvpm");
    expect(body).toContain("SUMMARY:Biscuit - Wellness Exam");
    expect(body).toContain("X-WR-CALNAME:Aspen Creek Animal Hospital schedule");
  });

  it("accepts the friendlier .ics suffix", async () => {
    mocks.selectResults.push([practiceRow], []);
    const res = await call(`${TOKEN}.ics`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("END:VCALENDAR");
  });

  it("rate limits both the token and the caller IP", async () => {
    mocks.selectResults.push([practiceRow], []);
    await call(TOKEN);
    const keys = (
      mocks.rateLimit.mock.calls as unknown as [{ key: string }][]
    ).map((c) => c[0].key);
    expect(keys.some((k) => k.startsWith("calendar-feed:ip:"))).toBe(true);
    expect(keys.some((k) => k.startsWith("calendar-feed:token:"))).toBe(true);
    // The raw token never appears in a rate-limit key (it is hashed).
    expect(keys.every((k) => !k.includes(TOKEN))).toBe(true);
  });
});
