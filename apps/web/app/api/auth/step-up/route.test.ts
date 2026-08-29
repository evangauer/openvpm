import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  rateLimit: vi.fn(async () => ({ success: true })),
  withTenant: vi.fn(),
  withSystem: vi.fn(async () => undefined),
  recordAuditLog: vi.fn(async () => undefined),
}));

vi.mock("next-auth", () => ({ getServerSession: mocks.getServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.rateLimit }));
vi.mock("@/lib/tenant-db", () => ({
  withTenant: mocks.withTenant,
  withSystem: mocks.withSystem,
}));
vi.mock("@/lib/audit", () => ({ recordAuditLog: mocks.recordAuditLog }));
vi.mock("@openpims/db/client", () => ({ db: {} }));

const { GET, POST } = await import("./route");
const { issuePrivilegedActionProof, PRIVILEGED_ACTION_COOKIE } =
  await import("@/lib/privileged-action-proof");

const activeSession = {
  user: {
    id: "00000000-0000-0000-0000-000000000001",
    practiceId: "00000000-0000-0000-0000-0000000000aa",
    sessionVersion: 2,
  },
};

function postRequest(body = "{}", headers?: HeadersInit) {
  return new Request("https://preview.example.test/api/auth/step-up", {
    method: "POST",
    headers: {
      origin: "https://preview.example.test",
      "content-type": "application/json",
      ...headers,
    },
    body,
  });
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("privileged action step-up route", () => {
  it("rejects cross-origin requests before reading session or credentials", async () => {
    const response = await POST(
      postRequest('{"password":"secret","code":"123456"}', {
        origin: "https://attacker.example",
      }),
    );

    expect(response.status).toBe(403);
    expect(mocks.getServerSession).not.toHaveBeenCalled();
    expect(mocks.rateLimit).not.toHaveBeenCalled();
  });

  it("requires an active session and a small valid JSON body", async () => {
    mocks.getServerSession.mockResolvedValueOnce(null);
    expect((await POST(postRequest())).status).toBe(401);

    mocks.getServerSession.mockResolvedValueOnce(activeSession);
    const oversized = postRequest("{}", { "content-length": "2049" });
    expect((await POST(oversized)).status).toBe(400);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.withTenant).not.toHaveBeenCalled();
  });

  it("reports only a proof bound to the current session as active", async () => {
    vi.stubEnv("MFA_ENCRYPTION_KEY", Buffer.alloc(32, 6).toString("base64"));
    const proof = issuePrivilegedActionProof({
      userId: activeSession.user.id,
      practiceId: activeSession.user.practiceId,
      sessionVersion: activeSession.user.sessionVersion,
    });
    mocks.getServerSession.mockResolvedValueOnce(activeSession);
    const response = await GET(
      new Request("https://preview.example.test/api/auth/step-up", {
        headers: { cookie: `${PRIVILEGED_ACTION_COOKIE}=${proof}` },
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, active: true });

    mocks.getServerSession.mockResolvedValueOnce({
      user: { ...activeSession.user, sessionVersion: 3 },
    });
    const staleResponse = await GET(
      new Request("https://preview.example.test/api/auth/step-up", {
        headers: { cookie: `${PRIVILEGED_ACTION_COOKIE}=${proof}` },
      }),
    );
    await expect(staleResponse.json()).resolves.toEqual({
      ok: true,
      active: false,
    });
  });
});
