import { NextResponse } from "next/server";
import { db } from "@openpims/db/client";
import { alertOps } from "@/lib/alerts";
import { cronAuthError } from "@/lib/cron-auth";
import { reportCronHeartbeat } from "@/lib/cron-heartbeat";
import {
  getSmsOperationsHealth,
  type SmsOperationsHealth,
} from "@/lib/messaging/sms-operations-health";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_ALERT_REASONS = 10;
const SAFE_REASON_CODE = /^[a-z0-9_.:-]{1,64}$/;

async function alertOpsSafely(subject: string, detail: string): Promise<void> {
  try {
    await alertOps(subject, detail);
  } catch {
    // Reporting must not turn this monitoring endpoint into a retry loop.
  }
}

async function reportHeartbeatSafely(
  input: Parameters<typeof reportCronHeartbeat>[0],
): Promise<void> {
  try {
    await reportCronHeartbeat(input);
  } catch {
    // The heartbeat helper normally contains its own failures; fail safe if an
    // unexpected implementation error escapes it.
  }
}

function reasonSummary(reasons: SmsOperationsHealth["reasons"]): string {
  const safe = reasons.slice(0, MAX_ALERT_REASONS).map((reason) => {
    const code = SAFE_REASON_CODE.test(reason.reason)
      ? reason.reason
      : `unclassified_${reason.category}`;
    return `${reason.severity}/${reason.category}/${code}=${reason.count}`;
  });

  return safe.length > 0 ? safe.join("; ") : "none reported";
}

function heartbeatMetrics(health: SmsOperationsHealth) {
  return {
    status: health.status,
    critical: health.counts.critical,
    attention: health.counts.attention,
    carrier: health.counts.carrier,
    profile: health.counts.profile,
    sendAttempts: health.counts.sendAttempts,
    deliveryEvents: health.counts.deliveryEvents,
    staleWithoutFinal: health.counts.staleWithoutFinal,
    providerAuditFailures: health.counts.providerAuditFailures,
    reasonGroups: health.reasons.length,
    truncated: health.truncated,
  };
}

function degradedAlert(health: SmsOperationsHealth): string {
  const counts = health.counts;
  const countQualifier = health.truncated ? "at least " : "";
  const truncationNotice = health.truncated
    ? " The bounded queue is truncated; additional exceptions exist."
    : "";
  return [
    `Status: ${health.status}. P0: ${countQualifier}${counts.critical}; P1: ${countQualifier}${counts.attention}.${truncationNotice}`,
    `Carrier: ${countQualifier}${counts.carrier}; profile: ${countQualifier}${counts.profile}; send attempts: ${countQualifier}${counts.sendAttempts}; delivery events: ${countQualifier}${counts.deliveryEvents}; stale without final: ${countQualifier}${counts.staleWithoutFinal}; provider audit failures: ${countQualifier}${counts.providerAuditFailures}.`,
    `Reason counts (bounded${health.truncated ? " lower bounds" : ""}): ${reasonSummary(health.reasons)}.`,
    "Review the SMS operations queue. This check made no provider, launch-control, message, or evidence changes.",
  ].join(" ");
}

/**
 * Daily, read-only SMS operations monitor. It reports existing evidence only;
 * it never sends/retries SMS, reconciles evidence, mutates a provider profile,
 * or changes a launch flag or allowlist.
 */
export async function GET(request: Request) {
  const authError = cronAuthError(request);
  if (authError) return authError;

  try {
    const health = await getSmsOperationsHealth(db);
    const degraded = health.status !== "healthy";

    if (degraded) {
      await alertOpsSafely(
        health.status === "critical"
          ? "SMS operations critical"
          : "SMS operations attention required",
        degradedAlert(health),
      );
    }

    await reportHeartbeatSafely({
      job: "sms-operations",
      status: degraded ? "degraded" : "ok",
      detail: degraded
        ? `${health.truncated ? "At least " : ""}${health.counts.critical} P0 and ${health.counts.attention} P1 exception(s)${health.truncated ? "; bounded queue truncated" : ""}`
        : "No SMS operations exceptions",
      metrics: heartbeatMetrics(health),
    });

    return NextResponse.json({
      ok: true,
      status: health.status,
      counts: health.counts,
      reasonGroups: health.reasons.length,
      truncated: health.truncated,
    });
  } catch {
    const detail = "Read-only SMS operations health computation failed";
    await alertOpsSafely(
      "SMS operations health check failed",
      `${detail}. Review application logs; no automated action was taken.`,
    );
    await reportHeartbeatSafely({
      job: "sms-operations",
      status: "failed",
      detail,
    });
    // Deliberately not a 5xx: report the failure without creating a retry loop.
    return NextResponse.json({
      ok: false,
      error: "SMS operations health check failed",
    });
  }
}
