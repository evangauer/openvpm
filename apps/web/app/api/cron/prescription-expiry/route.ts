import { NextResponse } from "next/server";
import { alertOps } from "@/lib/alerts";
import { cronAuthError } from "@/lib/cron-auth";
import { reportCronHeartbeat } from "@/lib/cron-heartbeat";
import { dispatchWebhookEvent } from "@/lib/webhook-dispatcher";
import { expireDuePrescriptions } from "@/lib/records/prescription-expiry";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const authError = cronAuthError(request);
  if (authError) return authError;

  try {
    const result = await expireDuePrescriptions();
    await Promise.all(
      result.prescriptions.map((prescription) =>
        dispatchWebhookEvent(prescription.practiceId, "prescription.expired", {
          id: prescription.id,
          patientId: prescription.patientId,
          source: "system",
        }),
      ),
    );
    await reportCronHeartbeat({
      job: "prescription-expiry",
      status: "ok",
      detail: `${result.expired} prescriptions expired`,
      metrics: { expired: result.expired },
    });
    return NextResponse.json({ expired: result.expired });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void alertOps("Prescription expiry failed", message);
    await reportCronHeartbeat({
      job: "prescription-expiry",
      status: "failed",
      detail: message,
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
