import { and, eq, isNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { auditLog, practices } from "@openpims/db";
import type { Database } from "@openpims/db/client";
import { readHostedAiAccess } from "@/lib/billing/ai-access";
import { billingEnforced } from "@/lib/billing/plans";
import { rateLimit } from "@/lib/rate-limit";
import {
  lockPracticeForExternalSideEffects,
  RECOVERY_HOLD_BLOCK_MESSAGE,
} from "@/lib/recovery-hold";
import {
  scribePracticeEnabled,
  scribeRolloutEnabled,
} from "@/lib/scribe/availability";

/**
 * Checks and audit shared by the Scribe router and the phone recording route,
 * so a recording from either device passes the same gates.
 */

export type ScribeContext = {
  db: Database;
  practiceId: string;
  user: { id: string };
};

export function activePracticeWhere(practiceId: string) {
  return and(eq(practices.id, practiceId), isNull(practices.deletedAt));
}

export function practiceNotFound(): TRPCError {
  return new TRPCError({ code: "NOT_FOUND", message: "Practice not found" });
}

/**
 * On OpenVPM Cloud, Scribe reaches clinics in stages: only the clinics listed
 * in SCRIBE_PRACTICE_IDS (comma-separated practice ids, or `*` for every
 * clinic) can see or use it. An empty list means no clinic. Self-hosted
 * installations do not enforce hosted billing and skip the list.
 */
export function scribeClinicAllowed(practiceId: string): boolean {
  if (!billingEnforced()) return true;
  const allowed = (process.env.SCRIBE_PRACTICE_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return allowed.includes("*") || allowed.includes(practiceId);
}

export function scribeNotAvailable(): TRPCError {
  return new TRPCError({
    code: "PRECONDITION_FAILED",
    message: "Scribe is not available.",
  });
}

/**
 * Everything that must hold before a transcript or recording leaves for the AI
 * provider, in the order the in-chart AI draft uses: the Scribe gates, the
 * per-person rate limit, the recovery hold, then hosted AI access re-read
 * under the practice lock.
 */
export async function assertMayCallProvider(
  ctx: ScribeContext,
  limit: { name: string; perMinute: number; message: string },
) {
  if (!scribeRolloutEnabled() || !scribeClinicAllowed(ctx.practiceId)) {
    throw scribeNotAvailable();
  }

  const [practice] = await ctx.db
    .select({ settings: practices.settings })
    .from(practices)
    .where(activePracticeWhere(ctx.practiceId))
    .limit(1);
  if (!practice) throw practiceNotFound();
  if (!scribePracticeEnabled(practice.settings)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Scribe is not turned on for this clinic.",
    });
  }

  const allowance = await rateLimit({
    key: `${limit.name}:${ctx.practiceId}:actor:${ctx.user.id}`,
    limit: limit.perMinute,
    windowMs: 60_000,
  });
  if (!allowance.success) {
    throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: limit.message });
  }

  if (!(await lockPracticeForExternalSideEffects(ctx.db, ctx.practiceId))) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: RECOVERY_HOLD_BLOCK_MESSAGE,
    });
  }

  const aiAccess = await readHostedAiAccess(ctx.db, ctx.practiceId);
  if (!aiAccess) throw practiceNotFound();
  if (!aiAccess.allowed) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: aiAccess.message ?? "OpenVPM AI is not available.",
    });
  }
}

/**
 * Who used Scribe and when, with sizes only: never the transcript, the audio,
 * or the note. Best effort, like the generic audit it replaces for these paths.
 */
export async function recordScribeAudit(
  ctx: ScribeContext,
  action: "drafted" | "recorded",
  changes: Record<string, number>,
  /** The visit, when Scribe ran inside one. */
  appointmentId?: string | null,
) {
  try {
    await ctx.db.insert(auditLog).values({
      practiceId: ctx.practiceId,
      userId: ctx.user.id,
      action,
      entityType: "scribe_note",
      entityId: appointmentId ?? null,
      changes,
    });
  } catch (error) {
    console.error(
      "[scribe] failed to record audit entry:",
      error instanceof Error ? error.name : "unknown",
    );
  }
}
