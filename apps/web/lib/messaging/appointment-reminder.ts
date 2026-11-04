import type { Database } from "@openpims/db/client";
import {
  appointments,
  clients,
  communications,
  emailSuppressions,
  patients,
  practices,
} from "@openpims/db";
import { and, eq, gte, isNull, lte, ne, or, sql } from "drizzle-orm";
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

export const APPOINTMENT_REMINDER_SUBJECT = "Appointment Reminder";
export const AUTOMATED_APPOINTMENT_REMINDER_SUBJECT =
  "Automated Appointment Reminder";

/**
 * A pending email claim older than this is treated as abandoned (the process
 * died between claiming and recording an outcome) and may be reclaimed.
 */
export const STALE_EMAIL_REMINDER_CLAIM_MS = 15 * 60 * 1000;

/** Keep a provider/gate failure reason short enough for the client timeline. */
export function reminderFailureReason(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const reason = raw.replace(/\s+/g, " ").trim();
  if (!reason) return "unknown error";
  return reason.length > 300 ? `${reason.slice(0, 297)}...` : reason;
}

/**
 * Shared cross-path claim. One row per appointment start time (the dedupe
 * key) records the reminder; a live pending claim blocks concurrent sends.
 *
 * Reclaim rules when the row already exists:
 * - `failed` rows are reclaimable so a failure never permanently blocks the
 *   visit's reminder. Staff sends (manual and bulk) can always retry; the
 *   automated sweep only retries failures it did not record itself, so a
 *   persistent failure is not re-attempted every hour.
 * - `pending` email rows are reclaimable once stale (the sender died before
 *   recording an outcome).
 * - `pending` SMS rows are only recovered when no provider attempt was ever
 *   reserved. SMS retries of a failed row reuse the same idempotency key, so
 *   the attempt ledger replays any earlier provider outcome instead of
 *   texting twice.
 *
 * The reclaim is a single conditional UPDATE: a concurrent claimer blocks on
 * the row lock, re-evaluates against the now-pending row, and gets nothing.
 */
export async function claimAppointmentReminderCommunication(
  db: Pick<Database, "insert" | "select" | "update">,
  options: {
    practiceId: string;
    appointmentId: string;
    clientId: string;
    channel: "sms" | "email";
    patientName: string | null;
    startTime: Date;
    source?: "staff" | "automated";
    now?: Date;
  },
): Promise<string | null> {
  const dedupeKey = appointmentReminderDedupeKey({
    id: options.appointmentId,
    startTime: options.startTime,
  });
  const automated = options.source === "automated";
  const subject = automated
    ? AUTOMATED_APPOINTMENT_REMINDER_SUBJECT
    : APPOINTMENT_REMINDER_SUBJECT;
  const content = `${automated ? "Automated appointment" : "Appointment"} reminder pending for ${options.patientName ?? "Unknown"} on ${options.startTime.toISOString()}`;
  const [row] = await db
    .insert(communications)
    .values({
      practiceId: options.practiceId,
      clientId: options.clientId,
      channel: options.channel,
      direction: "outbound",
      subject,
      content,
      status: "pending",
      dedupeKey,
    })
    .onConflictDoNothing({ target: communications.dedupeKey })
    .returning({ id: communications.id });
  if (row) return row.id;

  const now = options.now ?? new Date();
  const staleEmailCutoff = new Date(
    now.getTime() - STALE_EMAIL_REMINDER_CLAIM_MS,
  );
  const [reclaimed] = await db
    .update(communications)
    .set({
      channel: options.channel,
      subject,
      content,
      status: "pending",
      providerMessageId: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(communications.practiceId, options.practiceId),
        eq(communications.dedupeKey, dedupeKey),
        eq(communications.direction, "outbound"),
        isNull(communications.deletedAt),
        or(
          automated
            ? and(
                eq(communications.status, "failed"),
                ne(communications.subject, AUTOMATED_APPOINTMENT_REMINDER_SUBJECT),
              )
            : eq(communications.status, "failed"),
          and(
            eq(communications.status, "pending"),
            eq(communications.channel, "email"),
            lte(communications.updatedAt, staleEmailCutoff),
          ),
        ),
      ),
    )
    .returning({ id: communications.id });
  if (reclaimed) return reclaimed.id;
  if (options.channel !== "sms") return null;

  return recoverStaleUnreservedSmsCommunication(db, {
    practiceId: options.practiceId,
    dedupeKey,
  });
}
