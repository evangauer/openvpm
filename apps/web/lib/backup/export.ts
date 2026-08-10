import { eq, and, isNull, inArray, sql, getTableColumns } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import type { Database } from "@openpims/db/client";
import { redactSecrets } from "@/lib/audit";
import { normalizeE164 } from "@/lib/messaging/phone";
import { rowsFromExecute } from "@/lib/db/execute-rows";
import {
  appointmentTypes,
  appointmentWaitlist,
  appointments,
  apiKeys,
  auditLog,
  caseEntries,
  cases,
  clinicalRecordCorrections,
  clinicalNotes,
  clients,
  communications,
  controlledSubstanceLog,
  dispenseChargeQueue,
  emailSuppressions,
  files,
  invoiceAdjustments,
  invoiceItems,
  invoices,
  insuranceClaims,
  insurancePolicies,
  labResults,
  labResultEvents,
  labResultReplacements,
  locationMessaging,
  locations,
  patientAllergies,
  patientMergeEvents,
  patientWeights,
  patients,
  payments,
  prescriptionEvents,
  prescriptions,
  problemList,
  procedures,
  products,
  purchaseOrders,
  recurringSeries,
  rooms,
  services,
  smsConsentEvents,
  smsDeliveryEventHistory,
  smsDeliveryEvents,
  smsSendAttemptEvents,
  smsSendAttempts,
  smsSuppressions,
  soapNoteAddenda,
  soapNoteReplacements,
  soapNotes,
  staffSchedules,
  suppliers,
  treatmentTemplateItems,
  treatmentTemplates,
  treatmentPlanItems,
  treatmentPlans,
  users,
  vaccinationRecords,
  vitalSigns,
  visitCloseouts,
  webhooks,
  wellnessEnrollments,
  wellnessPlans,
} from "@openpims/db";

/**
 * Full, owned export of a single practice's core data — used by the scheduled
 * backup cron (and reusable elsewhere). Always scoped by practiceId.
 */

/** Object-storage key for a practice's daily backup. Pure (testable). */
export function backupKey(practiceId: string, dateYmd: string): string {
  return `backups/${practiceId}/${dateYmd}.json`;
}

export const PRACTICE_EXPORT_SYSTEM_EXCLUSIONS = {
  usageRecords:
    "Hosted billing metering ledger; restoring rows could replay unmetered usage or skew current-period billing.",
  practicePaymentAccounts:
    "Stripe Connect account/provider state; reconnect payment processing after restore instead of replaying onboarding state.",
  stripeEvents: "Global Stripe webhook de-duplication ledger.",
  practiceConversionMilestones:
    "Repairable system analytics projection; rebuild it from authoritative local practice, product, and allowlisted Stripe evidence after restore.",
  rateLimitBuckets: "Transient abuse-control buckets, not clinic-owned data.",
  sessions: "Transient authentication sessions.",
  verificationTokens: "Transient authentication verification tokens.",
  authTokens:
    "Expiring pre-tenant email verification and password-reset tokens.",
  authEmailAttempts:
    "System verification-email dispatch evidence; it contains live provider identity and is recovered only through operational database disaster recovery.",
  authEmailDeliveryEvents:
    "Global immutable verification-email provider callback evidence; it is not clinic-owned restore data.",
  authEmailWebhookConflicts:
    "Global immutable verification-email callback conflict evidence; it is not clinic-owned restore data.",
  authEmailProviderIdentityConflicts:
    "Global immutable verification-email provider identity conflict evidence; it is not clinic-owned restore data.",
  captureSessions:
    "Expiring QR photo-capture link tokens; restoring them would resurrect old capture URLs. The photos themselves are in the files section.",
  consentRequests:
    "Expiring e-sign link tokens; the signed consent PDF is in the files section and the signing event is in the audit log.",
  messagingRegistrations:
    "Encrypted tax identity plus live carrier brand/campaign state. It is environment-bound, may be undecryptable under another key, and must never bind a restored clone to the real SMS provider. Recover it only through operational database disaster recovery.",
} as const;

export const PRACTICE_EXPORT_AUDIT_ONLY_SECTIONS = {
  smsSendAttempts:
    "Provider dispatch authority; exported for audit but restored only through trusted owner-maintenance disaster recovery.",
  smsSendAttemptEvents:
    "Provider acceptance evidence; ordinary clinic restore must not recreate provider message authority.",
  smsDeliveryEvents:
    "Environment-bound provider callback evidence; ordinary clinic restore cannot recreate global provider identities.",
  smsDeliveryEventHistory:
    "Tenant-attributed attribution, projection, and operator-reconciliation history; platform-global quarantine, conflict, and review rows are excluded. Ordinary clinic restore cannot recreate system evidence.",
} as const;

export const PRACTICE_EXPORT_SECRET_REPLACEMENTS = {
  passwordHash: "$2a$12$HNkF00edpp2mYk2gvvj8ne/PWjlXwgT5YZhAodh0/UVgTgtIPdnWS",
  apiKeyPrefix: "disabled",
  apiKeyHash: "$2a$12$HNkF00edpp2mYk2gvvj8ne/PWjlXwgT5YZhAodh0/UVgTgtIPdnWS",
  webhookSecret: "rotate-after-restore",
} as const;

export const PRACTICE_EXPORT_SECTIONS = [
  "locations",
  "locationMessaging",
  "smsSuppressions",
  "smsConsentEvents",
  "smsDeliveryEvents",
  "smsDeliveryEventHistory",
  "smsSendAttempts",
  "smsSendAttemptEvents",
  "emailSuppressions",
  "webhooks",
  "apiKeys",
  "users",
  "auditLog",
  "appointmentTypes",
  "rooms",
  "recurringSeries",
  "clients",
  "patients",
  "patientMergeEvents",
  "insurancePolicies",
  "wellnessPlans",
  "wellnessEnrollments",
  "patientWeights",
  "patientAllergies",
  "appointments",
  "appointmentWaitlist",
  "staffSchedules",
  "services",
  "products",
  "treatmentTemplates",
  "treatmentTemplateItems",
  "suppliers",
  "purchaseOrders",
  "invoices",
  "invoiceItems",
  "payments",
  "invoiceAdjustments",
  "insuranceClaims",
  "soapNotes",
  "soapNoteAddenda",
  "soapNoteReplacements",
  "vaccinationRecords",
  "labResults",
  "labResultEvents",
  "procedures",
  "clinicalNotes",
  "problemList",
  "vitalSigns",
  "clinicalRecordCorrections",
  "labResultReplacements",
  "cases",
  "caseEntries",
  "treatmentPlans",
  "treatmentPlanItems",
  "prescriptions",
  "prescriptionEvents",
  "dispenseChargeQueue",
  "visitCloseouts",
  "files",
  "controlledSubstanceLog",
  "communications",
] as const;

export type PracticeExportSection = (typeof PRACTICE_EXPORT_SECTIONS)[number];

const PRACTICE_EXPORT_OPTIONAL_RESTORE_SECTIONS = [
  "emailSuppressions",
  // Backward compatibility for backups created before the immutable
  // prescription lifecycle ledger was introduced.
  "prescriptionEvents",
  "dispenseChargeQueue",
  // Backward compatibility for backups created before durable patient lineage.
  "patientMergeEvents",
  // Backward compatibility for backups created before SMS consent evidence.
  "smsConsentEvents",
  "smsDeliveryEvents",
  "smsDeliveryEventHistory",
  "smsSendAttempts",
  "smsSendAttemptEvents",
  "visitCloseouts",
  "clinicalRecordCorrections",
  // Backward compatibility: addenda were introduced in v3 and SOAP
  // replacement lineage in v4.
  "soapNoteAddenda",
  "soapNoteReplacements",
  // Backward compatibility for backups created before the lab result safety
  // ledger and clinic-wide review inbox were introduced.
  "labResultEvents",
  "labResultReplacements",
] as const satisfies readonly PracticeExportSection[];

export type PracticeExport = {
  formatVersion: number;
  practiceId: string;
  exportedAt: string;
  counts: Record<PracticeExportSection, number>;
} & Record<PracticeExportSection, unknown[]>;

export const PRACTICE_EXPORT_FORMAT_VERSION = 4;

type Row = Record<string, unknown>;

function isRecord(value: unknown): value is Row {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rowsFor(data: unknown, section: PracticeExportSection): Row[] {
  if (!isRecord(data)) return [];
  const value = data[section];
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

export function sanitizePracticeExportRows(
  section: PracticeExportSection,
  rows: Row[],
): Row[] {
  return rows.map((row) => {
    switch (section) {
      case "users":
        return {
          ...row,
          passwordHash: PRACTICE_EXPORT_SECRET_REPLACEMENTS.passwordHash,
          emailVerifiedAt: null,
        };
      case "clients":
        return { ...row, accessToken: null };
      case "apiKeys":
        return {
          ...row,
          keyPrefix: PRACTICE_EXPORT_SECRET_REPLACEMENTS.apiKeyPrefix,
          keyHash: PRACTICE_EXPORT_SECRET_REPLACEMENTS.apiKeyHash,
          lastUsedAt: null,
        };
      case "webhooks":
        return {
          ...row,
          secret: PRACTICE_EXPORT_SECRET_REPLACEMENTS.webhookSecret,
          active: false,
        };
      case "auditLog":
        return {
          ...row,
          changes: redactSecrets(row.changes),
        };
      case "smsSendAttempts":
        return row.requestedByActorType === "platform_operator"
          ? {
              ...row,
              requestedByIdentity: "platform-operator",
              requestedByName: "OpenVPM operator",
            }
          : row;
      case "smsSendAttemptEvents":
      case "smsDeliveryEventHistory":
        return row.actorType === "platform_operator"
          ? {
              ...row,
              actorIdentity: "platform-operator",
              actorName: "OpenVPM operator",
            }
          : row;
      default:
        return row;
    }
  });
}

type RestoreReferenceRule = {
  section: PracticeExportSection;
  field: string;
  parentSection: PracticeExportSection;
  required?: boolean;
};

const MAX_RESTORE_REFERENCE_ERRORS = 25;

function requiredRef(
  section: PracticeExportSection,
  field: string,
  parentSection: PracticeExportSection,
): RestoreReferenceRule {
  return { section, field, parentSection, required: true };
}

function optionalRef(
  section: PracticeExportSection,
  field: string,
  parentSection: PracticeExportSection,
): RestoreReferenceRule {
  return { section, field, parentSection };
}

const RESTORE_REFERENCE_RULES: RestoreReferenceRule[] = [
  requiredRef("locationMessaging", "locationId", "locations"),
  optionalRef("smsSuppressions", "locationId", "locations"),
  optionalRef("smsConsentEvents", "clientId", "clients"),
  optionalRef("smsConsentEvents", "locationId", "locations"),
  optionalRef("smsConsentEvents", "actorUserId", "users"),
  optionalRef("smsSendAttempts", "clientId", "clients"),
  optionalRef("smsSendAttempts", "locationId", "locations"),
  optionalRef("smsSendAttempts", "communicationId", "communications"),
  optionalRef("smsSendAttempts", "requestedByUserId", "users"),
  optionalRef("smsSendAttempts", "resendOfAttemptId", "smsSendAttempts"),
  requiredRef("smsSendAttemptEvents", "attemptId", "smsSendAttempts"),
  optionalRef("smsSendAttemptEvents", "actorUserId", "users"),
  requiredRef(
    "smsDeliveryEventHistory",
    "deliveryEventId",
    "smsDeliveryEvents",
  ),
  optionalRef("smsDeliveryEventHistory", "attemptId", "smsSendAttempts"),
  optionalRef("smsDeliveryEventHistory", "communicationId", "communications"),
  optionalRef("users", "locationId", "locations"),
  optionalRef("rooms", "locationId", "locations"),
  requiredRef("patients", "clientId", "clients"),
  requiredRef("patientMergeEvents", "sourcePatientId", "patients"),
  requiredRef("patientMergeEvents", "targetPatientId", "patients"),
  requiredRef("patientMergeEvents", "clientId", "clients"),
  requiredRef("patientMergeEvents", "performedBy", "users"),
  requiredRef("patientWeights", "patientId", "patients"),
  optionalRef("patientWeights", "recordedBy", "users"),
  requiredRef("patientAllergies", "patientId", "patients"),
  optionalRef("patientAllergies", "notedBy", "users"),
  optionalRef("appointments", "typeId", "appointmentTypes"),
  optionalRef("appointments", "patientId", "patients"),
  optionalRef("appointments", "clientId", "clients"),
  optionalRef("appointments", "doctorId", "users"),
  optionalRef("appointments", "roomId", "rooms"),
  optionalRef("appointments", "recurringSeriesId", "recurringSeries"),
  requiredRef("appointmentWaitlist", "clientId", "clients"),
  optionalRef("appointmentWaitlist", "patientId", "patients"),
  optionalRef("appointmentWaitlist", "typeId", "appointmentTypes"),
  optionalRef("appointmentWaitlist", "createdBy", "users"),
  requiredRef("staffSchedules", "userId", "users"),
  optionalRef("staffSchedules", "locationId", "locations"),
  optionalRef("products", "locationId", "locations"),
  requiredRef("purchaseOrders", "supplierId", "suppliers"),
  requiredRef("invoices", "clientId", "clients"),
  optionalRef("invoices", "patientId", "patients"),
  optionalRef("invoices", "appointmentId", "appointments"),
  requiredRef("invoiceItems", "invoiceId", "invoices"),
  optionalRef("invoiceItems", "sourcePrescriptionId", "prescriptions"),
  optionalRef("invoiceItems", "sourceDispenseChargeId", "dispenseChargeQueue"),
  requiredRef("payments", "invoiceId", "invoices"),
  optionalRef("payments", "receivedBy", "users"),
  requiredRef("invoiceAdjustments", "invoiceId", "invoices"),
  optionalRef("invoiceAdjustments", "createdBy", "users"),
  requiredRef("insurancePolicies", "clientId", "clients"),
  requiredRef("insurancePolicies", "patientId", "patients"),
  requiredRef("insuranceClaims", "policyId", "insurancePolicies"),
  optionalRef("insuranceClaims", "invoiceId", "invoices"),
  requiredRef("wellnessEnrollments", "planId", "wellnessPlans"),
  requiredRef("wellnessEnrollments", "clientId", "clients"),
  optionalRef("wellnessEnrollments", "patientId", "patients"),
  requiredRef("treatmentTemplateItems", "templateId", "treatmentTemplates"),
  requiredRef("soapNotes", "patientId", "patients"),
  optionalRef("soapNotes", "appointmentId", "appointments"),
  requiredRef("soapNotes", "authorId", "users"),
  optionalRef("soapNotes", "finalizedBy", "users"),
  requiredRef("soapNoteAddenda", "soapNoteId", "soapNotes"),
  requiredRef("soapNoteAddenda", "authorId", "users"),
  requiredRef(
    "soapNoteReplacements",
    "correctionId",
    "clinicalRecordCorrections",
  ),
  requiredRef("soapNoteReplacements", "sourceSoapNoteId", "soapNotes"),
  requiredRef("soapNoteReplacements", "replacementSoapNoteId", "soapNotes"),
  requiredRef("soapNoteReplacements", "actorId", "users"),
  requiredRef("vaccinationRecords", "patientId", "patients"),
  optionalRef("vaccinationRecords", "appointmentId", "appointments"),
  optionalRef("vaccinationRecords", "administeredBy", "users"),
  requiredRef("labResults", "patientId", "patients"),
  optionalRef("labResults", "appointmentId", "appointments"),
  optionalRef("labResults", "orderedBy", "users"),
  optionalRef("labResults", "reviewedBy", "users"),
  optionalRef("labResults", "followUpAssignedTo", "users"),
  optionalRef("labResults", "followUpCompletedBy", "users"),
  requiredRef("labResultEvents", "labResultId", "labResults"),
  requiredRef("labResultEvents", "patientId", "patients"),
  optionalRef("labResultEvents", "appointmentId", "appointments"),
  requiredRef("labResultEvents", "actorId", "users"),
  optionalRef("labResultEvents", "followUpAssignedTo", "users"),
  requiredRef("procedures", "patientId", "patients"),
  optionalRef("procedures", "appointmentId", "appointments"),
  optionalRef("procedures", "performedBy", "users"),
  requiredRef("clinicalNotes", "patientId", "patients"),
  requiredRef("clinicalNotes", "authorId", "users"),
  requiredRef("problemList", "patientId", "patients"),
  requiredRef("vitalSigns", "patientId", "patients"),
  optionalRef("vitalSigns", "appointmentId", "appointments"),
  optionalRef("vitalSigns", "recordedBy", "users"),
  requiredRef("clinicalRecordCorrections", "patientId", "patients"),
  optionalRef("clinicalRecordCorrections", "appointmentId", "appointments"),
  requiredRef("clinicalRecordCorrections", "correctedBy", "users"),
  optionalRef("clinicalRecordCorrections", "soapNoteId", "soapNotes"),
  optionalRef("clinicalRecordCorrections", "vitalSignId", "vitalSigns"),
  optionalRef(
    "clinicalRecordCorrections",
    "vaccinationRecordId",
    "vaccinationRecords",
  ),
  optionalRef("clinicalRecordCorrections", "labResultId", "labResults"),
  requiredRef(
    "labResultReplacements",
    "correctionId",
    "clinicalRecordCorrections",
  ),
  requiredRef("labResultReplacements", "sourceLabResultId", "labResults"),
  requiredRef("labResultReplacements", "replacementLabResultId", "labResults"),
  requiredRef("labResultReplacements", "actorId", "users"),
  requiredRef("cases", "patientId", "patients"),
  optionalRef("cases", "primaryVetId", "users"),
  requiredRef("caseEntries", "caseId", "cases"),
  optionalRef("caseEntries", "appointmentId", "appointments"),
  requiredRef("treatmentPlans", "patientId", "patients"),
  optionalRef("treatmentPlans", "problemId", "problemList"),
  optionalRef("treatmentPlans", "createdBy", "users"),
  requiredRef("treatmentPlanItems", "planId", "treatmentPlans"),
  requiredRef("prescriptions", "patientId", "patients"),
  optionalRef("prescriptions", "appointmentId", "appointments"),
  optionalRef("prescriptions", "productId", "products"),
  requiredRef("prescriptions", "prescribedBy", "users"),
  requiredRef("prescriptionEvents", "prescriptionId", "prescriptions"),
  requiredRef("prescriptionEvents", "patientId", "patients"),
  optionalRef("prescriptionEvents", "productId", "products"),
  optionalRef("prescriptionEvents", "actorId", "users"),
  requiredRef(
    "dispenseChargeQueue",
    "prescriptionEventId",
    "prescriptionEvents",
  ),
  requiredRef("dispenseChargeQueue", "prescriptionId", "prescriptions"),
  requiredRef("dispenseChargeQueue", "patientId", "patients"),
  requiredRef("dispenseChargeQueue", "clientId", "clients"),
  optionalRef("dispenseChargeQueue", "appointmentId", "appointments"),
  requiredRef("dispenseChargeQueue", "productId", "products"),
  optionalRef("dispenseChargeQueue", "invoiceId", "invoices"),
  optionalRef("dispenseChargeQueue", "invoiceItemId", "invoiceItems"),
  optionalRef("dispenseChargeQueue", "resolvedBy", "users"),
  requiredRef("visitCloseouts", "appointmentId", "appointments"),
  optionalRef("visitCloseouts", "followUpAppointmentId", "appointments"),
  optionalRef("visitCloseouts", "clinicalFinalizedBy", "users"),
  optionalRef("visitCloseouts", "invoiceId", "invoices"),
  optionalRef("visitCloseouts", "completedBy", "users"),
  requiredRef("files", "uploadedBy", "users"),
  optionalRef("controlledSubstanceLog", "patientId", "patients"),
  requiredRef("controlledSubstanceLog", "performedBy", "users"),
  optionalRef("controlledSubstanceLog", "witnessedBy", "users"),
  optionalRef("communications", "clientId", "clients"),
  optionalRef("communications", "assignedTo", "users"),
  optionalRef("auditLog", "userId", "users"),
];

function withPracticeId(rows: Row[], practiceId: string): Row[] {
  return rows.map((row) => ({ ...row, practiceId }));
}

function countsFor(
  sections: Record<PracticeExportSection, unknown[]>,
): Record<PracticeExportSection, number> {
  return Object.fromEntries(
    PRACTICE_EXPORT_SECTIONS.map((section) => [
      section,
      sections[section].length,
    ]),
  ) as Record<PracticeExportSection, number>;
}

export function summarizePracticeExport(data: unknown): {
  counts: Record<PracticeExportSection, number>;
  missingSections: PracticeExportSection[];
  totalRows: number;
} {
  const record = isRecord(data) ? data : {};
  const missingSections = PRACTICE_EXPORT_SECTIONS.filter((section) => {
    if (Array.isArray(record[section])) return false;
    const isBackwardCompatibleAbsence =
      !Object.prototype.hasOwnProperty.call(record, section) &&
      record.formatVersion !== PRACTICE_EXPORT_FORMAT_VERSION &&
      PRACTICE_EXPORT_OPTIONAL_RESTORE_SECTIONS.includes(section as never);
    return !isBackwardCompatibleAbsence;
  });
  const counts = Object.fromEntries(
    PRACTICE_EXPORT_SECTIONS.map((section) => [
      section,
      rowsFor(record, section).length,
    ]),
  ) as Record<PracticeExportSection, number>;

  return {
    counts,
    missingSections,
    totalRows: Object.values(counts).reduce((sum, count) => sum + count, 0),
  };
}

function rowLabel(row: Row, index: number): string {
  return typeof row.id === "string" ? row.id : `#${index + 1}`;
}

const PATIENT_IDENTITY_SPECIES = new Set([
  "canine",
  "feline",
  "avian",
  "rabbit",
  "reptile",
  "equine",
  "other",
]);
const PATIENT_IDENTITY_SEX = new Set([
  "male",
  "female",
  "male_neutered",
  "female_spayed",
]);
const CANONICAL_LOWER_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isNullableBoundedString(value: unknown, maxLength: number): boolean {
  return (
    value == null || (typeof value === "string" && value.length <= maxLength)
  );
}

function isValidCalendarDate(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function isValidPatientIdentitySnapshot(
  value: unknown,
  patientId: unknown,
  clientId: unknown,
): value is Row {
  if (!isRecord(value)) return false;
  const externalPairIsComplete =
    (value.externalSource == null) === (value.externalId == null);
  return (
    value.id === patientId &&
    value.clientId === clientId &&
    typeof value.name === "string" &&
    value.name.trim().length > 0 &&
    value.name.length <= 128 &&
    typeof value.species === "string" &&
    PATIENT_IDENTITY_SPECIES.has(value.species) &&
    Object.prototype.hasOwnProperty.call(value, "breed") &&
    isNullableBoundedString(value.breed, 128) &&
    Object.prototype.hasOwnProperty.call(value, "sex") &&
    (value.sex == null ||
      (typeof value.sex === "string" && PATIENT_IDENTITY_SEX.has(value.sex))) &&
    Object.prototype.hasOwnProperty.call(value, "dob") &&
    isValidCalendarDate(value.dob) &&
    Object.prototype.hasOwnProperty.call(value, "microchipNumber") &&
    isNullableBoundedString(value.microchipNumber, 64) &&
    Object.prototype.hasOwnProperty.call(value, "externalSource") &&
    isNullableBoundedString(value.externalSource, 64) &&
    Object.prototype.hasOwnProperty.call(value, "externalId") &&
    isNullableBoundedString(value.externalId, 160) &&
    externalPairIsComplete
  );
}

function isRestoredTimestamp(value: unknown): boolean {
  return (
    value instanceof Date ||
    (typeof value === "string" && !Number.isNaN(new Date(value).getTime()))
  );
}

function restoredTimestampMillis(value: unknown): number | null {
  if (!(value instanceof Date) && typeof value !== "string") return null;
  const milliseconds = new Date(value).getTime();
  return Number.isNaN(milliseconds) ? null : milliseconds;
}

function validateRestoreRows(
  data: unknown,
  pushError: (message: string) => void,
) {
  const record = isRecord(data) ? data : {};

  for (const section of PRACTICE_EXPORT_SECTIONS) {
    const value = record[section];
    if (!Array.isArray(value)) continue;

    value.forEach((row, index) => {
      const label = `#${index + 1}`;
      if (!isRecord(row)) {
        pushError(`${section}[${label}] must be an object row.`);
        return;
      }

      if (row.id == null || row.id === "") {
        pushError(`${section}[${label}].id is required.`);
        return;
      }

      if (typeof row.id !== "string" || row.id.trim().length === 0) {
        pushError(`${section}[${label}].id must be a non-empty string.`);
      }
    });
  }
}

export function validatePracticeExportRestore(data: unknown): {
  valid: boolean;
  errors: string[];
} {
  const parentIds = new Map<PracticeExportSection, Set<string>>();
  const errors: string[] = [];

  const idsFor = (section: PracticeExportSection) => {
    let ids = parentIds.get(section);
    if (!ids) {
      ids = new Set(
        rowsFor(data, section)
          .map((row) => row.id)
          .filter(
            (id): id is string => typeof id === "string" && id.length > 0,
          ),
      );
      parentIds.set(section, ids);
    }
    return ids;
  };

  const pushError = (message: string) => {
    if (errors.length < MAX_RESTORE_REFERENCE_ERRORS) {
      errors.push(message);
    }
  };

  validateRestoreRows(data, pushError);

  for (const rule of RESTORE_REFERENCE_RULES) {
    const ids = idsFor(rule.parentSection);
    rowsFor(data, rule.section).forEach((row, index) => {
      const value = row[rule.field];
      if (value == null || value === "") {
        if (rule.required) {
          pushError(
            `${rule.section}[${rowLabel(row, index)}].${rule.field} is required.`,
          );
        }
        return;
      }

      if (typeof value !== "string") {
        pushError(
          `${rule.section}[${rowLabel(row, index)}].${rule.field} must be a string id.`,
        );
        return;
      }

      if (!ids.has(value)) {
        pushError(
          `${rule.section}[${rowLabel(row, index)}].${rule.field} references missing ${rule.parentSection} row "${value}".`,
        );
      }
    });
  }

  const rowsById = (section: PracticeExportSection) =>
    new Map(
      rowsFor(data, section)
        .filter((row): row is Row & { id: string } =>
          Boolean(typeof row.id === "string" && row.id.length > 0),
        )
        .map((row) => [row.id, row]),
    );
  const backupPracticeId = isRecord(data) ? data.practiceId : undefined;
  const userRows = rowsById("users");
  const locationRows = rowsById("locations");
  const scheduleWindows = new Map<
    string,
    Array<{ startMinutes: number; endMinutes: number; label: string }>
  >();
  const scheduleTimeMinutes = (value: unknown): number | null => {
    if (typeof value !== "string") return null;
    const match = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d(?:\.\d{1,6})?)?$/.exec(
      value,
    );
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  };
  rowsFor(data, "staffSchedules").forEach((row, index) => {
    const label = `staffSchedules[${rowLabel(row, index)}]`;
    const provider =
      typeof row.userId === "string" ? userRows.get(row.userId) : undefined;
    const location =
      typeof row.locationId === "string"
        ? locationRows.get(row.locationId)
        : undefined;
    const startMinutes = scheduleTimeMinutes(row.startTime);
    const endMinutes = scheduleTimeMinutes(row.endTime);
    if (
      typeof row.practiceId !== "string" ||
      row.practiceId !== backupPracticeId
    ) {
      pushError(`${label}.practiceId must match the backup practiceId.`);
    }
    if (
      !Number.isInteger(row.dayOfWeek) ||
      Number(row.dayOfWeek) < 0 ||
      Number(row.dayOfWeek) > 6
    ) {
      pushError(`${label}.dayOfWeek must be an integer from 0 through 6.`);
    }
    if (
      startMinutes === null ||
      endMinutes === null ||
      startMinutes >= endMinutes
    ) {
      pushError(`${label} must contain a valid startTime before endTime.`);
    }
    if (
      provider &&
      (provider.practiceId !== row.practiceId ||
        provider.deletedAt != null ||
        !(
          provider.isVeterinarian === true ||
          (provider.isVeterinarian == null && provider.role === "veterinarian")
        ))
    ) {
      pushError(
        `${label}.userId must reference an active veterinarian provider.`,
      );
    }
    if (
      location &&
      (location.practiceId !== row.practiceId || location.deletedAt != null)
    ) {
      pushError(
        `${label}.locationId must reference an active same-practice location.`,
      );
    }
    if (
      typeof row.userId === "string" &&
      Number.isInteger(row.dayOfWeek) &&
      startMinutes !== null &&
      endMinutes !== null &&
      startMinutes < endMinutes
    ) {
      const key = `${row.userId}:${row.locationId ?? "global"}:${row.dayOfWeek}`;
      const windows = scheduleWindows.get(key) ?? [];
      windows.push({ startMinutes, endMinutes, label });
      scheduleWindows.set(key, windows);
    }
  });
  for (const windows of scheduleWindows.values()) {
    const ordered = [...windows].sort(
      (left, right) => left.startMinutes - right.startMinutes,
    );
    if (ordered.length > 3) {
      pushError(
        `${ordered[3]!.label} exceeds the maximum of three provider working windows per day.`,
      );
    }
    for (let index = 1; index < ordered.length; index += 1) {
      if (ordered[index]!.startMinutes < ordered[index - 1]!.endMinutes) {
        pushError(
          `${ordered[index]!.label} overlaps another provider working window.`,
        );
      }
    }
  }
  const appointmentRows = rowsById("appointments");

  for (const section of [
    "soapNotes",
    "vitalSigns",
    "labResults",
    "labResultEvents",
  ] as const) {
    rowsFor(data, section).forEach((row, index) => {
      if (typeof row.appointmentId !== "string") return;
      const appointment = appointmentRows.get(row.appointmentId);
      if (!appointment) return;

      if (appointment.patientId !== row.patientId) {
        pushError(
          `${section}[${rowLabel(row, index)}].appointmentId must reference an appointment for the same patient.`,
        );
      }
    });
  }

  const labRows = rowsById("labResults");
  rowsFor(data, "labResultEvents").forEach((row, index) => {
    if (typeof row.labResultId !== "string") return;
    const result = labRows.get(row.labResultId);
    if (!result) return;
    if (
      result.patientId !== row.patientId ||
      result.appointmentId !== row.appointmentId
    ) {
      pushError(
        `labResultEvents[${rowLabel(row, index)}] must match its lab result patient and appointment.`,
      );
    }
  });

  const record = isRecord(data) ? data : {};
  if (Array.isArray(record.patientMergeEvents)) {
    const patientRows = rowsById("patients");
    const clientRows = rowsById("clients");
    const userRows = rowsById("users");
    const mergeRows = rowsFor(data, "patientMergeEvents");
    const incomingTargetIds = new Set(
      mergeRows
        .map((row) => row.targetPatientId)
        .filter((id): id is string => typeof id === "string"),
    );
    const sourceKeys = new Set<string>();
    const operationKeys = new Set<string>();

    mergeRows.forEach((row, index) => {
      const label = `patientMergeEvents[${rowLabel(row, index)}]`;
      const practiceId = row.practiceId;
      const sourcePatient =
        typeof row.sourcePatientId === "string"
          ? patientRows.get(row.sourcePatientId)
          : undefined;
      const targetPatient =
        typeof row.targetPatientId === "string"
          ? patientRows.get(row.targetPatientId)
          : undefined;
      const client =
        typeof row.clientId === "string"
          ? clientRows.get(row.clientId)
          : undefined;
      const actor =
        typeof row.performedBy === "string"
          ? userRows.get(row.performedBy)
          : undefined;

      if (
        typeof practiceId !== "string" ||
        practiceId.length === 0 ||
        typeof record.practiceId !== "string" ||
        record.practiceId !== practiceId
      ) {
        pushError(`${label}.practiceId must match the backup practiceId.`);
      }
      if (row.sourcePatientId === row.targetPatientId) {
        pushError(`${label} cannot merge a patient into itself.`);
      }
      if (
        typeof row.sourcePatientId === "string" &&
        incomingTargetIds.has(row.sourcePatientId)
      ) {
        pushError(`${label} cannot use an existing merge target as a source.`);
      }

      if (
        typeof practiceId === "string" &&
        typeof row.sourcePatientId === "string"
      ) {
        const sourceKey = `${practiceId}:${row.sourcePatientId}`;
        if (sourceKeys.has(sourceKey)) {
          pushError(
            `${label}.sourcePatientId must be unique within its practice.`,
          );
        }
        sourceKeys.add(sourceKey);
      }
      if (
        typeof row.operationId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          row.operationId,
        )
      ) {
        pushError(`${label}.operationId must be a UUID.`);
      } else if (typeof practiceId === "string") {
        const operationKey = `${practiceId}:${row.operationId}`;
        if (operationKeys.has(operationKey)) {
          pushError(`${label}.operationId must be unique within its practice.`);
        }
        operationKeys.add(operationKey);
      }

      if (
        typeof row.performedByName !== "string" ||
        row.performedByName.trim().length === 0 ||
        row.performedByName.length > 255
      ) {
        pushError(
          `${label}.performedByName must be between 1 and 255 characters.`,
        );
      }
      if (
        typeof row.reason !== "string" ||
        row.reason.trim().length < 5 ||
        row.reason.length > 500
      ) {
        pushError(`${label}.reason must be between 5 and 500 characters.`);
      }

      if (
        !isValidPatientIdentitySnapshot(
          row.sourceSnapshot,
          row.sourcePatientId,
          row.clientId,
        )
      ) {
        pushError(
          `${label}.sourceSnapshot must be a valid patient identity snapshot.`,
        );
      }
      if (
        !isValidPatientIdentitySnapshot(
          row.targetSnapshot,
          row.targetPatientId,
          row.clientId,
        )
      ) {
        pushError(
          `${label}.targetSnapshot must be a valid patient identity snapshot.`,
        );
      }

      if (
        sourcePatient &&
        (sourcePatient.clientId !== row.clientId ||
          sourcePatient.practiceId !== practiceId)
      ) {
        pushError(
          `${label}.sourcePatientId must share its client and practice.`,
        );
      }
      if (
        targetPatient &&
        (targetPatient.clientId !== row.clientId ||
          targetPatient.practiceId !== practiceId)
      ) {
        pushError(
          `${label}.targetPatientId must share its client and practice.`,
        );
      }
      if (client && client.practiceId !== practiceId) {
        pushError(`${label}.clientId must belong to the declared practice.`);
      }
      if (actor && actor.practiceId !== practiceId) {
        pushError(`${label}.performedBy must belong to the declared practice.`);
      }
      if (sourcePatient && !isRestoredTimestamp(sourcePatient.deletedAt)) {
        pushError(
          `${label}.sourcePatientId must reference a soft-deleted source.`,
        );
      }
      if (targetPatient && targetPatient.deletedAt != null) {
        pushError(`${label}.targetPatientId must reference an active target.`);
      }
    });
  }

  if (Array.isArray(record.prescriptionEvents)) {
    const prescriptionRows = rowsFor(data, "prescriptions");
    const prescriptionById = new Map(
      prescriptionRows.map((prescription) => [prescription.id, prescription]),
    );
    const createdCounts = new Map<string, number>();
    rowsFor(data, "prescriptionEvents").forEach((event, index) => {
      const prescription = prescriptionById.get(event.prescriptionId);
      if (!prescription) return;
      if (
        event.patientId !== prescription.patientId ||
        (event.productId ?? null) !== (prescription.productId ?? null) ||
        (event.quantity ?? null) !== (prescription.quantity ?? null)
      ) {
        pushError(
          `prescriptionEvents[${rowLabel(event, index)}] does not exactly match its prescription patient, product, and quantity.`,
        );
      }
      if (event.eventType === "created") {
        createdCounts.set(
          String(event.prescriptionId),
          (createdCounts.get(String(event.prescriptionId)) ?? 0) + 1,
        );
      }
    });
    prescriptionRows.forEach((prescription, index) => {
      if (createdCounts.get(String(prescription.id)) !== 1) {
        pushError(
          `prescriptions[${rowLabel(prescription, index)}] must have exactly one created prescription event.`,
        );
      }
    });
  }

  if (Array.isArray(record.dispenseChargeQueue)) {
    const invoiceItemsByDispense = new Map<string, Row[]>();
    rowsFor(data, "invoiceItems").forEach((item) => {
      if (typeof item.sourceDispenseChargeId !== "string") return;
      const rows =
        invoiceItemsByDispense.get(item.sourceDispenseChargeId) ?? [];
      rows.push(item);
      invoiceItemsByDispense.set(item.sourceDispenseChargeId, rows);
    });
    rowsFor(data, "dispenseChargeQueue").forEach((row, index) => {
      const label = `dispenseChargeQueue[${rowLabel(row, index)}]`;
      const sourceItems =
        typeof row.id === "string"
          ? (invoiceItemsByDispense.get(row.id) ?? [])
          : [];
      if (
        row.status !== "pending" &&
        row.status !== "invoiced" &&
        row.status !== "waived"
      ) {
        pushError(`${label}.status is invalid.`);
        return;
      }
      if (row.status === "pending") {
        if (
          row.invoiceId != null ||
          row.invoiceItemId != null ||
          row.resolvedBy != null ||
          row.resolvedByName != null ||
          row.resolvedAt != null ||
          row.resolutionReason != null ||
          sourceItems.length > 0
        ) {
          pushError(`${label} pending state must be completely unresolved.`);
        }
        return;
      }
      if (
        typeof row.resolvedBy !== "string" ||
        typeof row.resolvedByName !== "string" ||
        row.resolvedByName.trim().length === 0 ||
        (typeof row.resolvedAt !== "string" &&
          !(row.resolvedAt instanceof Date))
      ) {
        pushError(`${label} resolved state requires attribution.`);
      }
      if (row.status === "invoiced") {
        if (
          typeof row.invoiceId !== "string" ||
          typeof row.invoiceItemId !== "string" ||
          row.resolutionReason != null ||
          sourceItems.length !== 1 ||
          sourceItems[0]?.id !== row.invoiceItemId ||
          sourceItems[0]?.invoiceId !== row.invoiceId
        ) {
          pushError(
            `${label} invoiced state must identify its exact sourced invoice line.`,
          );
        }
        return;
      }
      if (
        row.invoiceId != null ||
        row.invoiceItemId != null ||
        sourceItems.length > 0 ||
        typeof row.resolutionReason !== "string" ||
        row.resolutionReason.trim().length < 5 ||
        row.resolutionReason.length > 1000
      ) {
        pushError(
          `${label} waived state requires one bounded reason and no invoice.`,
        );
      }
    });
  }

  const soapRows = rowsById("soapNotes");
  const vitalRows = rowsById("vitalSigns");
  const vaccinationRows = rowsById("vaccinationRecords");
  const correctedSources = new Set<string>();
  const correctionOperationIds = new Set<string>();
  rowsFor(data, "clinicalRecordCorrections").forEach((row, index) => {
    const label = `clinicalRecordCorrections[${rowLabel(row, index)}]`;
    let source: Row | undefined;
    let sourceIdentity: string | undefined;

    if (row.recordType === "soap_note") {
      if (typeof row.soapNoteId !== "string" || row.soapNoteId.length === 0) {
        pushError(`${label}.soapNoteId is required for recordType soap_note.`);
        return;
      }
      if (row.vitalSignId != null) {
        pushError(
          `${label}.vitalSignId must be null for recordType soap_note.`,
        );
        return;
      }
      if (row.vaccinationRecordId != null) {
        pushError(
          `${label}.vaccinationRecordId must be null for recordType soap_note.`,
        );
        return;
      }
      if (row.labResultId != null) {
        pushError(
          `${label}.labResultId must be null for recordType soap_note.`,
        );
        return;
      }
      source = soapRows.get(row.soapNoteId);
      sourceIdentity = `soap_note:${row.soapNoteId}`;
    } else if (row.recordType === "vital_sign") {
      if (typeof row.vitalSignId !== "string" || row.vitalSignId.length === 0) {
        pushError(
          `${label}.vitalSignId is required for recordType vital_sign.`,
        );
        return;
      }
      if (row.soapNoteId != null) {
        pushError(
          `${label}.soapNoteId must be null for recordType vital_sign.`,
        );
        return;
      }
      if (row.vaccinationRecordId != null) {
        pushError(
          `${label}.vaccinationRecordId must be null for recordType vital_sign.`,
        );
        return;
      }
      if (row.labResultId != null) {
        pushError(
          `${label}.labResultId must be null for recordType vital_sign.`,
        );
        return;
      }
      source = vitalRows.get(row.vitalSignId);
      sourceIdentity = `vital_sign:${row.vitalSignId}`;
    } else if (row.recordType === "vaccination_record") {
      if (
        typeof row.vaccinationRecordId !== "string" ||
        row.vaccinationRecordId.length === 0
      ) {
        pushError(
          `${label}.vaccinationRecordId is required for recordType vaccination_record.`,
        );
        return;
      }
      if (
        row.soapNoteId != null ||
        row.vitalSignId != null ||
        row.labResultId != null
      ) {
        pushError(
          `${label} may only set .vaccinationRecordId for recordType vaccination_record.`,
        );
        return;
      }
      source = vaccinationRows.get(row.vaccinationRecordId);
      sourceIdentity = `vaccination_record:${row.vaccinationRecordId}`;
    } else if (row.recordType === "lab_result") {
      if (typeof row.labResultId !== "string" || row.labResultId.length === 0) {
        pushError(
          `${label}.labResultId is required for recordType lab_result.`,
        );
        return;
      }
      if (
        row.soapNoteId != null ||
        row.vitalSignId != null ||
        row.vaccinationRecordId != null
      ) {
        pushError(
          `${label} may only set .labResultId for recordType lab_result.`,
        );
        return;
      }
      if (
        typeof row.operationId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          row.operationId,
        ) ||
        typeof row.operationPayloadHash !== "string" ||
        !/^[0-9a-f]{64}$/.test(row.operationPayloadHash)
      ) {
        pushError(
          `${label} lab correction requires durable operation identity.`,
        );
        return;
      }
      if (correctionOperationIds.has(row.operationId)) {
        pushError(`${label}.operationId must be unique within its practice.`);
        return;
      }
      correctionOperationIds.add(row.operationId);
      source = labRows.get(row.labResultId);
      sourceIdentity = `lab_result:${row.labResultId}`;
    } else {
      pushError(
        `${label}.recordType must be soap_note, vital_sign, vaccination_record, or lab_result.`,
      );
      return;
    }

    if (
      row.recordType !== "lab_result" &&
      (row.operationId != null || row.operationPayloadHash != null)
    ) {
      pushError(`${label} non-lab correction cannot carry operation identity.`);
      return;
    }

    if (sourceIdentity && correctedSources.has(sourceIdentity)) {
      pushError(`${label} duplicates an existing correction source.`);
      return;
    }
    if (sourceIdentity) correctedSources.add(sourceIdentity);
    if (!source) return;

    const correctionAppointmentId = row.appointmentId ?? null;
    const sourceAppointmentId = source.appointmentId ?? null;
    if (
      source.patientId !== row.patientId ||
      sourceAppointmentId !== correctionAppointmentId
    ) {
      pushError(
        `${label} must match its source record patientId and appointmentId exactly.`,
      );
    }
  });

  const soapCorrectionByNoteId = new Map(
    rowsFor(data, "clinicalRecordCorrections")
      .filter(
        (row) =>
          row.recordType === "soap_note" && typeof row.soapNoteId === "string",
      )
      .map((row) => [row.soapNoteId as string, row]),
  );
  const addendumOperationIds = new Set<string>();
  const restoreValidationNow = Date.now();
  rowsFor(data, "soapNoteAddenda").forEach((row, index) => {
    const label = `soapNoteAddenda[${rowLabel(row, index)}]`;
    for (const field of [
      "id",
      "soapNoteId",
      "authorId",
      "operationId",
    ] as const) {
      if (
        typeof row[field] !== "string" ||
        !CANONICAL_LOWER_UUID.test(row[field])
      ) {
        pushError(`${label}.${field} must be a canonical lowercase UUID.`);
      }
    }
    if (
      typeof row.authorName !== "string" ||
      row.authorName.trim() !== row.authorName ||
      row.authorName.length < 1 ||
      row.authorName.length > 255
    ) {
      pushError(`${label}.authorName must be trimmed and 1-255 characters.`);
    }
    if (
      typeof row.content !== "string" ||
      row.content.trim() !== row.content ||
      row.content.length < 1 ||
      row.content.length > 10_000
    ) {
      pushError(`${label}.content must be trimmed and 1-10000 characters.`);
    }
    if (
      typeof row.operationPayloadHash !== "string" ||
      !/^[0-9a-f]{64}$/.test(row.operationPayloadHash)
    ) {
      pushError(`${label}.operationPayloadHash must be a SHA-256 hex digest.`);
    }
    const source =
      typeof row.soapNoteId === "string"
        ? soapRows.get(row.soapNoteId)
        : undefined;
    if (!source) return;

    const createdAt = restoredTimestampMillis(row.createdAt);
    const finalizedAt = restoredTimestampMillis(source.finalizedAt);
    const deletedAt = restoredTimestampMillis(source.deletedAt);
    const correction = soapCorrectionByNoteId.get(String(row.soapNoteId));
    const correctedAt = restoredTimestampMillis(correction?.createdAt);
    if (source.deletedAt != null && deletedAt === null) {
      pushError(`${label} source deletedAt must be a valid timestamp.`);
    }
    if (correction && correctedAt === null) {
      pushError(`${label} linked correction.createdAt must be a timestamp.`);
    }
    if (source.status !== "finalized" || finalizedAt === null) {
      pushError(`${label} must reference a finalized SOAP note.`);
    } else if (
      createdAt === null ||
      createdAt < finalizedAt ||
      createdAt > restoreValidationNow ||
      (deletedAt !== null && createdAt > deletedAt) ||
      (correctedAt !== null && createdAt > correctedAt)
    ) {
      pushError(
        `${label}.createdAt must be on or after finalization, not in the future, and no later than source deletion or correction.`,
      );
    }

    if (typeof row.operationId === "string") {
      const normalizedOperationId = row.operationId.toLowerCase();
      if (addendumOperationIds.has(normalizedOperationId)) {
        pushError(`${label}.operationId must be unique within its practice.`);
      }
      addendumOperationIds.add(normalizedOperationId);
    }

    if (
      typeof row.soapNoteId === "string" &&
      typeof row.authorId === "string" &&
      typeof row.content === "string"
    ) {
      const expectedHash = createHash("sha256")
        .update(
          JSON.stringify({
            noteId: row.soapNoteId.toLowerCase(),
            authorId: row.authorId.toLowerCase(),
            content: row.content,
          }),
        )
        .digest("hex");
      if (row.operationPayloadHash !== expectedHash) {
        pushError(
          `${label}.operationPayloadHash must match its exact note, author, and content payload.`,
        );
      }
    }
  });

  const correctionRows = rowsById("clinicalRecordCorrections");
  const soapReplacementSources = new Set<string>();
  const soapReplacements = new Set<string>();
  const soapReplacementOperations = new Set<string>();
  const soapReplacementEdges = new Map<string, string>();
  rowsFor(data, "soapNoteReplacements").forEach((row, index) => {
    const label = `soapNoteReplacements[${rowLabel(row, index)}]`;
    for (const field of [
      "id",
      "correctionId",
      "sourceSoapNoteId",
      "replacementSoapNoteId",
      "actorId",
      "operationId",
    ] as const) {
      if (
        typeof row[field] !== "string" ||
        !CANONICAL_LOWER_UUID.test(row[field])
      ) {
        pushError(`${label}.${field} must be a canonical lowercase UUID.`);
      }
    }
    const correction =
      typeof row.correctionId === "string"
        ? correctionRows.get(row.correctionId)
        : undefined;
    const source =
      typeof row.sourceSoapNoteId === "string"
        ? soapRows.get(row.sourceSoapNoteId)
        : undefined;
    const replacement =
      typeof row.replacementSoapNoteId === "string"
        ? soapRows.get(row.replacementSoapNoteId)
        : undefined;
    if (!correction || !source || !replacement) return;

    if (
      correction.recordType !== "soap_note" ||
      correction.soapNoteId !== row.sourceSoapNoteId
    ) {
      pushError(
        `${label}.correctionId must identify the exact SOAP correction for its source.`,
      );
    }
    if (row.sourceSoapNoteId === row.replacementSoapNoteId) {
      pushError(`${label} cannot replace a SOAP note with itself.`);
    }
    if (
      row.practiceId !== source.practiceId ||
      row.practiceId !== replacement.practiceId ||
      row.practiceId !== correction.practiceId
    ) {
      pushError(`${label}.practiceId must match all linked evidence.`);
    }
    if (
      source.patientId !== replacement.patientId ||
      (source.appointmentId ?? null) !== (replacement.appointmentId ?? null)
    ) {
      pushError(
        `${label} source and replacement must belong to the same patient and appointment.`,
      );
    }
    if (source.status !== "finalized" || replacement.status !== "finalized") {
      pushError(`${label} must link finalized SOAP notes.`);
    }
    if (
      row.actorId !== replacement.finalizedBy ||
      row.actorName !== replacement.finalizerName
    ) {
      pushError(
        `${label} actor attribution must match the replacement finalizer snapshot.`,
      );
    }
    const createdAt = restoredTimestampMillis(row.createdAt);
    const correctedAt = restoredTimestampMillis(correction.createdAt);
    const sourceFinalizedAt = restoredTimestampMillis(source.finalizedAt);
    const replacementFinalizedAt = restoredTimestampMillis(
      replacement.finalizedAt,
    );
    const sourceDeletedAt =
      source.deletedAt == null
        ? null
        : restoredTimestampMillis(source.deletedAt);
    const replacementDeletedAt =
      replacement.deletedAt == null
        ? null
        : restoredTimestampMillis(replacement.deletedAt);
    const replacementCorrection = soapCorrectionByNoteId.get(
      String(row.replacementSoapNoteId),
    );
    const replacementCorrectedAt = restoredTimestampMillis(
      replacementCorrection?.createdAt,
    );
    if (
      createdAt === null ||
      correctedAt === null ||
      sourceFinalizedAt === null ||
      replacementFinalizedAt === null ||
      sourceFinalizedAt > correctedAt ||
      correctedAt > replacementFinalizedAt ||
      createdAt < correctedAt ||
      createdAt < replacementFinalizedAt ||
      (source.deletedAt != null &&
        (sourceDeletedAt === null || createdAt > sourceDeletedAt)) ||
      (replacement.deletedAt != null &&
        (replacementDeletedAt === null || createdAt > replacementDeletedAt)) ||
      (replacementCorrection && replacementCorrectedAt === null) ||
      (replacementCorrectedAt !== null && createdAt > replacementCorrectedAt) ||
      createdAt > restoreValidationNow
    ) {
      pushError(
        `${label} chronology must run from source finalization through correction, replacement finalization, link creation, and any later replacement correction.`,
      );
    }
    if (soapReplacementSources.has(row.sourceSoapNoteId as string)) {
      pushError(
        `${label}.sourceSoapNoteId must be unique within its practice.`,
      );
    }
    soapReplacementSources.add(row.sourceSoapNoteId as string);
    if (soapReplacements.has(row.replacementSoapNoteId as string)) {
      pushError(`${label}.replacementSoapNoteId may replace only one source.`);
    }
    soapReplacements.add(row.replacementSoapNoteId as string);
    if (
      typeof row.operationPayloadHash !== "string" ||
      !/^[0-9a-f]{64}$/.test(row.operationPayloadHash)
    ) {
      pushError(`${label}.operationPayloadHash must be a SHA-256 hex digest.`);
    }
    if (typeof row.operationId === "string") {
      if (soapReplacementOperations.has(row.operationId)) {
        pushError(`${label}.operationId must be unique within its practice.`);
      }
      soapReplacementOperations.add(row.operationId);
    }
    if (
      typeof row.actorName !== "string" ||
      row.actorName.trim() !== row.actorName ||
      row.actorName.length < 1 ||
      row.actorName.length > 255
    ) {
      pushError(`${label}.actorName must contain bounded attribution.`);
    }
    if (
      typeof row.sourceSoapNoteId === "string" &&
      typeof row.actorId === "string" &&
      typeof correction.reason === "string"
    ) {
      const expectedHash = createHash("sha256")
        .update(
          JSON.stringify({
            patientId: source.patientId,
            sourceNoteId: row.sourceSoapNoteId,
            actorId: row.actorId,
            reason: correction.reason,
            subjective: replacement.subjective ?? null,
            objective: replacement.objective ?? null,
            assessment: replacement.assessment ?? null,
            plan: replacement.plan ?? null,
          }),
        )
        .digest("hex");
      if (row.operationPayloadHash !== expectedHash) {
        pushError(
          `${label}.operationPayloadHash must match its exact correction and replacement payload.`,
        );
      }
    }
    soapReplacementEdges.set(
      row.sourceSoapNoteId as string,
      row.replacementSoapNoteId as string,
    );
  });

  for (const sourceId of soapReplacementEdges.keys()) {
    const visited = new Set<string>();
    let current: string | undefined = sourceId;
    while (current) {
      if (visited.has(current)) {
        pushError(
          `soapNoteReplacements contains a directed replacement cycle at SOAP note "${current}".`,
        );
        break;
      }
      visited.add(current);
      current = soapReplacementEdges.get(current);
    }
  }

  const replacementSources = new Set<string>();
  const replacements = new Set<string>();
  const replacementOperations = new Set<string>();
  const replacementEdges = new Map<string, string>();
  rowsFor(data, "labResultReplacements").forEach((row, index) => {
    const label = `labResultReplacements[${rowLabel(row, index)}]`;
    const correction =
      typeof row.correctionId === "string"
        ? correctionRows.get(row.correctionId)
        : undefined;
    const source =
      typeof row.sourceLabResultId === "string"
        ? labRows.get(row.sourceLabResultId)
        : undefined;
    const replacement =
      typeof row.replacementLabResultId === "string"
        ? labRows.get(row.replacementLabResultId)
        : undefined;
    if (!correction || !source || !replacement) return;

    if (
      correction.recordType !== "lab_result" ||
      correction.labResultId !== row.sourceLabResultId
    ) {
      pushError(
        `${label}.correctionId must identify the exact lab correction for its source.`,
      );
    }
    if (row.sourceLabResultId === row.replacementLabResultId) {
      pushError(`${label} cannot replace a result with itself.`);
    }
    if (
      row.practiceId !== source.practiceId ||
      row.practiceId !== replacement.practiceId ||
      row.practiceId !== correction.practiceId
    ) {
      pushError(`${label}.practiceId must match all linked evidence.`);
    }
    if (replacementSources.has(row.sourceLabResultId as string)) {
      pushError(
        `${label}.sourceLabResultId must be unique within its practice.`,
      );
    }
    replacementSources.add(row.sourceLabResultId as string);
    if (replacements.has(row.replacementLabResultId as string)) {
      pushError(`${label}.replacementLabResultId may replace only one source.`);
    }
    replacements.add(row.replacementLabResultId as string);
    if (
      typeof row.operationId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        row.operationId,
      ) ||
      typeof row.operationPayloadHash !== "string" ||
      !/^[0-9a-f]{64}$/.test(row.operationPayloadHash)
    ) {
      pushError(`${label} requires valid operation identity and payload hash.`);
    } else if (replacementOperations.has(row.operationId)) {
      pushError(`${label}.operationId must be unique within its practice.`);
    } else {
      replacementOperations.add(row.operationId);
    }
    if (
      typeof row.actorName !== "string" ||
      row.actorName.trim().length < 1 ||
      row.actorName.length > 255
    ) {
      pushError(`${label}.actorName must contain bounded attribution.`);
    }
    replacementEdges.set(
      row.sourceLabResultId as string,
      row.replacementLabResultId as string,
    );
  });

  for (const sourceId of replacementEdges.keys()) {
    const visited = new Set<string>();
    let current: string | undefined = sourceId;
    while (current) {
      if (visited.has(current)) {
        pushError(
          `labResultReplacements contains a directed replacement cycle at lab result "${current}".`,
        );
        break;
      }
      visited.add(current);
      current = replacementEdges.get(current);
    }
  }

  return { valid: errors.length === 0, errors };
}

export function synthesizeLegacyPrescriptionEvents(data: unknown): Row[] {
  const actorNames = new Map(
    rowsFor(data, "users").map((user) => [user.id, user.name]),
  );
  return rowsFor(data, "prescriptions").map((prescription) => ({
    id: randomUUID(),
    createdAt: prescription.createdAt,
    practiceId: prescription.practiceId,
    prescriptionId: prescription.id,
    patientId: prescription.patientId,
    productId: prescription.productId ?? null,
    eventType: "created",
    quantity: prescription.quantity ?? null,
    statusBefore: null,
    statusAfter: "active",
    refillsBefore: null,
    refillsAfter:
      typeof prescription.refillsRemaining === "number"
        ? prescription.refillsRemaining
        : 0,
    reason:
      "Restored from pre-ledger backup; earlier refill history unavailable.",
    actorId: prescription.prescribedBy,
    actorName:
      actorNames.get(prescription.prescribedBy) ?? "Imported prescriber",
    operationId: prescription.operationId ?? null,
  }));
}

/**
 * Backups created before the consent ledger may contain only the current
 * client projection. Preserve an affirmative value only when that legacy row
 * itself contains complete, valid evidence; otherwise clear it fail-closed.
 */
export function prepareLegacySmsConsentRestore(data: unknown): {
  clients: Row[];
  smsConsentEvents: Row[];
} {
  const clientRows = rowsFor(data, "clients");
  const backupRecord = isRecord(data) ? data : {};
  if (Object.prototype.hasOwnProperty.call(backupRecord, "smsConsentEvents")) {
    const eventRows = rowsFor(data, "smsConsentEvents");
    const latestGrants = new Map<string, Row>();
    const latestRevokes = new Map<string, Row>();
    const occurredAtMs = (event: Row) => {
      const value = event.occurredAt;
      if (value instanceof Date) return value.getTime();
      if (typeof value === "string") return new Date(value).getTime();
      return Number.NaN;
    };
    const compareEvents = (left: Row, right: Row) => {
      const leftTime = occurredAtMs(left);
      const rightTime = occurredAtMs(right);
      if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) {
        // Malformed modern evidence must never preserve an affirmative state.
        return Number.NaN;
      }
      return (
        leftTime - rightTime ||
        String(left.id ?? "").localeCompare(String(right.id ?? ""))
      );
    };
    for (const event of eventRows) {
      if (typeof event.destinationE164 !== "string") continue;
      if (event.action === "revoked") {
        const prior = latestRevokes.get(event.destinationE164);
        if (!prior || compareEvents(event, prior) > 0) {
          latestRevokes.set(event.destinationE164, event);
        }
      } else if (
        event.action === "granted" &&
        typeof event.clientId === "string"
      ) {
        const key = `${event.clientId}\u0000${event.destinationE164}`;
        const prior = latestGrants.get(key);
        if (!prior || compareEvents(event, prior) > 0) {
          latestGrants.set(key, event);
        }
      }
    }
    return {
      clients: clientRows.map((client) => {
        if (client.smsConsent !== true) return client;
        const destination = normalizeE164(
          typeof client.phone === "string" ? client.phone : null,
        );
        const matchingGrant =
          typeof client.id === "string" && destination !== null
            ? latestGrants.get(`${client.id}\u0000${destination}`)
            : undefined;
        const latestRevoke = destination
          ? latestRevokes.get(destination)
          : undefined;
        const latestApplicableEventIsGrant =
          matchingGrant !== undefined &&
          Number.isFinite(occurredAtMs(matchingGrant)) &&
          (!latestRevoke ||
            (Number.isFinite(occurredAtMs(latestRevoke)) &&
              occurredAtMs(matchingGrant) > occurredAtMs(latestRevoke)));
        return latestApplicableEventIsGrant
          ? client
          : {
              ...client,
              smsConsent: false,
              smsConsentAt: null,
              smsConsentSource: null,
              smsConsentDisclosure: null,
            };
      }),
      smsConsentEvents: eventRows,
    };
  }

  const synthesizedEvents: Row[] = [];
  const preparedClients = clientRows.map((client) => {
    if (client.smsConsent !== true) return client;

    const destination = normalizeE164(
      typeof client.phone === "string" ? client.phone : null,
    );
    const source =
      typeof client.smsConsentSource === "string"
        ? client.smsConsentSource.trim()
        : "";
    const disclosure =
      typeof client.smsConsentDisclosure === "string"
        ? client.smsConsentDisclosure.trim()
        : "";
    const disclosureVersion = source.split(":", 2)[1]?.trim() ?? "";
    const occurredAt = client.smsConsentAt;
    const hasTruthfulEvidence =
      typeof client.id === "string" &&
      destination !== null &&
      source.length > 0 &&
      disclosureVersion.length > 0 &&
      disclosure.length > 0 &&
      isRestoredTimestamp(occurredAt);

    if (!hasTruthfulEvidence) {
      return {
        ...client,
        smsConsent: false,
        smsConsentAt: null,
        smsConsentSource: null,
        smsConsentDisclosure: null,
      };
    }

    const eventDigest = createHash("sha256")
      .update(client.id as string)
      .digest("hex");
    synthesizedEvents.push({
      id: randomUUID(),
      createdAt: occurredAt,
      occurredAt,
      practiceId: client.practiceId,
      clientId: client.id,
      locationId: null,
      destinationE164: destination,
      action: "granted",
      source,
      disclosureVersion,
      disclosure,
      detail:
        "Restored from complete affirmative evidence in a pre-ledger backup.",
      actorType: "system",
      actorUserId: null,
      actorName: null,
      provider: null,
      providerMessageId: null,
      eventKey: `restore:legacy-client:${eventDigest}:affirmative-v1`,
    });
    return client;
  });

  return { clients: preparedClients, smsConsentEvents: synthesizedEvents };
}

async function activeRows(db: Database, table: any, practiceId: string) {
  return db
    .select()
    .from(table)
    .where(and(eq(table.practiceId, practiceId), isNull(table.deletedAt)));
}

async function allPracticeRows(db: Database, table: any, practiceId: string) {
  return db.select().from(table).where(eq(table.practiceId, practiceId));
}

async function tenantParentChildRows(
  db: Database,
  table: any,
  parentColumn: any,
  parentIds: string[],
  parentTable: any,
  parentIdColumn: any,
  practiceId: string,
) {
  if (parentIds.length === 0) return [];
  return db
    .select()
    .from(table)
    .where(
      and(
        inArray(parentColumn, parentIds),
        sql`exists (
          select 1
          from ${parentTable}
          where ${parentIdColumn} = ${parentColumn}
            and ${parentTable.practiceId} = ${practiceId}
            and ${parentTable.deletedAt} is null
        )`,
        isNull(table.deletedAt),
      ),
    );
}

/**
 * Backups round-trip through JSON, so timestamp values arrive as ISO strings
 * while the drizzle timestamp columns expect Date objects on insert. Coerce
 * per-table so a real backup file is directly restorable.
 */
export function coerceRowDates(table: any, rows: Row[]): Row[] {
  const dateColumns = Object.entries(getTableColumns(table))
    .filter(
      ([, column]) => (column as { dataType?: string }).dataType === "date",
    )
    .map(([name]) => name);
  if (dateColumns.length === 0) return rows;

  return rows.map((row) => {
    const coerced = { ...row };
    for (const name of dateColumns) {
      const value = coerced[name];
      if (typeof value === "string") {
        const parsed = new Date(value);
        if (!Number.isNaN(parsed.getTime())) coerced[name] = parsed;
      }
    }
    return coerced;
  });
}

async function restoreRows(
  db: Database,
  table: any,
  section: PracticeExportSection,
  rows: Row[],
  opts: { practiceId?: string } = {},
): Promise<number> {
  if (rows.length === 0) return 0;
  const sanitizedRows = coerceRowDates(
    table,
    sanitizePracticeExportRows(section, rows),
  );
  const values = opts.practiceId
    ? withPracticeId(sanitizedRows, opts.practiceId)
    : sanitizedRows;
  const restored = await db
    .insert(table)
    .values(values)
    .onConflictDoNothing()
    .returning({ id: table.id });
  return restored.length;
}

export async function exportPracticeData(
  db: Database,
  practiceId: string,
  exportedAt: string,
): Promise<PracticeExport> {
  const [
    allLocationRows,
    locationMessagingRows,
    smsSuppressionRows,
    smsConsentEventRows,
    smsSendAttemptRows,
    smsSendAttemptEventRows,
    practiceSmsDeliveryHistoryRows,
    emailSuppressionRows,
    webhookRows,
    apiKeyRows,
    allUserRows,
    auditLogRows,
    allAppointmentTypeRows,
    allRoomRows,
    allRecurringSeriesRows,
    allClientRows,
    allPatientRows,
    patientMergeRows,
    allAppointmentRows,
    appointmentWaitlistRows,
    staffScheduleRows,
    serviceRows,
    allProductRows,
    treatmentTemplateRows,
    supplierRows,
    purchaseOrderRows,
    invoiceRows,
    insurancePolicyRows,
    insuranceClaimRows,
    wellnessPlanRows,
    wellnessEnrollmentRows,
    allSoapNoteRows,
    soapNoteAddendumRows,
    soapNoteReplacementRows,
    allVaccinationRows,
    labRows,
    labResultEventRows,
    procedureRows,
    clinicalNoteRows,
    problemRows,
    allVitalRows,
    clinicalCorrectionRows,
    labReplacementRows,
    caseRows,
    treatmentPlanRows,
    allPrescriptionRows,
    prescriptionEventRows,
    dispenseChargeRows,
    visitCloseoutRows,
    fileRows,
    controlledSubstanceRows,
    allCommunicationRows,
  ] = await Promise.all([
    allPracticeRows(db, locations, practiceId),
    activeRows(db, locationMessaging, practiceId),
    activeRows(db, smsSuppressions, practiceId),
    allPracticeRows(db, smsConsentEvents, practiceId),
    allPracticeRows(db, smsSendAttempts, practiceId),
    allPracticeRows(db, smsSendAttemptEvents, practiceId),
    allPracticeRows(db, smsDeliveryEventHistory, practiceId),
    activeRows(db, emailSuppressions, practiceId),
    activeRows(db, webhooks, practiceId),
    activeRows(db, apiKeys, practiceId),
    allPracticeRows(db, users, practiceId),
    activeRows(db, auditLog, practiceId),
    allPracticeRows(db, appointmentTypes, practiceId),
    allPracticeRows(db, rooms, practiceId),
    allPracticeRows(db, recurringSeries, practiceId),
    allPracticeRows(db, clients, practiceId),
    allPracticeRows(db, patients, practiceId),
    allPracticeRows(db, patientMergeEvents, practiceId),
    allPracticeRows(db, appointments, practiceId),
    activeRows(db, appointmentWaitlist, practiceId),
    activeRows(db, staffSchedules, practiceId),
    activeRows(db, services, practiceId),
    allPracticeRows(db, products, practiceId),
    activeRows(db, treatmentTemplates, practiceId),
    activeRows(db, suppliers, practiceId),
    activeRows(db, purchaseOrders, practiceId),
    activeRows(db, invoices, practiceId),
    activeRows(db, insurancePolicies, practiceId),
    activeRows(db, insuranceClaims, practiceId),
    activeRows(db, wellnessPlans, practiceId),
    activeRows(db, wellnessEnrollments, practiceId),
    allPracticeRows(db, soapNotes, practiceId),
    allPracticeRows(db, soapNoteAddenda, practiceId),
    allPracticeRows(db, soapNoteReplacements, practiceId),
    allPracticeRows(db, vaccinationRecords, practiceId),
    allPracticeRows(db, labResults, practiceId),
    allPracticeRows(db, labResultEvents, practiceId),
    activeRows(db, procedures, practiceId),
    activeRows(db, clinicalNotes, practiceId),
    activeRows(db, problemList, practiceId),
    allPracticeRows(db, vitalSigns, practiceId),
    allPracticeRows(db, clinicalRecordCorrections, practiceId),
    allPracticeRows(db, labResultReplacements, practiceId),
    activeRows(db, cases, practiceId),
    activeRows(db, treatmentPlans, practiceId),
    allPracticeRows(db, prescriptions, practiceId),
    allPracticeRows(db, prescriptionEvents, practiceId),
    allPracticeRows(db, dispenseChargeQueue, practiceId),
    activeRows(db, visitCloseouts, practiceId),
    activeRows(db, files, practiceId),
    activeRows(db, controlledSubstanceLog, practiceId),
    allPracticeRows(db, communications, practiceId),
  ]);

  const attributedDeliveryEventIds = new Set(
    practiceSmsDeliveryHistoryRows
      .filter((row) => row.result === "attributed")
      .map((row) => row.deliveryEventId as string),
  );
  const smsDeliveryHistoryRows = practiceSmsDeliveryHistoryRows.filter((row) =>
    attributedDeliveryEventIds.has(row.deliveryEventId as string),
  );
  const deliveryEventIds = [...attributedDeliveryEventIds];
  const smsDeliveryEventRows =
    deliveryEventIds.length === 0
      ? []
      : await db
          .select()
          .from(smsDeliveryEvents)
          .where(inArray(smsDeliveryEvents.id, deliveryEventIds));

  const referencedPrescriptionIds = new Set(
    prescriptionEventRows.map((event) => event.prescriptionId),
  );
  const prescriptionRows = allPrescriptionRows.filter(
    (prescription) =>
      prescription.deletedAt == null ||
      referencedPrescriptionIds.has(prescription.id),
  );
  const referencedSoapNoteIds = new Set(
    [
      ...clinicalCorrectionRows.map((correction) => correction.soapNoteId),
      ...soapNoteAddendumRows.map((addendum) => addendum.soapNoteId),
      ...soapNoteReplacementRows.flatMap((replacement) => [
        replacement.sourceSoapNoteId,
        replacement.replacementSoapNoteId,
      ]),
    ].filter((id): id is string => typeof id === "string"),
  );
  const soapNoteRows = allSoapNoteRows.filter(
    (note) => note.deletedAt == null || referencedSoapNoteIds.has(note.id),
  );
  const referencedVitalSignIds = new Set(
    clinicalCorrectionRows
      .map((correction) => correction.vitalSignId)
      .filter((id): id is string => typeof id === "string"),
  );
  const vitalRows = allVitalRows.filter(
    (vital) => vital.deletedAt == null || referencedVitalSignIds.has(vital.id),
  );
  const referencedVaccinationRecordIds = new Set(
    clinicalCorrectionRows
      .map((correction) => correction.vaccinationRecordId)
      .filter((id): id is string => typeof id === "string"),
  );
  const vaccinationRows = allVaccinationRows.filter(
    (vaccination) =>
      vaccination.deletedAt == null ||
      referencedVaccinationRecordIds.has(vaccination.id),
  );
  const referencedAppointmentIds = new Set(
    [
      ...prescriptionRows.map((prescription) => prescription.appointmentId),
      ...clinicalCorrectionRows.map((correction) => correction.appointmentId),
      ...soapNoteRows.map((note) => note.appointmentId),
      ...vitalRows.map((vital) => vital.appointmentId),
      ...vaccinationRows.map((vaccination) => vaccination.appointmentId),
      ...labRows.map((result) => result.appointmentId),
      ...labResultEventRows.map((event) => event.appointmentId),
    ].filter((id): id is string => typeof id === "string"),
  );
  const appointmentRows = allAppointmentRows.filter(
    (appointment) =>
      appointment.deletedAt == null ||
      referencedAppointmentIds.has(appointment.id),
  );
  const referencedPatientIds = new Set(
    [
      ...prescriptionEventRows.map((event) => event.patientId),
      ...prescriptionRows.map((prescription) => prescription.patientId),
      ...clinicalCorrectionRows.map((correction) => correction.patientId),
      ...soapNoteRows.map((note) => note.patientId),
      ...vitalRows.map((vital) => vital.patientId),
      ...vaccinationRows.map((vaccination) => vaccination.patientId),
      ...labRows.map((result) => result.patientId),
      ...labResultEventRows.map((event) => event.patientId),
      ...appointmentRows.map((appointment) => appointment.patientId),
      ...patientMergeRows.flatMap((event) => [
        event.sourcePatientId,
        event.targetPatientId,
      ]),
    ].filter((id): id is string => typeof id === "string"),
  );
  const patientRows = allPatientRows.filter(
    (patient) =>
      patient.deletedAt == null || referencedPatientIds.has(patient.id),
  );
  const referencedProductIds = new Set(
    [
      ...prescriptionEventRows.map((event) => event.productId),
      ...prescriptionRows.map((prescription) => prescription.productId),
    ].filter((id): id is string => typeof id === "string"),
  );
  const productRows = allProductRows.filter(
    (product) =>
      product.deletedAt == null || referencedProductIds.has(product.id),
  );
  const referencedUserIds = new Set(
    [
      ...prescriptionEventRows.map((event) => event.actorId),
      ...prescriptionRows.map((prescription) => prescription.prescribedBy),
      ...clinicalCorrectionRows.map((correction) => correction.correctedBy),
      ...labReplacementRows.map((replacement) => replacement.actorId),
      ...soapNoteRows.map((note) => note.authorId),
      ...soapNoteRows.map((note) => note.finalizedBy),
      ...soapNoteAddendumRows.map((addendum) => addendum.authorId),
      ...vitalRows.map((vital) => vital.recordedBy),
      ...vaccinationRows.map((vaccination) => vaccination.administeredBy),
      ...labRows.flatMap((result) => [
        result.orderedBy,
        result.reviewedBy,
        result.followUpAssignedTo,
        result.followUpCompletedBy,
      ]),
      ...labResultEventRows.flatMap((event) => [
        event.actorId,
        event.followUpAssignedTo,
      ]),
      ...appointmentRows.map((appointment) => appointment.doctorId),
      ...patientMergeRows.map((event) => event.performedBy),
      ...smsConsentEventRows.map((event) => event.actorUserId),
      ...smsSendAttemptRows.map((attempt) => attempt.requestedByUserId),
      ...smsSendAttemptEventRows.map((event) => event.actorUserId),
    ].filter((id): id is string => typeof id === "string"),
  );
  const userRows = allUserRows.filter(
    (user) => user.deletedAt == null || referencedUserIds.has(user.id),
  );
  const referencedClientIds = new Set(
    [
      ...patientRows.map((patient) => patient.clientId),
      ...appointmentRows.map((appointment) => appointment.clientId),
      ...patientMergeRows.map((event) => event.clientId),
      ...smsConsentEventRows.map((event) => event.clientId),
      ...smsSendAttemptRows.map((attempt) => attempt.clientId),
    ].filter((id): id is string => typeof id === "string"),
  );
  const clientRows = allClientRows.filter(
    (client) => client.deletedAt == null || referencedClientIds.has(client.id),
  );
  const referencedLocationIds = new Set(
    [
      ...productRows.map((product) => product.locationId),
      ...userRows.map((user) => user.locationId),
      ...smsConsentEventRows.map((event) => event.locationId),
      ...smsSendAttemptRows.map((attempt) => attempt.locationId),
      ...allRoomRows.map((room) =>
        appointmentRows.some((appointment) => appointment.roomId === room.id)
          ? room.locationId
          : null,
      ),
    ].filter((id): id is string => typeof id === "string"),
  );
  const locationRows = allLocationRows.filter(
    (location) =>
      location.deletedAt == null || referencedLocationIds.has(location.id),
  );
  const referencedAppointmentTypeIds = new Set(
    appointmentRows
      .map((appointment) => appointment.typeId)
      .filter((id): id is string => typeof id === "string"),
  );
  const appointmentTypeRows = allAppointmentTypeRows.filter(
    (type) =>
      type.deletedAt == null || referencedAppointmentTypeIds.has(type.id),
  );
  const referencedRoomIds = new Set(
    appointmentRows
      .map((appointment) => appointment.roomId)
      .filter((id): id is string => typeof id === "string"),
  );
  const roomRows = allRoomRows.filter(
    (room) => room.deletedAt == null || referencedRoomIds.has(room.id),
  );
  const referencedCommunicationIds = new Set(
    smsSendAttemptRows
      .map((attempt) => attempt.communicationId)
      .filter((id): id is string => typeof id === "string"),
  );
  const communicationRows = allCommunicationRows.filter(
    (communication) =>
      communication.deletedAt == null ||
      referencedCommunicationIds.has(communication.id),
  );
  const referencedRecurringSeriesIds = new Set(
    appointmentRows
      .map((appointment) => appointment.recurringSeriesId)
      .filter((id): id is string => typeof id === "string"),
  );
  const recurringSeriesRows = allRecurringSeriesRows.filter(
    (series) =>
      series.deletedAt == null || referencedRecurringSeriesIds.has(series.id),
  );

  const patientIds = patientRows.map((r) => r.id);
  const invoiceIds = invoiceRows.map((r) => r.id);
  const treatmentTemplateIds = treatmentTemplateRows.map((r) => r.id);
  const caseIds = caseRows.map((r) => r.id);
  const treatmentPlanIds = treatmentPlanRows.map((r) => r.id);

  const [
    patientWeightRows,
    allergyRows,
    itemRows,
    paymentRows,
    adjustmentRows,
    treatmentTemplateItemRows,
    caseEntryRows,
    treatmentPlanItemRows,
  ] = await Promise.all([
    tenantParentChildRows(
      db,
      patientWeights,
      patientWeights.patientId,
      patientIds,
      patients,
      patients.id,
      practiceId,
    ),
    tenantParentChildRows(
      db,
      patientAllergies,
      patientAllergies.patientId,
      patientIds,
      patients,
      patients.id,
      practiceId,
    ),
    tenantParentChildRows(
      db,
      invoiceItems,
      invoiceItems.invoiceId,
      invoiceIds,
      invoices,
      invoices.id,
      practiceId,
    ),
    tenantParentChildRows(
      db,
      payments,
      payments.invoiceId,
      invoiceIds,
      invoices,
      invoices.id,
      practiceId,
    ),
    tenantParentChildRows(
      db,
      invoiceAdjustments,
      invoiceAdjustments.invoiceId,
      invoiceIds,
      invoices,
      invoices.id,
      practiceId,
    ),
    tenantParentChildRows(
      db,
      treatmentTemplateItems,
      treatmentTemplateItems.templateId,
      treatmentTemplateIds,
      treatmentTemplates,
      treatmentTemplates.id,
      practiceId,
    ),
    tenantParentChildRows(
      db,
      caseEntries,
      caseEntries.caseId,
      caseIds,
      cases,
      cases.id,
      practiceId,
    ),
    tenantParentChildRows(
      db,
      treatmentPlanItems,
      treatmentPlanItems.planId,
      treatmentPlanIds,
      treatmentPlans,
      treatmentPlans.id,
      practiceId,
    ),
  ]);

  const sections: Record<PracticeExportSection, unknown[]> = {
    locations: locationRows,
    locationMessaging: locationMessagingRows,
    smsSuppressions: smsSuppressionRows,
    smsConsentEvents: smsConsentEventRows,
    smsSendAttempts: sanitizePracticeExportRows(
      "smsSendAttempts",
      smsSendAttemptRows,
    ),
    smsSendAttemptEvents: sanitizePracticeExportRows(
      "smsSendAttemptEvents",
      smsSendAttemptEventRows,
    ),
    smsDeliveryEvents: smsDeliveryEventRows,
    smsDeliveryEventHistory: sanitizePracticeExportRows(
      "smsDeliveryEventHistory",
      smsDeliveryHistoryRows,
    ),
    emailSuppressions: emailSuppressionRows,
    webhooks: sanitizePracticeExportRows("webhooks", webhookRows),
    apiKeys: sanitizePracticeExportRows("apiKeys", apiKeyRows),
    users: sanitizePracticeExportRows("users", userRows),
    auditLog: sanitizePracticeExportRows("auditLog", auditLogRows),
    appointmentTypes: appointmentTypeRows,
    rooms: roomRows,
    recurringSeries: recurringSeriesRows,
    clients: sanitizePracticeExportRows("clients", clientRows),
    patients: patientRows,
    patientMergeEvents: patientMergeRows,
    insurancePolicies: insurancePolicyRows,
    wellnessPlans: wellnessPlanRows,
    wellnessEnrollments: wellnessEnrollmentRows,
    patientWeights: patientWeightRows,
    patientAllergies: allergyRows,
    appointments: appointmentRows,
    appointmentWaitlist: appointmentWaitlistRows,
    staffSchedules: staffScheduleRows,
    services: serviceRows,
    products: productRows,
    treatmentTemplates: treatmentTemplateRows,
    treatmentTemplateItems: treatmentTemplateItemRows,
    suppliers: supplierRows,
    purchaseOrders: purchaseOrderRows,
    invoices: invoiceRows,
    invoiceItems: itemRows,
    payments: paymentRows,
    invoiceAdjustments: adjustmentRows,
    insuranceClaims: insuranceClaimRows,
    soapNotes: soapNoteRows,
    soapNoteAddenda: soapNoteAddendumRows,
    soapNoteReplacements: soapNoteReplacementRows,
    vaccinationRecords: vaccinationRows,
    labResults: labRows,
    labResultEvents: labResultEventRows,
    procedures: procedureRows,
    clinicalNotes: clinicalNoteRows,
    problemList: problemRows,
    vitalSigns: vitalRows,
    clinicalRecordCorrections: clinicalCorrectionRows,
    labResultReplacements: labReplacementRows,
    cases: caseRows,
    caseEntries: caseEntryRows,
    treatmentPlans: treatmentPlanRows,
    treatmentPlanItems: treatmentPlanItemRows,
    prescriptions: prescriptionRows,
    prescriptionEvents: prescriptionEventRows,
    dispenseChargeQueue: dispenseChargeRows,
    visitCloseouts: visitCloseoutRows,
    files: fileRows,
    controlledSubstanceLog: controlledSubstanceRows,
    communications: communicationRows,
  };

  const exported = {
    formatVersion: PRACTICE_EXPORT_FORMAT_VERSION,
    practiceId,
    exportedAt,
    counts: countsFor(sections),
    ...sections,
  };
  const validation = validatePracticeExportRestore(exported);
  if (!validation.valid) {
    throw new Error(
      `Generated backup failed restore validation: ${validation.errors.join("; ")}`,
    );
  }
  return exported;
}

async function restorePracticeDataRows(
  db: Database,
  practiceId: string,
  data: unknown,
): Promise<{
  restored: Record<PracticeExportSection, number>;
  totalRows: number;
}> {
  const summary = summarizePracticeExport(data);
  if (summary.missingSections.length > 0) {
    throw new Error(
      `Backup is missing required sections: ${summary.missingSections.join(", ")}`,
    );
  }
  const validation = validatePracticeExportRestore(data);
  if (!validation.valid) {
    throw new Error(
      `Backup contains invalid restore data: ${validation.errors.join("; ")}`,
    );
  }
  const backupRecord = isRecord(data) ? data : {};
  const hasDispenseChargeQueue = Object.prototype.hasOwnProperty.call(
    backupRecord,
    "dispenseChargeQueue",
  );
  const dispenseChargeRestoreRows = rowsFor(data, "dispenseChargeQueue");
  const smsConsentRestore = prepareLegacySmsConsentRestore(data);
  const soapNoteRestoreRows = rowsFor(data, "soapNotes").map((row) => {
    const authorName =
      typeof row.authorName === "string" && row.authorName.trim()
        ? row.authorName.trim()
        : row.imported === true
          ? "Imported record"
          : "Restored legacy record";
    const revision =
      typeof row.revision === "number" &&
      Number.isInteger(row.revision) &&
      row.revision > 0
        ? row.revision
        : 1;
    if (row.status === "draft") {
      return {
        ...row,
        authorName,
        status: "draft",
        revision,
        imported: false,
        finalizedAt: null,
        finalizedBy: null,
        finalizerName: null,
      };
    }
    return {
      ...row,
      authorName,
      status: "finalized",
      revision,
      finalizedAt: row.finalizedAt ?? row.createdAt ?? row.updatedAt,
      finalizedBy: row.finalizedBy ?? row.authorId,
      finalizerName:
        typeof row.finalizerName === "string" && row.finalizerName.trim()
          ? row.finalizerName.trim()
          : authorName,
    };
  });
  const labResultRestoreRows = rowsFor(data, "labResults").map((row) => {
    const fallbackTime = row.updatedAt ?? row.createdAt;
    const hasResult =
      typeof row.resultValue === "string" && row.resultValue.trim().length > 0;
    let normalizedStatus =
      row.status === "pending" && hasResult
        ? "completed"
        : (row.status === "completed" || row.status === "reviewed") &&
            !hasResult
          ? "pending"
          : row.status === "reviewed" &&
              (typeof row.reviewedBy !== "string" || !row.reviewedBy)
            ? "completed"
            : row.status;
    const criticalFollowUpWithoutDue =
      row.resultFlag === "critical" &&
      (row.followUpStatus === "open" || row.followUpStatus === "completed") &&
      row.followUpDueAt == null;
    const clearFollowUp =
      normalizedStatus === "pending" || criticalFollowUpWithoutDue;
    const normalizedFollowUp = clearFollowUp
      ? {
          followUpStatus: "not_required",
          followUpAssignedTo: null,
          followUpDueAt: null,
          followUpNote: null,
          followUpCompletedBy: null,
          followUpCompletedAt: null,
          followUpOutcome: null,
        }
      : {};
    const effectiveFollowUpStatus = clearFollowUp
      ? "not_required"
      : (row.followUpStatus ?? "not_required");
    if (
      normalizedStatus === "reviewed" &&
      row.resultFlag === "critical" &&
      effectiveFollowUpStatus === "not_required"
    ) {
      normalizedStatus = "completed";
    }
    if (normalizedStatus === "reviewed") {
      return {
        ...row,
        ...normalizedFollowUp,
        status: "reviewed",
        completedAt: row.completedAt ?? fallbackTime,
        reviewedAt: row.reviewedAt ?? fallbackTime,
      };
    }
    if (normalizedStatus === "completed") {
      return {
        ...row,
        ...normalizedFollowUp,
        status: "completed",
        completedAt: row.completedAt ?? fallbackTime,
        reviewedAt: null,
        reviewedBy: null,
      };
    }
    return {
      ...row,
      status: "pending",
      resultValue: null,
      unit: null,
      referenceRangeLow: null,
      referenceRangeHigh: null,
      resultFlag: "unknown",
      completedAt: null,
      reviewedAt: null,
      reviewedBy: null,
      followUpStatus: "not_required",
      followUpAssignedTo: null,
      followUpDueAt: null,
      followUpNote: null,
      followUpCompletedBy: null,
      followUpCompletedAt: null,
      followUpOutcome: null,
    };
  });

  const restored = {} as Record<PracticeExportSection, number>;
  const restorePracticeRows = async (
    section: PracticeExportSection,
    table: any,
  ) => {
    restored[section] = await restoreRows(
      db,
      table,
      section,
      rowsFor(data, section),
      {
        practiceId,
      },
    );
  };
  const restoreChildRows = async (
    section: PracticeExportSection,
    table: any,
  ) => {
    restored[section] = await restoreRows(
      db,
      table,
      section,
      rowsFor(data, section),
    );
  };

  await restorePracticeRows("locations", locations);
  await restorePracticeRows("locationMessaging", locationMessaging);
  await restorePracticeRows("smsSuppressions", smsSuppressions);
  await restorePracticeRows("emailSuppressions", emailSuppressions);
  await restorePracticeRows("webhooks", webhooks);
  await restorePracticeRows("apiKeys", apiKeys);
  restored.users = await restoreRows(
    db,
    users,
    "users",
    rowsFor(data, "users").map((row) => ({
      ...row,
      // Backups written before provider capability was separated from role
      // still restore veterinarian-role users as schedulable providers.
      isVeterinarian:
        row.isVeterinarian === true ||
        (row.isVeterinarian == null && row.role === "veterinarian"),
    })),
    { practiceId },
  );
  await restorePracticeRows("auditLog", auditLog);
  await restorePracticeRows("appointmentTypes", appointmentTypes);
  await restorePracticeRows("rooms", rooms);
  await restorePracticeRows("recurringSeries", recurringSeries);
  restored.clients = await restoreRows(
    db,
    clients,
    "clients",
    smsConsentRestore.clients,
    { practiceId },
  );
  restored.smsConsentEvents = await restoreRows(
    db,
    smsConsentEvents,
    "smsConsentEvents",
    smsConsentRestore.smsConsentEvents,
    { practiceId },
  );
  await restorePracticeRows("patients", patients);
  await restorePracticeRows("patientMergeEvents", patientMergeEvents);
  await restorePracticeRows("insurancePolicies", insurancePolicies);
  await restorePracticeRows("wellnessPlans", wellnessPlans);
  await restorePracticeRows("wellnessEnrollments", wellnessEnrollments);
  await restoreChildRows("patientWeights", patientWeights);
  await restoreChildRows("patientAllergies", patientAllergies);
  await restorePracticeRows("appointments", appointments);
  await restorePracticeRows("appointmentWaitlist", appointmentWaitlist);
  await restorePracticeRows("staffSchedules", staffSchedules);
  await restorePracticeRows("services", services);
  await restorePracticeRows("products", products);
  await restorePracticeRows("treatmentTemplates", treatmentTemplates);
  await restoreChildRows("treatmentTemplateItems", treatmentTemplateItems);
  await restorePracticeRows("suppliers", suppliers);
  await restorePracticeRows("purchaseOrders", purchaseOrders);
  await restorePracticeRows("invoices", invoices);
  const invoiceItemRestoreRows = rowsFor(data, "invoiceItems");
  restored.invoiceItems = await restoreRows(
    db,
    invoiceItems,
    "invoiceItems",
    hasDispenseChargeQueue
      ? invoiceItemRestoreRows.map((row) => ({
          ...row,
          sourceDispenseChargeId: null,
        }))
      : invoiceItemRestoreRows,
  );
  await restoreChildRows("payments", payments);
  await restoreChildRows("invoiceAdjustments", invoiceAdjustments);
  await restorePracticeRows("insuranceClaims", insuranceClaims);
  await restorePracticeRows("problemList", problemList);
  restored.soapNotes = await restoreRows(
    db,
    soapNotes,
    "soapNotes",
    soapNoteRestoreRows,
    { practiceId },
  );
  await restorePracticeRows("vaccinationRecords", vaccinationRecords);
  restored.labResults = await restoreRows(
    db,
    labResults,
    "labResults",
    labResultRestoreRows,
    { practiceId },
  );
  await restorePracticeRows("labResultEvents", labResultEvents);
  await restorePracticeRows("procedures", procedures);
  await restorePracticeRows("clinicalNotes", clinicalNotes);
  await restorePracticeRows("vitalSigns", vitalSigns);
  await restorePracticeRows(
    "clinicalRecordCorrections",
    clinicalRecordCorrections,
  );
  restored.soapNoteAddenda = 0;
  for (const row of coerceRowDates(
    soapNoteAddenda,
    rowsFor(data, "soapNoteAddenda"),
  )) {
    if (
      typeof row.id !== "string" ||
      !(row.createdAt instanceof Date) ||
      typeof row.soapNoteId !== "string" ||
      typeof row.authorId !== "string" ||
      typeof row.authorName !== "string" ||
      typeof row.content !== "string" ||
      typeof row.operationId !== "string" ||
      typeof row.operationPayloadHash !== "string"
    ) {
      throw new Error("Backup contains an invalid SOAP addendum row.");
    }
    const restoreResult = await db.execute(sql`
      select result_id, was_inserted
      from public.restore_soap_note_addendum(
      ${row.id}::uuid,
      ${row.createdAt},
      ${practiceId}::uuid,
      ${row.soapNoteId}::uuid,
      ${row.authorId}::uuid,
      ${row.authorName},
      ${row.content},
      ${row.operationId}::uuid,
      ${row.operationPayloadHash}
    )`);
    const [outcome] = rowsFromExecute<{
      result_id: string;
      was_inserted: boolean;
    }>(restoreResult);
    if (!outcome || outcome.result_id !== row.id) {
      throw new Error("SOAP addendum restore returned invalid evidence.");
    }
    if (outcome.was_inserted) restored.soapNoteAddenda += 1;
  }
  restored.soapNoteReplacements = 0;
  for (const row of coerceRowDates(
    soapNoteReplacements,
    rowsFor(data, "soapNoteReplacements"),
  )) {
    if (
      typeof row.id !== "string" ||
      !(row.createdAt instanceof Date) ||
      typeof row.correctionId !== "string" ||
      typeof row.sourceSoapNoteId !== "string" ||
      typeof row.replacementSoapNoteId !== "string" ||
      typeof row.actorId !== "string" ||
      typeof row.actorName !== "string" ||
      typeof row.operationId !== "string" ||
      typeof row.operationPayloadHash !== "string"
    ) {
      throw new Error("Backup contains an invalid SOAP replacement row.");
    }
    const restoreResult = await db.execute(sql`
      select result_id, was_inserted
      from public.restore_soap_note_replacement(
        ${row.id}::uuid,
        ${row.createdAt},
        ${practiceId}::uuid,
        ${row.correctionId}::uuid,
        ${row.sourceSoapNoteId}::uuid,
        ${row.replacementSoapNoteId}::uuid,
        ${row.actorId}::uuid,
        ${row.actorName},
        ${row.operationId}::uuid,
        ${row.operationPayloadHash}
      )
    `);
    const [outcome] = rowsFromExecute<{
      result_id: string;
      was_inserted: boolean;
    }>(restoreResult);
    if (!outcome || outcome.result_id !== row.id) {
      throw new Error("SOAP replacement restore returned invalid evidence.");
    }
    if (outcome.was_inserted) restored.soapNoteReplacements += 1;
  }
  await restorePracticeRows("labResultReplacements", labResultReplacements);
  await restorePracticeRows("cases", cases);
  await restoreChildRows("caseEntries", caseEntries);
  await restorePracticeRows("treatmentPlans", treatmentPlans);
  await restoreChildRows("treatmentPlanItems", treatmentPlanItems);
  await restorePracticeRows("prescriptions", prescriptions);
  const prescriptionEventRows = Object.prototype.hasOwnProperty.call(
    backupRecord,
    "prescriptionEvents",
  )
    ? rowsFor(data, "prescriptionEvents")
    : synthesizeLegacyPrescriptionEvents(data);
  restored.prescriptionEvents = await restoreRows(
    db,
    prescriptionEvents,
    "prescriptionEvents",
    prescriptionEventRows,
    { practiceId },
  );
  // Restore every queue row as pending first. Invoiced rows form an intentional
  // cycle with invoice_items, and the database protection trigger should see
  // the exact active source line before accepting their final status.
  restored.dispenseChargeQueue = await restoreRows(
    db,
    dispenseChargeQueue,
    "dispenseChargeQueue",
    dispenseChargeRestoreRows.map((row) => ({
      ...row,
      status: "pending",
      invoiceId: null,
      invoiceItemId: null,
      resolvedBy: null,
      resolvedByName: null,
      resolvedAt: null,
      resolutionReason: null,
    })),
    { practiceId },
  );
  if (hasDispenseChargeQueue) {
    for (const row of invoiceItemRestoreRows) {
      if (
        typeof row.id === "string" &&
        typeof row.sourceDispenseChargeId === "string"
      ) {
        await db
          .update(invoiceItems)
          .set({ sourceDispenseChargeId: row.sourceDispenseChargeId })
          .where(eq(invoiceItems.id, row.id));
      }
    }
    for (const row of coerceRowDates(
      dispenseChargeQueue,
      dispenseChargeRestoreRows,
    )) {
      if (
        typeof row.id !== "string" ||
        (row.status !== "invoiced" && row.status !== "waived")
      ) {
        continue;
      }
      await db
        .update(dispenseChargeQueue)
        .set({
          status: row.status,
          invoiceId: typeof row.invoiceId === "string" ? row.invoiceId : null,
          invoiceItemId:
            typeof row.invoiceItemId === "string" ? row.invoiceItemId : null,
          resolvedBy:
            typeof row.resolvedBy === "string" ? row.resolvedBy : null,
          resolvedByName:
            typeof row.resolvedByName === "string" ? row.resolvedByName : null,
          resolvedAt: row.resolvedAt instanceof Date ? row.resolvedAt : null,
          resolutionReason:
            typeof row.resolutionReason === "string"
              ? row.resolutionReason
              : null,
          updatedAt: row.updatedAt instanceof Date ? row.updatedAt : new Date(),
        })
        .where(
          and(
            eq(dispenseChargeQueue.id, row.id),
            eq(dispenseChargeQueue.practiceId, practiceId),
          ),
        );
    }
  }
  await restorePracticeRows("visitCloseouts", visitCloseouts);
  await restorePracticeRows("files", files);
  await restorePracticeRows("controlledSubstanceLog", controlledSubstanceLog);
  await restorePracticeRows("communications", communications);
  // Provider callback evidence is exported for clinic audit/portability, but
  // it is environment-bound global system state. Ordinary clinic restore must
  // never recreate provider identities or operator history; same-install
  // disaster recovery uses the owner-maintenance database path instead.
  restored.smsDeliveryEvents = 0;
  restored.smsDeliveryEventHistory = 0;
  restored.smsSendAttempts = 0;
  restored.smsSendAttemptEvents = 0;

  return {
    restored,
    totalRows: Object.values(restored).reduce((sum, count) => sum + count, 0),
  };
}

export async function restorePracticeData(
  db: Database,
  practiceId: string,
  data: unknown,
): Promise<{
  restored: Record<PracticeExportSection, number>;
  totalRows: number;
}> {
  const transaction = (
    db as unknown as {
      transaction?: (
        fn: (tx: unknown) => Promise<{
          restored: Record<PracticeExportSection, number>;
          totalRows: number;
        }>,
      ) => Promise<{
        restored: Record<PracticeExportSection, number>;
        totalRows: number;
      }>;
    }
  ).transaction;

  if (typeof transaction === "function") {
    return transaction.call(db, (tx) =>
      restorePracticeDataRows(tx as Database, practiceId, data),
    );
  }

  return restorePracticeDataRows(db, practiceId, data);
}
