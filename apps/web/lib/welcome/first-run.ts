/**
 * Which experience greets a brand-new practice. The personalized workspace
 * builder is the default; "welcome" remains an explicit one-env-var rollback
 * to the Polaroid guide surface. Guides stay available from Settings either
 * way after the clinic has shaped its first useful day.
 *
 * NEXT_PUBLIC_ vars are inlined at build time, so this must stay a direct
 * property access.
 */
export function firstRunMode(): "welcome" | "wizard" {
  return process.env.NEXT_PUBLIC_FIRST_RUN_MODE?.trim().toLowerCase() ===
    "welcome"
    ? "welcome"
    : "wizard";
}

/** Keep conversion deep links focused; Guides still opens the welcome manually. */
export function suppressWelcomeForBilling(
  pathname: string,
  searchParams: Pick<URLSearchParams, "get">,
) {
  return pathname === "/settings" && searchParams.get("tab") === "billing";
}
