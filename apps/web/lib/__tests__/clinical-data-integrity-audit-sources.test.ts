import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const auditSources = [
  "audit-controlled-substance-ledger.ts",
  "audit-prescription-integrity.ts",
  "audit-lab-result-integrity.ts",
  "audit-vaccination-integrity.ts",
] as const;

describe("clinical-data integrity audit source contract", () => {
  for (const file of auditSources) {
    it(`${file} emits fresh, target-bound aggregate evidence`, () => {
      const source = readFileSync(
        fileURLToPath(
          new URL(`../../../../packages/db/${file}`, import.meta.url),
        ),
        "utf8",
      );
      expect(source).toContain("databaseConnectionIdentityFingerprint");
      expect(source).toContain('mode: "read_only_aggregate"');
      expect(source).toContain("checkedAt: new Date().toISOString()");
      expect(source).toContain("databaseTargetFingerprint,");
      expect(source).toContain("releaseSafe:");
    });
  }
});
