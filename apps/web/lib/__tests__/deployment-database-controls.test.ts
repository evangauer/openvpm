import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertDatabaseTarget,
  databaseTargetFingerprint,
  supabaseProjectRef,
} from "@openpims/db/deployment-target";
import {
  CANONICAL_0086_MIGRATION_IDENTITY,
  LEGACY_PRODUCTION_0086_MIGRATION_IDENTITY,
  migrationConformanceIssues,
  unexpectedPublicApplicationTables,
  type MigrationIdentity,
} from "@openpims/db/migration-conformance";

const PROJECT_REF = "abcdefghijklmnopqrst";
const OTHER_REF = "zyxwvutsrqponmlkjihg";
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

describe("database deployment target identity", () => {
  it("extracts direct, session-pooler, transaction-pooler, and encoded Supabase project identities", () => {
    expect(
      supabaseProjectRef(
        `postgresql://postgres:secret@db.${PROJECT_REF}.supabase.co:5432/postgres`,
      ),
    ).toBe(PROJECT_REF);
    expect(
      supabaseProjectRef(
        `postgresql://postgres.${PROJECT_REF}:secret@aws-0-us-east-2.pooler.supabase.com:5432/postgres`,
      ),
    ).toBe(PROJECT_REF);
    expect(
      supabaseProjectRef(
        `postgres://postgres.${PROJECT_REF}:secret@aws-0-us-east-2.pooler.supabase.com:6543/postgres`,
      ),
    ).toBe(PROJECT_REF);
    expect(
      supabaseProjectRef(
        `postgresql://postgres%2E${PROJECT_REF}:secret@pooler.supabase.com:6543/postgres`,
      ),
    ).toBe(PROJECT_REF);
  });

  it("rejects non-PostgreSQL and unrelated targets", () => {
    expect(
      supabaseProjectRef(
        `https://postgres:secret@db.${PROJECT_REF}.supabase.co/postgres`,
      ),
    ).toBeNull();
    expect(
      supabaseProjectRef(
        `postgresql://postgres.${PROJECT_REF}:secret@example.com/postgres`,
      ),
    ).toBeNull();
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

  it("allows only the explicit provider table in a ledger-free public schema", () => {
    expect(unexpectedPublicApplicationTables([])).toEqual([]);
    expect(
      unexpectedPublicApplicationTables([
        { name: "spatial_ref_sys", extension: "postgis" },
      ]),
    ).toEqual([]);
    expect(
      unexpectedPublicApplicationTables([
        { name: "spatial_ref_sys", extension: null },
        { name: "patients", extension: null },
        { name: "appointments", extension: null },
      ]),
    ).toEqual(["appointments", "patients", "spatial_ref_sys"]);
  });

  it("requires exact history after migration", () => {
    expect(
      migrationConformanceIssues({
        expected,
        applied: expected,
        mode: "exact",
      }),
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

  it("accepts only the exact historical Production 0086 identity after its tenant helper is proven", () => {
    const expectedWithCanonical0086 = Array.from({ length: 87 }, (_, index) =>
      migration(index.toString(16), String(index)),
    );
    expectedWithCanonical0086[86] = CANONICAL_0086_MIGRATION_IDENTITY;
    const productionHistory = [...expectedWithCanonical0086];
    productionHistory[86] = LEGACY_PRODUCTION_0086_MIGRATION_IDENTITY;

    expect(
      migrationConformanceIssues({
        expected: expectedWithCanonical0086,
        applied: productionHistory,
        mode: "exact",
      }),
    ).toEqual(["Legacy 0086 tenant-context adoption is not proven"]);
    expect(
      migrationConformanceIssues({
        expected: expectedWithCanonical0086,
        applied: productionHistory,
        mode: "exact",
        legacy0086AdoptionProven: true,
      }),
    ).toEqual([]);

    productionHistory[86] = {
      ...LEGACY_PRODUCTION_0086_MIGRATION_IDENTITY,
      hash: "f".repeat(64),
    };
    expect(
      migrationConformanceIssues({
        expected: expectedWithCanonical0086,
        applied: productionHistory,
        mode: "exact",
        legacy0086AdoptionProven: true,
      }),
    ).toEqual(["Database migration history diverges at position 86"]);
  });
});

describe("database control CLI output", () => {
  it("never prints connection target or credential details", () => {
    const sensitiveHost = "synthetic-sensitive-postgres-host.invalid";
    const sensitiveUser = "synthetic_sensitive_user";
    const sensitivePassword = "synthetic_sensitive_password";
    const databaseUrl =
      `postgresql://${sensitiveUser}:${sensitivePassword}@${sensitiveHost}:5432/postgres` +
      "?connect_timeout=1";

    for (const script of [
      "db:drift",
      "db:migrations:conformance",
      "db:rls:preflight",
      "db:rls",
    ]) {
      const result = spawnSync("pnpm", ["--filter", "@openpims/db", script], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 15_000,
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          MIGRATION_CONFORMANCE_MODE: "prefix",
          OPENPIMS_APP_DB_PASSWORD: sensitivePassword,
        },
      });
      expect(result.error, script).toBeUndefined();
      expect(result.status, script).not.toBe(0);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(output, script).not.toContain(sensitiveHost);
      expect(output, script).not.toContain(sensitiveUser);
      expect(output, script).not.toContain(sensitivePassword);
    }
  }, 40_000);
});
