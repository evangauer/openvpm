import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decryptRegistrationTaxId,
  encryptRegistrationTaxId,
  MessagingRegistrationEncryptionError,
} from "../registration-crypto";

afterEach(() => vi.unstubAllEnvs());

describe("messaging registration encryption", () => {
  it("round-trips a tax ID without embedding the plaintext", () => {
    vi.stubEnv(
      "MESSAGING_REGISTRATION_ENCRYPTION_KEY",
      Buffer.alloc(32, 7).toString("base64")
    );
    const encrypted = encryptRegistrationTaxId("123456789");

    expect(encrypted).toMatch(/^v1:/);
    expect(encrypted).not.toContain("123456789");
    expect(decryptRegistrationTaxId(encrypted)).toBe("123456789");
  });

  it("rejects missing, malformed, and wrong keys", () => {
    expect(() => encryptRegistrationTaxId("123456789")).toThrow(
      MessagingRegistrationEncryptionError
    );

    vi.stubEnv("MESSAGING_REGISTRATION_ENCRYPTION_KEY", "not-32-bytes");
    expect(() => encryptRegistrationTaxId("123456789")).toThrow(
      "base64-encoded 32-byte key"
    );

    vi.stubEnv(
      "MESSAGING_REGISTRATION_ENCRYPTION_KEY",
      Buffer.alloc(32, 1).toString("base64")
    );
    const encrypted = encryptRegistrationTaxId("123456789");
    vi.stubEnv(
      "MESSAGING_REGISTRATION_ENCRYPTION_KEY",
      Buffer.alloc(32, 2).toString("base64")
    );
    expect(() => decryptRegistrationTaxId(encrypted)).toThrow(
      MessagingRegistrationEncryptionError
    );
  });
});
