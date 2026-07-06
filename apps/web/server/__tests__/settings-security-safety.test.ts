import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recordAuditLog: vi.fn(async () => undefined),
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: mocks.recordAuditLog,
}));

const { API_KEY_SCOPE_MAX_COUNT, apiKeysRouter } = await import(
  "../routers/api-keys"
);
const { WEBHOOK_EVENT_MAX_COUNT, webhooksRouter } = await import(
  "../routers/webhooks"
);
const { WEBHOOK_URL_MAX_LENGTH } = await import("@/lib/webhook-urls");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const API_KEY_ID = "00000000-0000-0000-0000-000000000002";
const WEBHOOK_ID = "00000000-0000-0000-0000-000000000003";

function callerContext(db: Record<string, unknown>) {
  return {
    db,
    session: {
      user: {
        id: USER_ID,
        email: "admin@example.com",
        name: "Admin",
        role: "admin",
        practiceId: PRACTICE_ID,
      },
    },
  } as never;
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
      orderBy: vi.fn(() => builder),
      limit: vi.fn(async () => result),
    };
    return builder;
  });

  const updateReturning = vi.fn(async () => opts?.updatedRows ?? []);
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  const insertReturning = vi.fn(async () => opts?.insertedRows ?? []);
  const insertValues = vi.fn(() => ({ returning: insertReturning }));
  const insert = vi.fn(() => ({ values: insertValues }));

  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    execute: vi.fn(async () => undefined),
    select,
    insert,
    update,
  };

  return { db, insertValues, updateSet };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("settings security stale target safety", () => {
  it("rejects duplicate and oversized integration event arrays before DB work", async () => {
    const { db, insertValues } = createDb();
    const apiKeys = apiKeysRouter.createCaller(callerContext(db));
    const webhooks = webhooksRouter.createCaller(callerContext(db));

    await expect(
      apiKeys.create({
        name: "Public API",
        scopes: ["clients:read", "clients:read"],
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      apiKeys.create({
        name: "Public API",
        scopes: Array.from(
          { length: API_KEY_SCOPE_MAX_COUNT + 1 },
          (): "clients:read" => "clients:read"
        ),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      apiKeys.create({
        name: "Public API",
        scopes: ["agent:write"],
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      webhooks.create({
        url: "https://example.com/openvpm",
        events: ["appointment.created", "appointment.created"],
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      webhooks.create({
        url: "https://example.com/openvpm",
        events: Array.from(
          { length: WEBHOOK_EVENT_MAX_COUNT + 1 },
          (): "appointment.created" => "appointment.created"
        ),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects unsafe and oversized webhook URLs before DB work", async () => {
    const { db, insertValues } = createDb();
    const webhooks = webhooksRouter.createCaller(callerContext(db));

    await expect(
      webhooks.create({
        url: "ftp://example.com/openvpm",
        events: ["appointment.created"],
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      webhooks.create({
        url: `https://example.com/${"a".repeat(WEBHOOK_URL_MAX_LENGTH)}`,
        events: ["appointment.created"],
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("trims accepted webhook URLs before storage", async () => {
    const { db, insertValues } = createDb({
      selectResults: [[{ id: PRACTICE_ID }]],
      insertedRows: [
        {
          id: WEBHOOK_ID,
          url: "https://example.com/openvpm",
          events: ["appointment.created"],
          active: true,
          createdAt: new Date("2026-06-29T12:00:00.000Z"),
        },
      ],
    });

    await expect(
      webhooksRouter.createCaller(callerContext(db)).create({
        url: " https://example.com/openvpm ",
        events: ["appointment.created"],
      })
    ).resolves.toMatchObject({ secret: expect.any(String) });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://example.com/openvpm" })
    );
  });

  it("returns only public webhook metadata plus the one-time secret on create", async () => {
    const createdAt = new Date("2026-06-29T12:00:00.000Z");
    const { db, insertValues } = createDb({
      selectResults: [[{ id: PRACTICE_ID }]],
      insertedRows: [
        {
          id: WEBHOOK_ID,
          practiceId: PRACTICE_ID,
          url: "https://example.com/openvpm",
          events: ["appointment.created"],
          active: true,
          secret: "stored-webhook-secret",
          deletedAt: null,
          updatedAt: new Date("2026-06-29T12:01:00.000Z"),
          createdAt,
        },
      ],
    });

    const result = await webhooksRouter.createCaller(callerContext(db)).create({
      url: "https://example.com/openvpm",
      events: ["appointment.created"],
    });

    expect(result).toEqual({
      id: WEBHOOK_ID,
      url: "https://example.com/openvpm",
      events: ["appointment.created"],
      active: true,
      createdAt,
      secret: expect.any(String),
    });
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ secret: result.secret })
    );
  });

  it("rejects webhook list and create when the practice is missing or deleted", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [[], []],
    });
    const webhooks = webhooksRouter.createCaller(callerContext(db));

    await expect(webhooks.list()).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    await expect(
      webhooks.create({
        url: "https://example.com/openvpm",
        events: ["appointment.created"],
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("requires an active practice for webhook reads, creation, toggles, and deletes", () => {
    const source = readFileSync("server/routers/webhooks.ts", "utf8");

    expect(source).toContain("function activePracticePredicate");
    expect(source).toContain("function assertActivePractice");
    expect(source).toContain("function practiceNotFound");
    expect(source).toContain('message: "Practice not found"');
    expect(source).toContain("await assertActivePractice(ctx.db, ctx.practiceId)");
    expect(source).toMatch(
      /eq\(webhooks\.practiceId, ctx\.practiceId\),\s+activePracticePredicate\(ctx\.practiceId\),\s+isNull\(webhooks\.deletedAt\)/
    );
  });

  it("does not return a raw API key when persistence returns no created row", async () => {
    const { db, insertValues } = createDb({
      selectResults: [[{ id: PRACTICE_ID }]],
      insertedRows: [],
    });

    await expect(
      apiKeysRouter.createCaller(callerContext(db)).create({
        name: "Clinical API",
        scopes: ["clients:read"],
      })
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        name: "Clinical API",
        scopes: ["clients:read"],
        keyPrefix: expect.stringMatching(/^ovpm_/),
        keyHash: expect.any(String),
      })
    );
  });

  it("returns only public API key metadata plus the one-time raw key on create", async () => {
    const createdAt = new Date("2026-06-29T12:00:00.000Z");
    const { db, insertValues } = createDb({
      selectResults: [[{ id: PRACTICE_ID }]],
      insertedRows: [
        {
          id: API_KEY_ID,
          practiceId: PRACTICE_ID,
          name: "Clinical API",
          keyPrefix: "ovpm_public1",
          keyHash: "stored-api-key-hash",
          scopes: ["clients:read"],
          lastUsedAt: null,
          deletedAt: null,
          updatedAt: new Date("2026-06-29T12:01:00.000Z"),
          createdAt,
        },
      ],
    });

    const result = await apiKeysRouter.createCaller(callerContext(db)).create({
      name: "Clinical API",
      scopes: ["clients:read"],
    });

    expect(result).toEqual({
      id: API_KEY_ID,
      name: "Clinical API",
      keyPrefix: "ovpm_public1",
      scopes: ["clients:read"],
      createdAt,
      key: expect.stringMatching(/^ovpm_/),
    });
    expect(JSON.stringify(result)).not.toContain("stored-api-key-hash");
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Clinical API",
        scopes: ["clients:read"],
        keyPrefix: expect.stringMatching(/^ovpm_/),
        keyHash: expect.any(String),
      })
    );
  });

  it("rejects API key list and create when the practice is missing or deleted", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [[], []],
    });
    const apiKeys = apiKeysRouter.createCaller(callerContext(db));

    await expect(apiKeys.list()).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    await expect(
      apiKeys.create({
        name: "Clinical API",
        scopes: ["clients:read"],
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("requires an active practice for API key reads, creation, and revocation", () => {
    const source = readFileSync("server/routers/api-keys.ts", "utf8");

    expect(source).toContain("function activePracticePredicate");
    expect(source).toContain("function assertActivePractice");
    expect(source).toContain("function practiceNotFound");
    expect(source).toContain('message: "Practice not found"');
    expect(source).toContain("await assertActivePractice(ctx.db, ctx.practiceId)");
    expect(source).toMatch(
      /eq\(apiKeys\.practiceId, ctx\.practiceId\),\s+activePracticePredicate\(ctx\.practiceId\),\s+isNull\(apiKeys\.deletedAt\)/
    );
  });

  it("returns a typed not-found error for stale API key revokes", async () => {
    const { db, updateSet } = createDb({ updatedRows: [] });

    await expect(
      apiKeysRouter.createCaller(callerContext(db)).revoke({ id: API_KEY_ID })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(updateSet).toHaveBeenCalledWith({ deletedAt: expect.any(Date) });
  });

  it("returns a typed not-found error for stale webhook toggles", async () => {
    const { db, updateSet } = createDb({ selectResults: [[]] });

    await expect(
      webhooksRouter.createCaller(callerContext(db)).toggle({ id: WEBHOOK_ID })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("returns not-found if a webhook disappears after toggle preflight", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ active: true }]],
      updatedRows: [],
    });

    await expect(
      webhooksRouter.createCaller(callerContext(db)).toggle({ id: WEBHOOK_ID })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(updateSet).toHaveBeenCalledWith({ active: false });
  });

  it("toggles an active tenant webhook", async () => {
    const createdAt = new Date("2026-06-29T12:00:00.000Z");
    const { db, updateSet } = createDb({
      selectResults: [[{ active: true }]],
      updatedRows: [
        {
          id: WEBHOOK_ID,
          url: "https://example.com/openvpm",
          events: ["appointment.created"],
          active: false,
          secret: "stored-webhook-secret",
          createdAt,
        },
      ],
    });

    await expect(
      webhooksRouter.createCaller(callerContext(db)).toggle({ id: WEBHOOK_ID })
    ).resolves.toEqual({
      id: WEBHOOK_ID,
      url: "https://example.com/openvpm",
      events: ["appointment.created"],
      active: false,
      createdAt,
    });

    expect(updateSet).toHaveBeenCalledWith({ active: false });
  });

  it("returns a typed not-found error for stale webhook deletes", async () => {
    const { db, updateSet } = createDb({ updatedRows: [] });

    await expect(
      webhooksRouter.createCaller(callerContext(db)).delete({ id: WEBHOOK_ID })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(updateSet).toHaveBeenCalledWith({ deletedAt: expect.any(Date) });
  });
});
