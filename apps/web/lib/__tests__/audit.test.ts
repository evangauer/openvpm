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
  it("redacts bulk import/restore payloads (csv, backup) so PHI is not copied into the audit trail", () => {
    const out = redactSecrets({
      csv: "clientEmail,patientName,date,notes\njane@x.com,Rex,2024-03-05,Sensitive medical note",
      dryRun: true,
    })!;
    expect(out.csv).toBe("[redacted-bulk-payload]");
    const onboarding = redactSecrets({
      csv: "patient rows",
      clientCsv: "client rows with PII",
    })!;
    expect(onboarding.csv).toBe("[redacted-bulk-payload]");
    expect(onboarding.clientCsv).toBe("[redacted-bulk-payload]");
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
