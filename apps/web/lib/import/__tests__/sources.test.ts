import { describe, expect, it } from "vitest";
import {
  isValidMigrationSource,
  migrationSourceExportHint,
  migrationSourceName,
} from "../sources";

describe("migration source identity", () => {
  it("preserves valid custom source IDs with a safe resume label", () => {
    expect(isValidMigrationSource("legacy_pims")).toBe(true);
    expect(migrationSourceName("legacy_pims")).toBe(
      "Previous source (legacy_pims)",
    );
    expect(migrationSourceExportHint("legacy_pims")).toContain(
      "Keep using this exact source",
    );
  });

  it("rejects source values outside the import contract", () => {
    expect(isValidMigrationSource("Legacy PIMS")).toBe(false);
    expect(isValidMigrationSource("<script>")).toBe(false);
    expect(isValidMigrationSource("a".repeat(65))).toBe(false);
  });

  it("keeps preset display copy unchanged", () => {
    expect(migrationSourceName("shepherd")).toBe("Shepherd");
    expect(migrationSourceExportHint("shepherd")).toContain("Reports");
  });
});
