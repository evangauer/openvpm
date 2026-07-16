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
    source,
  };
}
