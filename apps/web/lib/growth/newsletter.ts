import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@openpims/db/client";
import { rowsFromExecute } from "@/lib/db/execute-rows";
import { createFeedbackToken, verifyFeedbackToken, type FeedbackTokenOptions } from "./feedback-token";
import { leadEmailHash, normalizeLeadEmail } from "./leads";

export const NEWSLETTER_DISCLOSURE = "newsletter-confirmed-v1";
export const NEWSLETTER_INTERESTS = ["general", "offline", "labs", "migration"] as const;
export type NewsletterInterest = (typeof NEWSLETTER_INTERESTS)[number];
export const NEWSLETTER_CONFIRMATION_TTL = 48 * 60 * 60;
export const NEWSLETTER_SEQUENCE = "newsletter-welcome";
const PURPOSE = "openvpm.newsletter-confirm.v1";
const HOUR = 60 * 60 * 1000;

const subscriptionSchema = z.object({
  disclosureVersion: z.literal(NEWSLETTER_DISCLOSURE),
  nonce: z.string().uuid(),
  requestedAt: z.string().datetime(),
  confirmedAt: z.string().datetime().nullable(),
  welcomeStoppedAt: z.string().datetime().optional(),
  interest: z.enum(NEWSLETTER_INTERESTS),
  placement: z.string().max(180).regex(/^[a-zA-Z0-9._:/-]+$/),
});
export type NewsletterSubscription = z.infer<typeof subscriptionSchema>;

export function parseNewsletterSubscription(value: unknown): NewsletterSubscription | null {
  const parsed = subscriptionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function newsletterSignupEnabled(): boolean {
  return process.env.NEWSLETTER_SIGNUP_ENABLED?.trim().toLowerCase() === "true";
}

export function newsletterFollowupConfig(): { rolloutAt: Date } | null {
  if (process.env.NEWSLETTER_FOLLOWUP_ENABLED?.trim().toLowerCase() !== "true") return null;
  const rolloutAt = new Date(process.env.NEWSLETTER_FOLLOWUP_ROLLOUT_AT?.trim() ?? "");
  return Number.isFinite(rolloutAt.getTime()) ? { rolloutAt } : null;
}

export function newsletterStepDue(input: {
  now: Date; confirmedAt: string; sentSteps: number[]; lastEmailAt: Date | string | null;
}): 1 | 2 | 3 | null {
  const age = input.now.getTime() - Date.parse(input.confirmedAt);
  if (!Number.isFinite(age) || age < 0 || age > 30 * 24 * HOUR) return null;
  if (input.lastEmailAt) {
    const gap = input.now.getTime() - new Date(input.lastEmailAt).getTime();
    if (!Number.isFinite(gap) || gap < 24 * HOUR) return null;
  }
  for (const [step, afterHours] of [[1, 0], [2, 48], [3, 168]] as const) {
    if (!input.sentSteps.includes(step)) return age >= afterHours * HOUR ? step : null;
  }
  return null;
}

/** Existing lead source, demo consent, saved builds, and pauses stay intact. */
export async function requestNewsletterSubscription(tx: Database, input: {
  email: string; anonymousId: string | null; interest: NewsletterInterest; placement: string; now: Date;
}): Promise<{ id: string; subscription: NewsletterSubscription } | null> {
  const email = normalizeLeadEmail(input.email);
  const now = input.now.toISOString();
  const subscription: NewsletterSubscription = {
    disclosureVersion: NEWSLETTER_DISCLOSURE,
    nonce: randomUUID(), requestedAt: now, confirmedAt: null,
    interest: input.interest, placement: input.placement,
  };
  const result = await tx.execute(sql`
    insert into growth_leads (
      email, email_hash, source, anonymous_id, disclosure_version,
      first_seen_at, last_seen_at, newsletter_subscription
    ) values (
      ${email}, ${leadEmailHash(email)}, 'newsletter', ${input.anonymousId},
      ${NEWSLETTER_DISCLOSURE}, ${now}::timestamptz, ${now}::timestamptz,
      ${JSON.stringify(subscription)}::jsonb
    )
    on conflict (email_hash) do update set
      last_seen_at = excluded.last_seen_at,
      anonymous_id = coalesce(excluded.anonymous_id, growth_leads.anonymous_id),
      newsletter_subscription = case
        when growth_leads.newsletter_subscription ->> 'requestedAt' >
          ${new Date(input.now.getTime() - 15 * 60_000).toISOString()}
        then growth_leads.newsletter_subscription
        else excluded.newsletter_subscription end,
      updated_at = excluded.last_seen_at
    where growth_leads.deleted_at is null and growth_leads.paused_at is null
      and growth_leads.newsletter_subscription ->> 'confirmedAt' is null
    returning id, newsletter_subscription as subscription
  `);
  const row = rowsFromExecute<{ id: string; subscription: unknown }>(result)[0];
  const stored = parseNewsletterSubscription(row?.subscription);
  return row && stored ? { id: row.id, subscription: stored } : null;
}

export function createNewsletterToken(leadId: string, subscription: NewsletterSubscription, options: FeedbackTokenOptions = {}): string | null {
  return createFeedbackToken(PURPOSE, {
    practiceId: leadId, survey: subscription.nonce, ttlSeconds: NEWSLETTER_CONFIRMATION_TTL,
  }, { ...options, now: new Date(subscription.requestedAt) });
}

export function verifyNewsletterToken(token: string | null, options: FeedbackTokenOptions = {}): { leadId: string; nonce: string } | null {
  const verified = verifyFeedbackToken(PURPOSE, token, options);
  return verified?.survey ? { leadId: verified.practiceId, nonce: verified.survey } : null;
}

export async function confirmNewsletterSubscription(tx: Database, input: { leadId: string; nonce: string; now: Date }): Promise<boolean> {
  const result = await tx.execute(sql`
    update growth_leads set newsletter_subscription = jsonb_set(
      newsletter_subscription, '{confirmedAt}',
      coalesce(nullif(newsletter_subscription -> 'confirmedAt', 'null'::jsonb), to_jsonb(${input.now.toISOString()}::text))
    ), updated_at = ${input.now.toISOString()}::timestamptz
    where id = ${input.leadId}::uuid and deleted_at is null and paused_at is null
      and newsletter_subscription ->> 'nonce' = ${input.nonce}
      and newsletter_subscription ->> 'disclosureVersion' = ${NEWSLETTER_DISCLOSURE}
    returning id
  `);
  return rowsFromExecute(result).length === 1;
}

export async function newsletterConfirmationEligible(tx: Database, leadId: string, nonce: string): Promise<boolean> {
  const result = await tx.execute(sql`
    select id from growth_leads where id = ${leadId}::uuid
      and deleted_at is null and paused_at is null
      and newsletter_subscription ->> 'nonce' = ${nonce}
      and newsletter_subscription ->> 'confirmedAt' is null
      and newsletter_subscription ->> 'disclosureVersion' = ${NEWSLETTER_DISCLOSURE}
  `);
  return rowsFromExecute(result).length === 1;
}
