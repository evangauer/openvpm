import { createHmac } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@/lib/admin/practice-tracking", () => ({ loadPracticeTracking: mocks.load }));
import { syncAtlasTracking } from "./atlas-tracking";
const db = {} as Parameters<typeof syncAtlasTracking>[0];
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetAllMocks(); });
function enable() {
  vi.stubEnv("ATLAS_OPENVPM_SYNC_ENABLED", "true");
  vi.stubEnv("HOSTED_BILLING_ENABLED", "true");
  vi.stubEnv("OPENVPM_ENVIRONMENT", "production");
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("ATLAS_OPENVPM_INTAKE_URL", "https://atlas.example.test/api/intake/openvpm/sync");
  vi.stubEnv("OPENVPM_USAGE_SECRET", "synthetic-dedicated-signing-key-12345678");
}
it("is disabled by default and cannot export from a preview or self-host", async () => {
  vi.stubEnv("ATLAS_OPENVPM_SYNC_ENABLED", "false");
  expect((await syncAtlasTracking(db)).status).toBe("disabled");
  enable(); vi.stubEnv("VERCEL_ENV", "preview");
  expect((await syncAtlasTracking(db)).status).toBe("disabled");
  vi.stubEnv("VERCEL_ENV", "production"); vi.stubEnv("HOSTED_BILLING_ENABLED", "false");
  expect((await syncAtlasTracking(db)).status).toBe("disabled");
  expect(mocks.load).not.toHaveBeenCalled();
});
it("signs exact bytes, sends every page to the fixed destination and checks acknowledgements", async () => {
  enable();
  const cursor = { createdAt: "2026-11-01T00:00:00Z", practiceId: "00000000-0000-4000-8000-000000000001" };
  mocks.load.mockResolvedValueOnce({ snapshotAt: "2026-11-08T17:00:00Z", practices: [{ practiceId: cursor.practiceId }], nextCursor: cursor })
    .mockResolvedValueOnce({ snapshotAt: "2026-11-08T17:00:00Z", practices: [], nextCursor: null });
  const fetcher=vi.fn(async () => Response.json({ accepted: 1 }));
  vi.stubGlobal("fetch",fetcher);
  expect(await syncAtlasTracking(db)).toEqual({ status: "ok", accepted: 1 });
  const [url,init] = fetcher.mock.calls[0] as unknown as [string,RequestInit];
  expect(url).toBe("https://atlas.example.test/api/intake/openvpm/sync");
  expect(init.redirect).toBe("error");
  const headers=init.headers as Record<string,string>;
  expect(headers["x-atlas-signature"]).toBe("sha256="+createHmac("sha256",process.env.OPENVPM_USAGE_SECRET!).update(headers["x-atlas-timestamp"]+"."+init.body).digest("hex"));
  expect(mocks.load.mock.calls[1][1].cursor).toEqual(cursor);
});
it("fails visibly on a partial acknowledgement", async () => {
  enable(); mocks.load.mockResolvedValue({ snapshotAt: "2026-11-08T17:00:00Z", practices: [{}], nextCursor: null });
  vi.stubGlobal("fetch",vi.fn(async()=>Response.json({accepted:0})));
  await expect(syncAtlasTracking(db)).rejects.toThrow("complete page");
});
