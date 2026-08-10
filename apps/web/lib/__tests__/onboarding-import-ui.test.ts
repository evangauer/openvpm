import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  IMPORT_CSV_MAX_BYTES,
  csvByteLength,
  isImportCsvSizeValid,
} from "../import/policy";
import { MIGRATION_STEPS } from "../import/sources";

describe("onboarding import UI", () => {
  const source = readFileSync(
    "components/onboarding/steps/bring-data.tsx",
    "utf8",
  );
  const journeySource = readFileSync(
    "components/onboarding/journey-overlay.tsx",
    "utf8",
  );

  it("offers the complete four-stage clinic migration in safe order", () => {
    expect(MIGRATION_STEPS.map((step) => step.mode)).toEqual([
      "clients",
      "patients",
      "vaccinations",
      "soapNotes",
    ]);
    expect(source).toContain(
      "const importClientsCsv = trpc.data.importClientsCsv.useMutation",
    );
    expect(source).toContain(
      "const importPatientsCsv = trpc.data.importPatientsCsv.useMutation",
    );
    expect(source).toContain(
      "const importVaccinationsCsv = trpc.data.importVaccinationsCsv.useMutation",
    );
    expect(source).toContain(
      "const importSoapNotesCsv = trpc.data.importSoapNotesCsv.useMutation",
    );
    expect(source).toContain("MIGRATION_STEPS.slice(0, 2)");
    expect(source).toContain("MIGRATION_STEPS.slice(2)");
    expect(source).toContain("Also bring vaccine and visit history");
    expect(source).toContain(
      "History attaches only to a safely matched real patient",
    );
    expect(journeySource).toContain('title: "Bring your clinic records."');
    expect(journeySource).not.toContain(
      'title: "Add your real clients and pets."',
    );
  });

  it("previews every supplied file before its exact reviewed commit", () => {
    expect(source).toContain("dryRun: true");
    expect(source).toContain("dryRun: false");
    expect(source).toContain('migrationProtocol: "reviewed-v1"');
    expect(source).toContain("previewToken: activePreview.previewToken");
    expect(source).toContain(
      "nextOnboardingImportMode(selectedByMode, committedByMode)",
    );
    expect(source).toContain("setPreviewByMode");
    expect(source).toContain("setCommittedByMode");
    expect(source).toContain("if (result) return true");
    expect(source).toContain(
      "planned changes and every issue before you confirm",
    );
    expect(source).toContain("Start with a small representative sample");
    expect(source).toContain("has no one-click rollback");
    expect(source).toContain("Earlier completed stages are safe");
    expect(source).toContain("Retry the same import. It is safe");
    expect(source).toContain(
      "response.alreadyCommitted && response.errors.length === 0",
    );
    expect(source).toContain("? activePreview.errors");
    expect(source).not.toContain("if (activePreview.total === 0) {");
    expect(source).toContain("`all ${errors.length} issues`");
    expect(source).not.toContain("clientCsv:");
    expect(source).not.toContain("function parseCSV");
    expect(source).not.toContain("row.first_name");
  });

  it("guards stale file reads and preserves committed upstream stages", () => {
    expect(source).toContain(
      "const fileReadVersionRef = useRef(importMap(() => 0))",
    );
    expect(source).toContain(
      "const readVersion = ++fileReadVersionRef.current[mode]",
    );
    expect(source).toContain(
      "if (fileReadVersionRef.current[mode] !== readVersion) return;",
    );
    expect(source).toContain("clearReviewFrom(mode)");
    expect(source).toContain("isOnboardingImportModeLocked");
    expect(source).toContain("lastCommittedImportIndex");
    expect(source).toContain("continueDisabled: readingFiles");
    expect(source).toContain("setFileReadPending");
    expect(source).toContain("invalidatePendingFileReads()");
    expect(source).toContain('input.value = ""');
    expect(source).toContain("state.migrationSource");
    expect(source).toContain(
      "migrationCompletedModes: nextKnownCompletedModes",
    );
    expect(source).toContain("Already reviewed:");
    expect(source.match(/clearAllImportReview\(\)/g)).toHaveLength(4);
    expect(source).toContain(
      "Ask us to review your full-history export before import",
    );
  });

  it("uses the shared UTF-8 CSV size policy on all stages", () => {
    expect(IMPORT_CSV_MAX_BYTES).toBe(5_000_000);
    expect(csvByteLength("é")).toBe(2);
    expect(isImportCsvSizeValid("a".repeat(IMPORT_CSV_MAX_BYTES))).toBe(true);
    expect(isImportCsvSizeValid("a".repeat(IMPORT_CSV_MAX_BYTES + 1))).toBe(
      false,
    );

    expect(source).toContain('from "@/lib/import/policy"');
    expect(source).toContain("file.size > IMPORT_CSV_MAX_BYTES");
    expect(source).toContain("isImportCsvSizeValid(text)");
    expect(source).toContain("csvMetaByMode[mode].sizeValid");
    expect(source).toContain("maxLength={IMPORT_CSV_MAX_BYTES}");
    expect(source).toContain("aria-invalid={tooLarge || undefined}");
    expect(source).toContain(
      "aria-label={`Paste ${step.label.toLowerCase()} CSV text`}",
    );
    expect(source).toContain("aria-pressed={active}");
    expect(source).toContain("`${step.mode}-csv-size-error`");
  });

  it("shows complete result and issue summaries", () => {
    expect(source).toContain("result.imported.clients");
    expect(source).toContain("result.imported.patients");
    expect(source).toContain("result.imported.vaccinations");
    expect(source).toContain("result.imported.soapNotes");
    expect(source).toContain("result.reconciled");
    expect(source).toContain("result.errors");
    expect(
      MIGRATION_STEPS.find((step) => step.mode === "patients")?.unmatchedLabel,
    ).toBe("Missing owners");
    expect(
      MIGRATION_STEPS.find((step) => step.mode === "vaccinations")
        ?.unmatchedLabel,
    ).toBe("Missing pets");
    expect(source).toContain("Ready with issues to review");
    expect(source).toContain('label="Valid rows parsed"');
    expect(source).not.toContain("issue rows will be skipped");
    expect(source).toContain("Review completed with issues");
    expect(source).toContain("Fix skipped records in Settings, then Data");
    expect(source).toContain("migrationHasCommittedChanges: true");
    expect(source).toContain("migrationSourceHasCommittedChanges: true");
    expect(source).toContain(
      "disabled={importInputsBusy || migrationSourceLocked}",
    );
    expect(source).toContain("isCustomMigrationSource ? (");
    expect(source).toContain("<option value={migrationSource}>");
    expect(source).toContain("setKnownCompletedModes([])");
    expect(source).toContain("migrationCompletedModes: []");
    expect(source).not.toContain("knownCompletedModes.length > 0 ||");
    expect(source).toContain("state.keepSampleData && !hasImportedRows");
    expect(source).toContain("hasPartialImport: hasCommittedStages && !result");
  });
});
