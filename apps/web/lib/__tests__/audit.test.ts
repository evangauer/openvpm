import { describe, it, expect } from "vitest";
import { parseAuditPath, redactSecrets, extractEntityId } from "../audit";

const UUID = "11111111-1111-1111-1111-111111111111";

describe("parseAuditPath", () => {
  it("splits entity and action on the first dot", () => {
    expect(parseAuditPath("clients.create")).toEqual({
      entityType: "clients",
      action: "create",
    });
    expect(parseAuditPath("treatmentPlans.updateItemStatus")).toEqual({
      entityType: "treatmentPlans",
      action: "updateItemStatus",
    });
  });
  it("handles a path with no dot", () => {
    expect(parseAuditPath("health")).toEqual({
      entityType: "health",
      action: "",
    });
  });
});

describe("redactSecrets", () => {
  it("redacts secret-ish keys, keeps the rest", () => {
    const out = redactSecrets({
      name: "Rex",
      password: "hunter2",
      apiKey: "x",
      note: "ok",
    });
    expect(out).toEqual({
      name: "Rex",
      password: "[redacted]",
      apiKey: "[redacted]",
      note: "ok",
    });
  });
  it("redacts keyHash/secret/token variants", () => {
    const out = redactSecrets({ keyHash: "a", secret: "b", authToken: "c" })!;
    expect(out.keyHash).toBe("[redacted]");
    expect(out.secret).toBe("[redacted]");
    expect(out.authToken).toBe("[redacted]");
  });
  it("redacts authentication and recovery codes without hiding clinical codes", () => {
    const out = redactSecrets({
      code: "123456",
      mfaCode: "654321",
      recoveryCode: "ABCD-EFGH-IJKL-MNOP",
      oneTimePassword: "789012",
      diagnosisCode: "E11.9",
    });
    expect(out).toEqual({
      code: "[redacted]",
      mfaCode: "[redacted]",
      recoveryCode: "[redacted]",
      oneTimePassword: "[redacted]",
      diagnosisCode: "E11.9",
    });
  });
  it("redacts government tax identifiers used for carrier registration", () => {
    const out = redactSecrets({
      taxId: "12-3456789",
      federalTaxId: "12-3456789",
      ein: "123456789",
      ssn: "123-45-6789",
      taxIdLast4: "6789",
      legalName: "Healthy Pets LLC",
    });

    expect(out).toEqual({
      taxId: "[redacted]",
      federalTaxId: "[redacted]",
      ein: "[redacted]",
      ssn: "[redacted]",
      taxIdLast4: "[redacted]",
      legalName: "Healthy Pets LLC",
    });
  });
  it("redacts nested secret-ish keys without dropping non-secret context", () => {
    const out = redactSecrets({
      patientId: "patient-1",
      profile: {
        email: "client@example.com",
        password: "hunter2",
      },
      contacts: [
        { name: "Owner", portalToken: "portal-token" },
        { name: "Alt", phone: "+15555550123" },
      ],
    });

    expect(out).toEqual({
      patientId: "patient-1",
      profile: {
        email: "client@example.com",
        password: "[redacted]",
      },
      contacts: [
        { name: "Owner", portalToken: "[redacted]" },
        { name: "Alt", phone: "+15555550123" },
      ],
    });
  });
  it("redacts complete WebAuthn ceremony material while retaining action context", () => {
    const out = redactSecrets({
      action: "billing.refundPayment",
      passkeyChallengeId: "challenge-row-id",
      credentialResponse: {
        id: "credential-id",
        rawId: "credential-id",
        response: {
          clientDataJSON: "client-data",
          authenticatorData: "authenticator-data",
          signature: "signature",
        },
      },
    });

    expect(out).toEqual({
      action: "billing.refundPayment",
      passkeyChallengeId: "[redacted]",
      credentialResponse: "[redacted]",
    });
  });
  it("redacts bulk import/restore payloads (csv, backup) so PHI is not copied into the audit trail", () => {
    const out = redactSecrets({
      csv: "clientEmail,patientName,date,notes\njane@x.com,Rex,2024-03-05,Sensitive medical note",
      dryRun: true,
    })!;
    expect(out.csv).toBe("[redacted-bulk-payload]");
    const onboarding = redactSecrets({
      csv: "patient rows",
      clientCsv: "client rows with PII",
      previewToken: "opaque-migration-run-id",
      source: "shepherd",
    })!;
    expect(onboarding.csv).toBe("[redacted-bulk-payload]");
    expect(onboarding.clientCsv).toBe("[redacted-bulk-payload]");
    expect(onboarding.previewToken).toBe("[redacted]");
    expect(onboarding.source).toBe("shepherd");
    expect(out.dryRun).toBe(true);

    const restore = redactSecrets({
      backup: { soap_notes: [{ subjective: "confidential" }] },
      confirmFreshPractice: true,
    })!;
    expect(restore.backup).toBe("[redacted-bulk-payload]");
    expect(restore.confirmFreshPractice).toBe(true);
  });
  it("returns null for null/undefined", () => {
    expect(redactSecrets(null)).toBeNull();
    expect(redactSecrets(undefined)).toBeNull();
  });
});

describe("extractEntityId", () => {
  it("prefers the result row id", () => {
    expect(extractEntityId({ id: "ignored" }, { id: UUID })).toBe(UUID);
  });
  it("falls back to a uuid input id", () => {
    expect(extractEntityId({ id: UUID }, { ok: true })).toBe(UUID);
  });
  it("returns null when no uuid is present", () => {
    expect(extractEntityId({ id: "not-a-uuid" }, { success: true })).toBeNull();
    expect(extractEntityId(null, null)).toBeNull();
  });
});
