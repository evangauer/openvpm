import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const execute = vi.fn(async () => [{ id: "lead-1", created: true }]);
  const db = { execute };
  return {
    db,
    execute,
    withSystem: vi.fn(async (_db: unknown, fn: (tx: unknown) => unknown) =>
      fn(db),
    ),
  };
});

vi.mock("@openpims/db/client", () => ({ db: mocks.db }));
vi.mock("@/lib/tenant-db", () => ({ withSystem: mocks.withSystem }));

const { POST } = await import("./route");

const SECRET = "lead-capture-secret-at-least-32-bytes!";
const ANONYMOUS_ID = "11111111-1111-4111-8111-111111111111";

function post(body: unknown, authorization = `Bearer ${SECRET}`) {
  return new Request("https://app.openvpm.com/api/growth/leads", {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization },
    body: JSON.stringify(body),
  });
}

const validBody = {
  source: "demo",
  email: "Vet@Clinic.com",
  anonymousId: ANONYMOUS_ID,
  disclosureVersion: "demo-followup-v2",
};

beforeEach(() => vi.stubEnv("LEAD_CAPTURE_SECRET", SECRET));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("POST /api/growth/leads", () => {
  it("stores an authenticated demo lead", async () => {
    const response = await POST(post(validBody));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, created: true });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it("is disabled without a configured secret", async () => {
    vi.stubEnv("LEAD_CAPTURE_SECRET", "");
    const response = await POST(post(validBody));
    expect(response.status).toBe(404);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("rejects a wrong secret", async () => {
    const response = await POST(post(validBody, "Bearer nope"));
    expect(response.status).toBe(401);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("rejects unknown disclosures, sources, and extra fields", async () => {
    for (const body of [
      { ...validBody, disclosureVersion: "made-up" },
      { ...validBody, source: "newsletter" },
      { ...validBody, name: "extra" },
      { ...validBody, email: "not-an-email" },
    ]) {
      const response = await POST(post(body));
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("reports storage failures without leaking detail", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.execute.mockRejectedValueOnce(new Error("db down"));
    const response = await POST(post(validBody));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ ok: false });
    errorSpy.mockRestore();
  });
});
