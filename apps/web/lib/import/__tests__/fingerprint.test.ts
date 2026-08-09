import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { migrationImportFingerprint } from "../fingerprint";

describe("migration import fingerprints", () => {
  it("is deterministic, versioned by mode, and delimiter-safe", () => {
    const first = migrationImportFingerprint("clients", ["a|b", "c"]);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(migrationImportFingerprint("clients", ["a|b", "c"])).toBe(first);
    expect(migrationImportFingerprint("clients", ["a", "b|c"])).not.toBe(first);
    expect(migrationImportFingerprint("patients", ["a|b", "c"])).not.toBe(
      first,
    );
  });

  it("ships partial tenant-scoped uniqueness for all four import destinations", () => {
    const migration = readFileSync(
      resolve(process.cwd(), "../../packages/db/drizzle/0051_wide_maximus.sql"),
      "utf8",
    );

    for (const table of [
      "clients",
      "patients",
      "soap_notes",
      "vaccination_records",
    ]) {
      expect(migration).toContain(
        `CREATE UNIQUE INDEX "${table}_import_fingerprint_uq"`,
      );
      expect(migration).toContain(
        `("practice_id","import_fingerprint") WHERE "${table}"."import_fingerprint" is not null and "${table}"."deleted_at" is null`,
      );
      expect(migration).toContain(
        `CONSTRAINT "${table}_import_fingerprint_check"`,
      );
    }
  });
});
