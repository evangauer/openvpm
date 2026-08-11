import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "@openpims/db/client";
import { practices } from "@openpims/db";

type RecoveryHoldDb = Pick<Database, "select">;

export const RECOVERY_HOLD_BLOCK_MESSAGE =
  "This clinic is in protected recovery mode. External delivery and automated changes remain paused until OpenVPM completes recovery reconciliation.";

export async function practiceAllowsExternalSideEffects(
  database: RecoveryHoldDb,
  practiceId: string,
): Promise<boolean> {
  const [practice] = await database
    .select({ recoveryHold: practices.recoveryHold })
    .from(practices)
    .where(
      and(eq(practices.id, practiceId), isNull(practices.deletedAt)),
    )
    .limit(1);

  return practice?.recoveryHold === false;
}

/**
 * Transactional provider gate. The shared practice-row lock means an external
 * call that follows inside the same transaction cannot overlap the restore's
 * committed recovery-hold update.
 */
export async function lockPracticeForExternalSideEffects(
  database: RecoveryHoldDb,
  practiceId: string,
): Promise<boolean> {
  const [practice] = await database
    .select({ recoveryHold: practices.recoveryHold })
    .from(practices)
    .where(and(eq(practices.id, practiceId), isNull(practices.deletedAt)))
    .limit(1)
    .for("share", { of: practices });

  return practice?.recoveryHold === false;
}

export async function assertPracticeAllowsExternalSideEffects(
  database: RecoveryHoldDb,
  practiceId: string,
): Promise<void> {
  if (!(await practiceAllowsExternalSideEffects(database, practiceId))) {
    throw new Error(RECOVERY_HOLD_BLOCK_MESSAGE);
  }
}
