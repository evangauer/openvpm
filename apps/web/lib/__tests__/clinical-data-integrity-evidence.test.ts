import { describe, expect, it } from "vitest";
import {
  CLINICAL_DATA_AUDIT_SCHEMAS,
  evaluateClinicalDataIntegrityEvidence,
} from "../clinical-data-integrity-evidence";

const now = Date.parse("2026-08-30T20:00:00.000Z");
const sha = "a".repeat(40);
const fingerprint = "b".repeat(64);

type AuditDomain = keyof typeof CLINICAL_DATA_AUDIT_SCHEMAS;

function aggregateCounts(domain: AuditDomain) {
  return Object.fromEntries(
    CLINICAL_DATA_AUDIT_SCHEMAS[domain].countFields.map((field) => [field, 0]),
  );
}

function architectureState(domain: "labResults" | "vaccinations") {
  return Object.fromEntries(
    CLINICAL_DATA_AUDIT_SCHEMAS[domain].architectureFields.map((field) => [
      field,
      true,
    ]),
  );
}

function audit(domain: AuditDomain, extra: Record<string, unknown> = {}) {
  return {
    version: 1,
    mode: "read_only_aggregate",
    checkedAt: "2026-08-30T19:55:00.000Z",
    databaseTargetFingerprint: fingerprint,
    counts: aggregateCounts(domain),
    releaseSafe: true,
    ...extra,
  };
}

function healthyEvidence() {
  return {
    evidenceFormatVersion: 1,
    releaseSha: sha,
    collectedAt: "2026-08-30T20:00:00.000Z",
    databaseTargetFingerprint: fingerprint,
    audits: {
      controlledSubstances: audit("controlledSubstances", { findings: [] }),
      prescriptions: audit("prescriptions", {
        findings: [],
        architectureFindings: [],
      }),
      labResults: audit("labResults", {
        architectureState: architectureState("labResults"),
        integrityFindings: [],
        operationalFindings: [],
        architectureFindings: [],
      }),
      vaccinations: audit("vaccinations", {
        architectureState: architectureState("vaccinations"),
        integrityFindings: [],
        operationalFindings: [],
        architectureFindings: [],
      }),
    },
  };
}

describe("clinical-data integrity evidence", () => {
  it("accepts fresh, same-target, aggregate-only reports for every domain", () => {
    expect(
      evaluateClinicalDataIntegrityEvidence(healthyEvidence(), now),
    ).toEqual({
      ready: true,
      releaseSha: sha,
      databaseTargetFingerprint: fingerprint,
      reasons: [],
    });
  });

  it("fails closed when a required report is missing or marked unsafe", () => {
    const evidence = healthyEvidence();
    delete (evidence.audits as Partial<typeof evidence.audits>).labResults;
    const prescriptions = evidence.audits.prescriptions as Record<
      string,
      unknown
    >;
    prescriptions.releaseSafe = false;
    prescriptions.architectureFindings = ["interaction_catalog_is_empty"];
    expect(
      evaluateClinicalDataIntegrityEvidence(evidence, now).reasons,
    ).toEqual(
      expect.arrayContaining([
        "Clinical-data audit lab results is missing.",
        "Clinical-data audit prescriptions reports architectureFindings.",
        "Clinical-data audit prescriptions is not release-safe.",
      ]),
    );
  });

  it("rejects stale, cross-target, and malformed aggregate reports", () => {
    const evidence = healthyEvidence();
    evidence.audits.vaccinations.checkedAt = "2026-08-30T19:00:00.000Z";
    evidence.audits.vaccinations.databaseTargetFingerprint = "c".repeat(64);
    evidence.audits.vaccinations.counts.totalVaccinations = -1;
    expect(
      evaluateClinicalDataIntegrityEvidence(evidence, now).reasons,
    ).toEqual(
      expect.arrayContaining([
        "Clinical-data audit vaccinations evidence is stale.",
        "Clinical-data audit vaccinations does not match the database target.",
        "Clinical-data audit vaccinations has invalid aggregate counts.",
      ]),
    );
  });

  it("rejects extra fields instead of carrying free-form data into release evidence", () => {
    const evidence = healthyEvidence();
    (evidence as Record<string, unknown>).notes = "not allowed";
    (
      evidence.audits.controlledSubstances as Record<string, unknown>
    ).patientName = "not allowed";
    expect(
      evaluateClinicalDataIntegrityEvidence(evidence, now).reasons,
    ).toEqual(
      expect.arrayContaining([
        "Clinical-data integrity evidence has unexpected fields.",
        "Clinical-data audit controlled substances has unexpected fields.",
      ]),
    );
  });
});
