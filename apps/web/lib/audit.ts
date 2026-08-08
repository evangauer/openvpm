import type { Database } from "@openpims/db/client";
import { auditLog } from "@openpims/db";

/**
 * Audit logging for mutations. The pure helpers (path parsing, secret
 * redaction, entity-id extraction) are unit-tested; recordAuditLog performs the
 * best-effort insert and must never throw into the request path.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET_KEY_RE = /pass(word)?|secret|token|keyhash|^key$|apikey/i;
// Bulk import/restore payloads (raw CSV, full backup JSON) can be megabytes of
// medical records + client PII. The audit trail records who ran the import and
// when, not a second copy of the data, so these are replaced with a marker.
const BULK_PAYLOAD_KEY_RE = /(?:csv$|^backup$)/i;

/** "clients.create" -> { entityType: "clients", action: "create" }. */
export function parseAuditPath(path: string): {
  entityType: string;
  action: string;
} {
  const dot = path.indexOf(".");
  const entityType = (dot === -1 ? path : path.slice(0, dot)).slice(0, 64);
  const action = (dot === -1 ? "" : path.slice(dot + 1)).slice(0, 64);
  return { entityType, action };
}

function redactSecretValue(input: unknown): unknown {
  if (Array.isArray(input)) {
    return input.map(redactSecretValue);
  }
  if (!input || typeof input !== "object") {
    return input;
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    out[key] = SECRET_KEY_RE.test(key)
      ? "[redacted]"
      : BULK_PAYLOAD_KEY_RE.test(key)
        ? "[redacted-bulk-payload]"
        : redactSecretValue(value);
  }
  return out;
}

/** Recursively redact secret-ish fields so they never land in the audit trail. */
export function redactSecrets(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return input == null ? null : { value: "[redacted-nonobject]" };
  }
  return redactSecretValue(input) as Record<string, unknown>;
}

/** Best-effort entity id: prefer the created/updated row's id, else input.id. */
export function extractEntityId(
  rawInput: unknown,
  resultData: unknown,
): string | null {
  const fromResult = (resultData as { id?: unknown } | null)?.id;
  if (typeof fromResult === "string" && UUID_RE.test(fromResult))
    return fromResult;
  const fromInput = (rawInput as { id?: unknown } | null)?.id;
  if (typeof fromInput === "string" && UUID_RE.test(fromInput))
    return fromInput;
  return null;
}

export async function recordAuditLog(
  db: Database,
  opts: {
    practiceId: string;
    userId: string;
    ip?: string | null;
    path: string;
    rawInput: unknown;
    resultData: unknown;
  },
): Promise<void> {
  try {
    const { entityType, action } = parseAuditPath(opts.path);
    await db.insert(auditLog).values({
      practiceId: opts.practiceId,
      userId: opts.userId,
      action,
      entityType,
      entityId: extractEntityId(opts.rawInput, opts.resultData),
      changes: redactSecrets(opts.rawInput),
      ipAddress: opts.ip ?? null,
    });
  } catch (err) {
    // Auditing must never break the request it's recording.
    console.error("[audit] failed to record:", err);
  }
}
