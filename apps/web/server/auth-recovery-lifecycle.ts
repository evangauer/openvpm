import { createHash } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { authRecoveryCases, authRecoveryEvents, users } from "@openpims/db";
import { db, type Database } from "@openpims/db/client";
import { rowsFromExecute } from "@/lib/db/execute-rows";
import { withSystem } from "@/lib/tenant-db";
import {
  beginWebAuthnRegistration,
  finishWebAuthnRegistration,
} from "@/lib/webauthn-ceremony";

export const AUTH_RECOVERY_EXPIRY_BATCH_SIZE = 100;
export const AUTH_RECOVERY_EXPIRY_MAX_BATCH_SIZE = 1_000;
export const AUTH_RECOVERY_GRANT_LENGTH = 43;

const AUTH_RECOVERY_GRANT_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const RECOVERY_GRANT_HASH_DOMAIN = "openvpm-auth-recovery-grant:v1:";
const INVALID_GRANT_MESSAGE = "Recovery grant is invalid or expired.";

function validatedGrant(grant: string): string {
  if (!AUTH_RECOVERY_GRANT_PATTERN.test(grant)) {
    throw new Error(INVALID_GRANT_MESSAGE);
  }
  const decoded = Buffer.from(grant, "base64url");
  if (
    decoded.byteLength !== 32 ||
    decoded.toString("base64url") !== grant
  ) {
    throw new Error(INVALID_GRANT_MESSAGE);
  }
  return grant;
}

/** Domain-separated digest; the raw one-time grant is never persisted. */
export function authRecoveryGrantHash(grant: string): string {
  return createHash("sha256")
    .update(`${RECOVERY_GRANT_HASH_DOMAIN}${validatedGrant(grant)}`)
    .digest("hex");
}

async function lockApprovedRecoveryCase(
  database: Database,
  recoveryGrantHash: string,
) {
  const [recovery] = await database
    .select({
      caseId: authRecoveryCases.id,
      email: users.email,
      name: users.name,
      practiceId: authRecoveryCases.practiceId,
      revokedSessionVersion: authRecoveryCases.revokedSessionVersion,
      userId: authRecoveryCases.userId,
      userSessionVersion: users.sessionVersion,
    })
    .from(authRecoveryCases)
    .innerJoin(
      users,
      and(
        eq(users.id, authRecoveryCases.userId),
        eq(users.practiceId, authRecoveryCases.practiceId),
        isNull(users.deletedAt),
      ),
    )
    .where(
      and(
        eq(authRecoveryCases.status, "approved"),
        eq(authRecoveryCases.recoveryGrantHash, recoveryGrantHash),
        gt(authRecoveryCases.grantExpiresAt, new Date()),
      ),
    )
    .limit(1)
    .for("update");

  const revokedSessionVersion = recovery?.revokedSessionVersion;
  if (
    !revokedSessionVersion ||
    recovery.userSessionVersion !== revokedSessionVersion
  ) {
    throw new Error(INVALID_GRANT_MESSAGE);
  }
  return { ...recovery, revokedSessionVersion };
}

/**
 * Start the first replacement-passkey ceremony from an already approved grant.
 * No route calls this dormant server-only primitive.
 */
export async function beginAuthRecoveryRegistration(input: {
  database?: Database;
  grant: string;
}) {
  const recoveryGrantHash = authRecoveryGrantHash(input.grant);
  return withSystem(input.database ?? db, async (tx) => {
    const recovery = await lockApprovedRecoveryCase(tx, recoveryGrantHash);
    return beginWebAuthnRegistration({
      database: tx,
      identity: {
        email: recovery.email,
        name: recovery.name,
        practiceId: recovery.practiceId,
        sessionVersion: recovery.revokedSessionVersion,
        userId: recovery.userId,
      },
      purpose: "recovery_registration",
      recoveryCaseId: recovery.caseId,
    });
  });
}

/**
 * Verify and persist the first replacement passkey, consume its challenge,
 * consume the one-time grant, and append immutable evidence atomically.
 */
export async function finishAuthRecoveryRegistration(input: {
  challengeId: string;
  credentialName: string;
  database?: Database;
  grant: string;
  response: RegistrationResponseJSON;
}): Promise<{ credentialId: string }> {
  const recoveryGrantHash = authRecoveryGrantHash(input.grant);
  return withSystem(input.database ?? db, async (tx) => {
    const recovery = await lockApprovedRecoveryCase(tx, recoveryGrantHash);
    const registered = await finishWebAuthnRegistration({
      challengeId: input.challengeId,
      database: tx,
      identity: {
        email: recovery.email,
        name: recovery.name,
        practiceId: recovery.practiceId,
        sessionVersion: recovery.revokedSessionVersion,
        userId: recovery.userId,
      },
      name: input.credentialName,
      purpose: "recovery_registration",
      recoveryCaseId: recovery.caseId,
      response: input.response,
    });

    const consumedAt = new Date();
    const [consumed] = await tx
      .update(authRecoveryCases)
      .set({
        consumedAt,
        status: "consumed",
        updatedAt: consumedAt,
      })
      .where(
        and(
          eq(authRecoveryCases.id, recovery.caseId),
          eq(authRecoveryCases.status, "approved"),
          eq(authRecoveryCases.recoveryGrantHash, recoveryGrantHash),
          gt(authRecoveryCases.grantExpiresAt, consumedAt),
        ),
      )
      .returning({ id: authRecoveryCases.id });
    if (!consumed) throw new Error(INVALID_GRANT_MESSAGE);

    await tx.insert(authRecoveryEvents).values({
      actorUserId: recovery.userId,
      caseId: recovery.caseId,
      eventType: "grant_consumed",
      occurredAt: consumedAt,
      practiceId: recovery.practiceId,
      userId: recovery.userId,
    });
    return { credentialId: registered.credentialId };
  });
}

/** Run the database-owned expiry transition in bounded, skip-locked batches. */
export async function expireDueAuthRecoveryCases(
  database: Database = db,
  batchSize = AUTH_RECOVERY_EXPIRY_BATCH_SIZE,
): Promise<number> {
  if (
    !Number.isInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > AUTH_RECOVERY_EXPIRY_MAX_BATCH_SIZE
  ) {
    throw new Error("Auth recovery expiry batch size is invalid.");
  }
  return withSystem(database, async (tx) => {
    const result = await tx.execute(sql`
      select expire_due_auth_recovery_cases(${batchSize})::int
        as "expiredCount"
    `);
    const expiredCount = rowsFromExecute<{ expiredCount: number }>(result)[0]
      ?.expiredCount;
    if (
      !Number.isSafeInteger(expiredCount) ||
      expiredCount < 0 ||
      expiredCount > batchSize
    ) {
      throw new Error("Auth recovery expiry returned an invalid result.");
    }
    return expiredCount;
  });
}
