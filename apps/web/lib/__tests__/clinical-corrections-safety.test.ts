import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  appointments,
  clinicalRecordCorrections,
  patients,
  soapNotes,
  users,
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
    expect(patient).toContain(".filter((note) => !note.correctionId)");
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
    expect(backup).toContain(
      'await restorePracticeRows(\n    "clinicalRecordCorrections"',
    );
  });
});
