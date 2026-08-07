import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

export class MessagingRegistrationEncryptionError extends Error {
  constructor(
    message = "Messaging registration encryption is not configured."
  ) {
    super(message);
    this.name = "MessagingRegistrationEncryptionError";
  }
}

function encryptionKey(): Buffer {
  const encoded = process.env.MESSAGING_REGISTRATION_ENCRYPTION_KEY?.trim();
  if (!encoded) throw new MessagingRegistrationEncryptionError();

  let key: Buffer;
  try {
    key = Buffer.from(encoded, "base64");
  } catch {
    throw new MessagingRegistrationEncryptionError();
  }
  if (key.length !== 32) {
    throw new MessagingRegistrationEncryptionError(
      "MESSAGING_REGISTRATION_ENCRYPTION_KEY must be a base64-encoded 32-byte key."
    );
  }
  return key;
}

/** Encrypt a tax identifier for at-rest storage. The result is versioned. */
export function encryptRegistrationTaxId(value: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

/** Decrypt only at the provider-submission boundary. Never return this to UI. */
export function decryptRegistrationTaxId(value: string): string {
  const [version, ivPart, tagPart, ciphertextPart, ...extra] = value.split(":");
  if (
    version !== VERSION ||
    !ivPart ||
    !tagPart ||
    !ciphertextPart ||
    extra.length > 0
  ) {
    throw new MessagingRegistrationEncryptionError(
      "Stored messaging registration tax ID has an unsupported format."
    );
  }

  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      encryptionKey(),
      Buffer.from(ivPart, "base64url")
    );
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextPart, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    if (error instanceof MessagingRegistrationEncryptionError) throw error;
    throw new MessagingRegistrationEncryptionError(
      "Stored messaging registration tax ID could not be decrypted."
    );
  }
}
