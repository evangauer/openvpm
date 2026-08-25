import { describe, expect, it } from "vitest";
import {
  assertDatabaseTarget,
  databaseTargetFingerprint,
  supabaseProjectRef,
} from "@openpims/db/deployment-target";
import {
  migrationConformanceIssues,
  type MigrationIdentity,
} from "@openpims/db/migration-conformance";

const PROJECT_REF = "abcdefghijklmnopqrst";
const OTHER_REF = "zyxwvutsrqponmlkjihg";

describe("database deployment target identity", () => {
  it("extracts direct and pooler Supabase project identities", () => {
    expect(
      supabaseProjectRef(
        `postgresql://postgres:secret@db.${PROJECT_REF}.supabase.co:5432/postgres`,
      ),
    ).toBe(PROJECT_REF);
    expect(
      supabaseProjectRef(
        `postgresql://postgres.${PROJECT_REF}:secret@aws-0-us-east-2.pooler.supabase.com:6543/postgres`,
      ),
    ).toBe(PROJECT_REF);
  });

  it("accepts only the expected, non-forbidden fingerprint", () => {
    const databaseUrl = `postgresql://postgres.${PROJECT_REF}:secret@aws-0-us-east-2.pooler.supabase.com:6543/postgres`;
    expect(() =>
      assertDatabaseTarget({
        databaseUrl,
        expectedFingerprint: databaseTargetFingerprint(PROJECT_REF),
        forbiddenFingerprints: databaseTargetFingerprint(OTHER_REF),
      }),
    ).not.toThrow();
    expect(() =>
      assertDatabaseTarget({
        databaseUrl,
        expectedFingerprint: databaseTargetFingerprint(PROJECT_REF),
        forbiddenFingerprints: databaseTargetFingerprint(PROJECT_REF),
      }),
    ).toThrow("forbidden");
  });

  it("requires at least one well-formed forbidden target fingerprint", () => {
    const databaseUrl = `postgresql://postgres.${PROJECT_REF}:secret@pooler.supabase.com/postgres`;
    for (const forbiddenFingerprints of [undefined, "not-a-fingerprint"]) {
      expect(() =>
        assertDatabaseTarget({
          databaseUrl,
          expectedFingerprint: databaseTargetFingerprint(PROJECT_REF),
          forbiddenFingerprints,
        }),
      ).toThrow("Forbidden database target identities are not configured");
    }
  });

  it("fails generically without returning URL credentials or target values", () => {
    const secret = "do-not-log-this";
    let message = "";
    try {
      assertDatabaseTarget({
        databaseUrl: `postgresql://postgres.${PROJECT_REF}:${secret}@pooler.supabase.com/postgres`,
        expectedFingerprint: databaseTargetFingerprint(OTHER_REF),
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe(
      "Database target identity does not match this environment",
    );
    expect(message).not.toContain(secret);
    expect(message).not.toContain(PROJECT_REF);
  });
});

const migration = (suffix: string, createdAt: string): MigrationIdentity => ({
  hash: suffix.padStart(64, "0"),
  createdAt,
});

describe("migration ledger conformance", () => {
  const expected = [migration("a", "1"), migration("b", "2")];

  it("accepts empty and proper prefixes before migration", () => {
    expect(
      migrationConformanceIssues({ expected, applied: [], mode: "prefix" }),
    ).toEqual([]);
    expect(
      migrationConformanceIssues({
        expected,
        applied: expected.slice(0, 1),
        mode: "prefix",
      }),
    ).toEqual([]);
  });

  it("requires exact history after migration", () => {
    expect(
      migrationConformanceIssues({ expected, applied: expected, mode: "exact" }),
    ).toEqual([]);
    expect(
      migrationConformanceIssues({
        expected,
        applied: expected.slice(0, 1),
        mode: "exact",
      }),
    ).toEqual(["Database migration history is behind committed history"]);
  });

  it("rejects changed, reordered, and ahead histories", () => {
    expect(
      migrationConformanceIssues({
        expected,
        applied: [migration("c", "1")],
        mode: "prefix",
      }),
    ).toEqual(["Database migration history diverges at position 0"]);
    expect(
      migrationConformanceIssues({
        expected,
        applied: [...expected, migration("c", "3")],
        mode: "prefix",
      }),
    ).toEqual(["Database migration history is ahead of committed history"]);
  });
});
