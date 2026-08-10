import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rateLimit: vi.fn(async () => ({
    success: true,
    remaining: 4,
    resetAt: new Date(),
  })),
  billingEnforced: vi.fn(() => false),
  dispatchWebhookEvent: vi.fn(async () => undefined),
  recordActivationAfterAppointmentCreated: vi.fn(async () => true),
  hasHostedFullAccess: vi.fn(() => true),
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: mocks.rateLimit,
}));

vi.mock("@/lib/webhook-dispatcher", () => ({
  dispatchWebhookEvent: mocks.dispatchWebhookEvent,
}));

vi.mock("@/lib/funnel-events-server", () => ({
  recordActivationAfterAppointmentCreated:
    mocks.recordActivationAfterAppointmentCreated,
}));

vi.mock("@/lib/billing/plans", () => ({
  billingEnforced: mocks.billingEnforced,
  hasHostedFullAccess: mocks.hasHostedFullAccess,
}));

const { portalRouter } = await import("../routers/portal");
const { PORTAL_BOOKING_REASON_MAX_LENGTH } = await import(
  "@/lib/portal/booking"
);

const TOKEN = "portal-token";
const SLOT_TOKEN_BUCKET =
  "portal-slots:token:0ba11c8c03cc892e40cac090ac14c4db6e655ecfaff2490257fbe4c10fba19f9";
const BOOK_TOKEN_BUCKET =
  "portal-book:token:0ba11c8c03cc892e40cac090ac14c4db6e655ecfaff2490257fbe4c10fba19f9";
const IP = "203.0.113.10";
const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const CLIENT_ID = "00000000-0000-0000-0000-0000000000bb";
const PATIENT_ID = "00000000-0000-0000-0000-000000000001";
const APPOINTMENT_ID = "00000000-0000-0000-0000-000000000002";
const TYPE_ID = "00000000-0000-0000-0000-000000000003";
const LOCATION_ID = "00000000-0000-0000-0000-000000000004";
const ACTIVE_PRACTICE = [{ id: PRACTICE_ID }];

function callerWithDb(db: Record<string, unknown>, ip?: string) {
  return portalRouter.createCaller({ db, ip } as never);
}

function createDb(opts?: {
  selectResults?: unknown[][];
  insertedRows?: unknown[];
}) {
  const selectResults = [...(opts?.selectResults ?? [])];
  const operations: string[] = [];
  const select = vi.fn((fields?: Record<string, unknown>) => {
    const fieldNames = Object.keys(fields ?? {})
      .sort()
      .join(",");
    const result =
      fieldNames === "address,id,isPrimary,name,phone"
        ? [
            {
              id: LOCATION_ID,
              name: "Main Clinic",
              address: "1 Main St",
              phone: null,
              isPrimary: true,
            },
          ]
        : (selectResults.shift() ?? []);
    const afterWhere = {
      limit: vi.fn(async () => result),
      orderBy: vi.fn(async () => result),
      for: vi.fn(async () => {
        operations.push("type-lock");
        return result;
      }),
      then: (
        resolve: (value: unknown[]) => unknown,
        reject?: (error: unknown) => unknown
      ) => Promise.resolve(result).then(resolve, reject),
    };
    const builder = {
      from: vi.fn(() => builder),
      where: vi.fn(() => afterWhere),
      orderBy: vi.fn(async () => result),
      limit: vi.fn(async () => result),
    };
    return builder;
  });
  const insertValues = vi.fn(() => {
    operations.push("insert");
    return {
      returning: vi.fn(async () => opts?.insertedRows ?? []),
    };
  });
  const insert = vi.fn(() => ({ values: insertValues }));
  const execute = vi.fn(async (statement: unknown) => {
    operations.push(
      JSON.stringify(statement).includes("pg_advisory_xact_lock")
        ? "booking-lock"
        : "execute"
    );
  });
  const db: Record<string, unknown> = {
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
    execute,
    select,
    insert,
    update: vi.fn(),
  };
  return { db, select, insert, insertValues, execute, operations };
}

function sqlIncludesColumnName(
  value: unknown,
  columnName: string,
  seen = new WeakSet<object>()
): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (seen.has(value)) return false;
  seen.add(value);

  const candidate = value as { name?: unknown; queryChunks?: unknown[] };
  if (candidate.name === columnName) return true;
  if (Array.isArray(candidate.queryChunks)) {
    return candidate.queryChunks.some((item) =>
      sqlIncludesColumnName(item, columnName, seen)
    );
  }
  return Object.values(value as Record<string, unknown>).some((item) =>
    sqlIncludesColumnName(item, columnName, seen)
  );
}

function sqlIncludesValue(
  value: unknown,
  needle: unknown,
  seen = new WeakSet<object>()
): boolean {
  if (Object.is(value, needle)) return true;
  if (!value || typeof value !== "object") {
    return false;
  }
  if (seen.has(value)) return false;
  seen.add(value);

  const candidate = value as { value?: unknown; queryChunks?: unknown[] };
  if (
    Object.prototype.hasOwnProperty.call(candidate, "value") &&
    Object.is(candidate.value, needle)
  ) {
    return true;
  }
  if (Array.isArray(candidate.queryChunks)) {
    return candidate.queryChunks.some((item) =>
      sqlIncludesValue(item, needle, seen)
    );
  }
  return Object.values(value as Record<string, unknown>).some((item) =>
    sqlIncludesValue(item, needle, seen)
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  mocks.billingEnforced.mockReturnValue(false);
  mocks.hasHostedFullAccess.mockReturnValue(true);
});

describe("portal booking input validation", () => {
  it("rejects oversized portal tokens before DB or rate-limit work", async () => {
    const { db, select } = createDb();
    const oversizedToken = "a".repeat(65);

    await expect(
      callerWithDb(db).availableSlots({
        token: oversizedToken,
        date: "2026-07-01",
        durationMinutes: 30,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).requestAppointment({
        token: oversizedToken,
        patientId: PATIENT_ID,
        typeId: TYPE_ID,
        preferredDate: "2026-07-01",
        preferredTime: "09:00",
        reason: "Wellness visit",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
  });

  it("rejects invalid slot lookup dates before DB work", async () => {
    const { db, select } = createDb();

    await expect(
      callerWithDb(db).availableSlots({
        token: TOKEN,
        date: "2026-02-30",
        durationMinutes: 30,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
  });

  it("rate-limits portal slot unresolved-IP probes before token or DB work", async () => {
    mocks.rateLimit.mockResolvedValueOnce({
      success: false,
      remaining: 0,
      resetAt: new Date("2026-07-01T12:15:00Z"),
    });
    const { db, select } = createDb();

    await expect(
      callerWithDb(db).availableSlots({
        token: TOKEN,
        date: "2026-07-01",
        durationMinutes: 30,
      })
    ).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
      message:
        "Too many availability requests. Please try again later or call the clinic.",
    });

    expect(mocks.rateLimit).toHaveBeenCalledWith({
      key: "portal-slots:ip:unknown",
      limit: 120,
      windowMs: 15 * 60 * 1000,
    });
    expect(select).not.toHaveBeenCalled();
  });

  it("rate-limits portal slot tokens after unresolved-IP fallback passes", async () => {
    mocks.rateLimit
      .mockResolvedValueOnce({
        success: true,
        remaining: 119,
        resetAt: new Date("2026-07-01T12:15:00Z"),
      })
      .mockResolvedValueOnce({
        success: false,
        remaining: 0,
        resetAt: new Date("2026-07-01T12:15:00Z"),
      });
    const { db, select } = createDb();

    await expect(
      callerWithDb(db).availableSlots({
        token: TOKEN,
        date: "2026-07-01",
        durationMinutes: 30,
      })
    ).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
      message:
        "Too many availability requests. Please try again later or call the clinic.",
    });

    expect(mocks.rateLimit).toHaveBeenNthCalledWith(1, {
      key: "portal-slots:ip:unknown",
      limit: 120,
      windowMs: 15 * 60 * 1000,
    });
    expect(mocks.rateLimit).toHaveBeenNthCalledWith(2, {
      key: SLOT_TOKEN_BUCKET,
      limit: 60,
      windowMs: 15 * 60 * 1000,
    });
    expect(mocks.rateLimit).not.toHaveBeenCalledWith(
      expect.objectContaining({ key: `portal-slots:${TOKEN}` })
    );
    expect(select).not.toHaveBeenCalled();
  });

  it("fails closed when the portal slot limiter is unavailable", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mocks.rateLimit.mockRejectedValueOnce(new Error("rate limiter down"));
    const { db, select } = createDb();

    try {
      await expect(
        callerWithDb(db).availableSlots({
          token: TOKEN,
          date: "2026-07-01",
          durationMinutes: 30,
        })
      ).rejects.toMatchObject({
        code: "TOO_MANY_REQUESTS",
        message:
          "Too many availability requests. Please try again later or call the clinic.",
      });

      expect(consoleError).toHaveBeenCalledWith(
        "[portal] rate limit failed:",
        expect.any(Error)
      );
      expect(mocks.rateLimit).toHaveBeenCalledWith({
        key: "portal-slots:ip:unknown",
        limit: 120,
        windowMs: 15 * 60 * 1000,
      });
      expect(select).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("rate-limits portal slot token probes by IP before token or DB work", async () => {
    mocks.rateLimit.mockResolvedValueOnce({
      success: false,
      remaining: 0,
      resetAt: new Date("2026-07-01T12:15:00Z"),
    });
    const { db, select } = createDb();

    await expect(
      callerWithDb(db, IP).availableSlots({
        token: TOKEN,
        date: "2026-07-01",
        durationMinutes: 30,
      })
    ).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
      message:
        "Too many availability requests. Please try again later or call the clinic.",
    });

    expect(mocks.rateLimit).toHaveBeenCalledTimes(1);
    expect(mocks.rateLimit).toHaveBeenCalledWith({
      key: `portal-slots:ip:${IP}`,
      limit: 120,
      windowMs: 15 * 60 * 1000,
    });
    expect(select).not.toHaveBeenCalled();
  });

  it("rejects invalid appointment request date and time before DB or rate-limit work", async () => {
    const { db, select } = createDb();

    await expect(
      callerWithDb(db).requestAppointment({
        token: TOKEN,
        patientId: PATIENT_ID,
        typeId: TYPE_ID,
        preferredDate: "2026-02-30",
        preferredTime: "09:00",
        reason: "Wellness visit",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).requestAppointment({
        token: TOKEN,
        patientId: PATIENT_ID,
        typeId: TYPE_ID,
        preferredDate: "2026-07-01",
        preferredTime: "25:00",
        reason: "Wellness visit",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
  });

  it("rejects blank or oversized appointment request reasons before rate-limit work", async () => {
    const { db, select } = createDb();

    await expect(
      callerWithDb(db).requestAppointment({
        token: TOKEN,
        patientId: PATIENT_ID,
        typeId: TYPE_ID,
        preferredDate: "2026-07-01",
        preferredTime: "09:00",
        reason: "   ",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).requestAppointment({
        token: TOKEN,
        patientId: PATIENT_ID,
        typeId: TYPE_ID,
        preferredDate: "2026-07-01",
        preferredTime: "09:00",
        reason: "A".repeat(PORTAL_BOOKING_REASON_MAX_LENGTH + 1),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
  });

  it("rate-limits portal appointment unresolved-IP probes before token or DB work", async () => {
    mocks.rateLimit.mockResolvedValueOnce({
      success: false,
      remaining: 0,
      resetAt: new Date("2026-07-01T13:00:00Z"),
    });
    const { db, select, insert } = createDb();

    await expect(
      callerWithDb(db).requestAppointment({
        token: TOKEN,
        patientId: PATIENT_ID,
        typeId: TYPE_ID,
        preferredDate: "2026-07-01",
        preferredTime: "09:00",
        reason: "Wellness visit",
      })
    ).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
      message: "Too many requests. Please try again later or call the clinic.",
    });

    expect(mocks.rateLimit).toHaveBeenCalledWith({
      key: "portal-book:ip:unknown",
      limit: 20,
      windowMs: 60 * 60 * 1000,
    });
    expect(select).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(mocks.dispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it("fails closed when the portal appointment limiter is unavailable", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mocks.rateLimit.mockRejectedValueOnce(new Error("rate limiter down"));
    const { db, select, insert } = createDb();

    try {
      await expect(
        callerWithDb(db).requestAppointment({
          token: TOKEN,
          patientId: PATIENT_ID,
          typeId: TYPE_ID,
          preferredDate: "2026-07-01",
          preferredTime: "09:00",
          reason: "Wellness visit",
        })
      ).rejects.toMatchObject({
        code: "TOO_MANY_REQUESTS",
        message: "Too many requests. Please try again later or call the clinic.",
      });

      expect(consoleError).toHaveBeenCalledWith(
        "[portal] rate limit failed:",
        expect.any(Error)
      );
      expect(mocks.rateLimit).toHaveBeenCalledWith({
        key: "portal-book:ip:unknown",
        limit: 20,
        windowMs: 60 * 60 * 1000,
      });
      expect(select).not.toHaveBeenCalled();
      expect(insert).not.toHaveBeenCalled();
      expect(mocks.dispatchWebhookEvent).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("rate-limits portal appointment tokens after unresolved-IP fallback passes", async () => {
    mocks.rateLimit
      .mockResolvedValueOnce({
        success: true,
        remaining: 19,
        resetAt: new Date("2026-07-01T13:00:00Z"),
      })
      .mockResolvedValueOnce({
        success: false,
        remaining: 0,
        resetAt: new Date("2026-07-01T13:00:00Z"),
      });
    const { db, select, insert } = createDb();

    await expect(
      callerWithDb(db).requestAppointment({
        token: TOKEN,
        patientId: PATIENT_ID,
        typeId: TYPE_ID,
        preferredDate: "2026-07-01",
        preferredTime: "09:00",
        reason: "Wellness visit",
      })
    ).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
      message: "Too many requests. Please try again later or call the clinic.",
    });

    expect(mocks.rateLimit).toHaveBeenNthCalledWith(1, {
      key: "portal-book:ip:unknown",
      limit: 20,
      windowMs: 60 * 60 * 1000,
    });
    expect(mocks.rateLimit).toHaveBeenNthCalledWith(2, {
      key: BOOK_TOKEN_BUCKET,
      limit: 5,
      windowMs: 60 * 60 * 1000,
    });
    expect(mocks.rateLimit).not.toHaveBeenCalledWith(
      expect.objectContaining({ key: `portal-book:${TOKEN}` })
    );
    expect(select).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(mocks.dispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it("rate-limits portal appointment token probes by IP before token or DB work", async () => {
    mocks.rateLimit.mockResolvedValueOnce({
      success: false,
      remaining: 0,
      resetAt: new Date("2026-07-01T13:00:00Z"),
    });
    const { db, select, insert } = createDb();

    await expect(
      callerWithDb(db, IP).requestAppointment({
        token: TOKEN,
        patientId: PATIENT_ID,
        typeId: TYPE_ID,
        preferredDate: "2026-07-01",
        preferredTime: "09:00",
        reason: "Wellness visit",
      })
    ).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
      message: "Too many requests. Please try again later or call the clinic.",
    });

    expect(mocks.rateLimit).toHaveBeenCalledTimes(1);
    expect(mocks.rateLimit).toHaveBeenCalledWith({
      key: `portal-book:ip:${IP}`,
      limit: 20,
      windowMs: 60 * 60 * 1000,
    });
    expect(select).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(mocks.dispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it("does not suggest slots that have already started today", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T17:15:00.000Z"));
    const { db } = createDb({
      selectResults: [
        [{ id: CLIENT_ID, practiceId: PRACTICE_ID }],
        ACTIVE_PRACTICE,
        [{ timezone: "America/Los_Angeles" }],
        [],
      ],
    });

    const result = await callerWithDb(db).availableSlots({
      token: TOKEN,
      date: "2026-07-01",
      durationMinutes: 30,
    });

    expect(result[0]).toMatchObject({ time: "10:30" });
    expect(result[0]?.iso).toBe("2026-07-01T17:30:00.000Z");
    expect(result.map((slot) => slot.time)).not.toContain("10:00");
    expect(result.at(-1)).toMatchObject({ time: "17:30" });
  });

  it("suggests slots for long appointment type durations allowed by settings", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T14:00:00.000Z"));
    const { db } = createDb({
      selectResults: [
        [{ id: CLIENT_ID, practiceId: PRACTICE_ID }],
        ACTIVE_PRACTICE,
        [{ timezone: "America/Los_Angeles" }],
        [],
      ],
    });

    const result = await callerWithDb(db).availableSlots({
      token: TOKEN,
      date: "2026-07-02",
      durationMinutes: 240,
    });

    expect(result.map((slot) => slot.time)).toEqual(["08:00", "12:00"]);
  });

  it("rejects portal appointment requests when the requested slot is no longer available", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T14:00:00.000Z"));
    const { db, insert } = createDb({
      selectResults: [
        [{ id: CLIENT_ID, practiceId: PRACTICE_ID }],
        ACTIVE_PRACTICE,
        ACTIVE_PRACTICE,
        [{ timezone: "America/Los_Angeles" }],
        [{ id: PATIENT_ID, name: "Juniper" }],
        [{ id: TYPE_ID, durationMinutes: 30 }],
        [{ id: APPOINTMENT_ID }],
      ],
    });

    await expect(
      callerWithDb(db).requestAppointment({
        token: TOKEN,
        patientId: PATIENT_ID,
        typeId: TYPE_ID,
        preferredDate: "2026-07-01",
        preferredTime: "09:00",
        reason: "Wellness visit",
      })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "That time is no longer available. Please choose another time.",
    });

    expect(mocks.rateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ key: BOOK_TOKEN_BUCKET })
    );
    expect(insert).not.toHaveBeenCalled();
    expect(mocks.dispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it("rejects portal appointment requests when the practice becomes inactive before the write", async () => {
    const { db, insert } = createDb({
      selectResults: [
        [{ id: CLIENT_ID, practiceId: PRACTICE_ID }],
        ACTIVE_PRACTICE,
        [],
      ],
    });

    await expect(
      callerWithDb(db).requestAppointment({
        token: TOKEN,
        patientId: PATIENT_ID,
        typeId: TYPE_ID,
        preferredDate: "2026-07-01",
        preferredTime: "09:00",
        reason: "Wellness visit",
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Invalid portal link",
    });

    expect(insert).not.toHaveBeenCalled();
    expect(mocks.dispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it("uses a booking-specific error when hosted billing gates portal appointment requests", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    mocks.hasHostedFullAccess.mockReturnValue(false);
    const { db, insert } = createDb({
      selectResults: [
        [{ id: CLIENT_ID, practiceId: PRACTICE_ID }],
        ACTIVE_PRACTICE,
        [{ tier: "free", billingStatus: "past_due", trialEndsAt: null }],
      ],
    });

    await expect(
      callerWithDb(db).requestAppointment({
        token: TOKEN,
        patientId: PATIENT_ID,
        typeId: TYPE_ID,
        preferredDate: "2026-07-01",
        preferredTime: "09:00",
        reason: "Wellness visit",
      })
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message:
        "Online booking is unavailable until this practice's Cloud subscription is active.",
    });

    expect(insert).not.toHaveBeenCalled();
    expect(mocks.dispatchWebhookEvent).not.toHaveBeenCalled();
    expect(mocks.hasHostedFullAccess).toHaveBeenCalledWith(
      "free",
      "past_due",
      null
    );
  });

  it("rejects direct portal appointment requests outside booking hours before side effects", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T14:00:00.000Z"));
    const { db, insert } = createDb({
      selectResults: [
        [{ id: CLIENT_ID, practiceId: PRACTICE_ID }],
        ACTIVE_PRACTICE,
        ACTIVE_PRACTICE,
        [{ timezone: "America/Los_Angeles" }],
        [{ id: PATIENT_ID, name: "Juniper" }],
        [{ id: TYPE_ID, durationMinutes: 30 }],
      ],
    });

    await expect(
      callerWithDb(db).requestAppointment({
        token: TOKEN,
        patientId: PATIENT_ID,
        typeId: TYPE_ID,
        preferredDate: "2026-07-01",
        preferredTime: "07:30",
        reason: "Wellness visit",
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Please choose a time between 08:00 and 18:00.",
    });

    expect(mocks.rateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ key: BOOK_TOKEN_BUCKET })
    );
    expect(insert).not.toHaveBeenCalled();
    expect(mocks.dispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it("stores portal appointment requests in the practice timezone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T14:00:00.000Z"));
    const { db, insertValues, execute, operations } = createDb({
      selectResults: [
        [{ id: CLIENT_ID, practiceId: PRACTICE_ID }],
        ACTIVE_PRACTICE,
        ACTIVE_PRACTICE,
        [{ timezone: "America/Los_Angeles" }],
        [{ id: PATIENT_ID, name: "Juniper" }],
        [{ id: TYPE_ID, durationMinutes: 30 }],
        [],
      ],
      insertedRows: [
        {
          id: APPOINTMENT_ID,
          startTime: new Date("2026-07-01T16:00:00.000Z"),
          endTime: new Date("2026-07-01T16:30:00.000Z"),
          status: "scheduled",
        },
      ],
    });

    await expect(
      callerWithDb(db).requestAppointment({
        token: TOKEN,
        patientId: PATIENT_ID,
        typeId: TYPE_ID,
        preferredDate: "2026-07-01",
        preferredTime: "09:00",
        reason: "Wellness visit",
      })
    ).resolves.toMatchObject({
      success: true,
      appointmentId: APPOINTMENT_ID,
    });

    expect(insertValues).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        clientId: CLIENT_ID,
        patientId: PATIENT_ID,
        typeId: TYPE_ID,
        locationId: LOCATION_ID,
        startTime: new Date("2026-07-01T16:00:00.000Z"),
        endTime: new Date("2026-07-01T16:30:00.000Z"),
      })
    );
    expect(execute).toHaveBeenCalled();
    expect(JSON.stringify(execute.mock.calls.at(-1)?.[0])).toContain(
      "pg_advisory_xact_lock"
    );
    expect(operations.indexOf("booking-lock")).toBeLessThan(
      operations.indexOf("type-lock")
    );
    expect(operations.indexOf("type-lock")).toBeLessThan(
      operations.indexOf("insert")
    );
    expect(insertValues).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        clientId: CLIENT_ID,
        channel: "portal",
        content: expect.stringContaining(
          "Requested: 2026-07-01 09:00 (America/Los_Angeles)"
        ),
      })
    );
    expect(mocks.recordActivationAfterAppointmentCreated).toHaveBeenCalledWith(
      db,
      PRACTICE_ID,
      "portal.requestAppointment"
    );
    const communicationInsert = insertValues.mock.calls[1] as unknown as [
      { content: string; assignedTo?: unknown },
    ];
    expect(communicationInsert[0]).toEqual(
      expect.objectContaining({
        content: expect.not.stringContaining("2026-07-01T16:00:00.000Z"),
      })
    );
    expect(communicationInsert[0].assignedTo).toBeTruthy();
    expect(
      sqlIncludesColumnName(communicationInsert[0].assignedTo, "assigned_to")
    ).toBe(true);
    expect(
      sqlIncludesColumnName(communicationInsert[0].assignedTo, "client_id")
    ).toBe(true);
    expect(sqlIncludesValue(communicationInsert[0].assignedTo, PRACTICE_ID)).toBe(
      true
    );
    expect(sqlIncludesValue(communicationInsert[0].assignedTo, CLIENT_ID)).toBe(
      true
    );
    expect(mocks.dispatchWebhookEvent).toHaveBeenCalledWith(
      PRACTICE_ID,
      "appointment.created",
      expect.objectContaining({
        id: APPOINTMENT_ID,
        source: "portal",
      })
    );
  });

  it("rejects stale or cross-practice appointment types before creating a request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T14:00:00.000Z"));
    const { db, insert } = createDb({
      selectResults: [
        [{ id: CLIENT_ID, practiceId: PRACTICE_ID }],
        ACTIVE_PRACTICE,
        ACTIVE_PRACTICE,
        [{ timezone: "America/Los_Angeles" }],
        [{ id: PATIENT_ID, name: "Juniper" }],
        [],
      ],
    });

    await expect(
      callerWithDb(db).requestAppointment({
        token: TOKEN,
        patientId: PATIENT_ID,
        typeId: TYPE_ID,
        preferredDate: "2026-07-01",
        preferredTime: "09:00",
        reason: "Wellness visit",
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Appointment type not found",
    });
    expect(insert).not.toHaveBeenCalled();
  });
});
