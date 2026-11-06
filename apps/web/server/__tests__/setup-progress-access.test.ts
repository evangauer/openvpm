import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ recordAuditLog: vi.fn() }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/tenant-db", () => ({
  withSystem: async (db: unknown, fn: (tx: unknown) => unknown) => fn(db),
  withTenant: async (db: unknown, _practice: string, fn: (tx: unknown) => unknown) => fn(db),
}));
const { createRouter, protectedProcedure, requireRole } = await import("../trpc");
const router = createRouter({
  settings: createRouter({ setJourneyProgress: protectedProcedure.use(requireRole("admin")).mutation(() => "saved") }),
  clients: createRouter({ create: protectedProcedure.mutation(() => "created") }),
});
function caller(role = "admin", recoveryHold = false) {
  const db = {
    execute: vi.fn(),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{
      tier: "free", billingStatus: "none", trialEndsAt: null, stripeSubscriptionId: null,
    }] }) }) }),
  };
  return router.createCaller({ db, session: { user: {
    id: "00000000-0000-4000-8000-000000000001", practiceId: "00000000-0000-4000-8000-000000000002",
    email: "owner@example.invalid", name: "Synthetic owner", role, recoveryHold,
  } } } as never);
}
afterEach(() => vi.unstubAllEnvs());
describe("setup progress before checkout", () => {
  it("allows the admin to save progress while clinical writes remain blocked", async () => {
    vi.stubEnv("HOSTED_BILLING_ENABLED", "true");
    await expect(caller().settings.setJourneyProgress()).resolves.toBe("saved");
    await expect(caller().clients.create()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it.each(["viewer", "front_desk"])("preserves the %s role boundary", async role => {
    vi.stubEnv("HOSTED_BILLING_ENABLED", "true");
    await expect(caller(role).settings.setJourneyProgress()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("preserves recovery holds", async () => {
    vi.stubEnv("HOSTED_BILLING_ENABLED", "true");
    await expect(caller("admin", true).settings.setJourneyProgress()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
