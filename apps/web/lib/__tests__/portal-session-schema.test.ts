import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const schema = readFileSync(
  "../../packages/db/schema/portal-sessions.ts",
  "utf8",
);
const clientsSchema = readFileSync(
  "../../packages/db/schema/clients.ts",
  "utf8",
);
const journal = JSON.parse(
  readFileSync("../../packages/db/drizzle/meta/_journal.json", "utf8"),
) as { entries: Array<{ tag: string }> };
const portalMigrationTag = journal.entries.find((entry) =>
  entry.tag.startsWith("0097_"),
)?.tag;
if (!portalMigrationTag) {
  throw new Error("Portal session migration is missing from the journal");
}
const migration = readFileSync(
  `../../packages/db/drizzle/${portalMigrationTag}.sql`,
  "utf8",
);
const rls = readFileSync("../../packages/db/rls/enable-rls.sql", "utf8");

describe("portal session database contract", () => {
  it("stores only hashed revocable sessions with idle and absolute timestamps", () => {
    expect(schema).toContain('"portal_sessions"');
    expect(schema).toContain('tokenHash: varchar("token_hash", { length: 64 })');
    expect(schema).toContain('lastSeenAt: timestamp("last_seen_at"');
    expect(schema).toContain('expiresAt: timestamp("expires_at"');
    expect(schema).toContain('revokedAt: timestamp("revoked_at"');
    expect(schema).toContain("portal_sessions_token_hash_uq");
    expect(schema).toContain("portal_sessions_client_tenant_fk");
  });

  it("enforces one-time bootstrap state and invalidates reusable legacy links", () => {
    expect(clientsSchema).toContain("portalAccessTokenExpiresAt");
    expect(clientsSchema).toContain("portalAccessTokenUsedAt");
    expect(clientsSchema).toContain("clients_portal_access_token_state_check");
    expect(migration).toContain('UPDATE "clients"');
    expect(migration).toContain('SET "access_token" = NULL');
    expect(migration).toContain("clients_portal_access_token_state_check");
  });

  it("keeps portal sessions inside the tenant RLS policy set", () => {
    expect(rls).toContain("'portal_sessions'");
  });
});
