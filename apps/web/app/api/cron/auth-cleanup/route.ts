import { NextResponse } from "next/server";
import { cleanupExpiredAuthArtifacts } from "@/lib/auth-tokens";
import { cronAuthError } from "@/lib/cron-auth";
import { alertOps } from "@/lib/alerts";
import { reportCronHeartbeat } from "@/lib/cron-heartbeat";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const authError = cronAuthError(request);
  if (authError) return authError;

  try {
    const result = await cleanupExpiredAuthArtifacts();
    await reportCronHeartbeat({
      job: "auth-cleanup",
      status: "ok",
      detail: `${result.deleted} expired auth artifacts deleted`,
      metrics: {
        deleted: result.deleted,
        authTokensDeleted: result.authTokensDeleted,
        sessionsDeleted: result.sessionsDeleted,
        verificationTokensDeleted: result.verificationTokensDeleted,
        portalSessionsDeleted: result.portalSessionsDeleted,
      },
    });
    return NextResponse.json({
      deleted: result.deleted,
      authTokensDeleted: result.authTokensDeleted,
      sessionsDeleted: result.sessionsDeleted,
      verificationTokensDeleted: result.verificationTokensDeleted,
      portalSessionsDeleted: result.portalSessionsDeleted,
      cutoff: result.cutoff.toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void alertOps("Auth cleanup failed", message);
    await reportCronHeartbeat({
      job: "auth-cleanup",
      status: "failed",
      detail: message,
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
