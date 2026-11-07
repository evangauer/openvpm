import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { clients, portalSessions, practices } from "@openpims/db";
import type { Database } from "@openpims/db/client";
import {
  hashPortalSessionToken,
  PORTAL_SESSION_ABSOLUTE_TTL_MS,
  PORTAL_SESSION_IDLE_TTL_MS,
  PORTAL_SESSION_TOKEN_MAX_LENGTH,
  PORTAL_SESSION_TOUCH_INTERVAL_MS,
} from "./tokens";

const PORTAL_SESSION_COOKIE_DEV = "openvpm_portal_session";
const PORTAL_SESSION_COOKIE_PROD = "__Host-openvpm_portal_session";

export type PortalSessionClient = {
  id: string;
  practiceId: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
};

export function portalSessionCookieName(): string {
  return process.env.NODE_ENV === "production"
    ? PORTAL_SESSION_COOKIE_PROD
    : PORTAL_SESSION_COOKIE_DEV;
}

export function portalSessionCookieOptions(now = new Date()) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    expires: new Date(now.getTime() + PORTAL_SESSION_ABSOLUTE_TTL_MS),
    maxAge: Math.floor(PORTAL_SESSION_ABSOLUTE_TTL_MS / 1000),
  };
}

export function portalSessionTokenFromCookie(
  cookieHeader: string | null | undefined,
): string | null {
  if (!cookieHeader) return null;
  const expectedName = portalSessionCookieName();
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== expectedName) continue;
    const value = part.slice(separator + 1).trim();
    return /^[0-9a-f]+$/i.test(value) &&
      value.length === PORTAL_SESSION_TOKEN_MAX_LENGTH
      ? value.toLowerCase()
      : null;
  }
  return null;
}

export function portalSessionExpiresAt(now = new Date()): Date {
  return new Date(now.getTime() + PORTAL_SESSION_ABSOLUTE_TTL_MS);
}

/** Resolve an opaque cookie against a revocable, absolute + idle-expiring row. */
export async function resolvePortalSession(
  db: Database,
  rawToken: string | null | undefined,
  now = new Date(),
): Promise<{ sessionId: string; client: PortalSessionClient } | null> {
  if (
    !rawToken ||
    rawToken.length !== PORTAL_SESSION_TOKEN_MAX_LENGTH ||
    !/^[0-9a-f]+$/i.test(rawToken)
  ) {
    return null;
  }

  const idleCutoff = new Date(now.getTime() - PORTAL_SESSION_IDLE_TTL_MS);
  const [row] = await db
    .select({
      sessionId: portalSessions.id,
      lastSeenAt: portalSessions.lastSeenAt,
      clientId: clients.id,
      practiceId: clients.practiceId,
      firstName: clients.firstName,
      lastName: clients.lastName,
      email: clients.email,
      phone: clients.phone,
    })
    .from(portalSessions)
    .innerJoin(
      clients,
      and(
        eq(clients.id, portalSessions.clientId),
        eq(clients.practiceId, portalSessions.practiceId),
        isNull(clients.deletedAt),
      ),
    )
    .innerJoin(
      practices,
      and(
        eq(practices.id, portalSessions.practiceId),
        isNull(practices.deletedAt),
      ),
    )
    .where(
      and(
        eq(portalSessions.tokenHash, hashPortalSessionToken(rawToken)),
        isNull(portalSessions.revokedAt),
        isNull(portalSessions.deletedAt),
        gt(portalSessions.expiresAt, now),
        gt(portalSessions.lastSeenAt, idleCutoff),
      ),
    )
    .limit(1);

  if (!row) return null;

  const touchBefore = new Date(now.getTime() - PORTAL_SESSION_TOUCH_INTERVAL_MS);
  if (row.lastSeenAt < touchBefore) {
    await db
      .update(portalSessions)
      .set({ lastSeenAt: now })
      .where(
        and(
          eq(portalSessions.id, row.sessionId),
          isNull(portalSessions.revokedAt),
          gt(portalSessions.expiresAt, now),
          lt(portalSessions.lastSeenAt, touchBefore),
        ),
      );
  }

  return {
    sessionId: row.sessionId,
    client: {
      id: row.clientId,
      practiceId: row.practiceId,
      firstName: row.firstName,
      lastName: row.lastName,
      email: row.email,
      phone: row.phone,
    },
  };
}
