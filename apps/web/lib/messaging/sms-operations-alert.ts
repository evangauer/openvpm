import { sql } from "drizzle-orm";
import { auditLog } from "@openpims/db";
import { db, type Database } from "@openpims/db/client";
import { rowsFromExecute } from "@/lib/db/execute-rows";
import { withSystem } from "@/lib/tenant-db";

export const SMS_OPERATIONS_ALERT_COOLDOWN_HOURS = 6;

export type SmsOperationsAlertState = "healthy" | "degraded";

/**
 * Serialize health-state transitions and alert delivery. A recovered state is
 * recorded so the same incident alerts immediately if it recurs. The degraded
 * claim is written only after confirmed delivery; a failed transport therefore
 * remains retryable on the next monitor run.
 */
export async function processSmsOperationsAlertState(input: {
  fingerprint: string;
  state: SmsOperationsAlertState;
  deliver?: () => Promise<boolean>;
}): Promise<{ alerted: boolean; deliveryFailed: boolean }> {
  return withSystem(db, (tx) =>
    processSmsOperationsAlertStateWithDatabase(tx, input),
  );
}

export async function processSmsOperationsAlertStateWithDatabase(
  database: Pick<Database, "execute">,
  input: {
    fingerprint: string;
    state: SmsOperationsAlertState;
    deliver?: () => Promise<boolean>;
  },
): Promise<{ alerted: boolean; deliveryFailed: boolean }> {
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended('sms-operations-alert', 0))`,
  );
  const recentResult = await database.execute(sql`
    select
      ${auditLog.changes}->>'fingerprint' as "fingerprint",
      ${auditLog.changes}->>'state' as "state",
      ${auditLog.createdAt} >= now() - (${SMS_OPERATIONS_ALERT_COOLDOWN_HOURS} * interval '1 hour') as "withinCooldown"
    from ${auditLog}
    where ${auditLog.action} = 'sms_ops_alert_state'
      and ${auditLog.entityType} = 'sms_operations'
      and ${auditLog.practiceId} is null
    order by ${auditLog.createdAt} desc
    limit 1
  `);
  const recent = rowsFromExecute<{
    fingerprint: string | null;
    state: string | null;
    withinCooldown: boolean;
  }>(recentResult)[0];

  if (input.state === "degraded") {
    if (
      recent?.state === "degraded" &&
      recent.fingerprint === input.fingerprint &&
      recent.withinCooldown
    ) {
      return { alerted: false, deliveryFailed: false };
    }
    if (!input.deliver || !(await input.deliver())) {
      return { alerted: false, deliveryFailed: true };
    }
  } else if (recent?.state === "healthy") {
    return { alerted: false, deliveryFailed: false };
  }

  await database.execute(sql`
    insert into ${auditLog} (action, entity_type, changes)
    values (
      'sms_ops_alert_state',
      'sms_operations',
      jsonb_build_object(
        'fingerprint', ${input.fingerprint},
        'state', ${input.state}
      )
    )
  `);
  return {
    alerted: input.state === "degraded",
    deliveryFailed: false,
  };
}
