import type { Database } from "@openpims/db/client";
import {
  appointments,
  clients,
  communications,
  emailSuppressions,
  patients,
  practices,
} from "@openpims/db";
import { and, eq, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { recoverStaleUnreservedSmsCommunication } from "@/lib/messaging/durable-sms-communication";

export function appointmentReminderDedupeKey(appointment: {
  id: string;
  startTime: Date | string;
}): string {
  return `reminder:appointment:${appointment.id}:${new Date(
    appointment.startTime,
  ).toISOString()}`;
}

/**
 * Provider idempotency keys are scoped to the reminder's send attempt. A
 * reclaimed abandoned claim keeps its attempt (and key), so the provider
 * replays an earlier send instead of delivering twice. Only an explicit retry
 * of a definite failure starts a new attempt and therefore a new send.
 */
export function appointmentReminderSmsIdempotencyKey(
  appointment: { id: string; startTime: Date | string },
  attempt = 1,
): string {
  const key = `sms:${appointmentReminderDedupeKey(appointment)}`;
  return attempt > 1 ? `${key}:attempt-${attempt}` : key;
}

export function appointmentReminderEmailIdempotencyKey(
  appointment: { id: string; startTime: Date | string },
  attempt = 1,
): string {
  return `email:${appointmentReminderDedupeKey(appointment)}:attempt-${attempt}`;
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
 * A pending email claim whose last write is older than this is treated as
 * abandoned (the process died between claiming and recording an outcome) and
 * may be reclaimed. Measured on the database clock.
 */
export const STALE_EMAIL_REMINDER_CLAIM_MS = 15 * 60 * 1000;

/** The hourly sweep waits this long before retrying its own failure. */
export const AUTOMATED_REMINDER_RETRY_DELAY_MS = 60 * 60 * 1000;

/** Total sweep claims per reminder: the first send plus one retry. */
export const MAX_AUTOMATED_REMINDER_ATTEMPTS = 2;

export type AppointmentReminderOutcome =
  | "staff_failure"
  | "automated_failure"
  | "outcome_unknown";

/**
 * Keep the client timeline free of raw provider and database text. Errors we
 * raise for staff (TRPCError) already carry a staff-facing message; anything
 * else is logged server-side and replaced with a generic reason.
 */
export function reminderFailureReason(error: unknown): string {
  if (error instanceof TRPCError) return boundedReason(error.message);
  console.error("[appointment-reminder] unexpected send failure:", error);
  return "An unexpected error stopped the reminder.";
}

function boundedReason(raw: string): string {
  const reason = raw.replace(/\s+/g, " ").trim();
  if (!reason) return "An unexpected error stopped the reminder.";
  return reason.length > 300 ? `${reason.slice(0, 297)}...` : reason;
}

/** Staff-facing reason for an email the provider did not accept. */
export function emailReminderFailureReason(result: {
  outcome: "accepted" | "definite_failure" | "outcome_unknown";
  error?: string;
}): string {
  if (result.error) {
    console.error("[appointment-reminder] email provider:", result.error);
  }
  if (result.outcome === "outcome_unknown") {
    return "The email provider did not confirm the send. It may have been delivered.";
  }
  if (result.error === "Email provider is not configured for hosted sending.") {
    return "Email sending is not set up.";
  }
  return "The email provider rejected the reminder.";
}

/** Staff-facing reason for a text message the provider did not accept. */
export function smsReminderFailureReason(result: {
  outcome: "accepted" | "definite_failure" | "outcome_unknown";
  error?: string;
}): string {
  if (result.error) {
    console.error("[appointment-reminder] SMS provider:", result.error);
  }
  if (result.outcome === "outcome_unknown") {
    return "The text message provider did not confirm the send. It may have been delivered.";
  }
  if (result.error && /opted out/i.test(result.error)) {
    return "The client has opted out of text messages.";
  }
  if (result.error === "Set up an active texting number before sending SMS reminders") {
    return "No active texting number is set up for this location.";
  }
  return "The text message provider rejected the reminder.";
}

export type AppointmentReminderClaim = {
  id: string;
  /** Send attempt; scopes provider idempotency keys. */
  attempt: number;
};

/**
 * Shared cross-path claim. One row per appointment start time (the dedupe
 * key) records the reminder; a live pending claim blocks concurrent sends.
 *
 * Reclaim rules when the row already exists. Only rows this code wrote
 * (`reminder_attempt` set) are ever reclaimed; older rows keep blocking.
 * - A definite failure is reclaimable and starts a new send attempt. Staff
 *   sends (manual and bulk) can always retry it. The automated sweep retries
 *   a staff failure, and its own failure only after an hour, and claims a
 *   reminder at most twice in total.
 * - A pending email claim is reclaimable by another email send once stale
 *   (the sender died before recording an outcome). It keeps its send
 *   attempt, so the provider idempotency key replays any earlier send. It is
 *   never switched to SMS, which could text a client who was already emailed.
 * - A pending SMS claim is only recovered when no provider attempt was ever
 *   reserved (see recoverStaleUnreservedSmsCommunication).
 * - A send whose provider outcome is unknown is never reclaimed.
 *
 * The reclaim is a single conditional UPDATE that also sets `updated_at` to
 * the database clock. A concurrent claimer blocks on the row lock,
 * re-evaluates against the now-pending, freshly updated row, and gets nothing.
 */
export async function claimAppointmentReminderCommunication(
  db: Pick<Database, "insert" | "update">,
  options: {
    practiceId: string;
    appointmentId: string;
    clientId: string;
    channel: "sms" | "email";
    patientName: string | null;
    startTime: Date;
    source?: "staff" | "automated";
  },
): Promise<AppointmentReminderClaim | null> {
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
      reminderAttempt: 1,
      reminderAutomatedAttempts: automated ? 1 : 0,
      reminderOutcome: null,
    })
    .onConflictDoNothing({ target: communications.dedupeKey })
    .returning({ id: communications.id });
  if (row) return { id: row.id, attempt: 1 };

  const staleEmailClaim = sql`${communications.updatedAt} <= now() - make_interval(secs => ${STALE_EMAIL_REMINDER_CLAIM_MS / 1000})`;
  const retryableFailure = automated
    ? and(
        eq(communications.status, "failed"),
        lt(
          communications.reminderAutomatedAttempts,
          MAX_AUTOMATED_REMINDER_ATTEMPTS,
        ),
        or(
          eq(communications.reminderOutcome, "staff_failure"),
          and(
            eq(communications.reminderOutcome, "automated_failure"),
            sql`${communications.updatedAt} <= now() - make_interval(secs => ${AUTOMATED_REMINDER_RETRY_DELAY_MS / 1000})`,
          ),
        ),
      )
    : and(
        eq(communications.status, "failed"),
        inArray(communications.reminderOutcome, [
          "staff_failure",
          "automated_failure",
        ]),
      );
  const [reclaimed] = await db
    .update(communications)
    .set({
      channel: options.channel,
      subject,
      content,
      status: "pending",
      providerMessageId: null,
      reminderOutcome: null,
      // A retried failure is a new send; a reclaimed abandoned claim is not.
      reminderAttempt: sql`case when ${communications.status} = 'failed' then ${communications.reminderAttempt} + 1 else ${communications.reminderAttempt} end`,
      reminderAutomatedAttempts: automated
        ? sql`${communications.reminderAutomatedAttempts} + 1`
        : sql`${communications.reminderAutomatedAttempts}`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(communications.practiceId, options.practiceId),
        eq(communications.dedupeKey, dedupeKey),
        eq(communications.direction, "outbound"),
        isNull(communications.deletedAt),
        isNotNull(communications.reminderAttempt),
        options.channel === "email"
          ? or(
              retryableFailure,
              and(
                eq(communications.status, "pending"),
                eq(communications.channel, "email"),
                isNull(communications.reminderOutcome),
                staleEmailClaim,
              ),
            )
          : retryableFailure,
      ),
    )
    .returning({
      id: communications.id,
      attempt: communications.reminderAttempt,
    });
  if (reclaimed) return { id: reclaimed.id, attempt: reclaimed.attempt ?? 1 };
  if (options.channel !== "sms") return null;

  const recoveredId = await recoverStaleUnreservedSmsCommunication(db, {
    practiceId: options.practiceId,
    dedupeKey,
  });
  if (!recoveredId) return null;
  // No provider attempt was ever reserved, so any earlier "unknown" marker
  // (a dispatch that threw before reserving) no longer applies.
  const [recovered] = await db
    .update(communications)
    .set({ reminderOutcome: null, updatedAt: sql`now()` })
    .where(
      and(
        eq(communications.id, recoveredId),
        eq(communications.practiceId, options.practiceId),
      ),
    )
    .returning({ attempt: communications.reminderAttempt });
  return { id: recoveredId, attempt: recovered?.attempt ?? 1 };
}

/**
 * Record how a claimed reminder ended. Only a pending claim (or the same
 * accepted provider message) is updated, so a late or duplicate projection can
 * never turn a sent reminder into a failed one.
 *
 * - `sent`: the provider accepted the message.
 * - `failed`: a definite failure; the reminder may be retried.
 * - `unknown`: the provider may have delivered it. The row stays pending with
 *   `reminder_outcome = 'outcome_unknown'`, shows as "Delivery unknown", and is
 *   never reclaimed.
 */
export async function recordAppointmentReminderOutcome(
  db: Pick<Database, "update">,
  options: {
    practiceId: string;
    communicationId: string;
    channel: "sms" | "email";
    result: "sent" | "failed" | "unknown";
    source: "staff" | "automated";
    content: string;
    providerMessageId?: string;
  },
) {
  const sentRowMatches =
    options.result === "sent" && options.providerMessageId
      ? and(
          eq(communications.status, "sent"),
          eq(communications.providerMessageId, options.providerMessageId),
        )
      : undefined;
  return db
    .update(communications)
    .set({
      channel: options.channel,
      content: options.content,
      status:
        options.result === "sent"
          ? "sent"
          : options.result === "failed"
            ? "failed"
            : "pending",
      providerMessageId: options.providerMessageId ?? null,
      reminderOutcome:
        options.result === "sent"
          ? null
          : options.result === "unknown"
            ? "outcome_unknown"
            : options.source === "automated"
              ? "automated_failure"
              : "staff_failure",
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(communications.id, options.communicationId),
        eq(communications.practiceId, options.practiceId),
        isNull(communications.deletedAt),
        sentRowMatches
          ? or(eq(communications.status, "pending"), sentRowMatches)
          : eq(communications.status, "pending"),
      ),
    );
}

/** Explain why a reminder could not be claimed. */
export async function appointmentReminderConflictMessage(
  db: Pick<Database, "select">,
  options: { practiceId: string; appointmentId: string; startTime: Date },
): Promise<string> {
  const [row] = await db
    .select({
      status: communications.status,
      reminderOutcome: communications.reminderOutcome,
    })
    .from(communications)
    .where(
      and(
        eq(communications.practiceId, options.practiceId),
        eq(
          communications.dedupeKey,
          appointmentReminderDedupeKey({
            id: options.appointmentId,
            startTime: options.startTime,
          }),
        ),
        isNull(communications.deletedAt),
      ),
    )
    .limit(1);
  if (row?.reminderOutcome === "outcome_unknown") {
    return "The last reminder for this appointment may have been delivered, but the provider never confirmed it. To avoid a duplicate, it can't be sent again. Contact the client directly if needed.";
  }
  if (row?.status === "failed") {
    return "An earlier reminder for this appointment failed and can't be retried automatically. Contact the client directly.";
  }
  return "A reminder for this appointment is already pending or was already sent.";
}
