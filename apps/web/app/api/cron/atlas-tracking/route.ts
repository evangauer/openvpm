import { NextResponse } from "next/server";
import { db } from "@openpims/db/client";
import { cronAuthError } from "@/lib/cron-auth";
import { reportCronHeartbeat } from "@/lib/cron-heartbeat";
import { syncAtlasTracking } from "@/lib/integrations/atlas-tracking";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  const authError = cronAuthError(request);
  if (authError) return authError;
  try {
    const result = await syncAtlasTracking(db);
    await reportCronHeartbeat({
      job: "atlas-tracking", status: "ok",
      detail: result.status === "disabled" ? "Atlas tracking disabled" : "OpenVPM account tracking acknowledged",
      metrics: { accepted: result.accepted },
    });
    return NextResponse.json(result);
  } catch {
    await reportCronHeartbeat({
      job: "atlas-tracking", status: "failed", detail: "OpenVPM account tracking was not fully acknowledged",
    });
    return NextResponse.json({ error: "Atlas tracking failed; retry is safe" }, { status: 502 });
  }
}
