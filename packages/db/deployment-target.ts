import { createHash, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";

const PROJECT_REF_PATTERN = /^[a-z0-9]{15,40}$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;

function decodedUsername(url: URL): string {
  try {
    return decodeURIComponent(url.username);
  } catch {
    return "";
  }
}

/** Extract a Supabase project ref without returning any other URL component. */
export function supabaseProjectRef(databaseUrl: string): string | null {
  try {
    const url = new URL(databaseUrl);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
      return null;
    }
    const hostname = url.hostname.toLowerCase();
    const direct = /^db\.([a-z0-9]{15,40})\.supabase\.co$/.exec(hostname);
    if (direct?.[1] && PROJECT_REF_PATTERN.test(direct[1])) return direct[1];

    if (
      hostname === "pooler.supabase.com" ||
      hostname.endsWith(".pooler.supabase.com")
    ) {
      const username = decodedUsername(url);
      const separator = username.lastIndexOf(".");
      const candidate = separator >= 0 ? username.slice(separator + 1) : "";
      if (PROJECT_REF_PATTERN.test(candidate)) return candidate;
    }
  } catch {
    // The caller receives a generic target-validation failure below.
  }
  return null;
}

export function databaseTargetFingerprint(projectRef: string): string {
  if (!PROJECT_REF_PATTERN.test(projectRef)) {
    throw new Error("Database target identity is invalid");
  }
  return createHash("sha256")
    .update(`supabase-project:${projectRef}`, "utf8")
    .digest("hex");
}

/**
 * Produce a credential-free identity for the database an operator actually
 * connected to. Supabase direct and pooler URLs intentionally converge on the
 * same project fingerprint; other PostgreSQL targets use connection identity
 * without password or query parameters.
 */
export function databaseConnectionIdentityFingerprint(
  databaseUrl: string,
): string {
  const projectRef = supabaseProjectRef(databaseUrl);
  if (projectRef) return databaseTargetFingerprint(projectRef);

  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("Database connection identity is invalid");
  }
  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    !url.hostname ||
    !decodedUsername(url) ||
    !url.pathname.slice(1)
  ) {
    throw new Error("Database connection identity is invalid");
  }
  const port = url.port || "5432";
  let databaseName: string;
  try {
    databaseName = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new Error("Database connection identity is invalid");
  }
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        protocol: "postgresql",
        hostname: url.hostname.toLowerCase(),
        port,
        username: decodedUsername(url),
        databaseName,
      }),
      "utf8",
    )
    .digest("hex");
}

function sameFingerprint(left: string, right: string): boolean {
  if (!FINGERPRINT_PATTERN.test(left) || !FINGERPRINT_PATTERN.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function assertDatabaseTarget(input: {
  databaseUrl: string | undefined;
  expectedFingerprint: string | undefined;
  forbiddenFingerprints?: string | undefined;
}): void {
  const projectRef = input.databaseUrl
    ? supabaseProjectRef(input.databaseUrl)
    : null;
  const expected = input.expectedFingerprint?.trim().toLowerCase() ?? "";
  if (!projectRef || !FINGERPRINT_PATTERN.test(expected)) {
    throw new Error("Database target identity is not configured or recognized");
  }

  const actual = databaseTargetFingerprint(projectRef);
  if (!sameFingerprint(actual, expected)) {
    throw new Error("Database target identity does not match this environment");
  }

  const forbidden = (input.forbiddenFingerprints ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (
    forbidden.length === 0 ||
    forbidden.some((value) => !FINGERPRINT_PATTERN.test(value))
  ) {
    throw new Error("Forbidden database target identities are not configured");
  }
  if (forbidden.some((value) => sameFingerprint(actual, value))) {
    throw new Error(
      "Database target identity is forbidden for this environment",
    );
  }
}

async function main(): Promise<number> {
  try {
    assertDatabaseTarget({
      databaseUrl: process.env.DATABASE_URL,
      expectedFingerprint: process.env.DATABASE_TARGET_FINGERPRINT,
      forbiddenFingerprints: process.env.FORBIDDEN_DATABASE_TARGET_FINGERPRINTS,
    });
    console.log("Database target identity matched.");
    return 0;
  } catch (error) {
    console.error(
      "Database target identity check failed:",
      error instanceof Error ? error.message : "invalid target",
    );
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main();
}
