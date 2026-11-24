import { emailPreferenceIdentityKeyFingerprint } from "@/lib/email-preferences";

/**
 * Read-only diagnosis of a platform email identity key mismatch.
 *
 * A deployment fails closed when its configured identity key ring does not
 * match the fingerprint registered in `platform_email_identity`. Recovering
 * means finding which key the database was registered with, without ever
 * printing or storing a key and without touching recipient preferences.
 *
 * Everything here works on fingerprints, record counts and candidate *names*.
 */

export type FingerprintCounts = {
  fingerprint: string;
  preferences: number;
  /** Active preferences with marketing disabled (unsubscribes, suppressions). */
  optOuts: number;
  events: number;
};

export type IdentitySnapshot = {
  registry: {
    identityKeyFingerprint: string;
    previousIdentityKeyFingerprint: string | null;
    rotationStartedAt: string | null;
  } | null;
  byFingerprint: FingerprintCounts[];
  aliases: number;
};

export type IdentityCandidate = {
  /** Environment variable name the key was read from. Never the value. */
  name: string;
  secret: string | undefined;
};

export type CandidateResult = {
  name: string;
  /** Key fingerprint (SHA-256, not reversible), or null when unusable. */
  fingerprint: string | null;
  matchesRegisteredCurrent: boolean;
  matchesRegisteredPrevious: boolean;
  keyedPreferences: number;
};

export type IdentityVerdict =
  | "registry_empty"
  | "candidate_matches"
  | "rotation_in_progress"
  | "no_match_no_preferences"
  | "no_match_with_preferences";

export type IdentityDiagnosis = {
  verdict: IdentityVerdict;
  registered: {
    current: string | null;
    previous: string | null;
    rotationStartedAt: string | null;
  };
  totals: {
    preferences: number;
    optOuts: number;
    events: number;
    aliases: number;
    /** Preferences keyed by a fingerprint other than the registered one(s). */
    orphanedPreferences: number;
  };
  candidates: CandidateResult[];
  matchingCandidate: string | null;
  nextStep: string;
};

export function diagnoseEmailIdentity(
  snapshot: IdentitySnapshot,
  candidates: readonly IdentityCandidate[],
): IdentityDiagnosis {
  const current = snapshot.registry?.identityKeyFingerprint ?? null;
  const previous = snapshot.registry?.previousIdentityKeyFingerprint ?? null;
  const counts = new Map(
    snapshot.byFingerprint.map((row) => [row.fingerprint, row]),
  );
  const sum = (pick: (row: FingerprintCounts) => number) =>
    snapshot.byFingerprint.reduce((total, row) => total + pick(row), 0);

  const registeredSet = new Set([current, previous].filter(Boolean));
  const orphanedPreferences = snapshot.byFingerprint
    .filter((row) => !registeredSet.has(row.fingerprint))
    .reduce((total, row) => total + row.preferences, 0);

  const results: CandidateResult[] = candidates.map((candidate) => {
    const fingerprint = emailPreferenceIdentityKeyFingerprint({
      identitySecret: candidate.secret ?? "",
    });
    return {
      name: candidate.name,
      fingerprint: fingerprint ?? null,
      matchesRegisteredCurrent: Boolean(fingerprint && fingerprint === current),
      matchesRegisteredPrevious: Boolean(
        fingerprint && previous && fingerprint === previous,
      ),
      keyedPreferences: fingerprint
        ? (counts.get(fingerprint)?.preferences ?? 0)
        : 0,
    };
  });

  const totals = {
    preferences: sum((row) => row.preferences),
    optOuts: sum((row) => row.optOuts),
    events: sum((row) => row.events),
    aliases: snapshot.aliases,
    orphanedPreferences,
  };
  const registered = {
    current,
    previous,
    rotationStartedAt: snapshot.registry?.rotationStartedAt ?? null,
  };
  const match = results.find((result) => result.matchesRegisteredCurrent);

  const verdictFor = (): Pick<IdentityDiagnosis, "verdict" | "nextStep"> => {
    if (!current) {
      return {
        verdict: "registry_empty",
        nextStep:
          "No key is registered yet. The first preference operation registers the configured key; configure the intended key before any traffic reaches this database.",
      };
    }
    if (previous) {
      return {
        verdict: "rotation_in_progress",
        nextStep: match
          ? `A registered rotation is active. Configure ${match.name} as the current key and keep the exact former key as EMAIL_PREFERENCE_IDENTITY_SECRET_PREVIOUS.`
          : "A registered rotation is active, but no candidate matches the current key. Find the key that registered this rotation before changing anything.",
      };
    }
    if (match) {
      return {
        verdict: "candidate_matches",
        nextStep: `Configure the value of ${match.name} as EMAIL_PREFERENCE_IDENTITY_SECRET on this deployment, leave the previous key unset, redeploy and confirm /api/health. No database change is needed and every stored preference is preserved.`,
      };
    }
    if (
      totals.preferences === 0 &&
      totals.events === 0 &&
      totals.aliases === 0
    ) {
      return {
        verdict: "no_match_no_preferences",
        nextStep:
          "No candidate matches, and this database holds no preference records, so nothing can be lost. Re-register slot 1 to the intended key with the conditional update in docs/hosted-cloud-production.md (demo identity key recovery), then redeploy.",
      };
    }
    return {
      verdict: "no_match_with_preferences",
      nextStep:
        "Stop. Preference records are keyed by a key no candidate matches. Do not re-register or delete them: keep searching for the original key (older deployments, secret manager history), and confirm the canonical app database already holds these recipients' choices before deciding anything further.",
    };
  };

  return {
    ...verdictFor(),
    registered,
    totals,
    candidates: results,
    matchingCandidate: match?.name ?? null,
  };
}
