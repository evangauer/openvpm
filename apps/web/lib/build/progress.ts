import { sql } from "drizzle-orm";
import type { Database } from "@openpims/db/client";
import { rowsFromExecute } from "@/lib/db/execute-rows";
import {
  BUILD_SAVE_DISCLOSURE_VERSION,
  BUILD_SCENES,
  buildSavedStateSchema,
  type BuildSavedState,
  type BuildScene,
} from "@/lib/build/catalog";
import {
  createFeedbackToken,
  verifyFeedbackToken,
  type FeedbackTokenOptions,
} from "@/lib/growth/feedback-token";
import { leadEmailHash, normalizeLeadEmail } from "@/lib/growth/leads";

export const BUILD_RESUME_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const RESUME_PURPOSE = "openvpm.build-resume.v1";

export interface BuildProgress {
  state: BuildSavedState;
  scene: BuildScene;
  savedAt: string;
  disclosureVersion: typeof BUILD_SAVE_DISCLOSURE_VERSION;
}

export function parseBuildProgress(value: unknown): BuildProgress | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const state = buildSavedStateSchema.safeParse(raw.state);
  if (
    !state.success ||
    !BUILD_SCENES.includes(raw.scene as BuildScene) ||
    typeof raw.savedAt !== "string" ||
    raw.disclosureVersion !== BUILD_SAVE_DISCLOSURE_VERSION
  ) {
    return null;
  }
  return {
    state: state.data,
    scene: raw.scene as BuildScene,
    savedAt: raw.savedAt,
    disclosureVersion: BUILD_SAVE_DISCLOSURE_VERSION,
  };
}

/**
 * Save someone's build under their email. A new address becomes a "build"
 * lead; an address we already know (say, from the demo) keeps its source and
 * demo consent, and gains the build progress alongside.
 */
export async function saveBuildProgress(
  tx: Database,
  input: {
    email: string;
    anonymousId: string | null;
    state: BuildSavedState;
    scene: BuildScene;
    now: Date;
  },
): Promise<{ id: string } | null> {
  const email = normalizeLeadEmail(input.email);
  const now = input.now.toISOString();
  const progress: BuildProgress = {
    state: input.state,
    scene: input.scene,
    savedAt: now,
    disclosureVersion: BUILD_SAVE_DISCLOSURE_VERSION,
  };
  const result = await tx.execute(sql`
    insert into growth_leads (
      email, email_hash, source, anonymous_id, disclosure_version,
      first_seen_at, last_seen_at, build_progress
    ) values (
      ${email}, ${leadEmailHash(email)}, 'build', ${input.anonymousId},
      ${BUILD_SAVE_DISCLOSURE_VERSION}, ${now}::timestamptz,
      ${now}::timestamptz, ${JSON.stringify(progress)}::jsonb
    )
    on conflict (email_hash) do update set
      last_seen_at = excluded.last_seen_at,
      anonymous_id = coalesce(excluded.anonymous_id, growth_leads.anonymous_id),
      build_progress = excluded.build_progress,
      updated_at = excluded.last_seen_at
    returning id
  `);
  return rowsFromExecute<{ id: string }>(result)[0] ?? null;
}

export async function readBuildProgress(
  tx: Database,
  leadId: string,
): Promise<BuildProgress | null> {
  const result = await tx.execute(sql`
    select build_progress as "buildProgress"
    from growth_leads
    where id = ${leadId}::uuid and deleted_at is null
    limit 1
  `);
  const row = rowsFromExecute<{ buildProgress: unknown }>(result)[0];
  return row ? parseBuildProgress(row.buildProgress) : null;
}

/** A sign-in-free link back into one person's saved build. */
export function createBuildResumeToken(
  leadId: string,
  options: FeedbackTokenOptions = {},
): string | null {
  return createFeedbackToken(
    RESUME_PURPOSE,
    { practiceId: leadId, ttlSeconds: BUILD_RESUME_TOKEN_TTL_SECONDS },
    options,
  );
}

export function verifyBuildResumeToken(
  token: string | null | undefined,
  options: FeedbackTokenOptions = {},
): { leadId: string } | null {
  const verified = verifyFeedbackToken(RESUME_PURPOSE, token, options);
  return verified ? { leadId: verified.practiceId } : null;
}
