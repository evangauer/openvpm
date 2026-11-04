/**
 * Sign-in error codes shared by the credentials provider and the login page.
 * Client-safe: no server imports.
 */

const LOGIN_RATE_LIMITED_PREFIX = "LoginRateLimited:";

export const INVALID_LOGIN_MESSAGE = "Invalid email or password";

/** Error code thrown from `authorize`; NextAuth returns it to `signIn()` as `error`. */
export function loginRateLimitedErrorCode(retryAfterSeconds: number): string {
  const seconds = Math.max(1, Math.ceil(retryAfterSeconds));
  return `${LOGIN_RATE_LIMITED_PREFIX}${seconds}`;
}

export function loginRetryAfterSeconds(error: string | null | undefined): number | null {
  if (!error?.startsWith(LOGIN_RATE_LIMITED_PREFIX)) return null;
  const seconds = Number(error.slice(LOGIN_RATE_LIMITED_PREFIX.length));
  return Number.isInteger(seconds) && seconds > 0 ? seconds : null;
}

export function loginRateLimitedMessage(retryAfterSeconds: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  if (minutes <= 60) {
    return `Too many sign-in attempts. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
  }
  const hours = Math.ceil(minutes / 60);
  return `Too many sign-in attempts. Try again in ${hours} hours.`;
}

export function loginErrorMessage(error: string | null | undefined): string {
  const retryAfter = loginRetryAfterSeconds(error);
  return retryAfter === null
    ? INVALID_LOGIN_MESSAGE
    : loginRateLimitedMessage(retryAfter);
}
