import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const PRIVILEGED_ACTION_COOKIE = "openvpm-step-up";
export const PRIVILEGED_ACTION_TTL_SECONDS = 10 * 60;
const PROOF_VERSION = "v1";

type ProofPayload = {
  userId: string;
  practiceId: string;
  sessionVersion: number;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
};

function signingKey(): Buffer {
  const configured = process.env.MFA_ENCRYPTION_KEY?.trim();
  const value = configured?.startsWith("base64:")
    ? configured.slice("base64:".length)
    : configured;
  const decoded = value ? Buffer.from(value, "base64") : Buffer.alloc(0);
  if (decoded.length !== 32) {
    throw new Error("Privileged action proof signing is not configured.");
  }
  return decoded;
}

function signature(payload: string): Buffer {
  return createHmac("sha256", signingKey())
    .update(`openvpm-privileged-action:${PROOF_VERSION}:${payload}`)
    .digest();
}

export function issuePrivilegedActionProof(input: {
  userId: string;
  practiceId: string;
  sessionVersion: number;
  nowMs?: number;
}): string {
  const issuedAt = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const payload: ProofPayload = {
    userId: input.userId,
    practiceId: input.practiceId,
    sessionVersion: input.sessionVersion,
    issuedAt,
    expiresAt: issuedAt + PRIVILEGED_ACTION_TTL_SECONDS,
    nonce: randomBytes(16).toString("base64url"),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${PROOF_VERSION}.${encoded}.${signature(encoded).toString("base64url")}`;
}

export function verifyPrivilegedActionProof(
  proof: string | null | undefined,
  expected: {
    userId: string;
    practiceId: string;
    sessionVersion: number;
    nowMs?: number;
  },
): boolean {
  if (!proof) return false;
  const [version, encoded, providedValue, ...extra] = proof.split(".");
  if (
    version !== PROOF_VERSION ||
    !encoded ||
    !providedValue ||
    extra.length > 0
  ) {
    return false;
  }

  let provided: Buffer;
  let expectedSignature: Buffer;
  try {
    provided = Buffer.from(providedValue, "base64url");
    expectedSignature = signature(encoded);
  } catch {
    return false;
  }
  if (
    provided.length !== expectedSignature.length ||
    !timingSafeEqual(provided, expectedSignature)
  ) {
    return false;
  }

  let payload: ProofPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return false;
  }
  const now = Math.floor((expected.nowMs ?? Date.now()) / 1000);
  return (
    payload?.userId === expected.userId &&
    payload.practiceId === expected.practiceId &&
    payload.sessionVersion === expected.sessionVersion &&
    Number.isSafeInteger(payload.issuedAt) &&
    Number.isSafeInteger(payload.expiresAt) &&
    payload.issuedAt <= now + 30 &&
    payload.expiresAt > now &&
    payload.expiresAt - payload.issuedAt === PRIVILEGED_ACTION_TTL_SECONDS &&
    typeof payload.nonce === "string" &&
    /^[A-Za-z0-9_-]{20,32}$/.test(payload.nonce)
  );
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
