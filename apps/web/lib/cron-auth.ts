import { NextResponse } from "next/server";
import crypto from "node:crypto";

/**
 * Whether a scheduled-job (cron) invocation is authorized.
 *
 * Vercel Cron triggers the route with `Authorization: Bearer <CRON_SECRET>` — it
 * cannot set arbitrary custom headers from vercel.json, so the older
 * `x-cron-secret` check silently 401'd every Vercel-triggered run. We accept the
 * Bearer header (production) AND keep `x-cron-secret` as a fallback for manual /
 * local triggering (curl, scripts). If `CRON_SECRET` is unset we never authorize
 * — an unauthenticated cron sweep would be a cross-tenant data risk.
 */
export function isCronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const authorization = request.headers.get("authorization");
  const bearer = authorization?.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : null;
  const provided = bearer ?? request.headers.get("x-cron-secret");

  return !!provided && safeEqual(provided, secret);
}

/**
 * Returns a 401 `NextResponse` to short-circuit a cron route with, or `null`
 * when the request is authorized.
 */
export function cronAuthError(request: Request): NextResponse | null {
  return isCronAuthorized(request)
    ? null
    : NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
