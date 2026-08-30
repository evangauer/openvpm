import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activeWebAuthnCredentials: vi.fn(async () => [] as unknown[]),
  beginWebAuthnRegistration: vi.fn(async () => ({
    challengeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    expiresAt: new Date("2030-01-01T00:05:00.000Z"),
    options: { challenge: "challenge" },
  })),
  finishWebAuthnRegistration: vi.fn(async () => ({
    credentialId: "credential_identifier_1234",
  })),
}));

vi.mock("@/lib/webauthn-ceremony", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/webauthn-ceremony")
  >("@/lib/webauthn-ceremony");
  return {
    ...actual,
    activeWebAuthnCredentials: mocks.activeWebAuthnCredentials,
    beginWebAuthnRegistration: mocks.beginWebAuthnRegistration,
    finishWebAuthnRegistration: mocks.finishWebAuthnRegistration,
  };
});

vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn(async () => undefined),
}));

const { passkeysRouter } = await import("../routers/passkeys");

const session = {
  user: {
    id: "00000000-0000-4000-8000-000000000001",
    email: "admin@example.com",
    name: "Clinic Admin",
    role: "admin",
    practiceId: "00000000-0000-4000-8000-0000000000aa",
    sessionVersion: 3,
  },
};
const registrationResponse = {
  id: "credential_identifier_1234",
  rawId: "credential_identifier_1234",
  type: "public-key" as const,
  clientExtensionResults: {},
  response: {
    clientDataJSON: "client_data",
    attestationObject: "attestation_object",
    transports: ["internal" as const],
  },
};

function callerWithDb(db: Record<string, unknown>) {
  return passkeysRouter.createCaller({ db, session } as never);
}

function transactionalDb(
  options: {
    updateRows?: unknown[][];
    currentUserRows?: unknown[];
  } = {},
) {
  const updateRows = [...(options.updateRows ?? [])];
  const updateSet = vi.fn((_values: unknown) => ({
    where: () => ({ returning: async () => updateRows.shift() ?? [] }),
  }));
  const selectForUpdate = vi.fn(async () =>
    options.currentUserRows === undefined
      ? [{ id: session.user.id }]
      : options.currentUserRows,
  );
  const db: Record<string, unknown> = {
    execute: vi.fn(async () => undefined),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => ({ for: selectForUpdate }),
        }),
      }),
    }),
    update: () => ({ set: updateSet }),
  };
  const transaction = vi.fn(async (callback: (tx: unknown) => unknown) =>
    callback(db),
  );
  db.transaction = transaction;
  return { db, selectForUpdate, transaction, updateSet };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.activeWebAuthnCredentials.mockResolvedValue([]);
  mocks.finishWebAuthnRegistration.mockResolvedValue({
    credentialId: "credential_identifier_1234",
  });
});

describe("passkey router", () => {
  it("returns only bounded credential metadata from status", async () => {
    mocks.activeWebAuthnCredentials.mockResolvedValueOnce([
      {
        id: "credential-row-id",
        credentialId: "credential_identifier_1234",
        publicKey: new Uint8Array(32),
        backedUp: true,
        createdAt: new Date("2030-01-01T00:00:00.000Z"),
        deviceType: "multiDevice",
        lastUsedAt: null,
        name: "Primary passkey",
      },
    ]);
    const { db } = transactionalDb();

    const result = await callerWithDb(db).status();

    expect(result.credentials).toEqual([
      expect.objectContaining({
        id: "credential-row-id",
        name: "Primary passkey",
        backedUp: true,
      }),
    ]);
    expect(result.credentials[0]).not.toHaveProperty("credentialId");
    expect(result.credentials[0]).not.toHaveProperty("publicKey");
  });

  it("enrolls and revokes the session inside one nested transaction", async () => {
    vi.stubEnv("WEBAUTHN_RP_ID", "app.openvpm.com");
    vi.stubEnv("WEBAUTHN_ORIGINS", "https://app.openvpm.com");
    const { db, transaction, updateSet } = transactionalDb({
      updateRows: [[{ id: session.user.id }]],
    });

    await expect(
      callerWithDb(db).confirmRegistration({
        challengeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        name: "Hardware key",
        credentialResponse: registrationResponse,
      }),
    ).resolves.toEqual({
      ok: true,
      credentialId: "credential_identifier_1234",
    });

    expect(transaction).toHaveBeenCalledTimes(2);
    expect(mocks.finishWebAuthnRegistration).toHaveBeenCalledOnce();
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ sessionVersion: expect.anything() }),
    );
  });

  it("keeps two authenticators for required identities", async () => {
    vi.stubEnv("WEBAUTHN_ADMIN_POLICY", "required");
    mocks.activeWebAuthnCredentials.mockResolvedValueOnce([
      { id: "credential-1" },
      { id: "credential-2" },
    ]);
    const { db, selectForUpdate, updateSet } = transactionalDb();

    await expect(
      callerWithDb(db).remove({
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    expect(selectForUpdate).toHaveBeenCalledWith("update");
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("retires one of three passkeys and revokes the current session atomically", async () => {
    vi.stubEnv("WEBAUTHN_ADMIN_POLICY", "required");
    mocks.activeWebAuthnCredentials.mockResolvedValueOnce([
      { id: "credential-1" },
      { id: "credential-2" },
      { id: "credential-3" },
    ]);
    const { db, transaction, updateSet } = transactionalDb({
      updateRows: [[{ id: "credential-1" }], [{ id: session.user.id }]],
    });

    await expect(
      callerWithDb(db).remove({
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }),
    ).resolves.toEqual({ ok: true });

    expect(transaction).toHaveBeenCalledTimes(2);
    expect(updateSet).toHaveBeenCalledTimes(2);
  });
});
