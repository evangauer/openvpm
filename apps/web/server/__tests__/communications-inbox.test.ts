import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recordAuditLog: vi.fn(async () => undefined),
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: mocks.recordAuditLog,
}));

const { communicationsRouter } = await import("../routers/communications");
const { LIST_OFFSET_MAX } = await import("../routers/pagination");
const { clients, communications, practices, users } = await import(
  "@openpims/db"
);

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const OTHER_USER_ID = "00000000-0000-0000-0000-000000000009";
const CLIENT_ID = "00000000-0000-0000-0000-000000000002";
const COMM_ID = "00000000-0000-0000-0000-000000000003";

function callerWithDb(db: Record<string, unknown>, role = "front_desk") {
  const session = {
    user: {
      id: USER_ID,
      email: `${role}@example.com`,
      name: role === "front_desk" ? "Front Desk" : "Inbox User",
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
    sqlIncludesColumnName(item, columnName)
  );
}

function sqlIncludesColumn(
  value: unknown,
  column: unknown,
  seen = new WeakSet<object>()
): boolean {
  if (Object.is(value, column)) {
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
    return value.some((item) => sqlIncludesColumn(item, column, seen));
  }

  const candidate = value as { queryChunks?: unknown[] };
  if (!Array.isArray(candidate.queryChunks)) {
    return false;
  }

  return candidate.queryChunks.some((item) =>
    sqlIncludesColumn(item, column, seen)
  );
}

function sqlIncludesValue(
  value: unknown,
  needle: unknown,
  seen = new WeakSet<object>()
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
      sqlIncludesValue(item, needle, seen)
    );
  }

  return Object.values(value as Record<string, unknown>).some((item) =>
    sqlIncludesValue(item, needle, seen)
  );
}

function createListDb() {
  const itemOffset = vi.fn(async () => []);
  const itemLimit = vi.fn(() => ({ offset: itemOffset }));
  const itemOrderBy = vi.fn(() => ({ limit: itemLimit }));
  const itemWhere = vi.fn((_condition: unknown) => ({
    orderBy: itemOrderBy,
  }));
  const itemChain: {
    leftJoin: ReturnType<typeof vi.fn>;
    where: ReturnType<typeof vi.fn>;
  } = {
    leftJoin: vi.fn((_table: unknown, _condition: unknown) => itemChain),
    where: itemWhere,
  };

  const countWhere = vi.fn(async (_condition: unknown) => [{ count: 0 }]);
  const countChain: {
    leftJoin: ReturnType<typeof vi.fn>;
    where: ReturnType<typeof vi.fn>;
  } = {
    leftJoin: vi.fn((_table: unknown, _condition: unknown) => countChain),
    where: countWhere,
  };

  const from = vi
    .fn()
    .mockReturnValueOnce(itemChain)
    .mockReturnValueOnce(countChain);
  const select = vi.fn(() => ({ from }));
  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    execute: vi.fn(async () => undefined),
    select,
  };

  return {
    db,
    itemLeftJoin: itemChain.leftJoin,
    itemWhere,
    countLeftJoin: countChain.leftJoin,
    countWhere,
  };
}

function createTimelineDb() {
  const orderBy = vi.fn(async () => []);
  const where = vi.fn((_condition: unknown) => ({ orderBy }));
  const leftJoin = vi.fn((_table: unknown, _condition: unknown) => ({
    where,
  }));
  const innerJoin = vi.fn((_table: unknown, _condition: unknown) => ({
    leftJoin,
  }));
  const from = vi.fn(() => ({ innerJoin }));
  const select = vi.fn(() => ({ from }));
  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    execute: vi.fn(async () => undefined),
    select,
  };

  return { db, innerJoin, leftJoin };
}

function createSettingsDb(result = [{ timezone: "America/Los_Angeles" }]) {
  const limit = vi.fn(async () => result);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    execute: vi.fn(async () => undefined),
    select,
  };

  return { db, select };
}

function createConversationListDb(rows: Record<string, unknown>[] = []) {
  const execute = vi.fn(async (_query: unknown) => rows);
  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    execute,
  };

  return { db, execute };
}

function createMutationDb(opts?: {
  client?: Record<string, unknown> | null;
  selectResults?: Record<string, unknown>[][];
  updated?: Record<string, unknown>[];
}) {
  const client = opts && "client" in opts ? opts.client : { id: CLIENT_ID };
  const updated = opts?.updated ?? [{ id: COMM_ID }];
  const selectResults =
    opts?.selectResults ?? [[client].filter(Boolean)];

  const selectLimit = vi.fn(async () => selectResults.shift() ?? []);
  const selectOrderBy = vi.fn(() => ({ limit: selectLimit }));
  const selectWhere = vi.fn(() => ({
    limit: selectLimit,
    orderBy: selectOrderBy,
  }));
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));

  const updateReturning = vi.fn(async () => updated);
  const updateWhere = vi.fn((_condition: unknown) => ({
    returning: updateReturning,
  }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  const execute = vi.fn(async () => undefined);
  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    execute,
    select,
    update,
  };

  return { db, execute, select, updateSet, updateWhere };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("communications inbox workflows", () => {
  it("restricts inbox state writes to non-viewer staff roles", async () => {
    const { db, execute, select, updateSet } = createMutationDb();
    const viewer = callerWithDb(db, "viewer");

    await expect(
      viewer.markClientRead({ clientId: CLIENT_ID })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      viewer.assignClient({
        clientId: CLIENT_ID,
        action: "assign_to_me",
        expectedAssignedTo: null,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      viewer.linkCommunicationToClient({
        communicationId: COMM_ID,
        clientId: CLIENT_ID,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      viewer.updateStatus({ id: COMM_ID, status: "read" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(execute).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("returns the active practice timezone for Inbox timestamp rendering", async () => {
    const { db, select } = createSettingsDb();

    await expect(callerWithDb(db).settings()).resolves.toEqual({
      timezone: "America/Los_Angeles",
    });

    expect(select).toHaveBeenCalledTimes(1);
  });

  it("rejects missing or deleted practice settings before rendering Inbox timestamps", async () => {
    const { db } = createSettingsDb([]);

    await expect(callerWithDb(db).settings()).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });
  });

  it("rejects fractional list pagination before querying", async () => {
    const { db, itemWhere, countWhere } = createListDb();

    await expect(
      callerWithDb(db).list({ limit: 1.5, offset: 0 })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).list({ limit: 25, offset: 0.5 })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).list({ limit: 25, offset: LIST_OFFSET_MAX + 1 })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(itemWhere).not.toHaveBeenCalled();
    expect(countWhere).not.toHaveBeenCalled();
  });

  it("filters deleted client conversations from list items and totals", async () => {
    const {
      db,
      itemLeftJoin,
      itemWhere,
      countLeftJoin,
      countWhere,
    } = createListDb();

    await expect(
      callerWithDb(db).list({ limit: 25, offset: 0 })
    ).resolves.toEqual({ items: [], total: 0 });

    expect(itemLeftJoin.mock.calls[0]?.[0]).toBe(clients);
    expect(countLeftJoin.mock.calls[0]?.[0]).toBe(clients);
    expect(itemLeftJoin.mock.calls[1]?.[0]).toBe(users);

    const itemClientJoinCondition = itemLeftJoin.mock.calls[0]?.[1];
    const itemUserJoinCondition = itemLeftJoin.mock.calls[1]?.[1];
    const countClientJoinCondition = countLeftJoin.mock.calls[0]?.[1];
    expect(sqlIncludesColumn(itemClientJoinCondition, clients.practiceId)).toBe(
      true
    );
    expect(sqlIncludesColumn(itemClientJoinCondition, clients.deletedAt)).toBe(
      true
    );
    expect(sqlIncludesColumn(itemUserJoinCondition, users.practiceId)).toBe(
      true
    );
    expect(sqlIncludesColumn(itemUserJoinCondition, users.deletedAt)).toBe(
      true
    );
    expect(sqlIncludesColumn(itemUserJoinCondition, practices.deletedAt)).toBe(
      true
    );
    expect(sqlIncludesColumn(countClientJoinCondition, clients.practiceId)).toBe(
      true
    );
    expect(sqlIncludesColumn(countClientJoinCondition, clients.deletedAt)).toBe(
      true
    );
    expect(sqlIncludesColumn(countClientJoinCondition, practices.deletedAt)).toBe(
      true
    );

    const itemCondition = itemWhere.mock.calls[0]?.[0];
    const countCondition = countWhere.mock.calls[0]?.[0];
    expect(sqlIncludesColumn(itemCondition, clients.deletedAt)).toBe(true);
    expect(sqlIncludesColumn(itemCondition, practices.deletedAt)).toBe(true);
    expect(sqlIncludesColumn(countCondition, clients.deletedAt)).toBe(true);
    expect(sqlIncludesColumn(countCondition, practices.deletedAt)).toBe(true);
    expect(sqlIncludesColumn(itemCondition, communications.clientId)).toBe(
      true
    );
    expect(sqlIncludesColumn(countCondition, communications.clientId)).toBe(
      true
    );
  });

  it("requires client timeline reads to join an active tenant client", async () => {
    const { db, innerJoin, leftJoin } = createTimelineDb();

    await expect(
      callerWithDb(db).getByClient({ clientId: CLIENT_ID })
    ).resolves.toEqual([]);

    expect(innerJoin.mock.calls[0]?.[0]).toBe(clients);
    const joinCondition = innerJoin.mock.calls[0]?.[1];
    expect(sqlIncludesColumn(joinCondition, clients.practiceId)).toBe(true);
    expect(sqlIncludesColumn(joinCondition, clients.deletedAt)).toBe(true);
    expect(sqlIncludesColumn(joinCondition, practices.deletedAt)).toBe(true);

    expect(leftJoin.mock.calls[0]?.[0]).toBe(users);
    const userJoinCondition = leftJoin.mock.calls[0]?.[1];
    expect(sqlIncludesColumn(userJoinCondition, users.practiceId)).toBe(true);
    expect(sqlIncludesColumn(userJoinCondition, users.deletedAt)).toBe(true);
    expect(sqlIncludesColumn(userJoinCondition, practices.deletedAt)).toBe(true);
  });

  it("keeps delivered and read outbound messages in the sent filter", async () => {
    const { db, itemWhere, countWhere } = createListDb();

    await expect(
      callerWithDb(db).list({ inboxFilter: "sent", limit: 25, offset: 0 })
    ).resolves.toEqual({ items: [], total: 0 });

    const itemCondition = itemWhere.mock.calls[0]?.[0];
    const countCondition = countWhere.mock.calls[0]?.[0];
    expect(sqlIncludesColumn(itemCondition, communications.direction)).toBe(
      true
    );
    expect(sqlIncludesColumn(countCondition, communications.direction)).toBe(
      true
    );
    expect(sqlIncludesValue(itemCondition, "outbound")).toBe(true);
    expect(sqlIncludesValue(countCondition, "outbound")).toBe(true);
    expect(sqlIncludesValue(itemCondition, "sent")).toBe(true);
    expect(sqlIncludesValue(countCondition, "sent")).toBe(true);
    expect(sqlIncludesValue(itemCondition, "delivered")).toBe(true);
    expect(sqlIncludesValue(countCondition, "delivered")).toBe(true);
    expect(sqlIncludesValue(itemCondition, "read")).toBe(true);
    expect(sqlIncludesValue(countCondition, "read")).toBe(true);
  });

  it("keeps read outbound conversations in the sent conversation filter", async () => {
    const { db } = createConversationListDb();

    await expect(
      callerWithDb(db).listConversations({
        inboxFilter: "sent",
        limit: 25,
        offset: 0,
      })
    ).resolves.toEqual({ items: [], total: 0 });

    const source = readFileSync("server/routers/communications.ts", "utf8");
    expect(source).toContain(
      "c.status in ('sent', 'delivered', 'read')"
    );
  });

  it("returns server-derived inbox conversation summaries", async () => {
    const createdAt = new Date("2026-06-29T14:00:00.000Z");
    const { db, execute } = createConversationListDb([
      {
        id: COMM_ID,
        clientId: CLIENT_ID,
        channel: "sms",
        direction: "inbound",
        subject: "SMS from +15555550199",
        content: "Please call",
        status: "delivered",
        assignedTo: USER_ID,
        assignedToName: "Front Desk",
        readAt: null,
        providerMessageId: "msg-1",
        createdAt,
        clientFirstName: "Ada",
        clientLastName: "Lovelace",
        unreadCount: "3",
        total: "2",
      },
    ]);

    await expect(
      callerWithDb(db).listConversations({
        inboxFilter: "all",
        limit: 25,
        offset: 0,
      })
    ).resolves.toEqual({
      items: [
        {
          id: COMM_ID,
          clientId: CLIENT_ID,
          channel: "sms",
          direction: "inbound",
          subject: "SMS from +15555550199",
          content: "Please call",
          status: "delivered",
          assignedTo: USER_ID,
          assignedToName: "Front Desk",
          readAt: null,
          providerMessageId: "msg-1",
          createdAt,
          clientFirstName: "Ada",
          clientLastName: "Lovelace",
          unreadCount: 3,
        },
      ],
      total: 2,
    });

    const conversationQuery = execute.mock.calls.find(
      ([query]) => sqlIncludesValue(query, 25) && sqlIncludesValue(query, 0)
    )?.[0];
    expect(conversationQuery).toBeTruthy();
    expect(sqlIncludesValue(conversationQuery, PRACTICE_ID)).toBe(true);
    const source = readFileSync("server/routers/communications.ts", "utf8");
    expect(source).toContain("from practices p");
    expect(source).toContain("p.deleted_at is null");
  });

  it("derives conversation assignees from the latest non-null thread assignment", async () => {
    const { db, execute } = createConversationListDb([]);

    await callerWithDb(db).listConversations({
      inboxFilter: "all",
      limit: 25,
      offset: 0,
    });

    const conversationQuery = execute.mock.calls[0]?.[0];
    expect(conversationQuery).toBeTruthy();
    expect(sqlIncludesValue(conversationQuery, PRACTICE_ID)).toBe(true);

    const source = readFileSync("server/routers/communications.ts", "utf8");
    expect(source).toContain(
      'coalesce(latest_assignment.assigned_to, c.assigned_to) as "assignedTo"'
    );
    expect(source).toContain(
      'coalesce(latest_assignment.assigned_to_name, u.name) as "assignedToName"'
    );
    expect(source).toContain("left join lateral (");
    expect(source).toContain("from communications ca");
    expect(source).toContain("ca.client_id = c.client_id");
    expect(source).toContain("ca.assigned_to is not null");
    expect(source).toContain("order by ca.created_at desc, ca.id desc");
  });

  it("marks inbound client messages read after validating the client", async () => {
    const { db, updateSet, updateWhere } = createMutationDb({
      updated: [{ id: COMM_ID }, { id: "00000000-0000-0000-0000-000000000004" }],
    });

    await expect(
      callerWithDb(db).markClientRead({ clientId: CLIENT_ID })
    ).resolves.toEqual({ ok: true, updated: 2 });

    expect(updateSet).toHaveBeenCalledWith({
      status: "read",
      readAt: expect.any(Date),
    });
    const condition = updateWhere.mock.calls[0]?.[0];
    expect(sqlIncludesColumnName(condition, "deleted_at")).toBe(true);
    expect(sqlIncludesColumn(condition, practices.deletedAt)).toBe(true);
  });

  it("does not mark messages read for a missing or cross-tenant client", async () => {
    const { db, updateSet } = createMutationDb({ client: null });

    await expect(
      callerWithDb(db).markClientRead({ clientId: CLIENT_ID })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("assigns a client conversation to the current staff member", async () => {
    const { db, updateSet, updateWhere } = createMutationDb();

    await expect(
      callerWithDb(db).assignClient({
        clientId: CLIENT_ID,
        action: "assign_to_me",
        expectedAssignedTo: null,
      })
    ).resolves.toMatchObject({
      ok: true,
      assignedTo: USER_ID,
      assignedToName: "Front Desk",
      updated: 1,
    });

    expect(updateSet).toHaveBeenCalledWith({ assignedTo: USER_ID });
    const condition = updateWhere.mock.calls[0]?.[0];
    expect(sqlIncludesColumnName(condition, "deleted_at")).toBe(true);
    expect(sqlIncludesColumn(condition, practices.deletedAt)).toBe(true);
  });

  it("can unassign a client conversation", async () => {
    const { db, updateSet } = createMutationDb({
      selectResults: [[{ id: CLIENT_ID }], [{ assignedTo: USER_ID }]],
    });

    await expect(
      callerWithDb(db).assignClient({
        clientId: CLIENT_ID,
        action: "unassign",
        expectedAssignedTo: USER_ID,
      })
    ).resolves.toMatchObject({
      ok: true,
      assignedTo: null,
      assignedToName: null,
      updated: 1,
    });

    expect(updateSet).toHaveBeenCalledWith({ assignedTo: null });
  });

  it("checks assignment conflicts against the latest non-null assignment", async () => {
    const { db, updateSet } = createMutationDb({
      selectResults: [[{ id: CLIENT_ID }], [{ assignedTo: USER_ID }]],
    });

    await expect(
      callerWithDb(db).assignClient({
        clientId: CLIENT_ID,
        action: "unassign",
        expectedAssignedTo: USER_ID,
      })
    ).resolves.toMatchObject({
      ok: true,
      assignedTo: null,
      assignedToName: null,
      updated: 1,
    });

    expect(updateSet).toHaveBeenCalledWith({ assignedTo: null });

    const source = readFileSync("server/routers/communications.ts", "utf8");
    const assignClientSource = source.slice(
      source.indexOf("assignClient: inboxStaffProcedure"),
      source.indexOf("linkCommunicationToClient: inboxStaffProcedure")
    );
    expect(assignClientSource).toContain("isNotNull(communications.assignedTo)");
    expect(assignClientSource).toContain(
      "orderBy(desc(communications.createdAt), desc(communications.id))"
    );
  });

  it("rejects stale conversation assignment writes after locking the thread", async () => {
    const { db, execute, updateSet } = createMutationDb({
      selectResults: [[{ id: CLIENT_ID }], [{ assignedTo: OTHER_USER_ID }]],
    });

    await expect(
      callerWithDb(db).assignClient({
        clientId: CLIENT_ID,
        action: "assign_to_me",
        expectedAssignedTo: null,
      })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Conversation assignment changed. Refresh and try again.",
    });

    expect(execute).toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("links an unmatched inbound communication to a tenant client", async () => {
    const { db, updateSet, updateWhere } = createMutationDb({
      selectResults: [
        [{ id: COMM_ID, clientId: null, direction: "inbound" }],
        [{ id: CLIENT_ID }],
        [],
      ],
      updated: [
        { id: COMM_ID, clientId: CLIENT_ID, assignedTo: USER_ID },
      ],
    });

    await expect(
      callerWithDb(db).linkCommunicationToClient({
        communicationId: COMM_ID,
        clientId: CLIENT_ID,
      })
    ).resolves.toMatchObject({
      ok: true,
      communicationId: COMM_ID,
      clientId: CLIENT_ID,
      assignedTo: USER_ID,
      assignedToName: "Front Desk",
    });

    expect(updateSet).toHaveBeenCalledWith({
      clientId: CLIENT_ID,
      assignedTo: USER_ID,
    });
    const condition = updateWhere.mock.calls[0]?.[0];
    expect(sqlIncludesColumnName(condition, "deleted_at")).toBe(true);
    expect(sqlIncludesColumn(condition, practices.deletedAt)).toBe(true);
  });

  it("preserves an existing client conversation assignment when linking unmatched inbound messages", async () => {
    const { db, updateSet } = createMutationDb({
      selectResults: [
        [{ id: COMM_ID, clientId: null, direction: "inbound" }],
        [{ id: CLIENT_ID }],
        [{ assignedTo: OTHER_USER_ID }],
      ],
      updated: [
        { id: COMM_ID, clientId: CLIENT_ID, assignedTo: OTHER_USER_ID },
      ],
    });

    await expect(
      callerWithDb(db).linkCommunicationToClient({
        communicationId: COMM_ID,
        clientId: CLIENT_ID,
      })
    ).resolves.toMatchObject({
      ok: true,
      communicationId: COMM_ID,
      clientId: CLIENT_ID,
      assignedTo: OTHER_USER_ID,
      assignedToName: null,
    });

    expect(updateSet).toHaveBeenCalledWith({
      clientId: CLIENT_ID,
      assignedTo: OTHER_USER_ID,
    });
  });

  it("marks only unread inbound active communications read", async () => {
    const { db, updateSet, updateWhere } = createMutationDb({
      updated: [{ id: COMM_ID, status: "read" }],
    });

    await expect(
      callerWithDb(db).updateStatus({ id: COMM_ID, status: "read" })
    ).resolves.toMatchObject({ id: COMM_ID, status: "read" });

    expect(updateSet).toHaveBeenCalledWith({
      status: "read",
      readAt: expect.any(Date),
    });
    const condition = updateWhere.mock.calls[0]?.[0];
    expect(sqlIncludesColumnName(condition, "deleted_at")).toBe(true);
    expect(sqlIncludesColumn(condition, practices.deletedAt)).toBe(true);
    expect(sqlIncludesColumn(condition, communications.direction)).toBe(true);
    expect(sqlIncludesColumn(condition, communications.readAt)).toBe(true);
    expect(sqlIncludesColumn(condition, communications.status)).toBe(true);
  });

  it("does not let inbox status updates change delivery lifecycle state", async () => {
    const { db, updateSet } = createMutationDb();

    await expect(
      callerWithDb(db).updateStatus({ id: COMM_ID, status: "failed" })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Inbox status updates can only mark messages read",
    });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("does not link a communication that is already matched", async () => {
    const { db, updateSet } = createMutationDb({
      selectResults: [
        [{ id: COMM_ID, clientId: CLIENT_ID, direction: "inbound" }],
      ],
    });

    await expect(
      callerWithDb(db).linkCommunicationToClient({
        communicationId: COMM_ID,
        clientId: CLIENT_ID,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("does not link outbound communications from the unmatched workflow", async () => {
    const { db, updateSet } = createMutationDb({
      selectResults: [[{ id: COMM_ID, clientId: null, direction: "outbound" }]],
    });

    await expect(
      callerWithDb(db).linkCommunicationToClient({
        communicationId: COMM_ID,
        clientId: CLIENT_ID,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("does not link an unmatched message to a missing or cross-tenant client", async () => {
    const { db, updateSet } = createMutationDb({
      selectResults: [
        [{ id: COMM_ID, clientId: null, direction: "inbound" }],
        [],
      ],
    });

    await expect(
      callerWithDb(db).linkCommunicationToClient({
        communicationId: COMM_ID,
        clientId: CLIENT_ID,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(updateSet).not.toHaveBeenCalled();
  });
});
