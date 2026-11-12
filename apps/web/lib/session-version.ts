import { sql } from "drizzle-orm";
import { users } from "@openpims/db";

/**
 * The users.session_version column default. Sessions issued before the
 * version was carried in the JWT are treated as this generation, so they keep
 * working until the account's version is bumped for the first time.
 */
export const DEFAULT_SESSION_VERSION = 1;

/**
 * Whether a signed session still belongs to the account's current identity
 * generation. Every server path that trusts a staff session must check this
 * against a fresh users.session_version read.
 */
export function sessionVersionIsCurrent(
  tokenVersion: unknown,
  currentVersion: number,
): boolean {
  const version =
    tokenVersion === undefined || tokenVersion === null
      ? DEFAULT_SESSION_VERSION
      : tokenVersion;
  return (
    typeof version === "number" &&
    Number.isInteger(version) &&
    version === currentVersion
  );
}

/**
 * Update-set fragment that revokes every session issued for the user so far.
 * Use it on password resets, role changes, and deactivation/restoration.
 */
export function bumpSessionVersion() {
  return sql`${users.sessionVersion} + 1`;
}

/**
 * Update-set fragment for a staff edit that may change the role: revokes the
 * user's sessions only when the stored role actually changes.
 */
export function bumpSessionVersionOnRoleChange(
  role: (typeof users.role.enumValues)[number] | undefined,
) {
  if (role === undefined) return undefined;
  return sql`case when ${users.role} = ${role} then ${users.sessionVersion} else ${users.sessionVersion} + 1 end`;
}

/**
 * Update-set fragment for restoring a deactivated user: sessions issued before
 * the deactivation stay revoked, while restoring an already-active account is
 * a no-op for its sessions.
 */
export function bumpSessionVersionOnRestore() {
  return sql`case when ${users.deletedAt} is null then ${users.sessionVersion} else ${users.sessionVersion} + 1 end`;
}
