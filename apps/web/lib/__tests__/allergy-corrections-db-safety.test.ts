import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { clinicalRecordCorrections, patientAllergies } from "@openpims/db";

const MIGRATION = "packages/db/drizzle/0074_hesitant_franklin_richards.sql";

function readRepoFile(path: string): string {
  return readFileSync(new URL(`../../../../${path}`, import.meta.url), "utf8");
}

describe("patient allergy correction database safety", () => {
  it("binds one correction to the exact allergy and patient source", () => {
    const allergyConfig = getTableConfig(patientAllergies);
    const correctionConfig = getTableConfig(clinicalRecordCorrections);
    const allergyIndexes = allergyConfig.indexes.map(
      (index) => index.config.name,
    );
    const correctionIndexes = correctionConfig.indexes.map(
      (index) => index.config.name,
    );
    const patientAllergySource = correctionConfig.foreignKeys
      .find(
        (foreignKey) =>
          foreignKey.reference().name ===
          "clinical_record_corrections_patient_allergy_source_fk",
      )
      ?.reference();

    expect(correctionConfig.columns.map((column) => column.name)).toContain(
      "patient_allergy_id",
    );
    expect(
      correctionConfig.columns.find((column) => column.name === "record_type")
        ?.enumValues,
    ).toContain("patient_allergy");
    expect(allergyIndexes).toContain("patient_allergies_id_patient_uq");
    expect(correctionIndexes).toContain(
      "clinical_record_corrections_patient_allergy_uq",
    );
    expect({
      columns: patientAllergySource?.columns.map((column) => column.name),
      foreignColumns: patientAllergySource?.foreignColumns.map(
        (column) => column.name,
      ),
    }).toEqual({
      columns: ["patient_allergy_id", "patient_id"],
      foreignColumns: ["id", "patient_id"],
    });
  });

  it("ships a transaction-safe migration with ordered constraints", () => {
    const migration = readRepoFile(MIGRATION);
    const journal = JSON.parse(
      readRepoFile("packages/db/drizzle/meta/_journal.json"),
    ) as { entries?: Array<{ tag?: string }> };
    const sourceUniqueAt = migration.indexOf(
      'CREATE UNIQUE INDEX "patient_allergies_id_patient_uq"',
    );
    const exactSourceFkAt = migration.indexOf(
      'ADD CONSTRAINT "clinical_record_corrections_patient_allergy_source_fk"',
    );

    expect(journal.entries?.map((entry) => entry.tag)).toContain(
      "0074_hesitant_franklin_richards",
    );
    expect(migration).not.toContain("ADD VALUE 'patient_allergy'");
    expect(migration).toContain(
      'ALTER TYPE "public"."clinical_correction_record_type" RENAME TO "clinical_correction_record_type_old"',
    );
    expect(migration).toContain("'lab_result', 'patient_allergy'");
    expect(migration).toContain(
      'USING "record_type"::text::"public"."clinical_correction_record_type"',
    );
    expect(
      migration.indexOf(
        'DROP CONSTRAINT "clinical_record_corrections_operation_shape_check"',
      ),
    ).toBeLessThan(
      migration.indexOf(
        'ALTER COLUMN "record_type" TYPE "public"."clinical_correction_record_type"',
      ),
    );
    expect(
      migration.indexOf(
        'ADD CONSTRAINT "clinical_record_corrections_operation_shape_check"',
      ),
    ).toBeGreaterThan(
      migration.indexOf(
        'ALTER COLUMN "record_type" TYPE "public"."clinical_correction_record_type"',
      ),
    );
    expect(sourceUniqueAt).toBeGreaterThan(0);
    expect(exactSourceFkAt).toBeGreaterThan(sourceUniqueAt);
    expect(migration).toContain("ELSIF NEW.record_type = 'patient_allergy'");
    expect(migration).toContain("FROM public.patient_allergies source");
    expect(migration).toContain(
      "JOIN public.patients patient ON patient.id = source.patient_id",
    );
    expect(migration).toContain("patient.practice_id = NEW.practice_id");
    expect(migration).toContain("source.patient_id = NEW.patient_id");
    expect(migration).toContain('"appointment_id" is null');
  });

});
