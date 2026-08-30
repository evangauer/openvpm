import { describe, expect, it } from "vitest";
import { evaluateWebAuthnEnrollmentReadiness } from "../webauthn-readiness";

const admin = { id: "admin-1", email: "admin@clinic.example" };
const operator = { id: "ops-1", email: "ops@openvpm.example" };

describe("WebAuthn hosted enrollment readiness", () => {
  it("accepts only when every required identity and operator is enrolled", () => {
    expect(
      evaluateWebAuthnEnrollmentReadiness({
        requiredIdentities: [admin, operator],
        credentialUserIds: [admin.id, admin.id, operator.id, operator.id],
        operatorEmails: [operator.email.toUpperCase()],
      }),
    ).toEqual({
      ok: true,
      detail:
        "Hosted administrator/operator passkey enrollment and redundancy are complete",
    });
  });

  it("fails when a clinic administrator has no active credential", () => {
    expect(
      evaluateWebAuthnEnrollmentReadiness({
        requiredIdentities: [admin, operator],
        credentialUserIds: [operator.id, operator.id],
        operatorEmails: [operator.email],
      }).ok,
    ).toBe(false);
  });

  it("fails when an allowlisted operator has no active user", () => {
    expect(
      evaluateWebAuthnEnrollmentReadiness({
        requiredIdentities: [admin],
        credentialUserIds: [admin.id, admin.id],
        operatorEmails: [operator.email],
      }).ok,
    ).toBe(false);
  });

  it("fails closed when no required identities exist", () => {
    expect(
      evaluateWebAuthnEnrollmentReadiness({
        requiredIdentities: [],
        credentialUserIds: [],
        operatorEmails: [],
      }).ok,
    ).toBe(false);
  });

  it("fails when a required identity has only one authenticator", () => {
    expect(
      evaluateWebAuthnEnrollmentReadiness({
        requiredIdentities: [admin],
        credentialUserIds: [admin.id],
        operatorEmails: [],
      }).ok,
    ).toBe(false);
  });
});
