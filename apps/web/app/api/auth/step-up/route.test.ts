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
  activeWebAuthnCredentials: vi.fn(async () => [] as unknown[]),
  beginWebAuthnAuthentication: vi.fn(async () => ({
    challengeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    expiresAt: new Date("2030-01-01T00:05:00.000Z"),
    options: { challenge: "browser-challenge", rpId: "preview.example.test" },
  })),
  finishWebAuthnAuthentication: vi.fn(async () => ({
    credentialRowId: "credential-row-id",
  })),
  webauthnConfiguration: vi.fn(() => ({
    origins: ["https://preview.example.test"],
    policy: "required",
    rpID: "preview.example.test",
    rpName: "OpenVPM",
  })),
  passkeyRequiredForIdentity: vi.fn(() => false),
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

vi.mock("@/lib/webauthn-ceremony", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/webauthn-ceremony")
  >("@/lib/webauthn-ceremony");
  return {
    ...actual,
    activeWebAuthnCredentials: mocks.activeWebAuthnCredentials,
    beginWebAuthnAuthentication: mocks.beginWebAuthnAuthentication,
    finishWebAuthnAuthentication: mocks.finishWebAuthnAuthentication,
  };
});

vi.mock("@/lib/webauthn-config", () => ({
  passkeyRequiredForIdentity: mocks.passkeyRequiredForIdentity,
  webauthnConfiguration: mocks.webauthnConfiguration,
}));

const { GET, POST, PUT } = await import("./route");
const { issuePrivilegedActionProof, PRIVILEGED_ACTION_COOKIE } =
  await import("@/lib/privileged-action-proof");

const activeSession = {
  user: {
    id: "00000000-0000-0000-0000-000000000001",
    email: "admin@example.com",
    name: "Admin User",
    role: "admin",
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

function putRequest(body = "{}", headers?: HeadersInit) {
  return new Request("https://preview.example.test/api/auth/step-up", {
    method: "PUT",
    headers: {
      origin: "https://preview.example.test",
      "content-type": "application/json",
      ...headers,
    },
    body,
  });
}

const passkeyResponse = {
  id: "credential_id",
  rawId: "credential_id",
  type: "public-key" as const,
  clientExtensionResults: {},
  response: {
    clientDataJSON: "client_data",
    authenticatorData: "authenticator_data",
    signature: "signature",
  },
};

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.rateLimit.mockResolvedValue({ success: true });
  mocks.activeWebAuthnCredentials.mockResolvedValue([]);
  mocks.passkeyRequiredForIdentity.mockReturnValue(false);
  mocks.webauthnConfiguration.mockReturnValue({
    origins: ["https://preview.example.test"],
    policy: "required",
    rpID: "preview.example.test",
    rpName: "OpenVPM",
  });
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

  it("issues a throttled exact-action passkey challenge for a current session", async () => {
    mocks.getServerSession.mockResolvedValueOnce(activeSession);
    mocks.activeWebAuthnCredentials.mockResolvedValueOnce([
      { id: "credential-row-id", credentialId: "credential_id" },
    ]);
    mocks.withTenant.mockImplementationOnce(
      async (_db, _practiceId, callback) =>
        callback({
          select: () => ({
            from: () => ({
              where: () => ({ limit: async () => [{ sessionVersion: 2 }] }),
            }),
          }),
        }),
    );

    const response = await PUT(
      putRequest(JSON.stringify({ action: "billing.refundPayment" })),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      action: "billing.refundPayment",
      factor: "passkey",
      challengeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    expect(mocks.rateLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        key: expect.stringContaining("step-up-options:"),
        limit: 20,
      }),
    );
    expect(mocks.beginWebAuthnAuthentication).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "billing.refundPayment",
        purpose: "privileged_action",
        identity: expect.objectContaining({ sessionVersion: 2 }),
      }),
    );
  });

  it("rejects challenge issuance from a stale session generation", async () => {
    mocks.getServerSession.mockResolvedValueOnce(activeSession);
    mocks.withTenant.mockImplementationOnce(
      async (_db, _practiceId, callback) =>
        callback({
          select: () => ({
            from: () => ({ where: () => ({ limit: async () => [] }) }),
          }),
        }),
    );

    const response = await PUT(
      putRequest(JSON.stringify({ action: "billing.refundPayment" })),
    );

    expect(response.status).toBe(401);
    expect(mocks.beginWebAuthnAuthentication).not.toHaveBeenCalled();
  });

  it("does not offer or accept TOTP fallback for a required-mode identity without a passkey", async () => {
    vi.stubEnv(
      "PRIVILEGED_ACTION_SIGNING_KEY",
      Buffer.alloc(32, 6).toString("base64"),
    );
    mocks.passkeyRequiredForIdentity.mockReturnValue(true);
    mocks.getServerSession.mockResolvedValueOnce(activeSession);
    mocks.withTenant.mockImplementationOnce(
      async (_db, _practiceId, callback) =>
        callback({
          select: () => ({
            from: () => ({
              where: () => ({
                limit: async () => [
                  {
                    email: activeSession.user.email,
                    role: activeSession.user.role,
                    sessionVersion: activeSession.user.sessionVersion,
                  },
                ],
              }),
            }),
          }),
        }),
    );

    const optionsResponse = await PUT(
      putRequest(JSON.stringify({ action: "billing.refundPayment" })),
    );
    expect(optionsResponse.status).toBe(409);
    expect(mocks.beginWebAuthnAuthentication).not.toHaveBeenCalled();

    mocks.getServerSession.mockResolvedValueOnce(activeSession);
    const insertValues = vi.fn();
    mocks.withTenant.mockImplementationOnce(
      async (_db, _practiceId, callback) =>
        callback({
          select: () => ({
            from: () => ({
              where: () => ({
                limit: async () => [
                  {
                    id: activeSession.user.id,
                    email: activeSession.user.email,
                    name: activeSession.user.name,
                    role: activeSession.user.role,
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
          insert: () => ({ values: insertValues }),
        }),
    );

    const confirmationResponse = await POST(
      postRequest(
        JSON.stringify({
          action: "billing.refundPayment",
          password: "secret",
          code: "123456",
        }),
      ),
    );
    expect(confirmationResponse.status).toBe(401);
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("stores a passkey proof only after rollback-safe verification", async () => {
    vi.stubEnv(
      "PRIVILEGED_ACTION_SIGNING_KEY",
      Buffer.alloc(32, 6).toString("base64"),
    );
    mocks.getServerSession.mockResolvedValueOnce(activeSession);
    mocks.activeWebAuthnCredentials.mockResolvedValueOnce([
      { id: "credential-row-id", credentialId: "credential_id" },
    ]);
    const insertValues = vi.fn(() => ({
      returning: async () => [{ id: "proof-id" }],
    }));
    const transaction = vi.fn(async (callback) => callback({}));
    mocks.withTenant.mockImplementationOnce(
      async (_db, _practiceId, callback) =>
        callback({
          transaction,
          select: () => ({
            from: () => ({
              where: () => ({
                limit: async () => [
                  {
                    id: activeSession.user.id,
                    email: activeSession.user.email,
                    name: activeSession.user.name,
                    role: activeSession.user.role,
                    passwordHash: "hash",
                    sessionVersion: activeSession.user.sessionVersion,
                  },
                ],
              }),
            }),
          }),
          insert: () => ({ values: insertValues }),
        }),
    );

    const response = await POST(
      postRequest(
        JSON.stringify({
          action: "billing.refundPayment",
          password: "secret",
          passkeyChallengeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          passkeyResponse,
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(transaction).toHaveBeenCalledOnce();
    expect(mocks.finishWebAuthnAuthentication).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "billing.refundPayment",
        purpose: "privileged_action",
      }),
    );
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ factorType: "passkey" }),
    );
  });

  it("does not store a proof when passkey verification rolls back", async () => {
    vi.stubEnv(
      "PRIVILEGED_ACTION_SIGNING_KEY",
      Buffer.alloc(32, 6).toString("base64"),
    );
    mocks.getServerSession.mockResolvedValueOnce(activeSession);
    mocks.activeWebAuthnCredentials.mockResolvedValueOnce([
      { id: "credential-row-id", credentialId: "credential_id" },
    ]);
    mocks.finishWebAuthnAuthentication.mockRejectedValueOnce(
      new Error("invalid signature"),
    );
    const insertValues = vi.fn();
    mocks.withTenant.mockImplementationOnce(
      async (_db, _practiceId, callback) =>
        callback({
          transaction: async (savepoint: (tx: object) => Promise<unknown>) =>
            savepoint({}),
          select: () => ({
            from: () => ({
              where: () => ({
                limit: async () => [
                  {
                    id: activeSession.user.id,
                    email: activeSession.user.email,
                    name: activeSession.user.name,
                    role: activeSession.user.role,
                    passwordHash: "hash",
                    sessionVersion: activeSession.user.sessionVersion,
                  },
                ],
              }),
            }),
          }),
          insert: () => ({ values: insertValues }),
        }),
    );

    const response = await POST(
      postRequest(
        JSON.stringify({
          action: "billing.refundPayment",
          password: "secret",
          passkeyChallengeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          passkeyResponse,
        }),
      ),
    );

    expect(response.status).toBe(401);
    expect(insertValues).not.toHaveBeenCalled();
  });
});
