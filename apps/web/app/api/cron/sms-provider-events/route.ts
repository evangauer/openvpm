import { NextResponse } from "next/server";
import { alertOps } from "@/lib/alerts";
import { cronAuthError } from "@/lib/cron-auth";
import { reportCronHeartbeat } from "@/lib/cron-heartbeat";
import { processSmsProviderEventBatch } from "@/lib/messaging/sms-provider-events";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const BATCH_LIMIT = 50;
const JOB_BUDGET_MS = 240_000;

/**
 * Bounded writer for already-durable, signed provider events. The separate
 * sms-operations cron remains read-only and owns alert state transitions.
 */
export async function GET(request: Request) {
  const authError = cronAuthError(request);
  if (authError) return authError;

  try {
    const metrics = await processSmsProviderEventBatch({
      limit: BATCH_LIMIT,
      budgetMs: JOB_BUDGET_MS,
    });
    const degraded = metrics.retried > 0 || metrics.quarantined > 0;
    const detail = degraded
      ? `${metrics.retried} provider event retry and ${metrics.quarantined} quarantine outcome(s)`
      : `${metrics.projected} projected, ${metrics.ignored} ignored, ${metrics.remaining} remaining`;

    await reportCronHeartbeat({
      job: "sms-provider-events",
      status: degraded ? "degraded" : "ok",
      detail,
      metrics,
    });
    if (metrics.quarantined > 0) {
      try {
        await alertOps(
          "SMS provider event projection quarantined",
          `${metrics.quarantined} durable provider event(s) require redacted operator review. No message body, phone number, or provider payload is included in this alert.`,
        );
      } catch {
        // Durable queue state and the heartbeat remain authoritative if the
        // optional alert transport is unavailable.
      }
    }

    return NextResponse.json({
      ok: true,
      status: degraded ? "degraded" : "ok",
      detail,
      metrics,
    });
  } catch {
    const detail = "SMS provider event projection worker crashed";
    await reportCronHeartbeat({
      job: "sms-provider-events",
      status: "failed",
      detail,
    });
    try {
      await alertOps(
        "SMS provider event projection failed",
        "The bounded projection worker crashed. Durable events remain queued; review the worker heartbeat and redacted operations queue.",
      );
    } catch {
      // The failed heartbeat is still the durable dead-man signal.
    }
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
