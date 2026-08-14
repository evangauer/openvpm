/**
 * Which experience greets a brand-new practice. "welcome" (default) is the
 * value-first Polaroid guide surface; "wizard" restores the previous
 * behavior exactly (the Make-it-yours wizard auto-opens), giving hosted a
 * one-env-var rollback with no code change.
 *
 * NEXT_PUBLIC_ vars are inlined at build time, so this must stay a direct
 * property access.
 */
export function firstRunMode(): "welcome" | "wizard" {
  return process.env.NEXT_PUBLIC_FIRST_RUN_MODE?.trim().toLowerCase() ===
    "wizard"
    ? "wizard"
    : "welcome";
}

/** Keep conversion deep links focused; Guides still opens the welcome manually. */
export function suppressWelcomeForBilling(
  pathname: string,
  searchParams: Pick<URLSearchParams, "get">,
) {
  return pathname === "/settings" && searchParams.get("tab") === "billing";
}
