import { createHash } from "node:crypto";

export type ImportFingerprintMode =
  | "clients"
  | "patients"
  | "vaccinations"
  | "soap_notes";

const IMPORT_FINGERPRINT_SCHEMA_VERSION = 1;

/**
 * Privacy-minimized, deterministic identity for rows created by migration.
 * Only the digest is persisted. The versioned JSON envelope avoids delimiter
 * ambiguity and permits an intentional future identity-policy migration.
 */
export function migrationImportFingerprint(
  mode: ImportFingerprintMode,
  identityParts: readonly (string | null)[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: IMPORT_FINGERPRINT_SCHEMA_VERSION,
        mode,
        identityParts,
      }),
      "utf8",
    )
    .digest("hex");
}
