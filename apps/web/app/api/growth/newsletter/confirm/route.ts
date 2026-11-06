import { z } from "zod";
import { db } from "@openpims/db/client";
import { billingEnforced } from "@/lib/billing/plans";
import { withSystem } from "@/lib/tenant-db";
import { rateLimit } from "@/lib/rate-limit";
import { clientIpFromRequest } from "@/lib/request-ip";
import { readJsonRequestBody } from "@/lib/request-json";
import { confirmNewsletterSubscription, verifyNewsletterToken } from "@/lib/growth/newsletter";

export const dynamic = "force-dynamic";

/** Explicit POST, never an email scanner's GET. Existing links survive a signup pause. */
export async function POST(request: Request) {
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  if (!billingEnforced()) return json({ error: "Not found" }, 404);
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return json({ error: "Forbidden" }, 403);
  const body = await readJsonRequestBody(request, 1024);
  if (!body.ok) return json({ error: "Invalid request" }, body.reason === "too_large" ? 413 : 400);
  const parsed = z.object({ token: z.string().max(512) }).strict().safeParse(body.data);
  const verified = parsed.success ? verifyNewsletterToken(parsed.data.token) : null;
  if (!verified) return json({ error: "This link has expired or is invalid. Request a new confirmation email." }, 400);
  try {
    if (!(await rateLimit({ key: `newsletter-confirm:ip:${clientIpFromRequest(request)}`, limit: 30, windowMs: 60 * 60_000 })).success) return json({ error: "Please try again later." }, 429);
    const confirmed = await withSystem(db, (tx) => confirmNewsletterSubscription(tx, { ...verified, now: new Date() }));
    return confirmed ? json({ ok: true }) : json({ error: "This link is no longer active. Request a new confirmation email." }, 400);
  } catch {
    console.error("[newsletter] confirmation failed");
    return json({ error: "We couldn't confirm your email. Please try again." }, 503);
  }
}
