import { NextResponse } from "next/server";
import { cleanupExpiredRateLimitBuckets } from "@/lib/rate-limit";
import { cronAuthError } from "@/lib/cron-auth";
import { alertOps } from "@/lib/alerts";
import { reportCronHeartbeat } from "@/lib/cron-heartbeat";
import { db } from "@openpims/db/client";
import { withSystem } from "@/lib/tenant-db";
import { purgeStaleScribeTranscripts } from "@/lib/scribe/visit-store";

/**
 * Scribe transcripts are deleted when a visit's note is finalized; this
 * removes any a visit left behind. It runs whether or not Scribe is switched
 * on, so switching Scribe off never strands transcripts nobody can see, and it
 * never fails the rate-limit cleanup it rides along with.
 */
async function purgeScribeTranscripts(): Promise<number | null> {
  try {
    return await withSystem(db, (tx) => purgeStaleScribeTranscripts(tx));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void alertOps("Scribe transcript cleanup failed", message);
    return null;
  }
}

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const authError = cronAuthError(request);
  if (authError) return authError;

  try {
    const result = await cleanupExpiredRateLimitBuckets();
    const scribeTranscriptsDeleted = await purgeScribeTranscripts();
    await reportCronHeartbeat({
      job: "rate-limit-cleanup",
      status: "ok",
      detail: `${result.deleted} expired rate-limit buckets deleted`,
      metrics: {
        deleted: result.deleted,
        ...(scribeTranscriptsDeleted === null
          ? {}
          : { scribeTranscriptsDeleted }),
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
