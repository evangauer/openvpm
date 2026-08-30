import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  isPrivilegedAction,
  type PrivilegedAction,
} from "./privileged-actions";

export const PRIVILEGED_ACTION_COOKIE = "openvpm-step-up";
export const PRIVILEGED_ACTION_TTL_SECONDS = 5 * 60;
const PROOF_VERSION = "v2";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ProofPayload = {
  action: PrivilegedAction;
  expiresAt: number;
  issuedAt: number;
  nonce: string;
  practiceId: string;
  proofId: string;
  sessionVersion: number;
  userId: string;
};

export type PrivilegedActionProofRecord = {
  id: string;
  action: PrivilegedAction;
  expiresAt: Date;
  issuedAt: Date;
  nonceHash: string;
  practiceId: string;
  sessionVersion: number;
  userId: string;
};

export type IssuedPrivilegedActionProof = {
  proof: string;
  record: PrivilegedActionProofRecord;
};

export type VerifiedPrivilegedActionProof = {
  action: PrivilegedAction;
  expiresAt: Date;
  id: string;
  nonceHash: string;
};

function decodedKey(name: string): Buffer | null {
  const configured = process.env[name]?.trim();
  const value = configured?.startsWith("base64:")
    ? configured.slice("base64:".length)
    : configured;
  if (!value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64");
  const canonical = decoded.toString("base64");
  if (value !== canonical && value !== canonical.replace(/=+$/, ""))
    return null;
  return decoded.length === 32 ? decoded : null;
}

function signingKey(): Buffer {
  const key = decodedKey("PRIVILEGED_ACTION_SIGNING_KEY");
  const encryptionKey = decodedKey("MFA_ENCRYPTION_KEY");
  const sessionKey = decodedKey("NEXTAUTH_SECRET");
  if (
    !key ||
    (encryptionKey !== null && timingSafeEqual(key, encryptionKey)) ||
    (sessionKey !== null && timingSafeEqual(key, sessionKey))
  ) {
    throw new Error("Privileged action proof signing is not configured.");
  }
  return key;
}

export function privilegedActionSigningConfigured(): boolean {
  try {
    signingKey();
    return true;
  } catch {
    return false;
  }
}

function signature(payload: string): Buffer {
  return createHmac("sha256", signingKey())
    .update(`openvpm-privileged-action:${PROOF_VERSION}:${payload}`)
    .digest();
}

function nonceHash(value: string): string {
  return createHash("sha256")
    .update(`openvpm-privileged-action-nonce:${PROOF_VERSION}:${value}`)
    .digest("hex");
}

function canonicalBase64url(value: string): Buffer | null {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64url");
  return decoded.toString("base64url") === value ? decoded : null;
}

export function issuePrivilegedActionProof(input: {
  action: PrivilegedAction;
  userId: string;
  practiceId: string;
  sessionVersion: number;
  nowMs?: number;
}): IssuedPrivilegedActionProof {
  const issuedAt = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const expiresAt = issuedAt + PRIVILEGED_ACTION_TTL_SECONDS;
  const nonce = randomBytes(32).toString("base64url");
  const proofId = randomUUID();
  const payload: ProofPayload = {
    action: input.action,
    expiresAt,
    issuedAt,
    nonce,
    practiceId: input.practiceId,
    proofId,
    sessionVersion: input.sessionVersion,
    userId: input.userId,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return {
    proof: `${PROOF_VERSION}.${encoded}.${signature(encoded).toString("base64url")}`,
    record: {
      id: proofId,
      action: input.action,
      expiresAt: new Date(expiresAt * 1000),
      issuedAt: new Date(issuedAt * 1000),
      nonceHash: nonceHash(nonce),
      practiceId: input.practiceId,
      sessionVersion: input.sessionVersion,
      userId: input.userId,
    },
  };
}

function exactPayload(value: unknown): ProofPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(record).sort()) !==
    JSON.stringify(
      [
        "action",
        "expiresAt",
        "issuedAt",
        "nonce",
        "practiceId",
        "proofId",
        "sessionVersion",
        "userId",
      ].sort(),
    )
  ) {
    return null;
  }
  return record as ProofPayload;
}

export function verifiedPrivilegedActionProof(
  proof: string | null | undefined,
  expected: {
    action: PrivilegedAction;
    userId: string;
    practiceId: string;
    sessionVersion: number;
    nowMs?: number;
  },
): VerifiedPrivilegedActionProof | null {
  if (!proof || proof.length > 2_048) return null;
  const [version, encoded, providedValue, ...extra] = proof.split(".");
  if (
    version !== PROOF_VERSION ||
    !encoded ||
    !providedValue ||
    extra.length > 0
  ) {
    return null;
  }

  let provided: Buffer | null;
  let encodedPayload: Buffer | null;
  let expectedSignature: Buffer;
  try {
    provided = canonicalBase64url(providedValue);
    encodedPayload = canonicalBase64url(encoded);
    expectedSignature = signature(encoded);
  } catch {
    return null;
  }
  if (
    !provided ||
    !encodedPayload ||
    provided.length !== expectedSignature.length ||
    !timingSafeEqual(provided, expectedSignature)
  ) {
    return null;
  }

  let payload: ProofPayload | null;
  try {
    payload = exactPayload(JSON.parse(encodedPayload.toString("utf8")));
  } catch {
    return null;
  }
  const now = Math.floor((expected.nowMs ?? Date.now()) / 1000);
  if (
    !payload ||
    !isPrivilegedAction(payload.action) ||
    payload.action !== expected.action ||
    payload.userId !== expected.userId ||
    payload.practiceId !== expected.practiceId ||
    payload.sessionVersion !== expected.sessionVersion ||
    !Number.isSafeInteger(payload.sessionVersion) ||
    payload.sessionVersion <= 0 ||
    !Number.isSafeInteger(payload.issuedAt) ||
    !Number.isSafeInteger(payload.expiresAt) ||
    payload.issuedAt > now + 30 ||
    payload.expiresAt <= now ||
    payload.expiresAt - payload.issuedAt !== PRIVILEGED_ACTION_TTL_SECONDS ||
    !UUID.test(payload.proofId) ||
    typeof payload.nonce !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(payload.nonce)
  ) {
    return null;
  }
  return {
    action: payload.action,
    expiresAt: new Date(payload.expiresAt * 1000),
    id: payload.proofId,
    nonceHash: nonceHash(payload.nonce),
  };
}

export function verifyPrivilegedActionProof(
  proof: string | null | undefined,
  expected: Parameters<typeof verifiedPrivilegedActionProof>[1],
): boolean {
  return verifiedPrivilegedActionProof(proof, expected) !== null;
}

export function cookieValue(
  cookieHeader: string | null | undefined,
  name: string,
): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;
    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return null;
}
