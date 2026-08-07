import { eq, sql } from "drizzle-orm";
import type { Database } from "@openpims/db/client";
import { funnelEvents, practices } from "@openpims/db";
import { withSystem } from "@/lib/tenant-db";

export const PRACTICE_FUNNEL_STAGES = [
  "registration",
  "activation",
  "card_added",
  "paid",
] as const;

export type PracticeFunnelStage = (typeof PRACTICE_FUNNEL_STAGES)[number];

type FunnelPracticeSettings = {
  acquisition?: {
    funnelId?: string;
    source?: string;
  };
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function insertFunnelEvent(
  db: Database,
  input: {
    id?: string;
    eventName: string;
    anonymousId?: string | null;
    practiceId?: string | null;
    source?: string | null;
    path?: string | null;
    origin?: string | null;
    metadata?: Record<string, unknown>;
    createdAt?: Date;
  }
): Promise<boolean> {
  const rows = await db
    .insert(funnelEvents)
    .values({
      ...(input.id ? { id: input.id } : {}),
      eventName: input.eventName,
      anonymousId: input.anonymousId ?? null,
      practiceId: input.practiceId ?? null,
      source: input.source ?? null,
      path: input.path ?? null,
      origin: input.origin ?? null,
      metadata: input.metadata ?? {},
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    })
    .onConflictDoNothing()
    .returning({ id: funnelEvents.id });
  return rows.length > 0;
}

export async function recordPracticeFunnelStage(
  db: Database,
  practiceId: string,
  eventName: PracticeFunnelStage,
  metadata?: Record<string, unknown>
): Promise<boolean> {
  const [practice] = await db
    .select({
      settings: practices.settings,
      createdAt: practices.createdAt,
    })
    .from(practices)
    .where(eq(practices.id, practiceId))
    .limit(1);
  if (!practice) return false;

  const settings = (practice.settings ?? {}) as FunnelPracticeSettings;
  const acquisition = settings.acquisition;
  const funnelId = acquisition?.funnelId?.trim();

  return insertFunnelEvent(db, {
    eventName,
    anonymousId: funnelId && UUID_RE.test(funnelId) ? funnelId : null,
    practiceId,
    source: acquisition?.source ?? null,
    metadata,
    createdAt: eventName === "registration" ? practice.createdAt : undefined,
  });
}

/**
 * Record activation once a practice has created both a non-sample client and
 * a non-sample appointment. The partial unique index makes retries harmless.
 */
export async function recordActivationIfReached(
  db: Database,
  practiceId: string
): Promise<boolean> {
  return withSystem(db, async (tx) => {
    const result = await tx.execute(sql`
      select p.id
      from practices p
      where p.id = ${practiceId}::uuid
        and p.deleted_at is null
        and exists (
          select 1
          from clients c
          where c.practice_id = p.id
            and c.deleted_at is null
            and not (
              coalesce(p.settings -> 'demoData' -> 'clientIds', '[]'::jsonb)
                @> to_jsonb(c.id::text)
            )
        )
        and exists (
          select 1
          from appointments a
          where a.practice_id = p.id
            and a.deleted_at is null
            and not (
              coalesce(p.settings -> 'demoData' -> 'appointmentIds', '[]'::jsonb)
                @> to_jsonb(a.id::text)
            )
        )
      limit 1
    `);
    const rows = Array.isArray(result)
      ? result
      : ((result as { rows?: unknown[] } | null)?.rows ?? []);
    if (rows.length === 0) return false;
    return recordPracticeFunnelStage(tx, practiceId, "activation");
  });
}

export async function recordRegistration(
  db: Database,
  practiceId: string
): Promise<boolean> {
  return withSystem(db, (tx) =>
    recordPracticeFunnelStage(tx, practiceId, "registration")
  );
}
