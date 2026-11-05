import { sql } from "drizzle-orm";
import type { Database } from "@openpims/db/client";
import { rowsFromExecute } from "@/lib/db/execute-rows";
import {
  netPromoterScore,
  npsCategory,
  type NpsCategory,
} from "@/lib/growth/customer-lifecycle";
import { withSystem } from "@/lib/tenant-db";

export const NPS_SUMMARY_WINDOW_DAYS = 180;
export const NPS_RECENT_LIMIT = 25;

export interface NpsResponse {
  practiceId: string;
  practiceName: string;
  score: number;
  category: NpsCategory;
  comment: string | null;
  answeredAt: Date;
}

export interface NpsSummary {
  score: number | null;
  responses: number;
  promoters: number;
  passives: number;
  detractors: number;
  recent: NpsResponse[];
}

interface ResponseRow {
  practiceId: string;
  practiceName: string;
  score: number | string;
  comment: string | null;
  answeredAt: Date | string;
}

/** Each clinic's latest answer in the window, plus the most recent answers. */
export async function npsSummary(db: Database): Promise<NpsSummary> {
  const result = await withSystem(db, (tx) =>
    tx.execute(sql`
      select distinct on (r.practice_id)
        r.practice_id as "practiceId",
        p.name as "practiceName",
        r.score,
        r.comment,
        r.updated_at as "answeredAt"
      from practice_nps_responses r
      join practices p on p.id = r.practice_id
      where r.updated_at > now() - (${NPS_SUMMARY_WINDOW_DAYS} * interval '1 day')
        and p.deleted_at is null
        and p.settings ->> 'analyticsExcluded' is distinct from 'true'
      order by r.practice_id, r.updated_at desc
    `),
  );
  const latest = rowsFromExecute<ResponseRow>(result).map((row) => {
    const score = Number(row.score);
    return {
      practiceId: row.practiceId,
      practiceName: row.practiceName,
      score,
      category: npsCategory(score),
      comment: row.comment,
      answeredAt:
        row.answeredAt instanceof Date ? row.answeredAt : new Date(row.answeredAt),
    };
  });
  const scores = latest.map((r) => r.score);
  return {
    score: netPromoterScore(scores),
    responses: latest.length,
    promoters: latest.filter((r) => r.category === "promoter").length,
    passives: latest.filter((r) => r.category === "passive").length,
    detractors: latest.filter((r) => r.category === "detractor").length,
    recent: [...latest]
      .sort((a, b) => b.answeredAt.getTime() - a.answeredAt.getTime())
      .slice(0, NPS_RECENT_LIMIT),
  };
}
