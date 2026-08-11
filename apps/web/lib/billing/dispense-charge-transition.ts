import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "@openpims/db/client";

export type DispenseChargeTransitionSource =
  | "invoice_create"
  | "invoice_edit"
  | "medication_queue"
  | "visit_reconciliation"
  | "invoice_void"
  | "invoice_line_removed"
  | "database_safeguard";

type TransitionDb = Pick<Database, "execute">;

/**
 * Attach bounded, transaction-local attribution to medication charge changes.
 * The database trigger remains authoritative and supplies safe fallbacks for
 * non-application safeguards. Returning the operation id lets every affected
 * dispense in one user action share the same durable operation identity.
 */
export async function setDispenseChargeTransitionContext(
  db: TransitionDb,
  input: {
    source: DispenseChargeTransitionSource;
    actor: { id: string; name: string };
    reason?: string | null;
    operationId?: string;
  },
): Promise<string> {
  const operationId = input.operationId ?? randomUUID();
  await db.execute(sql`
    select
      set_config('app.dispense_charge_operation_id', ${operationId}, true),
      set_config('app.dispense_charge_transition_source', ${input.source}, true),
      set_config('app.dispense_charge_actor_id', ${input.actor.id}, true),
      set_config('app.dispense_charge_actor_name', ${input.actor.name}, true),
      set_config('app.dispense_charge_reason', ${input.reason ?? ""}, true)
  `);
  return operationId;
}
