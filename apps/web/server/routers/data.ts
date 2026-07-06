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
} from "@openpims/db";
import type { Database } from "@openpims/db/client";
import {
  type ClientImportRecord,
  type PatientImportRecord,
  csvToClientRecords,
  csvToPatientRecords,
} from "@/lib/csv/import";
import {
  exportPracticeData,
  restorePracticeData,
  summarizePracticeExport,
  validatePracticeExportRestore,
} from "@/lib/backup/export";
import {
  PRACTICE_BACKUP_JSON_SIZE_MESSAGE,
  isPracticeBackupJsonSizeValid,
} from "@/lib/backup/policy";
import { planClientImport } from "@/lib/import/plan";
import {
  IMPORT_CSV_MAX_BYTES,
  IMPORT_MAX_ROWS,
  isImportCsvSizeValid,
} from "@/lib/import/policy";
import { clinicalDateInput } from "@/lib/records/clinical-inputs";

const adminProcedure = protectedProcedure.use(requireRole("admin"));
export { IMPORT_CSV_MAX_BYTES, IMPORT_MAX_ROWS } from "@/lib/import/policy";

type ClientImportRow = Omit<typeof clients.$inferInsert, "practiceId">;
type PatientImportRow = Omit<typeof patients.$inferInsert, "practiceId">;
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
  z.string().trim().email().max(255).optional()
);
const importOptionalDate = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() || undefined : value),
  clinicalDateInput("Date of birth").optional()
);
const clientImportRecordInput = z.object({
  firstName: importRequiredText("First name", 128),
  lastName: importRequiredText("Last name", 128),
  email: importOptionalEmail,
  phone: importOptionalText("Phone", 32),
  address: importOptionalText("Address", 500),
  city: importOptionalText("City", 128),
  state: importOptionalText("State", 64),
  zip: importOptionalText("ZIP", 16),
});
const patientImportRecordInput = z.object({
  clientEmail: z.string().trim().email().max(255),
  name: importRequiredText("Patient name", 128),
  species: importSpeciesInput,
  breed: importOptionalText("Breed", 128),
  sex: importSexInput,
  dob: importOptionalDate,
  color: importOptionalText("Color", 64),
  microchipNumber: importOptionalText("Microchip number", 64),
});
const clientImportRecordsInput = z
  .array(clientImportRecordInput)
  .max(
    IMPORT_MAX_ROWS,
    `Client imports can include at most ${IMPORT_MAX_ROWS} rows.`
  );
const patientImportRecordsInput = z
  .array(patientImportRecordInput)
  .max(
    IMPORT_MAX_ROWS,
    `Patient imports can include at most ${IMPORT_MAX_ROWS} rows.`
  );
const importClientsInput = z.object({
  clients: clientImportRecordsInput,
});
const importPatientsInput = z.object({
  patients: patientImportRecordsInput,
});
const importCsvInput = z.object({
  csv: z
    .string()
    .min(1)
    .max(IMPORT_CSV_MAX_BYTES, "CSV imports must be 5 MB or less.")
    .refine(isImportCsvSizeValid, "CSV imports must be 5 MB or less."),
  dryRun: z.boolean().optional().default(false),
});

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

function patientMicrochipKey(microchipNumber?: string | null): string | null {
  const normalized = normalizeImportText(microchipNumber);
  return normalized ? `chip:${normalized}` : null;
}

function dedupeClientImport(
  records: ClientImportRecord[],
  existingEmails: Set<string>
): {
  rows: ClientImportRow[];
  errors: string[];
} {
  const seen = new Set([...existingEmails].map((email) => email.toLowerCase()));
  const rows: ClientImportRow[] = [];
  const errors: string[] = [];

  records.forEach((client, index) => {
    const email = normalizeImportEmail(client.email);
    if (email) {
      if (seen.has(email)) {
        errors.push(
          `Row ${index + 1}: Skipped duplicate client email "${email}".`
        );
        return;
      }
      seen.add(email);
    }

    rows.push({
      firstName: client.firstName.trim(),
      lastName: client.lastName.trim(),
      email,
      phone: client.phone?.trim() || null,
      address: client.address?.trim() || null,
      city: client.city?.trim() || null,
      state: client.state?.trim() || null,
      zip: client.zip?.trim() || null,
    });
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
  }>
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
        `Row ${index + 1}: No client found with email "${patient.clientEmail}"`
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
        `Row ${index + 1}: Skipped duplicate patient "${patient.name}".`
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
    });
  });

  return { rows, errors, duplicates, unmatchedClient };
}

function parseClientImportRecords(
  records: ClientImportRecord[]
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
  records: PatientImportRecord[]
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
          isNull(clients.deletedAt)
        )
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
          isNull(clients.deletedAt)
        )
      )
      .where(
        and(
          eq(patients.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(patients.deletedAt)
        )
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
          isNull(patients.deletedAt)
        )
      )
      .leftJoin(
        clients,
        and(
          eq(appointments.clientId, clients.id),
          eq(clients.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(clients.deletedAt)
        )
      )
      .leftJoin(
        users,
        and(
          eq(appointments.doctorId, users.id),
          eq(users.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(users.deletedAt)
        )
      )
      .leftJoin(
        appointmentTypes,
        and(
          eq(appointments.typeId, appointmentTypes.id),
          eq(appointmentTypes.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(appointmentTypes.deletedAt)
        )
      )
      .where(
        and(
          eq(appointments.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(appointments.deletedAt)
        )
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
          isNull(clients.deletedAt)
        )
      )
      .leftJoin(
        patients,
        and(
          eq(invoices.patientId, patients.id),
          eq(patients.clientId, invoices.clientId),
          eq(patients.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(patients.deletedAt)
        )
      )
      .where(
        and(
          eq(invoices.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(invoices.deletedAt)
        )
      );

    // Fetch items for each invoice
    const invoiceIds = invoiceRows.map((r) => r.invoiceId);
    let itemsByInvoice: Record<string, { description: string; quantity: number; unitPrice: string; total: string }[]> = {};

    if (invoiceIds.length > 0) {
      const allItems = await ctx.db
        .select({
          invoiceId: invoiceItems.invoiceId,
          description: invoiceItems.description,
          quantity: invoiceItems.quantity,
          unitPrice: invoiceItems.unitPrice,
          total: invoiceItems.total,
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
            isNull(invoiceItems.deletedAt)
          )
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
            PRACTICE_BACKUP_JSON_SIZE_MESSAGE
          ),
        dryRun: z.boolean().optional().default(true),
        confirmFreshPractice: z.boolean().optional().default(false),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const summary = summarizePracticeExport(input.backup);
      const validation = validatePracticeExportRestore(input.backup);
      await assertActivePractice(ctx);

      if (input.dryRun) {
        return {
          dryRun: true as const,
          ...summary,
          restoreErrors: validation.errors,
        };
      }

      if (summary.missingSections.length > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Backup is missing required sections: ${summary.missingSections.join(", ")}`,
        });
      }
      if (!validation.valid) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Backup contains invalid restore data: ${validation.errors.join("; ")}`,
        });
      }

      if (!input.confirmFreshPractice) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Restores are non-destructive and require confirmation that this is a fresh practice.",
        });
      }

      const [existingClients, existingPatients, existingAppointments, existingInvoices] =
        await Promise.all([
          ctx.db
            .select({ id: clients.id })
            .from(clients)
            .where(
              and(
                eq(clients.practiceId, ctx.practiceId),
                activePracticePredicate(ctx.practiceId),
                isNull(clients.deletedAt)
              )
            )
            .limit(1),
          ctx.db
            .select({ id: patients.id })
            .from(patients)
            .where(
              and(
                eq(patients.practiceId, ctx.practiceId),
                activePracticePredicate(ctx.practiceId),
                isNull(patients.deletedAt)
              )
            )
            .limit(1),
          ctx.db
            .select({ id: appointments.id })
            .from(appointments)
            .where(
              and(
                eq(appointments.practiceId, ctx.practiceId),
                activePracticePredicate(ctx.practiceId),
                isNull(appointments.deletedAt)
              )
            )
            .limit(1),
          ctx.db
            .select({ id: invoices.id })
            .from(invoices)
            .where(
              and(
                eq(invoices.practiceId, ctx.practiceId),
                activePracticePredicate(ctx.practiceId),
                isNull(invoices.deletedAt)
              )
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

      const result = await restorePracticeData(ctx.db, ctx.practiceId, input.backup);
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
        .select({ email: clients.email })
        .from(clients)
        .where(
          and(
            eq(clients.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(clients.deletedAt)
          )
        );
      const existingEmails = new Set(
        existing
          .map((client) => normalizeImportEmail(client.email))
          .filter((email): email is string => !!email)
      );
      const { rows, errors } = dedupeClientImport(
        input.clients,
        existingEmails
      );

      if (rows.length > 0) {
        await ctx.db
          .insert(clients)
          .values(rows.map((row) => ({ ...row, practiceId: ctx.practiceId })));
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
            isNull(clients.deletedAt)
          )
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
            isNull(patients.deletedAt)
          )
        );
      const { rows, errors } = dedupePatientImport(
        input.patients,
        emailToClientId,
        existingPatients
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
      const { records, errors } = csvToClientRecords(input.csv);
      const validRecords = parseClientImportRecords(records);

      if (validRecords.length === 0 && errors.length > 0) {
        if (input.dryRun) {
          return {
            dryRun: true as const,
            total: 0,
            willInsert: 0,
            duplicates: 0,
            errors,
          };
        }
        return { imported: 0, errors };
      }

      await assertActivePractice(ctx);

      if (input.dryRun) {
        const existing = await ctx.db
          .select({ email: clients.email })
          .from(clients)
          .where(
            and(
              eq(clients.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(clients.deletedAt)
            )
          );
        const emails = new Set(
          existing
            .map((client) => normalizeImportEmail(client.email))
            .filter((email): email is string => !!email)
        );
        const plan = planClientImport(validRecords, emails);
        return { dryRun: true as const, ...plan, errors };
      }

      const existing = await ctx.db
        .select({ email: clients.email })
        .from(clients)
        .where(
          and(
            eq(clients.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(clients.deletedAt)
          )
        );
      const existingEmails = new Set(
        existing
          .map((client) => normalizeImportEmail(client.email))
          .filter((email): email is string => !!email)
      );
      const deduped = dedupeClientImport(validRecords, existingEmails);

      if (deduped.rows.length > 0) {
        await ctx.db.insert(clients).values(
          deduped.rows.map((c) => ({
            ...c,
            practiceId: ctx.practiceId,
          }))
        );
      }
      return {
        imported: deduped.rows.length,
        errors: [...errors, ...deduped.errors],
      };
    }),

  importPatientsCsv: adminProcedure
    .input(importCsvInput)
    .mutation(async ({ ctx, input }) => {
      const { records, errors } = csvToPatientRecords(input.csv);
      const validRecords = parsePatientImportRecords(records);

      if (validRecords.length === 0 && errors.length > 0) {
        if (input.dryRun) {
          return {
            dryRun: true as const,
            total: 0,
            willInsert: 0,
            unmatchedClient: 0,
            duplicates: 0,
            errors,
          };
        }
        return { imported: 0, errors };
      }

      await assertActivePractice(ctx);

      const clientRows = await ctx.db
        .select({ id: clients.id, email: clients.email })
        .from(clients)
        .where(
          and(
            eq(clients.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(clients.deletedAt)
          )
        );
      const emailToClientId: Record<string, string> = {};
      for (const c of clientRows) {
        const email = normalizeImportEmail(c.email);
        if (email) emailToClientId[email] = c.id;
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
            isNull(patients.deletedAt)
          )
        );

      const deduped = dedupePatientImport(
        validRecords,
        emailToClientId,
        existingPatients
      );

      if (input.dryRun) {
        return {
          dryRun: true as const,
          total: validRecords.length,
          willInsert: deduped.rows.length,
          unmatchedClient: deduped.unmatchedClient,
          duplicates: deduped.duplicates,
          errors: [...errors, ...deduped.errors],
        };
      }

      if (deduped.rows.length > 0) {
        await ctx.db.insert(patients).values(
          deduped.rows.map((p) => ({ ...p, practiceId: ctx.practiceId }))
        );
      }
      return {
        imported: deduped.rows.length,
        errors: [...errors, ...deduped.errors],
      };
    }),
});
