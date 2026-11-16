import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emailPreferenceIdentityKeyFingerprint } from "../email-preferences";
import {
  diagnoseEmailIdentity,
  type IdentitySnapshot,
} from "../email-identity-diagnosis";
import { parseCandidateNames } from "../../scripts/diagnose-email-identity";

const DEMO_KEY = "demo-identity-key-kept-stable-at-least-32-bytes";
const APP_KEY = "app-identity-key-kept-stable-at-least-32-bytes!";
const LOST_KEY = "lost-identity-key-nobody-has-at-least-32-bytes";
const fp = (secret: string) =>
  emailPreferenceIdentityKeyFingerprint({ identitySecret: secret })!;

function snapshot(
  registered: string | null,
  rows: IdentitySnapshot["byFingerprint"] = [],
  extra: Partial<IdentitySnapshot> = {},
): IdentitySnapshot {
  return {
    registry: registered
      ? {
          identityKeyFingerprint: fp(registered),
          previousIdentityKeyFingerprint: null,
          rotationStartedAt: null,
        }
      : null,
    byFingerprint: rows,
    aliases: 0,
    ...extra,
  };
}

const candidates = [
  { name: "DEMO_KEY", secret: DEMO_KEY },
  { name: "APP_KEY", secret: APP_KEY },
];

beforeEach(() => {
  // A configured key must never leak into a candidate that has no value.
  vi.stubEnv("EMAIL_PREFERENCE_IDENTITY_SECRET", LOST_KEY);
});
afterEach(() => vi.unstubAllEnvs());

describe("diagnoseEmailIdentity", () => {
  it("names the candidate that registered the database and preserves its records", () => {
    const result = diagnoseEmailIdentity(
      snapshot(APP_KEY, [
        { fingerprint: fp(APP_KEY), preferences: 4, optOuts: 3, events: 9 },
      ]),
      candidates,
    );

    expect(result.verdict).toBe("candidate_matches");
    expect(result.matchingCandidate).toBe("APP_KEY");
    expect(result.totals).toMatchObject({ optOuts: 3, orphanedPreferences: 0 });
    expect(result.nextStep).toContain("No database change is needed");
  });

  it("allows re-registration only when no preference records exist", () => {
    const result = diagnoseEmailIdentity(snapshot(LOST_KEY), candidates);

    expect(result.verdict).toBe("no_match_no_preferences");
    expect(result.matchingCandidate).toBeNull();
  });

  it("stops when unsubscribes are keyed by a key nobody has", () => {
    const result = diagnoseEmailIdentity(
      snapshot(LOST_KEY, [
        { fingerprint: fp(LOST_KEY), preferences: 2, optOuts: 2, events: 2 },
      ]),
      candidates,
    );

    expect(result.verdict).toBe("no_match_with_preferences");
    expect(result.nextStep).toMatch(/^Stop\./);
  });

  it("counts preferences keyed outside the registered ring as orphaned", () => {
    const result = diagnoseEmailIdentity(
      snapshot(DEMO_KEY, [
        { fingerprint: fp(DEMO_KEY), preferences: 1, optOuts: 0, events: 1 },
        { fingerprint: fp(LOST_KEY), preferences: 5, optOuts: 5, events: 5 },
      ]),
      candidates,
    );

    expect(result.verdict).toBe("candidate_matches");
    expect(result.totals.orphanedPreferences).toBe(5);
  });

  it("reports an active rotation instead of advising a single-key fix", () => {
    const result = diagnoseEmailIdentity(
      snapshot(APP_KEY, [], {
        registry: {
          identityKeyFingerprint: fp(APP_KEY),
          previousIdentityKeyFingerprint: fp(DEMO_KEY),
          rotationStartedAt: "2026-11-01T00:00:00.000Z",
        },
      }),
      candidates,
    );

    expect(result.verdict).toBe("rotation_in_progress");
    expect(result.candidates.find((c) => c.name === "DEMO_KEY")).toMatchObject({
      matchesRegisteredPrevious: true,
    });
  });

  it("never outputs key material and ignores missing candidate values", () => {
    const result = diagnoseEmailIdentity(snapshot(LOST_KEY), [
      ...candidates,
      { name: "UNSET_KEY", secret: undefined },
    ]);
    const output = JSON.stringify(result);

    for (const secret of [DEMO_KEY, APP_KEY, LOST_KEY]) {
      expect(output).not.toContain(secret);
    }
    expect(result.candidates.at(-1)).toMatchObject({
      name: "UNSET_KEY",
      fingerprint: null,
      matchesRegisteredCurrent: false,
    });
  });
});

describe("parseCandidateNames", () => {
  it("accepts environment variable names only", () => {
    expect(
      parseCandidateNames(["--candidate", "KEY_A", "--candidate", "KEY_B"]),
    ).toEqual(["KEY_A", "KEY_B"]);
    expect(() => parseCandidateNames(["--candidate", DEMO_KEY])).toThrow(
      "invalid_candidate_name",
    );
    expect(() => parseCandidateNames([])).toThrow("no_candidates");
    expect(() => parseCandidateNames(["KEY_A"])).toThrow("invalid_arguments");
  });
});
