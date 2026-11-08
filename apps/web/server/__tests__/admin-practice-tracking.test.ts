import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ load: vi.fn(async () => ({ practices: [], nextCursor: null })), db: {} }));
vi.mock("@openpims/db/client", () => ({ db: mocks.db }));
vi.mock("@/lib/admin/practice-tracking", () => ({ loadPracticeTracking: mocks.load }));
vi.mock("@/lib/tenant-db", () => ({
  withTenant: vi.fn(async (database: unknown, _id: string, fn: (tx: unknown) => unknown) => fn(database)),
  withSystem: vi.fn(async (database: unknown, fn: (tx: unknown) => unknown) => fn(database)),
}));
const { adminRouter } = await import("../routers/admin");
const caller = (email: string) => adminRouter.createCaller({
  db: mocks.db, session: { user: { id: "00000000-0000-4000-8000-000000000001", email, role: "admin", practiceId: "00000000-0000-4000-8000-000000000002" } },
} as never);
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
it("denies a clinic admin before reading cross-tenant evidence", async () => {
  vi.stubEnv("PLATFORM_ADMIN_EMAILS", "ops@example.test");
  await expect(caller("clinic@example.test").practiceTracking()).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(mocks.load).not.toHaveBeenCalled();
});
it("forwards a bounded page only for an allowlisted operator", async () => {
  vi.stubEnv("PLATFORM_ADMIN_EMAILS", "ops@example.test");
  await caller("ops@example.test").practiceTracking({ limit: 25 });
  expect(mocks.load).toHaveBeenCalledWith(mocks.db, { limit: 25 });
  await expect(caller("ops@example.test").practiceTracking({ limit: 1000 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
});
