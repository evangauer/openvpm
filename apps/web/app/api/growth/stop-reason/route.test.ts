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
const { createStopReasonToken } = await import(
  "@/lib/growth/stop-reason-token"
);

const PRACTICE_ID = "00000000-0000-4000-8000-0000000000aa";

function post(fields: Record<string, string>) {
  return new Request("https://app.openvpm.com/api/growth/stop-reason", {
    method: "POST",
    body: new URLSearchParams(fields),
  });
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

describe("POST /api/growth/stop-reason", () => {
  it("records the reason, alerts the team, and shows the thank-you page", async () => {
    const token = createStopReasonToken(PRACTICE_ID)!;

    const response = await POST(
      post({ token, reason: "card", note: "  Wanted to look around first. " }),
    );

    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/feedback/stop-reason");
    expect(location.searchParams.get("saved")).toBe("card");
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.notifyLeadHandRaise).toHaveBeenCalledWith({
      practiceId: PRACTICE_ID,
      practiceName: "Neighborhood Veterinary",
      summary: "Stopped before trial: I didn't want to enter a card yet",
      note: "Wanted to look around first.",
    });
  });

  it("rejects a forged or missing token without writing", async () => {
    const response = await POST(post({ token: "forged.token", reason: "card" }));

    expect(response.status).toBe(303);
    expect(
      new URL(response.headers.get("location")!).searchParams.get("saved"),
    ).toBeNull();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.notifyLeadHandRaise).not.toHaveBeenCalled();
  });

  it("sends an unknown reason back to the form", async () => {
    const token = createStopReasonToken(PRACTICE_ID)!;

    const response = await POST(post({ token, reason: "spam" }));

    expect(
      new URL(response.headers.get("location")!).searchParams.get("token"),
    ).toBe(token);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("does not alert for a deleted practice", async () => {
    mocks.execute.mockResolvedValueOnce([]);
    const token = createStopReasonToken(PRACTICE_ID)!;

    await POST(post({ token, reason: "timing" }));

    expect(mocks.notifyLeadHandRaise).not.toHaveBeenCalled();
  });
});
