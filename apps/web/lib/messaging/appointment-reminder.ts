import type { Database } from "@openpims/db/client";
import {
  appointments,
  clients,
  communications,
  emailSuppressions,
  patients,
  practices,
} from "@openpims/db";
import { and, eq, gte, isNull, lte, sql } from "drizzle-orm";
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
 * Revalidate the mutable clinic/appointment boundary immediately before a
 * reminder claim. The hourly sweep is only a candidate list: an admin can turn
 * reminders off, or staff can cancel/reschedule an appointment, while the job
 * is running. Provider dispatch must never rely on that stale snapshot.
 */
export async function appointmentReminderDispatchEligible(
  db: Pick<Database, "select">,
  options: {
    practiceId: string;
    appointmentId: string;
    clientId: string;
    startTime: Date;
    now: Date;
  },
): Promise<boolean> {
  const [eligible] = await db
    .select({ dispatchEligible: appointments.id })
    .from(appointments)
    .innerJoin(
      practices,
      and(
        eq(practices.id, appointments.practiceId),
        isNull(practices.deletedAt),
        eq(practices.appointmentRemindersEnabled, true),
      ),
    )
    .innerJoin(
      clients,
      and(
        eq(clients.id, appointments.clientId),
        eq(clients.practiceId, appointments.practiceId),
        isNull(clients.deletedAt),
      ),
    )
    .innerJoin(
      patients,
      and(
        eq(patients.id, appointments.patientId),
        eq(patients.clientId, appointments.clientId),
        eq(patients.practiceId, appointments.practiceId),
        isNull(patients.deletedAt),
      ),
    )
    .where(
      and(
        eq(appointments.id, options.appointmentId),
        eq(appointments.practiceId, options.practiceId),
        eq(appointments.clientId, options.clientId),
        eq(appointments.startTime, options.startTime),
        eq(appointments.status, "confirmed"),
        isNull(appointments.deletedAt),
        gte(appointments.startTime, options.now),
        lte(
          appointments.startTime,
          sql`${options.now.toISOString()}::timestamptz + (${practices.appointmentReminderLeadHours} * interval '1 hour')`,
        ),
      ),
    )
    .limit(1);

  return Boolean(eligible);
}

/**
 * Resolve the recipient again immediately before an email provider call. This
 * is intentionally separate from the sweep and claim so an address edit,
 * bounce, complaint, cancellation, or clinic kill-switch committed while the
 * job is running is honored before any email leaves OpenVPM.
 */
export async function currentAppointmentReminderEmailRecipient(
  db: Pick<Database, "select">,
  options: {
    practiceId: string;
    appointmentId: string;
    clientId: string;
    startTime: Date;
    now: Date;
  },
): Promise<{
  recipientEmail: string | null;
  suppressionReason: string | null;
  clientFirstName: string;
  clientLastName: string;
  patientName: string | null;
  practiceName: string;
} | null> {
  const [recipient] = await db
    .select({
      recipientEmail: clients.email,
      suppressionReason: emailSuppressions.reason,
      clientFirstName: clients.firstName,
      clientLastName: clients.lastName,
      patientName: patients.name,
      practiceName: practices.name,
    })
    .from(appointments)
    .innerJoin(
      practices,
      and(
        eq(practices.id, appointments.practiceId),
        isNull(practices.deletedAt),
        eq(practices.appointmentRemindersEnabled, true),
      ),
    )
    .innerJoin(
      clients,
      and(
        eq(clients.id, appointments.clientId),
        eq(clients.practiceId, appointments.practiceId),
        isNull(clients.deletedAt),
      ),
    )
    .innerJoin(
      patients,
      and(
        eq(patients.id, appointments.patientId),
        eq(patients.clientId, appointments.clientId),
        eq(patients.practiceId, appointments.practiceId),
        isNull(patients.deletedAt),
      ),
    )
    .leftJoin(
      emailSuppressions,
      and(
        eq(emailSuppressions.practiceId, appointments.practiceId),
        sql`${emailSuppressions.email} = lower(trim(${clients.email}))`,
        isNull(emailSuppressions.deletedAt),
      ),
    )
    .where(
      and(
        eq(appointments.id, options.appointmentId),
        eq(appointments.practiceId, options.practiceId),
        eq(appointments.clientId, options.clientId),
        eq(appointments.startTime, options.startTime),
        eq(appointments.status, "confirmed"),
        isNull(appointments.deletedAt),
        gte(appointments.startTime, options.now),
        lte(
          appointments.startTime,
          sql`${options.now.toISOString()}::timestamptz + (${practices.appointmentReminderLeadHours} * interval '1 hour')`,
        ),
      ),
    )
    .limit(1);

  return recipient ?? null;
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
