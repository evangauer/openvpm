import {
  loginRetryAfterSeconds,
} from "@/lib/login-error-message";

export type SignInFailure =
  | { kind: "credentials"; error: string | null | undefined }
  | { kind: "unavailable" };

type SignInCatalog = (
  key: "invalid" | "unavailable" | "rateLimitedMinutes" | "rateLimitedHours",
  values?: { count: number },
) => string;

/** Credential failures use the same minute and hour thresholds as the English helper. */
export function signInErrorMessage(
  failure: SignInFailure,
  translate: SignInCatalog,
): string {
  if (failure.kind === "unavailable") return translate("unavailable");

  const retryAfter = loginRetryAfterSeconds(failure.error);
  if (retryAfter === null) return translate("invalid");

  const minutes = Math.max(1, Math.ceil(retryAfter / 60));
  if (minutes <= 60) {
    return translate("rateLimitedMinutes", { count: minutes });
  }
  return translate("rateLimitedHours", { count: Math.ceil(minutes / 60) });
}
