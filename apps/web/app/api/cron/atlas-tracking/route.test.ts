import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ sync: vi.fn(), heartbeat: vi.fn(async () => undefined) }));
vi.mock("@openpims/db/client", () => ({ db: {} }));
vi.mock("@/lib/integrations/atlas-tracking", () => ({ syncAtlasTracking: mocks.sync }));
vi.mock("@/lib/cron-heartbeat", () => ({ reportCronHeartbeat: mocks.heartbeat }));
import { GET } from "./route";
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
it("refuses unauthenticated account exports", async () => {
  vi.stubEnv("CRON_SECRET", "synthetic-cron-secret");
  expect((await GET(new Request("http://localhost/api/cron/atlas-tracking"))).status).toBe(401);
  expect(mocks.sync).not.toHaveBeenCalled();
});
it("reports a failed sync without returning private payloads or provider errors", async () => {
  vi.stubEnv("CRON_SECRET", "synthetic-cron-secret");
  mocks.sync.mockRejectedValue(new Error("PRIVATE_UPSTREAM_DETAIL"));
  const response=await GET(new Request("http://localhost/api/cron/atlas-tracking",{headers:{Authorization:"Bearer synthetic-cron-secret"}}));
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain("PRIVATE_UPSTREAM_DETAIL");
  expect(mocks.heartbeat).toHaveBeenCalledWith(expect.objectContaining({status:"failed"}));
});
