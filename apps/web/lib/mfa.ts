import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const MFA_KEY_BYTES = 32;
const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const ENCRYPTION_VERSION = "v1";

function configuredKey(): Buffer | null {
  const configured = process.env.MFA_ENCRYPTION_KEY?.trim();
  if (!configured) return null;

  const value = configured.startsWith("base64:")
    ? configured.slice("base64:".length)
    : configured;
  const decoded = Buffer.from(value, "base64");
  return decoded.length === MFA_KEY_BYTES ? decoded : null;
}

export function mfaEncryptionConfigured(): boolean {
  return configuredKey() !== null;
}

function encryptionKey(): Buffer {
  const key = configuredKey();
  if (!key) {
    throw new Error(
      "MFA_ENCRYPTION_KEY must be a base64-encoded 32-byte secret.",
    );
  }
  return key;
}

export function generateTotpSecret(): string {
  return encodeBase32(randomBytes(20));
}

export function encryptMfaSecret(secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    ENCRYPTION_VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptMfaSecret(value: string): string {
  const [version, ivValue, tagValue, ciphertextValue, ...extra] =
    value.split(".");
  if (
    version !== ENCRYPTION_VERSION ||
    !ivValue ||
    !tagValue ||
    !ciphertextValue ||
    extra.length > 0
  ) {
    throw new Error("Invalid encrypted MFA secret.");
  }

  const iv = Buffer.from(ivValue, "base64url");
  const tag = Buffer.from(tagValue, "base64url");
  const ciphertext = Buffer.from(ciphertextValue, "base64url");
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
    throw new Error("Invalid encrypted MFA secret.");
  }

  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

export function totpCodeAt(secret: string, nowMs = Date.now()): string {
  const counter = Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", decodeBase32(secret))
    .update(message)
    .digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

export function verifyTotpCode(
  secret: string,
  code: string,
  options: { nowMs?: number; window?: number } = {},
): boolean {
  return matchingTotpCounter(secret, code, options) !== null;
}

export function matchingTotpCounter(
  secret: string,
  code: string,
  options: { nowMs?: number; window?: number } = {},
): number | null {
  const normalized = code.trim();
  if (!/^\d{6}$/.test(normalized)) return null;
  const nowMs = options.nowMs ?? Date.now();
  const window = Math.max(0, Math.min(options.window ?? 1, 2));
  const currentCounter = Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
  const candidate = Buffer.from(normalized);

  for (let offset = -window; offset <= window; offset += 1) {
    const expected = Buffer.from(
      totpCodeAt(secret, nowMs + offset * TOTP_PERIOD_SECONDS * 1000),
    );
    if (
      candidate.length === expected.length &&
      timingSafeEqual(candidate, expected)
    ) {
      return currentCounter + offset;
    }
  }
  return null;
}

export function totpProvisioningUri(input: {
  secret: string;
  email: string;
  practiceName: string;
}): string {
  const issuer = "OpenVPM";
  const account = `${input.practiceName}:${input.email}`;
  const query = new URLSearchParams({
    secret: input.secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?${query.toString()}`;
}

export function generateRecoveryCodes(count = 10): string[] {
  if (!Number.isSafeInteger(count) || count < 1 || count > 20) {
    throw new Error("Recovery code count must be between 1 and 20.");
  }
  return Array.from({ length: count }, () =>
    encodeBase32(randomBytes(10))
      .match(/.{1,4}/g)!
      .join("-"),
  );
}

export function normalizeRecoveryCode(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z2-7]/g, "");
}

export function hashRecoveryCode(value: string): string {
  const normalized = normalizeRecoveryCode(value);
  if (normalized.length !== 16) return "";
  return createHmac("sha256", encryptionKey())
    .update(`openvpm-mfa-recovery:${normalized}`)
    .digest("hex");
}

export function consumeRecoveryCodeHash(
  hashes: string[],
  suppliedCode: string,
): { accepted: boolean; remaining: string[] } {
  const candidateHash = hashRecoveryCode(suppliedCode);
  if (!candidateHash) return { accepted: false, remaining: hashes };
  const candidate = Buffer.from(candidateHash, "hex");
  const index = hashes.findIndex((hash) => {
    if (!/^[0-9a-f]{64}$/i.test(hash)) return false;
    const stored = Buffer.from(hash, "hex");
    return (
      stored.length === candidate.length && timingSafeEqual(stored, candidate)
    );
  });
  if (index < 0) return { accepted: false, remaining: hashes };
  return {
    accepted: true,
    remaining: hashes.filter((_, itemIndex) => itemIndex !== index),
  };
}

function encodeBase32(value: Buffer): string {
  let bits = "";
  for (const byte of value) bits += byte.toString(2).padStart(8, "0");
  let encoded = "";
  for (let index = 0; index < bits.length; index += 5) {
    const chunk = bits.slice(index, index + 5).padEnd(5, "0");
    encoded += BASE32_ALPHABET[Number.parseInt(chunk, 2)];
  }
  return encoded;
}

function decodeBase32(value: string): Buffer {
  const normalized = value.trim().toUpperCase().replace(/=+$/g, "");
  if (!normalized || !/^[A-Z2-7]+$/.test(normalized)) {
    throw new Error("Invalid TOTP secret.");
  }
  let bits = "";
  for (const character of normalized) {
    bits += BASE32_ALPHABET.indexOf(character).toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }
  return Buffer.from(bytes);
}
