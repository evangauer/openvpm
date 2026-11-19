import { TRPCError } from "@trpc/server";
import { and, asc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Database } from "@openpims/db/client";
import {
  careReminders,
  clients,
  communications,
  emailSuppressions,
  locationMessaging,
  locations,
  patients,
  practices,
  smsSuppressions,
} from "@openpims/db";
import { sendCareReminder } from "@/lib/email";
import { sendCareReminderSms } from "@/lib/sms";
import {
  emailSuppressionSendBlockMessage,
  normalizeEmailSuppressionAddress,
} from "@/lib/email-suppression";
import { assertOutboundEmailAllowed } from "@/lib/outbound-email-security";
import { hasNonBlankMessagingSender } from "@/lib/messaging/sender-query";
import { normalizeE164 } from "@/lib/messaging/phone";
import {
  recoverStaleUnreservedSmsCommunication,
  STALE_SMS_COMMUNICATION_CLAIM_MS,
  withDurableSmsCommunication,
} from "@/lib/messaging/durable-sms-communication";
import {
  lockPracticeForExternalSideEffects,
  RECOVERY_HOLD_BLOCK_MESSAGE,
} from "@/lib/recovery-hold";
import { recordAuditLog } from "@/lib/audit";
import {
  rateLimit,
} from "@/lib/rate-limit";
import { formatDateInputForTimeZone } from "@/lib/date-input";
import { vaccinationRecallPracticeSettings } from "@/lib/vaccination-recalls";
import {
  bulkCareReminderRequestId,
  careReminderBulkBatchesPerHour,
  careReminderBulkMaxBatch,
  careReminderBulkRateLimitKey,
  careReminderBulkRateLimitWindowMs,
  CARE_REMINDER_BULK_PREVIEW_CAP,
  careReminderOutreachCopy,
  careReminderOutreachDedupeKey,
  careReminderQuietHours,
  evaluateCareReminderOutreach,
  reminderMatchesBulkFilters,
  type BulkOutreachFilters,
  type CareReminderOutreachCandidate,
  type CareReminderOutreachChannel,
  type CareReminderOutreachDecision,
} from "@/lib/care-reminder-outreach";

const LIVE_OUTREACH_STATUSES = ["pending", "sent", "delivered", "read"] as const;

export type CareReminderOutreachContext = {
  db: Database;
  practiceId: string;
  user: {
    id: string;
    practiceCreatedAt?: Date | string | null;
    emailVerifiedAt?: Date | string | null;
    practiceInPreview?: boolean;
  };
  ip?: string | null;
};

type BlockCode = "BAD_REQUEST" | "PRECONDITION_FAILED" | "NOT_FOUND";

type DispatchOutcome =
  | {
      kind: "sent";
      channel: CareReminderOutreachChannel;
      replayed: boolean;
    }
  | { kind: "deduped" }
  | { kind: "blocked"; code: BlockCode; message: string }
  | { kind: "failed"; message: string };

type LoadedReminder = {
  id: string;
  practiceId: string;
  title: string;
  dueDate: string;
  status: "open" | "completed" | "dismissed";
  imported: boolean;
  patientName: string;
  patientStatus: "active" | "inactive" | "deceased";
  species: string;
  patientId: string;
  clientId: string;
  clientFirstName: string | null;
  clientLastName: string | null;
  clientEmail: string | null;
  clientPhone: string | null;
  preferredContactMethod: string | null;
  clientSmsConsent: boolean;
  emailSuppressionReason: string | null;
  lastContactedAt: Date | null;
  practiceName: string;
  practicePhone: string | null;
  practiceAddress: string | null;
  practiceTimezone: string | null;
};

type PracticeSnapshot = {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
  timezone: string | null;
  settings: unknown;
};

function clientNameOf(reminder: Pick<LoadedReminder, "clientFirstName" | "clientLastName">): string {
  return (
    [reminder.clientFirstName, reminder.clientLastName].filter(Boolean).join(" ") ||
    "Client"
  );
}

function asDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function lastOutboundAt(practiceId: string) {
  return sql`(
    select max(${communications.createdAt})
    from ${communications}
    where ${communications.practiceId} = ${practiceId}
      and ${communications.clientId} = ${clients.id}
      and ${communications.direction} = 'outbound'
      and ${communications.status} in ('sent', 'delivered', 'read')
      and ${communications.deletedAt} is null
  )`;
}

async function activeCareReminderSmsSender(
  db: Pick<Database, "select">,
  practiceId: string,
): Promise<{ locationId: string } | null> {
  const senders = await db
    .select({ locationId: locationMessaging.locationId })
    .from(locationMessaging)
    .innerJoin(
      locations,
      and(
        eq(locations.id, locationMessaging.locationId),
        eq(locations.practiceId, practiceId),
        isNull(locations.deletedAt),
      ),
    )
    .where(
      and(
        eq(locationMessaging.practiceId, practiceId),
        isNull(locationMessaging.deletedAt),
        eq(locationMessaging.enabled, true),
        eq(locationMessaging.registrationStatus, "active"),
        hasNonBlankMessagingSender(),
      ),
    )
    .limit(2);
  return senders.length === 1 ? senders[0]! : null;
}

async function loadPractice(
  db: Pick<Database, "select">,
  practiceId: string,
): Promise<PracticeSnapshot | null> {
  const [practice] = await db
    .select({
      id: practices.id,
      name: practices.name,
      phone: practices.phone,
      address: practices.address,
      timezone: practices.timezone,
      settings: practices.settings,
    })
    .from(practices)
    .where(and(eq(practices.id, practiceId), isNull(practices.deletedAt)))
    .limit(1);
  return practice ?? null;
}

async function loadReminderRows(
  db: Pick<Database, "select">,
  practiceId: string,
  practice: PracticeSnapshot,
  options: {
    filters: BulkOutreachFilters;
    reminderIds?: string[];
    limit: number;
  },
): Promise<LoadedReminder[]> {
  const today = formatDateInputForTimeZone(new Date(), practice.timezone);
  const timeZone = practice.timezone?.trim() || "UTC";
  const title = options.filters.title?.trim().toLowerCase();
  const conditions = [
    eq(careReminders.practiceId, practiceId),
    eq(careReminders.status, "open"),
    isNull(careReminders.deletedAt),
    eq(patients.practiceId, practiceId),
    isNull(patients.deletedAt),
    eq(clients.practiceId, practiceId),
    isNull(clients.deletedAt),
  ];
  if (options.reminderIds) {
    if (options.reminderIds.length === 0) return [];
    conditions.push(inArray(careReminders.id, options.reminderIds));
  }
  if (options.filters.due === "overdue") {
    conditions.push(lte(careReminders.dueDate, today));
  }
  if (
    options.filters.due === "range" &&
    options.filters.dueFrom &&
    options.filters.dueTo
  ) {
    conditions.push(gte(careReminders.dueDate, options.filters.dueFrom));
    conditions.push(lte(careReminders.dueDate, options.filters.dueTo));
  }
  if (title) {
    conditions.push(
      sql`position(${title} in lower(${careReminders.title})) > 0`,
    );
  }
  if (options.filters.species) {
    conditions.push(eq(patients.species, options.filters.species));
  }
  if (options.filters.lastContacted === "never") {
    conditions.push(sql`${lastOutboundAt(practiceId)} is null`);
  }
  if (
    options.filters.lastContacted === "before" &&
    options.filters.lastContactedBefore
  ) {
    conditions.push(sql`(
      ${lastOutboundAt(practiceId)} is null
      or to_char(${lastOutboundAt(practiceId)} at time zone ${timeZone}, 'YYYY-MM-DD') < ${options.filters.lastContactedBefore}
    )`);
  }

  const rows = await db
    .select({
      id: careReminders.id,
      practiceId: careReminders.practiceId,
      title: careReminders.title,
      dueDate: careReminders.dueDate,
      status: careReminders.status,
      imported: sql<boolean>`${careReminders.externalSource} is not null`,
      patientName: patients.name,
      patientStatus: patients.status,
      species: patients.species,
      patientId: patients.id,
      clientId: clients.id,
      clientFirstName: clients.firstName,
      clientLastName: clients.lastName,
      clientEmail: clients.email,
      clientPhone: clients.phone,
      preferredContactMethod: clients.preferredContactMethod,
      clientSmsConsent: clients.smsConsent,
      emailSuppressionReason: emailSuppressions.reason,
      lastContactedAt: sql<Date | null>`${lastOutboundAt(practiceId)}`,
    })
    .from(careReminders)
    .innerJoin(
      patients,
      and(
        eq(careReminders.patientId, patients.id),
        eq(patients.practiceId, practiceId),
        isNull(patients.deletedAt),
      ),
    )
    .innerJoin(
      clients,
      and(
        eq(patients.clientId, clients.id),
        eq(clients.practiceId, practiceId),
        isNull(clients.deletedAt),
      ),
    )
    .leftJoin(
      emailSuppressions,
      and(
        eq(emailSuppressions.practiceId, practiceId),
        sql`${emailSuppressions.email} = lower(trim(${clients.email}))`,
        isNull(emailSuppressions.deletedAt),
      ),
    )
    .where(and(...conditions))
    .orderBy(asc(careReminders.dueDate), asc(careReminders.id))
    .limit(options.limit);

  return rows
    .filter((row) => row.practiceId === practiceId)
    .filter((row) =>
      reminderMatchesBulkFilters(
        {
          dueDate: row.dueDate,
          title: row.title,
          species: row.species,
          lastContactedAt: asDate(row.lastContactedAt),
        },
        options.filters,
        today,
        practice.timezone,
      ),
    )
    .map((row) => ({
      ...row,
      imported: Boolean(row.imported),
      clientSmsConsent: row.clientSmsConsent === true,
      lastContactedAt: asDate(row.lastContactedAt),
      practiceName: practice.name,
      practicePhone: practice.phone,
      practiceAddress: practice.address,
      practiceTimezone: practice.timezone,
    }));
}

function toCandidate(reminder: LoadedReminder): CareReminderOutreachCandidate {
  return {
    reminderId: reminder.id,
    practiceId: reminder.practiceId,
    status: reminder.status,
    title: reminder.title,
    dueDate: reminder.dueDate,
    imported: reminder.imported,
    patientId: reminder.patientId,
    patientName: reminder.patientName,
    patientStatus: reminder.patientStatus,
    species: reminder.species,
    clientId: reminder.clientId,
    clientName: clientNameOf(reminder),
    clientEmail: reminder.clientEmail,
    clientPhone: reminder.clientPhone,
    preferredContactMethod: reminder.preferredContactMethod,
    smsConsent: reminder.clientSmsConsent === true,
    emailSuppressionReason: reminder.emailSuppressionReason,
    lastContactedAt: reminder.lastContactedAt,
  };
}

type PriorSend = {
  dedupeKey: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  channel: string;
  hasSmsAttempt: boolean;
};

async function loadPriorSends(
  db: Pick<Database, "select">,
  practiceId: string,
  keys: string[],
): Promise<PriorSend[]> {
  if (keys.length === 0) return [];
  const rows = await db
    .select({
      dedupeKey: communications.dedupeKey,
      status: communications.status,
      createdAt: communications.createdAt,
      updatedAt: communications.updatedAt,
      channel: communications.channel,
      hasSmsAttempt: sql<boolean>`exists (
        select 1
        from sms_send_attempts outreach_attempt
        where outreach_attempt.practice_id = ${communications.practiceId}
          and outreach_attempt.communication_id = ${communications.id}
      )`,
    })
    .from(communications)
    .where(
      and(
        eq(communications.practiceId, practiceId),
        inArray(communications.dedupeKey, keys),
        inArray(communications.status, [...LIVE_OUTREACH_STATUSES]),
        isNull(communications.deletedAt),
      ),
    );
  return rows;
}

function priorStillBlocks(row: PriorSend, now: Date): boolean {
  const updatedAt = asDate(row.updatedAt) ?? asDate(row.createdAt) ?? now;
  const recoverable =
    row.channel === "sms" &&
    row.status === "pending" &&
    updatedAt.getTime() <= now.getTime() - STALE_SMS_COMMUNICATION_CLAIM_MS &&
    !row.hasSmsAttempt;
  return !recoverable;
}

async function loadSuppressedPhones(
  db: Pick<Database, "select">,
  practiceId: string,
): Promise<Set<string>> {
  const rows = await db
    .select({ phone: smsSuppressions.phone })
    .from(smsSuppressions)
    .where(
      and(
        eq(smsSuppressions.practiceId, practiceId),
        isNull(smsSuppressions.deletedAt),
      ),
    );
  return new Set(
    rows
      .map((row) => normalizeE164(row.phone))
      .filter((phone): phone is string => Boolean(phone)),
  );
}

type OutreachSnapshot = {
  practice: PracticeSnapshot;
  reminders: LoadedReminder[];
  decisions: Array<{
    reminder: LoadedReminder;
    decision: CareReminderOutreachDecision;
  }>;
  smsSender: { locationId: string } | null;
  truncated: boolean;
};

async function loadOutreachSnapshot(
  db: Pick<Database, "select">,
  practiceId: string,
  options: {
    filters: BulkOutreachFilters;
    reminderIds?: string[];
    limit: number;
  },
  now = new Date(),
): Promise<OutreachSnapshot | null> {
  const practice = await loadPractice(db, practiceId);
  if (!practice) return null;
  const fetched = await loadReminderRows(db, practiceId, practice, {
    ...options,
    limit: options.limit + 1,
  });
  const truncated = fetched.length > options.limit;
  const reminders = fetched.slice(0, options.limit);
  const smsSender = await activeCareReminderSmsSender(db, practiceId);
  const suppressedPhones = await loadSuppressedPhones(db, practiceId);
  const settings = vaccinationRecallPracticeSettings(practice.settings);
  const quietHours = careReminderQuietHours(now, practice.timezone);
  const provisional = reminders.map((reminder) => ({
    reminder,
    decision: evaluateCareReminderOutreach({
      practiceId,
      candidate: toCandidate(reminder),
      channelPreference: options.filters.channel,
      quietHours,
      smsSenderAvailable: Boolean(smsSender),
      smsSuppressedPhones: suppressedPhones,
      practiceSettings: settings,
    }),
  }));
  const keys = provisional.flatMap((item) =>
    item.decision.dedupeKey ? [item.decision.dedupeKey] : [],
  );
  const priors = await loadPriorSends(db, practiceId, keys);
  const priorByKey = new Map(
    priors.flatMap((row) =>
      row.dedupeKey && priorStillBlocks(row, now)
        ? [[row.dedupeKey, row] as const]
        : [],
    ),
  );
  const decisions = provisional.map((item) => {
    const prior = item.decision.dedupeKey
      ? priorByKey.get(item.decision.dedupeKey)
      : undefined;
    if (!prior || item.decision.status === "blocked") return item;
    return {
      reminder: item.reminder,
      decision: evaluateCareReminderOutreach({
        practiceId,
        candidate: toCandidate(item.reminder),
        channelPreference: options.filters.channel,
        quietHours,
        smsSenderAvailable: Boolean(smsSender),
        smsSuppressedPhones: suppressedPhones,
        practiceSettings: settings,
        existingSend: {
          status: prior.status,
          createdAt: asDate(prior.createdAt) ?? now,
        },
      }),
    };
  });
  return { practice, reminders, decisions, smsSender, truncated };
}

function deny(
  onBlock: "throw" | "return",
  code: BlockCode,
  message: string,
): DispatchOutcome {
  if (onBlock === "return") return { kind: "blocked", code, message };
  throw new TRPCError({ code, message });
}

/**
 * Deliver one care reminder that has already been loaded for this clinic.
 * Single sends throw on a block. Bulk sends collect the same block instead.
 */
export async function dispatchCareReminderOutreach(
  db: Database,
  ctx: CareReminderOutreachContext,
  reminder: LoadedReminder,
  input: {
    channel: CareReminderOutreachChannel;
    requestId: string;
    onBlock?: "throw" | "return";
    releaseDedupeOnFailure?: boolean;
    allowStaleSmsRecovery?: boolean;
    smsSender?: { locationId: string } | null;
  },
): Promise<DispatchOutcome> {
  const onBlock = input.onBlock ?? "throw";
  if (reminder.practiceId !== ctx.practiceId) {
    return deny(onBlock, "NOT_FOUND", "Care reminder not found");
  }
  if (reminder.status !== "open") {
    return deny(
      onBlock,
      "PRECONDITION_FAILED",
      "Only open care reminders can be sent to a client.",
    );
  }

  const clientName = clientNameOf(reminder);
  const copy = careReminderOutreachCopy({
    clientName,
    patientName: reminder.patientName,
    title: reminder.title,
    dueDate: reminder.dueDate,
    timeZone: reminder.practiceTimezone,
  });
  const subject = input.channel === "email" ? copy.subject : null;
  const content = copy.content;
  const dedupeKey = careReminderOutreachDedupeKey(
    ctx.practiceId,
    input.channel,
    input.requestId,
  );

  let email: string | null = null;
  let smsSender = input.smsSender ?? null;
  if (input.channel === "email") {
    email = normalizeEmailSuppressionAddress(reminder.clientEmail);
    if (!email) {
      return deny(
        onBlock,
        "BAD_REQUEST",
        "Client does not have an email address on file",
      );
    }
    if (reminder.emailSuppressionReason) {
      return deny(
        onBlock,
        "BAD_REQUEST",
        emailSuppressionSendBlockMessage(reminder.emailSuppressionReason),
      );
    }
    await assertOutboundEmailAllowed({
      practiceId: ctx.practiceId,
      practiceCreatedAt: ctx.user.practiceCreatedAt,
      userId: ctx.user.id,
      userEmailVerifiedAt: ctx.user.emailVerifiedAt,
      practiceInPreview: ctx.user.practiceInPreview,
      ip: ctx.ip,
      operation: "care_reminder",
    });
  } else if (reminder.clientSmsConsent !== true || !reminder.clientPhone) {
    return deny(
      onBlock,
      "BAD_REQUEST",
      "Client does not have an SMS-consented phone number on file",
    );
  } else if (careReminderQuietHours(new Date(), reminder.practiceTimezone)) {
    return deny(
      onBlock,
      "PRECONDITION_FAILED",
      "SMS reminders cannot be sent during quiet hours (9 PM–8 AM local time). Try again after 8 AM.",
    );
  } else {
    if (input.smsSender === undefined) {
      smsSender = await activeCareReminderSmsSender(db, ctx.practiceId);
    }
    if (!smsSender) {
      return deny(
        onBlock,
        "BAD_REQUEST",
        "Set up exactly one active clinic texting number before sending care reminders by SMS",
      );
    }
  }

  const insertCommunication = async (
    database: Pick<Database, "insert" | "select" | "update">,
  ) => {
    const [inserted] = await database
      .insert(communications)
      .values({
        practiceId: ctx.practiceId,
        clientId: reminder.clientId,
        channel: input.channel,
        direction: "outbound",
        subject,
        content,
        status: "pending",
        dedupeKey,
      })
      .onConflictDoNothing({ target: communications.dedupeKey })
      .returning();
    if (inserted) return { communication: inserted, replayed: false };
    if (input.channel === "sms" && input.allowStaleSmsRecovery) {
      const recoveredId = await recoverStaleUnreservedSmsCommunication(
        database,
        { practiceId: ctx.practiceId, dedupeKey },
      );
      if (recoveredId) {
        const [recovered] = await database
          .select()
          .from(communications)
          .where(
            and(
              eq(communications.id, recoveredId),
              eq(communications.practiceId, ctx.practiceId),
              isNull(communications.deletedAt),
            ),
          )
          .limit(1);
        if (recovered) return { communication: recovered, replayed: false };
      }
    }

    const [existing] = await database
      .select()
      .from(communications)
      .where(
        and(
          eq(communications.practiceId, ctx.practiceId),
          eq(communications.dedupeKey, dedupeKey),
          eq(communications.clientId, reminder.clientId),
          eq(communications.channel, input.channel),
          eq(communications.direction, "outbound"),
          isNull(communications.deletedAt),
        ),
      )
      .limit(1);
    if (!existing) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "Reminder request ID is already in use.",
      });
    }
    if (
      existing.content !== content ||
      (existing.subject ?? null) !== subject
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "Reminder request ID was already used for different reminder data.",
      });
    }
    return { communication: existing, replayed: true };
  };

  const durableSms = input.channel === "sms";
  const claim = durableSms
    ? await withDurableSmsCommunication(ctx.practiceId, insertCommunication)
    : await insertCommunication(db);
  const communication = claim.communication;
  if (
    claim.replayed &&
    new Set(["sent", "delivered", "read"]).has(communication.status)
  ) {
    return { kind: "sent", channel: input.channel, replayed: true };
  }
  if (claim.replayed) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        communication.status === "failed"
          ? "This reminder delivery failed. Start a new send to retry it."
          : "This reminder delivery is already being processed.",
    });
  }

  const result =
    input.channel === "email"
      ? await sendCareReminder({
          to: email!,
          clientName,
          patientName: reminder.patientName,
          reminderTitle: reminder.title,
          dueDate: copy.dueLabel,
          practiceName: reminder.practiceName,
          practicePhone: reminder.practicePhone ?? undefined,
          practiceAddress: reminder.practiceAddress ?? undefined,
          idempotencyKey: dedupeKey,
        })
      : await sendCareReminderSms({
          to: reminder.clientPhone!,
          patientName: reminder.patientName,
          reminderTitle: reminder.title,
          dueDate: copy.dueLabel,
          practiceName: reminder.practiceName,
          practicePhone: reminder.practicePhone ?? undefined,
          practiceId: ctx.practiceId,
          locationId: smsSender!.locationId,
          clientId: reminder.clientId,
          communicationId: communication.id,
          sourceId: reminder.id,
          idempotencyKey: dedupeKey,
        });

  if (
    input.channel === "sms" &&
    !result.success &&
    "outcome" in result &&
    result.outcome === "outcome_unknown"
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "The texting provider outcome is unknown. Do not resend until support confirms the outcome.",
    });
  }

  const project = (database: Pick<Database, "update">) =>
    database
      .update(communications)
      .set({
        status: result.success ? "sent" : "failed",
        dedupeKey:
          !result.success && input.releaseDedupeOnFailure ? null : undefined,
        providerMessageId: result.success
          ? "sid" in result
            ? result.sid
            : result.id
          : undefined,
      })
      .where(
        and(
          eq(communications.id, communication.id),
          eq(communications.practiceId, ctx.practiceId),
          eq(communications.status, "pending"),
          isNull(communications.deletedAt),
        ),
      );
  if (durableSms) {
    await withDurableSmsCommunication(ctx.practiceId, project);
  } else {
    await project(db);
  }
  if (!result.success) {
    return {
      kind: "failed",
      message: result.error ?? "Could not send care reminder",
    };
  }
  return { kind: "sent", channel: input.channel, replayed: false };
}

async function loadOneReminder(
  db: Pick<Database, "select">,
  practiceId: string,
  reminderId: string,
): Promise<LoadedReminder | null> {
  const practice = await loadPractice(db, practiceId);
  if (!practice) return null;
  const [row] = await db
    .select({
      id: careReminders.id,
      practiceId: careReminders.practiceId,
      title: careReminders.title,
      dueDate: careReminders.dueDate,
      status: careReminders.status,
      imported: sql<boolean>`${careReminders.externalSource} is not null`,
      patientName: patients.name,
      patientStatus: patients.status,
      species: patients.species,
      patientId: patients.id,
      clientId: clients.id,
      clientFirstName: clients.firstName,
      clientLastName: clients.lastName,
      clientEmail: clients.email,
      clientPhone: clients.phone,
      preferredContactMethod: clients.preferredContactMethod,
      clientSmsConsent: clients.smsConsent,
      emailSuppressionReason: emailSuppressions.reason,
      lastContactedAt: sql<Date | null>`${lastOutboundAt(practiceId)}`,
    })
    .from(careReminders)
    .innerJoin(
      patients,
      and(
        eq(careReminders.patientId, patients.id),
        eq(patients.practiceId, practiceId),
        isNull(patients.deletedAt),
      ),
    )
    .innerJoin(
      clients,
      and(
        eq(patients.clientId, clients.id),
        eq(clients.practiceId, practiceId),
        isNull(clients.deletedAt),
      ),
    )
    .leftJoin(
      emailSuppressions,
      and(
        eq(emailSuppressions.practiceId, practiceId),
        sql`${emailSuppressions.email} = lower(trim(${clients.email}))`,
        isNull(emailSuppressions.deletedAt),
      ),
    )
    .where(
      and(
        eq(careReminders.id, reminderId),
        eq(careReminders.practiceId, practiceId),
        isNull(careReminders.deletedAt),
      ),
    )
    .limit(1);
  if (!row || row.practiceId !== practiceId) return null;
  return {
    ...row,
    imported: Boolean(row.imported),
    clientSmsConsent: row.clientSmsConsent === true,
    lastContactedAt: asDate(row.lastContactedAt),
    practiceName: practice.name,
    practicePhone: practice.phone,
    practiceAddress: practice.address,
    practiceTimezone: practice.timezone,
  };
}

/** Staff send for one reminder. The request id makes a repeated click a replay. */
export async function deliverCareReminderOutreach(
  ctx: CareReminderOutreachContext,
  input: {
    reminderId: string;
    channel: CareReminderOutreachChannel;
    requestId: string;
  },
) {
  const outcome = await ctx.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    if (!(await lockPracticeForExternalSideEffects(db, ctx.practiceId))) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: RECOVERY_HOLD_BLOCK_MESSAGE,
      });
    }
    const reminder = await loadOneReminder(db, ctx.practiceId, input.reminderId);
    if (!reminder) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Care reminder not found",
      });
    }
    return dispatchCareReminderOutreach(db, ctx, reminder, {
      channel: input.channel,
      requestId: input.requestId,
      onBlock: "throw",
    });
  });
  if (outcome.kind === "failed") {
    throw new TRPCError({ code: "BAD_REQUEST", message: outcome.message });
  }
  if (outcome.kind === "blocked") {
    throw new TRPCError({ code: outcome.code, message: outcome.message });
  }
  if (outcome.kind === "deduped") {
    return { success: true as const, channel: input.channel, replayed: true };
  }
  return {
    success: true as const,
    channel: outcome.channel,
    replayed: outcome.replayed,
  };
}

export type BulkOutreachPreview = {
  generatedAt: Date;
  today: string;
  maxBatch: number;
  batchesPerHour: number;
  truncated: boolean;
  total: number;
  eligible: number;
  blocked: number;
  alreadySent: number;
  recipients: Array<{
    reminderId: string;
    patientId: string;
    patientName: string;
    species: string;
    clientName: string;
    title: string;
    dueDate: string;
    imported: boolean;
    lastContactedAt: Date | null;
    status: CareReminderOutreachDecision["status"];
    channel: CareReminderOutreachChannel | null;
    blockReason: CareReminderOutreachDecision["blockReason"];
    blockMessage: string | null;
  }>;
};

export async function previewBulkCareReminderOutreach(
  ctx: CareReminderOutreachContext,
  filters: BulkOutreachFilters,
): Promise<BulkOutreachPreview | null> {
  const snapshot = await loadOutreachSnapshot(ctx.db, ctx.practiceId, {
    filters,
    limit: CARE_REMINDER_BULK_PREVIEW_CAP,
  });
  if (!snapshot) return null;
  const recipients = snapshot.decisions.map((item) => ({
    reminderId: item.reminder.id,
    patientId: item.reminder.patientId,
    patientName: item.reminder.patientName,
    species: item.reminder.species,
    clientName: clientNameOf(item.reminder),
    title: item.reminder.title,
    dueDate: item.reminder.dueDate,
    imported: item.reminder.imported === true,
    lastContactedAt: item.reminder.lastContactedAt,
    status: item.decision.status,
    channel: item.decision.channel,
    blockReason: item.decision.blockReason,
    blockMessage: item.decision.blockMessage,
  }));
  return {
    generatedAt: new Date(),
    today: formatDateInputForTimeZone(new Date(), snapshot.practice.timezone),
    maxBatch: careReminderBulkMaxBatch(),
    batchesPerHour: careReminderBulkBatchesPerHour(),
    truncated: snapshot.truncated,
    total: recipients.length,
    eligible: recipients.filter((item) => item.status === "eligible").length,
    blocked: recipients.filter((item) => item.status === "blocked").length,
    alreadySent: recipients.filter((item) => item.status === "already_sent")
      .length,
    recipients,
  };
}

export type BulkOutreachResult = {
  sent: number;
  failed: number;
  blocked: number;
  deduped: number;
};

function countDecision(decision: CareReminderOutreachDecision): {
  blocked: number;
  deduped: number;
} {
  return {
    blocked: decision.status === "blocked" ? 1 : 0,
    deduped: decision.status === "already_sent" ? 1 : 0,
  };
}

export async function sendBulkCareReminderOutreach(
  ctx: CareReminderOutreachContext,
  input: {
    filters: BulkOutreachFilters;
    selectAllMatching?: boolean;
    reminderIds?: string[];
  },
): Promise<BulkOutreachResult> {
  const maxBatch = careReminderBulkMaxBatch();
  const reminderIds = [...new Set(input.reminderIds ?? [])];
  if (!input.selectAllMatching && reminderIds.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Choose at least one care reminder.",
    });
  }
  if (reminderIds.length > maxBatch) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Care reminders can target at most ${maxBatch} clients in one send.`,
    });
  }

  const allowance = await rateLimit({
    key: careReminderBulkRateLimitKey(ctx.practiceId),
    limit: careReminderBulkBatchesPerHour(),
    windowMs: careReminderBulkRateLimitWindowMs(),
  });
  if (!allowance.success) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message:
        "This clinic has reached the care-reminder outreach limit for this hour. Try again later.",
    });
  }

  const result = await ctx.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    if (!(await lockPracticeForExternalSideEffects(db, ctx.practiceId))) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: RECOVERY_HOLD_BLOCK_MESSAGE,
      });
    }
    const snapshot = await loadOutreachSnapshot(db, ctx.practiceId, {
      filters: input.filters,
      reminderIds: input.selectAllMatching ? undefined : reminderIds,
      limit: input.selectAllMatching
        ? CARE_REMINDER_BULK_PREVIEW_CAP
        : Math.max(reminderIds.length, 1),
    });
    if (!snapshot) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Practice not found" });
    }

    const found = new Set(snapshot.decisions.map((item) => item.reminder.id));
    let blocked = input.selectAllMatching
      ? 0
      : reminderIds.filter((id) => !found.has(id)).length;
    let deduped = 0;
    for (const item of snapshot.decisions) {
      const counted = countDecision(item.decision);
      blocked += counted.blocked;
      deduped += counted.deduped;
    }
    const queue = snapshot.decisions
      .filter((item) => item.decision.status === "eligible" && item.decision.channel)
      .slice(0, maxBatch);

    let sent = 0;
    let failed = 0;
    for (const item of queue) {
      const channel = item.decision.channel!;
      const copy = careReminderOutreachCopy({
        clientName: clientNameOf(item.reminder),
        patientName: item.reminder.patientName,
        title: item.reminder.title,
        dueDate: item.reminder.dueDate,
        timeZone: item.reminder.practiceTimezone,
      });
      const requestId = bulkCareReminderRequestId({
        reminderId: item.reminder.id,
        channel,
        subject: channel === "email" ? copy.subject : null,
        content: copy.content,
      });
      try {
        const outcome = await dispatchCareReminderOutreach(
          db,
          ctx,
          item.reminder,
          {
            channel,
            requestId,
            onBlock: "return",
            releaseDedupeOnFailure: true,
            allowStaleSmsRecovery: true,
            smsSender: snapshot.smsSender,
          },
        );
        if (outcome.kind === "sent") {
          if (outcome.replayed) deduped += 1;
          else sent += 1;
        } else if (outcome.kind === "deduped") deduped += 1;
        else if (outcome.kind === "blocked") blocked += 1;
        else failed += 1;
      } catch (error) {
        if (
          error instanceof TRPCError &&
          (error.code === "FORBIDDEN" ||
            error.code === "PRECONDITION_FAILED" ||
            error.message === RECOVERY_HOLD_BLOCK_MESSAGE)
        ) {
          throw error;
        }
        if (
          error instanceof TRPCError &&
          error.code === "CONFLICT" &&
          /already sent|already being processed|already in use|different reminder data/i.test(
            error.message,
          )
        ) {
          deduped += 1;
          continue;
        }
        failed += 1;
      }
    }

    await recordAuditLog(db, {
      practiceId: ctx.practiceId,
      userId: ctx.user.id,
      ip: ctx.ip,
      path: "careReminders.bulkOutreach",
      rawInput: {
        selectAllMatching: Boolean(input.selectAllMatching),
        filters: input.filters,
        requested: input.selectAllMatching
          ? snapshot.decisions.length
          : reminderIds.length,
        maxBatch,
      },
      resultData: { sent, failed, blocked, deduped },
    });
    return { sent, failed, blocked, deduped };
  });
  return result;
}

