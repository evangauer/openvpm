import { NextResponse } from "next/server";
import { and, eq, gte, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { db, type Database } from "@openpims/db/client";
import { practices } from "@openpims/db";
import {
  billingEnforced,
  CLOUD_LOCATION_UNIT_PRICE_MONTHLY_USD,
} from "@/lib/billing/plans";
import { cronAuthError } from "@/lib/cron-auth";
import { sendTrialEndingEmail } from "@/lib/email";
import { sendOptionalPlatformEmail } from "@/lib/email-lifecycle";
import { alertOps } from "@/lib/alerts";
import { withSystem } from "@/lib/tenant-db";
import { reportCronHeartbeat } from "@/lib/cron-heartbeat";
import { formatDateInputForTimeZone } from "@/lib/date-input";
import { billingContactEmail } from "@/lib/billing/contact";

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
          billingSetupRecorded: sql<boolean>`exists (
            select 1
            from practice_conversion_milestones pcm
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
            isNull(practices.deletedAt),
          ),
        ),
    );

    let sent = 0;
    let deduped = 0;
    let suppressed = 0;
    let failed = 0;
    let skipped = 0;

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

      const billingConnected =
        Boolean(practice.stripeSubscriptionId) &&
        practice.billingSetupRecorded === true;
      const needsBilling =
        !practice.stripeSubscriptionId &&
        practice.billingSetupRecorded !== true;
      if (!billingConnected && !needsBilling) {
        // Conflicting local evidence is an operator reconciliation case. Do
        // not guess whether the clinic needs a card or is already connected.
        skipped++;
        continue;
      }

      const dedupeKey = [
        "lc:trial-ending",
        practice.id,
        formatDateKey(trialEndsAt, practice.timezone ?? undefined),
        `t-${daysLeft}`,
      ].join(":");
      const result = await sendOptionalPlatformEmail({
        practiceId: practice.id,
        to,
        emailType: "trial-ending",
        dedupeKey,
        retryOnFail: true,
        stillEligible: (tx) =>
          trialReminderStillEligible(tx, {
            practiceId: practice.id,
            to,
            trialEndsAt,
            billingConnected,
          }),
        send: () =>
          sendTrialEndingEmail({
            to,
            practiceName: practice.name,
            daysLeft,
            trialEndDate: formatTrialEndDate(
              trialEndsAt,
              practice.timezone ?? undefined,
            ),
            monthlyPrice: `$${CLOUD_LOCATION_UNIT_PRICE_MONTHLY_USD}`,
            billingConnected,
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
      },
    });

    return NextResponse.json({ sent, deduped, suppressed, failed, skipped });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void alertOps("Billing lifecycle cron failed", message);
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
  input: {
    practiceId: string;
    to: string;
    trialEndsAt: Date;
    billingConnected: boolean;
  },
): Promise<boolean> {
  const [practice] = await tx
    .select({
      email: practices.email,
      stripeSubscriptionId: practices.stripeSubscriptionId,
      billingStatus: practices.billingStatus,
      trialEndsAt: practices.trialEndsAt,
      billingSetupRecorded: sql<boolean>`exists (
        select 1
        from practice_conversion_milestones pcm
        where pcm.practice_id = ${practices.id}
          and pcm.milestone = 'payment_method_collected'
      )`,
    })
    .from(practices)
    .where(
      and(
        eq(practices.id, input.practiceId),
        isNull(practices.deletedAt),
        eq(practices.recoveryHold, false),
      ),
    )
    .limit(1);
  if (
    !practice ||
    practice.billingStatus !== "trialing" ||
    !practice.trialEndsAt ||
    new Date(practice.trialEndsAt).getTime() !== input.trialEndsAt.getTime() ||
    billingContactEmail(practice.email) !== input.to
  ) {
    return false;
  }
  return input.billingConnected
    ? Boolean(practice.stripeSubscriptionId) &&
        practice.billingSetupRecorded === true
    : !practice.stripeSubscriptionId && practice.billingSetupRecorded !== true;
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
