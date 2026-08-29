import { createHash } from "node:crypto";

const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/;
const POOLER_HOST_PATTERN = /^[a-z0-9-]+\.pooler\.supabase\.com$/;

// Opaque SHA-256 identities for the production project and the existing
// data-bearing recovery source. Neither is an eligible disposable staging
// target, even if an environment variable is accidentally pointed at it.
const PROTECTED_PROJECT_REF_FINGERPRINTS = new Set([
  "65b538ef8991807f6d7f6fe32e6e6a5bd1f074255e6813bc1dae84155081fb34",
  "4cc599b3d417a79e26f45a8238f8e9158a4da0c72af97e11ca559ed3b4992ba9",
]);

export type StagingDatabaseTargetEvidence = {
  projectRefFingerprint: string;
  connectionMode: "direct" | "pooler";
};

function projectRefFingerprint(projectRef: string): string {
  return createHash("sha256").update(projectRef).digest("hex");
}

function expectedProjectRef(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!PROJECT_REF_PATTERN.test(normalized)) {
    throw new Error(
      "STAGING_PROJECT_REF must be an exact 20-character Supabase project ref.",
    );
  }
  return normalized;
}

function databaseUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("STAGING_DATABASE_URL is not a valid URL.");
  }
  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol)) {
    throw new Error("STAGING_DATABASE_URL must use PostgreSQL.");
  }
  if (!parsed.username || !parsed.hostname) {
    throw new Error("STAGING_DATABASE_URL is missing its database identity.");
  }
  return parsed;
}

export function verifyStagingDatabaseTarget(input: {
  databaseUrl: string;
  expectedProjectRef: string;
}): StagingDatabaseTargetEvidence {
  const projectRef = expectedProjectRef(input.expectedProjectRef);
  const parsed = databaseUrl(input.databaseUrl);
  const directHost = `db.${projectRef}.supabase.co`;
  const decodedUsername = decodeURIComponent(parsed.username).toLowerCase();
  let connectionMode: StagingDatabaseTargetEvidence["connectionMode"];

  if (parsed.hostname.toLowerCase() === directHost) {
    connectionMode = "direct";
  } else if (
    POOLER_HOST_PATTERN.test(parsed.hostname.toLowerCase()) &&
    decodedUsername.endsWith(`.${projectRef}`)
  ) {
    connectionMode = "pooler";
  } else {
    throw new Error(
      "STAGING_DATABASE_URL does not identify the configured Supabase staging project.",
    );
  }

  const fingerprint = projectRefFingerprint(projectRef);
  if (PROTECTED_PROJECT_REF_FINGERPRINTS.has(fingerprint)) {
    throw new Error(
      "Configured Supabase project is a protected data-bearing environment, not isolated staging.",
    );
  }

  return { projectRefFingerprint: fingerprint, connectionMode };
}
