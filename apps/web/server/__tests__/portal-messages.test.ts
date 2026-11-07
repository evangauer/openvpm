import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rateLimit: vi.fn(async () => ({
    success: true,
    remaining: 4,
    resetAt: new Date(),
  })),
  billingEnforced: vi.fn(() => false),
  hasHostedFullAccess: vi.fn(() => true),
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: mocks.rateLimit,
}));

vi.mock("@/lib/webhook-dispatcher", () => ({
  dispatchWebhookEvent: vi.fn(async () => undefined),
}));

vi.mock("@/lib/billing/plans", () => ({
  billingEnforced: mocks.billingEnforced,
  hasHostedFullAccess: mocks.hasHostedFullAccess,
}));

const { portalRouter } = await import("../routers/portal");
const { COMMUNICATION_CONTENT_MAX_LENGTH } = await import(
  "@/lib/communications/policy"
);

const TOKEN = "portal-token";
const MESSAGE_TOKEN_BUCKET =
  "portal-message:token:0ba11c8c03cc892e40cac090ac14c4db6e655ecfaff2490257fbe4c10fba19f9";
const READ_TOKEN_BUCKET =
  "portal-read:token:0ba11c8c03cc892e40cac090ac14c4db6e655ecfaff2490257fbe4c10fba19f9";
const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const CLIENT_ID = "00000000-0000-0000-0000-0000000000bb";
const MESSAGE_ID = "00000000-0000-0000-0000-000000000001";
const ACTIVE_PRACTICE = [{ id: PRACTICE_ID }];

function callerWithDb(db: Record<string, unknown>, ip?: string) {
  return portalRouter.createCaller({
    db,
    ip,
    portalSessionId: TOKEN,
    portalClient: {
      id: CLIENT_ID,
      practiceId: PRACTICE_ID,
      firstName: "Portal",
      lastName: "Client",
      email: "portal@example.test",
      phone: null,
    },
  } as never);
}

function createDb(opts?: {
  selectResults?: unknown[][];
  insertedRows?: unknown[];
  updatedRows?: unknown[];
}) {
  const selectResults = [...(opts?.selectResults ?? [])];
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
      where: vi.fn(() => afterWhere),
      orderBy: vi.fn(async () => result),
      limit: vi.fn(async () => result),
    };
    return builder;
  });
  const insertReturning = vi.fn(async () => opts?.insertedRows ?? []);
  const insertValues = vi.fn(() => ({ returning: insertReturning }));
  const insert = vi.fn(() => ({ values: insertValues }));
  const updateReturning = vi.fn(async () => opts?.updatedRows ?? []);
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));
  const db: Record<string, unknown> = {
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
    execute: vi.fn(async () => undefined),
    select,
    insert,
    update,
  };
  return { db, select, insert, insertValues, updateSet, updateWhere };
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
  vi.clearAllMocks();
  mocks.billingEnforced.mockReturnValue(false);
  mocks.hasHostedFullAccess.mockReturnValue(true);
});

describe("portal messages", () => {
  it("rejects invalid message input before rate limits or DB work", async () => {
    const { db, select, insert } = createDb();

    await expect(
      callerWithDb(db).createMessage({
        token: TOKEN,
        content: "   ",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).createMessage({
        token: TOKEN,
        content: "A".repeat(COMMUNICATION_CONTENT_MAX_LENGTH + 1),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("rate-limits unresolved-IP portal message sends before token or DB work", async () => {
    mocks.rateLimit.mockResolvedValueOnce({
      success: false,
      remaining: 0,
      resetAt: new Date("2026-07-01T13:00:00Z"),
    });
    const { db, select, insert } = createDb();

    await expect(
      callerWithDb(db).createMessage({
        token: TOKEN,
        content: "Can you call me?",
      })
    ).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
      message:
        "Too many portal messages. Please try again later or call the clinic.",
    });

    expect(mocks.rateLimit).toHaveBeenCalledWith({
      key: "portal-message:ip:unknown",
      limit: 30,
      windowMs: 60 * 60 * 1000,
    });
    expect(select).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("fails closed when the portal message limiter is unavailable", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mocks.rateLimit.mockRejectedValueOnce(new Error("rate limiter down"));
    const { db, select, insert } = createDb();

    try {
      await expect(
        callerWithDb(db).createMessage({
          token: TOKEN,
          content: "Can you call me?",
        })
      ).rejects.toMatchObject({
        code: "TOO_MANY_REQUESTS",
        message:
          "Too many portal messages. Please try again later or call the clinic.",
      });

      expect(consoleError).toHaveBeenCalledWith(
        "[portal] rate limit failed:",
        expect.any(Error)
      );
      expect(mocks.rateLimit).toHaveBeenCalledWith({
        key: "portal-message:ip:unknown",
        limit: 30,
        windowMs: 60 * 60 * 1000,
      });
      expect(select).not.toHaveBeenCalled();
      expect(insert).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("rate-limits portal message tokens after IP fallback passes", async () => {
    mocks.rateLimit
      .mockResolvedValueOnce({
        success: true,
        remaining: 29,
        resetAt: new Date("2026-07-01T13:00:00Z"),
      })
      .mockResolvedValueOnce({
        success: false,
        remaining: 0,
        resetAt: new Date("2026-07-01T13:00:00Z"),
      });
    const { db, select, insert } = createDb();

    await expect(
      callerWithDb(db).createMessage({
        token: TOKEN,
        content: "Can you call me?",
      })
    ).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
      message:
        "Too many portal messages. Please try again later or call the clinic.",
    });

    expect(mocks.rateLimit).toHaveBeenNthCalledWith(2, {
      key: MESSAGE_TOKEN_BUCKET,
      limit: 10,
      windowMs: 60 * 60 * 1000,
    });
    expect(select).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("lists portal messages for the token client with the practice timezone", async () => {
    const { db } = createDb({
      selectResults: [
        [
          {
            id: CLIENT_ID,
            practiceId: PRACTICE_ID,
          },
        ],
        ACTIVE_PRACTICE,
        [{ timezone: "America/New_York" }],
        [
          {
            id: MESSAGE_ID,
            direction: "outbound",
            subject: "Follow up",
            content: "Please review your discharge notes.",
            status: "delivered",
            createdAt: new Date("2026-07-01T14:00:00Z"),
          },
        ],
      ],
    });

    await expect(callerWithDb(db).getMessages({ token: TOKEN })).resolves.toEqual({
      timezone: "America/New_York",
      items: [
        expect.objectContaining({
          id: MESSAGE_ID,
          direction: "outbound",
          status: "delivered",
        }),
      ],
    });
  });

  it("creates an inbound portal communication for the token client", async () => {
    const { db, insertValues } = createDb({
      selectResults: [
        [
          {
            id: CLIENT_ID,
            practiceId: PRACTICE_ID,
            firstName: "Ada",
            lastName: "Lovelace",
          },
        ],
        ACTIVE_PRACTICE,
        ACTIVE_PRACTICE,
      ],
      insertedRows: [
        {
          id: MESSAGE_ID,
          direction: "inbound",
          subject: "Portal message from Ada Lovelace",
          content: "Can you call me?",
          status: "pending",
          createdAt: new Date("2026-07-01T14:00:00Z"),
        },
      ],
    });

    await expect(
      callerWithDb(db).createMessage({
        token: TOKEN,
        content: "Can you call me?",
      })
    ).resolves.toMatchObject({
      success: true,
      message: {
        id: MESSAGE_ID,
        direction: "inbound",
        status: "pending",
      },
    });

    expect(mocks.rateLimit).toHaveBeenNthCalledWith(2, {
      key: MESSAGE_TOKEN_BUCKET,
      limit: 10,
      windowMs: 60 * 60 * 1000,
    });
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        clientId: CLIENT_ID,
        channel: "portal",
        direction: "inbound",
        subject: "Portal message from Ada Lovelace",
        content: "Can you call me?",
        status: "pending",
      })
    );
    const messageInsert = (insertValues.mock.calls[0] as unknown as [
      { assignedTo?: unknown },
    ])[0];
    expect(messageInsert.assignedTo).toBeTruthy();
    expect(sqlIncludesColumnName(messageInsert.assignedTo, "assigned_to")).toBe(
      true
    );
    expect(sqlIncludesColumnName(messageInsert.assignedTo, "client_id")).toBe(
      true
    );
    expect(sqlIncludesValue(messageInsert.assignedTo, PRACTICE_ID)).toBe(true);
    expect(sqlIncludesValue(messageInsert.assignedTo, CLIENT_ID)).toBe(true);
  });

  it("rejects portal messages when the practice becomes inactive before the write", async () => {
    const { db, insert } = createDb({
      selectResults: [
        [
          {
            id: CLIENT_ID,
            practiceId: PRACTICE_ID,
            firstName: "Ada",
            lastName: "Lovelace",
          },
        ],
        ACTIVE_PRACTICE,
        [],
      ],
    });

    await expect(
      callerWithDb(db).createMessage({
        token: TOKEN,
        content: "Can you call me?",
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Invalid portal link",
    });

    expect(insert).not.toHaveBeenCalled();
  });

  it("rejects portal messages when the token client's practice is inactive", async () => {
    const { db, insert } = createDb({
      selectResults: [
        [
          {
            id: CLIENT_ID,
            practiceId: PRACTICE_ID,
            firstName: "Ada",
            lastName: "Lovelace",
          },
        ],
        [],
      ],
    });

    await expect(
      callerWithDb(db).createMessage({
        token: TOKEN,
        content: "Can you call me?",
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Invalid portal link",
    });

    expect(insert).not.toHaveBeenCalled();
  });

  it("uses a messaging-specific error when hosted billing gates portal messages", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    mocks.hasHostedFullAccess.mockReturnValue(false);
    const { db, insert } = createDb({
      selectResults: [
        [
          {
            id: CLIENT_ID,
            practiceId: PRACTICE_ID,
            firstName: "Ada",
            lastName: "Lovelace",
          },
        ],
        ACTIVE_PRACTICE,
        [{ tier: "free", billingStatus: "past_due", trialEndsAt: null }],
      ],
    });

    await expect(
      callerWithDb(db).createMessage({
        token: TOKEN,
        content: "Can you call me?",
      })
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message:
        "Portal messaging is unavailable until this practice's Cloud subscription is active.",
    });

    expect(insert).not.toHaveBeenCalled();
    expect(mocks.hasHostedFullAccess).toHaveBeenCalledWith(
      "free",
      "past_due",
      null
    );
  });

  it("marks outbound portal messages read for the token client", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [
          {
            id: CLIENT_ID,
            practiceId: PRACTICE_ID,
          },
        ],
        ACTIVE_PRACTICE,
      ],
      updatedRows: [{ id: MESSAGE_ID }],
    });

    await expect(
      callerWithDb(db).markMessagesRead({ token: TOKEN })
    ).resolves.toEqual({
      success: true,
      updated: 1,
    });

    expect(mocks.rateLimit).toHaveBeenNthCalledWith(1, {
      key: "portal-read:ip:unknown",
      limit: 300,
      windowMs: 15 * 60 * 1000,
    });
    expect(mocks.rateLimit).toHaveBeenNthCalledWith(2, {
      key: READ_TOKEN_BUCKET,
      limit: 120,
      windowMs: 15 * 60 * 1000,
    });
    expect(updateSet).toHaveBeenCalledWith({
      status: "read",
      readAt: expect.any(Date),
    });
  });

  it("scopes portal read receipts to active outbound portal rows", () => {
    const source = readFileSync("server/routers/portal.ts", "utf8");
    const block = source.slice(
      source.indexOf("markMessagesRead: portalProcedure"),
      source.indexOf("getInvoices: portalProcedure")
    );

    expect(block).toContain("eq(communications.clientId, client.id)");
    expect(block).toContain("eq(communications.practiceId, client.practiceId)");
    expect(block).toContain('eq(communications.channel, "portal")');
    expect(block).toContain('eq(communications.direction, "outbound")');
    expect(block).toContain("isNull(communications.readAt)");
    expect(block).toContain('ne(communications.status, "read")');
    expect(block).toContain("isNull(communications.deletedAt)");
  });
});
