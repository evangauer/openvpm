import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import {
  communications,
  practiceConversionMilestones,
  practices,
  users,
} from "@openpims/db";
import { db, type Database } from "@openpims/db/client";
import { alertOps } from "@/lib/alerts";
import { appBaseUrl } from "@/lib/app-url";
import { billingContactEmail } from "@/lib/billing/contact";
import {
  CLOUD_LOCATION_UNIT_PRICE_MONTHLY_USD,
  billingEnforced,
} from "@/lib/billing/plans";
import { createSubscriptionCheckoutAttributionToken } from "@/lib/billing/checkout-attribution";
import { firstRealVisitAt } from "@/lib/billing/first-real-visit";
import { sendFirstClinicWinEmail } from "@/lib/email";
import { sendOptionalPlatformEmail } from "@/lib/email-lifecycle";
import { envFlagEnabled } from "@/lib/env-bool";
import { withSystem } from "@/lib/tenant-db";

const CAMPAIGN_ENABLED_ENV = "FIRST_CLINIC_WIN_EMAIL_ENABLED";
const CAMPAIGN_LAUNCH_AT_ENV = "FIRST_CLINIC_WIN_EMAIL_LAUNCH_AT";
const CAMPAIGN_EVIDENCE_ID = "first-clinic-win:v1";
const FIRST_WIN_BATCH_LIMIT = 100;
const CROSS_CAMPAIGN_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export const FIRST_CLINIC_WIN_DEDUPE_PREFIX = "lc:first-clinic-win:v1";

type Candidate = {
  id: string;
  name: string;
  email: string;
  timezone: string;
  trialEndsAt: Date;
  firstVisitAt: Date;
};

type CandidateRow = {
  id: string;
  name: string;
  email: string;
  timezone: string;
  trialEndsAt: Date | string;
  firstVisitAt: Date | string;
};

export type FirstClinicWinCampaignResult = {
  candidates: number;
  sent: number;
  deduped: number;
  suppressed: number;
  failed: number;
  skipped: number;
  disabled: boolean;
};

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

export function firstClinicWinCampaignConfiguration():
  | { enabled: false; reason: string }
  | { enabled: true; launchAt: Date } {
  if (!billingEnforced()) {
    return { enabled: false, reason: "hosted billing disabled" };
  }
  if (!envFlagEnabled(CAMPAIGN_ENABLED_ENV)) {
    return { enabled: false, reason: `${CAMPAIGN_ENABLED_ENV} is false` };
  }
  const rawLaunchAt = process.env[CAMPAIGN_LAUNCH_AT_ENV]?.trim();
  const launchAt = rawLaunchAt ? new Date(rawLaunchAt) : null;
  if (!launchAt || Number.isNaN(launchAt.getTime())) {
    return {
      enabled: false,
      reason: `${CAMPAIGN_LAUNCH_AT_ENV} is missing or invalid`,
    };
  }
  return { enabled: true, launchAt };
}

/** Run one bounded, deterministic repair sweep from durable closeout evidence. */
export async function runFirstClinicWinCampaign(
  now = new Date(),
): Promise<FirstClinicWinCampaignResult> {
  const config = firstClinicWinCampaignConfiguration();
  if (!config.enabled) {
    return {
      candidates: 0,
      sent: 0,
      deduped: 0,
      suppressed: 0,
      failed: 0,
      skipped: 0,
      disabled: true,
    };
  }

  const candidates = await listCandidates(config.launchAt, now);
  const result: FirstClinicWinCampaignResult = {
    candidates: candidates.length,
    sent: 0,
    deduped: 0,
    suppressed: 0,
    failed: 0,
    skipped: 0,
    disabled: false,
  };

  for (const candidate of candidates) {
    const dedupeKey = `${FIRST_CLINIC_WIN_DEDUPE_PREFIX}:${candidate.id}`;
    const token = createSubscriptionCheckoutAttributionToken({
      practiceId: candidate.id,
      source: "first_visit_email",
      evidenceId: CAMPAIGN_EVIDENCE_ID,
    });
    if (!token) {
      result.skipped++;
      await alertOps(
        "First clinic win email configuration invalid",
        `practice=${candidate.id} checkout attribution signing unavailable`,
      );
      continue;
    }
    const billingUrl = new URL("/settings", appBaseUrl());
    billingUrl.searchParams.set("tab", "billing");
    billingUrl.searchParams.set("checkout_attribution", token);

    const delivery = await sendOptionalPlatformEmail({
      practiceId: candidate.id,
      to: candidate.email,
      emailType: "first-clinic-win",
      dedupeKey,
      retryOnFail: true,
      stillEligible: (tx) =>
        firstClinicWinStillEligible(tx, candidate, config.launchAt, now),
      send: () =>
        sendFirstClinicWinEmail({
          to: candidate.email,
          practiceName: candidate.name,
          trialEndDate: formatTrialEndDate(
            candidate.trialEndsAt,
            candidate.timezone,
          ),
          monthlyPrice: `$${CLOUD_LOCATION_UNIT_PRICE_MONTHLY_USD}`,
          billingUrl: billingUrl.toString(),
          idempotencyKey: dedupeKey,
        }),
    });

    if (delivery.sent) result.sent++;
    else if (delivery.suppressed) result.suppressed++;
    else if (delivery.deduped) result.deduped++;
    else result.failed++;
  }

  return result;
}

async function listCandidates(launchAt: Date, now: Date): Promise<Candidate[]> {
  const terminalDedupePattern = `${FIRST_CLINIC_WIN_DEDUPE_PREFIX}:%`;
  const result = await withSystem(db, (tx) =>
    tx.execute(sql`
      select
        p.id,
        p.name,
        lower(btrim(p.email)) as email,
        p.timezone,
        p.trial_ends_at as "trialEndsAt",
        min(vc.completed_at) as "firstVisitAt"
      from practices p
      join appointments a
        on a.practice_id = p.id
       and a.deleted_at is null
       and a.status = 'checked_out'
       and a.created_at >= p.created_at
      join visit_closeouts vc
        on vc.practice_id = p.id
       and vc.appointment_id = a.id
       and vc.deleted_at is null
       and vc.status = 'completed'
       and vc.completed_at >= ${launchAt}
       and vc.completed_at >= p.created_at
      where p.deleted_at is null
        and p.subscription_tier = 'cloud'
        and p.billing_status = 'trialing'
        and p.trial_ends_at > ${now}
        and p.stripe_subscription_id is null
        and p.recovery_hold = false
        and p.country = 'US'
        and nullif(btrim(p.email), '') is not null
        and p.settings ->> 'analyticsExcluded' is distinct from 'true'
        and p.settings -> 'onboardingState' ->> 'onboardingIntent'
          is distinct from 'self_host'
        and not (
          coalesce(p.settings -> 'demoData' -> 'appointmentIds', '[]'::jsonb)
            @> to_jsonb(a.id::text)
        )
        and exists (
          select 1 from users u
          where u.practice_id = p.id
            and u.role = 'admin'
            and u.email_verified_at is not null
            and u.deleted_at is null
            and lower(btrim(u.email)) = lower(btrim(p.email))
        )
        and not exists (
          select 1 from practice_conversion_milestones pcm
          where pcm.practice_id = p.id
            and pcm.milestone = 'payment_method_collected'
        )
        and not exists (
          select 1 from communications c
          where c.practice_id = p.id
            and c.dedupe_key like ${terminalDedupePattern}
            and c.status <> 'pending'
        )
      group by p.id, p.name, p.email, p.timezone, p.trial_ends_at
      order by min(vc.completed_at), p.id
      limit ${FIRST_WIN_BATCH_LIMIT}
    `),
  );

  return rowsFromExecute<CandidateRow>(result).flatMap((row) => {
    const trialEndsAt = new Date(row.trialEndsAt);
    const firstVisitAt = new Date(row.firstVisitAt);
    const email = billingContactEmail(row.email);
    if (
      !email ||
      Number.isNaN(trialEndsAt.getTime()) ||
      Number.isNaN(firstVisitAt.getTime())
    ) {
      return [];
    }
    return [{ ...row, email, trialEndsAt, firstVisitAt }];
  });
}

async function firstClinicWinStillEligible(
  tx: Database,
  candidate: Candidate,
  launchAt: Date,
  now: Date,
): Promise<boolean> {
  const [practice] = await tx
    .select({
      id: practices.id,
      name: practices.name,
      email: practices.email,
      timezone: practices.timezone,
      subscriptionTier: practices.subscriptionTier,
      billingStatus: practices.billingStatus,
      trialEndsAt: practices.trialEndsAt,
      stripeSubscriptionId: practices.stripeSubscriptionId,
      country: practices.country,
      settings: practices.settings,
    })
    .from(practices)
    .where(and(eq(practices.id, candidate.id), isNull(practices.deletedAt)))
    .limit(1);
  if (!practice) return false;

  const settings = (practice.settings ?? {}) as {
    analyticsExcluded?: boolean;
    onboardingState?: { onboardingIntent?: string };
  };
  const trialEndsAt = practice.trialEndsAt
    ? new Date(practice.trialEndsAt)
    : null;
  if (
    practice.subscriptionTier !== "cloud" ||
    practice.billingStatus !== "trialing" ||
    !trialEndsAt ||
    trialEndsAt.getTime() <= now.getTime() ||
    trialEndsAt.getTime() !== candidate.trialEndsAt.getTime() ||
    practice.stripeSubscriptionId !== null ||
    practice.country !== "US" ||
    settings.analyticsExcluded === true ||
    settings.onboardingState?.onboardingIntent === "self_host" ||
    practice.name !== candidate.name ||
    practice.timezone !== candidate.timezone ||
    billingContactEmail(practice.email) !== candidate.email
  ) {
    return false;
  }

  const [verifiedAdmin] = await tx
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.practiceId, candidate.id),
        eq(users.role, "admin"),
        sql`lower(btrim(${users.email})) = ${candidate.email}`,
        isNotNull(users.emailVerifiedAt),
        isNull(users.deletedAt),
      ),
    )
    .limit(1);
  if (!verifiedAdmin) return false;

  const [paymentMethod] = await tx
    .select({ practiceId: practiceConversionMilestones.practiceId })
    .from(practiceConversionMilestones)
    .where(
      and(
        eq(practiceConversionMilestones.practiceId, candidate.id),
        eq(practiceConversionMilestones.milestone, "payment_method_collected"),
      ),
    )
    .limit(1);
  if (paymentMethod) return false;

  const firstVisit = await firstRealVisitAt(tx, candidate.id);
  if (!firstVisit || firstVisit.getTime() < launchAt.getTime()) return false;

  const cooldownSince = new Date(now.getTime() - CROSS_CAMPAIGN_COOLDOWN_MS);
  const [recentCampaign] = await tx
    .select({ id: communications.id })
    .from(communications)
    .where(
      and(
        eq(communications.practiceId, candidate.id),
        eq(communications.channel, "email"),
        eq(communications.direction, "outbound"),
        eq(communications.status, "sent"),
        isNull(communications.deletedAt),
        sql`${communications.subject} in ('trial-ending', 'first-clinic-win')`,
        sql`${communications.createdAt} >= ${cooldownSince}`,
      ),
    )
    .limit(1);
  return !recentCampaign;
}

function formatTrialEndDate(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone,
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    }).format(date);
  }
}
