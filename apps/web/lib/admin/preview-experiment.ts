import { sql } from "drizzle-orm";
import type { Database } from "@openpims/db/client";
import { rowsFromExecute } from "@/lib/db/execute-rows";
import { withSystem } from "@/lib/tenant-db";
import type { PreviewArm } from "@/lib/billing/preview";

export interface PreviewExperimentArm {
  arm: PreviewArm;
  registered: number;
  finishedSetup: number;
  addedCard: number;
  paying: number;
}

interface ArmRow {
  arm: string;
  registered: number | string;
  finishedSetup: number | string;
  addedCard: number | string;
  paying: number | string;
}

/**
 * Funnel for the preview-before-card experiment, by arm: how many assigned
 * clinics finished guided setup, added a card (the trial start), and paid.
 * Card and payment come from webhook-backed conversion milestones.
 */
export async function previewExperimentSummary(
  db: Database,
): Promise<PreviewExperimentArm[]> {
  const result = await withSystem(db, (tx) =>
    tx.execute(sql`
      select
        p.settings -> 'growthExperiments' -> 'previewBeforeCard' ->> 'arm' as arm,
        count(*)::int as "registered",
        count(*) filter (
          where nullif(p.settings ->> 'onboardingCompletedAt', '') is not null
        )::int as "finishedSetup",
        count(*) filter (
          where exists (
            select 1 from practice_conversion_milestones m
            where m.practice_id = p.id
              and m.milestone = 'payment_method_collected'
          )
        )::int as "addedCard",
        count(*) filter (
          where exists (
            select 1 from practice_conversion_milestones m
            where m.practice_id = p.id
              and m.milestone = 'first_positive_payment'
          )
        )::int as "paying"
      from practices p
      where p.deleted_at is null
        and p.settings ->> 'analyticsExcluded' is distinct from 'true'
        and p.settings -> 'growthExperiments' -> 'previewBeforeCard' ->> 'arm'
          in ('preview', 'control')
      group by 1
    `),
  );
  const rows = rowsFromExecute<ArmRow>(result);
  return (["preview", "control"] as const).map((arm) => {
    const row = rows.find((r) => r.arm === arm);
    return {
      arm,
      registered: Number(row?.registered ?? 0),
      finishedSetup: Number(row?.finishedSetup ?? 0),
      addedCard: Number(row?.addedCard ?? 0),
      paying: Number(row?.paying ?? 0),
    };
  });
}
