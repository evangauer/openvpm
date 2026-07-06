import { sql } from "drizzle-orm";
import { db } from "@openpims/db/client";
import type { Database } from "@openpims/db/client";
import { billingEnforced } from "@/lib/billing/plans";
import { envFlagEnabled } from "@/lib/env-bool";

export interface HostedRlsRoleStatus {
  currentUser: string;
  rolBypassRls: boolean;
  rolSuper: boolean;
  ownsTenantTables: boolean;
}

export function shouldAssertHostedRlsRole(): boolean {
  if (!billingEnforced()) return false;
  if (envFlagEnabled("SKIP_RLS_BOOT_ASSERTION")) return false;
  return (
    process.env.NODE_ENV === "production" ||
    envFlagEnabled("ENFORCE_RLS_BOOT_ASSERTION")
  );
}

export function hostedRlsRoleViolations(status: HostedRlsRoleStatus): string[] {
  const violations: string[] = [];
  if (status.rolSuper) violations.push("role is superuser");
  if (status.rolBypassRls) violations.push("role has BYPASSRLS");
  if (status.ownsTenantTables) violations.push("role owns tenant tables");
  return violations;
}

function firstRow(result: unknown): HostedRlsRoleStatus {
  const rows = Array.isArray(result)
    ? result
    : Array.isArray((result as { rows?: unknown[] } | null)?.rows)
      ? (result as { rows: unknown[] }).rows
      : [];
  const row = rows[0] as Partial<HostedRlsRoleStatus> | undefined;
  if (!row?.currentUser) {
    throw new Error("Could not inspect current Postgres role");
  }
  return {
    currentUser: String(row.currentUser),
    rolBypassRls: Boolean(row.rolBypassRls),
    rolSuper: Boolean(row.rolSuper),
    ownsTenantTables: Boolean(row.ownsTenantTables),
  };
}

export async function inspectHostedRlsRole(
  database: Database = db
): Promise<HostedRlsRoleStatus> {
  const result = await database.execute(sql`
    select
      current_user as "currentUser",
      r.rolbypassrls as "rolBypassRls",
      r.rolsuper as "rolSuper",
      exists (
        select 1
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relkind = 'r'
          and c.relname in (
            'practices',
            'clients',
            'patients',
            'appointments',
            'invoices',
            'communications',
            'usage_records'
          )
          and c.relowner = r.oid
      ) as "ownsTenantTables"
    from pg_roles r
    where r.rolname = current_user
    limit 1
  `);
  return firstRow(result);
}

export async function assertHostedRlsRole(database: Database = db): Promise<void> {
  if (!shouldAssertHostedRlsRole()) return;
  const status = await inspectHostedRlsRole(database);
  const violations = hostedRlsRoleViolations(status);
  if (violations.length > 0) {
    throw new Error(
      `Unsafe hosted DATABASE_URL role "${status.currentUser}": ${violations.join(", ")}. Use a non-owner app role without BYPASSRLS.`
    );
  }
}

let cachedAssertion: Promise<void> | null = null;

export function assertHostedRlsRoleOnce(): Promise<void> {
  if (!shouldAssertHostedRlsRole()) return Promise.resolve();
  cachedAssertion ??= assertHostedRlsRole();
  return cachedAssertion;
}
