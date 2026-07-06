import { NextResponse } from "next/server";
import { reconcileUnmeteredUsage } from "@/lib/billing/usage";
import { cronAuthError } from "@/lib/cron-auth";
import { alertOps } from "@/lib/alerts";
import { reportCronHeartbeat } from "@/lib/cron-heartbeat";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  const authError = cronAuthError(request);
  if (authError) return authError;

  try {
    const result = await reconcileUnmeteredUsage({ limit: 250 });
    const failed = Math.max(
      0,
      result.attempted - result.metered - result.skipped
    );
    const status = failed > 0 ? "degraded" : "ok";
    const skippedDetail =
      result.skipped > 0 ? `; ${result.skipped} skipped` : "";
    const detail = `${result.metered} of ${result.attempted} usage records metered${skippedDetail}`;

    if (failed > 0) {
      void alertOps(
        "Usage reconciliation incomplete",
        `${failed} of ${result.attempted} usage records were not metered.`
      );
    }

    await reportCronHeartbeat({
      job: "usage-reconcile",
      status,
      detail,
      metrics: { ...result, failed },
    });
    return NextResponse.json({ ...result, failed });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void alertOps("Usage reconciliation failed", message);
    await reportCronHeartbeat({
      job: "usage-reconcile",
      status: "failed",
      detail: message,
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
