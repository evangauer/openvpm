import { and, eq, inArray, isNull } from "drizzle-orm";
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
