/**
 * Platform (operator) admin — distinct from a practice's own "admin" role. These
 * are OpenVPM staff who can see the cross-tenant operations dashboard. Gated by
 * an env allowlist so there's no in-app way to escalate into it.
 */

export function platformAdminEmails(): string[] {
  return (process.env.PLATFORM_ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isPlatformAdmin(email?: string | null): boolean {
  if (!email) return false;
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) return false;
  return platformAdminEmails().includes(normalizedEmail);
}
