import { sql } from "drizzle-orm";
import type { Database } from "@openpims/db/client";
import { rowsFromExecute } from "@/lib/db/execute-rows";
import { BUILD_SCENES, type BuildScene } from "@/lib/build/catalog";
import { withSystem } from "@/lib/tenant-db";

export const BUILD_FUNNEL_WINDOW_DAYS = 30;

export interface BuildFunnelScene {
  scene: BuildScene;
  /** Distinct visitors who reached this scene. */
  reached: number;
  /** Median seconds spent before continuing, or null with no completions. */
  medianSeconds: number | null;
}

export interface BuildFunnel {
  scenes: BuildFunnelScene[];
  /** Visitors who submitted the card gate (account created, sent to Stripe). */
  submitted: number;
  /** Builder signups whose card Stripe confirmed. */
  addedCard: number;
}

interface SceneRow {
  scene: string;
  reached: number | string;
  medianMs: number | string | null;
}

/**
 * Where visitors leave "Build your clinic", from anonymous funnel events in
 * the last 30 days. Each visitor counts once per scene however often they
 * revisit it.
 */
export async function buildFunnelSummary(db: Database): Promise<BuildFunnel> {
  return withSystem(db, async (tx) => {
    const sceneRows = rowsFromExecute<SceneRow>(
      await tx.execute(sql`
        with viewed as (
          select fe.metadata ->> 'scene' as scene,
            count(distinct fe.anonymous_id)::int as reached
          from funnel_events fe
          where fe.event_name = 'build_scene_viewed'
            and fe.deleted_at is null
            and fe.created_at > now() - (${BUILD_FUNNEL_WINDOW_DAYS} * interval '1 day')
          group by 1
        ), timed as (
          select fe.metadata ->> 'scene' as scene,
            percentile_cont(0.5) within group (
              order by (fe.metadata ->> 'ms')::numeric
            ) as median_ms
          from funnel_events fe
          where fe.event_name = 'build_scene_completed'
            and fe.deleted_at is null
            and fe.metadata ->> 'ms' ~ '^[0-9]+$'
            and fe.created_at > now() - (${BUILD_FUNNEL_WINDOW_DAYS} * interval '1 day')
          group by 1
        )
        select viewed.scene, viewed.reached, timed.median_ms as "medianMs"
        from viewed left join timed using (scene)
      `),
    );
    const [totals] = rowsFromExecute<{
      submitted: number | string;
      addedCard: number | string;
    }>(
      await tx.execute(sql`
        select
          (select count(distinct fe.anonymous_id)::int
             from funnel_events fe
             where fe.event_name = 'build_gate_submitted'
               and fe.deleted_at is null
               and fe.created_at > now() - (${BUILD_FUNNEL_WINDOW_DAYS} * interval '1 day')
          ) as submitted,
          (select count(*)::int
             from practices p
             where p.deleted_at is null
               and p.settings -> 'buildFlow' is not null
               and p.settings ->> 'analyticsExcluded' is distinct from 'true'
               and p.created_at > now() - (${BUILD_FUNNEL_WINDOW_DAYS} * interval '1 day')
               and exists (
                 select 1 from practice_conversion_milestones m
                 where m.practice_id = p.id
                   and m.milestone = 'payment_method_collected'
               )
          ) as "addedCard"
      `),
    );
    const byScene = new Map(sceneRows.map((row) => [row.scene, row]));
    return {
      scenes: BUILD_SCENES.map((scene) => {
        const row = byScene.get(scene);
        const median = row?.medianMs == null ? null : Number(row.medianMs);
        return {
          scene,
          reached: Number(row?.reached ?? 0),
          medianSeconds:
            median == null || !Number.isFinite(median)
              ? null
              : Math.round(median / 1000),
        };
      }),
      submitted: Number(totals?.submitted ?? 0),
      addedCard: Number(totals?.addedCard ?? 0),
    };
  });
}
