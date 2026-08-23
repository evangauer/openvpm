import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

export type RlsDeploymentCapability = {
  currentRole: string;
  unmanageableObjects: string[];
};

type RlsCapabilityRow = {
  currentRole: string;
  unmanageableObjects: string[] | null;
};

type SqlClient = ReturnType<typeof postgres>;

/**
 * Inspect every public object the idempotent RLS script grants on, alters, or
 * replaces. This is deliberately read-only so deployment can fail before a
 * migration, password rotation, grant, policy, or other database mutation.
 */
export async function inspectRlsDeploymentCapability(
  sql: SqlClient,
): Promise<RlsDeploymentCapability> {
  const [row] = await sql<RlsCapabilityRow[]>`
    with managed_objects as (
      select
        case c.relkind
          when 'S' then 'sequence '
          when 'v' then 'view '
          when 'm' then 'materialized view '
          when 'f' then 'foreign table '
          else 'table '
        end || quote_ident(c.relname) as label,
        c.relowner as owner_oid
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')

      union all

      select
        'function ' || p.oid::regprocedure::text as label,
        p.proowner as owner_oid
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = any(array[
          'app_current_practice_id',
          'app_rls_bypass',
          'enforce_clinic_pilot_projection_audit',
          'reject_clinic_pilot_event_mutation',
          'restore_soap_note_addendum',
          'restore_soap_note_replacement',
          'validate_payment_processor_refund_tenant',
          'validate_sms_provider_event_resolution_insert'
        ]::text[])

    ), actor as (
      select rolsuper
      from pg_roles
      where rolname = current_user
    )
    select
      current_user as "currentRole",
      coalesce(
        array_agg(managed_objects.label order by managed_objects.label)
          filter (
            where not actor.rolsuper
              and not pg_has_role(
                current_user,
                pg_get_userbyid(managed_objects.owner_oid),
                'USAGE'
              )
          ),
        array[]::text[]
      ) as "unmanageableObjects"
    from managed_objects
    cross join actor
    group by actor.rolsuper
  `;

  if (!row) {
    throw new Error(
      "RLS ownership preflight could not identify the database role.",
    );
  }

  return {
    currentRole: row.currentRole,
    unmanageableObjects: row.unmanageableObjects ?? [],
  };
}

export function rlsDeploymentCapabilityIsReady(
  capability: RlsDeploymentCapability,
): boolean {
  return capability.unmanageableObjects.length === 0;
}

export function describeRlsDeploymentCapabilityFailure(
  capability: RlsDeploymentCapability,
): string {
  const shown = capability.unmanageableObjects.slice(0, 10).join(", ");
  const remaining = capability.unmanageableObjects.length - 10;
  return (
    `RLS ownership preflight failed for role ${capability.currentRole}: ` +
    `${capability.unmanageableObjects.length} public object(s) cannot be managed` +
    `${shown ? ` (${shown}${remaining > 0 ? `, and ${remaining} more` : ""})` : ""}. ` +
    "No migrations, role/password changes, grants, or RLS changes were attempted. " +
    "Use the approved database-owner migration credential or reconcile object ownership first."
  );
}

export async function assertRlsDeploymentCapability(
  sql: SqlClient,
): Promise<RlsDeploymentCapability> {
  const capability = await inspectRlsDeploymentCapability(sql);
  if (!rlsDeploymentCapabilityIsReady(capability)) {
    throw new Error(describeRlsDeploymentCapabilityFailure(capability));
  }
  return capability;
}

function nonBlankEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

async function main(): Promise<number> {
  config({ path: "../../.env" });
  const url = nonBlankEnv("DATABASE_URL");
  if (!url) {
    console.error("DATABASE_URL not set");
    return 1;
  }

  const sql = postgres(url, { max: 1 });
  try {
    const capability = await assertRlsDeploymentCapability(sql);
    console.log(
      `✓ RLS ownership preflight passed for role ${capability.currentRole}.`,
    );
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main();
}
