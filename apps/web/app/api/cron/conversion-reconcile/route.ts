import { NextResponse } from "next/server";
import { db } from "@openpims/db/client";
import { alertOps } from "@/lib/alerts";
import { reconcileConversionMilestones } from "@/lib/conversion-milestones";
import { reconcileRegistrationFirstTouches } from "@/lib/funnel-events-server";
import { cronAuthError } from "@/lib/cron-auth";
import { reportCronHeartbeat } from "@/lib/cron-heartbeat";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Repair canonical conversion projections from local Postgres evidence only.
 * This job never calls Stripe and never invents a legacy payment timestamp.
 */
export async function GET(request: Request) {
  const authError = cronAuthError(request);
  if (authError) return authError;

  try {
    const milestones = await reconcileConversionMilestones(db);
    const attribution = await reconcileRegistrationFirstTouches(db);
    const milestoneRepairs = Object.values(milestones).reduce(
      (total, count) => total + count,
      0,
    );
    const repaired =
      milestoneRepairs + attribution.validFunnelIdMissingTouchRepaired;
    const result = { ...milestones, ...attribution };
    await reportCronHeartbeat({
      job: "conversion-reconcile",
      status: "ok",
      detail: `${repaired} canonical milestone projection(s) repaired`,
      metrics: { ...result, repaired },
    });
    return NextResponse.json({ ok: true, ...result, repaired });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await alertOps("Conversion reconciliation failed", message);
    await reportCronHeartbeat({
      job: "conversion-reconcile",
      status: "failed",
      detail: message,
    });
    return NextResponse.json(
      { ok: false, error: "Conversion reconciliation failed" },
      { status: 500 },
    );
  }
}
