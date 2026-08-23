import { sql } from "drizzle-orm";
import type { Database } from "@openpims/db/client";

export type TenantTransactionOptions = {
  isolationLevel?: "serializable";
};

/**
 * Tenant database context for Postgres Row-Level Security (defense-in-depth
 * behind the app-layer practiceId filters).
 *
 * RLS policies key off the `app.current_practice_id` GUC. Because postgres-js
 * pools connections, the GUC must be set on the SAME connection that runs the
 * queries — so we set it inside a transaction (set_config(..., true) = local to
 * the tx) and hand the transaction handle to the callback.
 *
 * On the owner DB role (used in dev/self-host) RLS is bypassed, so these
 * wrappers are a harmless no-op there. Enforcement activates when the app
 * connects as the least-privilege role (see packages/db/rls/enable-rls.sql).
 */
export async function withTenant<T>(
  db: Database,
  practiceId: string,
  fn: (tx: Database) => Promise<T>,
  options: TenantTransactionOptions = {},
): Promise<T> {
  return db.transaction(async (tx) => {
    if (options.isolationLevel === "serializable") {
      // PostgreSQL requires transaction characteristics to be set before the
      // tenant GUC or any other statement. This must remain on the outermost
      // transaction; setting it inside a Drizzle savepoint raises SQLSTATE
      // 25001 and turns otherwise safe patient merges into HTTP 500s.
      await tx.execute(sql`set transaction isolation level serializable`);
    }
    await tx.execute(
      sql`select set_config('app.current_practice_id', ${practiceId}, true)`,
    );
    return fn(tx as unknown as Database);
  });
}

/**
 * Run a multi-query tenant export against one read-only MVCC snapshot. The
 * transaction characteristics must be the first statement so Postgres applies
 * them before the tenant GUC and any export reads.
 */
export async function withTenantReadOnlySnapshot<T>(
  db: Database,
  practiceId: string,
  fn: (tx: Database) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`set transaction isolation level repeatable read read only`,
    );
    await tx.execute(
      sql`select set_config('app.current_practice_id', ${practiceId}, true)`,
    );
    return fn(tx as unknown as Database);
  });
}

/**
 * System context that bypasses tenant RLS — for cross-tenant operations
 * (platform admin, cron sweeps) and pre-tenant flows (registration, login,
 * subscription webhooks that look up a practice by Stripe id).
 */
export async function withSystem<T>(
  db: Database,
  fn: (tx: Database) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.rls_bypass', 'on', true)`);
    return fn(tx as unknown as Database);
  });
}
