import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  platformEmailIdentity,
  platformEmailIdentityAliases,
} from "@openpims/db";

function readRepoFile(path: string): string {
  return readFileSync(new URL(`../../../../${path}`, import.meta.url), "utf8");
}

describe("platform email identity rotation schema", () => {
  it("stores only fingerprints and keyed hashes in an immutable alias registry", () => {
    const identity = getTableConfig(platformEmailIdentity);
    const aliases = getTableConfig(platformEmailIdentityAliases);

    expect(identity.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "identity_key_fingerprint",
        "previous_identity_key_fingerprint",
        "rotation_started_at",
      ]),
    );
    expect(identity.checks.map((check) => check.name)).toEqual(
      expect.arrayContaining([
        "platform_email_identity_previous_fingerprint_check",
        "platform_email_identity_distinct_fingerprints_check",
        "platform_email_identity_rotation_state_check",
      ]),
    );

    const aliasColumns = aliases.columns.map((column) => column.name);
    expect(aliasColumns).toEqual(
      expect.arrayContaining([
        "current_identity_key_fingerprint",
        "current_email_hash",
        "previous_identity_key_fingerprint",
        "previous_email_hash",
      ]),
    );
    expect(aliasColumns).not.toEqual(
      expect.arrayContaining(["email", "recipient_email", "secret"]),
    );
    expect(aliases.indexes.map((index) => index.config.name)).toEqual(
      expect.arrayContaining([
        "platform_email_identity_aliases_current_uq",
        "platform_email_identity_aliases_previous_uq",
      ]),
    );
    expect(aliases.columns.map((column) => column.name)).not.toContain(
      "updated_at",
    );
  });

  it("ships constrained migration and system-only least-privilege RLS", () => {
    const migration = readRepoFile(
      "packages/db/drizzle/0101_colorful_stark_industries.sql",
    );
    const rls = readRepoFile("packages/db/rls/enable-rls.sql");

    expect(migration).toContain(
      'CREATE TABLE "platform_email_identity_aliases"',
    );
    expect(
      migration.indexOf("SET LOCAL search_path = public, pg_catalog"),
    ).toBeLessThan(
      migration.indexOf('CREATE TABLE "platform_email_identity_aliases"'),
    );
    expect(migration).toContain(
      'CONSTRAINT "platform_email_identity_rotation_state_check"',
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "platform_email_identity_aliases_current_uq"',
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "platform_email_identity_aliases_previous_uq"',
    );
    expect(migration).toContain(
      "ALTER TABLE platform_email_identity_aliases ENABLE ROW LEVEL SECURITY",
    );
    expect(migration).toContain(
      "GRANT SELECT, INSERT ON platform_email_identity_aliases TO openpims_app",
    );
    expect(migration).not.toContain(
      "GRANT SELECT, INSERT, UPDATE ON platform_email_identity_aliases",
    );
    expect(migration).not.toContain(
      "GRANT SELECT, INSERT, DELETE ON platform_email_identity_aliases",
    );

    expect(rls).toContain(
      "ALTER TABLE platform_email_identity_aliases ENABLE ROW LEVEL SECURITY",
    );
    expect(rls).toContain(
      "CREATE POLICY system_read ON platform_email_identity_aliases",
    );
    expect(rls).toContain(
      "CREATE POLICY system_insert ON platform_email_identity_aliases",
    );
    expect(rls).toContain(
      "GRANT SELECT, INSERT ON platform_email_identity_aliases TO openpims_app",
    );
    expect(rls).not.toContain(
      "GRANT SELECT, INSERT, UPDATE ON platform_email_identity_aliases",
    );
    expect(rls).not.toContain(
      "GRANT SELECT, INSERT, DELETE ON platform_email_identity_aliases",
    );
  });
});
