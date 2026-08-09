import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const { dashboardRouter } = await import("../routers/dashboard");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";

function callerWithDb(db: Record<string, unknown>) {
  const session = {
    user: {
      id: USER_ID,
      email: "frontdesk@example.com",
      name: "Front Desk",
      role: "front_desk",
      practiceId: PRACTICE_ID,
    },
  };
  return dashboardRouter.createCaller({ db, session } as never);
}

function createDashboardDb(selectResults: unknown[][]) {
  const results = [...selectResults];
  const select = vi.fn(() => {
    const result = results.shift() ?? [];
    const builder = {
      from: vi.fn(() => builder),
      leftJoin: vi.fn(() => builder),
      where: vi.fn(() => builder),
      groupBy: vi.fn(() => builder),
      orderBy: vi.fn(async () => result),
      limit: vi.fn(async () => result),
      then: (
        resolve: (value: unknown[]) => unknown,
        reject?: (error: unknown) => unknown
      ) => Promise.resolve(result).then(resolve, reject),
    };
    return builder;
  });

  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    execute: vi.fn(async () => undefined),
    select,
  };

  return { db, select };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("dashboard router", () => {
  it("summarizes stats against the practice-local day", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T02:30:00.000Z"));
    const { db, select } = createDashboardDb([
      [{ timezone: "America/Los_Angeles" }],
      [{ count: 7 }],
      [{ count: 5 }],
      [{ total: "1250.50" }],
      [{ count: 3 }],
    ]);

    await expect(callerWithDb(db).getStats()).resolves.toEqual({
      todayAppointments: 7,
      patientsSeen: 5,
      revenueMtd: 1250.5,
      pendingInvoices: 3,
    });

    expect(select).toHaveBeenCalledTimes(5);
  });

  it("builds dashboard charts with practice-local day buckets", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T02:30:00.000Z"));
    const { db, select } = createDashboardDb([
      [{ timezone: "America/Los_Angeles" }],
      [
        { day: "Tue", status: "scheduled", count: 2 },
        { day: "Tue", status: "checked_out", count: 1 },
      ],
      [{ day: "Jul 14", dayOrder: "2026-07-14", revenue: "450.25" }],
      [{ species: "canine", count: 4 }],
      [
        { doctorName: "Dr. Ada Chen", production: "925.50" },
        { doctorName: "Unassigned", production: "125.00" },
      ],
    ]);

    await expect(callerWithDb(db).getCharts()).resolves.toEqual({
      appointmentsByDay: [
        { date: "Wed", scheduled: 0, completed: 0, cancelled: 0 },
        { date: "Thu", scheduled: 0, completed: 0, cancelled: 0 },
        { date: "Fri", scheduled: 0, completed: 0, cancelled: 0 },
        { date: "Sat", scheduled: 0, completed: 0, cancelled: 0 },
        { date: "Sun", scheduled: 0, completed: 0, cancelled: 0 },
        { date: "Mon", scheduled: 0, completed: 0, cancelled: 0 },
        { date: "Tue", scheduled: 2, completed: 1, cancelled: 0 },
      ],
      revenueByDay: [{ date: "Jul 14", revenue: 450.25 }],
      speciesDistribution: [{ name: "Canine", value: 4 }],
      productionByDoctor: [
        { doctorName: "Dr. Ada Chen", production: 925.5 },
        { doctorName: "Unassigned", production: 125 },
      ],
    });

    expect(select).toHaveBeenCalledTimes(5);
  });

  it("rejects stats and charts when the practice is missing or deleted", async () => {
    const statsDb = createDashboardDb([[]]);

    await expect(callerWithDb(statsDb.db).getStats()).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    expect(statsDb.select).toHaveBeenCalledTimes(1);

    const chartsDb = createDashboardDb([[]]);

    await expect(callerWithDb(chartsDb.db).getCharts()).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    expect(chartsDb.select).toHaveBeenCalledTimes(1);
  });

  it("uses practice timezone ranges and local-day SQL grouping", () => {
    const source = readFileSync("server/routers/dashboard.ts", "utf8");

    expect(source).toContain("async function practiceTimeZone");
    expect(source).toContain("function activePracticePredicate");
    expect(source).toContain("function practiceNotFound");
    expect(source).toContain('message: "Practice not found"');
    expect(source).toContain("if (!practice)");
    expect(source).not.toContain("practice?.timezone");
    expect(source).toContain("dateInputUtcRangeForTimeZone(new Date(), timezone)");
    expect(source).toContain("lt(appointments.startTime, today.end)");
    expect(source).toContain("lt(invoices.createdAt, today.end)");
    expect(source).toContain("monthStartDateInput(today.date)");
    expect(source).toContain("timezone(${reportTimeZone}, ${appointments.startTime})");
    expect(source).toContain("timezone(${reportTimeZone}, ${invoices.createdAt})");
    expect(source).toContain("coalesce(${users.name}, 'Unassigned')");
    expect(source).toContain("eq(invoices.appointmentId, appointments.id)");
    expect(source).toContain("eq(appointments.practiceId, ctx.practiceId)");
    expect(source).toContain("eq(users.practiceId, ctx.practiceId)");
    expect(source).not.toMatch(
      /eq\(appointments\.doctorId, users\.id\)[\s\S]{0,180}?isNull\(users\.deletedAt\)/s
    );
    expect(
      source.match(/activePracticePredicate\(ctx\.practiceId\)/g)?.length ?? 0
    ).toBeGreaterThanOrEqual(10);
    expect(source).toMatch(
      /eq\(appointments\.practiceId, ctx\.practiceId\),\s+activePracticePredicate\(ctx\.practiceId\),\s+isNull\(appointments\.deletedAt\)/
    );
    expect(source).toMatch(
      /eq\(invoices\.practiceId, ctx\.practiceId\),\s+activePracticePredicate\(ctx\.practiceId\),\s+isNull\(invoices\.deletedAt\)/
    );
    expect(source).toMatch(
      /eq\(patients\.practiceId, ctx\.practiceId\),\s+activePracticePredicate\(ctx\.practiceId\),\s+isNull\(patients\.deletedAt\)/
    );
    expect(source).toMatch(
      /eq\(appointments\.doctorId, users\.id\),\s+eq\(users\.practiceId, ctx\.practiceId\),\s+activePracticePredicate\(ctx\.practiceId\)/
    );
    expect(source).not.toContain(
      "date_trunc('day', ${appointments.startTime})"
    );
    expect(source).not.toContain("date_trunc('day', ${invoices.createdAt})");
  });
});
