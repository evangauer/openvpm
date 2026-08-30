import { afterEach, describe, expect, it, vi } from "vitest";
import {
  passkeyRequiredForIdentity,
  webauthnAdminPolicy,
  webauthnConfiguration,
} from "../webauthn-config";

afterEach(() => {
  vi.unstubAllEnvs();
});

function validConfiguration() {
  vi.stubEnv("WEBAUTHN_RP_ID", "app.openvpm.com");
  vi.stubEnv("WEBAUTHN_RP_NAME", "OpenVPM");
  vi.stubEnv(
    "WEBAUTHN_ORIGINS",
    "https://app.openvpm.com,https://preview.app.openvpm.com",
  );
}

describe("WebAuthn relying-party configuration", () => {
  it("accepts exact HTTPS origins at or below the relying-party ID", () => {
    validConfiguration();
    vi.stubEnv("WEBAUTHN_ADMIN_POLICY", "migration");

    expect(webauthnConfiguration()).toEqual({
      origins: ["https://app.openvpm.com", "https://preview.app.openvpm.com"],
      policy: "migration",
      rpID: "app.openvpm.com",
      rpName: "OpenVPM",
    });
  });

  it.each([
    "http://app.openvpm.com",
    "https://app.openvpm.com/",
    "https://app.openvpm.com/path",
    "https://attacker.example",
    "https://user@app.openvpm.com",
  ])("rejects an unsafe or inexact origin: %s", (origin) => {
    validConfiguration();
    vi.stubEnv("WEBAUTHN_ORIGINS", origin);
    expect(webauthnConfiguration()).toBeNull();
  });

  it("permits HTTP only for localhost development", () => {
    vi.stubEnv("WEBAUTHN_RP_ID", "localhost");
    vi.stubEnv("WEBAUTHN_ORIGINS", "http://localhost:3000");
    expect(webauthnConfiguration()).toMatchObject({
      origins: ["http://localhost:3000"],
      rpID: "localhost",
    });
  });

  it("fails closed to disabled for an unknown enforcement policy", () => {
    validConfiguration();
    vi.stubEnv("WEBAUTHN_ADMIN_POLICY", "optional");
    expect(webauthnAdminPolicy()).toBe("disabled");
    expect(webauthnConfiguration()?.policy).toBe("disabled");
  });

  it("requires passkeys only for admins and allowlisted operators under required policy", () => {
    validConfiguration();
    vi.stubEnv("WEBAUTHN_ADMIN_POLICY", "required");
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "ops@openvpm.com");

    expect(
      passkeyRequiredForIdentity({
        role: "admin",
        email: "clinic@example.com",
      }),
    ).toBe(true);
    expect(
      passkeyRequiredForIdentity({
        role: "veterinarian",
        email: "OPS@OPENVPM.COM",
      }),
    ).toBe(true);
    expect(
      passkeyRequiredForIdentity({
        role: "veterinarian",
        email: "doctor@example.com",
      }),
    ).toBe(false);

    vi.stubEnv("WEBAUTHN_ADMIN_POLICY", "migration");
    expect(
      passkeyRequiredForIdentity({
        role: "admin",
        email: "clinic@example.com",
      }),
    ).toBe(false);
  });
});
