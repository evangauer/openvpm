import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  billingEnforced: vi.fn(() => true),
  rateLimit: vi.fn(async () => ({ success: true, remaining: 10, resetAt: new Date() })),
  saveBuildProgress: vi.fn(async () => ({ id: "lead-1" })),
  withSystem: vi.fn(async (_db: unknown, fn: (tx: unknown) => unknown) => fn({})),
}));

vi.mock("@openpims/db/client", () => ({ db: {} }));
vi.mock("@/lib/tenant-db", () => ({ withSystem: mocks.withSystem }));
vi.mock("@/lib/billing/plans", () => ({ billingEnforced: mocks.billingEnforced }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.rateLimit }));
vi.mock("@/lib/build/progress", () => ({ saveBuildProgress: mocks.saveBuildProgress }));

const { POST } = await import("./route");

const body = {
  email: " Dr.Ray@HarborView.test ",
  anonymousId: "11111111-1111-4111-8111-111111111111",
  scene: "services",
  disclosureVersion: "build-v1",
  state: {
    practiceType: "companion",
    currentSystem: "avimark",
    clinicName: "Harbor View",
    brandColor: "#e8590c",
    services: [{ name: "Wellness Exam", price: 65, on: true }],
  },
};

function post(payload: unknown, origin = "https://app.openvpm.com") {
  return new Request("https://app.openvpm.com/api/growth/build-save", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(payload),
  });
}

beforeEach(() => {
  mocks.billingEnforced.mockReturnValue(true);
});
afterEach(() => vi.clearAllMocks());

describe("POST /api/growth/build-save", () => {
  it("saves the build under the normalized email", async () => {
    const response = await POST(post(body));
    expect(response.status).toBe(200);
    expect(mocks.saveBuildProgress).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        email: "dr.ray@harborview.test",
        anonymousId: body.anonymousId,
        scene: "services",
        state: body.state,
      }),
    );
    expect(mocks.rateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ key: "build-save:email:dr.ray@harborview.test" }),
    );
  });

  it("refuses other origins, bad payloads, and self-hosted deployments", async () => {
    expect((await POST(post(body, "https://evil.example"))).status).toBe(403);
    expect((await POST(post({ ...body, scene: "nowhere" }))).status).toBe(400);
    expect((await POST(post({ ...body, disclosureVersion: "demo-followup-v2" }))).status).toBe(400);
    mocks.billingEnforced.mockReturnValue(false);
    expect((await POST(post(body))).status).toBe(404);
    expect(mocks.saveBuildProgress).not.toHaveBeenCalled();
  });

  it("stops repeated saves", async () => {
    mocks.rateLimit.mockResolvedValueOnce({ success: false, remaining: 0, resetAt: new Date() });
    expect((await POST(post(body))).status).toBe(429);
    expect(mocks.saveBuildProgress).not.toHaveBeenCalled();
  });
});
