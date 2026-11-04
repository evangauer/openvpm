import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  role: "admin",
  jwtRole: "admin",
  jwtSessionVersion: undefined as number | undefined,
  sessionVersion: 1,
  accountFound: true,
  practice: { recoveryHold: false, tier: "free", billingStatus: "none", trialEndsAt: null as Date | null },
}));
vi.mock("next-auth", () => ({
  getServerSession: vi.fn(async () => ({
    user: { id: "user_1", role: mocks.jwtRole, practiceId: "practice_1", sessionVersion: mocks.jwtSessionVersion },
  })),
}));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`redirect:${path}`); } }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@openpims/db/client", () => ({ db: {} }));
vi.mock("@/lib/tenant-db", () => ({
  withTenant: async (_db: unknown, _id: string, fn: (tx: unknown) => unknown) => {
    const row = { ...mocks.practice, role: mocks.role, sessionVersion: mocks.sessionVersion };
    const builder = {
      from: () => builder,
      innerJoin: () => builder,
      where: () => builder,
      limit: async () => (mocks.accountFound ? [row] : []),
    };
    return fn({ select: () => builder });
  },
}));
const { default: PostLoginPage } = await import("./page");
beforeEach(() => {
  vi.stubEnv("HOSTED_BILLING_ENABLED", "true");
  mocks.role = "admin";
  mocks.jwtRole = "admin";
  mocks.jwtSessionVersion = undefined;
  mocks.sessionVersion = 1;
  mocks.accountFound = true;
  mocks.practice = { recoveryHold: false, tier: "free", billingStatus: "none", trialEndsAt: null };
});
afterEach(() => vi.unstubAllEnvs());

describe("billing-aware sign-in landing", () => {
  it("lets an admin resume unfinished checkout", async () => {
    await expect(PostLoginPage()).rejects.toThrow("redirect:/settings?tab=billing");
  });
  it("keeps staff on their existing read-only dashboard", async () => {
    mocks.role = "receptionist";
    await expect(PostLoginPage()).rejects.toThrow("redirect:/");
  });
  it("preserves the protected recovery landing", async () => {
    mocks.practice.recoveryHold = true;
    await expect(PostLoginPage()).rejects.toThrow("redirect:/migration-archive");
  });
  it("keeps self-hosting ungated", async () => {
    vi.stubEnv("HOSTED_BILLING_ENABLED", "false");
    await expect(PostLoginPage()).rejects.toThrow("redirect:/");
  });
  it("allows an existing unexpired trial without changing its expiry", async () => {
    mocks.practice.billingStatus = "trialing";
    mocks.practice.trialEndsAt = new Date(Date.now() + 86_400_000);
    await expect(PostLoginPage()).rejects.toThrow("redirect:/");
  });
  it("lets an active paid clinic open its dashboard", async () => {
    mocks.practice.tier = "cloud";
    mocks.practice.billingStatus = "active";
    await expect(PostLoginPage()).rejects.toThrow("redirect:/");
  });
  it("uses the current database role, not the sign-in snapshot", async () => {
    mocks.jwtRole = "front_desk";
    await expect(PostLoginPage()).rejects.toThrow("redirect:/settings?tab=billing");
    mocks.jwtRole = "admin";
    mocks.role = "front_desk";
    await expect(PostLoginPage()).rejects.toThrow("redirect:/");
  });
  it("sends revoked sessions back to sign-in", async () => {
    mocks.jwtSessionVersion = 1;
    mocks.sessionVersion = 2;
    await expect(PostLoginPage()).rejects.toThrow("redirect:/login");
  });
  it("sends sessions issued before versioning to sign-in once the account was bumped", async () => {
    mocks.sessionVersion = 2;
    await expect(PostLoginPage()).rejects.toThrow("redirect:/login");
  });
  it("sends deactivated accounts back to sign-in", async () => {
    mocks.accountFound = false;
    await expect(PostLoginPage()).rejects.toThrow("redirect:/login");
  });
});
