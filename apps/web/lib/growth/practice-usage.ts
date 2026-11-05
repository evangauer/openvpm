import { sql } from "drizzle-orm";
import type { Database } from "@openpims/db/client";
import { rowsFromExecute } from "@/lib/db/execute-rows";

/** What a clinic has really done in OpenVPM, never counting sample data. */
export interface PracticeUsage {
  clients: number;
  patients: number;
  appointments: number;
  invoices: number;
  staffCount: number;
  portalSessions: number;
  remindersEnabled: boolean;
}

interface UsageRow {
  practiceId: string;
  clients: number | string;
  patients: number | string;
  appointments: number | string;
  invoices: number | string;
  staffCount: number | string;
  portalSessions: number | string;
  remindersEnabled: boolean;
}

export const EMPTY_PRACTICE_USAGE: PracticeUsage = {
  clients: 0,
  patients: 0,
  appointments: 0,
  invoices: 0,
  staffCount: 0,
  portalSessions: 0,
  remindersEnabled: false,
};

/** Rows whose id is in the practice's recorded sample-data ids are excluded. */
function notSample(kind: string, idColumn: ReturnType<typeof sql.raw>) {
  return sql`not (
    coalesce(p.settings -> 'demoData' -> ${kind}, '[]'::jsonb)
      @> to_jsonb(${idColumn}::text)
  )`;
}

/**
 * Usage counts for a batch of practices in one query. Call inside a system
 * transaction (crons) since it reads across tenants.
 */
export async function practiceUsageByIds(
  tx: Database,
  practiceIds: readonly string[],
): Promise<Map<string, PracticeUsage>> {
  const usage = new Map<string, PracticeUsage>();
  if (practiceIds.length === 0) return usage;

  const ids = sql.join(
    practiceIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const result = await tx.execute(sql`
    select
      p.id as "practiceId",
      (select count(*) from clients c
        where c.practice_id = p.id and c.deleted_at is null
          and ${notSample("clientIds", sql.raw("c.id"))})::int as "clients",
      (select count(*) from patients pt
        where pt.practice_id = p.id and pt.deleted_at is null
          and ${notSample("patientIds", sql.raw("pt.id"))})::int as "patients",
      (select count(*) from appointments a
        where a.practice_id = p.id and a.deleted_at is null
          and ${notSample("appointmentIds", sql.raw("a.id"))})::int as "appointments",
      (select count(*) from invoices i
        where i.practice_id = p.id and i.deleted_at is null
          and ${notSample("invoiceIds", sql.raw("i.id"))})::int as "invoices",
      (select count(*) from users u
        where u.practice_id = p.id and u.deleted_at is null)::int as "staffCount",
      (select count(*) from portal_sessions ps
        where ps.practice_id = p.id)::int as "portalSessions",
      p.appointment_reminders_enabled as "remindersEnabled"
    from practices p
    where p.id in (${ids})
  `);
  for (const row of rowsFromExecute<UsageRow>(result)) {
    usage.set(row.practiceId, {
      clients: Number(row.clients) || 0,
      patients: Number(row.patients) || 0,
      appointments: Number(row.appointments) || 0,
      invoices: Number(row.invoices) || 0,
      staffCount: Number(row.staffCount) || 0,
      portalSessions: Number(row.portalSessions) || 0,
      remindersEnabled: row.remindersEnabled === true,
    });
  }
  return usage;
}
