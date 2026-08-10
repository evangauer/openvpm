import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  appointments,
  clinicalRecordCorrections,
  labResultReplacements,
  patients,
  soapNoteReplacements,
  soapNotes,
  users,
  vaccinationRecords,
  vitalSigns,
} from "@openpims/db";

function readRepoFile(path: string): string {
  return readFileSync(new URL(`../../../../${path}`, import.meta.url), "utf8");
}

describe("clinical correction schema and migration", () => {
  it("declares an append-only, bounded, tenant-indexed correction ledger", () => {
    const config = getTableConfig(clinicalRecordCorrections);
    const columns = config.columns.map((column) => column.name);
    const indexes = config.indexes.map((index) => index.config.name);
    const foreignKeys = config.foreignKeys.map(
      (foreignKey) => foreignKey.reference().name,
    );
    const checks = config.checks.map((check) => check.name);

    expect(columns).toEqual(
      expect.arrayContaining([
        "practice_id",
        "record_type",
        "soap_note_id",
        "vital_sign_id",
        "patient_id",
        "appointment_id",
        "reason",
        "corrected_by",
        "corrected_by_name",
        "created_at",
      ]),
    );
    expect(columns).not.toContain("updated_at");
    expect(columns).not.toContain("deleted_at");
    expect(columns).not.toContain("replacement_soap_note_id");
    expect(columns).not.toContain("replacement_vital_sign_id");
    expect(indexes).toEqual(
      expect.arrayContaining([
        "clinical_record_corrections_practice_patient_history_idx",
        "clinical_record_corrections_practice_appointment_history_idx",
        "clinical_record_corrections_practice_type_history_idx",
        "clinical_record_corrections_soap_note_uq",
        "clinical_record_corrections_vital_sign_uq",
      ]),
    );
    expect(foreignKeys).toEqual(
      expect.arrayContaining([
        "clinical_record_corrections_practice_appointment_fk",
        "clinical_record_corrections_practice_patient_fk",
        "clinical_record_corrections_practice_actor_fk",
        "clinical_record_corrections_soap_source_fk",
        "clinical_record_corrections_vital_source_fk",
      ]),
    );
    const appointmentReference = config.foreignKeys
      .find(
        (foreignKey) =>
          foreignKey.reference().name ===
          "clinical_record_corrections_practice_appointment_fk",
      )
      ?.reference();
    expect({
      columns: appointmentReference?.columns.map((column) => column.name),
      foreignColumns: appointmentReference?.foreignColumns.map(
        (column) => column.name,
      ),
    }).toEqual({
      columns: ["practice_id", "appointment_id", "patient_id"],
      foreignColumns: ["practice_id", "id", "patient_id"],
    });
    expect(checks).toEqual(
      expect.arrayContaining([
        "clinical_record_corrections_source_type_check",
        "clinical_record_corrections_reason_length_check",
        "clinical_record_corrections_actor_name_check",
      ]),
    );
  });

  it("prepares tenant-bound foreign keys before installing the ledger", () => {
    const tableIndexes = (
      table:
        | typeof patients
        | typeof users
        | typeof appointments
        | typeof soapNotes
        | typeof vitalSigns,
    ) => getTableConfig(table).indexes.map((index) => index.config.name);

    expect(tableIndexes(patients)).toContain("patients_practice_id_uq");
    expect(tableIndexes(users)).toContain("users_practice_id_uq");
    expect(tableIndexes(appointments)).toContain(
      "appointments_practice_patient_id_uq",
    );
    expect(tableIndexes(soapNotes)).toContain("soap_notes_practice_record_uq");
    expect(tableIndexes(vitalSigns)).toContain(
      "vital_signs_practice_record_uq",
    );

    const appointmentTuple = (table: typeof soapNotes | typeof vitalSigns) => {
      const reference = getTableConfig(table)
        .foreignKeys.find((foreignKey) =>
          foreignKey.reference().name?.endsWith("practice_appointment_fk"),
        )
        ?.reference();

      return {
        columns: reference?.columns.map((column) => column.name),
        foreignColumns: reference?.foreignColumns.map((column) => column.name),
      };
    };

    expect(appointmentTuple(soapNotes)).toEqual({
      columns: ["practice_id", "appointment_id", "patient_id"],
      foreignColumns: ["practice_id", "id", "patient_id"],
    });
    expect(appointmentTuple(vitalSigns)).toEqual({
      columns: ["practice_id", "appointment_id", "patient_id"],
      foreignColumns: ["practice_id", "id", "patient_id"],
    });
  });

  it("ships the migration, immutable trigger, RLS, and least-privilege grants", () => {
    const migration = readRepoFile(
      "packages/db/drizzle/0047_clinical_record_corrections.sql",
    );
    const journal = readRepoFile("packages/db/drizzle/meta/_journal.json");
    const rls = readRepoFile("packages/db/rls/enable-rls.sql");

    expect(journal).toContain("0047_clinical_record_corrections");
    expect(migration).toContain('CREATE TABLE "clinical_record_corrections"');
    expect(migration).toContain(
      "a SOAP note or vital sign targets a patient or appointment outside its practice",
    );
    expect(migration).toContain("soap_notes_practice_patient_fk");
    expect(migration).toContain("vital_signs_practice_appointment_fk");
    expect(migration).toContain(
      "a.patient_id IS DISTINCT FROM source.patient_id",
    );
    expect(migration).toContain(
      'CONSTRAINT "clinical_record_corrections_practice_patient_fk"',
    );
    expect(migration).toContain(
      'CONSTRAINT "clinical_record_corrections_practice_actor_fk"',
    );
    expect(migration).toContain(
      "CREATE TRIGGER clinical_record_corrections_validate_source",
    );
    expect(migration).toContain(
      "source.appointment_id IS NOT DISTINCT FROM NEW.appointment_id",
    );
    expect(migration).toContain(
      "Clinical correction source does not match its patient and appointment.",
    );
    expect(migration).toContain(
      "Clinical correction events are append-only and cannot be updated or deleted.",
    );
    expect(migration).toContain(
      'ALTER TABLE "clinical_record_corrections" ENABLE ROW LEVEL SECURITY',
    );
    expect(migration).toContain(
      "REVOKE UPDATE, DELETE ON clinical_record_corrections FROM openpims_app",
    );
    expect(rls).toContain("'clinical_record_corrections'");
    expect(rls).toContain(
      "REVOKE UPDATE, DELETE ON clinical_record_corrections FROM openpims_app",
    );
  });

  it("extends the same tenant-safe append-only ledger to vaccination records", () => {
    const config = getTableConfig(clinicalRecordCorrections);
    const vaccinationConfig = getTableConfig(vaccinationRecords);
    const columns = config.columns.map((column) => column.name);
    const indexes = config.indexes.map((index) => index.config.name);
    const foreignKeys = config.foreignKeys.map(
      (foreignKey) => foreignKey.reference().name,
    );
    const migration = readRepoFile(
      "packages/db/drizzle/0054_ambitious_ultimatum.sql",
    );
    const journal = readRepoFile("packages/db/drizzle/meta/_journal.json");

    expect(columns).toContain("vaccination_record_id");
    expect(indexes).toContain(
      "clinical_record_corrections_vaccination_record_uq",
    );
    expect(foreignKeys).toContain(
      "clinical_record_corrections_vaccination_source_fk",
    );
    expect(
      vaccinationConfig.indexes.map((index) => index.config.name),
    ).toContain("vaccination_records_practice_record_uq");
    expect(journal).toContain("0054_ambitious_ultimatum");
    expect(migration).toContain(
      'ALTER TYPE "public"."clinical_correction_record_type" RENAME TO "clinical_correction_record_type_old"',
    );
    expect(migration).toContain(
      "CREATE TYPE \"public\".\"clinical_correction_record_type\" AS ENUM('soap_note', 'vital_sign', 'vaccination_record')",
    );
    expect(migration).toContain(
      'USING "record_type"::text::"public"."clinical_correction_record_type"',
    );
    expect(migration).not.toContain("ADD VALUE 'vaccination_record'");
    expect(
      migration.indexOf("vaccination_records_practice_record_uq"),
    ).toBeLessThan(
      migration.indexOf("clinical_record_corrections_vaccination_source_fk"),
    );
    expect(migration).toContain(
      'CONSTRAINT "clinical_record_corrections_vaccination_source_fk"',
    );
    expect(migration).toContain(
      '"clinical_record_corrections"."record_type" = \'vaccination_record\'',
    );
    expect(migration).toContain(
      'and "clinical_record_corrections"."soap_note_id" is null',
    );
    expect(migration).toContain(
      'and "clinical_record_corrections"."vital_sign_id" is null',
    );
    expect(migration).toContain("ELSIF NEW.record_type = 'vaccination_record'");
    expect(migration).toContain("FROM public.vaccination_records source");
    expect(migration).toContain(
      "source.appointment_id IS NOT DISTINCT FROM NEW.appointment_id",
    );
  });

  it("models lab replacement lineage as a separate exact append-only ledger", () => {
    const correctionConfig = getTableConfig(clinicalRecordCorrections);
    const replacementConfig = getTableConfig(labResultReplacements);
    const correctionColumns = correctionConfig.columns.map(
      (column) => column.name,
    );
    const correctionIndexes = correctionConfig.indexes.map(
      (index) => index.config.name,
    );
    const replacementColumns = replacementConfig.columns.map(
      (column) => column.name,
    );
    const replacementIndexes = replacementConfig.indexes.map(
      (index) => index.config.name,
    );
    const replacementForeignKeys = replacementConfig.foreignKeys.map(
      (foreignKey) => foreignKey.reference().name,
    );

    expect(correctionColumns).toEqual(
      expect.arrayContaining([
        "lab_result_id",
        "operation_id",
        "operation_payload_hash",
      ]),
    );
    expect(correctionIndexes).toEqual(
      expect.arrayContaining([
        "clinical_record_corrections_lab_result_uq",
        "clinical_record_corrections_operation_uq",
        "clinical_record_corrections_practice_record_lab_source_uq",
      ]),
    );
    expect(replacementColumns).toEqual(
      expect.arrayContaining([
        "practice_id",
        "correction_id",
        "source_lab_result_id",
        "replacement_lab_result_id",
        "actor_id",
        "actor_name",
        "operation_id",
        "operation_payload_hash",
      ]),
    );
    expect(replacementColumns).not.toContain("updated_at");
    expect(replacementColumns).not.toContain("deleted_at");
    expect(replacementIndexes).toEqual(
      expect.arrayContaining([
        "lab_result_replacements_source_uq",
        "lab_result_replacements_replacement_uq",
        "lab_result_replacements_operation_uq",
      ]),
    );
    expect(replacementForeignKeys).toEqual(
      expect.arrayContaining([
        "lab_result_replacements_source_tenant_fk",
        "lab_result_replacements_replacement_tenant_fk",
        "lab_result_replacements_correction_source_tenant_fk",
        "lab_result_replacements_actor_tenant_fk",
      ]),
    );
    const exactCorrectionReference = replacementConfig.foreignKeys
      .find(
        (foreignKey) =>
          foreignKey.reference().name ===
          "lab_result_replacements_correction_source_tenant_fk",
      )
      ?.reference();
    expect({
      columns: exactCorrectionReference?.columns.map((column) => column.name),
      foreignColumns: exactCorrectionReference?.foreignColumns.map(
        (column) => column.name,
      ),
    }).toEqual({
      columns: ["practice_id", "correction_id", "source_lab_result_id"],
      foreignColumns: ["practice_id", "id", "lab_result_id"],
    });
    expect(replacementConfig.checks.map((check) => check.name)).toContain(
      "lab_result_replacements_shape_check",
    );
  });

  it("models SOAP replacement lineage as a separate exact append-only ledger", () => {
    const correctionConfig = getTableConfig(clinicalRecordCorrections);
    const replacementConfig = getTableConfig(soapNoteReplacements);
    const correctionIndexes = correctionConfig.indexes.map(
      (index) => index.config.name,
    );
    const replacementColumns = replacementConfig.columns.map(
      (column) => column.name,
    );
    const replacementIndexes = replacementConfig.indexes.map(
      (index) => index.config.name,
    );
    const replacementForeignKeys = replacementConfig.foreignKeys.map(
      (foreignKey) => foreignKey.reference().name,
    );

    expect(correctionIndexes).toContain(
      "clinical_record_corrections_practice_record_soap_source_uq",
    );
    expect(replacementColumns).toEqual(
      expect.arrayContaining([
        "practice_id",
        "correction_id",
        "source_soap_note_id",
        "replacement_soap_note_id",
        "actor_id",
        "actor_name",
        "operation_id",
        "operation_payload_hash",
      ]),
    );
    expect(replacementColumns).not.toContain("updated_at");
    expect(replacementColumns).not.toContain("deleted_at");
    expect(replacementIndexes).toEqual(
      expect.arrayContaining([
        "soap_note_replacements_source_uq",
        "soap_note_replacements_replacement_uq",
        "soap_note_replacements_operation_uq",
      ]),
    );
    expect(replacementForeignKeys).toEqual(
      expect.arrayContaining([
        "soap_note_replacements_source_tenant_fk",
        "soap_note_replacements_replacement_tenant_fk",
        "soap_note_replacements_correction_source_tenant_fk",
        "soap_note_replacements_actor_tenant_fk",
      ]),
    );
    const exactCorrectionReference = replacementConfig.foreignKeys
      .find(
        (foreignKey) =>
          foreignKey.reference().name ===
          "soap_note_replacements_correction_source_tenant_fk",
      )
      ?.reference();
    expect({
      columns: exactCorrectionReference?.columns.map((column) => column.name),
      foreignColumns: exactCorrectionReference?.foreignColumns.map(
        (column) => column.name,
      ),
    }).toEqual({
      columns: ["practice_id", "correction_id", "source_soap_note_id"],
      foreignColumns: ["practice_id", "id", "soap_note_id"],
    });
    expect(replacementConfig.checks.map((check) => check.name)).toContain(
      "soap_note_replacements_shape_check",
    );
  });
});

describe("clinical correction consumers", () => {
  it("keeps history visible while excluding corrected SOAP from readiness and summaries", () => {
    const records = readRepoFile("apps/web/server/routers/records.ts");
    const recordsPage = readRepoFile(
      "apps/web/app/(dashboard)/records/page.tsx",
    );
    const encounters = readRepoFile("apps/web/server/routers/encounters.ts");
    const ai = readRepoFile("apps/web/server/routers/ai.ts");
    const patient = readRepoFile(
      "apps/web/app/(dashboard)/patients/[id]/page.tsx",
    );

    expect(records).toContain(
      "correctionReason: clinicalRecordCorrections.reason",
    );
    expect(encounters).toContain(
      "and ${clinicalRecordCorrections.soapNoteId} = ${soapNotes.id}",
    );
    expect(ai).toContain(
      "and ${clinicalRecordCorrections.soapNoteId} = ${soapNotes.id}",
    );
    expect(patient).toContain(
      '(note) => note.status === "finalized" && !note.correctionId',
    );
    expect(recordsPage).toContain("<ClinicalCorrectionControl");
    expect(recordsPage).toContain("Entered in error");
  });

  it("excludes corrected vitals from current trends and AI/agent context", () => {
    const patient = readRepoFile(
      "apps/web/app/(dashboard)/patients/[id]/page.tsx",
    );
    const ai = readRepoFile("apps/web/server/routers/ai.ts");
    const agent = readRepoFile("apps/web/lib/agent/tools.ts");

    expect(patient).toContain(".filter((vital) => !vital.correctionId)");
    expect(ai).toContain(
      "and ${clinicalRecordCorrections.vitalSignId} = ${vitalSigns.id}",
    );
    expect(agent).toContain(
      "and ${clinicalRecordCorrections.vitalSignId} = ${vitalSigns.id}",
    );
  });

  it("includes originals and correction history in full-practice exports", () => {
    const backup = readRepoFile("apps/web/lib/backup/export.ts");

    expect(backup).toContain('"soapNotes"');
    expect(backup).toContain('"vitalSigns"');
    expect(backup).toContain('"clinicalRecordCorrections"');
    expect(backup).toContain(
      "allPracticeRows(db, clinicalRecordCorrections, practiceId)",
    );
    expect(backup).toContain("allPracticeRows(db, soapNotes, practiceId)");
    expect(backup).toContain("allPracticeRows(db, vitalSigns, practiceId)");
    expect(backup).toContain("referencedSoapNoteIds");
    expect(backup).toContain("referencedVitalSignIds");
    expect(backup).toContain("referencedVaccinationRecordIds");
    expect(backup).toContain(
      'optionalRef(\n    "clinicalRecordCorrections",\n    "vaccinationRecordId",',
    );
    expect(backup).toContain(
      'await restorePracticeRows(\n    "clinicalRecordCorrections"',
    );
  });

  it("excludes corrected vaccinations from every current-record consumer", () => {
    const records = readRepoFile("apps/web/server/routers/records.ts");
    const recordsPage = readRepoFile(
      "apps/web/app/(dashboard)/records/page.tsx",
    );
    const patient = readRepoFile(
      "apps/web/app/(dashboard)/patients/[id]/page.tsx",
    );
    const portal = readRepoFile("apps/web/server/routers/portal.ts");
    const recalls = readRepoFile("apps/web/server/vaccination-recalls.ts");
    const notifications = readRepoFile(
      "apps/web/server/routers/notifications.ts",
    );
    const ai = readRepoFile("apps/web/server/routers/ai.ts");
    const agent = readRepoFile("apps/web/lib/agent/tools.ts");

    expect(records).toContain("markVaccinationEnteredInError");
    expect(records).toContain(
      "correctionReason: clinicalRecordCorrections.reason",
    );
    expect(records).toContain('recordType: "vaccination_record"');
    expect(records).toContain('status: "voided"');
    expect(records).toContain('eq(visitWorkItems.status, "unresolved")');
    expect(records).toContain("isNull(visitWorkItems.invoiceId)");
    expect(records).toContain("isNull(visitWorkItems.invoiceItemId)");
    expect(recordsPage).toContain("correctVaccination.mutateAsync");
    expect(patient).toMatch(
      /vaccinations\s*\.filter\(\(v\) => !v\.correctionId\)\s*\.map/,
    );
    for (const source of [portal, recalls, notifications, ai, agent]) {
      expect(source).toContain("vaccination_record_id");
    }
    for (const source of [recalls, notifications, ai, agent]) {
      expect(source).toContain("newer_correction.vaccination_record_id");
      expect(source).toContain("newer_vaccination.administered_at");
    }
  });

  it("retains corrected allergies while excluding them from current safety consumers", () => {
    const patientsRouter = readRepoFile("apps/web/server/routers/patients.ts");
    const records = readRepoFile("apps/web/server/routers/records.ts");
    const ai = readRepoFile("apps/web/server/routers/ai.ts");
    const portal = readRepoFile("apps/web/server/routers/portal.ts");
    const patientPage = readRepoFile(
      "apps/web/app/(dashboard)/patients/[id]/page.tsx",
    );
    const encounterPage = readRepoFile(
      "apps/web/app/(dashboard)/encounters/[appointmentId]/page.tsx",
    );
    const backup = readRepoFile("apps/web/lib/backup/export.ts");

    expect(patientsRouter).toContain("markAllergyEnteredInError");
    expect(patientsRouter).toContain('recordType: "patient_allergy"');
    expect(patientsRouter).toContain("allergyHistory");
    for (const source of [records, ai, portal]) {
      expect(source).toContain(
        "allergy_correction.patient_allergy_id = ${patientAllergies.id}",
      );
    }
    expect(patientPage).toContain("Allergy correction history");
    expect(patientPage).toContain(
      'triggerLabel="Mark allergy entered in error"',
    );
    for (const source of [patientPage, encounterPage]) {
      expect(source).toContain(
        'Reaction: {allergy.reaction || "Not documented"}',
      );
    }
    expect(backup).toContain('"patientAllergyId"');
    expect(backup).toContain('row.recordType === "patient_allergy"');
  });

  it("uses an accessible, explicit confirmation dialog for permanent corrections", () => {
    const control = readRepoFile(
      "apps/web/components/records/clinical-correction-control.tsx",
    );

    expect(control).toContain("<DialogPrimitive.Root");
    expect(control).toContain("<DialogPrimitive.Title");
    expect(control).toContain("<DialogPrimitive.Description");
    expect(control).toContain("htmlFor={reasonId}");
    expect(control).toContain("id={reasonId}");
    expect(control).toContain("CLINICAL_CORRECTION_REASON_MAX_LENGTH");
    expect(control).toContain("Confirm correction");
    expect(control).toContain("The original record will remain visible");
  });
});
