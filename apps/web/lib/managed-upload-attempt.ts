export interface ManagedUploadAttempt {
  file: File;
  idempotencyKey: string;
}

export type ManagedUploadOutcome =
  | { kind: "success" }
  | { kind: "response"; status: number }
  | { kind: "ambiguous" };

/** Statuses where the server may have committed the upload or asks us to retry. */
export function isRetryableUploadStatus(status: number): boolean {
  return (
    status === 0 ||
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  );
}

/**
 * A newly selected File gets one operation ID. Explicit retries pass the same
 * attempt back through this helper and therefore reuse the same ID.
 */
export function selectManagedUploadFile(
  current: ManagedUploadAttempt | null,
  file: File,
  createId: () => string = () => globalThis.crypto.randomUUID(),
): ManagedUploadAttempt {
  if (current?.file === file) return current;
  return { file, idempotencyKey: createId() };
}

/**
 * Keep the attempt only when retrying is safe and necessary. A success or a
 * definitive 4xx response ends the operation; ambiguous/network failures and
 * retryable responses preserve its idempotency key.
 */
export function settleManagedUploadAttempt(
  attempt: ManagedUploadAttempt,
  outcome: ManagedUploadOutcome,
): ManagedUploadAttempt | null {
  if (outcome.kind === "ambiguous") return attempt;
  if (outcome.kind === "success") return null;
  return isRetryableUploadStatus(outcome.status) ? attempt : null;
}
