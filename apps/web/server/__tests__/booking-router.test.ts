import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rateLimit: vi.fn(async () => ({
    success: true,
    remaining: 4,
    resetAt: new Date(),
  })),
  billingEnforced: vi.fn(() => false),
  hasHostedFullAccess: vi.fn(() => true),
  dispatchWebhookEvent: vi.fn(async () => undefined),
  recordAuditLog: vi.fn(async () => undefined),
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: mocks.rateLimit,
}));

vi.mock("@/lib/webhook-dispatcher", () => ({
  dispatchWebhookEvent: mocks.dispatchWebhookEvent,
}));

vi.mock("@/lib/billing/plans", () => ({
  billingEnforced: mocks.billingEnforced,
  hasHostedFullAccess: mocks.hasHostedFullAccess,
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: mocks.recordAuditLog,
}));

const { bookingRouter } = await import("../routers/booking");

const IP = "203.0.113.10";
const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const CLIENT_ID = "00000000-0000-0000-0000-0000000000bb";
const PATIENT_ID = "00000000-0000-0000-0000-000000000001";
const APPOINTMENT_ID = "00000000-0000-0000-0000-000000000002";
const TYPE_A = "00000000-0000-0000-0000-00000000000a";
const TYPE_B = "00000000-0000-0000-0000-00000000000b";
const USER_ID = "00000000-0000-0000-0000-000000000099";

const ALL_DAYS_OPEN = Array(7).fill({ open: "08:00", close: "18:00" });

function practiceRow(overrides?: Record<string, unknown>) {
  return {
    id: PRACTICE_ID,
    name: "Test Clinic",
    logoUrl: null,
    address: "1 Main St",
    phone: "555-0100",
    timezone: "UTC",
    subscriptionTier: "cloud",
    billingStatus: "trialing",
    trialEndsAt: null,
    ...overrides,
  };
}

function pageRow(config?: Record<string, unknown>) {
  return {
    page: {
      id: "00000000-0000-0000-0000-0000000000cc",
      practiceId: PRACTICE_ID,
      slug: "test-clinic",
      published: true,
      config: {
        hours: ALL_DAYS_OPEN,
        leadTimeMinutes: 0,
        ...config,
      },
    },
    practice: practiceRow(),
  };
}

function publicCaller(db: Record<string, unknown>) {
  return bookingRouter.createCaller({ db, ip: IP } as never);
}

function adminCaller(db: Record<string, unknown>, role = "admin") {
  return bookingRouter.createCaller({
    db,
    ip: IP,
    session: {
      user: {
        id: USER_ID,
        email: "admin@example.com",
        name: "Admin",
        role,
        practiceId: PRACTICE_ID,
      },
    },
  } as never);
}

function createDb(opts?: {
  selectResults?: unknown[][];
  insertResults?: unknown[][];
  updatedRows?: unknown[];
  insertError?: unknown;
  updateError?: unknown;
}) {
  const selectResults = [...(opts?.selectResults ?? [])];
  const insertResults = [...(opts?.insertResults ?? [])];
  const insertedValues: unknown[] = [];

  const select = vi.fn(() => {
    const result = selectResults.shift() ?? [];
    const afterWhere = {
      limit: vi.fn(async () => result),
      orderBy: vi.fn(async () => result),
      then: (
        resolve: (value: unknown[]) => unknown,
        reject?: (error: unknown) => unknown
      ) => Promise.resolve(result).then(resolve, reject),
    };
    const builder = {
      from: vi.fn(() => builder),
      innerJoin: vi.fn(() => builder),
      where: vi.fn(() => afterWhere),
      orderBy: vi.fn(async () => result),
      limit: vi.fn(async () => result),
    };
    return builder;
  });

  const insert = vi.fn(() => ({
    values: vi.fn((vals: unknown) => {
      insertedValues.push(vals);
      const result = insertResults.shift() ?? [];
      return {
        returning: vi.fn(async () => {
          if (opts?.insertError) throw opts.insertError;
          return result;
        }),
        then: (
          resolve: (value: unknown) => unknown,
          reject?: (error: unknown) => unknown
        ) => Promise.resolve(result).then(resolve, reject),
      };
    }),
  }));

  const updateReturning = vi.fn(async () => {
    if (opts?.updateError) throw opts.updateError;
    return opts?.updatedRows ?? [];
  });
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    execute: vi.fn(async () => undefined),
    select,
    insert,
    update,
  };

  return {
    db,
    select,
    insert,
    insertedValues,
    updateSet,
    execute: db.execute as ReturnType<typeof vi.fn>,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  mocks.billingEnforced.mockReturnValue(false);
  mocks.hasHostedFullAccess.mockReturnValue(true);
});

describe("public booking page", () => {
  it("404s unknown or unpublished slugs", async () => {
    const { db } = createDb({ selectResults: [[]] });
    await expect(
      publicCaller(db).getPage({ slug: "nope" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("hides pages for practices without hosted access when billing is enforced", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    mocks.hasHostedFullAccess.mockReturnValue(false);
    const { db } = createDb({ selectResults: [[pageRow()]] });
    await expect(
      publicCaller(db).getPage({ slug: "test-clinic" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("returns page data with bookable types filtered by config", async () => {
    const types = [
      { id: TYPE_A, name: "Wellness Exam", durationMinutes: 30 },
      { id: TYPE_B, name: "Surgery", durationMinutes: 120 },
    ];
    const { db } = createDb({
      selectResults: [[pageRow({ bookableTypeIds: [TYPE_A] })], types],
    });
    const result = await publicCaller(db).getPage({ slug: "test-clinic" });
    expect(result.practice.name).toBe("Test Clinic");
    expect(result.types).toEqual([types[0]]);
  });
});

describe("public availability", () => {
  it("returns no slots on closed days", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T12:00:00Z"));
    const { db, select } = createDb({
      selectResults: [[pageRow({ hours: [null, null, null, null, null, null, null] })]],
    });
    const result = await publicCaller(db).availableSlots({
      slug: "test-clinic",
      date: "2026-07-20",
    });
    expect(result).toEqual([]);
    // Page lookup only; the busy-appointments query is never made.
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("excludes times blocked by existing appointments", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T12:00:00Z"));
    const busy = [
      {
        startTime: new Date("2026-07-20T08:00:00Z"),
        endTime: new Date("2026-07-20T17:30:00Z"),
      },
    ];
    const { db } = createDb({
      selectResults: [[pageRow()], busy],
    });
    const result = await publicCaller(db).availableSlots({
      slug: "test-clinic",
      date: "2026-07-20",
    });
    expect(result).toEqual([{ time: "17:30", iso: "2026-07-20T17:30:00.000Z" }]);
  });
});

describe("public booking", () => {
  function bookInput(overrides?: Record<string, unknown>) {
    return {
      slug: "test-clinic",
      date: "2026-07-20",
      time: "09:00",
      contact: {
        firstName: "Pat",
        lastName: "Jones",
        email: "PAT@example.com",
        phone: "555-0111",
      },
      pet: { name: "Milo", species: "canine" as const },
      reason: "New puppy checkup",
      ...overrides,
    };
  }

  it("silently accepts honeypot submissions without touching the database", async () => {
    const { db, select, insert } = createDb();
    const result = await publicCaller(db).book(
      bookInput({ website: "https://spam.example.com" })
    );
    expect(result.success).toBe(true);
    expect(select).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("creates client, pet, appointment, and inbox item for a new client", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T12:00:00Z"));
    const appt = {
      id: APPOINTMENT_ID,
      startTime: new Date("2026-07-20T09:00:00Z"),
      endTime: new Date("2026-07-20T09:30:00Z"),
      status: "scheduled",
      patientId: PATIENT_ID,
      clientId: CLIENT_ID,
      typeId: null,
    };
    const { db, insertedValues, execute } = createDb({
      selectResults: [[pageRow()], [], [], []],
      insertResults: [
        [{ id: CLIENT_ID }],
        [{ id: PATIENT_ID, name: "Milo" }],
        [appt],
        [],
      ],
    });

    const result = await publicCaller(db).book(bookInput());
    expect(result.success).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    // withSystem establishes the RLS bypass, then booking takes the
    // practice-scoped advisory lock before checking for a conflicting slot.
    expect(execute).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(execute.mock.calls[1]![0])).toContain(
      "pg_advisory_xact_lock"
    );

    const [clientValues, patientValues, apptValues, commValues] =
      insertedValues as Array<Record<string, unknown>>;
    expect(clientValues).toMatchObject({
      practiceId: PRACTICE_ID,
      firstName: "Pat",
      lastName: "Jones",
      email: "pat@example.com",
    });
    expect(typeof clientValues!.accessToken).toBe("string");
    expect((clientValues!.accessToken as string).length).toBeGreaterThan(30);
    expect(patientValues).toMatchObject({
      clientId: CLIENT_ID,
      name: "Milo",
      species: "canine",
    });
    expect(apptValues).toMatchObject({
      practiceId: PRACTICE_ID,
      clientId: CLIENT_ID,
      patientId: PATIENT_ID,
      status: "scheduled",
    });
    expect(apptValues!.notes).toContain("[Online booking]");
    expect(commValues).toMatchObject({
      practiceId: PRACTICE_ID,
      clientId: CLIENT_ID,
      channel: "portal",
      direction: "inbound",
      status: "pending",
    });
    expect(mocks.dispatchWebhookEvent).toHaveBeenCalledWith(
      PRACTICE_ID,
      "appointment.created",
      expect.objectContaining({ source: "booking_page" })
    );
  });

  it("books as confirmed when the page auto-confirms", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T12:00:00Z"));
    const { db, insertedValues } = createDb({
      selectResults: [
        [pageRow({ autoConfirm: true })],
        [],
        [{ id: CLIENT_ID }],
        [{ id: PATIENT_ID, name: "Milo" }],
      ],
      insertResults: [[{ id: APPOINTMENT_ID, startTime: new Date(), endTime: new Date() }], []],
    });
    const result = await publicCaller(db).book(bookInput());
    expect(result.requiresConfirmation).toBe(false);
    const apptValues = insertedValues[0] as Record<string, unknown>;
    expect(apptValues.status).toBe("confirmed");
  });

  it("rejects times that clash with an existing appointment", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T12:00:00Z"));
    const { db, insert } = createDb({
      selectResults: [[pageRow()], [{ id: APPOINTMENT_ID }]],
    });
    await expect(publicCaller(db).book(bookInput())).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it("rejects unknown clients when new clients are not allowed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T12:00:00Z"));
    const { db, insert } = createDb({
      selectResults: [[pageRow({ allowNewClients: false })], [], []],
    });
    await expect(publicCaller(db).book(bookInput())).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it("rejects types that are not offered online", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T12:00:00Z"));
    const { db, insert } = createDb({
      selectResults: [
        [pageRow({ bookableTypeIds: [TYPE_A] })],
        [
          { id: TYPE_A, name: "Wellness Exam", durationMinutes: 30 },
          { id: TYPE_B, name: "Surgery", durationMinutes: 120 },
        ],
      ],
    });
    await expect(
      publicCaller(db).book(bookInput({ typeId: TYPE_B }))
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(insert).not.toHaveBeenCalled();
  });

  it("rejects days the page is closed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T12:00:00Z"));
    const closedMonday = [null, null, ...ALL_DAYS_OPEN.slice(2)];
    const { db } = createDb({
      selectResults: [[pageRow({ hours: closedMonday })]],
    });
    await expect(publicCaller(db).book(bookInput())).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("enforces the page lead time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T08:30:00Z"));
    const { db } = createDb({
      selectResults: [[pageRow({ leadTimeMinutes: 120 })]],
    });
    await expect(publicCaller(db).book(bookInput())).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("too soon"),
    });
  });

  it("fails closed when the rate limiter errors", async () => {
    mocks.rateLimit.mockRejectedValueOnce(new Error("db down"));
    const { db, select } = createDb();
    await expect(publicCaller(db).book(bookInput())).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
    expect(select).not.toHaveBeenCalled();
  });
});

describe("booking page admin", () => {
  it("requires the admin role", async () => {
    const { db } = createDb();
    await expect(
      adminCaller(db, "technician").savePage({
        slug: "test-clinic",
        published: true,
        config: {},
      } as never)
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("keeps the system-scoped global slug lookup admin-only", async () => {
    const { db, select } = createDb();

    await expect(
      publicCaller(db).checkSlug({ slug: "test-clinic" })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      adminCaller(db, "technician").checkSlug({ slug: "test-clinic" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(select).not.toHaveBeenCalled();
  });

  it("rejects invalid and reserved slugs before any database work", async () => {
    const { db, select } = createDb();
    await expect(
      adminCaller(db).savePage({
        slug: "admin",
        published: false,
        config: {},
      } as never)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(select).not.toHaveBeenCalled();
  });

  it("checks global slug availability outside the tenant-scoped connection", async () => {
    const { db, select, execute } = createDb({
      selectResults: [[{ practiceId: "someone-else" }]],
    });

    await expect(
      adminCaller(db).checkSlug({ slug: "taken-slug" })
    ).resolves.toEqual({ valid: true, available: false });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("keeps the practice's current slug available to that practice", async () => {
    const { db } = createDb({
      selectResults: [[{ practiceId: PRACTICE_ID }]],
    });

    await expect(
      adminCaller(db).checkSlug({ slug: "test-clinic" })
    ).resolves.toEqual({ valid: true, available: true });
  });

  it("creates the page on first save", async () => {
    const { db, insertedValues } = createDb({
      selectResults: [[]],
      insertResults: [[{ slug: "test-clinic", published: true }]],
    });
    const result = await adminCaller(db).savePage({
      slug: "test-clinic",
      published: true,
      config: {},
    } as never);
    expect(result).toEqual({ slug: "test-clinic", published: true });
    expect(insertedValues[0]).toMatchObject({
      practiceId: PRACTICE_ID,
      slug: "test-clinic",
      published: true,
    });
  });

  it("updates the existing page on later saves", async () => {
    const { db, updateSet, insertedValues } = createDb({
      selectResults: [[{ id: "existing-page" }]],
      updatedRows: [{ slug: "new-slug", published: false }],
    });
    const result = await adminCaller(db).savePage({
      slug: "new-slug",
      published: false,
      config: {},
    } as never);
    expect(result).toEqual({ slug: "new-slug", published: false });
    expect(insertedValues).toHaveLength(0);
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "new-slug", published: false })
    );
  });

  it("returns a friendly conflict when a concurrent save wins the slug race", async () => {
    const duplicate = Object.assign(new Error("duplicate key"), {
      code: "23505",
    });
    const { db } = createDb({
      selectResults: [[]],
      insertError: duplicate,
    });

    await expect(
      adminCaller(db).savePage({
        slug: "race-winner",
        published: true,
        config: {},
      } as never)
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "That link is already taken. Please choose another.",
    });
  });

  it("returns the same friendly conflict when a slug update loses the race", async () => {
    const duplicate = Object.assign(new Error("duplicate key"), {
      code: "23505",
    });
    const { db } = createDb({
      selectResults: [[{ id: "existing-page" }]],
      updateError: duplicate,
    });

    await expect(
      adminCaller(db).savePage({
        slug: "race-winner",
        published: true,
        config: {},
      } as never)
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "That link is already taken. Please choose another.",
    });
  });
});
