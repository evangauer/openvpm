import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@openpims/db/client";
import { practices } from "@openpims/db";
import { alertOps } from "@/lib/alerts";
import { cronAuthError } from "@/lib/cron-auth";
import { reportCronHeartbeat } from "@/lib/cron-heartbeat";
import { withSystem, withTenant } from "@/lib/tenant-db";
import { formatDateInputForTimeZone } from "@/lib/date-input";
import { generateDueWellnessInvoices } from "@/lib/wellness/invoicing";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function incrementBillingDateCount(
  billingDates: Record<string, number>,
  billingDate: string
) {
  billingDates[billingDate] = (billingDates[billingDate] ?? 0) + 1;
}

function summarizeBillingDates(billingDates: Record<string, number>) {
  const dates = Object.keys(billingDates).sort();
  if (dates.length === 0) return null;
  if (dates.length === 1) return dates[0]!;
  return `${dates[0]}..${dates[dates.length - 1]}`;
}

export async function GET(request: Request) {
  const authError = cronAuthError(request);
  if (authError) return authError;

  const now = new Date();
  const runDateUtc = now.toISOString().slice(0, 10);
  const billingDates: Record<string, number> = {};
  let generated = 0;
  let failed = 0;

  try {
    const allPractices = await withSystem(db, (tx) =>
      tx
        .select({ id: practices.id, timezone: practices.timezone })
        .from(practices)
        .where(
          and(
            isNull(practices.deletedAt),
            eq(practices.recoveryHold, false),
          ),
        )
    );

    for (const practice of allPractices) {
      const asOf = formatDateInputForTimeZone(now, practice.timezone);
      incrementBillingDateCount(billingDates, asOf);
      try {
        const result = await withTenant(db, practice.id, (tx) =>
          generateDueWellnessInvoices({
            db: tx,
            practiceId: practice.id,
            asOf,
          })
        );
        generated += result.generated;
      } catch (error) {
        failed++;
        void alertOps(
          "Wellness billing failed",
          `practice=${practice.id}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    await reportCronHeartbeat({
      job: "wellness-billing",
      status: failed > 0 ? "degraded" : "ok",
      detail: `${generated} invoices generated, ${failed} practices failed`,
      metrics: {
        practices: allPractices.length,
        generated,
        failed,
        runDateUtc,
        billingDateRange: summarizeBillingDates(billingDates),
      },
    });

    return NextResponse.json({
      date: runDateUtc,
      runDateUtc,
      billingDates,
      practices: allPractices.length,
      generated,
      failed,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void alertOps("Wellness billing cron failed", message);
    await reportCronHeartbeat({
      job: "wellness-billing",
      status: "failed",
      detail: message,
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
