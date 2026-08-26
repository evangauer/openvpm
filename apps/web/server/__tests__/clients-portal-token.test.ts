import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generatePortalAccessToken: vi.fn(() => "portal-token-1"),
  hashPortalAccessToken: vi.fn((token: string) => `hash:${token}`),
  recordAuditLog: vi.fn(async () => undefined),
  dispatchWebhookEvent: vi.fn(async () => undefined),
}));

vi.mock("@/lib/portal/tokens", () => ({
  generatePortalAccessToken: mocks.generatePortalAccessToken,
  hashPortalAccessToken: mocks.hashPortalAccessToken,
  PORTAL_ACCESS_TOKEN_TTL_MS: 15 * 60 * 1000,
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: mocks.recordAuditLog,
}));

vi.mock("@/lib/webhook-dispatcher", () => ({
  dispatchWebhookEvent: mocks.dispatchWebhookEvent,
}));

const { clientsRouter } = await import("../routers/clients");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const CLIENT_ID = "00000000-0000-0000-0000-000000000002";

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
  return clientsRouter.createCaller({ db, session } as never);
}

function createInsertDb(inserted?: Record<string, unknown>) {
  const select = vi.fn(() => {
    const rows = [{ id: PRACTICE_ID }];
    const builder = {
      from: vi.fn(() => builder),
      where: vi.fn(() => builder),
      limit: vi.fn(async () => rows),
    };
    return builder;
  });
  const insertValues = vi.fn(() => ({
    returning: vi.fn(async () => [
      inserted ?? {
        id: CLIENT_ID,
        firstName: "Ada",
        lastName: "Lovelace",
        accessToken: null,
      },
    ]),
  }));
  const insert = vi.fn(() => ({ values: insertValues }));
  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    execute: vi.fn(async () => undefined),
    select,
    insert,
  };
  return { db, insertValues };
}

function createUpdateDb(updatedRows: unknown[]) {
  const updateSet = vi.fn(() => ({
    where: vi.fn(() => ({
      returning: vi.fn(async () => updatedRows),
    })),
  }));
  const update = vi.fn(() => ({ set: updateSet }));
  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
    execute: vi.fn(async () => undefined),
    update,
  };
  return { db, updateSet };
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.generatePortalAccessToken.mockReturnValue("portal-token-1");
});

describe("clients portal access tokens", () => {
  it("does not persist an unrecoverable portal credential for every new client", async () => {
    const { db, insertValues } = createInsertDb();

    await expect(
      callerWithDb(db).create({
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
      })
    ).resolves.toMatchObject({ accessToken: null });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        practiceId: PRACTICE_ID,
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
        accessToken: null,
      })
    );
  });

  it("rotates a portal access token through a tenant-scoped client update", async () => {
    mocks.generatePortalAccessToken.mockReturnValue("portal-token-2");
    const { db, updateSet } = createUpdateDb([
      { id: CLIENT_ID },
    ]);

    await expect(
      callerWithDb(db).rotatePortalAccessToken({ id: CLIENT_ID })
    ).resolves.toEqual({ id: CLIENT_ID, accessToken: "portal-token-2" });

    expect(updateSet).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        accessToken: "hash:portal-token-2",
        portalAccessTokenExpiresAt: expect.any(Date),
        portalAccessTokenUsedAt: null,
      }),
    );
    expect(updateSet).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ revokedReason: "staff_access_reset" }),
    );
  });

  it("rejects portal token rotation for missing or cross-tenant clients", async () => {
    const { db, updateSet } = createUpdateDb([]);

    await expect(
      callerWithDb(db).rotatePortalAccessToken({ id: CLIENT_ID })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "hash:portal-token-1" }),
    );
  });
});
