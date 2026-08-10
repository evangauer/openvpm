import type { Database } from "@openpims/db/client";
import { dispatchWebhookEvent } from "@/lib/webhook-dispatcher";

export type AppointmentCreatedWebhookSource =
  | "agent"
  | "api"
  | "booking_page"
  | "dashboard"
  | "portal";

type AppointmentCreatedWebhookRow = {
  id: string;
  startTime: Date;
  endTime: Date;
  status?: string | null;
  patientId?: string | null;
  clientId?: string | null;
  doctorId?: string | null;
  typeId?: string | null;
  roomId?: string | null;
  locationId?: string | null;
};

export function appointmentCreatedWebhookPayload(
  appointment: AppointmentCreatedWebhookRow,
  source: AppointmentCreatedWebhookSource
) {
  return {
    id: appointment.id,
    startTime: appointment.startTime,
    endTime: appointment.endTime,
    status: appointment.status ?? null,
    patientId: appointment.patientId ?? null,
    clientId: appointment.clientId ?? null,
    doctorId: appointment.doctorId ?? null,
    typeId: appointment.typeId ?? null,
    roomId: appointment.roomId ?? null,
    locationId: appointment.locationId ?? null,
    source,
  };
}

/** Keep external delivery outside appointment scheduling transactions/locks. */
export async function dispatchAppointmentWebhookAfterCommit(
  ctx: {
    postCommitEffect?: (effect: (rootDb: Database) => Promise<void>) => void;
  },
  practiceId: string,
  event: string,
  payload: Record<string, any>,
): Promise<void> {
  if (ctx.postCommitEffect) {
    ctx.postCommitEffect(async () => {
      await dispatchWebhookEvent(practiceId, event, payload);
    });
    return;
  }
  await dispatchWebhookEvent(practiceId, event, payload);
}
