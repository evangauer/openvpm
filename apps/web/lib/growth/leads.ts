import { createHash, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "@openpims/db/client";
import type { DemoDisclosureVersion } from "@/lib/growth/demo-disclosure";

export const LEAD_CAPTURE_SECRET_ENV = "LEAD_CAPTURE_SECRET";
const LEAD_CAPTURE_SECRET_MIN_BYTES = 32;

export type LeadSource = "demo" | "newsletter" | "build";

export function normalizeLeadEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function leadEmailHash(email: string): string {
  return createHash("sha256").update(normalizeLeadEmail(email)).digest("hex");
}

/**
 * Shared secret for the demo deployment's server-to-server lead capture. The
 * demo runs on its own database, so this is how a gated demo email reaches
 * the app that sends follow-up. Unset or short disables capture.
 */
export function leadCaptureSecret(): string | null {
  const value = process.env[LEAD_CAPTURE_SECRET_ENV]?.trim();
  return value && Buffer.byteLength(value, "utf8") >= LEAD_CAPTURE_SECRET_MIN_BYTES
    ? value
    : null;
}

export function leadCaptureAuthorized(
  authorization: string | null,
  secret = leadCaptureSecret(),
): boolean {
  if (!secret || !authorization?.startsWith("Bearer ")) return false;
  const presented = createHash("sha256")
    .update(authorization.slice("Bearer ".length).trim())
    .digest();
  const expected = createHash("sha256").update(secret).digest();
  return timingSafeEqual(presented, expected);
}

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

/**
 * Insert or refresh a lead. A returning visitor keeps their first-seen time,
 * adopts the newest anonymous id, and moves to the disclosure they saw last.
 */
export async function upsertGrowthLead(
  tx: Database,
  input: {
    email: string;
    source: LeadSource;
    anonymousId: string | null;
    disclosureVersion: DemoDisclosureVersion;
    now: Date;
  },
): Promise<{ id: string; created: boolean } | null> {
  const email = normalizeLeadEmail(input.email);
  const now = input.now.toISOString();
  const result = await tx.execute(sql`
    insert into growth_leads (
      email, email_hash, source, anonymous_id, disclosure_version,
      first_seen_at, last_seen_at
    ) values (
      ${email}, ${leadEmailHash(email)}, ${input.source},
      ${input.anonymousId}, ${input.disclosureVersion},
      ${now}::timestamptz, ${now}::timestamptz
    )
    on conflict (email_hash) do update set
      last_seen_at = excluded.last_seen_at,
      seen_count = growth_leads.seen_count + 1,
      anonymous_id = coalesce(excluded.anonymous_id, growth_leads.anonymous_id),
      disclosure_version = excluded.disclosure_version,
      updated_at = excluded.last_seen_at
    returning id, (xmax = 0) as created
  `);
  return rowsFromExecute<{ id: string; created: boolean }>(result)[0] ?? null;
}
