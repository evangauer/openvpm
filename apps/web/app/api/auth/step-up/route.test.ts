import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  rateLimit: vi.fn(async () => ({ success: true })),
  withTenant: vi.fn(),
  withSystem: vi.fn(async () => undefined),
  recordAuditLog: vi.fn(async () => undefined),
  compare: vi.fn(async () => true),
  decryptMfaSecret: vi.fn(() => "totp-secret"),
  matchingTotpCounter: vi.fn(() => 123),
  consumeRecoveryCodeHash: vi.fn(() => ({
    accepted: false,
    remaining: [],
  })),
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
vi.mock("bcryptjs", () => ({ compare: mocks.compare }));
vi.mock("@/lib/mfa", () => ({
  decryptMfaSecret: mocks.decryptMfaSecret,
  matchingTotpCounter: mocks.matchingTotpCounter,
  consumeRecoveryCodeHash: mocks.consumeRecoveryCodeHash,
}));

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
    vi.stubEnv(
      "PRIVILEGED_ACTION_SIGNING_KEY",
      Buffer.alloc(32, 6).toString("base64"),
    );
    const { proof, record } = issuePrivilegedActionProof({
      action: "billing.refundPayment",
      userId: activeSession.user.id,
      practiceId: activeSession.user.practiceId,
      sessionVersion: activeSession.user.sessionVersion,
    });
    mocks.withTenant.mockImplementationOnce(
      async (_db, _practiceId, callback) =>
        callback({
          select: () => ({
            from: () => ({
              where: () => ({ limit: async () => [{ id: record.id }] }),
            }),
          }),
        }),
    );
    mocks.getServerSession.mockResolvedValueOnce(activeSession);
    const response = await GET(
      new Request(
        "https://preview.example.test/api/auth/step-up?action=billing.refundPayment",
        { headers: { cookie: `${PRIVILEGED_ACTION_COOKIE}=${proof}` } },
      ),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      action: "billing.refundPayment",
      active: true,
    });

    mocks.getServerSession.mockResolvedValueOnce({
      user: { ...activeSession.user, sessionVersion: 3 },
    });
    const staleResponse = await GET(
      new Request(
        "https://preview.example.test/api/auth/step-up?action=billing.refundPayment",
        { headers: { cookie: `${PRIVILEGED_ACTION_COOKIE}=${proof}` } },
      ),
    );
    await expect(staleResponse.json()).resolves.toEqual({
      ok: true,
      action: "billing.refundPayment",
      active: false,
    });
  });

  it("atomically records one exact action after fresh-factor confirmation", async () => {
    vi.stubEnv(
      "PRIVILEGED_ACTION_SIGNING_KEY",
      Buffer.alloc(32, 6).toString("base64"),
    );
    vi.stubEnv("MFA_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    mocks.getServerSession.mockResolvedValueOnce(activeSession);
    const insertValues = vi.fn(() => ({
      returning: async () => [{ id: "proof-id" }],
    }));
    const updateSet = vi.fn(() => ({
      where: () => ({ returning: async () => [{ id: activeSession.user.id }] }),
    }));
    mocks.withTenant.mockImplementationOnce(
      async (_db, _practiceId, callback) =>
        callback({
          select: () => ({
            from: () => ({
              where: () => ({
                limit: async () => [
                  {
                    id: activeSession.user.id,
                    passwordHash: "hash",
                    sessionVersion: activeSession.user.sessionVersion,
                    mfaSecretEncrypted: "encrypted",
                    mfaEnabledAt: new Date(),
                    mfaLastUsedTotpCounter: 122,
                    mfaRecoveryCodeHashes: [],
                  },
                ],
              }),
            }),
          }),
          update: () => ({ set: updateSet }),
          insert: () => ({ values: insertValues }),
        }),
    );

    const response = await POST(
      postRequest(
        JSON.stringify({
          action: "billing.refundPayment",
          password: "secret",
          code: "123456",
        }),
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      action: "billing.refundPayment",
      expiresInSeconds: 300,
    });
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "billing.refundPayment",
        factorType: "totp",
        nonceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
    expect(response.headers.get("set-cookie")).toContain(
      `${PRIVILEGED_ACTION_COOKIE}=v2.`,
    );
  });
});
