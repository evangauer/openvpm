import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTH_RECOVERY_POLICY_VERSION,
  checkHostedAuthRecoveryReadiness,
  evaluateAuthRecoveryReadiness,
} from "../auth-recovery-readiness";

const now = Date.parse("2026-08-30T03:00:00.000Z");
const hash = "a".repeat(64);

function completeInput() {
  return {
    authorityEmails: ["first@example.com", "second@example.com"],
    drillCompletedAt: "2026-08-29T03:00:00.000Z",
    drillEvidenceSha256: "b".repeat(64),
    platformOperatorEmails: ["first@example.com", "second@example.com"],
    policySha256: hash,
    policyVersion: AUTH_RECOVERY_POLICY_VERSION,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("hosted account recovery readiness", () => {
  it("accepts a pinned policy, two distinct operators, and a current drill", () => {
    expect(evaluateAuthRecoveryReadiness(completeInput(), now)).toEqual({
      ok: true,
      detail:
        "Hosted account recovery policy, dual control, and drill evidence are current",
    });
  });

  it("rejects missing or unrecognized policy evidence", () => {
    expect(
      evaluateAuthRecoveryReadiness(
        { ...completeInput(), policyVersion: "draft" },
        now,
      ),
    ).toMatchObject({ ok: false, detail: expect.stringContaining("policy") });
    expect(
      evaluateAuthRecoveryReadiness(
        { ...completeInput(), policySha256: "not-a-hash" },
        now,
      ),
    ).toMatchObject({ ok: false });
  });

  it("requires distinct authorities who are also configured operators", () => {
    expect(
      evaluateAuthRecoveryReadiness(
        {
          ...completeInput(),
          authorityEmails: ["first@example.com", "FIRST@example.com"],
        },
        now,
      ),
    ).toMatchObject({ ok: false, detail: expect.stringContaining("distinct") });
    expect(
      evaluateAuthRecoveryReadiness(
        {
          ...completeInput(),
          platformOperatorEmails: ["first@example.com"],
        },
        now,
      ),
    ).toMatchObject({
      ok: false,
      detail: expect.stringContaining("not platform operators"),
    });
  });

  it("rejects malformed, future, and stale drill evidence", () => {
    for (const drillCompletedAt of [
      "yesterday",
      "2026-08-30T03:02:00.000Z",
      "2026-05-01T03:00:00.000Z",
    ]) {
      expect(
        evaluateAuthRecoveryReadiness(
          { ...completeInput(), drillCompletedAt },
          now,
        ).ok,
      ).toBe(false);
    }
  });

  it("reads hosted configuration without returning authority identities", () => {
    vi.stubEnv(
      "PLATFORM_ADMIN_EMAILS",
      "first@example.com,second@example.com",
    );
    vi.stubEnv(
      "AUTH_RECOVERY_AUTHORITY_EMAILS",
      "first@example.com,second@example.com",
    );
    vi.stubEnv("AUTH_RECOVERY_POLICY_VERSION", AUTH_RECOVERY_POLICY_VERSION);
    vi.stubEnv("AUTH_RECOVERY_POLICY_SHA256", hash);
    vi.stubEnv(
      "AUTH_RECOVERY_DRILL_COMPLETED_AT",
      "2026-08-29T03:00:00.000Z",
    );
    vi.stubEnv("AUTH_RECOVERY_DRILL_EVIDENCE_SHA256", "b".repeat(64));

    const result = checkHostedAuthRecoveryReadiness(now);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("first@example.com");
  });
});
