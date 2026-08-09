import type { Database } from "@openpims/db/client";
import { communications } from "@openpims/db";
import { recoverStaleUnreservedSmsCommunication } from "@/lib/messaging/durable-sms-communication";

export function appointmentReminderDedupeKey(appointment: {
  id: string;
  startTime: Date | string;
}): string {
  return `reminder:appointment:${appointment.id}:${new Date(
    appointment.startTime,
  ).toISOString()}`;
}

export function appointmentReminderSmsIdempotencyKey(appointment: {
  id: string;
  startTime: Date | string;
}): string {
  return `sms:${appointmentReminderDedupeKey(appointment)}`;
}

/**
 * Shared cross-path claim. Pending and failed rows are intentionally not
 * reclaimed automatically: either can represent a provider-ambiguous SMS.
 */
export async function claimAppointmentReminderCommunication(
  db: Pick<Database, "insert" | "select">,
  options: {
    practiceId: string;
    appointmentId: string;
    clientId: string;
    channel: "sms" | "email";
    patientName: string | null;
    startTime: Date;
  },
): Promise<string | null> {
  const dedupeKey = appointmentReminderDedupeKey({
    id: options.appointmentId,
    startTime: options.startTime,
  });
  const [row] = await db
    .insert(communications)
    .values({
      practiceId: options.practiceId,
      clientId: options.clientId,
      channel: options.channel,
      direction: "outbound",
      subject: "Appointment Reminder",
      content: `Appointment reminder pending for ${options.patientName ?? "Unknown"} on ${options.startTime.toISOString()}`,
      status: "pending",
      dedupeKey,
    })
    .onConflictDoNothing({ target: communications.dedupeKey })
    .returning({ id: communications.id });
  if (row) return row.id;
  if (options.channel !== "sms") return null;

  return recoverStaleUnreservedSmsCommunication(db, {
    practiceId: options.practiceId,
    dedupeKey,
  });
}
