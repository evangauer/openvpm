import { createHash, randomFillSync, timingSafeEqual } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  WebAuthnCredential,
} from "@simplewebauthn/server";
import { and, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  webauthnChallenges,
  webauthnCredentials,
  type WebAuthnTransport,
} from "@openpims/db";
import type { Database } from "@openpims/db/client";
import type { PrivilegedAction } from "@/lib/privileged-actions";
import { webauthnConfiguration } from "@/lib/webauthn-config";

export const WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60 * 1_000;
const CEREMONY_TIMEOUT_MS = 2 * 60 * 1_000;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const TRANSPORTS = [
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb",
] as const;

const base64url = (max: number) => z.string().min(1).max(max).regex(BASE64URL);
const clientExtensions = z.custom<
  RegistrationResponseJSON["clientExtensionResults"]
>(
  (value) =>
    value !== null && typeof value === "object" && !Array.isArray(value),
);

export const registrationResponseSchema = z.object({
  id: base64url(1024),
  rawId: base64url(1024),
  response: z.object({
    clientDataJSON: base64url(32_768),
    attestationObject: base64url(65_536),
    authenticatorData: base64url(32_768).optional(),
    transports: z.enum(TRANSPORTS).array().max(7).optional(),
    publicKeyAlgorithm: z.number().int().optional(),
    publicKey: base64url(16_384).optional(),
  }),
  authenticatorAttachment: z.enum(["cross-platform", "platform"]).optional(),
  clientExtensionResults: clientExtensions,
  type: z.literal("public-key"),
});

export const authenticationResponseSchema = z.object({
  id: base64url(1024),
  rawId: base64url(1024),
  response: z.object({
    clientDataJSON: base64url(32_768),
    authenticatorData: base64url(32_768),
    signature: base64url(32_768),
    userHandle: base64url(1024).optional(),
  }),
  authenticatorAttachment: z.enum(["cross-platform", "platform"]).optional(),
  clientExtensionResults: clientExtensions,
  type: z.literal("public-key"),
});

export type WebAuthnChallengePurpose =
  | "registration"
  | "login"
  | "privileged_action";

type CeremonyIdentity = {
  email: string;
  name: string;
  practiceId: string;
  sessionVersion: number;
  userId: string;
};

type StoredCredential = typeof webauthnCredentials.$inferSelect;

function newChallenge(): {
  bytes: Uint8Array<ArrayBuffer>;
  encoded: string;
} {
  const bytes = randomFillSync(new Uint8Array(32));
  return { bytes, encoded: Buffer.from(bytes).toString("base64url") };
}

export function webauthnChallengeHash(challenge: string): string {
  return createHash("sha256")
    .update(`openvpm-webauthn-challenge:v1:${challenge}`)
    .digest("hex");
}

function challengeMatches(expectedHash: string, candidate: string): boolean {
  if (
    candidate.length < 32 ||
    candidate.length > 128 ||
    !BASE64URL.test(candidate)
  ) {
    return false;
  }
  const provided = Buffer.from(webauthnChallengeHash(candidate), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return (
    provided.length === expected.length && timingSafeEqual(provided, expected)
  );
}

function transports(value: unknown): AuthenticatorTransportFuture[] {
  return Array.isArray(value)
    ? value.filter((item): item is WebAuthnTransport =>
        (TRANSPORTS as readonly unknown[]).includes(item),
      )
    : [];
}

function verificationCredential(row: StoredCredential): WebAuthnCredential {
  return {
    id: row.credentialId,
    publicKey: new Uint8Array(row.publicKey),
    counter: row.counter,
    transports: transports(row.transports),
  };
}

export async function activeWebAuthnCredentials(
  database: Database,
  identity: Pick<CeremonyIdentity, "practiceId" | "userId">,
) {
  return database
    .select()
    .from(webauthnCredentials)
    .where(
      and(
        eq(webauthnCredentials.practiceId, identity.practiceId),
        eq(webauthnCredentials.userId, identity.userId),
        isNull(webauthnCredentials.deletedAt),
      ),
    );
}

async function persistChallenge(input: {
  action?: PrivilegedAction;
  challenge: string;
  database: Database;
  identity: CeremonyIdentity;
  purpose: WebAuthnChallengePurpose;
}) {
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + WEBAUTHN_CHALLENGE_TTL_MS);
  const [stored] = await input.database
    .insert(webauthnChallenges)
    .values({
      action: input.action ?? null,
      challengeHash: webauthnChallengeHash(input.challenge),
      expiresAt,
      issuedAt,
      practiceId: input.identity.practiceId,
      purpose: input.purpose,
      sessionVersion: input.identity.sessionVersion,
      userId: input.identity.userId,
    })
    .returning({ id: webauthnChallenges.id });
  if (!stored) throw new Error("WebAuthn challenge was not persisted.");
  return { challengeId: stored.id, expiresAt };
}

export async function beginWebAuthnRegistration(input: {
  database: Database;
  identity: CeremonyIdentity;
}): Promise<{
  challengeId: string;
  expiresAt: Date;
  options: PublicKeyCredentialCreationOptionsJSON;
}> {
  const config = webauthnConfiguration();
  if (!config) throw new Error("WebAuthn is not configured.");
  const existing = await activeWebAuthnCredentials(
    input.database,
    input.identity,
  );
  const challenge = newChallenge();
  const options = await generateRegistrationOptions({
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
    challenge: challenge.bytes,
    excludeCredentials: existing.map((credential) => ({
      id: credential.credentialId,
      transports: transports(credential.transports),
    })),
    rpID: config.rpID,
    rpName: config.rpName,
    timeout: CEREMONY_TIMEOUT_MS,
    userDisplayName: input.identity.name,
    userID: Buffer.from(input.identity.userId, "utf8"),
    userName: input.identity.email,
  });
  const stored = await persistChallenge({
    challenge: challenge.encoded,
    database: input.database,
    identity: input.identity,
    purpose: "registration",
  });
  return { ...stored, options };
}

export async function beginWebAuthnAuthentication(input: {
  action?: PrivilegedAction;
  credentials?: StoredCredential[];
  database: Database;
  identity: CeremonyIdentity;
  purpose: "login" | "privileged_action";
}): Promise<{
  challengeId: string;
  expiresAt: Date;
  options: PublicKeyCredentialRequestOptionsJSON;
}> {
  const config = webauthnConfiguration();
  if (!config) throw new Error("WebAuthn is not configured.");
  const credentials =
    input.credentials ??
    (await activeWebAuthnCredentials(input.database, input.identity));
  if (credentials.length === 0) throw new Error("No active passkey exists.");
  const challenge = newChallenge();
  const options = await generateAuthenticationOptions({
    allowCredentials: credentials.map((credential) => ({
      id: credential.credentialId,
      transports: transports(credential.transports),
    })),
    challenge: challenge.bytes,
    rpID: config.rpID,
    timeout: CEREMONY_TIMEOUT_MS,
    userVerification: "required",
  });
  const stored = await persistChallenge({
    action: input.action,
    challenge: challenge.encoded,
    database: input.database,
    identity: input.identity,
    purpose: input.purpose,
  });
  return { ...stored, options };
}

async function activeChallenge(input: {
  action?: PrivilegedAction;
  challengeId: string;
  database: Database;
  identity: CeremonyIdentity;
  purpose: WebAuthnChallengePurpose;
}) {
  const [challenge] = await input.database
    .select()
    .from(webauthnChallenges)
    .where(
      and(
        eq(webauthnChallenges.id, input.challengeId),
        eq(webauthnChallenges.practiceId, input.identity.practiceId),
        eq(webauthnChallenges.userId, input.identity.userId),
        eq(webauthnChallenges.sessionVersion, input.identity.sessionVersion),
        eq(webauthnChallenges.purpose, input.purpose),
        input.action
          ? eq(webauthnChallenges.action, input.action)
          : isNull(webauthnChallenges.action),
        isNull(webauthnChallenges.consumedAt),
        gt(webauthnChallenges.expiresAt, new Date()),
      ),
    )
    .limit(1)
    .for("update");
  return challenge ?? null;
}

async function consumeChallenge(input: {
  challengeId: string;
  database: Database;
  expiresAt: Date;
}) {
  const consumedAt = new Date();
  const [consumed] = await input.database
    .update(webauthnChallenges)
    .set({ consumedAt })
    .where(
      and(
        eq(webauthnChallenges.id, input.challengeId),
        isNull(webauthnChallenges.consumedAt),
        eq(webauthnChallenges.expiresAt, input.expiresAt),
        gt(webauthnChallenges.expiresAt, consumedAt),
      ),
    )
    .returning({ id: webauthnChallenges.id });
  if (!consumed)
    throw new Error("WebAuthn challenge was already used or expired.");
}

export async function finishWebAuthnRegistration(input: {
  challengeId: string;
  database: Database;
  identity: CeremonyIdentity;
  name: string;
  response: RegistrationResponseJSON;
}): Promise<{ credentialId: string }> {
  const config = webauthnConfiguration();
  if (!config) throw new Error("WebAuthn is not configured.");
  if (input.response.id !== input.response.rawId) {
    throw new Error("Passkey credential identity mismatch.");
  }
  const challenge = await activeChallenge({
    challengeId: input.challengeId,
    database: input.database,
    identity: input.identity,
    purpose: "registration",
  });
  if (!challenge)
    throw new Error("WebAuthn registration challenge is invalid.");
  const verification = await verifyRegistrationResponse({
    expectedChallenge: (candidate) =>
      challengeMatches(challenge.challengeHash, candidate),
    expectedOrigin: config.origins,
    expectedRPID: config.rpID,
    requireUserPresence: true,
    requireUserVerification: true,
    response: input.response,
  });
  if (!verification.verified) throw new Error("Passkey registration failed.");
  const info = verification.registrationInfo;
  if (info.credential.id !== input.response.id) {
    throw new Error("Passkey credential identity mismatch.");
  }
  await input.database.insert(webauthnCredentials).values({
    aaguid: info.aaguid,
    backedUp: info.credentialBackedUp,
    counter: info.credential.counter,
    credentialId: info.credential.id,
    deviceType: info.credentialDeviceType,
    name: input.name.trim(),
    practiceId: input.identity.practiceId,
    publicKey: new Uint8Array(info.credential.publicKey),
    transports: transports(input.response.response.transports),
    userId: input.identity.userId,
  });
  await consumeChallenge({
    challengeId: input.challengeId,
    database: input.database,
    expiresAt: challenge.expiresAt,
  });
  return { credentialId: info.credential.id };
}

export async function finishWebAuthnAuthentication(input: {
  action?: PrivilegedAction;
  challengeId: string;
  database: Database;
  identity: CeremonyIdentity;
  purpose: "login" | "privileged_action";
  response: AuthenticationResponseJSON;
}): Promise<{ credentialRowId: string }> {
  const config = webauthnConfiguration();
  if (!config) throw new Error("WebAuthn is not configured.");
  if (input.response.id !== input.response.rawId) {
    throw new Error("Passkey credential identity mismatch.");
  }
  const challenge = await activeChallenge({
    action: input.action,
    challengeId: input.challengeId,
    database: input.database,
    identity: input.identity,
    purpose: input.purpose,
  });
  if (!challenge)
    throw new Error("WebAuthn authentication challenge is invalid.");
  const [credential] = await input.database
    .select()
    .from(webauthnCredentials)
    .where(
      and(
        eq(webauthnCredentials.credentialId, input.response.id),
        eq(webauthnCredentials.practiceId, input.identity.practiceId),
        eq(webauthnCredentials.userId, input.identity.userId),
        isNull(webauthnCredentials.deletedAt),
      ),
    )
    .limit(1)
    .for("update");
  if (!credential) throw new Error("Passkey credential is not active.");
  const verification = await verifyAuthenticationResponse({
    credential: verificationCredential(credential),
    expectedChallenge: (candidate) =>
      challengeMatches(challenge.challengeHash, candidate),
    expectedOrigin: config.origins,
    expectedRPID: config.rpID,
    requireUserVerification: true,
    response: input.response,
  });
  if (!verification.verified || !verification.authenticationInfo.userVerified) {
    throw new Error("Passkey authentication failed.");
  }
  const usedAt = new Date();
  const [updated] = await input.database
    .update(webauthnCredentials)
    .set({
      backedUp: verification.authenticationInfo.credentialBackedUp,
      counter: verification.authenticationInfo.newCounter,
      lastUsedAt: usedAt,
      updatedAt: usedAt,
    })
    .where(
      and(
        eq(webauthnCredentials.id, credential.id),
        eq(webauthnCredentials.counter, credential.counter),
        isNull(webauthnCredentials.deletedAt),
      ),
    )
    .returning({ id: webauthnCredentials.id });
  if (!updated) throw new Error("Passkey credential changed concurrently.");
  await consumeChallenge({
    challengeId: input.challengeId,
    database: input.database,
    expiresAt: challenge.expiresAt,
  });
  return { credentialRowId: updated.id };
}
