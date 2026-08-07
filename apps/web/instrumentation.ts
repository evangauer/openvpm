import type { Instrumentation } from "next";

const REQUEST_ERROR_DEDUPE_MS = 60_000;
const MAX_RECENT_REQUEST_ERRORS = 100;
const recentRequestErrors = new Map<string, number>();

function errorFingerprint(
  error: Error & { digest?: string },
  routePath: string,
  routeType: string
): string {
  return [error.digest ?? error.message, routePath, routeType].join(":");
}

function shouldReportRequestError(key: string, now = Date.now()): boolean {
  const previous = recentRequestErrors.get(key);
  if (previous !== undefined && now - previous < REQUEST_ERROR_DEDUPE_MS) {
    return false;
  }

  recentRequestErrors.set(key, now);
  if (recentRequestErrors.size > MAX_RECENT_REQUEST_ERRORS) {
    for (const [candidate, reportedAt] of recentRequestErrors) {
      if (now - reportedAt >= REQUEST_ERROR_DEDUPE_MS) {
        recentRequestErrors.delete(candidate);
      }
    }
    while (recentRequestErrors.size > MAX_RECENT_REQUEST_ERRORS) {
      const oldest = recentRequestErrors.keys().next().value;
      if (oldest === undefined) break;
      recentRequestErrors.delete(oldest);
    }
  }
  return true;
}

export const onRequestError: Instrumentation.onRequestError = async (
  error,
  request,
  context
) => {
  const normalizedError =
    error instanceof Error ? error : new Error("Unhandled request error");
  const digest =
    typeof error === "object" &&
    error !== null &&
    "digest" in error &&
    typeof error.digest === "string"
      ? error.digest
      : undefined;
  const reportableError = Object.assign(normalizedError, { digest });
  const key = errorFingerprint(
    reportableError,
    context.routePath,
    context.routeType
  );
  if (!shouldReportRequestError(key)) return;

  // The ops alert implementation is intentionally Node-only. Edge failures
  // remain visible in Vercel logs without pulling Node dependencies into an
  // Edge bundle.
  if (process.env.NEXT_RUNTIME === "edge") {
    console.error(
      `[next-request-error] ${context.routeType} ${context.routePath} digest=${digest ?? "unavailable"}`
    );
    return;
  }

  const { captureException } = await import("@/lib/error-tracking");
  await captureException({
    source: `next-${context.routeType}`,
    message: normalizedError.message || "Unhandled request error",
    stack: normalizedError.stack ?? null,
    digest: digest ?? null,
    path: request.path,
  });
};

export function resetRequestErrorDedupeForTests(): void {
  if (process.env.NODE_ENV === "test") recentRequestErrors.clear();
}
