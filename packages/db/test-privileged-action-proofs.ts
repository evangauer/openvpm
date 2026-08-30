/**
 * Real-PostgreSQL contract for exact-action step-up proofs. This intentionally
 * connects as `openpims_app` for every product operation so unit-test mocks
 * cannot conceal a replay, privilege, or tenant-isolation defect.
 */
import { config } from "dotenv";
config({ path: "../../.env" });

import { randomUUID } from "node:crypto";
import postgres from "postgres";

function nonBlankEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function appRoleUrl(ownerUrl: string): string {
  const url = new URL(ownerUrl);
  url.username = "openpims_app";
  url.password = nonBlankEnv("OPENPIMS_APP_DB_PASSWORD") ?? "openpims_app";
  return url.toString();
}

const ownerUrl = nonBlankEnv("DATABASE_URL");
if (!ownerUrl) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const owner = postgres(ownerUrl, { max: 1 });
const app = postgres(appRoleUrl(ownerUrl), { max: 1 });
const appPeer = postgres(appRoleUrl(ownerUrl), { max: 1 });

const practiceA = randomUUID();
const practiceB = randomUUID();
const userA = randomUUID();
const userB = randomUUID();
const proofA = randomUUID();
const concurrentProof = randomUUID();
const expiredProof = randomUUID();
const revokedSessionProof = randomUUID();
const deniedProof = randomUUID();
const action = "billing.refundPayment";
let failures = 0;

function check(name: string, ok: boolean) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failures += 1;
}

async function tenantTransaction<T>(
  client: typeof app,
  practiceId: string,
  fn: (tx: typeof app) => Promise<T>,
): Promise<T> {
  return client.begin(async (rawTx) => {
    const tx = rawTx as unknown as typeof app;
    await tx`select set_config('app.current_practice_id', ${practiceId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

async function rejected(operation: () => Promise<unknown>): Promise<boolean> {
  try {
    await operation();
    return false;
  } catch {
    return true;
  }
}

function proofTimes(offsetMs = 0) {
  const issuedAt = new Date(Date.now() + offsetMs - 2_000);
  return {
    issuedAt,
    expiresAt: new Date(issuedAt.getTime() + 5 * 60 * 1_000),
  };
}

async function insertProof(
  tx: typeof app,
  input: {
    id: string;
    practiceId?: string;
    userId?: string;
    nonceHash: string;
    proofAction?: string;
    times?: ReturnType<typeof proofTimes>;
  },
) {
  const times = input.times ?? proofTimes();
  return tx`insert into privileged_action_proofs
    (id, practice_id, user_id, session_version, action, nonce_hash,
      factor_type, issued_at, expires_at)
    values (${input.id}, ${input.practiceId ?? practiceA},
      ${input.userId ?? userA}, 1, ${input.proofAction ?? action},
      ${input.nonceHash}, 'totp',
      ${times.issuedAt}, ${times.expiresAt})
    returning id`;
}

try {
  await owner`insert into practices (id, name) values
    (${practiceA}, 'Privileged proof contract A'),
    (${practiceB}, 'Privileged proof contract B')`;
  await owner`insert into users
    (id, email, password_hash, name, role, practice_id)
    values
    (${userA}, ${`proof-${userA}@example.test`}, 'not-a-real-hash',
      'Proof Admin A', 'admin', ${practiceA}),
    (${userB}, ${`proof-${userB}@example.test`}, 'not-a-real-hash',
      'Proof Admin B', 'admin', ${practiceB})`;

  const [role] = await app<
    Array<{
      currentRole: string;
      canSelect: boolean;
      canInsert: boolean;
      canUpdate: boolean;
      canDelete: boolean;
      bypassesRls: boolean;
    }>
  >`select current_user as "currentRole",
      has_table_privilege(current_user, 'privileged_action_proofs', 'SELECT') as "canSelect",
      has_table_privilege(current_user, 'privileged_action_proofs', 'INSERT') as "canInsert",
      has_table_privilege(current_user, 'privileged_action_proofs', 'UPDATE') as "canUpdate",
      has_table_privilege(current_user, 'privileged_action_proofs', 'DELETE') as "canDelete",
      rolbypassrls as "bypassesRls"
    from pg_roles where rolname = current_user`;
  check(
    "proof contract runs as the non-bypass least-privilege application role",
    role?.currentRole === "openpims_app" &&
      role.canSelect &&
      role.canInsert &&
      role.canUpdate &&
      !role.canDelete &&
      !role.bypassesRls,
  );

  await tenantTransaction(app, practiceA, (tx) =>
    insertProof(tx, { id: proofA, nonceHash: "a".repeat(64) }),
  );

  const noContextRows =
    await app`select id from privileged_action_proofs where id = ${proofA}`;
  check("no tenant context cannot read a proof", noContextRows.length === 0);

  const crossTenantRows = await tenantTransaction(
    app,
    practiceB,
    (tx) => tx`select id from privileged_action_proofs where id = ${proofA}`,
  );
  check("another tenant cannot read a proof", crossTenantRows.length === 0);

  check(
    "another tenant cannot insert a proof for the protected tenant",
    await rejected(() =>
      tenantTransaction(app, practiceB, (tx) =>
        insertProof(tx, {
          id: deniedProof,
          nonceHash: "b".repeat(64),
        }),
      ),
    ),
  );

  const ownRows = await tenantTransaction(
    app,
    practiceA,
    (tx) => tx`select id from privileged_action_proofs where id = ${proofA}`,
  );
  check("the owning tenant can read its proof", ownRows.length === 1);

  check(
    "signed proof identity and scope fields are immutable",
    await rejected(() =>
      tenantTransaction(
        app,
        practiceA,
        (tx) =>
          tx`update privileged_action_proofs set action = 'apiKeys.create'
            where id = ${proofA}`,
      ),
    ),
  );

  const consumed = await tenantTransaction(
    app,
    practiceA,
    (tx) =>
      tx`update privileged_action_proofs set consumed_at = now()
        where id = ${proofA} and consumed_at is null and expires_at > now()
        returning id`,
  );
  check(
    "an active exact-action proof can be consumed once",
    consumed.length === 1,
  );

  const replay = await tenantTransaction(
    app,
    practiceA,
    (tx) =>
      tx`update privileged_action_proofs set consumed_at = now()
        where id = ${proofA} and consumed_at is null and expires_at > now()
        returning id`,
  );
  check("a consumed proof cannot be replayed", replay.length === 0);
  check(
    "a direct second consumption is rejected by the database trigger",
    await rejected(() =>
      tenantTransaction(
        app,
        practiceA,
        (tx) =>
          tx`update privileged_action_proofs set consumed_at = now()
            where id = ${proofA}`,
      ),
    ),
  );

  await tenantTransaction(app, practiceA, (tx) =>
    insertProof(tx, {
      id: concurrentProof,
      nonceHash: "c".repeat(64),
      proofAction: "admin.attachMessagingProviderIds",
    }),
  );
  const raceResults = await Promise.all([
    tenantTransaction(
      app,
      practiceA,
      (tx) =>
        tx`update privileged_action_proofs set consumed_at = now()
          where id = ${concurrentProof} and consumed_at is null and expires_at > now()
          returning id`,
    ),
    tenantTransaction(
      appPeer,
      practiceA,
      (tx) =>
        tx`update privileged_action_proofs set consumed_at = now()
          where id = ${concurrentProof} and consumed_at is null and expires_at > now()
          returning id`,
    ),
  ]);
  check(
    "two concurrent consumers produce exactly one winner",
    raceResults.reduce((count, rows) => count + rows.length, 0) === 1,
  );

  await tenantTransaction(app, practiceA, (tx) =>
    insertProof(tx, {
      id: expiredProof,
      nonceHash: "d".repeat(64),
      times: proofTimes(-10 * 60 * 1_000),
    }),
  );
  const expiredConsumption = await tenantTransaction(
    app,
    practiceA,
    (tx) =>
      tx`update privileged_action_proofs set consumed_at = now()
        where id = ${expiredProof} and consumed_at is null and expires_at > now()
        returning id`,
  );
  check("an expired proof cannot be consumed", expiredConsumption.length === 0);

  await tenantTransaction(app, practiceA, (tx) =>
    insertProof(tx, {
      id: revokedSessionProof,
      nonceHash: "e".repeat(64),
    }),
  );
  await owner`update users set session_version = 2 where id = ${userA}`;
  const revokedSessionConsumption = await tenantTransaction(
    app,
    practiceA,
    (tx) =>
      tx`update privileged_action_proofs set consumed_at = now()
        where id = ${revokedSessionProof}
          and session_version = 1
          and consumed_at is null
          and expires_at > now()
          and exists (
            select 1 from users
            where users.id = ${userA}
              and users.practice_id = ${practiceA}
              and users.session_version = 1
              and users.deleted_at is null
          )
        returning id`,
  );
  check(
    "a database session-generation change revokes an outstanding proof",
    revokedSessionConsumption.length === 0,
  );

  check(
    "the application role cannot delete proof evidence",
    await rejected(() =>
      tenantTransaction(
        app,
        practiceA,
        (tx) => tx`delete from privileged_action_proofs where id = ${proofA}`,
      ),
    ),
  );
} finally {
  await owner.begin(async (rawCleanup) => {
    const cleanup = rawCleanup as unknown as typeof owner;
    await cleanup`delete from privileged_action_proofs
      where practice_id in (${practiceA}, ${practiceB})`;
    await cleanup`delete from users where id in (${userA}, ${userB})`;
    await cleanup`delete from practices where id in (${practiceA}, ${practiceB})`;
  });
  await owner.end();
  await app.end();
  await appPeer.end();
}

if (failures > 0) {
  console.error(`\n✗ ${failures} privileged-action proof check(s) FAILED`);
  process.exit(1);
}
console.log("\n✓ Privileged-action proof database contract passed.");
