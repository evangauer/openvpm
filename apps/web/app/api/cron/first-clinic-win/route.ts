import { NextResponse } from "next/server";
import { cronAuthError } from "@/lib/cron-auth";
import {
  firstClinicWinCampaignConfiguration,
  runFirstClinicWinCampaign,
} from "@/lib/billing/first-clinic-win";
import { reportCronHeartbeat } from "@/lib/cron-heartbeat";
import { alertOps } from "@/lib/alerts";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  const authError = cronAuthError(request);
  if (authError) return authError;

  const config = firstClinicWinCampaignConfiguration();
  if (!config.enabled) {
    const metrics = {
      candidates: 0,
      sent: 0,
      deduped: 0,
      suppressed: 0,
      failed: 0,
      skipped: 0,
      disabled: true,
    };
    await reportCronHeartbeat({
      job: "first-clinic-win",
      status: "ok",
      detail: config.reason,
      metrics,
    });
    return NextResponse.json(metrics);
  }

  try {
    const result = await runFirstClinicWinCampaign();
    await reportCronHeartbeat({
      job: "first-clinic-win",
      status: result.failed > 0 ? "degraded" : "ok",
      detail: `${result.sent} sent, ${result.deduped} deduped, ${result.suppressed} suppressed, ${result.failed} failed, ${result.skipped} skipped`,
      metrics: result,
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await alertOps("First clinic win cron failed", message);
    await reportCronHeartbeat({
      job: "first-clinic-win",
      status: "failed",
      detail: message,
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
