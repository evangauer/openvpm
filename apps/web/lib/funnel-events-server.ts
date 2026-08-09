import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "@openpims/db/client";
import { funnelEvents, practices } from "@openpims/db";
import { withSystem } from "@/lib/tenant-db";
import { upsertPracticeConversionMilestone } from "@/lib/conversion-milestones";

export {
  projectActivationMilestone,
  recordActivationAfterAppointmentCreated,
  recordActivationAfterClientCreated,
} from "@/lib/conversion-milestones";

type FunnelPracticeSettings = {
  acquisition?: {
    funnelId?: string;
    source?: string;
  };
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FIRST_TOUCH_EVENT_NAMES = [
  "visit",
  "demo_land",
  "demo_gate_viewed",
  "demo_gate_submitted",
  "signup_land",
];

export interface RegistrationAttributionReconciliationResult {
  validFunnelIdMissingTouchRepaired: number;
  missingFunnelIdHistoricalUnknown: number;
}

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

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

/**
 * Browser telemetry is best-effort and can be blocked. Registration itself
 * proves the visitor reached /register, so add a minimal server-owned touch
 * only when that anonymous UUID has no earlier first-party touch. The UUID,
 * coarse route, and acquisition source are the complete payload—never contact
 * or clinic data.
 */
export async function ensureRegistrationFirstTouch(
  db: Database,
  input: {
    anonymousId: string;
    source?: string | null;
    createdAt: Date;
  }
): Promise<boolean> {
  const [existing] = await db
    .select({ id: funnelEvents.id })
    .from(funnelEvents)
    .where(
      and(
        eq(funnelEvents.anonymousId, input.anonymousId),
        inArray(funnelEvents.eventName, FIRST_TOUCH_EVENT_NAMES),
        isNull(funnelEvents.deletedAt)
      )
    )
    .limit(1);
  if (existing) return false;

  return insertFunnelEvent(db, {
    eventName: "signup_land",
    anonymousId: input.anonymousId,
    source: input.source ?? null,
    path: "/register",
    metadata: { serverFallback: true },
    createdAt: input.createdAt,
  });
}

/**
 * Repair only attribution that is already proven by a captured funnel UUID.
 * Registrations without that UUID stay explicitly historical/unknown; no
 * email, IP, timestamp proximity, or other probabilistic identity is invented.
 */
export async function reconcileRegistrationFirstTouches(
  db: Database
): Promise<RegistrationAttributionReconciliationResult> {
  return withSystem(db, async (tx) => {
    // Acquire this before the repair statement so a waiting transaction gets a
    // fresh READ COMMITTED snapshot after the prior repair commits.
    await tx.execute(sql`
      select pg_advisory_xact_lock(
        hashtext('openvpm:registration-first-touch-repair')
      )
    `);
    const result = await tx.execute(sql`
      with repairable as (
        select distinct on (
          lower(p.settings -> 'acquisition' ->> 'funnelId')
        )
          lower(p.settings -> 'acquisition' ->> 'funnelId') as anonymous_id,
          nullif(btrim(p.settings -> 'acquisition' ->> 'source'), '') as source,
          p.created_at
        from practices p
        where p.deleted_at is null
          and p.settings ->> 'analyticsExcluded' is distinct from 'true'
          and coalesce(p.settings -> 'acquisition' ->> 'funnelId', '')
            ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          and not exists (
            select 1
            from funnel_events touch
            where touch.anonymous_id = lower(
              p.settings -> 'acquisition' ->> 'funnelId'
            )
              and touch.deleted_at is null
              and touch.event_name in (
                'visit', 'demo_land', 'demo_gate_viewed',
                'demo_gate_submitted', 'signup_land'
              )
          )
        order by
          lower(p.settings -> 'acquisition' ->> 'funnelId'),
          p.created_at,
          p.id
      ), inserted as (
        insert into funnel_events (
          event_name,
          anonymous_id,
          source,
          path,
          metadata,
          created_at
        )
        select
          'signup_land',
          repairable.anonymous_id,
          repairable.source,
          '/register',
          jsonb_build_object('serverFallback', true, 'repaired', true),
          repairable.created_at
        from repairable
        returning id
      )
      select
        (select count(*)::int from inserted)
          as "validFunnelIdMissingTouchRepaired",
        (
          select count(*)::int
          from practices historical
          where historical.deleted_at is null
            and historical.settings ->> 'analyticsExcluded' is distinct from 'true'
            and not (
              coalesce(
                historical.settings -> 'acquisition' ->> 'funnelId',
                ''
              ) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            )
        ) as "missingFunnelIdHistoricalUnknown"
    `);
    const row = rowsFromExecute<{
      validFunnelIdMissingTouchRepaired: number | string;
      missingFunnelIdHistoricalUnknown: number | string;
    }>(result)[0];
    return {
      validFunnelIdMissingTouchRepaired:
        Number(row?.validFunnelIdMissingTouchRepaired) || 0,
      missingFunnelIdHistoricalUnknown:
        Number(row?.missingFunnelIdHistoricalUnknown) || 0,
    };
  });
}

export async function recordRegistration(
  db: Database,
  practiceId: string
): Promise<boolean> {
  return withSystem(db, async (tx) => {
    const [practice] = await tx
      .select({
        id: practices.id,
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
    const anonymousId =
      funnelId && UUID_RE.test(funnelId) ? funnelId.toLowerCase() : null;
    if (anonymousId) {
      await ensureRegistrationFirstTouch(tx, {
        anonymousId,
        source: acquisition?.source ?? null,
        createdAt: practice.createdAt,
      });
    }

    return upsertPracticeConversionMilestone(tx, {
      practiceId: practice.id,
      milestone: "registered",
      occurredAt: practice.createdAt,
      evidenceSource: "practice_created",
      evidenceKey: `practice:${practice.id}`,
    });
  });
}
