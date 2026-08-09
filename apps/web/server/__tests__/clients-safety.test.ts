import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const mocks = vi.hoisted(() => ({
  recordAuditLog: vi.fn(async () => undefined),
  dispatchWebhookEvent: vi.fn(async () => undefined),
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: mocks.recordAuditLog,
}));

vi.mock("@/lib/webhook-dispatcher", () => ({
  dispatchWebhookEvent: mocks.dispatchWebhookEvent,
}));

const { clientsRouter } = await import("../routers/clients");
const { LIST_OFFSET_MAX } = await import("../routers/pagination");
const { SMS_CONSENT_DISCLOSURE } = await import("@/lib/messaging/consent");
const CLIENTS_SOURCE = readFileSync(
  new URL("../routers/clients.ts", import.meta.url),
  "utf8",
);

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const CLIENT_ID = "00000000-0000-0000-0000-000000000002";
const PATIENT_ID = "00000000-0000-0000-0000-000000000003";
const APPOINTMENT_ID = "00000000-0000-0000-0000-000000000004";
const WAITLIST_ID = "00000000-0000-0000-0000-000000000005";
const INVOICE_ID = "00000000-0000-0000-0000-000000000006";

function callerWithDb(db: Record<string, unknown>, role = "admin") {
  const session = {
    user: {
      id: USER_ID,
      email: `${role}@example.com`,
      name: "Client User",
      role,
      practiceId: PRACTICE_ID,
    },
  };
  return clientsRouter.createCaller({ db, session } as never);
}

function objectContainsText(
  value: unknown,
  needle: string,
  seen = new WeakSet<object>(),
): boolean {
  if (typeof value === "string") return value.includes(needle);
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  return Object.values(value as Record<string, unknown>).some((item) =>
    objectContainsText(item, needle, seen),
  );
}

function createDb(opts?: {
  selectResults?: unknown[][];
  insertedRows?: unknown[];
  updatedRows?: unknown[];
}) {
  const lockEvents: string[] = [];
  const selectResults = [...(opts?.selectResults ?? [])];
  const select = vi.fn(() => {
    const result = selectResults.shift() ?? [];
    const builder = {
      from: vi.fn(() => builder),
      where: vi.fn(() => builder),
      orderBy: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      for: vi.fn((mode: string) => {
        lockEvents.push(`row:${mode}`);
        return builder;
      }),
      offset: vi.fn(async () => result),
      then: (
        resolve: (value: unknown[]) => unknown,
        reject?: (error: unknown) => unknown,
      ) => Promise.resolve(result).then(resolve, reject),
    };
    return builder;
  });
  const insertReturning = vi.fn(
    async () => opts?.insertedRows ?? [{ id: "consent-event-1" }],
  );
  const insertConflict = vi.fn(async () => undefined);
  const insertValues = vi.fn(() => ({
    returning: insertReturning,
    onConflictDoNothing: vi.fn(() => ({ returning: insertReturning })),
    onConflictDoUpdate: insertConflict,
  }));
  const insert = vi.fn(() => ({ values: insertValues }));

  const updateReturning = vi.fn(async () => opts?.updatedRows ?? []);
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));
  const execute = vi.fn(async (query: unknown) => {
    if (objectContainsText(query, "pg_advisory_xact_lock")) {
      lockEvents.push("advisory");
    }
  });
  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    execute,
    select,
    insert,
    update,
  };
  return { db, select, insertValues, updateSet, execute, lockEvents };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("clients mutation safety", () => {
  it("keeps client write actions restricted to non-viewer staff roles", async () => {
    const { db, insertValues, updateSet } = createDb();
    const viewer = callerWithDb(db, "viewer");

    await expect(
      viewer.create({
        firstName: "Ada",
        lastName: "Lovelace",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      viewer.update({
        id: CLIENT_ID,
        firstName: "Ada",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      viewer.rotatePortalAccessToken({ id: CLIENT_ID }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();

    const { db: writableDb } = createDb({
      selectResults: [[{ id: PRACTICE_ID }]],
      insertedRows: [{ id: CLIENT_ID, firstName: "Ada", lastName: "Lovelace" }],
    });

    await expect(
      callerWithDb(writableDb, "front_desk").create({
        firstName: "Ada",
        lastName: "Lovelace",
      }),
    ).resolves.toMatchObject({ id: CLIENT_ID });
  });

  it("returns the practice timezone with client list results", () => {
    expect(CLIENTS_SOURCE).toContain("practices,");
    expect(CLIENTS_SOURCE).toContain(
      ".select({ timezone: practices.timezone })",
    );
    expect(CLIENTS_SOURCE).toContain(
      "timezone: practiceResult[0].timezone ?? null",
    );
    expect(CLIENTS_SOURCE).toContain("if (!practiceResult[0])");
    expect(CLIENTS_SOURCE).toContain('message: "Practice not found"');
  });

  it("redacts portal access tokens from client list rows", async () => {
    const { db } = createDb({
      selectResults: [
        [
          {
            id: CLIENT_ID,
            firstName: "Ada",
            lastName: "Lovelace",
            accessToken: "private-portal-token",
          },
        ],
        [{ count: 1 }],
        [{ timezone: "America/New_York" }],
      ],
    });

    await expect(
      callerWithDb(db, "admin").list({ limit: 25, offset: 0 }),
    ).resolves.toMatchObject({
      items: [
        {
          id: CLIENT_ID,
          firstName: "Ada",
          lastName: "Lovelace",
          accessToken: null,
        },
      ],
      total: 1,
      timezone: "America/New_York",
    });
  });

  it("rejects missing or deleted practice settings for client list rows", async () => {
    const { db } = createDb({
      selectResults: [[], [{ count: 0 }], []],
    });

    await expect(
      callerWithDb(db, "admin").list({ limit: 25, offset: 0 }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });
  });

  it("redacts portal access tokens from read-only client detail callers", async () => {
    const clientRow = {
      id: CLIENT_ID,
      firstName: "Ada",
      lastName: "Lovelace",
      accessToken: "private-portal-token",
    };
    const { db } = createDb({
      selectResults: [[clientRow], []],
    });

    await expect(
      callerWithDb(db, "viewer").getById({ id: CLIENT_ID }),
    ).resolves.toMatchObject({
      id: CLIENT_ID,
      accessToken: null,
      patients: [],
    });

    const { db: writableDb } = createDb({
      selectResults: [[clientRow], []],
    });

    await expect(
      callerWithDb(writableDb, "front_desk").getById({ id: CLIENT_ID }),
    ).resolves.toMatchObject({
      id: CLIENT_ID,
      accessToken: "private-portal-token",
      patients: [],
    });
  });

  it("rejects invalid list and contact inputs before DB work", async () => {
    const { db, select, insertValues, updateSet } = createDb();

    await expect(
      callerWithDb(db).list({ limit: 1.5, offset: 0 } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).list({
        search: "s".repeat(101),
        limit: 25,
        offset: 0,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).list({
        limit: 25,
        offset: LIST_OFFSET_MAX + 1,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).search({ query: "   " }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).create({
        firstName: "Ada",
        lastName: "Lovelace",
        email: "not-an-email",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).create({
        firstName: "A".repeat(129),
        lastName: "Lovelace",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).create({
        firstName: "Ada",
        lastName: "Lovelace",
        address: "a".repeat(501),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).update({
        id: CLIENT_ID,
        phone: "1".repeat(33),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      callerWithDb(db).update({
        id: CLIENT_ID,
        notes: "n".repeat(2001),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("emits a narrow webhook payload after creating a client", async () => {
    const { db, insertValues } = createDb({
      selectResults: [[{ id: PRACTICE_ID }]],
      insertedRows: [
        {
          id: CLIENT_ID,
          firstName: "Ada",
          lastName: "Lovelace",
          email: "ada@example.com",
          phone: "+15555550123",
          accessToken: "private-token",
        },
      ],
    });

    await expect(
      callerWithDb(db).create({
        firstName: " Ada ",
        lastName: " Lovelace ",
        email: " ada@example.com ",
        phone: " +15555550123 ",
        address: " 123 Analytical Engine Way ",
        city: " London ",
        state: " Middlesex ",
        zip: " SW1 ",
        notes: " Prefers email. ",
      }),
    ).resolves.toMatchObject({ id: CLIENT_ID, accessToken: "private-token" });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
        phone: "+15555550123",
        address: "123 Analytical Engine Way",
        city: "London",
        state: "Middlesex",
        zip: "SW1",
        notes: "Prefers email.",
        practiceId: PRACTICE_ID,
        accessToken: expect.any(String),
      }),
    );
    expect(mocks.dispatchWebhookEvent).toHaveBeenCalledWith(
      PRACTICE_ID,
      "client.created",
      {
        id: CLIENT_ID,
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
        phone: "+15555550123",
        source: "dashboard",
      },
    );
  });

  it("stores the current server-owned disclosure only on explicit creation consent", async () => {
    const { db, insertValues } = createDb({
      selectResults: [[{ id: PRACTICE_ID }]],
      insertedRows: [
        {
          id: CLIENT_ID,
          firstName: "Ada",
          lastName: "Lovelace",
          phone: "+15555550123",
        },
      ],
    });

    await callerWithDb(db).create({
      firstName: "Ada",
      lastName: "Lovelace",
      phone: "(555) 555-0123",
      smsConsent: true,
    });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        smsConsent: true,
        smsConsentAt: expect.any(Date),
        smsConsentSource: SMS_CONSENT_DISCLOSURE.source,
        smsConsentDisclosure: SMS_CONSENT_DISCLOSURE.snapshot,
      }),
    );
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        clientId: CLIENT_ID,
        destinationE164: "+15555550123",
        action: "granted",
        source: SMS_CONSENT_DISCLOSURE.source,
        disclosureVersion: SMS_CONSENT_DISCLOSURE.version,
        disclosure: SMS_CONSENT_DISCLOSURE.snapshot,
        actorType: "staff",
        actorUserId: USER_ID,
      }),
    );
    expect(SMS_CONSENT_DISCLOSURE.source).toContain(
      SMS_CONSENT_DISCLOSURE.version,
    );
  });

  it("rejects explicit creation consent without a valid SMS destination", async () => {
    const { db, select, insertValues } = createDb();

    await expect(
      callerWithDb(db).create({
        firstName: "Ada",
        lastName: "Lovelace",
        phone: "12345",
        smsConsent: true,
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "A valid mobile phone number is required for SMS consent",
    });

    expect(select).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects client creation before insert when the practice is missing or deleted", async () => {
    const { db, insertValues } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).create({
        firstName: "Ada",
        lastName: "Lovelace",
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Practice not found",
    });

    expect(insertValues).not.toHaveBeenCalled();
    expect(mocks.dispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it("updates a non-deleted client in the current practice", async () => {
    const { db, updateSet } = createDb({
      updatedRows: [{ id: CLIENT_ID, firstName: "Ada" }],
    });

    await expect(
      callerWithDb(db).update({
        id: CLIENT_ID,
        firstName: " Ada ",
        address: "   ",
        notes: " Prefers morning appointments. ",
      }),
    ).resolves.toMatchObject({ id: CLIENT_ID, firstName: "Ada" });

    expect(updateSet).toHaveBeenCalledWith({
      firstName: "Ada",
      address: undefined,
      notes: "Prefers morning appointments.",
    });
  });

  it("preserves consent evidence across formatting-only phone edits", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [{ id: CLIENT_ID, phone: "+15555550123", smsConsent: true }],
        [{ id: CLIENT_ID, phone: "+15555550123", smsConsent: true }],
      ],
      updatedRows: [{ id: CLIENT_ID, phone: "(555) 555-0123" }],
    });

    await callerWithDb(db).update({
      id: CLIENT_ID,
      phone: "(555) 555-0123",
    });

    expect(updateSet).toHaveBeenCalledWith({
      phone: "(555) 555-0123",
    });
  });

  it("clears consent evidence when the normalized phone destination changes", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [
        [{ id: CLIENT_ID, phone: "+15555550123", smsConsent: true }],
        [{ id: CLIENT_ID, phone: "+15555550123", smsConsent: true }],
      ],
      updatedRows: [{ id: CLIENT_ID, phone: "+15555550999" }],
    });

    await callerWithDb(db).update({
      id: CLIENT_ID,
      phone: "+15555550999",
    });

    expect(updateSet).toHaveBeenCalledWith({
      phone: "+15555550999",
      smsConsent: false,
      smsConsentAt: null,
      smsConsentSource: null,
      smsConsentDisclosure: null,
    });
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: CLIENT_ID,
        destinationE164: "+15555550123",
        action: "revoked",
        source: "phone_change:v1",
        actorType: "staff",
        actorUserId: USER_ID,
      }),
    );
  });

  it("stores fresh current evidence when a phone edit explicitly re-consents", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [
        [{ id: CLIENT_ID, phone: "+15555550123", smsConsent: true }],
        [{ id: CLIENT_ID, phone: "+15555550123", smsConsent: true }],
        [],
      ],
      updatedRows: [{ id: CLIENT_ID, phone: "+15555550999" }],
    });

    await callerWithDb(db).update({
      id: CLIENT_ID,
      phone: "+15555550999",
      smsConsent: true,
    });

    expect(updateSet).toHaveBeenCalledWith({
      phone: "+15555550999",
      smsConsent: true,
      smsConsentAt: expect.any(Date),
      smsConsentSource: SMS_CONSENT_DISCLOSURE.source,
      smsConsentDisclosure: SMS_CONSENT_DISCLOSURE.snapshot,
    });
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: CLIENT_ID,
        destinationE164: "+15555550999",
        action: "granted",
        source: SMS_CONSENT_DISCLOSURE.source,
        disclosureVersion: SMS_CONSENT_DISCLOSURE.version,
        actorType: "staff",
        actorUserId: USER_ID,
      }),
    );
  });

  it("does not let ordinary re-consent bypass a manual suppression", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [{ id: CLIENT_ID, phone: "+15555550123", smsConsent: true }],
        [{ id: CLIENT_ID, phone: "+15555550123", smsConsent: true }],
        [{ id: "suppression-1", reason: "manual" }],
      ],
      updatedRows: [{ id: CLIENT_ID }],
    });

    await expect(
      callerWithDb(db).update({ id: CLIENT_ID, smsConsent: true }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining(
        "manually placed on the do-not-text list",
      ),
    });
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("requires an inbound START before staff can restore a carrier STOP", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [
        [{ id: CLIENT_ID, phone: "+15555550123", smsConsent: false }],
        [{ id: CLIENT_ID, phone: "+15555550123", smsConsent: false }],
        [{ id: "suppression-1", reason: "stop" }],
      ],
    });

    await expect(
      callerWithDb(db).update({ id: CLIENT_ID, smsConsent: true }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("reply START"),
    });
    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("manually revokes a normalized phone practice-wide across duplicate clients", async () => {
    const { db, insertValues, updateSet, lockEvents } = createDb({
      selectResults: [
        [{ phone: "(555) 555-0123" }],
        [{ phone: "+15555550123" }],
      ],
      updatedRows: [{ id: CLIENT_ID }, { id: PATIENT_ID }],
    });

    await expect(
      callerWithDb(db, "front_desk").revokeSms({
        id: CLIENT_ID,
        expectedPhone: "+15555550123",
      }),
    ).resolves.toEqual({
      phone: "+15555550123",
      clientsRevoked: 2,
    });
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: CLIENT_ID,
        destinationE164: "+15555550123",
        action: "revoked",
        source: "staff_manual_revoke:v1",
        actorType: "staff",
        actorUserId: USER_ID,
      }),
    );
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        phone: "+15555550123",
        reason: "manual",
      }),
    );
    expect(updateSet).toHaveBeenCalledWith({
      smsConsent: false,
      smsConsentAt: null,
      smsConsentSource: null,
      smsConsentDisclosure: null,
    });
    expect(lockEvents.slice(0, 2)).toEqual(["advisory", "row:update"]);
  });

  it("fails closed when the revoke page has a stale persisted phone", async () => {
    const { db, insertValues, updateSet, lockEvents } = createDb({
      selectResults: [[{ phone: "+15555550999" }]],
    });

    await expect(
      callerWithDb(db, "front_desk").revokeSms({
        id: CLIENT_ID,
        expectedPhone: "+15555550123",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("no longer matches"),
    });

    expect(lockEvents).toEqual([]);
    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rechecks the persisted phone after the recipient lock before revoking", async () => {
    const { db, insertValues, updateSet, lockEvents } = createDb({
      selectResults: [[{ phone: "+15555550123" }], [{ phone: "+15555550999" }]],
    });

    await expect(
      callerWithDb(db, "front_desk").revokeSms({
        id: CLIENT_ID,
        expectedPhone: "+15555550123",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("changed while revoking"),
    });

    expect(lockEvents).toEqual(["advisory", "row:update"]);
    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("clears prior evidence when staff explicitly withdraws SMS consent", async () => {
    const { db, updateSet, lockEvents } = createDb({
      selectResults: [
        [{ phone: "+15555550123", smsConsent: true }],
        [{ id: CLIENT_ID, phone: "+15555550123", smsConsent: true }],
      ],
      updatedRows: [{ id: CLIENT_ID, smsConsent: false }],
    });

    await callerWithDb(db).update({
      id: CLIENT_ID,
      smsConsent: false,
    });

    expect(updateSet).toHaveBeenCalledWith({
      smsConsent: false,
      smsConsentAt: null,
      smsConsentSource: null,
      smsConsentDisclosure: null,
    });
    expect(lockEvents.slice(0, 2)).toEqual(["advisory", "row:update"]);
  });

  it("does not withdraw consent when the immutable revoke event conflicts", async () => {
    const { db, updateSet } = createDb({
      selectResults: [
        [{ phone: "+15555550123", smsConsent: true }],
        [{ id: CLIENT_ID, phone: "+15555550123", smsConsent: true }],
      ],
      insertedRows: [],
    });

    await expect(
      callerWithDb(db).update({ id: CLIENT_ID, smsConsent: false }),
    ).rejects.toThrow("SMS consent revocation evidence could not be appended");
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("withdraws from the persisted phone rather than an unsaved replacement", async () => {
    const { db, insertValues, updateSet } = createDb({
      selectResults: [
        [{ phone: "+15555550123", smsConsent: true }],
        [{ id: CLIENT_ID, phone: "+15555550123", smsConsent: true }],
      ],
      updatedRows: [{ id: CLIENT_ID, smsConsent: false }],
    });

    await callerWithDb(db).update({
      id: CLIENT_ID,
      phone: "+15555550999",
      smsConsent: false,
    });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ phone: "+15555550123", reason: "manual" }),
    );
    expect(insertValues).not.toHaveBeenCalledWith(
      expect.objectContaining({ phone: "+15555550999" }),
    );
    expect(updateSet).toHaveBeenCalledWith({
      phone: "+15555550999",
      smsConsent: false,
      smsConsentAt: null,
      smsConsentSource: null,
      smsConsentDisclosure: null,
    });
  });

  it("rechecks the withdrawal phone after the recipient lock", async () => {
    const { db, insertValues, updateSet, lockEvents } = createDb({
      selectResults: [
        [{ phone: "+15555550123", smsConsent: true }],
        [{ id: CLIENT_ID, phone: "+15555550999", smsConsent: true }],
      ],
    });

    await expect(
      callerWithDb(db).update({ id: CLIENT_ID, smsConsent: false }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("changed while saving"),
    });

    expect(lockEvents).toEqual(["advisory", "row:update"]);
    expect(insertValues).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects stale, deleted, or cross-tenant client updates", async () => {
    const { db, updateSet } = createDb({ updatedRows: [] });

    await expect(
      callerWithDb(db).update({
        id: CLIENT_ID,
        firstName: "Ada",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(updateSet).toHaveBeenCalledWith({ firstName: "Ada" });
  });

  it("rejects stale, deleted, or cross-tenant client deletes", async () => {
    const { db, updateSet } = createDb({ selectResults: [[]] });

    await expect(
      callerWithDb(db).delete({ id: CLIENT_ID }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects client deletes while active patients still belong to the client", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: CLIENT_ID }], [{ id: PATIENT_ID }]],
    });

    await expect(
      callerWithDb(db).delete({ id: CLIENT_ID }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects client deletes while active appointments still belong to the client", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: CLIENT_ID }], [], [{ id: APPOINTMENT_ID }]],
    });

    await expect(
      callerWithDb(db).delete({ id: CLIENT_ID }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects client deletes while waiting appointment requests still belong to the client", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: CLIENT_ID }], [], [], [{ id: WAITLIST_ID }]],
    });

    await expect(
      callerWithDb(db).delete({ id: CLIENT_ID }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("rejects client deletes while unresolved invoices still belong to the client", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: CLIENT_ID }], [], [], [], [{ id: INVOICE_ID }]],
    });

    await expect(
      callerWithDb(db).delete({ id: CLIENT_ID }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(updateSet).not.toHaveBeenCalled();
  });

  it("soft-deletes clients without active dependencies", async () => {
    const { db, updateSet } = createDb({
      selectResults: [[{ id: CLIENT_ID }], [], [], [], []],
      updatedRows: [{ id: CLIENT_ID }],
    });

    await expect(callerWithDb(db).delete({ id: CLIENT_ID })).resolves.toEqual({
      success: true,
    });

    expect(updateSet).toHaveBeenCalledWith({ deletedAt: expect.any(Date) });
  });
});

describe("clients delete dependency safety", () => {
  it("requires an active practice for client reads, writes, and dependency checks", () => {
    expect(CLIENTS_SOURCE).toContain("function activePracticePredicate");
    expect(CLIENTS_SOURCE).toContain("function assertActivePractice");
    expect(CLIENTS_SOURCE).toContain("from ${practices}");
    expect(CLIENTS_SOURCE).toContain("${practices.deletedAt} is null");
    expect(
      CLIENTS_SOURCE.match(/activePracticePredicate\(ctx\.practiceId\)/g)
        ?.length ?? 0,
    ).toBeGreaterThanOrEqual(10);
    expect(CLIENTS_SOURCE).toContain("await assertActivePractice(ctx)");
    expect(CLIENTS_SOURCE).toMatch(
      /eq\(clients\.practiceId, ctx\.practiceId\),\s+activePracticePredicate\(ctx\.practiceId\),\s+isNull\(clients\.deletedAt\)/,
    );
    expect(CLIENTS_SOURCE).toMatch(
      /eq\(patients\.practiceId, ctx\.practiceId\),\s+activePracticePredicate\(ctx\.practiceId\),\s+isNull\(patients\.deletedAt\)/,
    );
    expect(CLIENTS_SOURCE).toMatch(
      /eq\(invoices\.practiceId, ctx\.practiceId\),\s+activePracticePredicate\(ctx\.practiceId\),\s+isNull\(invoices\.deletedAt\)/,
    );
  });

  it("keeps client delete dependency checks tenant-scoped", () => {
    const deleteBlock = CLIENTS_SOURCE.match(
      /delete: protectedProcedure[\s\S]+?\n\s*\}\),\n\}\);/,
    )?.[0];

    expect(deleteBlock).toContain("await ctx.db.transaction");
    expect(deleteBlock).toContain("eq(clients.id, input.id)");
    expect(deleteBlock).toContain("eq(clients.practiceId, ctx.practiceId)");
    expect(deleteBlock).toContain("activePracticePredicate(ctx.practiceId)");
    expect(deleteBlock).toContain("eq(patients.clientId, input.id)");
    expect(deleteBlock).toContain("eq(patients.practiceId, ctx.practiceId)");
    expect(deleteBlock).toContain("eq(appointments.clientId, input.id)");
    expect(deleteBlock).toContain(
      "eq(appointments.practiceId, ctx.practiceId)",
    );
    expect(deleteBlock).toContain(
      "inArray(appointments.status, activeSchedulingStatuses)",
    );
    expect(deleteBlock).toContain("eq(appointmentWaitlist.clientId, input.id)");
    expect(deleteBlock).toContain(
      "eq(appointmentWaitlist.practiceId, ctx.practiceId)",
    );
    expect(deleteBlock).toContain('eq(appointmentWaitlist.status, "waiting")');
    expect(deleteBlock).toContain("eq(invoices.clientId, input.id)");
    expect(deleteBlock).toContain("eq(invoices.practiceId, ctx.practiceId)");
    expect(deleteBlock).toContain(
      "inArray(invoices.status, unresolvedInvoiceStatuses)",
    );
  });
});
