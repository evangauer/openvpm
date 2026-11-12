import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const execute = vi.fn(async () => [{ name: "Neighborhood Veterinary" }]);
  const db = { execute };
  return {
    db,
    execute,
    withSystem: vi.fn(async (_db: unknown, fn: (tx: unknown) => unknown) =>
      fn(db),
    ),
    notifyLeadHandRaise: vi.fn(async () => true),
  };
});

vi.mock("@openpims/db/client", () => ({ db: mocks.db }));
vi.mock("@/lib/tenant-db", () => ({ withSystem: mocks.withSystem }));
vi.mock("@/lib/growth/lead-alerts", () => ({
  notifyLeadHandRaise: mocks.notifyLeadHandRaise,
}));

const { POST } = await import("./route");
const { createNpsToken } = await import("@/lib/growth/nps-token");
const { createStopReasonToken } = await import(
  "@/lib/growth/stop-reason-token"
);

const PRACTICE_ID = "00000000-0000-4000-8000-0000000000aa";

function post(fields: Record<string, string>) {
  return new Request("https://app.openvpm.com/api/growth/nps", {
    method: "POST",
    body: new URLSearchParams(fields),
  });
}

function location(response: Response): URL {
  return new URL(response.headers.get("location")!);
}

beforeEach(() => {
  vi.stubEnv(
    "EMAIL_PREFERENCE_SIGNING_SECRET",
    "stable-signing-secret-at-least-32-bytes",
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("POST /api/growth/nps", () => {
  it("saves a promoter's score without paging anyone", async () => {
    const token = createNpsToken(PRACTICE_ID, "nps:1")!;

    const response = await POST(post({ token, score: "10" }));

    expect(response.status).toBe(303);
    expect(location(response).pathname).toBe("/feedback/nps");
    expect(location(response).searchParams.get("saved")).toBe("10");
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.notifyLeadHandRaise).not.toHaveBeenCalled();
  });

  it("alerts the team about a detractor, with their comment", async () => {
    const token = createNpsToken(PRACTICE_ID, "nps:1")!;

    await POST(post({ token, score: "4", comment: "  Reports are slow. " }));

    expect(mocks.notifyLeadHandRaise).toHaveBeenCalledWith({
      practiceId: PRACTICE_ID,
      practiceName: "Neighborhood Veterinary",
      summary: "NPS 4 (detractor)",
      note: "Reports are slow.",
    });
  });

  it("rejects stop-reason tokens and out-of-range scores", async () => {
    const stopToken = createStopReasonToken(PRACTICE_ID)!;
    const wrongPurpose = await POST(post({ token: stopToken, score: "9" }));
    expect(location(wrongPurpose).searchParams.get("token")).toBe("");

    const token = createNpsToken(PRACTICE_ID, "nps:1")!;
    for (const score of ["11", "-1", "7.5", ""]) {
      const response = await POST(post({ token, score }));
      expect(location(response).searchParams.has("saved")).toBe(false);
    }
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("treats a deleted clinic like an expired link", async () => {
    mocks.execute.mockResolvedValueOnce([]);
    const token = createNpsToken(PRACTICE_ID, "nps:1")!;

    const response = await POST(post({ token, score: "8" }));

    expect(location(response).searchParams.get("token")).toBe("");
    expect(mocks.notifyLeadHandRaise).not.toHaveBeenCalled();
  });
});
