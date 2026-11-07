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
  recordActivationAfterAppointmentCreated: vi.fn(async () => true),
  recordAuditLog: vi.fn(async () => undefined),
  providerCoverageForDate: vi.fn(
    async (): Promise<{
      configured: boolean;
      windows: Array<{ start: Date; end: Date }>;
    }> => ({ configured: false, windows: [] }),
  ),
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

vi.mock("@/lib/audit", () => ({
  recordAuditLog: mocks.recordAuditLog,
}));

vi.mock("@/lib/scheduling/provider-availability", () => ({
  providerCoverageForDate: mocks.providerCoverageForDate,
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
const LOCATION_ID = "00000000-0000-0000-0000-000000000088";

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
        bookableTypeIds: [TYPE_A],
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
              phone: "555-0100",
              isPrimary: true,
            },
          ]
        : fieldNames === "name"
          ? [{ name: "Main Clinic" }]
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
        reject?: (error: unknown) => unknown,
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
      operations.push("insert");
      insertedValues.push(vals);
      const result = insertResults.shift() ?? [];
      return {
        returning: vi.fn(async () => {
          if (opts?.insertError) throw opts.insertError;
          return result;
        }),
        then: (
          resolve: (value: unknown) => unknown,
          reject?: (error: unknown) => unknown,
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
  const update = vi.fn(() => {
    operations.push("update");
    return { set: updateSet };
  });

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
    operations,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  mocks.billingEnforced.mockReturnValue(false);
  mocks.hasHostedFullAccess.mockReturnValue(true);
  mocks.providerCoverageForDate.mockResolvedValue({
    configured: false,
    windows: [],
  });
});

describe("public booking page", () => {
  it("404s unknown or unpublished slugs", async () => {
    const { db } = createDb({ selectResults: [[]] });
    await expect(
      publicCaller(db).getPage({ slug: "nope" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("hides pages for practices without hosted access when billing is enforced", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    mocks.hasHostedFullAccess.mockReturnValue(false);
    const { db } = createDb({ selectResults: [[pageRow()]] });
    await expect(
      publicCaller(db).getPage({ slug: "test-clinic" }),
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
    expect(result.intakeFieldKeys).toEqual([]);
  });

  it("exposes optional intake only after explicit clinic configuration", async () => {
    const types = [{ id: TYPE_A, name: "Wellness Exam", durationMinutes: 30 }];
    const { db } = createDb({
      selectResults: [
        [
          pageRow({
            bookableTypeIds: [TYPE_A],
            intakeFieldKeys: ["handlingNotes", "serviceAddress"],
          }),
        ],
        types,
      ],
    });

    const result = await publicCaller(db).getPage({ slug: "test-clinic" });
    expect(result.intakeFieldKeys).toEqual(["serviceAddress", "handlingNotes"]);
  });

  it("fails closed for malformed legacy intake configuration", async () => {
    const types = [{ id: TYPE_A, name: "Wellness Exam", durationMinutes: 30 }];
    const { db } = createDb({
      selectResults: [
        [
          pageRow({
            bookableTypeIds: [TYPE_A],
            intakeFieldKeys: ["serviceAddress", "unknown-sensitive-field"],
          }),
        ],
        types,
      ],
    });

    const result = await publicCaller(db).getPage({ slug: "test-clinic" });
    expect(result.intakeFieldKeys).toEqual([]);
  });

  it("hides a published page with no configured active requestable type", async () => {
    const emptyConfig = createDb({
      selectResults: [[pageRow({ bookableTypeIds: [] })]],
    });
    await expect(
      publicCaller(emptyConfig.db).getPage({ slug: "test-clinic" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const staleConfig = createDb({
      selectResults: [[pageRow({ bookableTypeIds: [TYPE_A] })], []],
    });
    await expect(
      publicCaller(staleConfig.db).getPage({ slug: "test-clinic" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("public availability", () => {
  it("returns no slots on closed days", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T12:00:00Z"));
    const { db, select } = createDb({
      selectResults: [
        [pageRow({ hours: [null, null, null, null, null, null, null] })],
      ],
    });
    const result = await publicCaller(db).availableSlots({
      slug: "test-clinic",
      date: "2026-07-20",
      typeId: TYPE_A,
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
      selectResults: [
        [pageRow()],
        [{ id: TYPE_A, name: "Wellness Exam", durationMinutes: 30 }],
        busy,
      ],
    });
    const result = await publicCaller(db).availableSlots({
      slug: "test-clinic",
      date: "2026-07-20",
      typeId: TYPE_A,
    });
    expect(result).toEqual([
      { time: "17:30", iso: "2026-07-20T17:30:00.000Z" },
    ]);
  });

  it("intersects doctor-required requests with configured provider coverage", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T12:00:00Z"));
    mocks.providerCoverageForDate.mockResolvedValue({
      configured: true,
      windows: [
        {
          start: new Date("2026-07-20T10:00:00Z"),
          end: new Date("2026-07-20T12:00:00Z"),
        },
      ],
    });
    const { db } = createDb({
      selectResults: [
        [pageRow()],
        [
          {
            id: TYPE_A,
            name: "Wellness Exam",
            durationMinutes: 30,
            requiresDoctor: 1,
          },
        ],
        [],
      ],
    });

    const result = await publicCaller(db).availableSlots({
      slug: "test-clinic",
      date: "2026-07-20",
      typeId: TYPE_A,
    });

    expect(result.map((slot) => slot.time)).toEqual([
      "10:00",
      "10:30",
      "11:00",
      "11:30",
    ]);
    expect(mocks.providerCoverageForDate).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        locationId: LOCATION_ID,
        date: "2026-07-20",
      }),
    );
  });

  it("rejects a stale or unrequestable type before reading appointments", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T12:00:00Z"));
    const { db, select } = createDb({
      selectResults: [
        [pageRow({ bookableTypeIds: [TYPE_A] })],
        [{ id: TYPE_A, name: "Wellness Exam", durationMinutes: 30 }],
      ],
    });
    await expect(
      publicCaller(db).availableSlots({
        slug: "test-clinic",
        date: "2026-07-20",
        typeId: TYPE_B,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(select).toHaveBeenCalledTimes(2);
  });
});

describe("public booking", () => {
  function bookInput(overrides?: Record<string, unknown>) {
    return {
      slug: "test-clinic",
      typeId: TYPE_A,
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
      bookInput({ website: "https://spam.example.com" }),
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
      typeId: TYPE_A,
    };
    const { db, insertedValues, execute } = createDb({
      selectResults: [
        [pageRow({ intakeFieldKeys: ["serviceAddress"] })],
        [{ id: TYPE_A, name: "Wellness Exam", durationMinutes: 30 }],
        [],
        [],
        [],
      ],
      insertResults: [
        [{ id: CLIENT_ID }],
        [{ id: PATIENT_ID, name: "Maple" }],
        [appt],
        [],
      ],
    });

    const result = await publicCaller(db).book(
      bookInput({
        pet: { name: "Maple", species: "bovine" as const },
        intake: { serviceAddress: "North pasture, 10 Farm Road" },
      }),
    );
    expect(result.success).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    // withSystem establishes the RLS bypass, then booking takes the
    // practice-scoped advisory lock before checking for a conflicting slot.
    expect(execute).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(execute.mock.calls[1]![0])).toContain(
      "pg_advisory_xact_lock",
    );

    const [clientValues, patientValues, apptValues, commValues] =
      insertedValues as Array<Record<string, unknown>>;
    expect(clientValues).toMatchObject({
      practiceId: PRACTICE_ID,
      firstName: "Pat",
      lastName: "Jones",
      email: "pat@example.com",
    });
    // Public booking creates the client record but never creates a portal
    // credential. Staff must explicitly issue a short-lived one-time link.
    expect(clientValues!.accessToken).toBeNull();
    expect(patientValues).toMatchObject({
      clientId: CLIENT_ID,
      name: "Maple",
      species: "bovine",
    });
    expect(apptValues).toMatchObject({
      practiceId: PRACTICE_ID,
      locationId: LOCATION_ID,
      clientId: CLIENT_ID,
      patientId: PATIENT_ID,
      typeId: TYPE_A,
      status: "scheduled",
    });
    expect(apptValues!.notes).toContain("[Online request]");
    expect(apptValues!.notes).toContain(
      "Service/farm address (owner-reported): North pasture, 10 Farm Road",
    );
    expect(commValues).toMatchObject({
      practiceId: PRACTICE_ID,
      clientId: CLIENT_ID,
      channel: "portal",
      direction: "inbound",
      subject: "New appointment request for Maple",
      status: "pending",
    });
    expect(mocks.dispatchWebhookEvent).toHaveBeenCalledWith(
      PRACTICE_ID,
      "appointment.created",
      expect.objectContaining({ source: "booking_page" }),
    );
    expect(mocks.recordActivationAfterAppointmentCreated).toHaveBeenCalledWith(
      db,
      PRACTICE_ID,
      "booking.book",
    );
  });

  it("puts owner-reported service address and history in the appointment and inbox handoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T12:00:00Z"));
    const { db, insertedValues, updateSet } = createDb({
      selectResults: [
        [
          pageRow({
            intakeFieldKeys: ["serviceAddress", "symptoms", "handlingNotes"],
          }),
        ],
        [{ id: TYPE_A, name: "Wellness Exam", durationMinutes: 30 }],
        [],
        [{ id: CLIENT_ID }],
        [{ id: PATIENT_ID, name: "Milo" }],
      ],
      insertResults: [
        [{ id: APPOINTMENT_ID, startTime: new Date(), endTime: new Date() }],
        [],
      ],
    });

    await publicCaller(db).book(
      bookInput({
        intake: {
          serviceAddress: "North pasture, 10 Farm Road",
          symptoms: "Low energy and coughing",
          handlingNotes: "Call before entering the gate",
        },
      }),
    );

    const [appointment, communication] = insertedValues as Array<
      Record<string, unknown>
    >;
    expect(appointment.notes).toContain(
      "Service/farm address (owner-reported): North pasture, 10 Farm Road",
    );
    expect(appointment.notes).toContain(
      "Client-reported pre-visit history (unverified)",
    );
    expect(communication.content).toContain(String(appointment.notes));
    // Public intake is request context. It does not mutate the permanent
    // address or other demographics of an existing client.
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects overlong intake before database work", async () => {
    const { db, select, insert } = createDb();
    await expect(
      publicCaller(db).book(
        bookInput({ intake: { serviceAddress: "x".repeat(501) } }),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(select).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("rejects an aggregate note overflow before any persistence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T12:00:00Z"));
    const { db, insert } = createDb({
      selectResults: [
        [pageRow({ intakeFieldKeys: ["serviceAddress", "symptoms"] })],
      ],
    });

    await expect(
      publicCaller(db).book(
        bookInput({
          reason: "r".repeat(1000),
          intake: {
            serviceAddress: "a".repeat(500),
            symptoms: "s".repeat(500),
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining(
        "Visit details are too long to send. Shorten the visit reason or optional intake answers by at least",
      ),
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it("rejects known intake fields that the clinic disabled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T12:00:00Z"));
    const { db, insert } = createDb({
      selectResults: [[pageRow({ intakeFieldKeys: ["serviceAddress"] })]],
    });

    await expect(
      publicCaller(db).book(
        bookInput({
          intake: {
            serviceAddress: "Allowed address",
            symptoms: "Tampered disabled answer",
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message:
        "One or more optional intake fields are no longer enabled. Refresh the page and try again.",
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it("keeps legacy auto-confirm pages request-only", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T12:00:00Z"));
    const { db, insertedValues } = createDb({
      selectResults: [
        [pageRow({ autoConfirm: true })],
        [{ id: TYPE_A, name: "Wellness Exam", durationMinutes: 30 }],
        [],
        [{ id: CLIENT_ID }],
        [{ id: PATIENT_ID, name: "Milo" }],
      ],
      insertResults: [
        [{ id: APPOINTMENT_ID, startTime: new Date(), endTime: new Date() }],
        [],
      ],
    });
    const result = await publicCaller(db).book(bookInput());
    expect(result.requiresConfirmation).toBe(true);
    expect(result.message).toContain("request has been sent");
    const apptValues = insertedValues[0] as Record<string, unknown>;
    expect(apptValues.status).toBe("scheduled");
  });

  it("rejects times that clash with an existing appointment", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T12:00:00Z"));
    const { db, insert } = createDb({
      selectResults: [
        [pageRow()],
        [{ id: TYPE_A, name: "Wellness Exam", durationMinutes: 30 }],
        [{ id: APPOINTMENT_ID }],
      ],
    });
    await expect(publicCaller(db).book(bookInput())).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it("rejects a tampered doctor-required request outside provider coverage", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T12:00:00Z"));
    mocks.providerCoverageForDate.mockResolvedValue({
      configured: true,
      windows: [
        {
          start: new Date("2026-07-20T10:00:00Z"),
          end: new Date("2026-07-20T12:00:00Z"),
        },
      ],
    });
    const { db, insert } = createDb({
      selectResults: [
        [pageRow()],
        [{ id: TYPE_A, durationMinutes: 30, requiresDoctor: 1 }],
      ],
    });

    await expect(publicCaller(db).book(bookInput())).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining(
        "outside the clinic's provider coverage",
      ),
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it("rejects unknown clients when new clients are not allowed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T12:00:00Z"));
    const { db, insert } = createDb({
      selectResults: [
        [pageRow({ allowNewClients: false })],
        [{ id: TYPE_A, name: "Wellness Exam", durationMinutes: 30 }],
        [],
        [],
      ],
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
      publicCaller(db).book(bookInput({ typeId: TYPE_B })),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(insert).not.toHaveBeenCalled();
  });

  it("rejects days the page is closed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T12:00:00Z"));
    const closedMonday = [null, null, ...ALL_DAYS_OPEN.slice(2)];
    const { db } = createDb({
      selectResults: [
        [pageRow({ hours: closedMonday })],
        [{ id: TYPE_A, name: "Wellness Exam", durationMinutes: 30 }],
      ],
    });
    await expect(publicCaller(db).book(bookInput())).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("enforces the page lead time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T08:30:00Z"));
    const { db } = createDb({
      selectResults: [
        [pageRow({ leadTimeMinutes: 120 })],
        [{ id: TYPE_A, name: "Wellness Exam", durationMinutes: 30 }],
      ],
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
      } as never),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("keeps the system-scoped global slug lookup admin-only", async () => {
    const { db, select } = createDb();

    await expect(
      publicCaller(db).checkSlug({ slug: "test-clinic" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      adminCaller(db, "technician").checkSlug({ slug: "test-clinic" }),
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
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(select).not.toHaveBeenCalled();
  });

  it("checks global slug availability outside the tenant-scoped connection", async () => {
    const { db, select, execute } = createDb({
      selectResults: [[{ practiceId: "someone-else" }]],
    });

    await expect(
      adminCaller(db).checkSlug({ slug: "taken-slug" }),
    ).resolves.toEqual({ valid: true, available: false });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("keeps the practice's current slug available to that practice", async () => {
    const { db } = createDb({
      selectResults: [[{ practiceId: PRACTICE_ID }]],
    });

    await expect(
      adminCaller(db).checkSlug({ slug: "test-clinic" }),
    ).resolves.toEqual({ valid: true, available: true });
  });

  it("creates the page on first save", async () => {
    const { db, insertedValues, operations } = createDb({
      selectResults: [
        [{ id: TYPE_A, name: "Wellness Exam", durationMinutes: 30 }],
        [],
      ],
      insertResults: [[{ slug: "test-clinic", published: true }]],
    });
    const result = await adminCaller(db).savePage({
      slug: "test-clinic",
      published: true,
      config: {
        autoConfirm: true,
        bookableTypeIds: [TYPE_A],
        intakeFieldKeys: ["handlingNotes", "serviceAddress"],
      },
    } as never);
    expect(result).toEqual({ slug: "test-clinic", published: true });
    expect(insertedValues[0]).toMatchObject({
      practiceId: PRACTICE_ID,
      slug: "test-clinic",
      published: true,
      config: expect.objectContaining({
        autoConfirm: false,
        intakeFieldKeys: ["serviceAddress", "handlingNotes"],
      }),
    });
    expect(operations.indexOf("type-lock")).toBeGreaterThanOrEqual(0);
    expect(operations.indexOf("type-lock")).toBeLessThan(
      operations.indexOf("insert"),
    );
  });

  it("rejects malformed intake configuration before any database write", async () => {
    const { db, insert, updateSet } = createDb();

    await expect(
      adminCaller(db).savePage({
        slug: "test-clinic",
        published: false,
        config: {
          intakeFieldKeys: ["serviceAddress", "unknown-sensitive-field"],
        },
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(insert).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects publication unless a selected type is active in this practice", async () => {
    const noSelection = createDb();
    await expect(
      adminCaller(noSelection.db).savePage({
        slug: "test-clinic",
        published: true,
        config: {},
      } as never),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message:
        "Select at least one active visit type before publishing the appointment request page.",
    });

    const staleSelection = createDb({ selectResults: [[]] });
    await expect(
      adminCaller(staleSelection.db).savePage({
        slug: "test-clinic",
        published: true,
        config: { bookableTypeIds: [TYPE_A] },
      } as never),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("drops stale selected type IDs when saving a draft", async () => {
    const { db, insertedValues } = createDb({
      selectResults: [
        [{ id: TYPE_A, name: "Wellness Exam", durationMinutes: 30 }],
        [],
      ],
      insertResults: [[{ slug: "test-clinic", published: false }]],
    });
    await adminCaller(db).savePage({
      slug: "test-clinic",
      published: false,
      config: { bookableTypeIds: [TYPE_A, TYPE_B] },
    } as never);
    expect(insertedValues[0]).toMatchObject({
      config: expect.objectContaining({ bookableTypeIds: [TYPE_A] }),
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
      expect.objectContaining({
        slug: "new-slug",
        published: false,
        config: expect.objectContaining({ autoConfirm: false }),
      }),
    );
  });

  it("returns a friendly conflict when a concurrent save wins the slug race", async () => {
    const duplicate = Object.assign(new Error("duplicate key"), {
      code: "23505",
    });
    const { db } = createDb({
      selectResults: [
        [{ id: TYPE_A, name: "Wellness Exam", durationMinutes: 30 }],
        [],
      ],
      insertError: duplicate,
    });

    await expect(
      adminCaller(db).savePage({
        slug: "race-winner",
        published: true,
        config: { bookableTypeIds: [TYPE_A] },
      } as never),
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
      selectResults: [
        [{ id: TYPE_A, name: "Wellness Exam", durationMinutes: 30 }],
        [{ id: "existing-page" }],
      ],
      updateError: duplicate,
    });

    await expect(
      adminCaller(db).savePage({
        slug: "race-winner",
        published: true,
        config: { bookableTypeIds: [TYPE_A] },
      } as never),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "That link is already taken. Please choose another.",
    });
  });
});
