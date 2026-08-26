import { describe, expect, it, vi } from "vitest";
import {
  portalSessionCookieName,
  portalSessionCookieOptions,
  portalSessionTokenFromCookie,
  resolvePortalSession,
} from "../session";
import {
  generatePortalAccessToken,
  generatePortalSessionToken,
  hashPortalAccessToken,
  hashPortalSessionToken,
  PORTAL_SESSION_IDLE_TTL_MS,
} from "../tokens";

describe("portal credential primitives", () => {
  it("generates 256-bit opaque values and stores only deterministic digests", () => {
    const access = generatePortalAccessToken();
    const session = generatePortalSessionToken();
    expect(access).toMatch(/^[0-9a-f]{64}$/);
    expect(session).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPortalAccessToken(access)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPortalAccessToken(access)).not.toBe(access);
    expect(hashPortalSessionToken(session)).not.toBe(session);
  });

  it("accepts only the exact opaque portal cookie", () => {
    const name = portalSessionCookieName();
    const token = "a".repeat(64);
    expect(portalSessionTokenFromCookie(`other=x; ${name}=${token}`)).toBe(token);
    expect(portalSessionTokenFromCookie(`${name}=short`)).toBeNull();
    expect(portalSessionTokenFromCookie(`${name}=${"z".repeat(64)}`)).toBeNull();
    expect(portalSessionTokenFromCookie(null)).toBeNull();
  });

  it("uses an HttpOnly, same-site, root-scoped expiring cookie", () => {
    const options = portalSessionCookieOptions(new Date("2026-08-26T12:00:00Z"));
    expect(options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    expect(options.maxAge).toBeGreaterThan(0);
    expect(options.expires.getTime()).toBeGreaterThan(
      new Date("2026-08-26T12:00:00Z").getTime(),
    );
  });
});

describe("resolvePortalSession", () => {
  it("resolves an active tenant session and throttles last-seen writes", async () => {
    const now = new Date("2026-08-26T12:00:00Z");
    const row = {
      sessionId: "00000000-0000-0000-0000-000000000001",
      lastSeenAt: new Date(now.getTime() - 10 * 60 * 1000),
      clientId: "00000000-0000-0000-0000-000000000002",
      practiceId: "00000000-0000-0000-0000-000000000003",
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.test",
      phone: null,
    };
    const limit = vi.fn(async () => [row]);
    const selectBuilder: Record<string, unknown> = {};
    selectBuilder.from = vi.fn(() => selectBuilder);
    selectBuilder.innerJoin = vi.fn(() => selectBuilder);
    selectBuilder.where = vi.fn(() => ({ limit }));
    const updateWhere = vi.fn(async () => undefined);
    const updateSet = vi.fn(() => ({ where: updateWhere }));
    const db = {
      select: vi.fn(() => selectBuilder),
      update: vi.fn(() => ({ set: updateSet })),
    };

    await expect(
      resolvePortalSession(db as never, "a".repeat(64), now),
    ).resolves.toMatchObject({
      sessionId: row.sessionId,
      client: { id: row.clientId, practiceId: row.practiceId },
    });
    expect(updateSet).toHaveBeenCalledWith({ lastSeenAt: now });
  });

  it("fails closed for malformed or unresolved/idle-expired credentials", async () => {
    const db = { select: vi.fn() };
    await expect(resolvePortalSession(db as never, "bad")).resolves.toBeNull();
    expect(db.select).not.toHaveBeenCalled();

    const now = new Date("2026-08-26T12:00:00Z");
    const limit = vi.fn(async () => []);
    const builder: Record<string, unknown> = {};
    builder.from = vi.fn(() => builder);
    builder.innerJoin = vi.fn(() => builder);
    builder.where = vi.fn(() => ({ limit }));
    const unresolvedDb = { select: vi.fn(() => builder) };
    await expect(
      resolvePortalSession(unresolvedDb as never, "b".repeat(64), now),
    ).resolves.toBeNull();
    expect(PORTAL_SESSION_IDLE_TTL_MS).toBe(30 * 60 * 1000);
  });
});
