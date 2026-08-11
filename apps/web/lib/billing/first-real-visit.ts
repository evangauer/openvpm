import { sql } from "drizzle-orm";
import type { Database } from "@openpims/db/client";

type FirstRealVisitRow = { firstVisitAt: Date | string | null };

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

/**
 * Earliest durable, non-demo clinic visit completed after the practice was
 * created. This is stronger product evidence than an appointment alone: the
 * closeout contract requires clinical handoff and an attributable billing
 * disposition (paid, accounts receivable, or documented no charge).
 */
export async function firstRealVisitAt(
  tx: Database,
  practiceId: string,
): Promise<Date | null> {
  const result = await tx.execute(sql`
    select min(vc.completed_at) as "firstVisitAt"
    from practices p
    join appointments a
      on a.practice_id = p.id
     and a.deleted_at is null
     and a.status = 'checked_out'
     and a.created_at >= p.created_at
    join visit_closeouts vc
      on vc.practice_id = p.id
     and vc.appointment_id = a.id
     and vc.deleted_at is null
     and vc.status = 'completed'
     and vc.completed_at is not null
     and vc.completed_at >= p.created_at
    where p.id = ${practiceId}::uuid
      and p.deleted_at is null
      and not (
        coalesce(p.settings -> 'demoData' -> 'appointmentIds', '[]'::jsonb)
          @> to_jsonb(a.id::text)
      )
  `);
  const value = rowsFromExecute<FirstRealVisitRow>(result)[0]?.firstVisitAt;
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function hasFirstRealVisit(
  tx: Database,
  practiceId: string,
): Promise<boolean> {
  return (await firstRealVisitAt(tx, practiceId)) !== null;
}
