import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cookieValue,
  issuePrivilegedActionProof,
  privilegedActionSigningConfigured,
  verifiedPrivilegedActionProof,
  verifyPrivilegedActionProof,
} from "../privileged-action-proof";

const identity = {
  userId: "00000000-0000-0000-0000-000000000001",
  practiceId: "00000000-0000-0000-0000-0000000000aa",
  sessionVersion: 4,
  action: "billing.refundPayment" as const,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("privileged action proofs", () => {
  it("binds a short-lived proof to the exact action, user, tenant, and session", () => {
    vi.stubEnv(
      "PRIVILEGED_ACTION_SIGNING_KEY",
      Buffer.alloc(32, 4).toString("base64"),
    );
    const issued = issuePrivilegedActionProof({
      ...identity,
      nowMs: 1_000_000,
    });

    expect(
      verifyPrivilegedActionProof(issued.proof, {
        ...identity,
        nowMs: 1_299_000,
      }),
    ).toBe(true);
    expect(
      verifyPrivilegedActionProof(issued.proof, {
        ...identity,
        sessionVersion: 5,
        nowMs: 1_001_000,
      }),
    ).toBe(false);
    expect(
      verifyPrivilegedActionProof(issued.proof, {
        ...identity,
        practiceId: "00000000-0000-0000-0000-0000000000bb",
        nowMs: 1_001_000,
      }),
    ).toBe(false);
    expect(
      verifyPrivilegedActionProof(issued.proof, {
        ...identity,
        action: "apiKeys.create",
        nowMs: 1_001_000,
      }),
    ).toBe(false);
    expect(issued.record.nonceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(issued.proof).not.toContain(issued.record.nonceHash);
    expect(
      verifiedPrivilegedActionProof(issued.proof, {
        ...identity,
        nowMs: 1_001_000,
      }),
    ).toMatchObject({
      action: identity.action,
      id: issued.record.id,
      nonceHash: issued.record.nonceHash,
    });
  });

  it("rejects expired and modified proofs", () => {
    vi.stubEnv(
      "PRIVILEGED_ACTION_SIGNING_KEY",
      Buffer.alloc(32, 8).toString("base64"),
    );
    const { proof } = issuePrivilegedActionProof({
      ...identity,
      nowMs: 2_000_000,
    });
    expect(
      verifyPrivilegedActionProof(proof, { ...identity, nowMs: 2_300_000 }),
    ).toBe(false);
    expect(
      verifyPrivilegedActionProof(`${proof.slice(0, -1)}x`, {
        ...identity,
        nowMs: 2_001_000,
      }),
    ).toBe(false);
  });

  it("requires a valid signing key that is separate from MFA encryption", () => {
    vi.stubEnv("PRIVILEGED_ACTION_SIGNING_KEY", "not-a-32-byte-key");
    expect(() => issuePrivilegedActionProof(identity)).toThrow(
      "Privileged action proof signing is not configured.",
    );
    const shared = Buffer.alloc(32, 7).toString("base64");
    vi.stubEnv("PRIVILEGED_ACTION_SIGNING_KEY", shared);
    vi.stubEnv("MFA_ENCRYPTION_KEY", shared);
    expect(privilegedActionSigningConfigured()).toBe(false);
    expect(() => issuePrivilegedActionProof(identity)).toThrow(
      "Privileged action proof signing is not configured.",
    );

    vi.stubEnv(
      "PRIVILEGED_ACTION_SIGNING_KEY",
      `${Buffer.alloc(32, 9).toString("base64")}=`,
    );
    vi.stubEnv("MFA_ENCRYPTION_KEY", Buffer.alloc(32, 10).toString("base64"));
    expect(privilegedActionSigningConfigured()).toBe(false);

    const sessionShared = Buffer.alloc(32, 11).toString("base64");
    vi.stubEnv("PRIVILEGED_ACTION_SIGNING_KEY", sessionShared);
    vi.stubEnv("NEXTAUTH_SECRET", sessionShared);
    expect(privilegedActionSigningConfigured()).toBe(false);
  });

  it("parses an exact encoded cookie without accepting prefix collisions", () => {
    expect(
      cookieValue("a=1; openvpm-step-up=v2%2Epayload%2Esig", "openvpm-step-up"),
    ).toBe("v2.payload.sig");
    expect(
      cookieValue("openvpm-step-up-extra=bad", "openvpm-step-up"),
    ).toBeNull();
  });
});
