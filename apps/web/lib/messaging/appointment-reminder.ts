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
import { lockPracticeForExternalSideEffects } from "@/lib/recovery-hold";

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
 * reclaimed abandoned or unconfirmed email keeps its attempt (and key), so the
 * provider replays an earlier send instead of delivering twice. Only an
 * explicit retry of a definite failure starts a new attempt and therefore a
 * new send.
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
  practicePhone: string | null;
} | null> {
  const [recipient] = await db
    .select({
      recipientEmail: clients.email,
      suppressionReason: emailSuppressions.reason,
      clientFirstName: clients.firstName,
      clientLastName: clients.lastName,
      patientName: patients.name,
      practiceName: practices.name,
      practicePhone: practices.phone,
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

const DEFAULT_REMINDER_PRACTICE_NAME = "your clinic";

function formatInTimeZone(
  date: Date,
  timeZone: string | null | undefined,
  format: (date: Date, timeZone: string) => string,
): string {
  try {
    return format(date, timeZone?.trim() || "UTC");
  } catch {
    // An invalid saved timezone falls back to UTC.
    return format(date, "UTC");
  }
}

/**
 * The one formatter for appointment reminder content. Staff sends and the
 * hourly sweep reuse the same provider idempotency key for an attempt, so
 * they must build identical messages from identical data: a resend under the
 * same key with a different body is rejected by the provider and could never
 * confirm the original send.
 */
export function appointmentReminderMessageFields(options: {
  startTime: Date | string;
  timeZone?: string | null;
  patientName: string | null;
  practiceName: string | null;
  practicePhone: string | null;
}): {
  appointmentDate: string;
  appointmentTime: string;
  patientName: string;
  practiceName: string;
  practicePhone?: string;
} {
  const startTime = new Date(options.startTime);
  const practicePhone = options.practicePhone?.trim();
  return {
    appointmentDate: formatInTimeZone(startTime, options.timeZone, (d, tz) =>
      d.toLocaleDateString("en-US", {
        timeZone: tz,
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      }),
    ),
    appointmentTime: formatInTimeZone(startTime, options.timeZone, (d, tz) =>
      d.toLocaleTimeString("en-US", {
        timeZone: tz,
        hour: "numeric",
        minute: "2-digit",
      }),
    ),
    patientName: options.patientName ?? "Unknown",
    practiceName: options.practiceName?.trim() || DEFAULT_REMINDER_PRACTICE_NAME,
    ...(practicePhone ? { practicePhone } : {}),
  };
}

/** Email reminder fields; see appointmentReminderMessageFields. */
export function appointmentReminderEmailFields(options: {
  startTime: Date | string;
  timeZone?: string | null;
  clientFirstName: string | null;
  clientLastName: string | null;
  patientName: string | null;
  practiceName: string | null;
  practicePhone: string | null;
}) {
  return {
    ...appointmentReminderMessageFields(options),
    clientName: `${options.clientFirstName ?? ""} ${options.clientLastName ?? ""}`.trim(),
  };
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

/**
 * An email attempt may be resent under its own idempotency key only while the
 * provider still honors that key. Resend keeps keys for 24 hours; the margin
 * covers the time between claiming and the provider first seeing the key.
 * Measured from the attempt's first claim on the database clock.
 */
export const EMAIL_REMINDER_KEY_REUSE_WINDOW_MS = 23 * 60 * 60 * 1000;

/**
 * The hourly sweep waits this long before retrying its own failure. Shorter
 * than an hour so normal cron start-time jitter can't push the retry back a
 * whole extra run.
 */
export const AUTOMATED_REMINDER_RETRY_DELAY_MS = 50 * 60 * 1000;

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
  /**
   * Fencing value written by this claim. Every send re-checks it under a row
   * lock right before calling a provider, and every outcome write requires
   * it, so a claimant that was overtaken can neither send nor overwrite.
   */
  claimToken: string;
  /**
   * True when this claim resumed an email attempt that may already have
   * reached the provider (an abandoned or unconfirmed send). Nothing that
   * happens on a redispatch proves the earlier send failed, so anything short
   * of a confirmed send is recorded as "Delivery unknown", never as a
   * retryable failure that would start a new attempt under a new key.
   */
  redispatch: boolean;
};

/**
 * Shared cross-path claim. One row per appointment start time (the dedupe
 * key) records the reminder; a live pending claim blocks concurrent sends.
 *
 * Reclaim rules when the row already exists. Only rows this code wrote
 * (`reminder_attempt` set) are ever reclaimed; older rows keep blocking.
 * - A definite failure is reclaimable and starts a new send attempt (and
 *   restarts the attempt clock). Staff sends (manual and bulk) can always
 *   retry it. The automated sweep retries a staff failure, and its own
 *   failure only after a delay, and retries a definite failure at most once.
 * - A pending email is reclaimable by another email send, keeping its send
 *   attempt so the provider idempotency key replays any earlier send, while
 *   that key is still honored (EMAIL_REMINDER_KEY_REUSE_WINDOW_MS). That
 *   covers an abandoned claim (no outcome recorded for 15 minutes) and an
 *   email whose provider outcome is unknown. Past the window an abandoned
 *   claim is marked "Delivery unknown" instead; an unconfirmed email is never
 *   resent under a new key and never switched to SMS, either of which could
 *   reach a client who was already emailed.
 * - A pending SMS claim is only recovered when no provider attempt was ever
 *   reserved (see recoverStaleUnreservedSmsCommunication). An SMS whose
 *   provider outcome is unknown is never reclaimed.
 *
 * The reclaim is a single conditional UPDATE that also clears the outcome,
 * writes a new claim token, and sets `updated_at` to the database clock. A concurrent claimer blocks on the
 * row lock, re-evaluates against the now-pending, freshly updated row, and
 * gets nothing.
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
      reminderAttemptStartedAt: sql`now()`,
      reminderClaimToken: sql`gen_random_uuid()`,
    })
    .onConflictDoNothing({ target: communications.dedupeKey })
    .returning({
      id: communications.id,
      claimToken: communications.reminderClaimToken,
    });
  if (row) {
    return { id: row.id, attempt: 1, claimToken: row.claimToken!, redispatch: false };
  }

  const staleEmailClaim = sql`${communications.updatedAt} <= now() - make_interval(secs => ${STALE_EMAIL_REMINDER_CLAIM_MS / 1000})`;
  const emailKeyStillHonored = sql`${communications.reminderAttemptStartedAt} > now() - make_interval(secs => ${EMAIL_REMINDER_KEY_REUSE_WINDOW_MS / 1000})`;
  const sameRow = and(
    eq(communications.practiceId, options.practiceId),
    eq(communications.dedupeKey, dedupeKey),
    eq(communications.direction, "outbound"),
    isNull(communications.deletedAt),
    isNotNull(communications.reminderAttempt),
  );
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
      // A retried failure is a new send; a reclaimed pending email is not.
      reminderAttempt: sql`case when ${communications.status} = 'failed' then ${communications.reminderAttempt} + 1 else ${communications.reminderAttempt} end`,
      reminderAttemptStartedAt: sql`case when ${communications.status} = 'failed' then now() else ${communications.reminderAttemptStartedAt} end`,
      reminderAutomatedAttempts:
        automated
          ? sql`case when ${communications.status} = 'failed' then ${communications.reminderAutomatedAttempts} + 1 else ${communications.reminderAutomatedAttempts} end`
          : sql`${communications.reminderAutomatedAttempts}`,
      reminderClaimToken: sql`gen_random_uuid()`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        sameRow,
        options.channel === "email"
          ? or(
              retryableFailure,
              and(
                eq(communications.status, "pending"),
                eq(communications.channel, "email"),
                emailKeyStillHonored,
                or(
                  and(isNull(communications.reminderOutcome), staleEmailClaim),
                  eq(communications.reminderOutcome, "outcome_unknown"),
                ),
              ),
            )
          : retryableFailure,
      ),
    )
    .returning({
      id: communications.id,
      attempt: communications.reminderAttempt,
      claimToken: communications.reminderClaimToken,
      // RETURNING sees the new row. A retried failure restarts the attempt
      // clock at this transaction's now(); a resumed email keeps the earlier
      // start, so an older start means this claim resumed an attempt.
      redispatch: sql<boolean>`${communications.reminderAttemptStartedAt} < now()`,
    });
  if (reclaimed) {
    return {
      id: reclaimed.id,
      attempt: reclaimed.attempt ?? 1,
      claimToken: reclaimed.claimToken!,
      redispatch: Boolean(reclaimed.redispatch),
    };
  }

  // An abandoned email claim whose key may no longer be honored can't be
  // resent safely. Surface it as "Delivery unknown" rather than "Pending".
  await db
    .update(communications)
    .set({
      content: `Appointment reminder delivery unknown for ${options.patientName ?? "Unknown"} on ${options.startTime.toISOString()}: The email was interrupted before the provider confirmed it. It may have been delivered.`,
      reminderOutcome: "outcome_unknown",
      updatedAt: sql`now()`,
    })
    .where(
      and(
        sameRow,
        eq(communications.status, "pending"),
        eq(communications.channel, "email"),
        isNull(communications.reminderOutcome),
        staleEmailClaim,
        or(
          isNull(communications.reminderAttemptStartedAt),
          sql`not (${emailKeyStillHonored})`,
        ),
      ),
    );
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
    .set({
      reminderOutcome: null,
      reminderClaimToken: sql`gen_random_uuid()`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(communications.id, recoveredId),
        eq(communications.practiceId, options.practiceId),
      ),
    )
    .returning({
      attempt: communications.reminderAttempt,
      claimToken: communications.reminderClaimToken,
    });
  if (!recovered?.claimToken) return null;
  return {
    id: recoveredId,
    attempt: recovered.attempt ?? 1,
    claimToken: recovered.claimToken,
    redispatch: false,
  };
}

/**
 * Fence a provider call. Run inside the transaction that calls the provider,
 * immediately before the call: locks the reminder row and confirms this claim
 * still owns it (pending, no outcome, same claim token, expected channel). A
 * claimant that stalled while another sender reclaimed or advanced the row
 * gets false and must not send. The lock is held through the provider call,
 * so no other claimer can take the row over mid-send.
 */
export async function lockAppointmentReminderClaimForSend(
  db: Pick<Database, "select">,
  options: {
    practiceId: string;
    claim: Pick<AppointmentReminderClaim, "id" | "claimToken">;
    channel: "sms" | "email";
  },
): Promise<boolean> {
  const [row] = await db
    .select({ id: communications.id })
    .from(communications)
    .where(
      and(
        eq(communications.id, options.claim.id),
        eq(communications.practiceId, options.practiceId),
        eq(communications.status, "pending"),
        eq(communications.channel, options.channel),
        isNull(communications.reminderOutcome),
        eq(communications.reminderClaimToken, options.claim.claimToken),
        isNull(communications.deletedAt),
      ),
    )
    .limit(1)
    .for("update");
  return Boolean(row);
}

type ReminderEmailProviderResult = {
  success: boolean;
  id?: string;
  error?: string;
  outcome: "accepted" | "definite_failure" | "outcome_unknown";
};

/**
 * Send a claimed reminder email from its own transaction (opened by
 * `transaction`, which must commit on its own), fenced by the claim
 * (see lockAppointmentReminderClaimForSend). With `holdForRecovery`, the
 * practice's shared recovery lock is held through the provider request too,
 * so a restore drains an in-flight email and a committed hold blocks it.
 *
 * Once the provider has been called, nothing that goes wrong afterwards (a
 * thrown send, a failed commit, a dropped connection) is a definite failure:
 * the provider may have accepted the email, so the result is
 * `outcome_unknown` and any retry reuses the same idempotency key.
 */
export async function sendClaimedAppointmentReminderEmail(
  transaction: <T>(fn: (tx: Database) => Promise<T>) => Promise<T>,
  options: {
    practiceId: string;
    claim: AppointmentReminderClaim;
    holdForRecovery?: boolean;
  },
  send: () => Promise<ReminderEmailProviderResult>,
): Promise<
  | { status: "held" }
  | { status: "superseded" }
  | { status: "called"; result: ReminderEmailProviderResult }
> {
  let providerCalled = false;
  try {
    return await transaction(async (tx) => {
      if (
        options.holdForRecovery &&
        !(await lockPracticeForExternalSideEffects(tx, options.practiceId))
      ) {
        return { status: "held" as const };
      }
      if (
        !(await lockAppointmentReminderClaimForSend(tx, {
          practiceId: options.practiceId,
          claim: options.claim,
          channel: "email",
        }))
      ) {
        return { status: "superseded" as const };
      }
      providerCalled = true;
      try {
        return { status: "called" as const, result: await send() };
      } catch (error) {
        console.error("[appointment-reminder] email send threw:", error);
        return {
          status: "called" as const,
          result: {
            success: false,
            outcome: "outcome_unknown" as const,
            error: "The email send ended without a provider answer.",
          },
        };
      }
    });
  } catch (error) {
    if (!providerCalled) throw error;
    console.error(
      "[appointment-reminder] email transaction failed after the provider call:",
      error,
    );
    return {
      status: "called",
      result: {
        success: false,
        outcome: "outcome_unknown",
        error: "The email transaction did not commit after the provider call.",
      },
    };
  }
}

/**
 * The outcome a claim may record. On a redispatch nothing short of a
 * confirmed send proves the earlier provider request failed.
 */
export function appointmentReminderResultForClaim(
  claim: Pick<AppointmentReminderClaim, "redispatch">,
  result: "sent" | "failed" | "unknown",
): "sent" | "failed" | "unknown" {
  return result === "failed" && claim.redispatch ? "unknown" : result;
}

/**
 * The definite-failure marker for a reminder whose SMS the provider (or an
 * operator reconciliation) confirmed failed, so it can be retried once. Null
 * for communications that are not retry-tracked reminders.
 */
export function definiteReminderFailureOutcomeSql() {
  return sql`case
    when ${communications.reminderAttempt} is null then null
    when ${communications.subject} = ${AUTOMATED_APPOINTMENT_REMINDER_SUBJECT} then 'automated_failure'
    else 'staff_failure'
  end`;
}

/**
 * Move a claimed SMS reminder to its email fallback before the email provider
 * is called. If the process dies mid-send, the row is then an abandoned email
 * claim (reclaimed under the same email key, or shown as "Delivery unknown")
 * rather than an SMS row stuck as "Pending".
 */
export async function switchAppointmentReminderClaimToEmail(
  db: Pick<Database, "update">,
  options: { practiceId: string; claim: AppointmentReminderClaim },
): Promise<boolean> {
  const [row] = await db
    .update(communications)
    .set({ channel: "email", updatedAt: sql`now()` })
    .where(
      and(
        eq(communications.id, options.claim.id),
        eq(communications.practiceId, options.practiceId),
        eq(communications.status, "pending"),
        isNull(communications.reminderOutcome),
        eq(communications.reminderClaimToken, options.claim.claimToken),
        isNull(communications.deletedAt),
      ),
    )
    .returning({ id: communications.id });
  return Boolean(row);
}

/**
 * Record how a claimed reminder ended. Only this claim's pending row (or the
 * same accepted provider message) is updated, so a late or duplicate
 * projection can never turn a sent reminder into a failed one, and a claimant
 * that was overtaken can't overwrite the claim that replaced it.
 *
 * - `sent`: the provider accepted the message.
 * - `failed`: a definite failure; the reminder may be retried. On a
 *   redispatch this is recorded as `unknown` instead (see
 *   AppointmentReminderClaim.redispatch); callers should build their content
 *   from appointmentReminderResultForClaim.
 * - `unknown`: the provider may have delivered it. The row stays pending with
 *   `reminder_outcome = 'outcome_unknown'` and shows as "Delivery unknown". An
 *   email may be resent under the same key while it is honored; nothing is
 *   ever resent under a new key.
 */
export async function recordAppointmentReminderOutcome(
  db: Pick<Database, "update">,
  options: {
    practiceId: string;
    claim: AppointmentReminderClaim;
    channel: "sms" | "email";
    result: "sent" | "failed" | "unknown";
    source: "staff" | "automated";
    content: string;
    providerMessageId?: string;
  },
) {
  const result = appointmentReminderResultForClaim(
    options.claim,
    options.result,
  );
  const sentRowMatches =
    result === "sent" && options.providerMessageId
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
        result === "sent"
          ? "sent"
          : result === "failed"
            ? "failed"
            : "pending",
      providerMessageId: options.providerMessageId ?? null,
      reminderOutcome:
        result === "sent"
          ? null
          : result === "unknown"
            ? "outcome_unknown"
            : options.source === "automated"
              ? "automated_failure"
              : "staff_failure",
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(communications.id, options.claim.id),
        eq(communications.practiceId, options.practiceId),
        isNull(communications.deletedAt),
        or(
          and(
            eq(communications.status, "pending"),
            eq(communications.reminderClaimToken, options.claim.claimToken),
          ),
          sentRowMatches,
        ),
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
  if (row?.status === "sent" || row?.status === "delivered" || row?.status === "read") {
    return "A reminder for this appointment was already sent.";
  }
  if (row?.status === "pending" && row.reminderOutcome === "outcome_unknown") {
    return "The last reminder for this appointment may have been delivered, but the provider never confirmed it. To avoid a duplicate, it can't be sent again. Contact the client directly if needed.";
  }
  if (row?.status === "failed") {
    return "An earlier reminder for this appointment failed and can't be retried automatically. Contact the client directly.";
  }
  return "A reminder for this appointment is already pending or was already sent.";
}
