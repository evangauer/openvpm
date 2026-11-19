/**
 * Bulk care-reminder outreach policy.
 *
 * A clinic's weekly reminder volume varies, and this repo does not store a
 * measured send rate to size against. The defaults stay conservative:
 *
 * - `CARE_REMINDER_BULK_MAX_BATCH` (default 200): most reminders one send
 *   will deliver. Hard ceiling is 500.
 * - `CARE_REMINDER_BULK_BATCHES_PER_HOUR` (default 4): how many send attempts
 *   one clinic may start per hour, tracked in `lib/rate-limit.ts`.
 *
 * Invalid or missing env values fall back to the defaults. Raising either
 * value does not skip consent, suppression, quiet hours, or the recovery hold.
 *
 * Imported reminders are clinic tasks only. A source system id never counts
 * as SMS consent; texts require the client's current `smsConsent`.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  automatedAppointmentReminderSuppressionReason,
  hasReservedFixturePhone,
} from "@/lib/automated-reminder-policy";
import { normalizeEmailSuppressionAddress } from "@/lib/email-suppression";
import { formatDateInputForTimeZone } from "@/lib/date-input";
import { pickReminderChannel, isQuietHours } from "@/lib/messaging/reminders";
import { normalizeE164 } from "@/lib/messaging/phone";
import { formatClinicalDate } from "@/lib/records/clinical-dates";
import { clinicalDateInput } from "@/lib/records/clinical-inputs";
import { vaccinationRecallPracticeSettings } from "@/lib/vaccination-recalls";
import {
  CARE_REMINDER_SPECIES,
  type CareReminderSpecies,
} from "@/lib/care-reminder-species";

export const DEFAULT_CARE_REMINDER_BULK_MAX_BATCH = 200;
export const CARE_REMINDER_BULK_MAX_BATCH_CEILING = 500;
export const DEFAULT_CARE_REMINDER_BULK_BATCHES_PER_HOUR = 4;
export const CARE_REMINDER_BULK_BATCHES_PER_HOUR_CEILING = 24;
export const CARE_REMINDER_BULK_WINDOW_MS = 60 * 60 * 1000;
export const CARE_REMINDER_BULK_PREVIEW_CAP = 1000;

const HOUR_MS = CARE_REMINDER_BULK_WINDOW_MS;

function configuredPositiveInt(
  name: string,
  fallback: number,
  ceiling: number,
): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > ceiling) return fallback;
  return value;
}

/** Reminders delivered by one bulk send. Default 200. */
export function careReminderBulkMaxBatch(): number {
  return configuredPositiveInt(
    "CARE_REMINDER_BULK_MAX_BATCH",
    DEFAULT_CARE_REMINDER_BULK_MAX_BATCH,
    CARE_REMINDER_BULK_MAX_BATCH_CEILING,
  );
}

/** Bulk send attempts allowed per clinic per hour. Default 4. */
export function careReminderBulkBatchesPerHour(): number {
  return configuredPositiveInt(
    "CARE_REMINDER_BULK_BATCHES_PER_HOUR",
    DEFAULT_CARE_REMINDER_BULK_BATCHES_PER_HOUR,
    CARE_REMINDER_BULK_BATCHES_PER_HOUR_CEILING,
  );
}

export function careReminderBulkRateLimitKey(practiceId: string): string {
  return `care-reminder-bulk:${practiceId}`;
}

export function careReminderBulkRateLimitWindowMs(): number {
  return HOUR_MS;
}

export const careReminderSpeciesSchema = z.enum(CARE_REMINDER_SPECIES);

export const bulkOutreachFiltersSchema = z
  .object({
    due: z.enum(["all", "overdue", "range"]).default("overdue"),
    dueFrom: clinicalDateInput("Due from").optional(),
    dueTo: clinicalDateInput("Due to").optional(),
    title: z.string().trim().max(255).optional(),
    species: careReminderSpeciesSchema.optional(),
    lastContacted: z.enum(["any", "never", "before"]).default("any"),
    lastContactedBefore: clinicalDateInput("Last contacted before").optional(),
    channel: z.enum(["auto", "email", "sms"]).default("auto"),
  })
  .superRefine((filters, ctx) => {
    if (filters.due === "range") {
      if (!filters.dueFrom || !filters.dueTo) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dueFrom"],
          message: "Choose both dates for a due range.",
        });
      } else if (filters.dueFrom > filters.dueTo) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dueTo"],
          message: "The due range must end on or after it starts.",
        });
      }
    }
    if (filters.lastContacted === "before" && !filters.lastContactedBefore) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lastContactedBefore"],
        message: "Choose the date a client must have been contacted before.",
      });
    }
  });

export type BulkOutreachFilters = z.infer<typeof bulkOutreachFiltersSchema>;

export type CareReminderOutreachChannel = "email" | "sms";

export type CareReminderBlockReason =
  | "cross_practice"
  | "not_open"
  | "inactive_patient"
  | "test_practice"
  | "seeded_demo_data"
  | "reserved_contact"
  | "missing_sms_consent"
  | "email_suppressed"
  | "sms_suppressed"
  | "quiet_hours"
  | "texting_unavailable"
  | "no_deliverable_channel";

export type CareReminderOutreachCandidate = {
  reminderId: string;
  practiceId: string;
  status: "open" | "completed" | "dismissed";
  title: string;
  dueDate: string;
  /** True when the row was migrated. Never treated as consent. */
  imported: boolean;
  patientId: string;
  patientName: string;
  patientStatus: "active" | "inactive" | "deceased";
  species: CareReminderSpecies | string;
  clientId: string;
  clientName: string;
  clientEmail: string | null;
  clientPhone: string | null;
  preferredContactMethod: string | null;
  smsConsent: boolean;
  emailSuppressionReason: string | null;
  lastContactedAt: Date | null;
};

export type CareReminderOutreachDecision = {
  status: "eligible" | "blocked" | "already_sent";
  channel: CareReminderOutreachChannel | null;
  blockReason: CareReminderBlockReason | null;
  blockMessage: string | null;
  dedupeKey: string | null;
  lastSentAt: Date | null;
};

export function careReminderOutreachDedupeKey(
  practiceId: string,
  channel: CareReminderOutreachChannel,
  requestId: string,
): string {
  return `${channel}:care-reminder:${practiceId}:${requestId}`;
}

export function careReminderOutreachCopy(input: {
  clientName: string;
  patientName: string;
  title: string;
  dueDate: string;
  timeZone?: string | null;
}): { subject: string; content: string; dueLabel: string } {
  const clientName = input.clientName.trim() || "Client";
  const dueLabel = formatClinicalDate(
    input.dueDate,
    input.timeZone,
    input.dueDate,
  );
  const subject = `Care Reminder for ${input.patientName}`;
  const content = `Hello ${clientName},\n\nThis is a reminder from our veterinary team about ${input.patientName}: ${input.title}. The reminder date is ${dueLabel}. Please contact us if you have questions or would like to schedule.`;
  return { subject, content, dueLabel };
}

/** Stable id so the same wording is claimed once. A changed reminder is a new id. */
export function bulkCareReminderRequestId(input: {
  reminderId: string;
  channel: CareReminderOutreachChannel;
  subject: string | null;
  content: string;
}): string {
  const hash = createHash("sha256")
    .update(
      [
        "openvpm:care-reminder-bulk:v1",
        input.channel,
        input.reminderId,
        input.subject ?? "",
        input.content,
      ].join("\n"),
    )
    .digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `a${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join("-");
}

export function reminderMatchesBulkFilters(
  candidate: Pick<
    CareReminderOutreachCandidate,
    "dueDate" | "title" | "species" | "lastContactedAt"
  >,
  filters: BulkOutreachFilters,
  today: string,
  timeZone?: string | null,
): boolean {
  if (filters.due === "overdue" && candidate.dueDate > today) return false;
  if (filters.due === "range") {
    if (!filters.dueFrom || !filters.dueTo) return false;
    if (candidate.dueDate < filters.dueFrom || candidate.dueDate > filters.dueTo) {
      return false;
    }
  }
  const title = filters.title?.trim().toLowerCase();
  if (title && !candidate.title.toLowerCase().includes(title)) return false;
  if (filters.species && candidate.species !== filters.species) return false;
  if (filters.lastContacted === "never") return candidate.lastContactedAt == null;
  if (filters.lastContacted === "before" && filters.lastContactedBefore) {
    if (!candidate.lastContactedAt) return true;
    const contactedOn = formatDateInputForTimeZone(
      candidate.lastContactedAt,
      timeZone,
    );
    return contactedOn < filters.lastContactedBefore;
  }
  return true;
}

const LIVE_SEND_STATUSES = new Set(["pending", "sent", "delivered", "read"]);

function blocked(
  reason: CareReminderBlockReason,
  message: string,
): CareReminderOutreachDecision {
  return {
    status: "blocked",
    channel: null,
    blockReason: reason,
    blockMessage: message,
    dedupeKey: null,
    lastSentAt: null,
  };
}

function emailIsDeliverable(candidate: CareReminderOutreachCandidate): boolean {
  return Boolean(
    normalizeEmailSuppressionAddress(candidate.clientEmail) &&
      !candidate.emailSuppressionReason,
  );
}

export function evaluateCareReminderOutreach(input: {
  practiceId: string;
  candidate: CareReminderOutreachCandidate;
  channelPreference: BulkOutreachFilters["channel"];
  quietHours: boolean;
  smsSenderAvailable: boolean;
  smsSuppressedPhones: ReadonlySet<string>;
  practiceSettings: ReturnType<typeof vaccinationRecallPracticeSettings>;
  existingSend?: { status: string; createdAt: Date } | null;
}): CareReminderOutreachDecision {
  const { candidate } = input;
  if (candidate.practiceId !== input.practiceId) {
    return blocked(
      "cross_practice",
      "This reminder belongs to another clinic and was not contacted.",
    );
  }
  if (candidate.status !== "open") {
    return blocked(
      "not_open",
      "Only open care reminders can be sent to a client.",
    );
  }
  if (candidate.patientStatus !== "active") {
    return blocked(
      "inactive_patient",
      "This patient is not active, so outreach stays off.",
    );
  }
  if (input.practiceSettings.analyticsExcluded) {
    return blocked(
      "test_practice",
      "Outreach is disabled for practices marked as demo or test data.",
    );
  }
  const seededDemo =
    input.practiceSettings.demoClientIds.has(candidate.clientId) ||
    input.practiceSettings.demoPatientIds.has(candidate.patientId);
  const fixture = automatedAppointmentReminderSuppressionReason({
    isSeededDemoClient: seededDemo,
    clientEmail: candidate.clientEmail,
  });
  if (fixture === "seeded_demo_data") {
    return blocked(
      "seeded_demo_data",
      "Seeded sample records can be reviewed but never contacted.",
    );
  }
  if (fixture === "reserved_email_domain" || hasReservedFixturePhone(candidate.clientPhone)) {
    return blocked(
      "reserved_contact",
      "This client uses a reserved test contact and cannot be messaged.",
    );
  }

  const normalizedPhone = normalizeE164(candidate.clientPhone);
  const smsSuppressed = Boolean(
    normalizedPhone && input.smsSuppressedPhones.has(normalizedPhone),
  );
  const emailAvailable = emailIsDeliverable(candidate);
  // Consent is the live client flag only. `imported` is intentionally unused.
  const smsConsent = candidate.smsConsent === true;
  const preference =
    input.channelPreference === "email"
      ? "email"
      : input.channelPreference === "sms"
        ? "sms"
        : candidate.preferredContactMethod;
  const picked = pickReminderChannel({
    preferredContactMethod: preference,
    phone: candidate.clientPhone,
    smsConsent,
    hasEmail:
      input.channelPreference === "sms" ? false : emailAvailable,
    quietHours: input.quietHours,
    deferQuietHoursSms: input.channelPreference === "sms",
  });

  let channel: CareReminderOutreachChannel | null = null;
  let channelBlock: CareReminderOutreachDecision | null = null;
  if (picked === "sms") {
    if (!smsConsent) {
      channelBlock = blocked(
        "missing_sms_consent",
        "This client has not agreed to texts. Imported reminders do not add consent.",
      );
    } else if (!normalizedPhone) {
      channelBlock = blocked(
        "no_deliverable_channel",
        "Add a mobile number before sending a text.",
      );
    } else if (smsSuppressed) {
      channelBlock = input.channelPreference === "auto" && emailAvailable
        ? null
        : blocked(
            "sms_suppressed",
            "The client has opted out of text messages.",
          );
      if (input.channelPreference === "auto" && emailAvailable) channel = "email";
    } else if (!input.smsSenderAvailable) {
      if (input.channelPreference === "auto" && emailAvailable) channel = "email";
      else {
        channelBlock = blocked(
          "texting_unavailable",
          "Set up exactly one active clinic texting number before sending texts.",
        );
      }
    } else {
      channel = "sms";
    }
  } else if (picked === "email") {
    if (candidate.emailSuppressionReason) {
      channelBlock = blocked(
        "email_suppressed",
        "The client's email is suppressed.",
      );
    } else if (!emailAvailable) {
      channelBlock = blocked(
        "no_deliverable_channel",
        "Add a deliverable email before sending.",
      );
    } else {
      channel = "email";
    }
  } else if (input.channelPreference === "sms" && input.quietHours && smsConsent && normalizedPhone) {
    channelBlock = blocked(
      "quiet_hours",
      "SMS reminders cannot be sent during quiet hours (9 PM–8 AM local time). Try again after 8 AM.",
    );
  } else if (!smsConsent && normalizedPhone) {
    channelBlock = blocked(
      "missing_sms_consent",
      "This client has not agreed to texts. Imported reminders do not add consent.",
    );
  } else if (candidate.emailSuppressionReason && !emailAvailable) {
    channelBlock = blocked(
      "email_suppressed",
      "The client's email is suppressed and no consented text is available.",
    );
  } else if (smsSuppressed && !emailAvailable) {
    channelBlock = blocked(
      "sms_suppressed",
      "The client has opted out of text messages and has no deliverable email.",
    );
  } else {
    channelBlock = blocked(
      "no_deliverable_channel",
      "Add a deliverable email or an opted-in mobile number before sending.",
    );
  }
  if (!channel) return channelBlock ?? blocked(
    "no_deliverable_channel",
    "Add a deliverable email or an opted-in mobile number before sending.",
  );

  const copy = careReminderOutreachCopy({
    clientName: candidate.clientName,
    patientName: candidate.patientName,
    title: candidate.title,
    dueDate: candidate.dueDate,
  });
  const requestId = bulkCareReminderRequestId({
    reminderId: candidate.reminderId,
    channel,
    subject: channel === "email" ? copy.subject : null,
    content: copy.content,
  });
  const dedupeKey = careReminderOutreachDedupeKey(
    input.practiceId,
    channel,
    requestId,
  );
  if (
    input.existingSend &&
    LIVE_SEND_STATUSES.has(input.existingSend.status)
  ) {
    return {
      status: "already_sent",
      channel: null,
      blockReason: null,
      blockMessage: "This reminder was already sent with the same wording.",
      dedupeKey,
      lastSentAt: input.existingSend.createdAt,
    };
  }

  return {
    status: "eligible",
    channel,
    blockReason: null,
    blockMessage:
      channel === "email" &&
      input.channelPreference === "auto" &&
      smsConsent &&
      candidate.preferredContactMethod === "sms"
        ? "Texting is unavailable right now; this reminder will use email."
        : null,
    dedupeKey,
    lastSentAt: null,
  };
}

export function careReminderQuietHours(
  now: Date,
  timeZone: string | null | undefined,
): boolean {
  return isQuietHours(now, timeZone);
}

export type { CareReminderSpecies };
