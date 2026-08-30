import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  let systemDepth = 0;
  let tenantDepth = 0;
  const events: string[] = [];
  const executeErrors: unknown[] = [];
  const patientMergeResolverErrors: unknown[] = [];
  const privilegedResolverErrors: unknown[] = [];
  let proofConsumptionUpdates = 0;
  return {
    events,
    executeErrors,
    patientMergeResolverErrors,
    privilegedResolverErrors,
    billingEnforced: vi.fn(() => false),
    get proofConsumptionUpdates() {
      return proofConsumptionUpdates;
    },
    get systemDepth() {
      return systemDepth;
    },
    get tenantDepth() {
      return tenantDepth;
    },
    withSystem: vi.fn(
      async (database: unknown, fn: (tx: unknown) => Promise<unknown>) => {
        systemDepth += 1;
        events.push("system:begin");
        try {
          return await fn({ scope: "system", root: database });
        } finally {
          events.push("system:commit");
          systemDepth -= 1;
        }
      },
    ),
    withTenant: vi.fn(
      async (
        database: unknown,
        _practiceId: string,
        fn: (tx: unknown) => Promise<unknown>,
        _options?: { isolationLevel?: "serializable" },
      ) => {
        tenantDepth += 1;
        events.push("tenant:begin");
        try {
          const result = await fn({
            scope: "tenant",
            root: database,
            execute: vi.fn(async () => {
              events.push("tenant:constraints");
              const error = executeErrors.shift();
              if (error) throw error;
              return [];
            }),
            update: vi.fn(() => ({
              set: () => ({
                where: () => ({
                  returning: async () => {
                    proofConsumptionUpdates += 1;
                    return [{ id: "proof-id" }];
                  },
                }),
              }),
            })),
            select: vi.fn(() => ({
              from: () => ({
                where: () => ({
                  limit: async () => [
                    {
                      tier: "cloud",
                      billingStatus: "active",
                      trialEndsAt: null,
                    },
                  ],
                }),
              }),
            })),
          });
          events.push("tenant:commit");
          return result;
        } catch (error) {
          events.push("tenant:rollback");
          throw error;
        } finally {
          tenantDepth -= 1;
        }
      },
    ),
    recordAuditLog: vi.fn(async () => undefined),
    db: {},
  };
});

vi.mock("@/lib/tenant-db", () => ({
  withSystem: mocks.withSystem,
  withTenant: mocks.withTenant,
}));
vi.mock("@/lib/audit", () => ({ recordAuditLog: mocks.recordAuditLog }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/auth-secret", () => ({
  hasBlankConfiguredNextAuthSecret: () => true,
}));
vi.mock("@/lib/rls-assertion", () => ({
  assertHostedRlsRoleOnce: vi.fn(async () => undefined),
}));
vi.mock("@/lib/billing/plans", () => ({
  billingEnforced: mocks.billingEnforced,
  hasHostedFullAccess: () => true,
  isEntitled: () => true,
  effectiveTier: () => "cloud",
}));
vi.mock("@openpims/db/client", () => ({ db: mocks.db }));

const { createRouter, protectedProcedure, publicProcedure } =
  await import("../trpc");
const { issuePrivilegedActionProof } =
  await import("@/lib/privileged-action-proof");

const router = createRouter({
  publicEffect: publicProcedure.mutation(({ ctx }) => {
    mocks.events.push("public:handler");
    ctx.postCommitEffect?.(async (rootDb) => {
      expect(rootDb).toBe((ctx.db as unknown as { root: unknown }).root);
      expect(mocks.systemDepth).toBe(0);
      mocks.events.push("public:effect");
    });
    return { ok: true };
  }),
  protectedEffect: protectedProcedure.mutation(({ ctx }) => {
    mocks.events.push("protected:handler");
    ctx.postCommitEffect?.(async (rootDb) => {
      expect(rootDb).toBe((ctx.db as unknown as { root: unknown }).root);
      expect(mocks.tenantDepth).toBe(0);
      mocks.events.push("protected:effect");
    });
    return { ok: true };
  }),
  patients: createRouter({
    merge: protectedProcedure.mutation(() => {
      const error = mocks.patientMergeResolverErrors.shift();
      if (error) throw error;
      return { ok: true };
    }),
  }),
  billing: createRouter({
    refundPayment: protectedProcedure.mutation(() => {
      const error = mocks.privilegedResolverErrors.shift();
      if (error) throw error;
      return { ok: true };
    }),
  }),
  data: createRouter({
    exportClients: protectedProcedure.query(() => ({ rows: 1 })),
  }),
});

afterEach(() => {
  mocks.events.length = 0;
  mocks.executeErrors.length = 0;
  mocks.patientMergeResolverErrors.length = 0;
  mocks.privilegedResolverErrors.length = 0;
  mocks.billingEnforced.mockReturnValue(false);
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("tRPC post-commit effects", () => {
  it("runs public mutation effects after the outer system transaction commits", async () => {
    const rootDb = { kind: "root-public" };
    const caller = router.createCaller({ db: rootDb, session: null } as never);

    await expect(caller.publicEffect()).resolves.toEqual({ ok: true });

    expect(mocks.events).toEqual([
      "system:begin",
      "public:handler",
      "system:commit",
      "public:effect",
    ]);
  });

  it("runs protected mutation effects after the outer tenant transaction commits", async () => {
    const rootDb = { kind: "root-tenant" };
    const caller = router.createCaller({
      db: rootDb,
      session: {
        user: {
          id: "user-1",
          email: "owner@example.com",
          name: "Owner",
          role: "admin",
          practiceId: "practice-1",
        },
      },
    } as never);

    await expect(caller.protectedEffect()).resolves.toEqual({ ok: true });

    const commitIndex = mocks.events.indexOf("tenant:commit");
    const effectIndex = mocks.events.indexOf("protected:effect");
    expect(commitIndex).toBeGreaterThan(-1);
    expect(effectIndex).toBeGreaterThan(commitIndex);
    expect(mocks.events.indexOf("tenant:constraints")).toBeLessThan(
      commitIndex,
    );
  });

  it("selects serializable isolation only for the patient merge path", async () => {
    const caller = router.createCaller({
      db: { kind: "root-tenant" },
      session: {
        user: {
          id: "user-1",
          email: "owner@example.com",
          name: "Owner",
          role: "admin",
          practiceId: "practice-1",
        },
      },
    } as never);

    await expect(caller.patients.merge()).resolves.toEqual({ ok: true });

    expect(mocks.withTenant).toHaveBeenLastCalledWith(
      expect.anything(),
      "practice-1",
      expect.any(Function),
      { isolationLevel: "serializable" },
    );
  });

  it.each([
    [
      { code: "40001" },
      "CONFLICT",
      "Patient records changed during the merge. Refresh both charts and retry.",
    ],
    [
      {
        code: "23505",
        constraint_name: "patient_merge_events_operation_uq",
      },
      "CONFLICT",
      "This patient merge conflicts with another completed operation. Refresh both charts before continuing.",
    ],
    [
      {
        code: "23514",
        message:
          "A canonical patient with incoming merge history cannot be retired.",
      },
      "PRECONDITION_FAILED",
      "The patient merge no longer satisfies the identity safety checks. Refresh both charts before continuing.",
    ],
    [
      {
        code: "23503",
        message:
          "Patient merge source and target must belong to the recorded client.",
      },
      "PRECONDITION_FAILED",
      "The patient merge no longer satisfies the identity safety checks. Refresh both charts before continuing.",
    ],
  ])(
    "maps patient merge database failures to stable typed responses",
    async (error, code, message) => {
      mocks.patientMergeResolverErrors.push(error);
      const caller = router.createCaller({
        db: { kind: "root-tenant" },
        session: {
          user: {
            id: "user-1",
            email: "owner@example.com",
            name: "Owner",
            role: "admin",
            practiceId: "practice-1",
          },
        },
      } as never);

      await expect(caller.patients.merge()).rejects.toMatchObject({
        code,
        message,
      });
    },
  );

  it("maps only the named deferred SOAP invariant and runs no audit or effect", async () => {
    mocks.executeErrors.push({
      code: "23514",
      constraint_name: "soap_notes_appointment_invariant",
    });
    const caller = router.createCaller({
      db: { kind: "root-tenant" },
      session: {
        user: {
          id: "user-1",
          email: "owner@example.com",
          name: "Owner",
          role: "admin",
          practiceId: "practice-1",
        },
      },
    } as never);

    await expect(caller.protectedEffect()).rejects.toMatchObject({
      code: "CONFLICT",
      message:
        "Clinical documentation changed in another session. Refresh and retry.",
    });
    expect(mocks.events).not.toContain("protected:effect");
    expect(mocks.recordAuditLog).not.toHaveBeenCalled();
  });

  it("does not mislabel unrelated check violations", async () => {
    const unrelated = {
      code: "23514",
      constraint_name: "some_other_check",
    };
    mocks.executeErrors.push(unrelated);
    const caller = router.createCaller({
      db: { kind: "root-tenant" },
      session: {
        user: {
          id: "user-1",
          email: "owner@example.com",
          name: "Owner",
          role: "admin",
          practiceId: "practice-1",
        },
      },
    } as never);

    const attempt = caller.protectedEffect();
    await expect(attempt).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
    await expect(attempt).rejects.not.toMatchObject({
      code: "CONFLICT",
      message:
        "Clinical documentation changed in another session. Refresh and retry.",
    });
    expect(mocks.events).not.toContain("protected:effect");
    expect(mocks.recordAuditLog).not.toHaveBeenCalled();
  });

  it("rolls back one-time proof consumption when a privileged resolver fails", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    vi.stubEnv(
      "PRIVILEGED_ACTION_SIGNING_KEY",
      Buffer.alloc(32, 11).toString("base64"),
    );
    const user = {
      id: "00000000-0000-0000-0000-000000000001",
      email: "owner@example.com",
      name: "Owner",
      role: "admin",
      practiceId: "00000000-0000-0000-0000-0000000000aa",
      sessionVersion: 1,
    };
    const { proof } = issuePrivilegedActionProof({
      action: "billing.refundPayment",
      userId: user.id,
      practiceId: user.practiceId,
      sessionVersion: user.sessionVersion,
    });
    mocks.privilegedResolverErrors.push(
      new Error("synthetic resolver failure"),
    );
    const caller = router.createCaller({
      db: { kind: "root-tenant" },
      session: { user },
      privilegedActionProof: proof,
    } as never);

    await expect(caller.billing.refundPayment()).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
    expect(mocks.proofConsumptionUpdates).toBe(1);
    expect(mocks.events).toContain("tenant:rollback");
    expect(mocks.events).not.toContain("tenant:commit");
    expect(mocks.recordAuditLog).not.toHaveBeenCalled();
  });

  it("consumes and audits proof for sensitive exports modeled as queries", async () => {
    mocks.billingEnforced.mockReturnValue(true);
    vi.stubEnv(
      "PRIVILEGED_ACTION_SIGNING_KEY",
      Buffer.alloc(32, 12).toString("base64"),
    );
    const user = {
      id: "00000000-0000-0000-0000-000000000001",
      email: "owner@example.com",
      name: "Owner",
      role: "admin",
      practiceId: "00000000-0000-0000-0000-0000000000aa",
      sessionVersion: 1,
    };
    const unconfirmed = router.createCaller({
      db: { kind: "root-tenant" },
      session: { user },
    } as never);
    await expect(unconfirmed.data.exportClients()).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });

    const { proof } = issuePrivilegedActionProof({
      action: "data.exportClients",
      userId: user.id,
      practiceId: user.practiceId,
      sessionVersion: user.sessionVersion,
    });
    const before = mocks.proofConsumptionUpdates;
    const confirmed = router.createCaller({
      db: { kind: "root-tenant" },
      session: { user },
      privilegedActionProof: proof,
    } as never);
    await expect(confirmed.data.exportClients()).resolves.toEqual({ rows: 1 });

    expect(mocks.proofConsumptionUpdates).toBe(before + 1);
    expect(mocks.events).toContain("tenant:commit");
    expect(mocks.recordAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ path: "data.exportClients" }),
    );
  });
});
