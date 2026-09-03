import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { consentRequests } from "@openpims/db";

describe("consent signature persistence schema", () => {
  it("stores nullable exact PNG evidence without invalidating legacy rows", () => {
    const config = getTableConfig(consentRequests);
    const columns = new Map(
      config.columns.map((column) => [column.name, column.getSQLType()]),
    );
    expect(columns.get("signature_png_bytes")).toBe("bytea");
    expect(columns.get("signature_sha256")).toBe("varchar(64)");
    expect(consentRequests.signaturePngBytes.notNull).toBe(false);
    expect(consentRequests.signatureSha256.notNull).toBe(false);
    expect(columns.get("token_hash")).toBe("varchar(64)");
    expect(columns.get("signer_attestation_version")).toBe("varchar(64)");
    expect(columns.get("document_render_version")).toBe("varchar(32)");
    expect(columns.get("storage_lease_token")).toBe("uuid");
    expect(columns.get("storage_lease_expires_at")).toBe(
      "timestamp with time zone",
    );
    expect(consentRequests.token.notNull).toBe(false);
    expect(consentRequests.tokenHash.notNull).toBe(false);
  });

  it("registers paired, bounded, content-hash integrity constraints", () => {
    const checkNames = getTableConfig(consentRequests).checks.map(
      (constraint) => constraint.name,
    );
    expect(checkNames).toEqual(
      expect.arrayContaining([
        "consent_requests_signature_evidence_pair_check",
        "consent_requests_signature_evidence_size_check",
        "consent_requests_signature_evidence_hash_check",
        "consent_requests_credential_storage_check",
        "consent_requests_token_hash_format_check",
        "consent_requests_document_render_version_check",
        "consent_requests_storage_lease_pair_check",
        "consent_requests_storage_lease_state_check",
      ]),
    );

    const source = readFileSync("../../packages/db/schema/consents.ts", "utf8");
    expect(source).toContain("octet_length(${table.signaturePngBytes})");
    expect(source).toContain("pg_catalog.sha256(${table.signaturePngBytes})");
    expect(source).toContain("'^[0-9a-f]{64}$'");
    // The signed arm deliberately does not require the new fields, preserving
    // rows completed before exact signature evidence was introduced.
    expect(source).toContain(
      "${table.status} = 'signed' and ${table.signerName} is not null and ${table.signedAt} is not null and ${table.fileId} is not null)",
    );
  });

  it("stages stronger checks without dropping the validated live guard", () => {
    const migration = readFileSync(
      "../../packages/db/drizzle/0082_overconfident_manta.sql",
      "utf8",
    );
    expect(migration).not.toContain(
      'DROP CONSTRAINT "consent_requests_signing_evidence_check"',
    );
    expect(migration).toContain(
      'ADD CONSTRAINT "consent_requests_signing_signature_evidence_check"',
    );
    expect(migration.match(/ADD CONSTRAINT[^\n]+NOT VALID/g)).toHaveLength(5);

    const preflight = readFileSync(
      "../../packages/db/preflight/0083_validate_recovery_hold_consent_signature.sql",
      "utf8",
    );
    expect(preflight).toContain("owner-visible gate");
    expect(preflight).toContain("invalid_signature_states");
    expect(preflight).toContain(
      "missing_or_unvalidated_live_signing_constraint",
    );
    expect(preflight).toContain(
      "c.conname = 'consent_requests_signing_evidence_check'",
    );
    expect(preflight).toContain("c.contype = 'c'");
    expect(preflight).toContain("c.convalidated");
    expect(preflight).toContain("missing_staged_constraints");
  });
});
