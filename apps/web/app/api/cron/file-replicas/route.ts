import { NextResponse } from "next/server";
import { alertOps } from "@/lib/alerts";
import { cronAuthError } from "@/lib/cron-auth";
import { reportCronHeartbeat } from "@/lib/cron-heartbeat";
import { reconcileFileReplicas } from "@/lib/file-replication";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function databaseFailureDiagnostic(error: unknown) {
  const outer =
    error && typeof error === "object"
      ? (error as {
          name?: unknown;
          code?: unknown;
          cause?: unknown;
        })
      : null;
  const cause =
    outer?.cause && typeof outer.cause === "object"
      ? (outer.cause as {
          name?: unknown;
          code?: unknown;
          message?: unknown;
        })
      : null;

  return {
    name: typeof outer?.name === "string" ? outer.name : "unknown",
    code: typeof outer?.code === "string" ? outer.code : "none",
    causeName: typeof cause?.name === "string" ? cause.name : "unknown",
    causeCode: typeof cause?.code === "string" ? cause.code : "none",
    causeMessage:
      typeof cause?.message === "string"
        ? cause.message.slice(0, 500)
        : "unavailable",
  };
}

export async function GET(request: Request) {
  const authError = cronAuthError(request);
  if (authError) return authError;

  try {
    const metrics = await reconcileFileReplicas();
    const status = !metrics.configured
      ? metrics.intended
        ? "degraded"
        : "ok"
      : !metrics.enabled
        ? metrics.required
          ? "degraded"
          : "ok"
        : metrics.failed > 0 ||
            metrics.sourceMissing > 0 ||
            metrics.sourceCorrupt > 0 ||
            (metrics.required &&
              (metrics.backlog > 0 || metrics.coveragePct < 100))
          ? "degraded"
          : "ok";
    const detail = !metrics.configured
      ? metrics.intended
        ? "Independent file replica configuration is incomplete"
        : "Independent file replica rollout is not enabled"
      : !metrics.enabled
        ? metrics.required
          ? "Independent file replica is required but execution is disabled"
          : "Independent file replica target is staged but execution is disabled"
        : `${metrics.available}/${metrics.activeFiles} active files independently available (${metrics.coveragePct}%)`;

    await reportCronHeartbeat({
      job: "file-replicas",
      status,
      detail,
      metrics: { ...metrics },
    });

    if (status === "degraded" && metrics.configured) {
      const alertDetail =
        metrics.required && !metrics.enabled
          ? "Independent file replica is required but execution is disabled."
          : `${metrics.failed} failed, ${metrics.sourceMissing} primary missing, ${metrics.sourceCorrupt} integrity mismatch, ${metrics.backlog} in backlog, ${metrics.coveragePct}% independently available.`;
      void alertOps(
        "File replica reconciliation degraded",
        alertDetail,
      );
    }

    return NextResponse.json({ ok: true, status, detail, metrics });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      "[file-replicas] crash diagnostic",
      databaseFailureDiagnostic(error),
    );
    await alertOps("File replica reconciliation crashed", message);
    await reportCronHeartbeat({
      job: "file-replicas",
      status: "failed",
      detail: "File replica reconciliation crashed",
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
