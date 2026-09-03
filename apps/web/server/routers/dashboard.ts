import { eq, and, isNull, gte, lt, sql, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure } from "../trpc";
import {
  appointments,
  invoices,
  patients,
  practices,
  users,
} from "@openpims/db";
import type { Database } from "@openpims/db/client";
import {
  dateInputDayUtcRange,
  dateInputUtcRangeForTimeZone,
} from "@/lib/date-input";
import { PATIENT_SPECIES_LABELS } from "@/lib/patients/species";

type DashboardContext = {
  db: Database;
  practiceId: string;
};

function activePracticePredicate(practiceId: string) {
  return sql`exists (
    select 1
    from ${practices}
    where ${practices.id} = ${practiceId}
      and ${practices.deletedAt} is null
  )`;
}

function practiceNotFound(): TRPCError {
  return new TRPCError({ code: "NOT_FOUND", message: "Practice not found" });
}

async function practiceTimeZone(ctx: DashboardContext): Promise<string | null> {
  const [practice] = await ctx.db
    .select({ timezone: practices.timezone })
    .from(practices)
    .where(and(eq(practices.id, ctx.practiceId), isNull(practices.deletedAt)))
    .limit(1);

  if (!practice) {
    throw practiceNotFound();
  }

  return practice.timezone ?? null;
}

function addDateInputDays(dateInput: string, days: number): string {
  const [year, month, day] = dateInput.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(
    2,
    "0"
  )}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function monthStartDateInput(dateInput: string): string {
  return `${dateInput.slice(0, 8)}01`;
}

function dateInputWeekdayLabel(dateInput: string): string {
  return new Date(`${dateInput}T00:00:00.000Z`).toLocaleDateString("en-US", {
    weekday: "short",
    timeZone: "UTC",
  });
}

function sqlStringLiteral(value: string) {
  return sql.raw(`'${value.replace(/'/g, "''")}'`);
}

export const dashboardRouter = createRouter({
  getStats: protectedProcedure.query(async ({ ctx }) => {
    const timezone = await practiceTimeZone(ctx);
    const today = dateInputUtcRangeForTimeZone(new Date(), timezone);
    const monthStart = dateInputDayUtcRange(
      monthStartDateInput(today.date),
      timezone
    ).start;

    const [
      todayAppointmentsResult,
      patientsSeenResult,
      revenueMtdResult,
      pendingInvoicesResult,
    ] = await Promise.all([
      // Today's appointments count
      ctx.db
        .select({ count: sql<number>`count(*)` })
        .from(appointments)
        .where(
          and(
            eq(appointments.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(appointments.deletedAt),
            gte(appointments.startTime, today.start),
            lt(appointments.startTime, today.end)
          )
        ),

      // Patients seen today (checked_out)
      ctx.db
        .select({ count: sql<number>`count(*)` })
        .from(appointments)
        .where(
          and(
            eq(appointments.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(appointments.deletedAt),
            gte(appointments.startTime, today.start),
            lt(appointments.startTime, today.end),
            eq(appointments.status, "checked_out")
          )
        ),

      // Revenue MTD (paid invoices this month)
      ctx.db
        .select({
          total: sql<string>`coalesce(sum(${invoices.total}::numeric), 0)`,
        })
        .from(invoices)
        .where(
          and(
            eq(invoices.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(invoices.deletedAt),
            eq(invoices.status, "paid"),
            gte(invoices.createdAt, monthStart),
            lt(invoices.createdAt, today.end)
          )
        ),

      // Pending invoices (sent or overdue)
      ctx.db
        .select({ count: sql<number>`count(*)` })
        .from(invoices)
        .where(
          and(
            eq(invoices.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(invoices.deletedAt),
            inArray(invoices.status, ["sent", "overdue"])
          )
        ),
    ]);

    return {
      todayAppointments: Number(todayAppointmentsResult[0]?.count ?? 0),
      patientsSeen: Number(patientsSeenResult[0]?.count ?? 0),
      revenueMtd: parseFloat(String(revenueMtdResult[0]?.total ?? "0")),
      pendingInvoices: Number(pendingInvoicesResult[0]?.count ?? 0),
    };
  }),

  getCharts: protectedProcedure.query(async ({ ctx }) => {
    const timezone = await practiceTimeZone(ctx);
    const today = dateInputUtcRangeForTimeZone(new Date(), timezone);
    const monthStart = dateInputDayUtcRange(
      monthStartDateInput(today.date),
      timezone
    ).start;
    const reportTimeZone = sqlStringLiteral(timezone ?? "UTC");

    // --- Appointments by day (last 7 days) ---
    const sevenDaysAgoDate = addDateInputDays(today.date, -6);
    const sevenDaysAgo = dateInputDayUtcRange(
      sevenDaysAgoDate,
      timezone
    ).start;
    const appointmentDay = sql`
      date_trunc('day', timezone(${reportTimeZone}, ${appointments.startTime}))
    `;

    const appointmentsByDayRows = await ctx.db
      .select({
        day: sql<string>`to_char(${appointmentDay}, 'Dy')`,
        status: appointments.status,
        count: sql<number>`count(*)::int`,
      })
      .from(appointments)
      .where(
        and(
          eq(appointments.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(appointments.deletedAt),
          gte(appointments.startTime, sevenDaysAgo),
          lt(appointments.startTime, today.end)
        )
      )
      .groupBy(
        appointmentDay,
        appointments.status
      )
      .orderBy(sql`min(${appointments.startTime})`);

    // Pivot rows into per-day objects
    const dayMap = new Map<
      string,
      {
        date: string;
        scheduled: number;
        completed: number;
        cancelled: number;
      }
    >();
    for (let i = 0; i < 7; i++) {
      const dateInput = addDateInputDays(sevenDaysAgoDate, i);
      const label = dateInputWeekdayLabel(dateInput);
      dayMap.set(label, {
        date: label,
        scheduled: 0,
        completed: 0,
        cancelled: 0,
      });
    }
    for (const row of appointmentsByDayRows) {
      const entry = dayMap.get(row.day);
      if (!entry) continue;
      if (row.status === "scheduled" || row.status === "confirmed") {
        entry.scheduled += Number(row.count);
      } else if (row.status === "checked_out") {
        entry.completed += Number(row.count);
      } else if (row.status === "cancelled" || row.status === "no_show") {
        entry.cancelled += Number(row.count);
      }
    }
    const appointmentsByDay = Array.from(dayMap.values());

    // --- Revenue by day (last 30 days) ---
    const thirtyDaysAgoDate = addDateInputDays(today.date, -29);
    const thirtyDaysAgo = dateInputDayUtcRange(
      thirtyDaysAgoDate,
      timezone
    ).start;
    const revenueDay = sql`
      date_trunc('day', timezone(${reportTimeZone}, ${invoices.createdAt}))
    `;

    const revenueByDayRows = await ctx.db
      .select({
        day: sql<string>`to_char(${revenueDay}, 'Mon DD')`,
        dayOrder: sql<string>`to_char(${revenueDay}, 'YYYY-MM-DD')`,
        revenue: sql<string>`coalesce(sum(${invoices.total}::numeric), 0)`,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(invoices.deletedAt),
          eq(invoices.status, "paid"),
          gte(invoices.createdAt, thirtyDaysAgo),
          lt(invoices.createdAt, today.end)
        )
      )
      .groupBy(revenueDay)
      .orderBy(sql`min(${invoices.createdAt})`);

    const revenueByDay = revenueByDayRows.map((r) => ({
      date: r.day,
      revenue: parseFloat(String(r.revenue)),
    }));

    // --- Species distribution (active patients) ---
    const speciesRows = await ctx.db
      .select({
        species: patients.species,
        count: sql<number>`count(*)::int`,
      })
      .from(patients)
      .where(
        and(
          eq(patients.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(patients.deletedAt),
          eq(patients.status, "active")
        )
      )
      .groupBy(patients.species)
      .orderBy(sql`count(*) desc`);

    const speciesLabels: Record<string, string> = PATIENT_SPECIES_LABELS;

    const speciesDistribution = speciesRows.map((r) => ({
      name: speciesLabels[r.species] ?? r.species,
      value: Number(r.count),
    }));

    // --- Production by doctor (month to date paid invoices) ---
    const doctorProductionName = sql<string>`coalesce(${users.name}, 'Unassigned')`;
    const productionByDoctorRows = await ctx.db
      .select({
        doctorName: doctorProductionName,
        production: sql<string>`coalesce(sum(${invoices.total}::numeric), 0)`,
      })
      .from(invoices)
      .leftJoin(
        appointments,
        and(
          eq(invoices.appointmentId, appointments.id),
          eq(appointments.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(appointments.deletedAt)
        )
      )
      .leftJoin(
        users,
        and(
          eq(appointments.doctorId, users.id),
          eq(users.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId)
        )
      )
      .where(
        and(
          eq(invoices.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(invoices.deletedAt),
          eq(invoices.status, "paid"),
          gte(invoices.createdAt, monthStart),
          lt(invoices.createdAt, today.end)
        )
      )
      .groupBy(doctorProductionName)
      .orderBy(sql`coalesce(sum(${invoices.total}::numeric), 0) desc`);

    const productionByDoctor = productionByDoctorRows.slice(0, 8).map((r) => ({
      doctorName: r.doctorName,
      production: parseFloat(String(r.production)),
    }));

    return {
      appointmentsByDay,
      revenueByDay,
      speciesDistribution,
      productionByDoctor,
    };
  }),
});
