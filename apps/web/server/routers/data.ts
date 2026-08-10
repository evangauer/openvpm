import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq, and, isNull, inArray, sql } from "drizzle-orm";
import { createRouter, protectedProcedure, requireRole } from "../trpc";
import {
  clients,
  patients,
  appointments,
  appointmentTypes,
  invoices,
  invoiceItems,
  practices,
  users,
  vaccinationRecords,
  soapNotes,
} from "@openpims/db";
import type { Database } from "@openpims/db/client";
import {
  type ClientImportRecord,
  type PatientImportRecord,
  type VaccinationImportRecord,
  type SoapNoteImportRecord,
  csvToClientRecords,
  csvToPatientRecords,
  csvToVaccinationRecords,
  csvToSoapNoteRecords,
} from "@/lib/csv/import";
import {
  SOAP_SECTION_MAX_LENGTH,
  hasSoapContent,
} from "@/lib/records/soap-content";
import { finalizedSoapInsertValues } from "@/lib/records/soap-lifecycle";
import {
  exportPracticeData,
  restorePracticeData,
  summarizePracticeExport,
  validatePracticeFileRestoreTarget,
  validatePracticeExportRestore,
} from "@/lib/backup/export";
import {
  PRACTICE_BACKUP_JSON_SIZE_MESSAGE,
  isPracticeBackupJsonSizeValid,
} from "@/lib/backup/policy";
import {
  IMPORT_CSV_MAX_BYTES,
  IMPORT_MAX_ROWS,
  isImportCsvSizeValid,
} from "@/lib/import/policy";
import { MIGRATION_SOURCE_PATTERN } from "@/lib/import/sources";
import { clinicalDateInput } from "@/lib/records/clinical-inputs";
import {
  MigrationPreviewError,
  claimMigrationPreview,
  completeMigrationRun,
  createMigrationPreview,
  lockMigrationPractice,
  type MigrationClaimResult,
  type MigrationPreviewSummary,
  type MigrationReviewedDisposition,
  type MigrationReviewedPlan,
  type MigrationReviewedTarget,
  type MigrationRunMode,
} from "@/lib/import/run-ledger";
import {
  recordActivationAfterAppointmentCreated,
  recordActivationAfterClientCreated,
} from "@/lib/funnel-events-server";
import { migrationImportFingerprint } from "@/lib/import/fingerprint";

const adminProcedure = protectedProcedure.use(requireRole("admin"));
export { IMPORT_CSV_MAX_BYTES, IMPORT_MAX_ROWS } from "@/lib/import/policy";

type ClientImportRow = Omit<typeof clients.$inferInsert, "practiceId">;
type PatientImportRow = Omit<typeof patients.$inferInsert, "practiceId">;
type VaccinationImportRow = Omit<
  typeof vaccinationRecords.$inferInsert,
  "practiceId"
>;
// authorId is stamped in the mutation (the importing admin); historical
// imports have no OpenVPM author of their own.
type SoapNoteImportRow = {
  patientId: string;
  appointmentId: null;
  subjective: string | null;
  objective: string | null;
  assessment: string | null;
  plan: string | null;
  createdAt: Date;
  importFingerprint: string;
};
type DataContext = {
  db: Database;
  practiceId: string;
};

const importSpeciesInput = z.enum([
  "canine",
  "feline",
  "avian",
  "rabbit",
  "reptile",
  "equine",
  "other",
]);
const importSexInput = z
  .enum(["male", "female", "male_neutered", "female_spayed"])
  .optional();
const importRequiredText = (label: string, maxLength: number) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required.`)
    .max(maxLength, `${label} must be at most ${maxLength} characters.`);
const importOptionalText = (label: string, maxLength: number) =>
  z
    .string()
    .trim()
    .max(maxLength, `${label} must be at most ${maxLength} characters.`)
    .optional()
    .transform((value) => value || undefined);
const importOptionalEmail = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() || undefined : value),
  z.string().trim().email().max(255).optional(),
);
const importOptionalDate = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() || undefined : value),
  clinicalDateInput("Date of birth").optional(),
);
const importOptionalDueDate = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() || undefined : value),
  clinicalDateInput("Next due date").optional(),
);
const importOptionalExternalId = importOptionalText("External ID", 160);
const importSourceInput = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    MIGRATION_SOURCE_PATTERN,
    "Import source must use letters, numbers, underscores, or hyphens.",
  )
  .default("other");
const clientImportRecordInput = z.object({
  externalClientId: importOptionalExternalId,
  firstName: importRequiredText("First name", 128),
  lastName: importRequiredText("Last name", 128),
  email: importOptionalEmail,
  phone: importOptionalText("Phone", 32),
  address: importOptionalText("Address", 500),
  city: importOptionalText("City", 128),
  state: importOptionalText("State", 64),
  zip: importOptionalText("ZIP", 16),
});
const patientImportRecordInput = z
  .object({
    clientEmail: importOptionalEmail,
    externalClientId: importOptionalExternalId,
    externalPatientId: importOptionalExternalId,
    name: importRequiredText("Patient name", 128),
    species: importSpeciesInput,
    breed: importOptionalText("Breed", 128),
    sex: importSexInput,
    dob: importOptionalDate,
    color: importOptionalText("Color", 64),
    microchipNumber: importOptionalText("Microchip number", 64),
  })
  .refine((record) => record.clientEmail || record.externalClientId, {
    message: "An owner email or external owner ID is required.",
  });
const clientImportRecordsInput = z
  .array(clientImportRecordInput)
  .max(
    IMPORT_MAX_ROWS,
    `Client imports can include at most ${IMPORT_MAX_ROWS} rows.`,
  );
const patientImportRecordsInput = z
  .array(patientImportRecordInput)
  .max(
    IMPORT_MAX_ROWS,
    `Patient imports can include at most ${IMPORT_MAX_ROWS} rows.`,
  );
const clientJsonImportRecordInput = clientImportRecordInput.omit({
  externalClientId: true,
});
const patientJsonImportRecordInput = z.object({
  clientEmail: z.string().trim().email().max(255),
  name: importRequiredText("Patient name", 128),
  species: importSpeciesInput,
  breed: importOptionalText("Breed", 128),
  sex: importSexInput,
  dob: importOptionalDate,
  color: importOptionalText("Color", 64),
  microchipNumber: importOptionalText("Microchip number", 64),
});
const importClientsInput = z.object({
  clients: z
    .array(clientJsonImportRecordInput)
    .max(
      IMPORT_MAX_ROWS,
      `Client imports can include at most ${IMPORT_MAX_ROWS} rows.`,
    ),
});
const importPatientsInput = z.object({
  patients: z
    .array(patientJsonImportRecordInput)
    .max(
      IMPORT_MAX_ROWS,
      `Patient imports can include at most ${IMPORT_MAX_ROWS} rows.`,
    ),
});
const vaccinationImportRecordInput = z
  .object({
    clientEmail: importOptionalEmail,
    externalClientId: importOptionalExternalId,
    externalPatientId: importOptionalExternalId,
    patientName: importOptionalText("Patient name", 128),
    vaccineName: importRequiredText("Vaccine name", 255),
    administeredAt: clinicalDateInput("Date given"),
    nextDueDate: importOptionalDueDate,
    lotNumber: importOptionalText("Lot number", 64),
    manufacturer: importOptionalText("Manufacturer", 128),
  })
  .refine(
    (record) =>
      record.externalPatientId ||
      (record.patientName && (record.clientEmail || record.externalClientId)),
    {
      message: "A patient ID or owner reference plus patient name is required.",
    },
  );
const vaccinationImportRecordsInput = z
  .array(vaccinationImportRecordInput)
  .max(
    IMPORT_MAX_ROWS,
    `Vaccination imports can include at most ${IMPORT_MAX_ROWS} rows.`,
  );
const soapNoteImportRecordInput = z
  .object({
    clientEmail: importOptionalEmail,
    externalClientId: importOptionalExternalId,
    externalPatientId: importOptionalExternalId,
    patientName: importOptionalText("Patient name", 128),
    date: clinicalDateInput("Visit date"),
    subjective: importOptionalText("Subjective", SOAP_SECTION_MAX_LENGTH),
    objective: importOptionalText("Objective", SOAP_SECTION_MAX_LENGTH),
    assessment: importOptionalText("Assessment", SOAP_SECTION_MAX_LENGTH),
    plan: importOptionalText("Plan", SOAP_SECTION_MAX_LENGTH),
  })
  .refine(
    (record) =>
      record.externalPatientId ||
      (record.patientName && (record.clientEmail || record.externalClientId)),
    {
      message: "A patient ID or owner reference plus patient name is required.",
    },
  )
  .refine((record) => hasSoapContent(record), {
    message:
      "Each medical history row needs at least one of Subjective, Objective, Assessment, or Plan.",
  });
const soapNoteImportRecordsInput = z
  .array(soapNoteImportRecordInput)
  .max(
    IMPORT_MAX_ROWS,
    `Medical history imports can include at most ${IMPORT_MAX_ROWS} rows.`,
  );
const importCsvTextInput = z
  .string()
  .min(1, "Choose a non-empty CSV file.")
  .max(IMPORT_CSV_MAX_BYTES, "CSV imports must be 5 MB or less.")
  .refine(isImportCsvSizeValid, "CSV imports must be 5 MB or less.");
const importCsvInput = z.object({
  csv: importCsvTextInput,
  // Keep the pre-ledger default during the compatibility rollout so a browser
  // tab loaded before this deploy does not silently switch a commit to preview.
  dryRun: z.boolean().optional().default(false),
  source: importSourceInput,
  previewToken: z.string().uuid().optional(),
  migrationProtocol: z.literal("reviewed-v1").optional(),
  // Accepted only so a pre-deploy onboarding tab receives an explicit refresh
  // instruction instead of a misleading pet preview.
  clientCsv: importCsvTextInput.optional(),
});

type CsvImportIntent = z.infer<typeof importCsvInput>;

const CLIENT_IMPORT_PLANNER_VERSION = "clients-v1";
const PATIENT_IMPORT_PLANNER_VERSION = "patients-v1";
const VACCINATION_IMPORT_PLANNER_VERSION = "vaccinations-v1";
const SOAP_NOTE_IMPORT_PLANNER_VERSION = "soap-notes-v1";

function csvPreviewResult<T extends Record<string, unknown>>(value: T) {
  return value as T & { imported?: never; reconciled?: never };
}

const LEGACY_IMPORT_COMPATIBILITY_END_MS = Date.parse("2026-08-15T00:00:00Z");

export function legacyImportCompatibilityOpen(
  now = Date.now(),
  nodeEnv = process.env.NODE_ENV,
): boolean {
  return nodeEnv === "test" || now < LEGACY_IMPORT_COMPATIBILITY_END_MS;
}

function requireValidImportIntent(input: CsvImportIntent): void {
  if (
    input.migrationProtocol !== "reviewed-v1" &&
    !input.previewToken &&
    !legacyImportCompatibilityOpen()
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "This import session is out of date. Refresh OpenVPM and check the file again.",
    });
  }
  if (input.dryRun && input.previewToken) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Start a new preview without an existing preview token.",
    });
  }
  if (
    input.migrationProtocol === "reviewed-v1" &&
    !input.dryRun &&
    !input.previewToken
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Check this exact CSV first, then confirm its import.",
    });
  }
}

async function createCsvImportPreview(
  ctx: DataContext & { user: { id: string } },
  input: CsvImportIntent,
  mode: MigrationRunMode,
  summary: MigrationPreviewSummary,
  reviewedPlan?: MigrationReviewedPlan,
  db: Database = ctx.db,
): Promise<string> {
  return createMigrationPreview(db, {
    practiceId: ctx.practiceId,
    createdBy: ctx.user.id,
    mode,
    source: input.source,
    csv: input.csv,
    summary,
    reviewedPlan,
  });
}

async function claimCsvImportPreview(
  db: Database,
  practiceId: string,
  input: CsvImportIntent,
  mode: MigrationRunMode,
  summary: MigrationPreviewSummary,
  reviewedPlan?: MigrationReviewedPlan,
): Promise<MigrationClaimResult> {
  // One rollout keeps legacy, already-loaded browser bundles working. Every
  // newly shipped caller identifies the reviewed protocol and must provide the
  // exact preview token. Remove this branch after the compatibility window.
  if (input.migrationProtocol !== "reviewed-v1" && !input.previewToken) {
    return { alreadyCommitted: false };
  }
  try {
    return await claimMigrationPreview(db, {
      practiceId,
      previewToken: input.previewToken!,
      mode,
      source: input.source,
      csv: input.csv,
      summary,
      reviewedPlan,
    });
  } catch (error) {
    if (error instanceof MigrationPreviewError) {
      throw new TRPCError({ code: "CONFLICT", message: error.message });
    }
    throw error;
  }
}

async function finishCsvImportRun(
  db: Database,
  practiceId: string,
  previewToken: string | undefined,
  importedCount: number,
  committedBy: string,
  reconciledCount = 0,
): Promise<void> {
  if (importedCount + reconciledCount > 0) {
    const committedAt = new Date().toISOString();
    // This marker must commit atomically with the imported records. The
    // onboarding shell uses it after a reload to avoid silently treating a
    // practice with real imported data as sample-only again.
    await db.execute(sql`
      update ${practices}
      set settings = jsonb_set(
        coalesce(${practices.settings}, '{}'::jsonb),
        '{onboardingState}',
        coalesce(${practices.settings} -> 'onboardingState', '{}'::jsonb)
          || jsonb_build_object(
            'migrationHasCommittedChanges', true,
            'migrationLastCommittedAt', ${committedAt}
          ),
        true
      )
      where ${practices.id} = ${practiceId}
        and ${practices.deletedAt} is null
    `);
  }
  if (!previewToken) return;
  try {
    await completeMigrationRun(db, {
      practiceId,
      previewToken,
      importedCount,
      reconciledCount,
      committedBy,
    });
  } catch (error) {
    if (error instanceof MigrationPreviewError) {
      throw new TRPCError({ code: "CONFLICT", message: error.message });
    }
    throw error;
  }
}

function activePracticeWhere(practiceId: string) {
  return and(eq(practices.id, practiceId), isNull(practices.deletedAt));
}

function activePracticePredicate(practiceId: string) {
  return sql`exists (
    select 1
    from ${practices}
    where ${practices.id} = ${practiceId}
      and ${practices.deletedAt} is null
  )`;
}

function isDemoDataId(
  practiceId: string,
  key: "clientIds" | "patientIds",
  column: typeof clients.id | typeof patients.id,
) {
  return sql<boolean>`exists (
    select 1
    from practices as demo_practice
    cross join lateral jsonb_array_elements_text(
      case
        when jsonb_typeof(demo_practice.settings -> 'demoData' -> ${key}) = 'array'
          then demo_practice.settings -> 'demoData' -> ${key}
        else '[]'::jsonb
      end
    ) as demo_id(value)
    where demo_practice.id = ${practiceId}
      and demo_practice.deleted_at is null
      and demo_id.value = ${column}::text
  )`;
}

function practiceNotFound(): TRPCError {
  return new TRPCError({ code: "NOT_FOUND", message: "Practice not found" });
}

async function assertActivePractice(ctx: DataContext) {
  const [practice] = await ctx.db
    .select({ id: practices.id })
    .from(practices)
    .where(activePracticeWhere(ctx.practiceId))
    .limit(1);

  if (!practice) {
    throw practiceNotFound();
  }
}

function normalizeImportEmail(email?: string | null): string | null {
  const value = email?.trim().toLowerCase();
  return value ? value : null;
}

function normalizeImportText(value?: string | null): string {
  return value?.trim().toLowerCase().replace(/\s+/g, " ") ?? "";
}

function normalizeExternalId(value?: string | null): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function externalIdentityKey(source: string, externalId: string): string {
  return `${source}|${externalId}`;
}

type ExistingClientImportIdentity = {
  id: string;
  email: string | null;
  externalSource: string | null;
  externalId: string | null;
  importFingerprint?: string | null;
  deletedAt: Date | null;
  updatedAt?: Date;
  plannedRowIndex?: number;
  isDemo?: boolean;
};

type ExternalIdentityUpdate = {
  id: string;
  externalSource: string;
  externalId: string;
};

function reviewedTarget(
  rowIndex: number,
  kind: MigrationReviewedTarget["kind"],
  role: MigrationReviewedTarget["role"],
  target: { id: string; updatedAt?: Date },
): MigrationReviewedTarget | undefined {
  if (target.id.startsWith("planned:")) return undefined;
  return {
    rowIndex,
    kind,
    role,
    targetId: target.id,
    targetVersion: target.updatedAt?.toISOString() ?? null,
  };
}

function reviewedDisposition(
  rowIndex: number,
  entityKind: MigrationReviewedDisposition["entityKind"],
  action: MigrationReviewedDisposition["action"],
): MigrationReviewedDisposition {
  return { rowIndex, entityKind, action };
}

function planClientCsvImport(
  records: ClientImportRecord[],
  source: string,
  existingClients: ExistingClientImportIdentity[],
): {
  rows: ClientImportRow[];
  identityUpdates: ExternalIdentityUpdate[];
  reviewedDispositions: MigrationReviewedDisposition[];
  reviewedTargets: MigrationReviewedTarget[];
  errors: string[];
  duplicates: number;
} {
  const byEmail = new Map<string, ExistingClientImportIdentity>();
  const ambiguousEmails = new Set<string>();
  const byExternalId = new Map<string, ExistingClientImportIdentity>();
  const importFingerprints = new Set<string>();

  for (const client of existingClients) {
    if (client.isDemo) continue;
    if (!client.deletedAt && client.importFingerprint) {
      importFingerprints.add(client.importFingerprint);
    }
    if (client.externalSource && client.externalId) {
      byExternalId.set(
        externalIdentityKey(client.externalSource, client.externalId),
        client,
      );
    }
    if (client.deletedAt) continue;
    const email = normalizeImportEmail(client.email);
    if (!email) continue;
    if (byEmail.has(email)) ambiguousEmails.add(email);
    else byEmail.set(email, client);
  }

  const rows: ClientImportRow[] = [];
  const identityUpdates: ExternalIdentityUpdate[] = [];
  const reviewedDispositions: MigrationReviewedDisposition[] = [];
  const reviewedTargets: MigrationReviewedTarget[] = [];
  const errors: string[] = [];
  let duplicates = 0;

  records.forEach((client, index) => {
    const email = normalizeImportEmail(client.email);
    const externalId = normalizeExternalId(client.externalClientId);
    const externalKey = externalId
      ? externalIdentityKey(source, externalId)
      : null;
    const externalMatch = externalKey
      ? byExternalId.get(externalKey)
      : undefined;
    const emailMatch =
      email && !ambiguousEmails.has(email) ? byEmail.get(email) : undefined;

    if (externalMatch) {
      const target = reviewedTarget(
        index,
        "client",
        "external_match",
        externalMatch,
      );
      if (target) reviewedTargets.push(target);
      if (externalMatch.deletedAt) {
        reviewedDispositions.push(
          reviewedDisposition(index, "client", "error"),
        );
        errors.push(
          `Row ${index + 1}: This external client ID belongs to an archived client. Restore or review that client before importing.`,
        );
        return;
      }
      if (emailMatch && emailMatch.id !== externalMatch.id) {
        reviewedDispositions.push(
          reviewedDisposition(index, "client", "error"),
        );
        errors.push(
          `Row ${index + 1}: The client email and external ID point to different existing clients. Nothing was changed.`,
        );
        return;
      }
      duplicates++;
      reviewedDispositions.push(
        reviewedDisposition(index, "client", "duplicate"),
      );
      errors.push(`Row ${index + 1}: Skipped an already linked client.`);
      return;
    }

    if (email && ambiguousEmails.has(email)) {
      reviewedDispositions.push(reviewedDisposition(index, "client", "error"));
      errors.push(
        `Row ${index + 1}: More than one existing client uses this email. Resolve the duplicate clients before importing.`,
      );
      return;
    }

    if (emailMatch) {
      const target = reviewedTarget(
        index,
        "client",
        "identity_match",
        emailMatch,
      );
      if (target) reviewedTargets.push(target);
      if (!externalId) {
        duplicates++;
        reviewedDispositions.push(
          reviewedDisposition(index, "client", "duplicate"),
        );
        errors.push(`Row ${index + 1}: Skipped a duplicate client.`);
        return;
      }
      if (emailMatch.externalSource || emailMatch.externalId) {
        reviewedDispositions.push(
          reviewedDisposition(index, "client", "error"),
        );
        errors.push(
          `Row ${index + 1}: This client already has a different external identity. Nothing was changed.`,
        );
        return;
      }

      if (emailMatch.plannedRowIndex !== undefined) {
        reviewedDispositions.push(
          reviewedDisposition(index, "client", "merge"),
        );
        const plannedRow = rows[emailMatch.plannedRowIndex];
        if (!plannedRow) {
          throw new Error("Missing planned client import row.");
        }
        plannedRow.externalSource = source;
        plannedRow.externalId = externalId;
      } else {
        reviewedDispositions.push(
          reviewedDisposition(index, "client", "reconcile"),
        );
        identityUpdates.push({
          id: emailMatch.id,
          externalSource: source,
          externalId,
        });
      }
      emailMatch.externalSource = source;
      emailMatch.externalId = externalId;
      byExternalId.set(externalKey!, emailMatch);
      return;
    }

    const row: ClientImportRow = {
      firstName: client.firstName.trim(),
      lastName: client.lastName.trim(),
      email,
      phone: client.phone?.trim() || null,
      address: client.address?.trim() || null,
      city: client.city?.trim() || null,
      state: client.state?.trim() || null,
      zip: client.zip?.trim() || null,
      ...(externalId ? { externalSource: source, externalId } : {}),
    };
    row.importFingerprint = migrationImportFingerprint("clients", [
      email ? "email" : externalId ? "external" : "record",
      email ?? (externalId ? source : normalizeImportText(row.firstName)),
      email ?? externalId ?? normalizeImportText(row.lastName),
      email || externalId ? null : normalizeImportText(row.phone),
      email || externalId ? null : normalizeImportText(row.address),
      email || externalId ? null : normalizeImportText(row.city),
      email || externalId ? null : normalizeImportText(row.state),
      email || externalId ? null : normalizeImportText(row.zip),
    ]);
    if (importFingerprints.has(row.importFingerprint)) {
      duplicates++;
      reviewedDispositions.push(
        reviewedDisposition(index, "client", "duplicate"),
      );
      errors.push(`Row ${index + 1}: Skipped a duplicate client.`);
      return;
    }
    importFingerprints.add(row.importFingerprint);
    reviewedDispositions.push(reviewedDisposition(index, "client", "insert"));
    rows.push(row);

    const planned: ExistingClientImportIdentity = {
      id: `planned:${index}`,
      email,
      externalSource: externalId ? source : null,
      externalId,
      deletedAt: null,
      plannedRowIndex: rows.length - 1,
    };
    if (email) byEmail.set(email, planned);
    if (externalKey) byExternalId.set(externalKey, planned);
  });

  return {
    rows,
    identityUpdates,
    reviewedDispositions,
    reviewedTargets,
    errors,
    duplicates,
  };
}

function patientIdentityKey(input: {
  clientId: string;
  name: string;
  species: string;
  dob?: string | null;
}): string {
  return [
    input.clientId,
    normalizeImportText(input.name),
    input.species,
    input.dob?.trim() ?? "",
  ].join("|");
}

function patientWeakIdentityKey(input: {
  clientId: string;
  name: string;
  species: string;
}): string {
  return [input.clientId, normalizeImportText(input.name), input.species].join(
    "|",
  );
}

function patientMicrochipKey(microchipNumber?: string | null): string | null {
  const normalized = normalizeImportText(microchipNumber);
  return normalized ? `chip:${normalized}` : null;
}

function dedupeClientImport(
  records: ClientImportRecord[],
  existingEmails: Set<string>,
  existingImportFingerprints: Set<string>,
): {
  rows: ClientImportRow[];
  errors: string[];
} {
  const seen = new Set([...existingEmails].map((email) => email.toLowerCase()));
  const seenImportFingerprints = new Set(existingImportFingerprints);
  const rows: ClientImportRow[] = [];
  const errors: string[] = [];

  records.forEach((client, index) => {
    const email = normalizeImportEmail(client.email);
    if (email) {
      if (seen.has(email)) {
        errors.push(
          `Row ${index + 1}: Skipped duplicate client email "${email}".`,
        );
        return;
      }
      seen.add(email);
    }

    const row: ClientImportRow = {
      firstName: client.firstName.trim(),
      lastName: client.lastName.trim(),
      email,
      phone: client.phone?.trim() || null,
      address: client.address?.trim() || null,
      city: client.city?.trim() || null,
      state: client.state?.trim() || null,
      zip: client.zip?.trim() || null,
      importFingerprint: migrationImportFingerprint("clients", [
        email ? "email" : "record",
        email ?? normalizeImportText(client.firstName),
        email ?? normalizeImportText(client.lastName),
        email ? null : normalizeImportText(client.phone),
        email ? null : normalizeImportText(client.address),
        email ? null : normalizeImportText(client.city),
        email ? null : normalizeImportText(client.state),
        email ? null : normalizeImportText(client.zip),
      ]),
    };
    if (seenImportFingerprints.has(row.importFingerprint!)) {
      errors.push(`Row ${index + 1}: Skipped a duplicate imported client.`);
      return;
    }
    seenImportFingerprints.add(row.importFingerprint!);
    rows.push(row);
  });

  return { rows, errors };
}

function dedupePatientImport(
  records: PatientImportRecord[],
  emailToClientId: Record<string, string>,
  existingPatients: Array<{
    clientId: string;
    name: string;
    species: string;
    dob: string | null;
    microchipNumber: string | null;
  }>,
): {
  rows: PatientImportRow[];
  errors: string[];
  duplicates: number;
  unmatchedClient: number;
} {
  const seenIdentities = new Set<string>();
  const seenMicrochips = new Set<string>();
  for (const patient of existingPatients) {
    seenIdentities.add(patientIdentityKey(patient));
    const chipKey = patientMicrochipKey(patient.microchipNumber);
    if (chipKey) seenMicrochips.add(chipKey);
  }

  const rows: PatientImportRow[] = [];
  const errors: string[] = [];
  let duplicates = 0;
  let unmatchedClient = 0;

  records.forEach((patient, index) => {
    const clientEmail = normalizeImportEmail(patient.clientEmail);
    const clientId = clientEmail ? emailToClientId[clientEmail] : undefined;
    if (!clientId) {
      unmatchedClient++;
      errors.push(
        `Row ${index + 1}: No client found with email "${patient.clientEmail}"`,
      );
      return;
    }

    const identityKey = patientIdentityKey({
      clientId,
      name: patient.name,
      species: patient.species,
      dob: patient.dob ?? null,
    });
    const chipKey = patientMicrochipKey(patient.microchipNumber);
    if (
      seenIdentities.has(identityKey) ||
      (chipKey && seenMicrochips.has(chipKey))
    ) {
      duplicates++;
      errors.push(
        `Row ${index + 1}: Skipped duplicate patient "${patient.name}".`,
      );
      return;
    }

    seenIdentities.add(identityKey);
    if (chipKey) seenMicrochips.add(chipKey);
    rows.push({
      clientId,
      name: patient.name.trim(),
      species: patient.species,
      breed: patient.breed?.trim() || null,
      sex: patient.sex || null,
      dob: patient.dob?.trim() || null,
      color: patient.color?.trim() || null,
      microchipNumber: patient.microchipNumber?.trim() || null,
      importFingerprint: migrationImportFingerprint("patients", [
        clientId,
        normalizeImportText(patient.name),
        patient.species,
        patient.dob?.trim() ?? "",
        patientMicrochipKey(patient.microchipNumber),
      ]),
    });
  });

  return { rows, errors, duplicates, unmatchedClient };
}

type ExistingPatientImportIdentity = {
  id: string;
  clientId: string;
  name: string;
  species: string;
  dob: string | null;
  microchipNumber: string | null;
  externalSource: string | null;
  externalId: string | null;
  importFingerprint?: string | null;
  deletedAt: Date | null;
  updatedAt?: Date;
  plannedRowIndex?: number;
  isDemo?: boolean;
};

type ClientTargetReference = {
  id: string;
  updatedAt?: Date;
};

type ClientReferenceLookup = {
  byEmail: Map<string, ClientTargetReference | "ambiguous">;
  byExternalId: Map<string, ClientTargetReference | "archived">;
};

function createClientReferenceLookup(
  clientsToIndex: ExistingClientImportIdentity[],
): ClientReferenceLookup {
  const byEmail = new Map<string, ClientTargetReference | "ambiguous">();
  const byExternalId = new Map<string, ClientTargetReference | "archived">();

  for (const client of clientsToIndex) {
    if (client.isDemo) continue;
    const email = normalizeImportEmail(client.email);
    if (email && !client.deletedAt) {
      byEmail.set(
        email,
        byEmail.has(email)
          ? "ambiguous"
          : { id: client.id, updatedAt: client.updatedAt },
      );
    }
    if (client.externalSource && client.externalId) {
      byExternalId.set(
        externalIdentityKey(client.externalSource, client.externalId),
        client.deletedAt
          ? "archived"
          : { id: client.id, updatedAt: client.updatedAt },
      );
    }
  }

  return { byEmail, byExternalId };
}

function resolveClientReference(
  record: Pick<PatientImportRecord, "clientEmail" | "externalClientId">,
  source: string,
  lookup: ClientReferenceLookup,
): {
  client?: ClientTargetReference;
  issue?: "ambiguous" | "archived" | "conflict";
} {
  const email = normalizeImportEmail(record.clientEmail);
  const externalId = normalizeExternalId(record.externalClientId);
  const emailResult = email ? lookup.byEmail.get(email) : undefined;
  const externalResult = externalId
    ? lookup.byExternalId.get(externalIdentityKey(source, externalId))
    : undefined;

  if (externalId) {
    if (externalResult === "archived") return { issue: "archived" };
    if (!externalResult) return {};
    if (emailResult === "ambiguous") return { issue: "ambiguous" };
    if (emailResult && emailResult.id !== externalResult.id) {
      return { issue: "conflict" };
    }
    return { client: externalResult };
  }

  if (emailResult === "ambiguous") return { issue: "ambiguous" };
  return { client: emailResult };
}

function planPatientCsvImport(
  records: PatientImportRecord[],
  source: string,
  clientLookup: ClientReferenceLookup,
  existingPatients: ExistingPatientImportIdentity[],
): {
  rows: PatientImportRow[];
  identityUpdates: ExternalIdentityUpdate[];
  reviewedDispositions: MigrationReviewedDisposition[];
  reviewedTargets: MigrationReviewedTarget[];
  errors: string[];
  duplicates: number;
  unmatchedClient: number;
} {
  const byExternalId = new Map<string, ExistingPatientImportIdentity>();
  const byIdentity = new Map<
    string,
    ExistingPatientImportIdentity | "ambiguous"
  >();
  const byMicrochip = new Map<
    string,
    ExistingPatientImportIdentity | "ambiguous"
  >();
  const byWeakIdentity = new Map<
    string,
    ExistingPatientImportIdentity | "ambiguous"
  >();
  const importFingerprints = new Set<string>();

  for (const patient of existingPatients) {
    if (patient.isDemo) continue;
    if (!patient.deletedAt && patient.importFingerprint) {
      importFingerprints.add(patient.importFingerprint);
    }
    if (patient.externalSource && patient.externalId) {
      byExternalId.set(
        externalIdentityKey(patient.externalSource, patient.externalId),
        patient,
      );
    }
    if (patient.deletedAt) continue;
    const identityKey = patientIdentityKey(patient);
    byIdentity.set(
      identityKey,
      byIdentity.has(identityKey) ? "ambiguous" : patient,
    );
    const weakIdentityKey = patientWeakIdentityKey(patient);
    byWeakIdentity.set(
      weakIdentityKey,
      byWeakIdentity.has(weakIdentityKey) ? "ambiguous" : patient,
    );
    const chipKey = patientMicrochipKey(patient.microchipNumber);
    if (chipKey) {
      byMicrochip.set(
        chipKey,
        byMicrochip.has(chipKey) ? "ambiguous" : patient,
      );
    }
  }

  const rows: PatientImportRow[] = [];
  const identityUpdates: ExternalIdentityUpdate[] = [];
  const reviewedDispositions: MigrationReviewedDisposition[] = [];
  const reviewedTargets: MigrationReviewedTarget[] = [];
  const errors: string[] = [];
  let duplicates = 0;
  let unmatchedClient = 0;

  records.forEach((patient, index) => {
    const owner = resolveClientReference(patient, source, clientLookup);
    if (!owner.client) {
      unmatchedClient++;
      reviewedDispositions.push(
        reviewedDisposition(index, "patient", "unmatched"),
      );
      const message =
        owner.issue === "archived"
          ? "The external owner ID belongs to an archived client. Restore or review that client before importing."
          : owner.issue === "ambiguous"
            ? "The owner reference matches more than one client. Resolve the duplicate clients before importing."
            : owner.issue === "conflict"
              ? "The owner email and external ID point to different clients. Nothing was changed."
              : "No matching client was found for the supplied owner reference.";
      errors.push(`Row ${index + 1}: ${message}`);
      return;
    }
    const ownerTarget = reviewedTarget(
      index,
      "owner",
      "owner_match",
      owner.client,
    );
    if (ownerTarget) reviewedTargets.push(ownerTarget);
    const clientId = owner.client.id;

    const externalId = normalizeExternalId(patient.externalPatientId);
    const externalKey = externalId
      ? externalIdentityKey(source, externalId)
      : null;
    const externalMatch = externalKey
      ? byExternalId.get(externalKey)
      : undefined;
    if (externalMatch) {
      if (externalMatch.deletedAt) {
        reviewedDispositions.push(
          reviewedDisposition(index, "patient", "error"),
        );
        errors.push(
          `Row ${index + 1}: This external patient ID belongs to an archived patient. Restore or review that patient before importing.`,
        );
        return;
      }
      const target = reviewedTarget(
        index,
        "patient",
        "external_match",
        externalMatch,
      );
      if (target) reviewedTargets.push(target);
      if (externalMatch.clientId !== clientId) {
        reviewedDispositions.push(
          reviewedDisposition(index, "patient", "error"),
        );
        errors.push(
          `Row ${index + 1}: The patient ID is linked to a different owner. Nothing was changed.`,
        );
        return;
      }
      duplicates++;
      reviewedDispositions.push(
        reviewedDisposition(index, "patient", "duplicate"),
      );
      errors.push(`Row ${index + 1}: Skipped an already linked patient.`);
      return;
    }

    const identityKey = patientIdentityKey({
      clientId,
      name: patient.name,
      species: patient.species,
      dob: patient.dob ?? null,
    });
    const identityMatch = byIdentity.get(identityKey);
    const weakIdentityKey = patientWeakIdentityKey({
      clientId,
      name: patient.name,
      species: patient.species,
    });
    const weakIdentityMatch = byWeakIdentity.get(weakIdentityKey);
    const chipKey = patientMicrochipKey(patient.microchipNumber);
    const chipMatch = chipKey ? byMicrochip.get(chipKey) : undefined;
    if (chipMatch === "ambiguous") {
      reviewedDispositions.push(reviewedDisposition(index, "patient", "error"));
      errors.push(
        `Row ${index + 1}: This microchip matches more than one patient. Resolve the duplicate charts before importing.`,
      );
      return;
    }
    if (identityMatch === "ambiguous") {
      reviewedDispositions.push(reviewedDisposition(index, "patient", "error"));
      errors.push(
        `Row ${index + 1}: More than one existing patient matches this row. Resolve the duplicate charts before importing.`,
      );
      return;
    }
    if (chipMatch && chipMatch.clientId !== clientId) {
      reviewedDispositions.push(reviewedDisposition(index, "patient", "error"));
      errors.push(
        `Row ${index + 1}: This microchip is already linked to a patient under a different owner. Nothing was changed.`,
      );
      return;
    }
    if (identityMatch && chipMatch && identityMatch.id !== chipMatch.id) {
      reviewedDispositions.push(reviewedDisposition(index, "patient", "error"));
      errors.push(
        `Row ${index + 1}: The patient identity and microchip point to different charts. Nothing was changed.`,
      );
      return;
    }

    const existingMatch = identityMatch ?? chipMatch;
    if (existingMatch) {
      const target = reviewedTarget(
        index,
        "patient",
        "identity_match",
        existingMatch,
      );
      if (target) reviewedTargets.push(target);
      if (!externalId) {
        duplicates++;
        reviewedDispositions.push(
          reviewedDisposition(index, "patient", "duplicate"),
        );
        errors.push(`Row ${index + 1}: Skipped a duplicate patient.`);
        return;
      }
      if (existingMatch.externalSource || existingMatch.externalId) {
        reviewedDispositions.push(
          reviewedDisposition(index, "patient", "error"),
        );
        errors.push(
          `Row ${index + 1}: This patient already has a different external identity. Nothing was changed.`,
        );
        return;
      }
      if (
        existingMatch.plannedRowIndex === undefined &&
        !chipMatch &&
        !patient.dob
      ) {
        reviewedDispositions.push(
          reviewedDisposition(index, "patient", "error"),
        );
        errors.push(
          `Row ${index + 1}: An existing patient may match this external ID, but a microchip or date of birth is needed before OpenVPM can connect it safely.`,
        );
        return;
      }
      if (existingMatch.plannedRowIndex !== undefined) {
        reviewedDispositions.push(
          reviewedDisposition(index, "patient", "merge"),
        );
        const plannedRow = rows[existingMatch.plannedRowIndex];
        if (!plannedRow) {
          throw new Error("Missing planned patient import row.");
        }
        plannedRow.externalSource = source;
        plannedRow.externalId = externalId;
      } else {
        reviewedDispositions.push(
          reviewedDisposition(index, "patient", "reconcile"),
        );
        identityUpdates.push({
          id: existingMatch.id,
          externalSource: source,
          externalId,
        });
      }
      existingMatch.externalSource = source;
      existingMatch.externalId = externalId;
      byExternalId.set(externalKey!, existingMatch);
      return;
    }

    if (externalId && !patient.dob && weakIdentityMatch) {
      reviewedDispositions.push(reviewedDisposition(index, "patient", "error"));
      errors.push(
        weakIdentityMatch === "ambiguous"
          ? `Row ${index + 1}: More than one existing patient may match this external ID. Add a microchip or date of birth, or resolve the duplicate charts before importing.`
          : `Row ${index + 1}: An existing patient may match this external ID, but a microchip or date of birth is needed before OpenVPM can connect it safely.`,
      );
      return;
    }

    const row: PatientImportRow = {
      clientId,
      name: patient.name.trim(),
      species: patient.species,
      breed: patient.breed?.trim() || null,
      sex: patient.sex || null,
      dob: patient.dob?.trim() || null,
      color: patient.color?.trim() || null,
      microchipNumber: patient.microchipNumber?.trim() || null,
      ...(externalId ? { externalSource: source, externalId } : {}),
    };
    row.importFingerprint = migrationImportFingerprint("patients", [
      clientId,
      normalizeImportText(row.name),
      row.species,
      row.dob?.trim() ?? "",
      patientMicrochipKey(row.microchipNumber),
    ]);
    if (importFingerprints.has(row.importFingerprint)) {
      duplicates++;
      reviewedDispositions.push(
        reviewedDisposition(index, "patient", "duplicate"),
      );
      errors.push(`Row ${index + 1}: Skipped a duplicate patient.`);
      return;
    }
    importFingerprints.add(row.importFingerprint);
    reviewedDispositions.push(reviewedDisposition(index, "patient", "insert"));
    rows.push(row);

    const planned: ExistingPatientImportIdentity = {
      id: `planned:${index}`,
      clientId,
      name: row.name,
      species: row.species,
      dob: row.dob ?? null,
      microchipNumber: row.microchipNumber ?? null,
      externalSource: externalId ? source : null,
      externalId,
      deletedAt: null,
      plannedRowIndex: rows.length - 1,
    };
    byIdentity.set(identityKey, planned);
    byWeakIdentity.set(weakIdentityKey, planned);
    if (chipKey) byMicrochip.set(chipKey, planned);
    if (externalKey) byExternalId.set(externalKey, planned);
  });

  return {
    rows,
    identityUpdates,
    reviewedDispositions,
    reviewedTargets,
    errors,
    duplicates,
    unmatchedClient,
  };
}

async function loadClientCsvPlan(
  db: Database,
  practiceId: string,
  records: ClientImportRecord[],
  source: string,
  parseErrors: string[],
) {
  const existing = await db
    .select({
      id: clients.id,
      email: clients.email,
      externalSource: clients.externalSource,
      externalId: clients.externalId,
      deletedAt: clients.deletedAt,
      updatedAt: clients.updatedAt,
      isDemo: isDemoDataId(practiceId, "clientIds", clients.id),
      importFingerprint: clients.importFingerprint,
    })
    .from(clients)
    .where(
      and(
        eq(clients.practiceId, practiceId),
        activePracticePredicate(practiceId),
      ),
    )
    .orderBy(clients.id)
    .for("update");
  const plan = planClientCsvImport(records, source, existing);
  const combinedErrors = [...parseErrors, ...plan.errors];
  const summary: MigrationPreviewSummary = {
    sourceRowCount: records.length,
    plannedInsertCount: plan.rows.length,
    plannedReconcileCount: plan.identityUpdates.length,
    duplicateCount: plan.duplicates,
    errorCount: combinedErrors.length,
  };
  const reviewedPlan: MigrationReviewedPlan = {
    plannerVersion: CLIENT_IMPORT_PLANNER_VERSION,
    dispositions: plan.reviewedDispositions,
    targets: plan.reviewedTargets,
  };
  return { plan, combinedErrors, summary, reviewedPlan };
}

async function loadPatientCsvPlan(
  db: Database,
  practiceId: string,
  records: PatientImportRecord[],
  source: string,
  parseErrors: string[],
) {
  // Keep the lock order practice -> clients -> patients for every migration.
  const clientRows = await db
    .select({
      id: clients.id,
      email: clients.email,
      externalSource: clients.externalSource,
      externalId: clients.externalId,
      deletedAt: clients.deletedAt,
      updatedAt: clients.updatedAt,
      isDemo: isDemoDataId(practiceId, "clientIds", clients.id),
    })
    .from(clients)
    .where(
      and(
        eq(clients.practiceId, practiceId),
        activePracticePredicate(practiceId),
      ),
    )
    .orderBy(clients.id)
    .for("update");
  const clientLookup = createClientReferenceLookup(clientRows);

  const existingPatients = await db
    .select({
      id: patients.id,
      clientId: patients.clientId,
      name: patients.name,
      species: patients.species,
      dob: patients.dob,
      microchipNumber: patients.microchipNumber,
      externalSource: patients.externalSource,
      externalId: patients.externalId,
      deletedAt: patients.deletedAt,
      updatedAt: patients.updatedAt,
      isDemo: isDemoDataId(practiceId, "patientIds", patients.id),
      importFingerprint: patients.importFingerprint,
    })
    .from(patients)
    .where(
      and(
        eq(patients.practiceId, practiceId),
        activePracticePredicate(practiceId),
      ),
    )
    .orderBy(patients.id)
    .for("update");

  const plan = planPatientCsvImport(
    records,
    source,
    clientLookup,
    existingPatients,
  );
  const combinedErrors = [...parseErrors, ...plan.errors];
  const summary: MigrationPreviewSummary = {
    sourceRowCount: records.length,
    plannedInsertCount: plan.rows.length,
    plannedReconcileCount: plan.identityUpdates.length,
    duplicateCount: plan.duplicates,
    unmatchedCount: plan.unmatchedClient,
    errorCount: combinedErrors.length,
  };
  const reviewedPlan: MigrationReviewedPlan = {
    plannerVersion: PATIENT_IMPORT_PLANNER_VERSION,
    dispositions: plan.reviewedDispositions,
    targets: plan.reviewedTargets,
  };
  return { plan, combinedErrors, summary, reviewedPlan };
}

/** Legacy key linking a historical row to a pet: owner email + pet name. */
function vaccinationPatientKey(
  clientEmail: string,
  patientName: string,
): string {
  return `${normalizeImportEmail(clientEmail) ?? ""}|${normalizeImportText(patientName)}`;
}

function externalOwnerPatientKey(
  source: string,
  externalClientId: string,
  patientName: string,
): string {
  return `${externalIdentityKey(source, externalClientId)}|${normalizeImportText(patientName)}`;
}

type PatientReferenceLookup = {
  byExternalPatientId: Record<string, PatientTargetReference>;
  byEmailAndName: Record<string, PatientTargetReference | "ambiguous">;
  byExternalOwnerAndName: Record<string, PatientTargetReference | "ambiguous">;
};

type PatientTargetReference = {
  id: string;
  updatedAt?: Date;
};

type ResolvedPatientReference =
  | {
      target: PatientTargetReference;
      role: "external_match" | "identity_match";
    }
  | "ambiguous"
  | undefined;

function addUniquePatientReference(
  target: Record<string, PatientTargetReference | "ambiguous">,
  key: string,
  patient: PatientTargetReference,
) {
  target[key] = target[key] ? "ambiguous" : patient;
}

function createPatientReferenceLookup(
  patientRows: Array<{
    id: string;
    name: string;
    externalSource: string | null;
    externalId: string | null;
    clientEmail: string | null;
    clientExternalSource: string | null;
    clientExternalId: string | null;
    updatedAt?: Date;
    isDemoClient?: boolean;
    isDemoPatient?: boolean;
  }>,
): PatientReferenceLookup {
  const lookup: PatientReferenceLookup = {
    byExternalPatientId: {},
    byEmailAndName: {},
    byExternalOwnerAndName: {},
  };

  for (const patient of patientRows) {
    if (patient.isDemoClient || patient.isDemoPatient) continue;
    const target = { id: patient.id, updatedAt: patient.updatedAt };
    if (patient.externalSource && patient.externalId) {
      lookup.byExternalPatientId[
        externalIdentityKey(patient.externalSource, patient.externalId)
      ] = target;
    }
    if (patient.clientEmail) {
      addUniquePatientReference(
        lookup.byEmailAndName,
        vaccinationPatientKey(patient.clientEmail, patient.name),
        target,
      );
    }
    if (patient.clientExternalSource && patient.clientExternalId) {
      addUniquePatientReference(
        lookup.byExternalOwnerAndName,
        externalOwnerPatientKey(
          patient.clientExternalSource,
          patient.clientExternalId,
          patient.name,
        ),
        target,
      );
    }
  }

  return lookup;
}

function resolvePatientReference(
  record: Pick<
    VaccinationImportRecord,
    "clientEmail" | "externalClientId" | "externalPatientId" | "patientName"
  >,
  source: string,
  lookup: PatientReferenceLookup,
): ResolvedPatientReference {
  const externalPatientId = normalizeExternalId(record.externalPatientId);
  const matches = new Map<string, PatientTargetReference>();
  let ambiguous = false;
  if (externalPatientId) {
    const directMatch =
      lookup.byExternalPatientId[
        externalIdentityKey(source, externalPatientId)
      ];
    if (!directMatch) return undefined;
    matches.set(directMatch.id, directMatch);
  }

  if (record.patientName && record.clientEmail) {
    const match =
      lookup.byEmailAndName[
        vaccinationPatientKey(record.clientEmail, record.patientName)
      ];
    if (match === "ambiguous") ambiguous = true;
    else if (match) matches.set(match.id, match);
  }
  const externalClientId = normalizeExternalId(record.externalClientId);
  if (record.patientName && externalClientId) {
    const match =
      lookup.byExternalOwnerAndName[
        externalOwnerPatientKey(source, externalClientId, record.patientName)
      ];
    if (match === "ambiguous") ambiguous = true;
    else if (match) matches.set(match.id, match);
  }

  if (ambiguous || matches.size > 1) return "ambiguous";
  const target = matches.values().next().value;
  if (!target) return undefined;
  return {
    target,
    role: externalPatientId ? "external_match" : "identity_match",
  };
}

/** Identity of an administered dose: patient + vaccine + date given. */
function vaccinationIdentityKey(input: {
  patientId: string;
  vaccineName: string;
  administeredDate: string;
}): string {
  return [
    input.patientId,
    normalizeImportText(input.vaccineName),
    input.administeredDate,
  ].join("|");
}

/**
 * Historical doses import at noon UTC of the given day so the calendar
 * date survives every clinic timezone (the exact hour was never in the
 * source export to begin with).
 */
function vaccinationInstant(dateInput: string): Date {
  return new Date(`${dateInput}T12:00:00.000Z`);
}

function dedupeVaccinationImport(
  records: VaccinationImportRecord[],
  patientLookup: PatientReferenceLookup,
  source: string,
  existingDoses: Array<{
    patientId: string;
    vaccineName: string;
    administeredAt: Date;
  }>,
): {
  rows: VaccinationImportRow[];
  reviewedDispositions: MigrationReviewedDisposition[];
  reviewedTargets: MigrationReviewedTarget[];
  errors: string[];
  duplicates: number;
  unmatchedPatient: number;
} {
  const seen = new Set(
    existingDoses.map((dose) =>
      vaccinationIdentityKey({
        patientId: dose.patientId,
        vaccineName: dose.vaccineName,
        administeredDate: dose.administeredAt.toISOString().slice(0, 10),
      }),
    ),
  );

  const rows: VaccinationImportRow[] = [];
  const reviewedDispositions: MigrationReviewedDisposition[] = [];
  const reviewedTargets: MigrationReviewedTarget[] = [];
  const errors: string[] = [];
  let duplicates = 0;
  let unmatchedPatient = 0;

  records.forEach((record, index) => {
    const patientReference = resolvePatientReference(
      record,
      source,
      patientLookup,
    );
    if (!patientReference) {
      unmatchedPatient++;
      reviewedDispositions.push(
        reviewedDisposition(index, "vaccination", "unmatched"),
      );
      errors.push(
        `Row ${index + 1}: No matching patient was found for the supplied reference.`,
      );
      return;
    }
    if (patientReference === "ambiguous") {
      unmatchedPatient++;
      reviewedDispositions.push(
        reviewedDisposition(index, "vaccination", "error"),
      );
      errors.push(
        `Row ${index + 1}: The supplied patient references are ambiguous or conflict. Nothing was changed.`,
      );
      return;
    }
    const patientId = patientReference.target.id;
    const target = reviewedTarget(
      index,
      "patient",
      patientReference.role,
      patientReference.target,
    );
    if (target) reviewedTargets.push(target);

    const identityKey = vaccinationIdentityKey({
      patientId,
      vaccineName: record.vaccineName,
      administeredDate: record.administeredAt,
    });
    if (seen.has(identityKey)) {
      duplicates++;
      reviewedDispositions.push(
        reviewedDisposition(index, "vaccination", "duplicate"),
      );
      errors.push(`Row ${index + 1}: Skipped a duplicate vaccine dose.`);
      return;
    }
    seen.add(identityKey);
    reviewedDispositions.push(
      reviewedDisposition(index, "vaccination", "insert"),
    );

    rows.push({
      patientId,
      vaccineName: record.vaccineName.trim(),
      administeredAt: vaccinationInstant(record.administeredAt),
      nextDueDate: record.nextDueDate ?? null,
      lotNumber: record.lotNumber?.trim() || null,
      manufacturer: record.manufacturer?.trim() || null,
      // Historical import: no OpenVPM user administered this dose.
      administeredBy: null,
      importFingerprint: migrationImportFingerprint("vaccinations", [
        patientId,
        normalizeImportText(record.vaccineName),
        record.administeredAt,
      ]),
    });
  });

  return {
    rows,
    reviewedDispositions,
    reviewedTargets,
    errors,
    duplicates,
    unmatchedPatient,
  };
}

async function loadMigrationPatientReferences(
  db: Database,
  practiceId: string,
) {
  return db
    .select({
      id: patients.id,
      name: patients.name,
      externalSource: patients.externalSource,
      externalId: patients.externalId,
      clientEmail: clients.email,
      clientExternalSource: clients.externalSource,
      clientExternalId: clients.externalId,
      updatedAt: patients.updatedAt,
      isDemoClient: isDemoDataId(practiceId, "clientIds", clients.id),
      isDemoPatient: isDemoDataId(practiceId, "patientIds", patients.id),
    })
    .from(patients)
    .innerJoin(clients, eq(patients.clientId, clients.id))
    .where(
      and(
        eq(patients.practiceId, practiceId),
        eq(clients.practiceId, practiceId),
        activePracticePredicate(practiceId),
        isNull(patients.deletedAt),
        isNull(clients.deletedAt),
      ),
    )
    .orderBy(patients.id)
    .for("update", { of: patients });
}

async function loadVaccinationCsvPlan(
  db: Database,
  practiceId: string,
  records: VaccinationImportRecord[],
  source: string,
  parseErrors: string[],
) {
  const patientRows = await loadMigrationPatientReferences(db, practiceId);
  const patientLookup = createPatientReferenceLookup(patientRows);
  const existingDoses = await db
    .select({
      id: vaccinationRecords.id,
      patientId: vaccinationRecords.patientId,
      vaccineName: vaccinationRecords.vaccineName,
      administeredAt: vaccinationRecords.administeredAt,
    })
    .from(vaccinationRecords)
    .where(
      and(
        eq(vaccinationRecords.practiceId, practiceId),
        activePracticePredicate(practiceId),
        isNull(vaccinationRecords.deletedAt),
      ),
    )
    .orderBy(vaccinationRecords.id)
    .for("update");
  const plan = dedupeVaccinationImport(
    records,
    patientLookup,
    source,
    existingDoses,
  );
  const combinedErrors = [...parseErrors, ...plan.errors];
  const summary: MigrationPreviewSummary = {
    sourceRowCount: records.length,
    plannedInsertCount: plan.rows.length,
    duplicateCount: plan.duplicates,
    unmatchedCount: plan.unmatchedPatient,
    errorCount: combinedErrors.length,
  };
  const reviewedPlan: MigrationReviewedPlan = {
    plannerVersion: VACCINATION_IMPORT_PLANNER_VERSION,
    dispositions: plan.reviewedDispositions,
    targets: plan.reviewedTargets,
  };
  return { plan, combinedErrors, summary, reviewedPlan };
}

function parseVaccinationImportRecords(
  records: VaccinationImportRecord[],
): VaccinationImportRecord[] {
  const result = vaccinationImportRecordsInput.safeParse(records);
  if (!result.success) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Vaccination import rows contain invalid values.",
    });
  }
  return result.data;
}

/** Text signature of a note's four sections, for duplicate detection. */
function soapNoteContentSignature(sections: {
  subjective?: string | null;
  objective?: string | null;
  assessment?: string | null;
  plan?: string | null;
}): string {
  return [
    sections.subjective,
    sections.objective,
    sections.assessment,
    sections.plan,
  ]
    .map((section) => normalizeImportText(section))
    .join("§");
}

/** Identity of a visit note: pet + visit date + its content. */
function soapNoteIdentityKey(input: {
  patientId: string;
  date: string;
  signature: string;
}): string {
  return [input.patientId, input.date, input.signature].join("|");
}

/**
 * Historical visit notes import at noon UTC of the given day (the vaccination
 * convention) so the calendar date survives every clinic timezone and the
 * medical history timeline, ordered by created_at, reads in true order.
 */
function soapNoteInstant(dateInput: string): Date {
  return new Date(`${dateInput}T12:00:00.000Z`);
}

function dedupeSoapNoteImport(
  records: SoapNoteImportRecord[],
  patientLookup: PatientReferenceLookup,
  source: string,
  existingNotes: Array<{
    patientId: string;
    createdAt: Date;
    subjective: string | null;
    objective: string | null;
    assessment: string | null;
    plan: string | null;
  }>,
): {
  rows: SoapNoteImportRow[];
  reviewedDispositions: MigrationReviewedDisposition[];
  reviewedTargets: MigrationReviewedTarget[];
  errors: string[];
  duplicates: number;
  unmatchedPatient: number;
} {
  const seen = new Set(
    existingNotes.map((note) =>
      soapNoteIdentityKey({
        patientId: note.patientId,
        date: note.createdAt.toISOString().slice(0, 10),
        signature: soapNoteContentSignature(note),
      }),
    ),
  );

  const rows: SoapNoteImportRow[] = [];
  const reviewedDispositions: MigrationReviewedDisposition[] = [];
  const reviewedTargets: MigrationReviewedTarget[] = [];
  const errors: string[] = [];
  let duplicates = 0;
  let unmatchedPatient = 0;

  records.forEach((record, index) => {
    const patientReference = resolvePatientReference(
      record,
      source,
      patientLookup,
    );
    if (!patientReference) {
      unmatchedPatient++;
      reviewedDispositions.push(
        reviewedDisposition(index, "soap_note", "unmatched"),
      );
      errors.push(
        `Row ${index + 1}: No matching patient was found for the supplied reference.`,
      );
      return;
    }
    if (patientReference === "ambiguous") {
      unmatchedPatient++;
      reviewedDispositions.push(
        reviewedDisposition(index, "soap_note", "error"),
      );
      errors.push(
        `Row ${index + 1}: The supplied patient references are ambiguous or conflict. Nothing was changed.`,
      );
      return;
    }
    const patientId = patientReference.target.id;
    const target = reviewedTarget(
      index,
      "patient",
      patientReference.role,
      patientReference.target,
    );
    if (target) reviewedTargets.push(target);

    const identityKey = soapNoteIdentityKey({
      patientId,
      date: record.date,
      signature: soapNoteContentSignature(record),
    });
    if (seen.has(identityKey)) {
      duplicates++;
      reviewedDispositions.push(
        reviewedDisposition(index, "soap_note", "duplicate"),
      );
      errors.push(`Row ${index + 1}: Skipped a duplicate medical note.`);
      return;
    }
    seen.add(identityKey);
    reviewedDispositions.push(
      reviewedDisposition(index, "soap_note", "insert"),
    );

    rows.push({
      patientId,
      appointmentId: null,
      subjective: record.subjective?.trim() || null,
      objective: record.objective?.trim() || null,
      assessment: record.assessment?.trim() || null,
      plan: record.plan?.trim() || null,
      // Preserve the visit date so the history reads in chronological order.
      createdAt: soapNoteInstant(record.date),
      importFingerprint: migrationImportFingerprint("soap_notes", [
        patientId,
        record.date,
        soapNoteContentSignature(record),
      ]),
    });
  });

  return {
    rows,
    reviewedDispositions,
    reviewedTargets,
    errors,
    duplicates,
    unmatchedPatient,
  };
}

async function loadSoapNoteCsvPlan(
  db: Database,
  practiceId: string,
  records: SoapNoteImportRecord[],
  source: string,
  parseErrors: string[],
) {
  const patientRows = await loadMigrationPatientReferences(db, practiceId);
  const patientLookup = createPatientReferenceLookup(patientRows);
  const existingNotes = await db
    .select({
      id: soapNotes.id,
      patientId: soapNotes.patientId,
      createdAt: soapNotes.createdAt,
      subjective: soapNotes.subjective,
      objective: soapNotes.objective,
      assessment: soapNotes.assessment,
      plan: soapNotes.plan,
    })
    .from(soapNotes)
    .where(
      and(
        eq(soapNotes.practiceId, practiceId),
        eq(soapNotes.status, "finalized"),
        activePracticePredicate(practiceId),
        isNull(soapNotes.deletedAt),
      ),
    )
    .orderBy(soapNotes.id)
    .for("update");
  const plan = dedupeSoapNoteImport(
    records,
    patientLookup,
    source,
    existingNotes,
  );
  const combinedErrors = [...parseErrors, ...plan.errors];
  const summary: MigrationPreviewSummary = {
    sourceRowCount: records.length,
    plannedInsertCount: plan.rows.length,
    duplicateCount: plan.duplicates,
    unmatchedCount: plan.unmatchedPatient,
    errorCount: combinedErrors.length,
  };
  const reviewedPlan: MigrationReviewedPlan = {
    plannerVersion: SOAP_NOTE_IMPORT_PLANNER_VERSION,
    dispositions: plan.reviewedDispositions,
    targets: plan.reviewedTargets,
  };
  return { plan, combinedErrors, summary, reviewedPlan };
}

function parseSoapNoteImportRecords(
  records: SoapNoteImportRecord[],
): SoapNoteImportRecord[] {
  const result = soapNoteImportRecordsInput.safeParse(records);
  if (!result.success) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Medical history import rows contain invalid values.",
    });
  }
  return result.data;
}

function parseClientImportRecords(
  records: ClientImportRecord[],
): ClientImportRecord[] {
  const result = clientImportRecordsInput.safeParse(records);
  if (!result.success) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Client import rows contain invalid values.",
    });
  }
  return result.data;
}

function parsePatientImportRecords(
  records: PatientImportRecord[],
): PatientImportRecord[] {
  const result = patientImportRecordsInput.safeParse(records);
  if (!result.success) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Patient import rows contain invalid values.",
    });
  }
  return result.data;
}

export const dataRouter = createRouter({
  // ── Export ──────────────────────────────────────────────────

  exportFullBackup: adminProcedure.query(async ({ ctx }) => {
    await assertActivePractice(ctx);
    return exportPracticeData(ctx.db, ctx.practiceId, new Date().toISOString());
  }),

  exportClients: adminProcedure.query(async ({ ctx }) => {
    await assertActivePractice(ctx);
    const rows = await ctx.db
      .select({
        firstName: clients.firstName,
        lastName: clients.lastName,
        email: clients.email,
        phone: clients.phone,
        address: clients.address,
        city: clients.city,
        state: clients.state,
        zip: clients.zip,
        emergencyContact: clients.emergencyContact,
        emergencyPhone: clients.emergencyPhone,
        preferredContactMethod: clients.preferredContactMethod,
        notes: clients.notes,
        createdAt: clients.createdAt,
      })
      .from(clients)
      .where(
        and(
          eq(clients.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(clients.deletedAt),
        ),
      );
    return rows;
  }),

  exportPatients: adminProcedure.query(async ({ ctx }) => {
    await assertActivePractice(ctx);
    const rows = await ctx.db
      .select({
        name: patients.name,
        species: patients.species,
        breed: patients.breed,
        sex: patients.sex,
        dob: patients.dob,
        color: patients.color,
        microchipNumber: patients.microchipNumber,
        status: patients.status,
        clientFirstName: clients.firstName,
        clientLastName: clients.lastName,
        clientEmail: clients.email,
        createdAt: patients.createdAt,
      })
      .from(patients)
      .innerJoin(
        clients,
        and(
          eq(patients.clientId, clients.id),
          eq(clients.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(clients.deletedAt),
        ),
      )
      .where(
        and(
          eq(patients.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(patients.deletedAt),
        ),
      );
    return rows;
  }),

  exportAppointments: adminProcedure.query(async ({ ctx }) => {
    await assertActivePractice(ctx);
    const rows = await ctx.db
      .select({
        startTime: appointments.startTime,
        endTime: appointments.endTime,
        status: appointments.status,
        notes: appointments.notes,
        patientName: patients.name,
        clientFirstName: clients.firstName,
        clientLastName: clients.lastName,
        doctorName: users.name,
        appointmentType: appointmentTypes.name,
        createdAt: appointments.createdAt,
      })
      .from(appointments)
      .leftJoin(
        patients,
        and(
          eq(appointments.patientId, patients.id),
          eq(patients.clientId, appointments.clientId),
          eq(patients.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(patients.deletedAt),
        ),
      )
      .leftJoin(
        clients,
        and(
          eq(appointments.clientId, clients.id),
          eq(clients.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(clients.deletedAt),
        ),
      )
      .leftJoin(
        users,
        and(
          eq(appointments.doctorId, users.id),
          eq(users.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
        ),
      )
      .leftJoin(
        appointmentTypes,
        and(
          eq(appointments.typeId, appointmentTypes.id),
          eq(appointmentTypes.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(appointmentTypes.deletedAt),
        ),
      )
      .where(
        and(
          eq(appointments.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(appointments.deletedAt),
        ),
      );
    return rows;
  }),

  exportInvoices: adminProcedure.query(async ({ ctx }) => {
    await assertActivePractice(ctx);
    const invoiceRows = await ctx.db
      .select({
        invoiceId: invoices.id,
        status: invoices.status,
        subtotal: invoices.subtotal,
        tax: invoices.tax,
        total: invoices.total,
        paidAmount: invoices.paidAmount,
        dueDate: invoices.dueDate,
        isEstimate: invoices.isEstimate,
        clientFirstName: clients.firstName,
        clientLastName: clients.lastName,
        patientName: patients.name,
        createdAt: invoices.createdAt,
      })
      .from(invoices)
      .innerJoin(
        clients,
        and(
          eq(invoices.clientId, clients.id),
          eq(clients.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(clients.deletedAt),
        ),
      )
      .leftJoin(
        patients,
        and(
          eq(invoices.patientId, patients.id),
          eq(patients.clientId, invoices.clientId),
          eq(patients.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(patients.deletedAt),
        ),
      )
      .where(
        and(
          eq(invoices.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(invoices.deletedAt),
        ),
      );

    // Fetch items for each invoice
    const invoiceIds = invoiceRows.map((r) => r.invoiceId);
    let itemsByInvoice: Record<
      string,
      {
        description: string;
        quantity: number;
        unitPrice: string;
        total: string;
        taxable: boolean;
      }[]
    > = {};

    if (invoiceIds.length > 0) {
      const allItems = await ctx.db
        .select({
          invoiceId: invoiceItems.invoiceId,
          description: invoiceItems.description,
          quantity: invoiceItems.quantity,
          unitPrice: invoiceItems.unitPrice,
          total: invoiceItems.total,
          taxable: invoiceItems.taxable,
        })
        .from(invoiceItems)
        .where(
          and(
            inArray(invoiceItems.invoiceId, invoiceIds),
            sql`exists (
              select 1
              from ${invoices}
              where ${invoices.id} = ${invoiceItems.invoiceId}
                and ${invoices.practiceId} = ${ctx.practiceId}
                and ${invoices.deletedAt} is null
            )`,
            activePracticePredicate(ctx.practiceId),
            isNull(invoiceItems.deletedAt),
          ),
        );

      for (const item of allItems) {
        if (invoiceIds.includes(item.invoiceId)) {
          if (!itemsByInvoice[item.invoiceId]) {
            itemsByInvoice[item.invoiceId] = [];
          }
          itemsByInvoice[item.invoiceId].push({
            description: item.description,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            total: item.total,
            taxable: item.taxable,
          });
        }
      }
    }

    return invoiceRows.map((row) => ({
      ...row,
      items: itemsByInvoice[row.invoiceId] ?? [],
    }));
  }),

  restoreBackup: adminProcedure
    .input(
      z.object({
        backup: z
          .record(z.unknown())
          .refine(
            isPracticeBackupJsonSizeValid,
            PRACTICE_BACKUP_JSON_SIZE_MESSAGE,
          ),
        dryRun: z.boolean().optional().default(true),
        confirmFreshPractice: z.boolean().optional().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const summary = summarizePracticeExport(input.backup);
      const validation = validatePracticeExportRestore(input.backup);
      const targetValidation = validatePracticeFileRestoreTarget(
        input.backup,
        ctx.practiceId,
      );
      const restoreErrors = [...validation.errors, ...targetValidation.errors];
      await assertActivePractice(ctx);

      if (input.dryRun) {
        return {
          dryRun: true as const,
          ...summary,
          restoreErrors,
        };
      }

      if (summary.missingSections.length > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Backup is missing required sections: ${summary.missingSections.join(", ")}`,
        });
      }
      if (restoreErrors.length > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Backup cannot be restored here: ${restoreErrors.join("; ")}`,
        });
      }

      if (!input.confirmFreshPractice) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Restores are non-destructive and require confirmation that this is a fresh practice.",
        });
      }

      const [
        existingClients,
        existingPatients,
        existingAppointments,
        existingInvoices,
      ] = await Promise.all([
        ctx.db
          .select({ id: clients.id })
          .from(clients)
          .where(
            and(
              eq(clients.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(clients.deletedAt),
            ),
          )
          .limit(1),
        ctx.db
          .select({ id: patients.id })
          .from(patients)
          .where(
            and(
              eq(patients.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(patients.deletedAt),
            ),
          )
          .limit(1),
        ctx.db
          .select({ id: appointments.id })
          .from(appointments)
          .where(
            and(
              eq(appointments.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(appointments.deletedAt),
            ),
          )
          .limit(1),
        ctx.db
          .select({ id: invoices.id })
          .from(invoices)
          .where(
            and(
              eq(invoices.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(invoices.deletedAt),
            ),
          )
          .limit(1),
      ]);

      if (
        existingClients.length > 0 ||
        existingPatients.length > 0 ||
        existingAppointments.length > 0 ||
        existingInvoices.length > 0
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Restore requires an empty practice with no clients, patients, appointments, or invoices.",
        });
      }

      const result = await restorePracticeData(
        ctx.db,
        ctx.practiceId,
        input.backup,
      );
      await recordActivationAfterAppointmentCreated(
        ctx.db,
        ctx.practiceId,
        "data.restoreBackup",
      );
      return { dryRun: false as const, ...result };
    }),

  // ── Import ──────────────────────────────────────────────────

  importClients: adminProcedure
    .input(importClientsInput)
    .mutation(async ({ ctx, input }) => {
      await assertActivePractice(ctx);
      if (input.clients.length === 0) {
        return { imported: 0, errors: [] as string[] };
      }

      const existing = await ctx.db
        .select({
          email: clients.email,
          importFingerprint: clients.importFingerprint,
        })
        .from(clients)
        .where(
          and(
            eq(clients.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(clients.deletedAt),
          ),
        );
      const existingEmails = new Set(
        existing
          .map((client) => normalizeImportEmail(client.email))
          .filter((email): email is string => !!email),
      );
      const existingImportFingerprints = new Set(
        existing
          .map((client) => client.importFingerprint)
          .filter((fingerprint): fingerprint is string => !!fingerprint),
      );
      const { rows, errors } = dedupeClientImport(
        input.clients,
        existingEmails,
        existingImportFingerprints,
      );

      if (rows.length > 0) {
        await ctx.db
          .insert(clients)
          .values(rows.map((row) => ({ ...row, practiceId: ctx.practiceId })));
        await recordActivationAfterClientCreated(
          ctx.db,
          ctx.practiceId,
          "data.importClients",
        );
      }

      return { imported: rows.length, errors };
    }),

  importPatients: adminProcedure
    .input(importPatientsInput)
    .mutation(async ({ ctx, input }) => {
      await assertActivePractice(ctx);
      if (input.patients.length === 0) {
        return { imported: 0, errors: [] as string[] };
      }

      const clientRows = await ctx.db
        .select({ id: clients.id, email: clients.email })
        .from(clients)
        .where(
          and(
            eq(clients.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(clients.deletedAt),
          ),
        );

      const emailToClientId: Record<string, string> = {};
      for (const c of clientRows) {
        const email = normalizeImportEmail(c.email);
        if (email) {
          emailToClientId[email] = c.id;
        }
      }

      const existingPatients = await ctx.db
        .select({
          clientId: patients.clientId,
          name: patients.name,
          species: patients.species,
          dob: patients.dob,
          microchipNumber: patients.microchipNumber,
        })
        .from(patients)
        .where(
          and(
            eq(patients.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(patients.deletedAt),
          ),
        );
      const { rows, errors } = dedupePatientImport(
        input.patients,
        emailToClientId,
        existingPatients,
      );

      if (rows.length > 0) {
        await ctx.db
          .insert(patients)
          .values(rows.map((row) => ({ ...row, practiceId: ctx.practiceId })));
      }

      return { imported: rows.length, errors };
    }),

  // ── CSV Import ──────────────────────────────────────────────
  // Accept raw CSV (the common export format from other PIMS) so a practice
  // can migrate without hand-building JSON. Parsing + validation is pure
  // (lib/csv); these mutations just persist the valid rows.

  importClientsCsv: adminProcedure
    .input(importCsvInput)
    .mutation(async ({ ctx, input }) => {
      requireValidImportIntent(input);
      const { records, errors } = csvToClientRecords(input.csv);
      const validRecords = parseClientImportRecords(records);

      if (validRecords.length === 0 && errors.length > 0) {
        await assertActivePractice(ctx);
        return ctx.db.transaction(async (tx) => {
          await tx.execute(sql`set transaction isolation level serializable`);
          const migrationDb = tx as unknown as Database;
          await lockMigrationPractice(migrationDb, ctx.practiceId);
          const summary: MigrationPreviewSummary = {
            sourceRowCount: 0,
            plannedInsertCount: 0,
            errorCount: errors.length,
          };
          const reviewedPlan: MigrationReviewedPlan = {
            plannerVersion: CLIENT_IMPORT_PLANNER_VERSION,
            dispositions: [],
            targets: [],
          };
          if (input.dryRun) {
            const previewToken = await createCsvImportPreview(
              ctx,
              input,
              "clients",
              summary,
              reviewedPlan,
              migrationDb,
            );
            return csvPreviewResult({
              dryRun: true as const,
              previewToken,
              total: 0,
              willInsert: 0,
              willReconcile: 0,
              duplicates: 0,
              errors,
            });
          }
          if (!input.previewToken) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                "This CSV has no importable client rows. Check it again.",
            });
          }
          const claim = await claimCsvImportPreview(
            migrationDb,
            ctx.practiceId,
            input,
            "clients",
            summary,
            reviewedPlan,
          );
          if (claim.alreadyCommitted) {
            return {
              imported: claim.importedCount,
              reconciled: claim.reconciledCount,
              errors,
              alreadyCommitted: true as const,
              migrationRunId: input.previewToken,
            };
          }
          await finishCsvImportRun(
            migrationDb,
            ctx.practiceId,
            input.previewToken,
            0,
            ctx.user.id,
          );
          return { imported: 0, reconciled: 0, errors };
        });
      }

      await assertActivePractice(ctx);
      const result = await ctx.db.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level serializable`);
        const migrationDb = tx as unknown as Database;
        await lockMigrationPractice(migrationDb, ctx.practiceId);
        const { plan, combinedErrors, summary, reviewedPlan } =
          await loadClientCsvPlan(
            migrationDb,
            ctx.practiceId,
            validRecords,
            input.source,
            errors,
          );

        if (input.dryRun) {
          const previewToken = await createCsvImportPreview(
            ctx,
            input,
            "clients",
            summary,
            reviewedPlan,
            migrationDb,
          );
          return csvPreviewResult({
            dryRun: true as const,
            previewToken,
            total: validRecords.length,
            willInsert: plan.rows.length,
            willReconcile: plan.identityUpdates.length,
            duplicates: plan.duplicates,
            errors: combinedErrors,
          });
        }

        const claim = await claimCsvImportPreview(
          migrationDb,
          ctx.practiceId,
          input,
          "clients",
          summary,
          reviewedPlan,
        );
        if (claim.alreadyCommitted) {
          return {
            imported: claim.importedCount,
            reconciled: claim.reconciledCount,
            errors: [] as string[],
            alreadyCommitted: true as const,
            migrationRunId: input.previewToken!,
          };
        }
        for (const update of plan.identityUpdates) {
          const updated = await tx
            .update(clients)
            .set({
              externalSource: update.externalSource,
              externalId: update.externalId,
            })
            .where(
              and(
                eq(clients.id, update.id),
                eq(clients.practiceId, ctx.practiceId),
                isNull(clients.deletedAt),
                isNull(clients.externalSource),
                isNull(clients.externalId),
              ),
            )
            .returning({ id: clients.id });
          if (updated.length !== 1) {
            throw new TRPCError({
              code: "CONFLICT",
              message:
                "A client changed after the dry run. Check the file again before importing.",
            });
          }
        }

        if (plan.rows.length > 0) {
          await tx.insert(clients).values(
            plan.rows.map((client) => ({
              ...client,
              practiceId: ctx.practiceId,
            })),
          );
        }
        await finishCsvImportRun(
          migrationDb,
          ctx.practiceId,
          input.previewToken!,
          plan.rows.length,
          ctx.user.id,
          plan.identityUpdates.length,
        );
        return {
          imported: plan.rows.length,
          reconciled: plan.identityUpdates.length,
          errors: combinedErrors,
        };
      });
      if ("imported" in result && (result.imported ?? 0) > 0) {
        await recordActivationAfterClientCreated(
          ctx.db,
          ctx.practiceId,
          "data.importClientsCsv",
        );
      }
      return result;
    }),

  importPatientsCsv: adminProcedure
    .input(importCsvInput)
    .mutation(async ({ ctx, input }) => {
      requireValidImportIntent(input);
      if (input.clientCsv) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "This onboarding import session is out of date. Refresh OpenVPM to check clients before pets.",
        });
      }
      const { records, errors } = csvToPatientRecords(input.csv);
      const validRecords = parsePatientImportRecords(records);

      if (validRecords.length === 0 && errors.length > 0) {
        await assertActivePractice(ctx);
        return ctx.db.transaction(async (tx) => {
          await tx.execute(sql`set transaction isolation level serializable`);
          const migrationDb = tx as unknown as Database;
          await lockMigrationPractice(migrationDb, ctx.practiceId);
          const summary: MigrationPreviewSummary = {
            sourceRowCount: 0,
            plannedInsertCount: 0,
            errorCount: errors.length,
          };
          const reviewedPlan: MigrationReviewedPlan = {
            plannerVersion: PATIENT_IMPORT_PLANNER_VERSION,
            dispositions: [],
            targets: [],
          };
          if (input.dryRun) {
            const previewToken = await createCsvImportPreview(
              ctx,
              input,
              "patients",
              summary,
              reviewedPlan,
              migrationDb,
            );
            return csvPreviewResult({
              dryRun: true as const,
              previewToken,
              total: 0,
              willInsert: 0,
              willReconcile: 0,
              unmatchedClient: 0,
              duplicates: 0,
              errors,
            });
          }
          if (!input.previewToken) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                "This CSV has no importable patient rows. Check it again.",
            });
          }
          const claim = await claimCsvImportPreview(
            migrationDb,
            ctx.practiceId,
            input,
            "patients",
            summary,
            reviewedPlan,
          );
          if (claim.alreadyCommitted) {
            return {
              imported: claim.importedCount,
              reconciled: claim.reconciledCount,
              errors,
              alreadyCommitted: true as const,
              migrationRunId: input.previewToken,
            };
          }
          await finishCsvImportRun(
            migrationDb,
            ctx.practiceId,
            input.previewToken,
            0,
            ctx.user.id,
          );
          return { imported: 0, reconciled: 0, errors };
        });
      }

      await assertActivePractice(ctx);
      return ctx.db.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level serializable`);
        const migrationDb = tx as unknown as Database;
        await lockMigrationPractice(migrationDb, ctx.practiceId);
        const { plan, combinedErrors, summary, reviewedPlan } =
          await loadPatientCsvPlan(
            migrationDb,
            ctx.practiceId,
            validRecords,
            input.source,
            errors,
          );

        if (input.dryRun) {
          const previewToken = await createCsvImportPreview(
            ctx,
            input,
            "patients",
            summary,
            reviewedPlan,
            migrationDb,
          );
          return csvPreviewResult({
            dryRun: true as const,
            previewToken,
            total: validRecords.length,
            willInsert: plan.rows.length,
            willReconcile: plan.identityUpdates.length,
            unmatchedClient: plan.unmatchedClient,
            duplicates: plan.duplicates,
            errors: combinedErrors,
          });
        }

        const claim = await claimCsvImportPreview(
          migrationDb,
          ctx.practiceId,
          input,
          "patients",
          summary,
          reviewedPlan,
        );
        if (claim.alreadyCommitted) {
          return {
            imported: claim.importedCount,
            reconciled: claim.reconciledCount,
            errors: [] as string[],
            alreadyCommitted: true as const,
            migrationRunId: input.previewToken!,
          };
        }
        for (const update of plan.identityUpdates) {
          const updated = await tx
            .update(patients)
            .set({
              externalSource: update.externalSource,
              externalId: update.externalId,
            })
            .where(
              and(
                eq(patients.id, update.id),
                eq(patients.practiceId, ctx.practiceId),
                isNull(patients.deletedAt),
                isNull(patients.externalSource),
                isNull(patients.externalId),
              ),
            )
            .returning({ id: patients.id });
          if (updated.length !== 1) {
            throw new TRPCError({
              code: "CONFLICT",
              message:
                "A patient changed after the dry run. Check the file again before importing.",
            });
          }
        }

        if (plan.rows.length > 0) {
          await tx.insert(patients).values(
            plan.rows.map((patient) => ({
              ...patient,
              practiceId: ctx.practiceId,
            })),
          );
        }
        await finishCsvImportRun(
          migrationDb,
          ctx.practiceId,
          input.previewToken!,
          plan.rows.length,
          ctx.user.id,
          plan.identityUpdates.length,
        );
        return {
          imported: plan.rows.length,
          reconciled: plan.identityUpdates.length,
          errors: combinedErrors,
        };
      });
    }),

  /**
   * Vaccination history import (migration): rows prefer a source-scoped
   * external patient ID and fall back to owner reference + pet name. Run it
   * after clients and patients. Historical doses power reminders immediately.
   */
  importVaccinationsCsv: adminProcedure
    .input(importCsvInput)
    .mutation(async ({ ctx, input }) => {
      requireValidImportIntent(input);
      const { records, errors } = csvToVaccinationRecords(input.csv);
      const validRecords = parseVaccinationImportRecords(records);

      if (validRecords.length === 0 && errors.length > 0) {
        await assertActivePractice(ctx);
        return ctx.db.transaction(async (tx) => {
          await tx.execute(sql`set transaction isolation level serializable`);
          const migrationDb = tx as unknown as Database;
          await lockMigrationPractice(migrationDb, ctx.practiceId);
          const summary: MigrationPreviewSummary = {
            sourceRowCount: 0,
            plannedInsertCount: 0,
            errorCount: errors.length,
          };
          const reviewedPlan: MigrationReviewedPlan = {
            plannerVersion: VACCINATION_IMPORT_PLANNER_VERSION,
            dispositions: [],
            targets: [],
          };
          if (input.dryRun) {
            const previewToken = await createCsvImportPreview(
              ctx,
              input,
              "vaccinations",
              summary,
              reviewedPlan,
              migrationDb,
            );
            return {
              dryRun: true as const,
              previewToken,
              total: 0,
              willInsert: 0,
              unmatchedPatient: 0,
              duplicates: 0,
              errors,
            };
          }
          if (!input.previewToken) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                "This CSV has no importable vaccination rows. Check it again.",
            });
          }
          const claim = await claimCsvImportPreview(
            migrationDb,
            ctx.practiceId,
            input,
            "vaccinations",
            summary,
            reviewedPlan,
          );
          if (claim.alreadyCommitted) {
            return {
              imported: claim.importedCount,
              errors,
              alreadyCommitted: true as const,
              migrationRunId: input.previewToken,
            };
          }
          await finishCsvImportRun(
            migrationDb,
            ctx.practiceId,
            input.previewToken,
            0,
            ctx.user.id,
          );
          return { imported: 0, errors };
        });
      }

      await assertActivePractice(ctx);
      return ctx.db.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level serializable`);
        const migrationDb = tx as unknown as Database;
        await lockMigrationPractice(migrationDb, ctx.practiceId);
        const { plan, combinedErrors, summary, reviewedPlan } =
          await loadVaccinationCsvPlan(
            migrationDb,
            ctx.practiceId,
            validRecords,
            input.source,
            errors,
          );

        if (input.dryRun) {
          const previewToken = await createCsvImportPreview(
            ctx,
            input,
            "vaccinations",
            summary,
            reviewedPlan,
            migrationDb,
          );
          return {
            dryRun: true as const,
            previewToken,
            total: validRecords.length,
            willInsert: plan.rows.length,
            unmatchedPatient: plan.unmatchedPatient,
            duplicates: plan.duplicates,
            errors: combinedErrors,
          };
        }

        const claim = await claimCsvImportPreview(
          migrationDb,
          ctx.practiceId,
          input,
          "vaccinations",
          summary,
          reviewedPlan,
        );
        if (claim.alreadyCommitted) {
          return {
            imported: claim.importedCount,
            errors: [] as string[],
            alreadyCommitted: true as const,
            migrationRunId: input.previewToken!,
          };
        }
        if (plan.rows.length > 0) {
          await tx
            .insert(vaccinationRecords)
            .values(
              plan.rows.map((v) => ({ ...v, practiceId: ctx.practiceId })),
            );
        }
        await finishCsvImportRun(
          migrationDb,
          ctx.practiceId,
          input.previewToken!,
          plan.rows.length,
          ctx.user.id,
        );
        return {
          imported: plan.rows.length,
          errors: combinedErrors,
        };
      });
    }),

  /**
   * Medical history import (migration): each row is one dated visit note,
   * saved as a SOAP note and linked by external patient ID or owner reference
   * + pet name, so run it after clients and patients. The visit date is preserved (the
   * history reads in order) and the note is attributed to the importing admin,
   * since historical records have no OpenVPM author. Re-running a file is
   * safe: the same pet + date + note text is skipped as a duplicate.
   */
  importSoapNotesCsv: adminProcedure
    .input(importCsvInput)
    .mutation(async ({ ctx, input }) => {
      requireValidImportIntent(input);
      const { records, errors } = csvToSoapNoteRecords(input.csv);
      const validRecords = parseSoapNoteImportRecords(records);

      if (validRecords.length === 0 && errors.length > 0) {
        await assertActivePractice(ctx);
        return ctx.db.transaction(async (tx) => {
          await tx.execute(sql`set transaction isolation level serializable`);
          const migrationDb = tx as unknown as Database;
          await lockMigrationPractice(migrationDb, ctx.practiceId);
          const summary: MigrationPreviewSummary = {
            sourceRowCount: 0,
            plannedInsertCount: 0,
            errorCount: errors.length,
          };
          const reviewedPlan: MigrationReviewedPlan = {
            plannerVersion: SOAP_NOTE_IMPORT_PLANNER_VERSION,
            dispositions: [],
            targets: [],
          };
          if (input.dryRun) {
            const previewToken = await createCsvImportPreview(
              ctx,
              input,
              "soap_notes",
              summary,
              reviewedPlan,
              migrationDb,
            );
            return {
              dryRun: true as const,
              previewToken,
              total: 0,
              willInsert: 0,
              unmatchedPatient: 0,
              duplicates: 0,
              errors,
            };
          }
          if (!input.previewToken) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                "This CSV has no importable medical history rows. Check it again.",
            });
          }
          const claim = await claimCsvImportPreview(
            migrationDb,
            ctx.practiceId,
            input,
            "soap_notes",
            summary,
            reviewedPlan,
          );
          if (claim.alreadyCommitted) {
            return {
              imported: claim.importedCount,
              errors,
              alreadyCommitted: true as const,
              migrationRunId: input.previewToken,
            };
          }
          await finishCsvImportRun(
            migrationDb,
            ctx.practiceId,
            input.previewToken,
            0,
            ctx.user.id,
          );
          return { imported: 0, errors };
        });
      }

      await assertActivePractice(ctx);
      return ctx.db.transaction(async (tx) => {
        await tx.execute(sql`set transaction isolation level serializable`);
        const migrationDb = tx as unknown as Database;
        await lockMigrationPractice(migrationDb, ctx.practiceId);
        const { plan, combinedErrors, summary, reviewedPlan } =
          await loadSoapNoteCsvPlan(
            migrationDb,
            ctx.practiceId,
            validRecords,
            input.source,
            errors,
          );

        if (input.dryRun) {
          const previewToken = await createCsvImportPreview(
            ctx,
            input,
            "soap_notes",
            summary,
            reviewedPlan,
            migrationDb,
          );
          return {
            dryRun: true as const,
            previewToken,
            total: validRecords.length,
            willInsert: plan.rows.length,
            unmatchedPatient: plan.unmatchedPatient,
            duplicates: plan.duplicates,
            errors: combinedErrors,
          };
        }

        const claim = await claimCsvImportPreview(
          migrationDb,
          ctx.practiceId,
          input,
          "soap_notes",
          summary,
          reviewedPlan,
        );
        if (claim.alreadyCommitted) {
          return {
            imported: claim.importedCount,
            errors: [] as string[],
            alreadyCommitted: true as const,
            migrationRunId: input.previewToken!,
          };
        }
        if (plan.rows.length > 0) {
          await tx.insert(soapNotes).values(
            plan.rows.map((n) => ({
              ...n,
              practiceId: ctx.practiceId,
              ...finalizedSoapInsertValues({
                actor: { id: ctx.user.id, name: ctx.user.name },
                sections: n,
                finalizedAt: n.createdAt,
                imported: true,
              }),
            })),
          );
        }
        await finishCsvImportRun(
          migrationDb,
          ctx.practiceId,
          input.previewToken!,
          plan.rows.length,
          ctx.user.id,
        );
        return {
          imported: plan.rows.length,
          errors: combinedErrors,
        };
      });
    }),
});
