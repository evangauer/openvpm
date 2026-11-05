import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  withTenant: vi.fn(
    async (
      database: unknown,
      _practiceId: string,
      fn: (tx: unknown) => Promise<unknown>,
    ) => fn(database),
  ),
  db: {
    select: vi.fn(),
    execute: vi.fn(async () => undefined),
  },
}));

vi.mock("next-auth", () => ({ getServerSession: mocks.getServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/rls-assertion", () => ({
  assertHostedRlsRoleOnce: vi.fn(async () => undefined),
}));
vi.mock("@/lib/tenant-db", () => ({
  withTenant: mocks.withTenant,
  withSystem: vi.fn(
    async (database: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      fn(database),
  ),
}));
vi.mock("@openpims/db/client", () => ({ db: mocks.db }));
vi.mock("@/lib/audit", () => ({ recordAuditLog: vi.fn(async () => undefined) }));

const { createRouter, createTRPCContext, protectedProcedure } = await import(
  "../trpc"
);

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_ID = "00000000-0000-0000-0000-000000000001";
const HOUR = 60 * 60 * 1000;

const probeRouter = createRouter({
  clients: createRouter({
    create: protectedProcedure.mutation(() => "write-ok"),
  }),
  messaging: createRouter({
    orderNumber: protectedProcedure.mutation(() => "ordered"),
  }),
  inPreview: protectedProcedure.query(
    ({ ctx }) => ctx.session?.user.practiceInPreview,
  ),
});

function practiceState(overrides: Record<string, unknown> = {}) {
  return {
    tier: "free",
    billingStatus: "none",
    trialEndsAt: null,
    stripeSubscriptionId: null,
    previewEndsAt: new Date(Date.now() + 24 * HOUR),
    ...overrides,
  };
}

/** First select: the session lookup. Second: the hosted write gate. */
async function callerFor(practice: Record<string, unknown>) {
  mocks.getServerSession.mockResolvedValueOnce({
    user: {
      id: USER_ID,
      email: "owner@example.com",
      name: "Owner",
      role: "admin",
      practiceId: PRACTICE_ID,
      sessionVersion: 1,
    },
  });
  const sessionRow = {
    id: USER_ID,
    role: "admin",
    sessionVersion: 1,
    emailVerifiedAt: new Date(),
    practiceCreatedAt: new Date(),
    recoveryHold: false,
    ...practice,
  };
  mocks.db.select.mockImplementation(() => ({
    from: () => ({
      innerJoin: () => ({
        where: () => ({ limit: async () => [sessionRow] }),
      }),
      where: () => ({ limit: async () => [practice] }),
    }),
  }));
  return probeRouter.createCaller(await createTRPCContext());
}

beforeEach(() => {
  vi.stubEnv("HOSTED_BILLING_ENABLED", "true");
});

afterEach(() => {
  vi.unstubAllEnvs();
  mocks.getServerSession.mockReset();
  mocks.db.select.mockReset();
});

describe("preview before card access", () => {
  it("lets a preview clinic set up its workspace", async () => {
    const caller = await callerFor(practiceState());
    await expect(caller.clients.create()).resolves.toBe("write-ok");
    await expect(caller.inPreview()).resolves.toBe(true);
  });

  it("keeps provider purchases and outbound surfaces behind the trial", async () => {
    const caller = await callerFor(practiceState());
    await expect(caller.messaging.orderNumber()).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("Start your free trial"),
    });
  });

  it("returns to read-only when the preview window closes", async () => {
    const caller = await callerFor(
      practiceState({ previewEndsAt: new Date(Date.now() - HOUR) }),
    );
    await expect(caller.clients.create()).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("read-only"),
    });
    // Outbound stays off after the window too, until a trial starts.
    await expect(caller.inPreview()).resolves.toBe(true);
  });

  it("leaves never-previewed signups read-only until checkout", async () => {
    const caller = await callerFor(practiceState({ previewEndsAt: null }));
    await expect(caller.clients.create()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(caller.inPreview()).resolves.toBe(false);
  });

  it("drops preview limits once the trial starts", async () => {
    const caller = await callerFor(
      practiceState({
        billingStatus: "trialing",
        trialEndsAt: new Date(Date.now() + 14 * 24 * HOUR),
        stripeSubscriptionId: "sub_123",
      }),
    );
    await expect(caller.messaging.orderNumber()).resolves.toBe("ordered");
    await expect(caller.inPreview()).resolves.toBe(false);
  });
});
