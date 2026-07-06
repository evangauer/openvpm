import { NextResponse } from "next/server";
import { cleanupExpiredRateLimitBuckets } from "@/lib/rate-limit";
import { cronAuthError } from "@/lib/cron-auth";
import { alertOps } from "@/lib/alerts";
import { reportCronHeartbeat } from "@/lib/cron-heartbeat";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const authError = cronAuthError(request);
  if (authError) return authError;

  try {
    const result = await cleanupExpiredRateLimitBuckets();
    await reportCronHeartbeat({
      job: "rate-limit-cleanup",
      status: "ok",
      detail: `${result.deleted} expired rate-limit buckets deleted`,
      metrics: {
        deleted: result.deleted,
      },
    });
    return NextResponse.json({
      deleted: result.deleted,
      cutoff: result.cutoff.toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void alertOps("Rate-limit cleanup failed", message);
    await reportCronHeartbeat({
      job: "rate-limit-cleanup",
      status: "failed",
      detail: message,
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
