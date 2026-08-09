import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  sendSms: vi.fn(),
  recordAuditLog: vi.fn(async () => undefined),
  alertOps: vi.fn(async () => undefined),
  durableDb: {} as Record<string, unknown>,
  withDurableSmsCommunication: vi.fn(),
}));

vi.mock("@/lib/email", () => ({
  sendEmail: mocks.sendEmail,
}));

vi.mock("@/lib/sms", () => ({
  sendSms: mocks.sendSms,
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: mocks.recordAuditLog,
}));

vi.mock("@/lib/alerts", () => ({
  alertOps: mocks.alertOps,
}));

vi.mock("@/lib/messaging/durable-sms-communication", () => ({
  withDurableSmsCommunication: mocks.withDurableSmsCommunication,
}));

const {
  COMMUNICATION_CONTENT_MAX_LENGTH,
  COMMUNICATION_SUBJECT_MAX_LENGTH,
  SMS_COMMUNICATION_CONTENT_MAX_LENGTH,
  communicationsRouter,
} = await import("../routers/communications");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const OTHER_USER_ID = "00000000-0000-0000-0000-000000000009";
const CLIENT_ID = "00000000-0000-0000-0000-000000000002";
const COMM_ID = "00000000-0000-0000-0000-000000000003";
const LOCATION_ID = "00000000-0000-0000-0000-000000000004";
const REQUEST_ID = "00000000-0000-0000-0000-000000000099";
const routerSource = readFileSync("server/routers/communications.ts", "utf8");

function callerWithDb(db: Record<string, unknown>, role = "front_desk") {
  mocks.durableDb = db;
  mocks.withDurableSmsCommunication.mockImplementation(
    (_practiceId: string, fn: (durableDb: unknown) => unknown) =>
      fn(mocks.durableDb),
  );
  const session = {
    user: {
      id: USER_ID,
      email: `${role}@example.com`,
      name: "Inbox User",
      role,
      practiceId: PRACTICE_ID,
    },
  };
  return communicationsRouter.createCaller({ db, session } as never);
}

function sqlIncludesColumnName(value: unknown, columnName: string): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as { name?: unknown; queryChunks?: unknown[] };
  if (candidate.name === columnName) {
    return true;
  }
  if (!Array.isArray(candidate.queryChunks)) {
    return false;
  }

  return candidate.queryChunks.some((item) =>
    sqlIncludesColumnName(item, columnName),
  );
}

function sqlIncludesValue(
  value: unknown,
  needle: unknown,
  seen = new WeakSet<object>(),
): boolean {
  if (Object.is(value, needle)) {
    return true;
  }

  if (!value || typeof value !== "object") {
    return false;
  }

  if (seen.has(value)) {
    return false;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.some((item) => sqlIncludesValue(item, needle, seen));
  }

  const candidate = value as { queryChunks?: unknown[] };
  if (Array.isArray(candidate.queryChunks)) {
    return candidate.queryChunks.some((item) =>
      sqlIncludesValue(item, needle, seen),
    );
  }

  return Object.values(value as Record<string, unknown>).some((item) =>
    sqlIncludesValue(item, needle, seen),
  );
}

function createDb(opts?: {
  client?: Record<string, unknown> | null;
  practice?: Record<string, unknown> | null;
  smsSender?: Record<string, unknown> | null;
  conversationAssignment?: Record<string, unknown> | null;
  inserted?: Record<string, unknown>;
  updated?: Record<string, unknown> | null;
  selectResults?: unknown[][];
  insertResults?: Array<Record<string, unknown>[]>;
}) {
  const client = opts?.client ?? {
    id: CLIENT_ID,
    firstName: "Ada",
    lastName: "Lovelace",
    email: "ada@example.com",
    phone: "(555) 555-0100",
    smsConsent: true,
  };
  const practice =
    opts && "practice" in opts
      ? opts.practice
      : {
          name: "Neighborhood Veterinary",
          timezone: "America/New_York",
          email: "clinic@example.com",
        };
  const smsSender =
    opts && "smsSender" in opts ? opts.smsSender : { locationId: LOCATION_ID };
  const conversationAssignment =
    opts && "conversationAssignment" in opts
      ? opts.conversationAssignment
      : null;
  const inserted = opts?.inserted ?? {
    id: COMM_ID,
    practiceId: PRACTICE_ID,
    clientId: CLIENT_ID,
    status: "pending",
  };
  const updated =
    opts && "updated" in opts ? opts.updated : { ...inserted, status: "sent" };
  const selectResults = opts?.selectResults ?? [
    [client].filter(Boolean),
    [practice].filter(Boolean),
    [conversationAssignment].filter(Boolean),
    [smsSender].filter(Boolean),
  ];

  const selectLimit = vi.fn(async () => selectResults.shift() ?? []);
  const selectFor = vi.fn(() => ({ limit: selectLimit }));
  const selectOrderBy = vi.fn(() => ({ limit: selectLimit }));
  const selectWhere = vi.fn(() => ({
    limit: selectLimit,
    orderBy: selectOrderBy,
    for: selectFor,
  }));
  const selectInnerJoin = vi.fn(() => ({ where: selectWhere }));
  const selectLeftJoin = vi.fn(() => ({
    innerJoin: selectInnerJoin,
    leftJoin: selectLeftJoin,
    where: selectWhere,
  }));
  const selectFrom = vi.fn(() => ({
    innerJoin: selectInnerJoin,
    leftJoin: selectLeftJoin,
    where: selectWhere,
  }));
  const select = vi.fn(() => ({ from: selectFrom }));

  const insertReturning = vi.fn(async () =>
    opts?.insertResults ? (opts.insertResults.shift() ?? []) : [inserted],
  );
  const insertOnConflict = vi.fn(() => ({ returning: insertReturning }));
  const insertValues = vi.fn(() => ({
    returning: insertReturning,
    onConflictDoNothing: insertOnConflict,
  }));
  const insert = vi.fn(() => ({ values: insertValues }));

  const updateReturning = vi.fn(async () => (updated ? [updated] : []));
  const updateWhere = vi.fn((_condition: unknown) => ({
    returning: updateReturning,
  }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    execute: vi.fn(async () => undefined),
    select,
    insert,
    update,
  };

  return { db, select, insertValues, updateSet, updateWhere };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("communications.create delivery", () => {
  it("requires an active practice before inbox communication creation", () => {
    const createBlock = routerSource.slice(
      routerSource.indexOf("create: inboxStaffProcedure"),
      routerSource.indexOf(
        "updateStatus:",
        routerSource.indexOf("create: inboxStaffProcedure"),
      ),
    );

    expect(createBlock).toMatch(
      /select\(\{\s*name: practices\.name,\s*timezone: practices\.timezone,\s*email: practices\.email,\s*\}\)[\s\S]+?where\(activePracticeWhere\(ctx\.practiceId\)\)/s,
    );
    expect(createBlock).toContain("if (!practice)");
    expect(createBlock).toContain("throw practiceNotFound()");
    expect(createBlock).toContain(
      "sql`${emailSuppressions.email} = lower(trim(${clients.email}))`",
    );
    expect(createBlock).toContain("hasNonBlankMessagingSender()");
    expect(createBlock).not.toContain(
      "isNotNull(locationMessaging.senderE164)",
    );
    expect(createBlock).not.toContain(
      "isNotNull(locationMessaging.messagingProfileId)",
    );
    expect(createBlock).not.toContain(': [{ name: "OpenVPM"');
    expect(createBlock).not.toContain("practice?.name");
    expect(createBlock).not.toContain("practice?.email");
    expect(createBlock).not.toContain("practice?.timezone");
  });

  it("restricts outbound compose to non-viewer inbox staff roles", async () => {
    const { db, select, insertValues, updateSet } = createDb();

    await expect(
      callerWithDb(db, "viewer").create({
        clientId: CLIENT_ID,
        channel: "email",
        direction: "outbound",
        content: "Hello",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.sendSms).not.toHaveBeenCalled();
  });

  it("rejects oversized compose content before DB work", async () => {
    const { db, select, insertValues, updateSet } = createDb();

    await expect(
      callerWithDb(db).create({
        clientId: CLIENT_ID,
        channel: "email",
        direction: "outbound",
        subject: "A".repeat(COMMUNICATION_SUBJECT_MAX_LENGTH + 1),
        content: "Hello",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).create({
        clientId: CLIENT_ID,
        channel: "email",
        direction: "outbound",
        content: "A".repeat(COMMUNICATION_CONTENT_MAX_LENGTH + 1),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).create({
        clientId: CLIENT_ID,
        channel: "sms",
        direction: "outbound",
        content: "A".repeat(SMS_COMMUNICATION_CONTENT_MAX_LENGTH + 1),
        requestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.sendSms).not.toHaveBeenCalled();
  });

  it("delivers outbound portal messages internally without provider transport", async () => {
    const { db, insertValues, updateSet } = createDb({
      inserted: {
        id: COMM_ID,
        practiceId: PRACTICE_ID,
        clientId: CLIENT_ID,
        channel: "portal",
        direction: "outbound",
        status: "delivered",
      },
    });

    await expect(
      callerWithDb(db).create({
        clientId: CLIENT_ID,
        channel: "portal",
        direction: "outbound",
        content: "See your estimate in the portal.",
      }),
    ).resolves.toMatchObject({ status: "delivered" });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        clientId: CLIENT_ID,
        channel: "portal",
        direction: "outbound",
        content: "See your estimate in the portal.",
        status: "delivered",
      }),
    );
    expect(updateSet).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.sendSms).not.toHaveBeenCalled();
  });

  it("sends outbound email before marking the communication sent", async () => {
    mocks.sendEmail.mockResolvedValue({ success: true, id: "email-1" });
    const { db, insertValues, updateSet } = createDb();

    await expect(
      callerWithDb(db).create({
        clientId: CLIENT_ID,
        channel: "email",
        direction: "outbound",
        subject: "Follow up",
        content: "Hello\n<script>",
      }),
    ).resolves.toMatchObject({ status: "sent" });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        clientId: CLIENT_ID,
        channel: "email",
        direction: "outbound",
        subject: "Follow up",
        content: "Hello\n<script>",
        assignedTo: USER_ID,
        status: "pending",
      }),
    );
    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "ada@example.com",
        subject: "Follow up",
        replyTo: "clinic@example.com",
        html: expect.stringContaining("Hello<br />&lt;script&gt;"),
      }),
    );
    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        html: expect.stringContaining(
          "Email replies are not imported into OpenVPM yet.",
        ),
      }),
    );
    expect(updateSet).toHaveBeenCalledWith({
      status: "sent",
      providerMessageId: "email-1",
    });
  });

  it("preserves an existing conversation assignment when composing a reply", async () => {
    mocks.sendEmail.mockResolvedValue({ success: true, id: "email-1" });
    const { db, insertValues } = createDb({
      conversationAssignment: { assignedTo: OTHER_USER_ID },
    });

    await expect(
      callerWithDb(db).create({
        clientId: CLIENT_ID,
        channel: "email",
        direction: "outbound",
        subject: "Follow up",
        content: "Hello",
      }),
    ).resolves.toMatchObject({ status: "sent" });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        clientId: CLIENT_ID,
        channel: "email",
        direction: "outbound",
        assignedTo: OTHER_USER_ID,
        status: "pending",
      }),
    );
  });

  it("normalizes legacy padded client emails before outbound delivery", async () => {
    mocks.sendEmail.mockResolvedValue({ success: true, id: "email-1" });
    const { db } = createDb({
      client: {
        id: CLIENT_ID,
        firstName: "Ada",
        lastName: "Lovelace",
        email: " Ada@Example.COM ",
        phone: "(555) 555-0100",
        smsConsent: true,
      },
    });

    await expect(
      callerWithDb(db).create({
        clientId: CLIENT_ID,
        channel: "email",
        direction: "outbound",
        subject: "Follow up",
        content: "Hello",
      }),
    ).resolves.toMatchObject({ status: "sent" });

    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "ada@example.com",
      }),
    );
  });

  it("omits invalid practice reply-to emails without blocking delivery", async () => {
    mocks.sendEmail.mockResolvedValue({ success: true, id: "email-1" });
    const { db } = createDb({
      practice: {
        name: "Neighborhood Veterinary",
        timezone: "America/New_York",
        email: "not an email",
      },
    });

    await expect(
      callerWithDb(db).create({
        clientId: CLIENT_ID,
        channel: "email",
        direction: "outbound",
        subject: "Follow up",
        content: "Hello",
      }),
    ).resolves.toMatchObject({ status: "sent" });

    const [sendArgs] = mocks.sendEmail.mock.calls[0] ?? [];
    expect(sendArgs).not.toHaveProperty("replyTo");
    expect(sendArgs).toMatchObject({
      html: expect.stringContaining(
        "Please contact Neighborhood Veterinary directly",
      ),
    });
  });

  it("blocks outbound email to provider-suppressed recipients before creating a row", async () => {
    const { db, insertValues, updateSet } = createDb({
      client: {
        id: CLIENT_ID,
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
        phone: "(555) 555-0100",
        smsConsent: true,
        emailSuppressionReason: "bounce",
      },
    });

    await expect(
      callerWithDb(db).create({
        clientId: CLIENT_ID,
        channel: "email",
        direction: "outbound",
        subject: "Follow up",
        content: "Hello",
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message:
        "Client email is suppressed after a delivery bounce. Update the client email before sending.",
    });

    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("blocks external delivery when the practice is no longer active", async () => {
    const { db, insertValues, updateSet } = createDb({ practice: null });

    await expect(
      callerWithDb(db).create({
        clientId: CLIENT_ID,
        channel: "email",
        direction: "outbound",
        subject: "Follow up",
        content: "Hello",
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.sendSms).not.toHaveBeenCalled();
  });

  it("blocks internal portal communication rows when the practice is no longer active", async () => {
    const { db, insertValues, updateSet } = createDb({ practice: null });

    await expect(
      callerWithDb(db).create({
        clientId: CLIENT_ID,
        channel: "portal",
        direction: "outbound",
        content: "See your estimate in the portal.",
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.sendSms).not.toHaveBeenCalled();
  });

  it("claims pending delivery status before marking outbound messages sent", async () => {
    mocks.sendEmail.mockResolvedValue({ success: true, id: "email-1" });
    const { db, updateWhere } = createDb();

    await expect(
      callerWithDb(db).create({
        clientId: CLIENT_ID,
        channel: "email",
        direction: "outbound",
        subject: "Follow up",
        content: "Hello",
      }),
    ).resolves.toMatchObject({ status: "sent" });

    const condition = updateWhere.mock.calls[0]?.[0];
    expect(sqlIncludesValue(condition, "pending")).toBe(true);
    expect(sqlIncludesColumnName(condition, "deleted_at")).toBe(true);
  });

  it("sends consented SMS to the normalized client phone outside quiet hours", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T18:00:00Z")); // 1pm America/New_York
    mocks.sendSms.mockResolvedValue({ success: true, sid: "sms-1" });
    const { db, updateSet } = createDb();

    await expect(
      callerWithDb(db).create({
        clientId: CLIENT_ID,
        channel: "sms",
        direction: "outbound",
        content: "Your refill is ready.",
        requestId: REQUEST_ID,
      }),
    ).resolves.toMatchObject({ status: "sent" });

    expect(mocks.sendSms).toHaveBeenCalledWith({
      to: "+15555550100",
      body: "Your refill is ready.",
      practiceId: PRACTICE_ID,
      locationId: LOCATION_ID,
      clientId: CLIENT_ID,
      communicationId: COMM_ID,
      source: "inbox",
      sourceId: REQUEST_ID,
      idempotencyKey: `sms:inbox:${PRACTICE_ID}:${REQUEST_ID}`,
    });
    expect(updateSet).toHaveBeenCalledWith({
      status: "sent",
      providerMessageId: "sms-1",
    });
    expect(mocks.withDurableSmsCommunication).toHaveBeenCalledTimes(2);
  });

  it("reuses one durable inbox request after a lost response", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T18:00:00Z"));
    mocks.sendSms.mockResolvedValue({ success: true, sid: "sms-1" });
    const client = {
      id: CLIENT_ID,
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
      phone: "(555) 555-0100",
      smsConsent: true,
    };
    const practice = {
      name: "Neighborhood Veterinary",
      timezone: "America/New_York",
      email: "clinic@example.com",
    };
    const pending = {
      id: COMM_ID,
      practiceId: PRACTICE_ID,
      clientId: CLIENT_ID,
      channel: "sms",
      direction: "outbound",
      subject: null,
      content: "Your refill is ready.",
      status: "pending",
    };
    const sent = { ...pending, status: "sent", providerMessageId: "sms-1" };
    const { db, insertValues } = createDb({
      inserted: pending,
      updated: sent,
      insertResults: [[pending], []],
      selectResults: [
        [client],
        [practice],
        [],
        [{ locationId: LOCATION_ID }],
        [client],
        [practice],
        [],
        [{ locationId: LOCATION_ID }],
        [sent],
      ],
    });
    const caller = callerWithDb(db);
    const input = {
      clientId: CLIENT_ID,
      channel: "sms" as const,
      direction: "outbound" as const,
      content: "Your refill is ready.",
      requestId: REQUEST_ID,
    };

    await expect(caller.create(input)).resolves.toMatchObject({
      status: "sent",
    });
    await expect(caller.create(input)).resolves.toMatchObject({
      status: "sent",
    });

    expect(mocks.sendSms).toHaveBeenCalledOnce();
    expect(insertValues).toHaveBeenCalledTimes(2);
    expect(mocks.sendSms).toHaveBeenCalledWith(
      expect.objectContaining({
        communicationId: COMM_ID,
        sourceId: REQUEST_ID,
        idempotencyKey: `sms:inbox:${PRACTICE_ID}:${REQUEST_ID}`,
      }),
    );
  });

  it("blocks SMS when the practice has no active texting sender", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T18:00:00Z")); // 1pm America/New_York
    const { db, insertValues } = createDb({ smsSender: null });

    await expect(
      callerWithDb(db).create({
        clientId: CLIENT_ID,
        channel: "sms",
        direction: "outbound",
        content: "Your refill is ready.",
        requestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(mocks.sendSms).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("blocks SMS during quiet hours without creating a fake sent row", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-16T02:30:00Z")); // 9:30pm America/New_York
    const { db, insertValues } = createDb();

    await expect(
      callerWithDb(db).create({
        clientId: CLIENT_ID,
        channel: "sms",
        direction: "outbound",
        content: "Late reminder",
        requestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(mocks.sendSms).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("marks the row failed when transport returns a send error", async () => {
    mocks.sendEmail.mockResolvedValue({ success: false, error: "Resend down" });
    const { db, updateSet } = createDb({
      updated: { id: COMM_ID, status: "failed" },
    });

    await expect(
      callerWithDb(db).create({
        clientId: CLIENT_ID,
        channel: "email",
        direction: "outbound",
        content: "Hello",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(updateSet).toHaveBeenCalledWith({ status: "failed" });
  });

  it("does not return a fake sent row when delivery status cannot be saved", async () => {
    mocks.sendEmail.mockResolvedValue({ success: true, id: "email-1" });
    const { db, updateSet } = createDb({ updated: null });

    await expect(
      callerWithDb(db).create({
        clientId: CLIENT_ID,
        channel: "email",
        direction: "outbound",
        subject: "Follow up",
        content: "Hello",
      }),
    ).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message:
        "Message was delivered, but the inbox status could not be updated. Refresh before sending again.",
    });

    expect(updateSet).toHaveBeenCalledWith({
      status: "sent",
      providerMessageId: "email-1",
    });
    expect(mocks.alertOps).toHaveBeenCalledWith(
      "Communication delivery status update failed",
      expect.stringContaining(`communication=${COMM_ID}`),
    );
  });

  it("marks the row failed when email transport throws", async () => {
    mocks.sendEmail.mockRejectedValue(new Error("Resend timed out"));
    const { db, updateSet } = createDb({
      updated: { id: COMM_ID, status: "failed" },
    });

    await expect(
      callerWithDb(db).create({
        clientId: CLIENT_ID,
        channel: "email",
        direction: "outbound",
        content: "Hello",
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Resend timed out",
    });

    expect(updateSet).toHaveBeenCalledWith({ status: "failed" });
  });

  it("keeps the row pending when SMS transport throws ambiguously", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T18:00:00Z")); // 1pm America/New_York
    mocks.sendSms.mockRejectedValue(new Error("Telnyx timed out"));
    const { db, updateSet } = createDb({
      updated: { id: COMM_ID, status: "failed" },
    });

    await expect(
      callerWithDb(db).create({
        clientId: CLIENT_ID,
        channel: "sms",
        direction: "outbound",
        content: "Your refill is ready.",
        requestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("provider outcome is unknown"),
    });

    expect(updateSet).not.toHaveBeenCalled();
  });
});
