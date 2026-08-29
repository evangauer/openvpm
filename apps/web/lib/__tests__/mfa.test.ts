import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumeRecoveryCodeHash,
  decryptMfaSecret,
  encryptMfaSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  matchingTotpCounter,
  mfaEncryptionConfigured,
  normalizeRecoveryCode,
  totpCodeAt,
  totpProvisioningUri,
  verifyTotpCode,
} from "@/lib/mfa";

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

beforeEach(() => vi.stubEnv("MFA_ENCRYPTION_KEY", TEST_KEY));
afterEach(() => vi.unstubAllEnvs());

describe("MFA primitives", () => {
  it("requires an independent 32-byte encryption key", () => {
    expect(mfaEncryptionConfigured()).toBe(true);
    vi.stubEnv("MFA_ENCRYPTION_KEY", "too-short");
    expect(mfaEncryptionConfigured()).toBe(false);
    expect(() => encryptMfaSecret("secret")).toThrow(/32-byte/);
  });

  it("encrypts TOTP secrets with authenticated encryption", () => {
    const encrypted = encryptMfaSecret("JBSWY3DPEHPK3PXP");
    expect(encrypted).not.toContain("JBSWY3DPEHPK3PXP");
    expect(decryptMfaSecret(encrypted)).toBe("JBSWY3DPEHPK3PXP");
    expect(() => decryptMfaSecret(`${encrypted}x`)).toThrow();
  });

  it("matches the six-digit RFC 6238 vector and accepts one clock step", () => {
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    expect(totpCodeAt(secret, 59_000)).toBe("287082");
    expect(verifyTotpCode(secret, "287082", { nowMs: 59_000, window: 0 })).toBe(
      true,
    );
    expect(verifyTotpCode(secret, "287082", { nowMs: 89_000, window: 1 })).toBe(
      true,
    );
    expect(verifyTotpCode(secret, "000000", { nowMs: 59_000 })).toBe(false);
    expect(
      matchingTotpCounter(secret, "287082", { nowMs: 59_000, window: 0 }),
    ).toBe(1);
  });

  it("creates authenticator-compatible enrollment details", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    const uri = totpProvisioningUri({
      secret,
      email: "owner@example.com",
      practiceName: "Neighborhood Vet",
    });
    expect(uri).toContain("otpauth://totp/");
    expect(uri).toContain(`secret=${secret}`);
    expect(uri).toContain("issuer=OpenVPM");
  });

  it("issues single-use recovery codes without storing plaintext", () => {
    const [code] = generateRecoveryCodes(1);
    expect(code).toMatch(/^(?:[A-Z2-7]{4}-){3}[A-Z2-7]{4}$/);
    expect(normalizeRecoveryCode(code!)).toHaveLength(16);
    const stored = hashRecoveryCode(code!);
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).not.toContain(normalizeRecoveryCode(code!));
    const accepted = consumeRecoveryCodeHash([stored, "bad"], code!);
    expect(accepted).toEqual({ accepted: true, remaining: ["bad"] });
    expect(consumeRecoveryCodeHash(accepted.remaining, code!).accepted).toBe(
      false,
    );
  });
});
