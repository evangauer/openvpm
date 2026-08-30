import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateAuthenticationOptions: vi.fn(),
  generateRegistrationOptions: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
  verifyRegistrationResponse: vi.fn(),
  webauthnConfiguration: vi.fn(() => ({
    origins: ["https://app.openvpm.com"],
    policy: "required",
    rpID: "app.openvpm.com",
    rpName: "OpenVPM",
  })),
}));

vi.mock("@simplewebauthn/server", () => ({
  generateAuthenticationOptions: mocks.generateAuthenticationOptions,
  generateRegistrationOptions: mocks.generateRegistrationOptions,
  verifyAuthenticationResponse: mocks.verifyAuthenticationResponse,
  verifyRegistrationResponse: mocks.verifyRegistrationResponse,
}));

vi.mock("../webauthn-config", () => ({
  webauthnConfiguration: mocks.webauthnConfiguration,
}));

const {
  WEBAUTHN_CHALLENGE_TTL_MS,
  beginWebAuthnAuthentication,
  finishWebAuthnAuthentication,
  finishWebAuthnRegistration,
  webauthnChallengeHash,
} = await import("../webauthn-ceremony");

const identity = {
  email: "admin@example.com",
  name: "Clinic Admin",
  practiceId: "00000000-0000-4000-8000-0000000000aa",
  sessionVersion: 4,
  userId: "00000000-0000-4000-8000-000000000001",
};
const challengeText = "A".repeat(43);
const challengeRow = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  challengeHash: webauthnChallengeHash(challengeText),
  expiresAt: new Date(Date.now() + 4 * 60 * 1_000),
};
const authenticationResponse = {
  id: "credential_identifier_1234",
  rawId: "credential_identifier_1234",
  type: "public-key" as const,
  clientExtensionResults: {},
  response: {
    clientDataJSON: "client_data",
    authenticatorData: "authenticator_data",
    signature: "signature",
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

function lockedSelect(rows: unknown[][]) {
  let index = 0;
  return vi.fn(() => ({
    from: () => ({
      where: () => ({
        limit: () => ({
          for: async () => rows[index++] ?? [],
        }),
      }),
    }),
  }));
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.webauthnConfiguration.mockReturnValue({
    origins: ["https://app.openvpm.com"],
    policy: "required",
    rpID: "app.openvpm.com",
    rpName: "OpenVPM",
  });
});

describe("WebAuthn ceremony binding", () => {
  it("stores a domain-separated digest and an exact five-minute action challenge", async () => {
    mocks.generateAuthenticationOptions.mockImplementationOnce(
      async (options) => ({
        challenge: Buffer.from(options.challenge).toString("base64url"),
        rpId: options.rpID,
        timeout: options.timeout,
        userVerification: options.userVerification,
        allowCredentials: options.allowCredentials,
      }),
    );
    const challengeValues = vi.fn((_values: unknown) => ({
      returning: async () => [{ id: challengeRow.id }],
    }));
    const database = {
      insert: () => ({ values: challengeValues }),
    };
    const issued = await beginWebAuthnAuthentication({
      action: "billing.refundPayment",
      credentials: [
        {
          credentialId: authenticationResponse.id,
          transports: ["internal"],
        },
      ] as never,
      database: database as never,
      identity,
      purpose: "privileged_action",
    });

    const persisted = challengeValues.mock.calls[0]?.[0] as {
      action: string;
      challengeHash: string;
      expiresAt: Date;
      issuedAt: Date;
      purpose: string;
    };
    expect(persisted).toMatchObject({
      action: "billing.refundPayment",
      purpose: "privileged_action",
      challengeHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(persisted.challengeHash).not.toBe(issued.options.challenge);
    expect(persisted.challengeHash).toBe(
      webauthnChallengeHash(issued.options.challenge),
    );
    expect(persisted.expiresAt.getTime() - persisted.issuedAt.getTime()).toBe(
      WEBAUTHN_CHALLENGE_TTL_MS,
    );
    expect(mocks.generateAuthenticationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        rpID: "app.openvpm.com",
        userVerification: "required",
        timeout: 120_000,
      }),
    );
  });

  it("verifies exact origin, RP, UV, counter, and one-use challenge on authentication", async () => {
    const credential = {
      id: "credential-row-id",
      credentialId: authenticationResponse.id,
      publicKey: new Uint8Array(32),
      counter: 7,
      transports: ["internal"],
      backedUp: false,
    };
    mocks.verifyAuthenticationResponse.mockImplementationOnce(
      async (options) => {
        expect(options.expectedChallenge(challengeText)).toBe(true);
        return {
          verified: true,
          authenticationInfo: {
            userVerified: true,
            newCounter: 8,
            credentialBackedUp: true,
          },
        };
      },
    );
    const select = lockedSelect([[challengeRow], [credential]]);
    const updateSets: unknown[] = [];
    const updateRows = [[{ id: credential.id }], [{ id: challengeRow.id }]];
    const database = {
      select,
      update: () => ({
        set: (values: unknown) => {
          updateSets.push(values);
          return {
            where: () => ({ returning: async () => updateRows.shift() ?? [] }),
          };
        },
      }),
    };

    await expect(
      finishWebAuthnAuthentication({
        action: "billing.refundPayment",
        challengeId: challengeRow.id,
        database: database as never,
        identity,
        purpose: "privileged_action",
        response: authenticationResponse,
      }),
    ).resolves.toEqual({ credentialRowId: credential.id });

    expect(mocks.verifyAuthenticationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedOrigin: ["https://app.openvpm.com"],
        expectedRPID: "app.openvpm.com",
        requireUserVerification: true,
      }),
    );
    expect(updateSets[0]).toMatchObject({ counter: 8, backedUp: true });
    expect(updateSets[1]).toMatchObject({ consumedAt: expect.any(Date) });
  });

  it("persists a verified public credential and consumes registration once", async () => {
    mocks.verifyRegistrationResponse.mockImplementationOnce(async (options) => {
      expect(options.expectedChallenge(challengeText)).toBe(true);
      return {
        verified: true,
        registrationInfo: {
          aaguid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          credential: {
            id: registrationResponse.id,
            publicKey: new Uint8Array(32),
            counter: 0,
          },
          credentialBackedUp: true,
          credentialDeviceType: "multiDevice",
        },
      };
    });
    const credentialValues = vi.fn(async () => undefined);
    const consumeValues = vi.fn(() => ({
      where: () => ({ returning: async () => [{ id: challengeRow.id }] }),
    }));
    const database = {
      select: lockedSelect([[challengeRow]]),
      insert: () => ({ values: credentialValues }),
      update: () => ({ set: consumeValues }),
    };

    await expect(
      finishWebAuthnRegistration({
        challengeId: challengeRow.id,
        database: database as never,
        identity,
        name: "  Hardware key  ",
        response: registrationResponse,
      }),
    ).resolves.toEqual({ credentialId: registrationResponse.id });
    expect(mocks.verifyRegistrationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedOrigin: ["https://app.openvpm.com"],
        expectedRPID: "app.openvpm.com",
        requireUserPresence: true,
        requireUserVerification: true,
      }),
    );
    expect(credentialValues).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialId: registrationResponse.id,
        name: "Hardware key",
        publicKey: expect.any(Uint8Array),
      }),
    );
    expect(consumeValues).toHaveBeenCalledWith({
      consumedAt: expect.any(Date),
    });
  });

  it("rejects conflicting browser credential IDs before verification or storage", async () => {
    const response = {
      ...authenticationResponse,
      rawId: "different_credential_identifier",
    };
    await expect(
      finishWebAuthnAuthentication({
        challengeId: challengeRow.id,
        database: {} as never,
        identity,
        purpose: "login",
        response,
      }),
    ).rejects.toThrow("credential identity mismatch");
    expect(mocks.verifyAuthenticationResponse).not.toHaveBeenCalled();
  });
});
