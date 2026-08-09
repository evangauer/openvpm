import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Database } from "@openpims/db/client";
import {
  clients,
  communications,
  emailSuppressions,
  locationMessaging,
  locations,
  patients,
  practices,
  smsSuppressions,
  vaccinationRecords,
} from "@openpims/db";
import { sendVaccinationReminder } from "@/lib/email";
import { normalizeEmailSuppressionAddress } from "@/lib/email-suppression";
import { formatDateInputForTimeZone } from "@/lib/date-input";
import { isQuietHours } from "@/lib/messaging/reminders";
import { normalizeE164 } from "@/lib/messaging/phone";
import { hasNonBlankMessagingSender } from "@/lib/messaging/sender-query";
import { formatClinicalDate } from "@/lib/records/clinical-dates";
import { sendVaccinationReminderSms } from "@/lib/sms";
import {
  evaluateVaccinationRecallRecipient,
  vaccinationRecallDedupeKey,
  vaccinationRecallPracticeSettings,
  type VaccinationRecallCandidate,
  type VaccinationRecallRecipient,
} from "@/lib/vaccination-recalls";

const DEFAULT_PRACTICE_NAME = "your clinic";

function activePracticePredicate(practiceId: string) {
  return sql`exists (
    select 1
    from ${practices}
    where ${practices.id} = ${practiceId}
      and ${practices.deletedAt} is null
  )`;
}

function latestVaccinationRecordPredicate() {
  return sql`not exists (
    select 1
    from vaccination_records as newer_vaccination
    where newer_vaccination.practice_id = ${vaccinationRecords.practiceId}
      and newer_vaccination.patient_id = ${vaccinationRecords.patientId}
      and newer_vaccination.deleted_at is null
      and not exists (
        select 1
        from clinical_record_corrections as newer_correction
        where newer_correction.practice_id = ${vaccinationRecords.practiceId}
          and newer_correction.vaccination_record_id = newer_vaccination.id
      )
      and lower(btrim(newer_vaccination.vaccine_name)) = lower(btrim(${vaccinationRecords.vaccineName}))
      and (
        newer_vaccination.administered_at > ${vaccinationRecords.administeredAt}
        or (
          newer_vaccination.administered_at = ${vaccinationRecords.administeredAt}
          and newer_vaccination.created_at > ${vaccinationRecords.createdAt}
        )
        or (
          newer_vaccination.administered_at = ${vaccinationRecords.administeredAt}
          and newer_vaccination.created_at = ${vaccinationRecords.createdAt}
          and newer_vaccination.id::text > ${vaccinationRecords.id}::text
        )
      )
  )`;
}

function validVaccinationRecordPredicate() {
  return sql`not exists (
    select 1
    from clinical_record_corrections as vaccination_correction
    where vaccination_correction.practice_id = ${vaccinationRecords.practiceId}
      and vaccination_correction.vaccination_record_id = ${vaccinationRecords.id}
  )`;
}

async function practiceNotificationSettings(ctx: {
  db: Database;
  practiceId: string;
}) {
  const [practice] = await ctx.db
    .select({
      name: practices.name,
      phone: practices.phone,
      timezone: practices.timezone,
      settings: practices.settings,
    })
    .from(practices)
    .where(
      and(
        eq(practices.id, ctx.practiceId),
        isNull(practices.deletedAt)
      )
    )
    .limit(1);
  if (!practice) return null;
  return {
    name: practice.name?.trim() || DEFAULT_PRACTICE_NAME,
    phone: practice.phone ?? null,
    timezone: practice.timezone ?? null,
    settings: practice.settings,
  };
}

async function activeReminderSmsSender(ctx: {
  db: Database;
  practiceId: string;
}) {
  const senders = await ctx.db
    .select({ locationId: locationMessaging.locationId })
    .from(locationMessaging)
    .innerJoin(
      locations,
      and(
        eq(locations.id, locationMessaging.locationId),
        eq(locations.practiceId, ctx.practiceId),
        activePracticePredicate(ctx.practiceId),
        isNull(locations.deletedAt)
      )
    )
    .where(
      and(
        eq(locationMessaging.practiceId, ctx.practiceId),
        activePracticePredicate(ctx.practiceId),
        isNull(locationMessaging.deletedAt),
        eq(locations.practiceId, ctx.practiceId),
        isNull(locations.deletedAt),
        eq(locationMessaging.enabled, true),
        eq(locationMessaging.registrationStatus, "active"),
        hasNonBlankMessagingSender()
      )
    )
    .limit(2);
  return senders.length === 1 ? senders[0]! : null;
}

type VaccinationRecallRow = {
  vaccinationRecordId: string;
  patientId: string;
  patientName: string;
  clientId: string;
  clientFirstName: string;
  clientLastName: string;
  clientEmail: string | null;
  clientPhone: string | null;
  preferredContactMethod: string | null;
  smsConsent: boolean | null;
  emailSuppressionReason: string | null;
  vaccineName: string;
  nextDueDate: string | null;
};

function groupRows(rows: VaccinationRecallRow[]): VaccinationRecallCandidate[] {
  const grouped = new Map<string, VaccinationRecallCandidate>();
  for (const row of rows) {
    if (!row.nextDueDate) continue;
    const vaccine = {
      recordId: row.vaccinationRecordId,
      vaccineName: row.vaccineName,
      nextDueDate: row.nextDueDate,
    };
    const existing = grouped.get(row.patientId);
    if (existing) {
      existing.vaccines.push(vaccine);
      continue;
    }
    grouped.set(row.patientId, {
      patientId: row.patientId,
      patientName: row.patientName,
      clientId: row.clientId,
      clientName: `${row.clientFirstName} ${row.clientLastName}`.trim(),
      clientEmail: row.clientEmail,
      clientPhone: row.clientPhone,
      preferredContactMethod: row.preferredContactMethod,
      smsConsent: row.smsConsent ?? false,
      emailSuppressionReason: row.emailSuppressionReason,
      vaccines: [vaccine],
    });
  }
  return Array.from(grouped.values()).map((candidate) => ({
    ...candidate,
    vaccines: candidate.vaccines.sort(
      (left, right) =>
        left.nextDueDate.localeCompare(right.nextDueDate) ||
        left.vaccineName.localeCompare(right.vaccineName)
    ),
  }));
}

export type VaccinationRecallPreview = {
  generatedAt: Date;
  total: number;
  eligible: number;
  blocked: number;
  alreadySent: number;
  recipients: VaccinationRecallRecipient[];
};

async function loadVaccinationRecallRecipients(
  ctx: { db: Database; practiceId: string },
  patientIds?: string[]
) {
  const practice = await practiceNotificationSettings(ctx);
  if (!practice) return null;
  const today = formatDateInputForTimeZone(new Date(), practice.timezone);
  const targetPredicate =
    patientIds && patientIds.length > 0
      ? inArray(patients.id, patientIds)
      : undefined;
  const rows = await ctx.db
    .select({
      vaccinationRecordId: vaccinationRecords.id,
      patientId: patients.id,
      patientName: patients.name,
      clientId: clients.id,
      clientFirstName: clients.firstName,
      clientLastName: clients.lastName,
      clientEmail: clients.email,
      clientPhone: clients.phone,
      preferredContactMethod: clients.preferredContactMethod,
      smsConsent: clients.smsConsent,
      emailSuppressionReason: emailSuppressions.reason,
      vaccineName: vaccinationRecords.vaccineName,
      nextDueDate: vaccinationRecords.nextDueDate,
    })
    .from(vaccinationRecords)
    .innerJoin(
      patients,
      and(
        eq(vaccinationRecords.patientId, patients.id),
        eq(patients.practiceId, ctx.practiceId),
        activePracticePredicate(ctx.practiceId),
        isNull(patients.deletedAt)
      )
    )
    .innerJoin(
      clients,
      and(
        eq(patients.clientId, clients.id),
        eq(clients.practiceId, ctx.practiceId),
        activePracticePredicate(ctx.practiceId),
        isNull(clients.deletedAt)
      )
    )
    .leftJoin(
      emailSuppressions,
      and(
        eq(emailSuppressions.practiceId, ctx.practiceId),
        sql`${emailSuppressions.email} = lower(trim(${clients.email}))`,
        isNull(emailSuppressions.deletedAt)
      )
    )
    .where(
      and(
        eq(vaccinationRecords.practiceId, ctx.practiceId),
        activePracticePredicate(ctx.practiceId),
        isNull(vaccinationRecords.deletedAt),
        eq(patients.practiceId, ctx.practiceId),
        eq(patients.status, "active"),
        isNull(patients.deletedAt),
        eq(clients.practiceId, ctx.practiceId),
        isNull(clients.deletedAt),
        targetPredicate,
        lt(vaccinationRecords.nextDueDate, today),
        validVaccinationRecordPredicate(),
        latestVaccinationRecordPredicate()
      )
    )
    .orderBy(patients.name, vaccinationRecords.nextDueDate);

  const candidates = groupRows(rows);
  const [smsSender, suppressedRows] = await Promise.all([
    activeReminderSmsSender(ctx),
    ctx.db
      .select({ phone: smsSuppressions.phone })
      .from(smsSuppressions)
      .where(
        and(
          eq(smsSuppressions.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(smsSuppressions.deletedAt)
        )
      ),
  ]);
  const smsSuppressedPhones = new Set(
    suppressedRows
      .map((row) => normalizeE164(row.phone))
      .filter((phone): phone is string => Boolean(phone))
  );
  const dedupeKeys = candidates.map((candidate) =>
    vaccinationRecallDedupeKey(ctx.practiceId, candidate)
  );
  const priorRows =
    dedupeKeys.length > 0
      ? await ctx.db
          .select({
            dedupeKey: communications.dedupeKey,
            createdAt: communications.createdAt,
          })
          .from(communications)
          .where(
            and(
              eq(communications.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              inArray(communications.dedupeKey, dedupeKeys),
              inArray(communications.status, [
                "pending",
                "sent",
                "delivered",
                "read",
              ]),
              isNull(communications.deletedAt)
            )
          )
      : [];
  const priorByKey = new Map(
    priorRows.flatMap((row) =>
      row.dedupeKey ? [[row.dedupeKey, { createdAt: row.createdAt }]] : []
    )
  );
  const practiceSettings = vaccinationRecallPracticeSettings(practice.settings);
  const quietHours = isQuietHours(new Date(), practice.timezone);
  const recipients = candidates.map((candidate) => {
    const dedupeKey = vaccinationRecallDedupeKey(ctx.practiceId, candidate);
    return evaluateVaccinationRecallRecipient({
      practiceId: ctx.practiceId,
      practiceSettings,
      candidate,
      smsSenderAvailable: Boolean(smsSender),
      smsSuppressedPhones,
      quietHours,
      existingSend: priorByKey.get(dedupeKey),
    });
  });
  return { practice, recipients, smsSender };
}

export async function getVaccinationRecallPreview(ctx: {
  db: Database;
  practiceId: string;
}): Promise<VaccinationRecallPreview | null> {
  const result = await loadVaccinationRecallRecipients(ctx);
  if (!result) return null;
  return {
    generatedAt: new Date(),
    total: result.recipients.length,
    eligible: result.recipients.filter((item) => item.status === "eligible")
      .length,
    blocked: result.recipients.filter((item) => item.status === "blocked").length,
    alreadySent: result.recipients.filter(
      (item) => item.status === "already_sent"
    ).length,
    recipients: result.recipients,
  };
}

export async function sendVaccinationRecallReminders(
  ctx: { db: Database; practiceId: string },
  patientIds: string[]
) {
  if (patientIds.length === 0) {
    return { sent: 0, failed: 0, blocked: 0, deduped: 0 };
  }
  const targets = [...new Set(patientIds)];
  const result = await loadVaccinationRecallRecipients(ctx, targets);
  if (!result) return null;
  const { practice, recipients, smsSender } = result;
  let sent = 0;
  let failed = 0;
  const blocked =
    targets.length - recipients.length +
    recipients.filter((recipient) => recipient.status === "blocked").length;
  let deduped = recipients.filter(
    (recipient) => recipient.status === "already_sent"
  ).length;

  for (const recipient of recipients) {
    if (recipient.status !== "eligible" || !recipient.channel) continue;
    const vaccineNames = recipient.vaccines
      .map((vaccine) => vaccine.vaccineName)
      .join(", ");
    const dueDate = recipient.vaccines[0]?.nextDueDate;
    const [claim] = await ctx.db
      .insert(communications)
      .values({
        practiceId: ctx.practiceId,
        clientId: recipient.clientId,
        channel: recipient.channel,
        direction: "outbound",
        subject: "Vaccination Reminder",
        content: `Vaccination reminder for ${recipient.patientName}: ${vaccineNames}`,
        status: "pending",
        dedupeKey: recipient.dedupeKey,
      })
      .onConflictDoNothing({ target: communications.dedupeKey })
      .returning({ id: communications.id });
    if (!claim) {
      deduped++;
      continue;
    }

    const sendEmail = async () => {
      const clientEmail = normalizeEmailSuppressionAddress(recipient.clientEmail);
      if (!clientEmail || recipient.emailSuppressionReason || !dueDate) {
        return { success: false as const };
      }
      try {
        return await sendVaccinationReminder({
          to: clientEmail,
          clientName: recipient.clientName,
          patientName: recipient.patientName,
          vaccineName: vaccineNames,
          dueDate: formatClinicalDate(dueDate, practice.timezone, "overdue"),
          practiceName: practice.name,
          practicePhone: practice.phone ?? undefined,
        });
      } catch {
        return { success: false as const };
      }
    };

    let deliveredChannel: "sms" | "email" = recipient.channel;
    let providerMessageId: string | undefined;
    let delivered = false;
    if (recipient.channel === "sms" && smsSender) {
      try {
        const smsResult = await sendVaccinationReminderSms({
          to: recipient.clientPhone!,
          patientName: recipient.patientName,
          vaccineName: vaccineNames,
          practiceName: practice.name,
          practicePhone: practice.phone ?? undefined,
          practiceId: ctx.practiceId,
          locationId: smsSender.locationId,
        });
        delivered = smsResult.success;
        providerMessageId = smsResult.sid;
      } catch {
        delivered = false;
      }
      if (!delivered) {
        const emailResult = await sendEmail();
        delivered = emailResult.success;
        if (delivered) {
          deliveredChannel = "email";
          providerMessageId = emailResult.id;
        }
      }
    } else {
      const emailResult = await sendEmail();
      delivered = emailResult.success;
      providerMessageId = emailResult.id;
    }

    if (delivered) {
      await ctx.db
        .update(communications)
        .set({
          channel: deliveredChannel,
          content: `Vaccination reminder sent for ${recipient.patientName}: ${vaccineNames}`,
          status: "sent",
          providerMessageId,
        })
        .where(
          and(
            eq(communications.id, claim.id),
            eq(communications.practiceId, ctx.practiceId),
            eq(communications.dedupeKey, recipient.dedupeKey),
            isNull(communications.deletedAt)
          )
        );
      sent++;
      continue;
    }

    await ctx.db
      .update(communications)
      .set({
        content: `Vaccination reminder failed for ${recipient.patientName}: ${vaccineNames}`,
        status: "failed",
        dedupeKey: null,
      })
      .where(
        and(
          eq(communications.id, claim.id),
          eq(communications.practiceId, ctx.practiceId),
          eq(communications.dedupeKey, recipient.dedupeKey),
          isNull(communications.deletedAt)
        )
      );
    failed++;
  }

  return { sent, failed, blocked, deduped };
}
