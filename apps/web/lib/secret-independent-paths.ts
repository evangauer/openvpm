// Routes that authenticate with their own credentials (provider webhook
// signatures, CRON_SECRET, API keys, signed email-preference and calendar
// tokens) or need none, and never read the staff session or anything keyed
// off NEXTAUTH_SECRET. They keep working while a rejected secret blocks
// sign-in, so payments, messaging, and scheduled jobs don't stop with it.
// Anything that reaches the session (tRPC, booking, portal, uploads) stays
// blocked. The test next to this module walks every route under these
// prefixes and fails if one starts importing the session or the secret.
export const SECRET_INDEPENDENT_PATH_PREFIXES = [
  "/api/webhooks",
  "/api/cron",
  "/api/v1",
  "/api/email-preferences",
  "/api/calendar",
  "/email-preferences",
  "/api/growth",
  "/feedback",
  "/sms",
];

export function isSecretIndependentPath(pathname: string): boolean {
  return SECRET_INDEPENDENT_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
