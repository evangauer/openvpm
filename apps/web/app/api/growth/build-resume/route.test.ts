import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readBuildProgress: vi.fn(),
  withSystem: vi.fn(async (_db: unknown, fn: (tx: unknown) => unknown) => fn({})),
}));

vi.mock("@openpims/db/client", () => ({ db: {} }));
vi.mock("@/lib/tenant-db", () => ({ withSystem: mocks.withSystem }));
vi.mock("@/lib/build/progress", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/build/progress")>()),
  readBuildProgress: mocks.readBuildProgress,
}));

const { GET } = await import("./route");
const { createBuildResumeToken } = await import("@/lib/build/progress");
const LEAD = "00000000-0000-4000-8000-0000000000aa";

beforeEach(() => {
  vi.stubEnv("EMAIL_PREFERENCE_SIGNING_SECRET", "stable-signing-secret-at-least-32-bytes");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("GET /api/growth/build-resume", () => {
  it("returns the saved build behind a valid link", async () => {
    mocks.readBuildProgress.mockResolvedValueOnce({
      state: { clinicName: "Harbor View" },
      scene: "visit",
      savedAt: "2026-11-05T18:00:00Z",
      disclosureVersion: "build-v2",
    });
    const token = createBuildResumeToken(LEAD)!;
    const response = await GET(
      new Request(`https://app.openvpm.com/api/growth/build-resume?token=${encodeURIComponent(token)}`),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: { clinicName: "Harbor View" }, scene: "visit" });
    expect(mocks.readBuildProgress).toHaveBeenCalledWith({}, LEAD);
  });

  it("refuses bad links and missing builds", async () => {
    expect(
      (await GET(new Request("https://app.openvpm.com/api/growth/build-resume?token=nope"))).status,
    ).toBe(404);
    mocks.readBuildProgress.mockResolvedValueOnce(null);
    const token = createBuildResumeToken(LEAD)!;
    expect(
      (await GET(new Request(`https://app.openvpm.com/api/growth/build-resume?token=${encodeURIComponent(token)}`))).status,
    ).toBe(404);
  });
});
