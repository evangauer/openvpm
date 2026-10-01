import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  role: "admin",
  practice: { recoveryHold: false, tier: "free", billingStatus: "none", trialEndsAt: null as Date | null },
}));
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => ({ user: { role: mocks.role, practiceId: "practice_1" } })) }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`redirect:${path}`); } }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@openpims/db/client", () => ({ db: {} }));
vi.mock("@/lib/tenant-db", () => ({
  withTenant: async (_db: unknown, _id: string, fn: (tx: unknown) => unknown) => {
    const builder = { from: () => builder, where: () => builder, limit: async () => [mocks.practice] };
    return fn({ select: () => builder });
  },
}));
const { default: PostLoginPage } = await import("./page");
beforeEach(() => {
  vi.stubEnv("HOSTED_BILLING_ENABLED", "true");
  mocks.role = "admin";
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
});
