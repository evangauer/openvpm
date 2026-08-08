import { eq, and, isNull, inArray, sql, getTableColumns } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Database } from "@openpims/db/client";
import { redactSecrets } from "@/lib/audit";
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
  emailSuppressions,
  files,
  invoiceAdjustments,
  invoiceItems,
  invoices,
  insuranceClaims,
  insurancePolicies,
  labResults,
  locationMessaging,
  locations,
  patientAllergies,
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
  smsSuppressions,
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
  rateLimitBuckets: "Transient abuse-control buckets, not clinic-owned data.",
  sessions: "Transient authentication sessions.",
  verificationTokens: "Transient authentication verification tokens.",
  authTokens: "Expiring pre-tenant email verification and password-reset tokens.",
  captureSessions:
    "Expiring QR photo-capture link tokens; restoring them would resurrect old capture URLs. The photos themselves are in the files section.",
  consentRequests:
    "Expiring e-sign link tokens; the signed consent PDF is in the files section and the signing event is in the audit log.",
  messagingRegistrations:
    "Encrypted tax identity plus live carrier brand/campaign state. It is environment-bound, may be undecryptable under another key, and must never bind a restored clone to the real SMS provider. Recover it only through operational database disaster recovery.",
} as const;

export const PRACTICE_EXPORT_SECRET_REPLACEMENTS = {
  passwordHash:
    "$2a$12$HNkF00edpp2mYk2gvvj8ne/PWjlXwgT5YZhAodh0/UVgTgtIPdnWS",
  apiKeyPrefix: "disabled",
  apiKeyHash:
    "$2a$12$HNkF00edpp2mYk2gvvj8ne/PWjlXwgT5YZhAodh0/UVgTgtIPdnWS",
  webhookSecret: "rotate-after-restore",
} as const;

export const PRACTICE_EXPORT_SECTIONS = [
  "locations",
  "locationMessaging",
  "smsSuppressions",
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
  "vaccinationRecords",
  "labResults",
  "procedures",
  "clinicalNotes",
  "problemList",
  "vitalSigns",
  "clinicalRecordCorrections",
  "cases",
  "caseEntries",
  "treatmentPlans",
  "treatmentPlanItems",
  "prescriptions",
  "prescriptionEvents",
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
  "visitCloseouts",
  "clinicalRecordCorrections",
] as const satisfies readonly PracticeExportSection[];

export type PracticeExport = {
  practiceId: string;
  exportedAt: string;
  counts: Record<PracticeExportSection, number>;
} & Record<PracticeExportSection, unknown[]>;

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
  rows: Row[]
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
  parentSection: PracticeExportSection
): RestoreReferenceRule {
  return { section, field, parentSection, required: true };
}

function optionalRef(
  section: PracticeExportSection,
  field: string,
  parentSection: PracticeExportSection
): RestoreReferenceRule {
  return { section, field, parentSection };
}

const RESTORE_REFERENCE_RULES: RestoreReferenceRule[] = [
  requiredRef("locationMessaging", "locationId", "locations"),
  optionalRef("smsSuppressions", "locationId", "locations"),
  optionalRef("users", "locationId", "locations"),
  optionalRef("rooms", "locationId", "locations"),
  requiredRef("patients", "clientId", "clients"),
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
  requiredRef("vaccinationRecords", "patientId", "patients"),
  optionalRef("vaccinationRecords", "administeredBy", "users"),
  requiredRef("labResults", "patientId", "patients"),
  optionalRef("labResults", "appointmentId", "appointments"),
  optionalRef("labResults", "orderedBy", "users"),
  optionalRef("labResults", "reviewedBy", "users"),
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
  optionalRef(
    "clinicalRecordCorrections",
    "appointmentId",
    "appointments"
  ),
  requiredRef("clinicalRecordCorrections", "correctedBy", "users"),
  optionalRef("clinicalRecordCorrections", "soapNoteId", "soapNotes"),
  optionalRef("clinicalRecordCorrections", "vitalSignId", "vitalSigns"),
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

function countsFor(sections: Record<PracticeExportSection, unknown[]>): Record<PracticeExportSection, number> {
  return Object.fromEntries(
    PRACTICE_EXPORT_SECTIONS.map((section) => [
      section,
      sections[section].length,
    ])
  ) as Record<PracticeExportSection, number>;
}

export function summarizePracticeExport(data: unknown): {
  counts: Record<PracticeExportSection, number>;
  missingSections: PracticeExportSection[];
  totalRows: number;
} {
  const record = isRecord(data) ? data : {};
  const missingSections = PRACTICE_EXPORT_SECTIONS.filter(
    (section) => {
      if (Array.isArray(record[section])) return false;
      const isBackwardCompatibleAbsence =
        !Object.prototype.hasOwnProperty.call(record, section) &&
        PRACTICE_EXPORT_OPTIONAL_RESTORE_SECTIONS.includes(section as never);
      return !isBackwardCompatibleAbsence;
    },
  );
  const counts = Object.fromEntries(
    PRACTICE_EXPORT_SECTIONS.map((section) => [
      section,
      rowsFor(record, section).length,
    ])
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

function validateRestoreRows(data: unknown, pushError: (message: string) => void) {
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
          .filter((id): id is string => typeof id === "string" && id.length > 0)
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
            `${rule.section}[${rowLabel(row, index)}].${rule.field} is required.`
          );
        }
        return;
      }

      if (typeof value !== "string") {
        pushError(
          `${rule.section}[${rowLabel(row, index)}].${rule.field} must be a string id.`
        );
        return;
      }

      if (!ids.has(value)) {
        pushError(
          `${rule.section}[${rowLabel(row, index)}].${rule.field} references missing ${rule.parentSection} row "${value}".`
        );
      }
    });
  }

  const rowsById = (section: PracticeExportSection) =>
    new Map(
      rowsFor(data, section)
        .filter((row): row is Row & { id: string } =>
          Boolean(typeof row.id === "string" && row.id.length > 0)
        )
        .map((row) => [row.id, row])
    );
  const appointmentRows = rowsById("appointments");

  for (const section of ["soapNotes", "vitalSigns"] as const) {
    rowsFor(data, section).forEach((row, index) => {
      if (typeof row.appointmentId !== "string") return;
      const appointment = appointmentRows.get(row.appointmentId);
      if (!appointment) return;

      if (appointment.patientId !== row.patientId) {
        pushError(
          `${section}[${rowLabel(row, index)}].appointmentId must reference an appointment for the same patient.`
        );
      }
    });
  }

  const record = isRecord(data) ? data : {};
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

  const soapRows = rowsById("soapNotes");
  const vitalRows = rowsById("vitalSigns");
  rowsFor(data, "clinicalRecordCorrections").forEach((row, index) => {
    const label = `clinicalRecordCorrections[${rowLabel(row, index)}]`;
    let source: Row | undefined;

    if (row.recordType === "soap_note") {
      if (typeof row.soapNoteId !== "string" || row.soapNoteId.length === 0) {
        pushError(`${label}.soapNoteId is required for recordType soap_note.`);
        return;
      }
      if (row.vitalSignId != null) {
        pushError(`${label}.vitalSignId must be null for recordType soap_note.`);
        return;
      }
      source = soapRows.get(row.soapNoteId);
    } else if (row.recordType === "vital_sign") {
      if (
        typeof row.vitalSignId !== "string" ||
        row.vitalSignId.length === 0
      ) {
        pushError(
          `${label}.vitalSignId is required for recordType vital_sign.`
        );
        return;
      }
      if (row.soapNoteId != null) {
        pushError(`${label}.soapNoteId must be null for recordType vital_sign.`);
        return;
      }
      source = vitalRows.get(row.vitalSignId);
    } else {
      pushError(`${label}.recordType must be soap_note or vital_sign.`);
      return;
    }

    if (!source) return;

    const correctionAppointmentId = row.appointmentId ?? null;
    const sourceAppointmentId = source.appointmentId ?? null;
    if (
      source.patientId !== row.patientId ||
      sourceAppointmentId !== correctionAppointmentId
    ) {
      pushError(
        `${label} must match its source record patientId and appointmentId exactly.`
      );
    }
  });

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
  practiceId: string
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
        isNull(table.deletedAt)
      )
    );
}

/**
 * Backups round-trip through JSON, so timestamp values arrive as ISO strings
 * while the drizzle timestamp columns expect Date objects on insert. Coerce
 * per-table so a real backup file is directly restorable.
 */
export function coerceRowDates(table: any, rows: Row[]): Row[] {
  const dateColumns = Object.entries(getTableColumns(table))
    .filter(([, column]) => (column as { dataType?: string }).dataType === "date")
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
  opts: { practiceId?: string } = {}
): Promise<number> {
  if (rows.length === 0) return 0;
  const sanitizedRows = coerceRowDates(
    table,
    sanitizePracticeExportRows(section, rows)
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
  exportedAt: string
): Promise<PracticeExport> {
  const [
    allLocationRows,
    locationMessagingRows,
    smsSuppressionRows,
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
    vaccinationRows,
    labRows,
    procedureRows,
    clinicalNoteRows,
    problemRows,
    allVitalRows,
    clinicalCorrectionRows,
    caseRows,
    treatmentPlanRows,
    allPrescriptionRows,
    prescriptionEventRows,
    visitCloseoutRows,
    fileRows,
    controlledSubstanceRows,
    communicationRows,
  ] = await Promise.all([
    allPracticeRows(db, locations, practiceId),
    activeRows(db, locationMessaging, practiceId),
    activeRows(db, smsSuppressions, practiceId),
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
    activeRows(db, vaccinationRecords, practiceId),
    activeRows(db, labResults, practiceId),
    activeRows(db, procedures, practiceId),
    activeRows(db, clinicalNotes, practiceId),
    activeRows(db, problemList, practiceId),
    allPracticeRows(db, vitalSigns, practiceId),
    allPracticeRows(db, clinicalRecordCorrections, practiceId),
    activeRows(db, cases, practiceId),
    activeRows(db, treatmentPlans, practiceId),
    allPracticeRows(db, prescriptions, practiceId),
    allPracticeRows(db, prescriptionEvents, practiceId),
    activeRows(db, visitCloseouts, practiceId),
    activeRows(db, files, practiceId),
    activeRows(db, controlledSubstanceLog, practiceId),
    activeRows(db, communications, practiceId),
  ]);

  const referencedPrescriptionIds = new Set(
    prescriptionEventRows.map((event) => event.prescriptionId),
  );
  const prescriptionRows = allPrescriptionRows.filter(
    (prescription) =>
      prescription.deletedAt == null ||
      referencedPrescriptionIds.has(prescription.id),
  );
  const referencedSoapNoteIds = new Set(
    clinicalCorrectionRows
      .map((correction) => correction.soapNoteId)
      .filter((id): id is string => typeof id === "string"),
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
  const referencedAppointmentIds = new Set(
    [
      ...prescriptionRows.map((prescription) => prescription.appointmentId),
      ...clinicalCorrectionRows.map((correction) => correction.appointmentId),
      ...soapNoteRows.map((note) => note.appointmentId),
      ...vitalRows.map((vital) => vital.appointmentId),
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
      ...appointmentRows.map((appointment) => appointment.patientId),
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
      ...soapNoteRows.map((note) => note.authorId),
      ...vitalRows.map((vital) => vital.recordedBy),
      ...appointmentRows.map((appointment) => appointment.doctorId),
    ].filter((id): id is string => typeof id === "string"),
  );
  const userRows = allUserRows.filter(
    (user) => user.deletedAt == null || referencedUserIds.has(user.id),
  );
  const referencedClientIds = new Set(
    [
      ...patientRows.map((patient) => patient.clientId),
      ...appointmentRows.map((appointment) => appointment.clientId),
    ].filter((id): id is string => typeof id === "string"),
  );
  const clientRows = allClientRows.filter(
    (client) =>
      client.deletedAt == null || referencedClientIds.has(client.id),
  );
  const referencedLocationIds = new Set(
    [
      ...productRows.map((product) => product.locationId),
      ...userRows.map((user) => user.locationId),
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
      practiceId
    ),
    tenantParentChildRows(
      db,
      patientAllergies,
      patientAllergies.patientId,
      patientIds,
      patients,
      patients.id,
      practiceId
    ),
    tenantParentChildRows(
      db,
      invoiceItems,
      invoiceItems.invoiceId,
      invoiceIds,
      invoices,
      invoices.id,
      practiceId
    ),
    tenantParentChildRows(
      db,
      payments,
      payments.invoiceId,
      invoiceIds,
      invoices,
      invoices.id,
      practiceId
    ),
    tenantParentChildRows(
      db,
      invoiceAdjustments,
      invoiceAdjustments.invoiceId,
      invoiceIds,
      invoices,
      invoices.id,
      practiceId
    ),
    tenantParentChildRows(
      db,
      treatmentTemplateItems,
      treatmentTemplateItems.templateId,
      treatmentTemplateIds,
      treatmentTemplates,
      treatmentTemplates.id,
      practiceId
    ),
    tenantParentChildRows(
      db,
      caseEntries,
      caseEntries.caseId,
      caseIds,
      cases,
      cases.id,
      practiceId
    ),
    tenantParentChildRows(
      db,
      treatmentPlanItems,
      treatmentPlanItems.planId,
      treatmentPlanIds,
      treatmentPlans,
      treatmentPlans.id,
      practiceId
    ),
  ]);

  const sections: Record<PracticeExportSection, unknown[]> = {
    locations: locationRows,
    locationMessaging: locationMessagingRows,
    smsSuppressions: smsSuppressionRows,
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
    vaccinationRecords: vaccinationRows,
    labResults: labRows,
    procedures: procedureRows,
    clinicalNotes: clinicalNoteRows,
    problemList: problemRows,
    vitalSigns: vitalRows,
    clinicalRecordCorrections: clinicalCorrectionRows,
    cases: caseRows,
    caseEntries: caseEntryRows,
    treatmentPlans: treatmentPlanRows,
    treatmentPlanItems: treatmentPlanItemRows,
    prescriptions: prescriptionRows,
    prescriptionEvents: prescriptionEventRows,
    visitCloseouts: visitCloseoutRows,
    files: fileRows,
    controlledSubstanceLog: controlledSubstanceRows,
    communications: communicationRows,
  };

  const exported = {
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
  data: unknown
): Promise<{ restored: Record<PracticeExportSection, number>; totalRows: number }> {
  const summary = summarizePracticeExport(data);
  if (summary.missingSections.length > 0) {
    throw new Error(
      `Backup is missing required sections: ${summary.missingSections.join(", ")}`
    );
  }
  const validation = validatePracticeExportRestore(data);
  if (!validation.valid) {
    throw new Error(
      `Backup contains invalid restore data: ${validation.errors.join("; ")}`
    );
  }

  const restored = {} as Record<PracticeExportSection, number>;
  const restorePracticeRows = async (section: PracticeExportSection, table: any) => {
    restored[section] = await restoreRows(db, table, section, rowsFor(data, section), {
      practiceId,
    });
  };
  const restoreChildRows = async (section: PracticeExportSection, table: any) => {
    restored[section] = await restoreRows(db, table, section, rowsFor(data, section));
  };

  await restorePracticeRows("locations", locations);
  await restorePracticeRows("locationMessaging", locationMessaging);
  await restorePracticeRows("smsSuppressions", smsSuppressions);
  await restorePracticeRows("emailSuppressions", emailSuppressions);
  await restorePracticeRows("webhooks", webhooks);
  await restorePracticeRows("apiKeys", apiKeys);
  await restorePracticeRows("users", users);
  await restorePracticeRows("auditLog", auditLog);
  await restorePracticeRows("appointmentTypes", appointmentTypes);
  await restorePracticeRows("rooms", rooms);
  await restorePracticeRows("recurringSeries", recurringSeries);
  await restorePracticeRows("clients", clients);
  await restorePracticeRows("patients", patients);
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
  await restoreChildRows("invoiceItems", invoiceItems);
  await restoreChildRows("payments", payments);
  await restoreChildRows("invoiceAdjustments", invoiceAdjustments);
  await restorePracticeRows("insuranceClaims", insuranceClaims);
  await restorePracticeRows("problemList", problemList);
  await restorePracticeRows("soapNotes", soapNotes);
  await restorePracticeRows("vaccinationRecords", vaccinationRecords);
  await restorePracticeRows("labResults", labResults);
  await restorePracticeRows("procedures", procedures);
  await restorePracticeRows("clinicalNotes", clinicalNotes);
  await restorePracticeRows("vitalSigns", vitalSigns);
  await restorePracticeRows(
    "clinicalRecordCorrections",
    clinicalRecordCorrections
  );
  await restorePracticeRows("cases", cases);
  await restoreChildRows("caseEntries", caseEntries);
  await restorePracticeRows("treatmentPlans", treatmentPlans);
  await restoreChildRows("treatmentPlanItems", treatmentPlanItems);
  await restorePracticeRows("prescriptions", prescriptions);
  const backupRecord = isRecord(data) ? data : {};
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
  await restorePracticeRows("visitCloseouts", visitCloseouts);
  await restorePracticeRows("files", files);
  await restorePracticeRows("controlledSubstanceLog", controlledSubstanceLog);
  await restorePracticeRows("communications", communications);

  return {
    restored,
    totalRows: Object.values(restored).reduce((sum, count) => sum + count, 0),
  };
}

export async function restorePracticeData(
  db: Database,
  practiceId: string,
  data: unknown
): Promise<{ restored: Record<PracticeExportSection, number>; totalRows: number }> {
  const transaction = (db as unknown as {
    transaction?: (
      fn: (tx: unknown) => Promise<{
        restored: Record<PracticeExportSection, number>;
        totalRows: number;
      }>
    ) => Promise<{
      restored: Record<PracticeExportSection, number>;
      totalRows: number;
    }>;
  }).transaction;

  if (typeof transaction === "function") {
    return transaction.call(db, (tx) =>
      restorePracticeDataRows(tx as Database, practiceId, data)
    );
  }

  return restorePracticeDataRows(db, practiceId, data);
}
