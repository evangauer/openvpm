import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  IMPORT_CSV_MAX_BYTES,
  csvByteLength,
  isImportCsvSizeValid,
} from "../import/policy";

describe("onboarding import UI", () => {
  const source = readFileSync(
    "components/onboarding/steps/bring-data.tsx",
    "utf8",
  );

  it("dry-runs CSV imports before committing first-run data", () => {
    expect(source).toContain(
      "const importClientsCsv = trpc.data.importClientsCsv.useMutation",
    );
    expect(source).toContain(
      "const importPatientsCsv = trpc.data.importPatientsCsv.useMutation",
    );
    expect(source).toContain("dryRun: true");
    expect(source).toContain("dryRun: false");
    expect(source).toContain("setClientsPreview");
    expect(source).toContain("setPetsPreview");
    expect(source).toContain("previewToken: string;");
    expect(source.match(/previewToken: r\.previewToken/g)).toHaveLength(2);
    expect(source).toContain("previewToken: preview.previewToken");
    expect(source).toContain("previewToken: petsPreview!.previewToken");
    expect(source).toContain("if (result) return true");
    expect(source).toContain("Only the");
    expect(source).toContain("issue rows will be skipped.");
    expect(source).toContain("source: migrationSource");
    expect(source.match(/migrationProtocol: "reviewed-v1"/g)).toHaveLength(4);
    expect(source).toContain("Which system are you moving from?");
    expect(source).toContain("MIGRATION_SOURCES.map");
    expect(source).not.toContain("clientCsv:");
    expect(source).toContain('? "Check client file"');
    expect(source).toContain('"Check pet file"');
    expect(source).toContain("setCommittedClients(committed)");
    expect(source).toContain("Retry the same import; it is safe");
    expect(source).toContain("Download all {errors.length} issues");
    expect(source).toContain(
      "const importInputsBusy = importing || readingFiles",
    );
    expect(source).toContain("continueDisabled: readingFiles");
    expect(source).toContain("if (which === \"clients\") clearImportReview()");
    expect(source).toContain("else clearPetReview()");
    expect(source).toContain("setFileReadPending");
    expect(source).toContain("Request a migration review before the full import");
    expect(source).toContain("willReconcile");
    expect(source).toContain(
      "const fileReadVersionRef = useRef({ clients: 0, pets: 0 })",
    );
    expect(source).toContain(
      "const readVersion = ++fileReadVersionRef.current[which]",
    );
    expect(source).toContain(
      "if (fileReadVersionRef.current[which] !== readVersion) return;",
    );
    expect(source).toContain("invalidatePendingFileReads()");
    expect(source).not.toContain("function parseCSV");
    expect(source).not.toContain("row.first_name");
  });

  it("uses the shared CSV size policy before import dry-runs", () => {
    expect(IMPORT_CSV_MAX_BYTES).toBe(5_000_000);
    expect(csvByteLength("é")).toBe(2);
    expect(isImportCsvSizeValid("a".repeat(IMPORT_CSV_MAX_BYTES))).toBe(true);
    expect(isImportCsvSizeValid("a".repeat(IMPORT_CSV_MAX_BYTES + 1))).toBe(
      false,
    );

    expect(source).toContain('from "@/lib/import/policy"');
    expect(source).toContain("file.size > IMPORT_CSV_MAX_BYTES");
    expect(source).toContain("isImportCsvSizeValid(text)");
    expect(source).toContain(
      "const clientsCsvTooLarge = !isImportCsvSizeValid(clientsCsv);",
    );
    expect(source).toContain(
      "const petsCsvTooLarge = !isImportCsvSizeValid(petsCsv);",
    );
    expect(source).toContain("if (hasImportCsvSizeError) {");
    expect(source.match(/maxLength={IMPORT_CSV_MAX_BYTES}/g)).toHaveLength(2);
    expect(source).toContain("aria-invalid={clientsCsvTooLarge || undefined}");
    expect(source).toContain("aria-invalid={petsCsvTooLarge || undefined}");
    expect(source).toContain('id="clients-csv-size-error"');
    expect(source).toContain('id="pets-csv-size-error"');
  });
});
