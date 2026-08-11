import { NextResponse } from "next/server";
import { and, eq, gte, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { db, type Database } from "@openpims/db/client";
import {
  communications,
  practiceConversionMilestones,
  practices,
  users,
} from "@openpims/db";
import {
  billingEnforced,
  CLOUD_LOCATION_UNIT_PRICE_MONTHLY_USD,
} from "@/lib/billing/plans";
import { cronAuthError } from "@/lib/cron-auth";
import { sendTrialEndingEmailWithEvidence } from "@/lib/email";
import { sendOptionalPlatformEmail } from "@/lib/email-lifecycle";
import { alertOps } from "@/lib/alerts";
import { withSystem } from "@/lib/tenant-db";
import { reportCronHeartbeat } from "@/lib/cron-heartbeat";
import { formatDateInputForTimeZone } from "@/lib/date-input";
import { billingContactEmail } from "@/lib/billing/contact";
import { appBaseUrl } from "@/lib/app-url";
import { createSubscriptionCheckoutAttributionToken } from "@/lib/billing/checkout-attribution";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DAY_MS = 24 * 60 * 60 * 1000;
const TRIAL_REMINDER_DAYS = [7, 3, 1] as const;

type TrialReminderDay = (typeof TRIAL_REMINDER_DAYS)[number];

export async function GET(request: Request) {
  const authError = cronAuthError(request);
  if (authError) return authError;

  if (!billingEnforced()) {
    await reportCronHeartbeat({
      job: "billing-lifecycle",
      status: "ok",
      detail: "Hosted billing disabled; no lifecycle emails sent",
      metrics: {
        sent: 0,
        deduped: 0,
        suppressed: 0,
        failed: 0,
        skipped: 0,
        disabled: true,
      },
    });
    return NextResponse.json({
      sent: 0,
      deduped: 0,
      suppressed: 0,
      failed: 0,
      skipped: 0,
      disabled: true,
    });
  }

  try {
    const now = new Date();
    const latestTrialEnd = new Date(
      now.getTime() + (Math.max(...TRIAL_REMINDER_DAYS) + 1) * DAY_MS,
    );

    const trialingPractices = await withSystem(db, (tx) =>
      tx
        .select({
          id: practices.id,
          name: practices.name,
          email: practices.email,
          timezone: practices.timezone,
          trialEndsAt: practices.trialEndsAt,
          stripeSubscriptionId: practices.stripeSubscriptionId,
          settings: practices.settings,
          country: practices.country,
          paymentMethodCollected: sql<boolean>`exists (
            select 1 from ${practiceConversionMilestones} pcm
            where pcm.practice_id = ${practices.id}
              and pcm.milestone = 'payment_method_collected'
          )`,
        })
        .from(practices)
        .where(
          and(
            eq(practices.billingStatus, "trialing"),
            isNotNull(practices.trialEndsAt),
            gte(practices.trialEndsAt, now),
            lte(practices.trialEndsAt, latestTrialEnd),
            eq(practices.recoveryHold, false),
            eq(practices.country, "US"),
            isNull(practices.deletedAt),
            sql`${practices.settings} ->> 'analyticsExcluded' is distinct from 'true'`,
            sql`${practices.settings} -> 'onboardingState' ->> 'onboardingIntent' is distinct from 'self_host'`,
          ),
        ),
    );

    let sent = 0;
    let deduped = 0;
    let suppressed = 0;
    let failed = 0;
    let skipped = 0;
    let dataQualitySuppressed = 0;

    for (const practice of trialingPractices) {
      const trialEndsAt = practice.trialEndsAt
        ? new Date(practice.trialEndsAt)
        : null;
      const to = billingContactEmail(practice.email);
      const daysLeft = trialEndsAt
        ? calendarDaysUntil(trialEndsAt, now, practice.timezone ?? undefined)
        : null;

      if (!to || !trialEndsAt || !isTrialReminderDay(daysLeft)) {
        skipped++;
        continue;
      }

      const variant = practice.stripeSubscriptionId
        ? practice.paymentMethodCollected
          ? "billing_connected"
          : "unknown"
        : "add_billing";
      if (variant === "unknown") {
        dataQualitySuppressed++;
        suppressed++;
        continue;
      }

      const dedupeKey = [
        "lc:trial-ending",
        practice.id,
        formatDateKey(trialEndsAt, practice.timezone ?? undefined),
        `t-${daysLeft}`,
      ].join(":");
      const billingUrl = new URL("/settings", appBaseUrl());
      billingUrl.searchParams.set("tab", "billing");
      if (variant === "add_billing") {
        const attributionToken = createSubscriptionCheckoutAttributionToken({
          practiceId: practice.id,
          source: "trial_ending_email",
          evidenceId: `${formatDateKey(trialEndsAt, practice.timezone ?? undefined)}:t-${daysLeft}`,
        });
        if (!attributionToken) {
          skipped++;
          continue;
        }
        billingUrl.searchParams.set("checkout_attribution", attributionToken);
      }

      const result = await sendOptionalPlatformEmail({
        practiceId: practice.id,
        to,
        emailType: "trial-ending",
        dedupeKey,
        retryOnFail: true,
        stillEligible: (tx) =>
          trialReminderStillEligible(tx, {
            practiceId: practice.id,
            name: practice.name,
            email: to,
            timezone: practice.timezone,
            trialEndsAt,
            stripeSubscriptionId: practice.stripeSubscriptionId,
            variant,
            now,
          }),
        send: () =>
          sendTrialEndingEmailWithEvidence({
            to,
            practiceName: practice.name,
            daysLeft,
            trialEndDate: formatTrialEndDate(
              trialEndsAt,
              practice.timezone ?? undefined,
            ),
            monthlyPrice: `$${CLOUD_LOCATION_UNIT_PRICE_MONTHLY_USD}`,
            billingUrl: billingUrl.toString(),
            variant,
            idempotencyKey: dedupeKey,
          }),
      });

      if (result.sent) {
        sent++;
      } else if (result.suppressed) {
        suppressed++;
      } else if (result.deduped) {
        deduped++;
      } else {
        failed++;
      }
    }

    await reportCronHeartbeat({
      job: "billing-lifecycle",
      status: failed > 0 ? "degraded" : "ok",
      detail: `${sent} sent, ${deduped} deduped, ${suppressed} suppressed, ${failed} failed, ${skipped} skipped`,
      metrics: {
        candidates: trialingPractices.length,
        sent,
        deduped,
        suppressed,
        failed,
        skipped,
        dataQualitySuppressed,
      },
    });

    return NextResponse.json({
      sent,
      deduped,
      suppressed,
      failed,
      skipped,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await alertOps("Billing lifecycle cron failed", message);
    await reportCronHeartbeat({
      job: "billing-lifecycle",
      status: "failed",
      detail: message,
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

async function trialReminderStillEligible(
  tx: Database,
  expected: {
    practiceId: string;
    name: string;
    email: string;
    timezone: string;
    trialEndsAt: Date;
    stripeSubscriptionId: string | null;
    variant: "add_billing" | "billing_connected";
    now: Date;
  },
): Promise<boolean> {
  const [practice] = await tx
    .select({
      name: practices.name,
      email: practices.email,
      timezone: practices.timezone,
      billingStatus: practices.billingStatus,
      trialEndsAt: practices.trialEndsAt,
      stripeSubscriptionId: practices.stripeSubscriptionId,
      country: practices.country,
      settings: practices.settings,
    })
    .from(practices)
    .where(
      and(eq(practices.id, expected.practiceId), isNull(practices.deletedAt)),
    )
    .limit(1);
  if (!practice || practice.billingStatus !== "trialing") return false;
  const trialEndsAt = practice.trialEndsAt
    ? new Date(practice.trialEndsAt)
    : null;
  const settings = (practice.settings ?? {}) as {
    analyticsExcluded?: boolean;
    onboardingState?: { onboardingIntent?: string };
  };
  if (
    !trialEndsAt ||
    trialEndsAt.getTime() <= expected.now.getTime() ||
    trialEndsAt.getTime() !== expected.trialEndsAt.getTime() ||
    practice.name !== expected.name ||
    practice.timezone !== expected.timezone ||
    billingContactEmail(practice.email) !== expected.email ||
    practice.country !== "US" ||
    settings.analyticsExcluded === true ||
    settings.onboardingState?.onboardingIntent === "self_host"
  ) {
    return false;
  }

  const [verifiedAdmin] = await tx
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.practiceId, expected.practiceId),
        eq(users.role, "admin"),
        isNotNull(users.emailVerifiedAt),
        isNull(users.deletedAt),
        sql`lower(btrim(${users.email})) = ${expected.email}`,
      ),
    )
    .limit(1);
  if (!verifiedAdmin) return false;

  const [paymentMethod] = await tx
    .select({ practiceId: practiceConversionMilestones.practiceId })
    .from(practiceConversionMilestones)
    .where(
      and(
        eq(practiceConversionMilestones.practiceId, expected.practiceId),
        eq(practiceConversionMilestones.milestone, "payment_method_collected"),
      ),
    )
    .limit(1);
  const currentVariant = practice.stripeSubscriptionId
    ? paymentMethod
      ? "billing_connected"
      : "unknown"
    : "add_billing";
  if (
    currentVariant !== expected.variant ||
    practice.stripeSubscriptionId !== expected.stripeSubscriptionId
  ) {
    return false;
  }

  const cooldownSince = new Date(expected.now.getTime() - DAY_MS);
  const [recentFirstWin] = await tx
    .select({ id: communications.id })
    .from(communications)
    .where(
      and(
        eq(communications.practiceId, expected.practiceId),
        eq(communications.subject, "first-clinic-win"),
        eq(communications.status, "sent"),
        isNull(communications.deletedAt),
        gte(communications.createdAt, cooldownSince),
      ),
    )
    .limit(1);
  return !recentFirstWin;
}

function calendarDaysUntil(end: Date, now: Date, timeZone?: string): number {
  const endDay = localDateParts(end, timeZone);
  const nowDay = localDateParts(now, timeZone);
  return Math.round(
    (Date.UTC(endDay.year, endDay.month - 1, endDay.day) -
      Date.UTC(nowDay.year, nowDay.month - 1, nowDay.day)) /
      DAY_MS,
  );
}

function isTrialReminderDay(
  daysLeft: number | null,
): daysLeft is TrialReminderDay {
  return TRIAL_REMINDER_DAYS.includes(daysLeft as TrialReminderDay);
}

function formatDateKey(date: Date, timeZone?: string): string {
  return formatDateInputForTimeZone(date, timeZone?.trim() || "UTC");
}

function formatTrialEndDate(date: Date, timeZone?: string): string {
  const options: Intl.DateTimeFormatOptions = {
    month: "long",
    day: "numeric",
    year: "numeric",
  };

  try {
    return new Intl.DateTimeFormat("en-US", {
      ...options,
      ...(timeZone ? { timeZone } : {}),
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-US", options).format(date);
  }
}

function localDateParts(
  date: Date,
  timeZone?: string,
): { year: number; month: number; day: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      ...(timeZone ? { timeZone } : {}),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    return {
      year: Number(parts.find((part) => part.type === "year")?.value),
      month: Number(parts.find((part) => part.type === "month")?.value),
      day: Number(parts.find((part) => part.type === "day")?.value),
    };
  } catch {
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
    };
  }
}
