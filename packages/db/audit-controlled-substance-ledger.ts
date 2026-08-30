/** Privacy-bounded, read-only preflight for existing controlled-drug history. */
import { config } from "dotenv";
config({ path: process.env.OPENPIMS_ENV_FILE?.trim() || "../../.env" });

import postgres from "postgres";
import { databaseConnectionIdentityFingerprint } from "./deployment-target";

const CONFIRMATION = "OPENVPM_CONTROLLED_SUBSTANCE_LEDGER_READ_ONLY";

function nonBlankEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function allowLiveReadOnly(): boolean {
  return (
    process.argv.includes("--allow-live-read-only") &&
    process.env.CONTROLLED_SUBSTANCE_LEDGER_READ_ONLY_CONFIRMATION ===
      CONFIRMATION
  );
}

if (!allowLiveReadOnly()) {
  console.error(
    `Refusing database access. Pass --allow-live-read-only and set CONTROLLED_SUBSTANCE_LEDGER_READ_ONLY_CONFIRMATION=${CONFIRMATION}.`,
  );
  process.exit(1);
}

const databaseUrl = nonBlankEnv("DATABASE_URL");
if (!databaseUrl) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}
const sql = postgres(databaseUrl, {
  max: 1,
  connect_timeout: 10,
  idle_timeout: 2,
});

type AuditCounts = {
  totalEntries: number;
  practicesWithEntries: number;
  knownRepositoryDemoEntries: number;
  entriesOutsideKnownRepositoryDemo: number;
  nonPositiveQuantity: number;
  administeredWithoutPatient: number;
  wasteWithoutWitness: number;
  selfWitnessed: number;
  crossTenantPatient: number;
  crossTenantPerformer: number;
  crossTenantWitness: number;
  negativeFinalBalances: number;
  negativeRunningBalanceEntries: number;
};

try {
  const databaseTargetFingerprint =
    databaseConnectionIdentityFingerprint(databaseUrl);
  const counts = await sql.begin(
    "isolation level repeatable read read only",
    async (tx) => {
      const [row] = await tx.unsafe<AuditCounts[]>(`
      with ledger as (
        select
          entry.*,
          case
            when entry.action = 'received' then entry.quantity
            else -entry.quantity
          end as signed_quantity
        from controlled_substance_log entry
        where entry.deleted_at is null
      ),
      running as (
        select
          sum(signed_quantity) over (
            partition by practice_id, drug_name, unit
            order by performed_at, id
            rows between unbounded preceding and current row
          ) as balance
        from ledger
      ),
      final_balances as (
        select sum(signed_quantity) as balance
        from ledger
        group by practice_id, drug_name, unit
      )
      select
        (select count(*)::int from ledger) as "totalEntries",
        (select count(distinct practice_id)::int from ledger) as "practicesWithEntries",
        (select count(*)::int
          from ledger entry
          join practices practice on practice.id = entry.practice_id
          where practice.name = 'Neighborhood Veterinary'
            and practice.email = 'hello@neighborhoodvet.example.com') as "knownRepositoryDemoEntries",
        (select count(*)::int
          from ledger entry
          join practices practice on practice.id = entry.practice_id
          where practice.name <> 'Neighborhood Veterinary'
            or practice.email is distinct from 'hello@neighborhoodvet.example.com') as "entriesOutsideKnownRepositoryDemo",
        (select count(*)::int from ledger where quantity <= 0) as "nonPositiveQuantity",
        (select count(*)::int from ledger where action = 'administered' and patient_id is null) as "administeredWithoutPatient",
        (select count(*)::int from ledger where action = 'wasted' and witnessed_by is null) as "wasteWithoutWitness",
        (select count(*)::int from ledger where witnessed_by = performed_by) as "selfWitnessed",
        (select count(*)::int
          from ledger entry
          left join patients patient
            on patient.practice_id = entry.practice_id
            and patient.id = entry.patient_id
          where entry.patient_id is not null and patient.id is null) as "crossTenantPatient",
        (select count(*)::int
          from ledger entry
          left join users performer
            on performer.practice_id = entry.practice_id
            and performer.id = entry.performed_by
          where performer.id is null) as "crossTenantPerformer",
        (select count(*)::int
          from ledger entry
          left join users witness
            on witness.practice_id = entry.practice_id
            and witness.id = entry.witnessed_by
          where entry.witnessed_by is not null and witness.id is null) as "crossTenantWitness",
        (select count(*)::int from final_balances where balance < 0) as "negativeFinalBalances",
        (select count(*)::int from running where balance < 0) as "negativeRunningBalanceEntries"
    `);
      if (!row)
        throw new Error("Controlled-substance audit returned no result.");
      return row;
    },
  );

  const findingKeys = (Object.keys(counts) as Array<keyof AuditCounts>).filter(
    (key) =>
      key !== "totalEntries" &&
      key !== "practicesWithEntries" &&
      key !== "knownRepositoryDemoEntries" &&
      key !== "entriesOutsideKnownRepositoryDemo" &&
      counts[key] > 0,
  );
  console.log(
    JSON.stringify(
      {
        version: 1,
        mode: "read_only_aggregate",
        checkedAt: new Date().toISOString(),
        databaseTargetFingerprint,
        counts,
        releaseSafe: findingKeys.length === 0,
        findings: findingKeys,
      },
      null,
      2,
    ),
  );
  if (findingKeys.length > 0) process.exitCode = 2;
} catch {
  console.error(
    "Controlled-substance read-only audit failed; details redacted.",
  );
  process.exitCode = 1;
} finally {
  await sql.end();
}
