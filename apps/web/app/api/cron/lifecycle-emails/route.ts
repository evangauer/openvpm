import { NextResponse } from "next/server";
import { runLifecycleEmailBatch } from "@/lib/billing/lifecycle-email-outbox";
import { cronAuthError } from "@/lib/cron-auth";
import { reportCronHeartbeat } from "@/lib/cron-heartbeat";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  const authError = cronAuthError(request);
  if (authError) return authError;

  try {
    const metrics = await runLifecycleEmailBatch();
    const degraded =
      metrics.errors > 0 ||
      metrics.failed > 0 ||
      metrics.outcomeUnknown > 0 ||
      metrics.blocked > 0;
    await reportCronHeartbeat({
      job: "lifecycle-emails",
      status: degraded ? "degraded" : "ok",
      detail: "Durable subscription lifecycle email sweep completed",
      metrics,
    });
    return NextResponse.json(metrics);
  } catch {
    console.error("[lifecycle-emails] durable worker crashed; details redacted");
    await reportCronHeartbeat({
      job: "lifecycle-emails",
      status: "failed",
      detail: "Durable lifecycle email worker crashed",
    });
    return NextResponse.json(
      { error: "Lifecycle email sweep failed" },
      { status: 500 },
    );
  }
}
