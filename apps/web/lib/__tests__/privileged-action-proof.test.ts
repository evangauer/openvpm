import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cookieValue,
  issuePrivilegedActionProof,
  verifyPrivilegedActionProof,
} from "../privileged-action-proof";

const identity = {
  userId: "00000000-0000-0000-0000-000000000001",
  practiceId: "00000000-0000-0000-0000-0000000000aa",
  sessionVersion: 4,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("privileged action proofs", () => {
  it("binds a short-lived proof to the user, tenant, and session generation", () => {
    vi.stubEnv("MFA_ENCRYPTION_KEY", Buffer.alloc(32, 4).toString("base64"));
    const proof = issuePrivilegedActionProof({ ...identity, nowMs: 1_000_000 });

    expect(
      verifyPrivilegedActionProof(proof, { ...identity, nowMs: 1_599_000 }),
    ).toBe(true);
    expect(
      verifyPrivilegedActionProof(proof, {
        ...identity,
        sessionVersion: 5,
        nowMs: 1_001_000,
      }),
    ).toBe(false);
    expect(
      verifyPrivilegedActionProof(proof, {
        ...identity,
        practiceId: "00000000-0000-0000-0000-0000000000bb",
        nowMs: 1_001_000,
      }),
    ).toBe(false);
  });

  it("rejects expired and modified proofs", () => {
    vi.stubEnv("MFA_ENCRYPTION_KEY", Buffer.alloc(32, 8).toString("base64"));
    const proof = issuePrivilegedActionProof({ ...identity, nowMs: 2_000_000 });
    const replacement = proof.endsWith("x") ? "y" : "x";
    const modifiedProof = `${proof.slice(0, -1)}${replacement}`;
    expect(
      verifyPrivilegedActionProof(proof, { ...identity, nowMs: 2_600_000 }),
    ).toBe(false);
    expect(
      verifyPrivilegedActionProof(modifiedProof, {
        ...identity,
        nowMs: 2_001_000,
      }),
    ).toBe(false);
  });

  it("does not issue proofs without a valid hosted key", () => {
    vi.stubEnv("MFA_ENCRYPTION_KEY", "not-a-32-byte-key");
    expect(() => issuePrivilegedActionProof(identity)).toThrow(
      "Privileged action proof signing is not configured.",
    );
  });

  it("parses an exact encoded cookie without accepting prefix collisions", () => {
    expect(cookieValue("a=1; openvpm-step-up=v1%2Epayload%2Esig", "openvpm-step-up"))
      .toBe("v1.payload.sig");
    expect(cookieValue("openvpm-step-up-extra=bad", "openvpm-step-up")).toBeNull();
  });
});
