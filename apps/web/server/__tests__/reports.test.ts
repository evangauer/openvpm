import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recordAuditLog: vi.fn(async () => undefined),
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: mocks.recordAuditLog,
}));

const { reportsRouter } = await import("../routers/reports");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";

function callerWithDb(db: Record<string, unknown>, role = "admin") {
  const session = {
    user: {
      id: USER_ID,
      email: `${role}@example.com`,
      name: "Reports User",
      role,
      practiceId: PRACTICE_ID,
    },
  };
  return reportsRouter.createCaller({ db, session } as never);
}

function createReportDb(selectResults: unknown[][]) {
  const results = [...selectResults];
  const select = vi.fn(() => {
    const result = results.shift() ?? [];
    const builder = {
      from: vi.fn(() => builder),
      innerJoin: vi.fn(() => builder),
      leftJoin: vi.fn(() => builder),
      where: vi.fn(() => builder),
      groupBy: vi.fn(() => builder),
      orderBy: vi.fn(() => builder),
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

describe("reports", () => {
  it("restricts report data to reporting roles", async () => {
    const { db, select } = createReportDb([]);

    await expect(callerWithDb(db, "front_desk").settings()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(select).not.toHaveBeenCalled();

    const { db: vetDb } = createReportDb([[{ timezone: "America/New_York" }]]);

    await expect(callerWithDb(vetDb, "veterinarian").settings()).resolves.toEqual({
      timezone: "America/New_York",
    });
  });

  it("exposes the practice timezone for report controls", async () => {
    const { db } = createReportDb([[{ timezone: "America/Los_Angeles" }]]);

    await expect(callerWithDb(db).settings()).resolves.toEqual({
      timezone: "America/Los_Angeles",
    });
  });

  it("rejects report settings when the practice is missing or deleted", async () => {
    const { db } = createReportDb([[]]);

    await expect(callerWithDb(db).settings()).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });
  });

  it("rejects invalid report date ranges before querying", async () => {
    const { db, select } = createReportDb([]);

    await expect(
      callerWithDb(db).revenue({
        startDate: "2026-06-10",
        endDate: "2026-06-01",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
  });

  it("rejects report data requests when the practice is missing or deleted", async () => {
    const { db } = createReportDb([[]]);

    await expect(
      callerWithDb(db).revenue({
        startDate: "2026-06-01",
        endDate: "2026-06-07",
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });
  });

  it("returns selected and previous period revenue for a custom range", async () => {
    const { db } = createReportDb([
      [{ timezone: "America/Los_Angeles" }],
      [{ total: "125.50" }],
      [{ total: "75.25" }],
      [{ date: "2026-06-01", amount: "50.00" }],
    ]);

    const summary = await callerWithDb(db).revenue({
      startDate: "2026-06-01",
      endDate: "2026-06-07",
    });

    expect(summary).toMatchObject({
      range: {
        startDate: "2026-06-01",
        endDate: "2026-06-07",
        previousStartDate: "2026-05-25",
        previousEndDate: "2026-05-31",
      },
      total: 125.5,
      previousTotal: 75.25,
    });
    // The daily series is zero-filled to one point per day in the range.
    expect(summary.daily).toHaveLength(7);
    expect(summary.daily[0]).toEqual({ date: "2026-06-01", amount: 50 });
    expect(summary.daily.slice(1).every((d) => d.amount === 0)).toBe(true);
  });

  it("defaults report ranges to the practice-local day", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T02:30:00.000Z"));
    const { db } = createReportDb([
      [{ timezone: "America/Los_Angeles" }],
      [{ total: "125.50" }],
      [{ total: "75.25" }],
      [{ date: "2026-07-14", amount: "50.00" }],
    ]);

    const summary = await callerWithDb(db).revenue();

    expect(summary).toMatchObject({
      range: {
        startDate: "2026-06-15",
        endDate: "2026-07-14",
        previousStartDate: "2026-05-16",
        previousEndDate: "2026-06-14",
      },
      total: 125.5,
      previousTotal: 75.25,
    });
    // Zero-filled: 30 days ending on the practice-local "today".
    expect(summary.daily).toHaveLength(30);
    expect(summary.daily[summary.daily.length - 1]).toEqual({
      date: "2026-07-14",
      amount: 50,
    });
    expect(summary.range.start.toISOString()).toBe(
      "2026-06-15T07:00:00.000Z"
    );
    expect(summary.range.endExclusive.toISOString()).toBe(
      "2026-07-15T07:00:00.000Z"
    );
  });

  it("returns appointment KPIs for the selected date range", async () => {
    const { db } = createReportDb([
      [{ timezone: "America/Los_Angeles" }],
      [{ count: 10 }],
      [{ count: 7 }],
      [{ count: 1 }],
      [{ count: 2 }],
      [{ doctorName: "Dr. Ames", total: 6, completed: 5 }],
    ]);

    await expect(
      callerWithDb(db).appointments({
        startDate: "2026-06-01",
        endDate: "2026-06-30",
      })
    ).resolves.toMatchObject({
      range: { startDate: "2026-06-01", endDate: "2026-06-30" },
      total: 10,
      completed: 7,
      noShows: 1,
      cancelled: 2,
      fillRate: 70,
      byDoctor: [{ doctorName: "Dr. Ames", total: 6, completed: 5 }],
    });
  });

  it("returns top service rows scoped to the selected date range", async () => {
    const { db } = createReportDb([
      [{ timezone: "America/Los_Angeles" }],
      [{ name: "Wellness Exam", count: 12, revenue: "840.00" }],
    ]);

    await expect(
      callerWithDb(db).topServices({
        startDate: "2026-06-01",
        endDate: "2026-06-30",
      })
    ).resolves.toMatchObject({
      range: { startDate: "2026-06-01", endDate: "2026-06-30" },
      items: [{ name: "Wellness Exam", count: 12, revenue: 840 }],
    });
  });

  it("returns inventory expiration alerts as expired and expiring-soon buckets", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T02:30:00.000Z"));
    const { db } = createReportDb([
      [{ timezone: "America/Los_Angeles" }],
      [{ name: "Carprofen", sku: "RX-1", stockQuantity: 2, reorderPoint: 10 }],
      [
        {
          name: "Expired Vaccine",
          sku: "VAC-OLD",
          stockQuantity: 4,
          expirationDate: "2026-06-01",
        },
      ],
      [
        {
          name: "Soon Vaccine",
          sku: "VAC-SOON",
          stockQuantity: 8,
          expirationDate: "2026-07-01",
        },
      ],
    ]);

    await expect(callerWithDb(db).inventoryAlerts()).resolves.toMatchObject({
      lowStock: [{ name: "Carprofen", sku: "RX-1" }],
      expired: [{ name: "Expired Vaccine", sku: "VAC-OLD" }],
      expiringSoon: [{ name: "Soon Vaccine", sku: "VAC-SOON" }],
    });
  });

  it("keeps joined report rows scoped to tenant-owned active records", () => {
    const source = readFileSync("server/routers/reports.ts", "utf8");

    expect(source).toContain("function activePracticePredicate");
    expect(source).toContain("from ${practices}");
    expect(source).toContain("${practices.deletedAt} is null");
    expect(source).toContain('message: "Practice not found"');
    expect(
      source.match(/activePracticePredicate\(ctx\.practiceId\)/g)?.length ?? 0
    ).toBeGreaterThanOrEqual(6);
    expect(source).toContain("eq(users.practiceId, ctx.practiceId)");
    expect(source).not.toMatch(
      /eq\(appointments\.doctorId, users\.id\)[\s\S]{0,180}?isNull\(users\.deletedAt\)/s
    );
    expect(source).toContain("isNull(invoiceItems.deletedAt)");
    expect(source).toContain("name: invoiceItems.description");
    expect(source).toContain(".groupBy(invoiceItems.description)");
    expect(source).not.toContain(
      "coalesce(${services.name}, ${invoiceItems.description})"
    );
    expect(source).toMatch(
      /\.from\(invoiceItems\)[\s\S]*?eq\(invoiceItems\.invoiceId, invoices\.id\)[\s\S]*?eq\(invoices\.practiceId, ctx\.practiceId\)[\s\S]*?isNull\(invoices\.deletedAt\)/
    );
    expect(source).toMatch(
      /eq\(appointments\.practiceId, ctx\.practiceId\),\s+activePracticePredicate\(ctx\.practiceId\),\s+isNull\(appointments\.deletedAt\)/
    );
    expect(source).toMatch(
      /eq\(products\.practiceId, ctx\.practiceId\),\s+activePracticePredicate\(ctx\.practiceId\),\s+isNull\(products\.deletedAt\)/
    );
  });

  it("uses the practice timezone for report date bounds and daily grouping", () => {
    const source = readFileSync("server/routers/reports.ts", "utf8");

    expect(source).toContain("async function practiceTimeZone");
    expect(source).toContain("await getReportDateRange(ctx, input)");
    expect(source).toContain("lt(invoices.createdAt, range.endExclusive)");
    expect(source).toContain(
      "lt(invoices.createdAt, range.previousEndExclusive)"
    );
    expect(source).toContain("lt(appointments.startTime, range.endExclusive)");
    expect(source).toContain("timezone(${reportTimeZone}, ${invoices.createdAt})");
    expect(source).not.toContain(
      "date_trunc('day', ${invoices.createdAt})"
    );
  });

  it("keeps inventory expiration report filters split by status", () => {
    const source = readFileSync("server/routers/reports.ts", "utf8");

    expect(source).toContain("const timezone = await practiceTimeZone(ctx)");
    expect(source).toContain(
      "const todayYmd = formatDateInputForTimeZone(new Date(), timezone)"
    );
    expect(source).toContain("const soonYmd = addDaysYmd(todayYmd, 90)");
    expect(source).not.toContain(
      'new Date(`${todayYmd}T00:00:00.000Z`)'
    );
    expect(source).toContain("const [lowStock, expired, expiringSoon]");
    expect(source).toContain("lt(products.expirationDate, todayYmd)");
    expect(source).toContain("gte(products.expirationDate, todayYmd)");
    expect(source).toContain("lte(products.expirationDate, soonYmd)");
    expect(source).toContain("return { lowStock, expired, expiringSoon }");
  });
});
