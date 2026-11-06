import { z } from "zod";
import { db } from "@openpims/db/client";
import { billingEnforced } from "@/lib/billing/plans";
import { withSystem } from "@/lib/tenant-db";
import { rateLimit } from "@/lib/rate-limit";
import { clientIpFromRequest } from "@/lib/request-ip";
import { readJsonRequestBody } from "@/lib/request-json";
import { sendNewsletterEmail } from "@/lib/email";
import { sendLeadEmail } from "@/lib/growth/lead-email";
import { leadEmailHash } from "@/lib/growth/leads";
import { NEWSLETTER_DISCLOSURE, NEWSLETTER_INTERESTS, createNewsletterToken, newsletterSignupEnabled, requestNewsletterSubscription, newsletterConfirmationEligible } from "@/lib/growth/newsletter";
import { newsletterJson, newsletterOptions, newsletterOriginAllowed } from "@/lib/growth/newsletter-http";

export const dynamic = "force-dynamic";
export const OPTIONS = newsletterOptions;
const inputSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
  anonymousId: z.string().uuid().optional(),
  interest: z.enum(NEWSLETTER_INTERESTS).default("general"),
  placement: z.string().max(180).regex(/^[a-zA-Z0-9._:/-]+$/).default("site"),
  disclosureVersion: z.literal(NEWSLETTER_DISCLOSURE),
  consent: z.literal(true),
}).strict();

export async function POST(request: Request) {
  if (!billingEnforced() || !newsletterSignupEnabled()) return newsletterJson(request, { error: "Signup is not available yet." }, 404);
  if (!newsletterOriginAllowed(request)) return newsletterJson(request, { error: "Forbidden" }, 403);
  const body = await readJsonRequestBody(request, 2048);
  if (!body.ok) return newsletterJson(request, { error: "Invalid request" }, body.reason === "too_large" ? 413 : 400);
  const parsed = inputSchema.safeParse(body.data);
  if (!parsed.success) return newsletterJson(request, { error: "Enter a valid email and confirm your subscription request." }, 400);
  const now = new Date();
  // Check signing before storing anything or claiming an email.
  if (!createNewsletterToken("00000000-0000-4000-8000-000000000000", {
    disclosureVersion: NEWSLETTER_DISCLOSURE, nonce: "00000000-0000-4000-8000-000000000000",
    requestedAt: now.toISOString(), confirmedAt: null, interest: "general", placement: "site",
  })) return newsletterJson(request, { error: "Signup is temporarily unavailable." }, 503);
  try {
    for (const [key, limit] of [
      [`newsletter:ip:${clientIpFromRequest(request)}`, 20],
      [`newsletter:email:${leadEmailHash(parsed.data.email)}`, 3],
    ] as const) {
      if (!(await rateLimit({ key, limit, windowMs: 60 * 60_000 })).success) {
        return newsletterJson(request, { error: "Please wait before requesting another email." }, 429);
      }
    }
    const lead = await withSystem(db, (tx) => requestNewsletterSubscription(tx, {
      ...parsed.data, anonymousId: parsed.data.anonymousId ?? null, now,
    }));
    if (lead) {
      const token = createNewsletterToken(lead.id, lead.subscription)!;
      const dedupeKey = `lead:newsletter-confirm:${lead.id}:${lead.subscription.nonce}`;
      const result = await sendLeadEmail({
        leadId: lead.id, to: parsed.data.email, sequence: "newsletter-confirm", step: 0, dedupeKey,
        stillEligible: (tx) => newsletterConfirmationEligible(tx, lead.id, lead.subscription.nonce),
        send: () => sendNewsletterEmail({ to: parsed.data.email, step: 0, token,
          interest: lead.subscription.interest, anonymousId: parsed.data.anonymousId ?? null, idempotencyKey: dedupeKey }),
      });
      if (!result.sent && !result.deduped && !result.suppressed) return newsletterJson(request, { error: "We couldn't send the confirmation. Please try again later." }, 503);
    }
    // Same response for existing, paused, deleted, suppressed, and new leads.
    return newsletterJson(request, { ok: true }, 202);
  } catch {
    console.error("[newsletter] subscription request failed");
    return newsletterJson(request, { error: "Signup is temporarily unavailable." }, 503);
  }
}
