/**
 * Real-PostgreSQL contract for passkey credentials and one-use challenges.
 * Product operations run as openpims_app so mocks cannot hide RLS, privilege,
 * immutability, replay, or concurrency defects.
 */
import { config } from "dotenv";
config({ path: "../../.env" });

import { createHash, randomUUID } from "node:crypto";
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
const credentialA = randomUUID();
const challengeA = randomUUID();
const challengeRace = randomUUID();
const challengeExpired = randomUUID();
const challengePurge = randomUUID();
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

function challengeHash(id: string): string {
  return createHash("sha256").update(`contract:${id}`).digest("hex");
}

function challengeTimes(offsetMs = 0) {
  const issuedAt = new Date(Date.now() + offsetMs - 2_000);
  return {
    issuedAt,
    expiresAt: new Date(issuedAt.getTime() + 5 * 60 * 1_000),
  };
}

async function insertChallenge(tx: typeof app, id: string, offsetMs = 0) {
  const times = challengeTimes(offsetMs);
  return tx`insert into webauthn_challenges
    (id, practice_id, user_id, session_version, purpose, action,
      challenge_hash, issued_at, expires_at)
    values (${id}, ${practiceA}, ${userA}, 1, 'privileged_action',
      'passkeys.remove', ${challengeHash(id)}, ${times.issuedAt},
      ${times.expiresAt}) returning id`;
}

try {
  await owner`insert into practices (id, name) values
    (${practiceA}, 'WebAuthn contract A'),
    (${practiceB}, 'WebAuthn contract B')`;
  await owner`insert into users
    (id, email, password_hash, name, role, practice_id)
    values
    (${userA}, ${`passkey-${userA}@example.test`}, 'not-a-real-hash',
      'Passkey Admin A', 'admin', ${practiceA}),
    (${userB}, ${`passkey-${userB}@example.test`}, 'not-a-real-hash',
      'Passkey Admin B', 'admin', ${practiceB})`;

  const privileges = await app<
    Array<{
      tableName: string;
      canSelect: boolean;
      canInsert: boolean;
      canUpdate: boolean;
      canDelete: boolean;
      bypassesRls: boolean;
    }>
  >`select table_name as "tableName",
      has_table_privilege(current_user, table_name, 'SELECT') as "canSelect",
      has_table_privilege(current_user, table_name, 'INSERT') as "canInsert",
      has_table_privilege(current_user, table_name, 'UPDATE') as "canUpdate",
      has_table_privilege(current_user, table_name, 'DELETE') as "canDelete",
      (select rolbypassrls from pg_roles where rolname = current_user) as "bypassesRls"
    from (values ('webauthn_credentials'), ('webauthn_challenges')) tables(table_name)`;
  check(
    "both WebAuthn tables expose only select/insert/update to the non-bypass app role",
    privileges.length === 2 &&
      privileges.every(
        (row) =>
          row.canSelect &&
          row.canInsert &&
          row.canUpdate &&
          !row.canDelete &&
          !row.bypassesRls,
      ),
  );

  await tenantTransaction(
    app,
    practiceA,
    (tx) => tx`insert into webauthn_credentials
      (id, practice_id, user_id, credential_id, public_key, counter,
        device_type, backed_up, transports, aaguid, name)
      values (${credentialA}, ${practiceA}, ${userA},
        ${`credential_${credentialA.replaceAll("-", "")}`},
        decode(${"ab".repeat(32)}, 'hex'), 0, 'multiDevice', false,
        '["internal","hybrid"]'::jsonb, ${randomUUID()}, 'Contract key')`,
  );
  await tenantTransaction(app, practiceA, (tx) =>
    insertChallenge(tx, challengeA),
  );

  const noContextCredentials =
    await app`select id from webauthn_credentials where id = ${credentialA}`;
  const noContextChallenges =
    await app`select id from webauthn_challenges where id = ${challengeA}`;
  check(
    "no tenant context cannot read credentials or challenges",
    noContextCredentials.length === 0 && noContextChallenges.length === 0,
  );
  const crossTenantRows = await tenantTransaction(
    app,
    practiceB,
    (tx) => tx`select id from webauthn_credentials where id = ${credentialA}`,
  );
  check(
    "another tenant cannot read a credential",
    crossTenantRows.length === 0,
  );
  check(
    "another tenant cannot insert a challenge for the protected tenant",
    await rejected(() =>
      tenantTransaction(app, practiceB, (tx) =>
        insertChallenge(tx, randomUUID()),
      ),
    ),
  );

  const ownCredential = await tenantTransaction(
    app,
    practiceA,
    (tx) => tx`select id from webauthn_credentials where id = ${credentialA}`,
  );
  check(
    "the owning tenant can read its credential",
    ownCredential.length === 1,
  );
  check(
    "credential identity and public key are immutable",
    await rejected(() =>
      tenantTransaction(
        app,
        practiceA,
        (tx) => tx`update webauthn_credentials
          set public_key = decode(${"cd".repeat(32)}, 'hex')
          where id = ${credentialA}`,
      ),
    ),
  );
  await tenantTransaction(
    app,
    practiceA,
    (tx) => tx`update webauthn_credentials
      set counter = 2, backed_up = true, last_used_at = now(),
        updated_at = now(), name = 'Renamed contract key'
      where id = ${credentialA}`,
  );
  check(
    "credential counters cannot move backward",
    await rejected(() =>
      tenantTransaction(
        app,
        practiceA,
        (tx) => tx`update webauthn_credentials set counter = 1
          where id = ${credentialA}`,
      ),
    ),
  );
  check(
    "credential backup state cannot move from true to false",
    await rejected(() =>
      tenantTransaction(
        app,
        practiceA,
        (tx) => tx`update webauthn_credentials set backed_up = false
          where id = ${credentialA}`,
      ),
    ),
  );

  check(
    "challenge identity and hash are immutable",
    await rejected(() =>
      tenantTransaction(
        app,
        practiceA,
        (tx) => tx`update webauthn_challenges
          set challenge_hash = ${"f".repeat(64)} where id = ${challengeA}`,
      ),
    ),
  );
  const consumed = await tenantTransaction(
    app,
    practiceA,
    (tx) => tx`update webauthn_challenges set consumed_at = now()
      where id = ${challengeA} and consumed_at is null and expires_at > now()
      returning id`,
  );
  const replay = await tenantTransaction(
    app,
    practiceA,
    (tx) => tx`update webauthn_challenges set consumed_at = now()
      where id = ${challengeA} and consumed_at is null and expires_at > now()
      returning id`,
  );
  check(
    "an active challenge is consumed exactly once and replay returns no row",
    consumed.length === 1 && replay.length === 0,
  );
  check(
    "a direct second challenge consumption is rejected by the trigger",
    await rejected(() =>
      tenantTransaction(
        app,
        practiceA,
        (tx) => tx`update webauthn_challenges set consumed_at = now()
          where id = ${challengeA}`,
      ),
    ),
  );

  await tenantTransaction(app, practiceA, (tx) =>
    insertChallenge(tx, challengeRace),
  );
  const raceResults = await Promise.all([
    tenantTransaction(
      app,
      practiceA,
      (tx) => tx`update webauthn_challenges set consumed_at = now()
        where id = ${challengeRace} and consumed_at is null and expires_at > now()
        returning id`,
    ),
    tenantTransaction(
      appPeer,
      practiceA,
      (tx) => tx`update webauthn_challenges set consumed_at = now()
        where id = ${challengeRace} and consumed_at is null and expires_at > now()
        returning id`,
    ),
  ]);
  check(
    "two concurrent challenge consumers produce exactly one winner",
    raceResults.reduce((count, rows) => count + rows.length, 0) === 1,
  );

  await tenantTransaction(app, practiceA, (tx) =>
    insertChallenge(tx, challengeExpired, -10 * 60 * 1_000),
  );
  const expired = await tenantTransaction(
    app,
    practiceA,
    (tx) => tx`update webauthn_challenges set consumed_at = now()
      where id = ${challengeExpired} and consumed_at is null
        and expires_at > now() returning id`,
  );
  check("an expired challenge cannot be consumed", expired.length === 0);
  await tenantTransaction(app, practiceA, (tx) =>
    insertChallenge(tx, challengePurge, -2 * 24 * 60 * 60 * 1_000),
  );
  const [purged] = await app<
    Array<{ deleted: string }>
  >`select public.purge_expired_webauthn_challenges()::text as deleted`;
  const retainedRecentExpired = await tenantTransaction(
    app,
    practiceA,
    (tx) => tx`select id from webauthn_challenges
      where id = ${challengeExpired}`,
  );
  check(
    "the narrow purge removes only challenges expired for more than 24 hours",
    purged?.deleted === "1" && retainedRecentExpired.length === 1,
  );

  await tenantTransaction(
    app,
    practiceA,
    (tx) => tx`update webauthn_credentials set deleted_at = now(),
      updated_at = now() where id = ${credentialA}`,
  );
  check(
    "credential retirement is one-way",
    await rejected(() =>
      tenantTransaction(
        app,
        practiceA,
        (tx) => tx`update webauthn_credentials set deleted_at = null
          where id = ${credentialA}`,
      ),
    ),
  );
  check(
    "the application role cannot delete credential or challenge evidence",
    (await rejected(() =>
      tenantTransaction(
        app,
        practiceA,
        (tx) => tx`delete from webauthn_credentials where id = ${credentialA}`,
      ),
    )) &&
      (await rejected(() =>
        tenantTransaction(
          app,
          practiceA,
          (tx) => tx`delete from webauthn_challenges where id = ${challengeA}`,
        ),
      )),
  );
} finally {
  await owner.begin(async (rawCleanup) => {
    const cleanup = rawCleanup as unknown as typeof owner;
    await cleanup`delete from webauthn_challenges
      where practice_id in (${practiceA}, ${practiceB})`;
    await cleanup`delete from webauthn_credentials
      where practice_id in (${practiceA}, ${practiceB})`;
    await cleanup`delete from users where id in (${userA}, ${userB})`;
    await cleanup`delete from practices where id in (${practiceA}, ${practiceB})`;
  });
  await owner.end();
  await app.end();
  await appPeer.end();
}

if (failures > 0) {
  console.error(`\n✗ ${failures} WebAuthn database check(s) FAILED`);
  process.exit(1);
}
console.log("\n✓ WebAuthn database contract passed.");
