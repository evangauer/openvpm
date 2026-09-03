const SAFE_ERROR_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const SAFE_ERROR_CODE = /^[A-Z0-9]{2,16}$/;

/**
 * Return only bounded exception classification metadata. Error messages,
 * stacks, query parameters, and causes can contain PHI or bearer credentials
 * and must not reach capability-route telemetry.
 */
export function sanitizedExceptionTelemetry(error: unknown): {
  errorName: string;
  errorCode?: string;
} {
  const candidateName =
    error instanceof Error && SAFE_ERROR_NAME.test(error.name)
      ? error.name
      : "UnknownError";
  const candidateCode =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    SAFE_ERROR_CODE.test(error.code)
      ? error.code
      : undefined;
  return candidateCode
    ? { errorName: candidateName, errorCode: candidateCode }
    : { errorName: candidateName };
}
