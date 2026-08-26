import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const updateRows: unknown[][] = [];
  const updateWhere = vi.fn(() => ({
    returning: vi.fn(async () => updateRows.shift() ?? []),
  }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));
  const inserted: Record<string, unknown>[] = [];
  const insertValues = vi.fn(async (values: Record<string, unknown>) => {
    inserted.push(values);
  });
  const db = { update, insert: vi.fn(() => ({ values: insertValues })) };
  return {
    db,
    updateRows,
    updateSet,
    updateWhere,
    inserted,
    insertValues,
    withSystem: vi.fn(async (_db: unknown, fn: (tx: unknown) => unknown) => fn(db)),
    rateLimit: vi.fn(async () => ({
      success: true,
      remaining: 4,
      resetAt: new Date("2026-08-26T12:15:00Z"),
    })),
  };
});

vi.mock("@openpims/db/client", () => ({ db: mocks.db }));
vi.mock("@/lib/tenant-db", () => ({ withSystem: mocks.withSystem }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.rateLimit }));

const { DELETE, POST } = await import("./route");
const { hashPortalAccessToken, hashPortalSessionToken } = await import(
  "@/lib/portal/tokens"
);
const { portalSessionCookieName } = await import("@/lib/portal/session");

const CLIENT_ID = "00000000-0000-0000-0000-000000000001";
const PRACTICE_ID = "00000000-0000-0000-0000-000000000002";
const RAW_LINK = "a".repeat(64);

function request(body: unknown, headers: HeadersInit = {}) {
  const req = new Request("https://portal.example.test/api/portal/session", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  Object.defineProperty(req, "nextUrl", {
    value: new URL("https://portal.example.test/api/portal/session"),
  });
  return req as never;
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.updateRows.length = 0;
  mocks.inserted.length = 0;
  mocks.rateLimit.mockResolvedValue({
    success: true,
    remaining: 4,
    resetAt: new Date("2026-08-26T12:15:00Z"),
  });
});

describe("portal session exchange", () => {
  it("atomically consumes a one-time link and sets an opaque HttpOnly cookie", async () => {
    mocks.updateRows.push([{ id: CLIENT_ID, practiceId: PRACTICE_ID }]);
    const response = await POST(
      request({ token: RAW_LINK }, { "user-agent": "Portal Browser" }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ redirectTo: "/portal" });
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${portalSessionCookieName()}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie.toLowerCase()).toContain("samesite=lax");
    expect(setCookie).not.toContain(RAW_LINK);
    expect(mocks.updateWhere).toHaveBeenCalledTimes(1);
    expect(mocks.inserted).toHaveLength(1);
    expect(mocks.inserted[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(mocks.inserted[0]?.tokenHash).not.toBe(RAW_LINK);
    expect(hashPortalAccessToken(RAW_LINK)).not.toBe(RAW_LINK);
  });

  it("rejects a replay without creating a second session", async () => {
    mocks.updateRows.push([]);
    const response = await POST(request({ token: RAW_LINK }));
    expect(response.status).toBe(404);
    expect(mocks.insertValues).not.toHaveBeenCalled();
  });

  it("fails closed when either abuse limiter is unavailable", async () => {
    mocks.rateLimit.mockRejectedValueOnce(new Error("rate limit unavailable"));
    const response = await POST(request({ token: RAW_LINK }));
    expect(response.status).toBe(429);
    expect(mocks.withSystem).not.toHaveBeenCalled();
  });

  it("returns a generic error when the atomic exchange cannot persist", async () => {
    mocks.withSystem.mockRejectedValueOnce(new Error("database detail"));
    const response = await POST(request({ token: RAW_LINK }));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Portal access is temporarily unavailable.",
    });
  });

  it("revokes the current server-side session and clears the cookie", async () => {
    const rawSession = "b".repeat(64);
    const req = new Request("https://portal.example.test/api/portal/session", {
      method: "DELETE",
      headers: {
        origin: "https://portal.example.test",
        cookie: `${portalSessionCookieName()}=${rawSession}`,
      },
    });
    Object.defineProperty(req, "nextUrl", {
      value: new URL("https://portal.example.test/api/portal/session"),
    });

    const response = await DELETE(req as never);
    expect(response.status).toBe(200);
    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ revokedReason: "client_logout" }),
    );
    expect(hashPortalSessionToken(rawSession)).not.toBe(rawSession);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("accepts the browser origin when the framework URL uses an internal proxy host", async () => {
    const rawSession = "c".repeat(64);
    const req = new Request("http://internal-next:3000/api/portal/session", {
      method: "DELETE",
      headers: {
        host: "portal.example.test",
        "x-forwarded-proto": "https",
        origin: "https://portal.example.test",
        cookie: `${portalSessionCookieName()}=${rawSession}`,
      },
    });

    const response = await DELETE(req as never);
    expect(response.status).toBe(200);
    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ revokedReason: "client_logout" }),
    );
  });

  it("rejects a cross-origin logout request", async () => {
    const rawSession = "d".repeat(64);
    const req = new Request("https://portal.example.test/api/portal/session", {
      method: "DELETE",
      headers: {
        host: "portal.example.test",
        origin: "https://attacker.example",
        cookie: `${portalSessionCookieName()}=${rawSession}`,
      },
    });

    const response = await DELETE(req as never);
    expect(response.status).toBe(403);
    expect(mocks.withSystem).not.toHaveBeenCalled();
  });
});
