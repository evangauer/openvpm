export const MESSAGING_PROVIDER_PROFILE_ATTESTATION_MAX_AGE_MS =
  15 * 60 * 1000;

/**
 * Provider-profile readiness is deliberately short-lived. A future timestamp
 * is not evidence, and malformed values fail closed.
 */
export function providerProfileAttestationIsCurrent(
  value: unknown,
  now: Date = new Date(),
): boolean {
  const observedAt =
    value instanceof Date
      ? value
      : typeof value === "string" || typeof value === "number"
        ? new Date(value)
        : null;
  const observedMs = observedAt?.getTime() ?? Number.NaN;
  const nowMs = now.getTime();
  return (
    Number.isFinite(observedMs) &&
    Number.isFinite(nowMs) &&
    observedMs <= nowMs &&
    observedMs >= nowMs - MESSAGING_PROVIDER_PROFILE_ATTESTATION_MAX_AGE_MS
  );
}
