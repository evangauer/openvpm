import { NextRequest, NextResponse } from "next/server";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { clients, portalSessions, practices } from "@openpims/db";
import { db } from "@openpims/db/client";
import { withSystem } from "@/lib/tenant-db";
import { readJsonRequestBody } from "@/lib/request-json";
import { clientIpFromRequest } from "@/lib/request-ip";
import { isSameOriginRequest } from "@/lib/request-origin";
import { rateLimit } from "@/lib/rate-limit";
import {
  generatePortalSessionToken,
  hashPortalAccessToken,
  hashPortalRequestMetadata,
  hashPortalSessionToken,
  PORTAL_ACCESS_TOKEN_MAX_LENGTH,
  portalRateLimitKey,
} from "@/lib/portal/tokens";
import {
  portalSessionCookieName,
  portalSessionCookieOptions,
  portalSessionExpiresAt,
  portalSessionTokenFromCookie,
} from "@/lib/portal/session";

const exchangeInput = z.object({
  token: z.string().trim().min(1).max(PORTAL_ACCESS_TOKEN_MAX_LENGTH),
});
const NO_STORE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" };
const GENERIC_ERROR =
  "This portal link is invalid or has expired. Please ask your clinic for a new link.";

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

async function allowExchange(ip: string, token: string): Promise<boolean> {
  try {
    const [ipLimit, tokenLimit] = await Promise.all([
      rateLimit({
        key: `portal-session:ip:${ip}`,
        limit: 20,
        windowMs: 15 * 60 * 1000,
      }),
      rateLimit({
        key: portalRateLimitKey("portal-session", token),
        limit: 5,
        windowMs: 15 * 60 * 1000,
      }),
    ]);
    return ipLimit.success && tokenLimit.success;
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  const body = await readJsonRequestBody(req);
  if (!body.ok) return json({ error: GENERIC_ERROR }, 400);
  const parsed = exchangeInput.safeParse(body.data);
  if (!parsed.success) return json({ error: GENERIC_ERROR }, 400);

  const ip = clientIpFromRequest(req);
  if (!(await allowExchange(ip, parsed.data.token))) {
    return json(
      { error: "Too many attempts. Please wait and ask your clinic for help." },
      429,
    );
  }

  const now = new Date();
  const rawSessionToken = generatePortalSessionToken();
  const sessionTokenHash = hashPortalSessionToken(rawSessionToken);
  const accessTokenHash = hashPortalAccessToken(parsed.data.token);

  let claimed: boolean;
  try {
    claimed = await withSystem(db, async (tx) => {
      const [client] = await tx
        .update(clients)
        .set({ portalAccessTokenUsedAt: now })
        .where(
          and(
            eq(clients.accessToken, accessTokenHash),
            isNull(clients.portalAccessTokenUsedAt),
            gt(clients.portalAccessTokenExpiresAt, now),
            isNull(clients.deletedAt),
            sql`exists (
              select 1 from ${practices}
              where ${practices.id} = ${clients.practiceId}
                and ${practices.deletedAt} is null
            )`,
          ),
        )
        .returning({ id: clients.id, practiceId: clients.practiceId });

      if (!client) return false;

      await tx.insert(portalSessions).values({
        practiceId: client.practiceId,
        clientId: client.id,
        tokenHash: sessionTokenHash,
        lastSeenAt: now,
        expiresAt: portalSessionExpiresAt(now),
        createdIpHash: hashPortalRequestMetadata(ip),
        userAgentHash: hashPortalRequestMetadata(req.headers.get("user-agent")),
      });
      return true;
    });
  } catch {
    console.error("[portal-session] exchange failed");
    return json({ error: "Portal access is temporarily unavailable." }, 500);
  }

  if (!claimed) return json({ error: GENERIC_ERROR }, 404);

  const response = json({ redirectTo: "/portal" });
  response.cookies.set(
    portalSessionCookieName(),
    rawSessionToken,
    portalSessionCookieOptions(now),
  );
  return response;
}

export async function DELETE(req: NextRequest) {
  if (!isSameOriginRequest(req)) {
    return json({ error: "Invalid request origin" }, 403);
  }

  const rawSessionToken = portalSessionTokenFromCookie(
    req.headers.get("cookie"),
  );
  if (rawSessionToken) {
    await withSystem(db, (tx) =>
      tx
        .update(portalSessions)
        .set({ revokedAt: new Date(), revokedReason: "client_logout" })
        .where(
          and(
            eq(portalSessions.tokenHash, hashPortalSessionToken(rawSessionToken)),
            isNull(portalSessions.revokedAt),
          ),
        ),
    );
  }

  const response = json({ ok: true });
  response.cookies.set(portalSessionCookieName(), "", {
    ...portalSessionCookieOptions(),
    expires: new Date(0),
    maxAge: 0,
  });
  return response;
}
