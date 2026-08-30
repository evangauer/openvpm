/**
 * Real-PostgreSQL contract for the dormant dual-control account-recovery core.
 * No HTTP route exposes this workflow. The restricted application role proves
 * RLS, immutable evidence, revocation atomicity, one-use grants, and races.
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
const targetPractice = randomUUID();
const operatorPractice = randomUUID();
const targetUser = randomUUID();
const targetWithoutEvent = randomUUID();
const requesterUser = randomUUID();
const approverUser = randomUUID();
const credentialId = randomUUID();
const challengeId = randomUUID();
const proofId = randomUUID();
const recoveryCaseId = randomUUID();
let failures = 0;

function digest(domain: string, value: string): string {
  return createHash("sha256").update(`${domain}:${value}`).digest("hex");
}

function check(name: string, ok: boolean) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) failures += 1;
}

async function rejected(operation: () => Promise<unknown>): Promise<boolean> {
  try {
    await operation();
    return false;
  } catch {
    return true;
  }
}

async function systemTransaction<T>(
  client: typeof app,
  fn: (tx: typeof app) => Promise<T>,
): Promise<T> {
  return client.begin(async (rawTx) => {
    const tx = rawTx as unknown as typeof app;
    await tx`select set_config('app.rls_bypass', 'on', true)`;
    return fn(tx);
  }) as Promise<T>;
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

async function insertRequest(input: {
  caseId: string;
  targetId: string;
  targetSessionVersion: number;
  requestedAt: Date;
  withEvent?: boolean;
}) {
  const expiresAt = new Date(
    input.requestedAt.getTime() + 24 * 60 * 60 * 1_000,
  );
  return systemTransaction(app, async (tx) => {
    await tx`insert into auth_recovery_cases
      (id, practice_id, user_id, requester_user_id, target_session_version,
        status, reason_code, identity_proof_reference_hash, requested_at,
        expires_at, updated_at)
      values (${input.caseId}, ${targetPractice}, ${input.targetId},
        ${requesterUser}, ${input.targetSessionVersion}, 'pending',
        'lost_all_passkeys', ${digest("identity-proof-ref", input.caseId)},
        ${input.requestedAt}, ${expiresAt}, ${input.requestedAt})`;
    if (input.withEvent !== false) {
      await tx`insert into auth_recovery_events
        (case_id, practice_id, user_id, actor_user_id, event_type, occurred_at)
        values (${input.caseId}, ${targetPractice}, ${input.targetId},
          ${requesterUser}, 'requested', ${input.requestedAt})`;
    }
  });
}

/**
 * Installs an already-expired fixture as the database owner. Production callers
 * cannot backdate requests; trigger bypass is scoped to this test transaction.
 */
async function insertHistoricalPendingRequest(input: {
  caseId: string;
  targetId: string;
  targetSessionVersion: number;
  requestedAt: Date;
}) {
  const expiresAt = new Date(
    input.requestedAt.getTime() + 24 * 60 * 60 * 1_000,
  );
  return owner.begin(async (rawTx) => {
    const tx = rawTx as unknown as typeof owner;
    await tx`set local session_replication_role = replica`;
    await tx`insert into auth_recovery_cases
      (id, practice_id, user_id, requester_user_id, target_session_version,
        status, reason_code, identity_proof_reference_hash, requested_at,
        expires_at, updated_at)
      values (${input.caseId}, ${targetPractice}, ${input.targetId},
        ${requesterUser}, ${input.targetSessionVersion}, 'pending',
        'lost_all_passkeys', ${digest("identity-proof-ref", input.caseId)},
        ${input.requestedAt}, ${expiresAt}, ${input.requestedAt})`;
    await tx`insert into auth_recovery_events
      (case_id, practice_id, user_id, actor_user_id, event_type, occurred_at)
      values (${input.caseId}, ${targetPractice}, ${input.targetId},
        ${requesterUser}, 'requested', ${input.requestedAt})`;
  });
}

async function consumeGrant(
  client: typeof app,
  caseId: string,
  grantHash: string,
) {
  return systemTransaction(client, async (tx) => {
    const consumedAt = new Date();
    const rows = await tx<Array<{ id: string }>>`update auth_recovery_cases
      set status = 'consumed', consumed_at = ${consumedAt},
        updated_at = ${consumedAt}
      where id = ${caseId}
        and status = 'approved'
        and recovery_grant_hash = ${grantHash}
        and grant_expires_at > ${consumedAt}
      returning id`;
    if (rows.length === 1) {
      await tx`insert into auth_recovery_events
        (case_id, practice_id, user_id, actor_user_id, event_type, occurred_at)
        values (${caseId}, ${targetPractice}, ${targetUser},
          ${targetUser}, 'grant_consumed', ${consumedAt})`;
    }
    return rows;
  });
}

async function expireDueCases(client: typeof app, batchSize = 100) {
  return systemTransaction(client, async (tx) => {
    const [result] = await tx<Array<{ expiredCount: number }>>`
      select expire_due_auth_recovery_cases(${batchSize})::int
        as "expiredCount"`;
    return result?.expiredCount ?? 0;
  });
}

try {
  await owner`insert into practices (id, name) values
    (${targetPractice}, 'Recovery contract target'),
    (${operatorPractice}, 'Recovery contract operators')`;
  await owner`insert into users
    (id, email, password_hash, name, role, practice_id)
    values
    (${targetUser}, ${`recovery-target-${targetUser}@example.test`},
      'not-a-real-hash', 'Recovery Target', 'admin', ${targetPractice}),
    (${targetWithoutEvent}, ${`recovery-no-event-${targetWithoutEvent}@example.test`},
      'not-a-real-hash', 'Recovery No Event', 'admin', ${targetPractice}),
    (${requesterUser}, ${`recovery-requester-${requesterUser}@example.test`},
      'not-a-real-hash', 'Recovery Requester', 'admin', ${operatorPractice}),
    (${approverUser}, ${`recovery-approver-${approverUser}@example.test`},
      'not-a-real-hash', 'Recovery Approver', 'admin', ${operatorPractice})`;

  const issuedAt = new Date(Date.now() - 1_000);
  const factorExpiresAt = new Date(issuedAt.getTime() + 5 * 60 * 1_000);
  await owner`insert into webauthn_credentials
    (id, practice_id, user_id, credential_id, public_key, counter,
      device_type, backed_up, transports, aaguid, name)
    values (${credentialId}, ${targetPractice}, ${targetUser},
      ${`credential_${credentialId.replaceAll("-", "")}`},
      decode(${"ab".repeat(32)}, 'hex'), 0, 'multiDevice', false,
      '["internal"]'::jsonb, ${randomUUID()}, 'Recovery contract key')`;
  await owner`insert into webauthn_challenges
    (id, practice_id, user_id, session_version, purpose, action,
      challenge_hash, issued_at, expires_at)
    values (${challengeId}, ${targetPractice}, ${targetUser}, 1,
      'privileged_action', 'passkeys.remove',
      ${digest("challenge", challengeId)}, ${issuedAt}, ${factorExpiresAt})`;
  await owner`insert into privileged_action_proofs
    (id, practice_id, user_id, session_version, action, nonce_hash,
      factor_type, issued_at, expires_at)
    values (${proofId}, ${targetPractice}, ${targetUser}, 1,
      'passkeys.remove', ${digest("proof", proofId)}, 'passkey',
      ${issuedAt}, ${factorExpiresAt})`;

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
    from (values ('auth_recovery_cases'), ('auth_recovery_events')) tables(table_name)
    order by table_name`;
  const casePrivileges = privileges.find(
    (row) => row.tableName === "auth_recovery_cases",
  );
  const eventPrivileges = privileges.find(
    (row) => row.tableName === "auth_recovery_events",
  );
  check(
    "the app role can select/insert/update cases but cannot delete them",
    Boolean(
      casePrivileges?.canSelect &&
        casePrivileges.canInsert &&
        casePrivileges.canUpdate &&
        !casePrivileges.canDelete,
    ),
  );
  check(
    "the app role can only select/insert immutable recovery events",
    Boolean(
      eventPrivileges?.canSelect &&
        eventPrivileges.canInsert &&
        !eventPrivileges.canUpdate &&
        !eventPrivileges.canDelete,
    ),
  );
  check(
    "the restricted app role never bypasses RLS",
    privileges.length === 2 && privileges.every((row) => !row.bypassesRls),
  );

  const [expiryFunctionPrivileges] = await owner<
    Array<{ appCanExecute: boolean; publicCanExecute: boolean }>
  >`select
      has_function_privilege(
        'openpims_app', procedure.oid, 'EXECUTE'
      ) as "appCanExecute",
      exists (
        select 1
        from aclexplode(
          coalesce(
            procedure.proacl,
            acldefault('f', procedure.proowner)
          )
        ) function_acl
        where function_acl.grantee = 0
          and function_acl.privilege_type = 'EXECUTE'
      ) as "publicCanExecute"
    from pg_proc procedure
    where procedure.oid =
      'public.expire_due_auth_recovery_cases(integer)'::regprocedure`;
  check(
    "only the application role receives the recovery expiry function grant",
    expiryFunctionPrivileges?.appCanExecute === true &&
      expiryFunctionPrivileges.publicCanExecute === false,
  );

  check(
    "no context or tenant context can read the system recovery ledger",
    (await app`select id from auth_recovery_cases`).length === 0 &&
      (
        await tenantTransaction(
          app,
          targetPractice,
          (tx) => tx`select id from auth_recovery_cases`,
        )
      ).length === 0,
  );
  check(
    "a tenant context cannot create a system recovery request",
    await rejected(() =>
      tenantTransaction(
        app,
        targetPractice,
        (tx) => tx`insert into auth_recovery_cases
          (practice_id, user_id, requester_user_id, target_session_version,
            status, reason_code, identity_proof_reference_hash, requested_at,
            expires_at, updated_at)
          values (${targetPractice}, ${targetUser}, ${requesterUser}, 1,
            'pending', 'lost_all_passkeys', ${"a".repeat(64)}, now(),
            now() + interval '24 hours', now())`,
      ),
    ),
  );
  check(
    "a recovery request cannot bind to a stale target session generation",
    await rejected(() =>
      insertRequest({
        caseId: randomUUID(),
        targetId: targetUser,
        targetSessionVersion: 2,
        requestedAt: new Date(),
      }),
    ),
  );
  check(
    "a recovery request cannot be created with a backdated timestamp",
    await rejected(() =>
      insertRequest({
        caseId: randomUUID(),
        targetId: targetUser,
        targetSessionVersion: 1,
        requestedAt: new Date(Date.now() - 2 * 60 * 1_000),
      }),
    ),
  );

  const requestedAt = new Date();
  await insertRequest({
    caseId: recoveryCaseId,
    targetId: targetUser,
    targetSessionVersion: 1,
    requestedAt,
  });
  check(
    "a recovery transition cannot commit without immutable event evidence",
    await rejected(() =>
      insertRequest({
        caseId: randomUUID(),
        targetId: targetWithoutEvent,
        targetSessionVersion: 1,
        requestedAt: new Date(),
        withEvent: false,
      }),
    ),
  );
  const stalePendingCaseId = randomUUID();
  const stalePendingRequestedAt = new Date(
    Date.now() - 25 * 60 * 60 * 1_000,
  );
  const stalePendingExpiresAt = new Date(
    stalePendingRequestedAt.getTime() + 24 * 60 * 60 * 1_000,
  );
  await insertHistoricalPendingRequest({
    caseId: stalePendingCaseId,
    targetId: targetWithoutEvent,
    targetSessionVersion: 1,
    requestedAt: stalePendingRequestedAt,
  });
  const forgedPendingActionAt = new Date(
    stalePendingExpiresAt.getTime() - 60 * 1_000,
  );
  check(
    "an expired request cannot be approved with a backdated timestamp",
    await rejected(() =>
      systemTransaction(app, async (tx) => {
        const forgedGrantExpiresAt = new Date(
          forgedPendingActionAt.getTime() + 15 * 60 * 1_000,
        );
        await tx`update users set session_version = 2
          where id = ${targetWithoutEvent} and practice_id = ${targetPractice}
            and session_version = 1`;
        await tx`update auth_recovery_cases set status = 'approved',
          approver_user_id = ${approverUser}, revoked_session_version = 2,
          recovery_grant_hash = ${digest("recovery-grant", stalePendingCaseId)},
          approved_at = ${forgedPendingActionAt},
          grant_expires_at = ${forgedGrantExpiresAt},
          updated_at = ${forgedPendingActionAt}
          where id = ${stalePendingCaseId}`;
        await tx`insert into auth_recovery_events
          (case_id, practice_id, user_id, actor_user_id, event_type, occurred_at)
          values (${stalePendingCaseId}, ${targetPractice},
            ${targetWithoutEvent}, ${approverUser}, 'approved',
            ${forgedPendingActionAt})`;
      }),
    ),
  );
  check(
    "an expired request cannot be cancelled with a backdated timestamp",
    await rejected(() =>
      systemTransaction(app, async (tx) => {
        await tx`update auth_recovery_cases set status = 'cancelled',
          cancelled_by_user_id = ${requesterUser},
          cancelled_at = ${forgedPendingActionAt},
          updated_at = ${forgedPendingActionAt}
          where id = ${stalePendingCaseId}`;
        await tx`insert into auth_recovery_events
          (case_id, practice_id, user_id, actor_user_id, event_type, occurred_at)
          values (${stalePendingCaseId}, ${targetPractice},
            ${targetWithoutEvent}, ${requesterUser}, 'cancelled',
            ${forgedPendingActionAt})`;
      }),
    ),
  );
  const [noContextExpiry] = await app<Array<{ expiredCount: number }>>`
    select expire_due_auth_recovery_cases(1)::int as "expiredCount"`;
  const tenantExpiryCount = await tenantTransaction(
    app,
    targetPractice,
    async (tx) => {
      const [result] = await tx<Array<{ expiredCount: number }>>`
        select expire_due_auth_recovery_cases(1)::int as "expiredCount"`;
      return result?.expiredCount ?? 0;
    },
  );
  check(
    "the expiry primitive cannot see cases without system context",
    noContextExpiry?.expiredCount === 0 && tenantExpiryCount === 0,
  );
  check(
    "the expiry primitive rejects unbounded batch sizes",
    (await rejected(() => expireDueCases(app, 0))) &&
      (await rejected(() => expireDueCases(app, 1001))),
  );
  const expiredPendingCount = await expireDueCases(app, 1);
  const pendingReplacementId = randomUUID();
  await insertRequest({
    caseId: pendingReplacementId,
    targetId: targetWithoutEvent,
    targetSessionVersion: 1,
    requestedAt: new Date(),
  });
  const [pendingExpiry] = await systemTransaction(
    app,
    (tx) => tx<Array<{ status: string; expiryEvents: number }>>`
      select recovery.status,
        (select count(*)::int from auth_recovery_events event
          where event.case_id = recovery.id and event.event_type = 'expired')
          as "expiryEvents"
      from auth_recovery_cases recovery
      where recovery.id = ${stalePendingCaseId}`,
  );
  check(
    "an expired pending request is evidenced and does not block replacement",
    expiredPendingCount === 1 &&
      pendingExpiry?.status === "expired" &&
      pendingExpiry.expiryEvents === 1,
  );
  check(
    "only one active recovery case can exist for a target",
    await rejected(() =>
      insertRequest({
        caseId: randomUUID(),
        targetId: targetUser,
        targetSessionVersion: 1,
        requestedAt: new Date(),
      }),
    ),
  );

  const approvalAt = new Date();
  const grantExpiresAt = new Date(approvalAt.getTime() + 15 * 60 * 1_000);
  const grantHash = digest("recovery-grant", randomUUID());
  check(
    "the requester cannot self-approve a recovery case",
    await rejected(() =>
      systemTransaction(
        app,
        (tx) => tx`update auth_recovery_cases set status = 'approved',
          approver_user_id = ${requesterUser}, revoked_session_version = 2,
          recovery_grant_hash = ${grantHash}, approved_at = ${approvalAt},
          grant_expires_at = ${grantExpiresAt}, updated_at = ${approvalAt}
          where id = ${recoveryCaseId}`,
      ),
    ),
  );
  check(
    "approval cannot claim revocation while factors and sessions remain active",
    await rejected(() =>
      systemTransaction(app, async (tx) => {
        await tx`update auth_recovery_cases set status = 'approved',
          approver_user_id = ${approverUser}, revoked_session_version = 2,
          recovery_grant_hash = ${grantHash}, approved_at = ${approvalAt},
          grant_expires_at = ${grantExpiresAt}, updated_at = ${approvalAt}
          where id = ${recoveryCaseId}`;
        await tx`insert into auth_recovery_events
          (case_id, practice_id, user_id, actor_user_id, event_type, occurred_at)
          values (${recoveryCaseId}, ${targetPractice}, ${targetUser},
            ${approverUser}, 'approved', ${approvalAt})`;
      }),
    ),
  );
  check(
    "approval cannot commit without its immutable approval event",
    await rejected(() =>
      systemTransaction(app, async (tx) => {
        await tx`update webauthn_credentials
          set deleted_at = ${approvalAt}, updated_at = ${approvalAt}
          where practice_id = ${targetPractice} and user_id = ${targetUser}
            and deleted_at is null`;
        await tx`update webauthn_challenges set consumed_at = ${approvalAt}
          where practice_id = ${targetPractice} and user_id = ${targetUser}
            and consumed_at is null and expires_at > ${approvalAt}`;
        await tx`update privileged_action_proofs set consumed_at = ${approvalAt}
          where practice_id = ${targetPractice} and user_id = ${targetUser}
            and consumed_at is null and expires_at > ${approvalAt}`;
        await tx`update users set session_version = 2
          where id = ${targetUser} and practice_id = ${targetPractice}
            and session_version = 1`;
        await tx`update auth_recovery_cases set status = 'approved',
          approver_user_id = ${approverUser}, revoked_session_version = 2,
          recovery_grant_hash = ${grantHash}, approved_at = ${approvalAt},
          grant_expires_at = ${grantExpiresAt}, updated_at = ${approvalAt}
          where id = ${recoveryCaseId}`;
      }),
    ),
  );

  await systemTransaction(app, async (tx) => {
    const [lockedTarget] = await tx<Array<{ sessionVersion: number }>>`
      select session_version as "sessionVersion" from users
      where id = ${targetUser} and practice_id = ${targetPractice}
      for update`;
    if (lockedTarget?.sessionVersion !== 1) throw new Error("target changed");
    await tx`update webauthn_credentials
      set deleted_at = ${approvalAt}, updated_at = ${approvalAt}
      where practice_id = ${targetPractice} and user_id = ${targetUser}
        and deleted_at is null`;
    await tx`update webauthn_challenges set consumed_at = ${approvalAt}
      where practice_id = ${targetPractice} and user_id = ${targetUser}
        and consumed_at is null and expires_at > ${approvalAt}`;
    await tx`update privileged_action_proofs set consumed_at = ${approvalAt}
      where practice_id = ${targetPractice} and user_id = ${targetUser}
        and consumed_at is null and expires_at > ${approvalAt}`;
    await tx`update users set session_version = 2
      where id = ${targetUser} and practice_id = ${targetPractice}
        and session_version = 1`;
    await tx`update auth_recovery_cases set status = 'approved',
      approver_user_id = ${approverUser}, revoked_session_version = 2,
      recovery_grant_hash = ${grantHash}, approved_at = ${approvalAt},
      grant_expires_at = ${grantExpiresAt}, updated_at = ${approvalAt}
      where id = ${recoveryCaseId} and status = 'pending'
        and target_session_version = 1 and expires_at > ${approvalAt}`;
    await tx`insert into auth_recovery_events
      (case_id, practice_id, user_id, actor_user_id, event_type, occurred_at)
      values (${recoveryCaseId}, ${targetPractice}, ${targetUser},
        ${approverUser}, 'approved', ${approvalAt})`;
  });

  const [approved] = await systemTransaction(
    app,
    (tx) => tx<
      Array<{
        sessionVersion: number;
        activeCredentials: number;
        activeChallenges: number;
        activeProofs: number;
        status: string;
        eventCount: number;
      }>
    >`select account.session_version as "sessionVersion",
        (select count(*)::int from webauthn_credentials credential
          where credential.user_id = account.id and credential.deleted_at is null)
          as "activeCredentials",
        (select count(*)::int from webauthn_challenges challenge
          where challenge.user_id = account.id and challenge.consumed_at is null
            and challenge.expires_at > now()) as "activeChallenges",
        (select count(*)::int from privileged_action_proofs proof
          where proof.user_id = account.id and proof.consumed_at is null
            and proof.expires_at > now()) as "activeProofs",
        recovery.status,
        (select count(*)::int from auth_recovery_events event
          where event.case_id = recovery.id) as "eventCount"
      from users account
      join auth_recovery_cases recovery on recovery.user_id = account.id
      where recovery.id = ${recoveryCaseId}`,
  );
  check(
    "approval atomically revokes sessions, passkeys, challenges, and proofs with evidence",
    approved?.status === "approved" &&
      approved.sessionVersion === 2 &&
      approved.activeCredentials === 0 &&
      approved.activeChallenges === 0 &&
      approved.activeProofs === 0 &&
      approved.eventCount === 2,
  );
  check(
    "approved recovery identity and request evidence remain immutable",
    await rejected(() =>
      systemTransaction(
        app,
        (tx) => tx`update auth_recovery_cases
          set identity_proof_reference_hash = ${"f".repeat(64)}
          where id = ${recoveryCaseId}`,
      ),
    ),
  );
  check(
    "an approved recovery case cannot expire before its grant deadline",
    await rejected(() =>
      systemTransaction(app, async (tx) => {
        const prematureExpiryAt = new Date();
        await tx`update auth_recovery_cases set status = 'expired',
          expired_at = ${prematureExpiryAt}, updated_at = ${prematureExpiryAt}
          where id = ${recoveryCaseId}`;
        await tx`insert into auth_recovery_events
          (case_id, practice_id, user_id, event_type, occurred_at)
          values (${recoveryCaseId}, ${targetPractice}, ${targetUser},
            'expired', ${prematureExpiryAt})`;
      }),
    ),
  );

  const race = await Promise.all([
    consumeGrant(app, recoveryCaseId, grantHash),
    consumeGrant(appPeer, recoveryCaseId, grantHash),
  ]);
  check(
    "two concurrent grant consumers produce exactly one winner",
    race.reduce((count, rows) => count + rows.length, 0) === 1,
  );
  check(
    "a consumed recovery grant cannot be replayed",
    (await consumeGrant(app, recoveryCaseId, grantHash)).length === 0,
  );

  const expiredCaseId = randomUUID();
  const expiredRequestAt = new Date(Date.now() - 60 * 60 * 1_000);
  const expiredApprovalAt = new Date(Date.now() - 20 * 60 * 1_000);
  const expiredGrantAt = new Date(
    expiredApprovalAt.getTime() + 15 * 60 * 1_000,
  );
  const expiredRequestDeadline = new Date(
    expiredRequestAt.getTime() + 24 * 60 * 60 * 1_000,
  );
  const expiredGrantHash = digest("recovery-grant", expiredCaseId);
  // Install a historical approved case as the test owner. Live callers cannot
  // backdate approval; the fixture is needed to exercise database-time expiry.
  await owner.begin(async (rawTx) => {
    const tx = rawTx as unknown as typeof owner;
    await tx`set local session_replication_role = replica`;
    await tx`update users set session_version = 3
      where id = ${targetUser} and practice_id = ${targetPractice}
        and session_version = 2`;
    await tx`insert into auth_recovery_cases
      (id, practice_id, user_id, requester_user_id, approver_user_id,
        target_session_version, revoked_session_version, status, reason_code,
        identity_proof_reference_hash, recovery_grant_hash, requested_at,
        expires_at, approved_at, grant_expires_at, updated_at)
      values (${expiredCaseId}, ${targetPractice}, ${targetUser},
        ${requesterUser}, ${approverUser}, 2, 3, 'approved',
        'lost_all_passkeys',
        ${digest("identity-proof-ref", expiredCaseId)}, ${expiredGrantHash},
        ${expiredRequestAt}, ${expiredRequestDeadline}, ${expiredApprovalAt},
        ${expiredGrantAt}, ${expiredApprovalAt})`;
    await tx`insert into auth_recovery_events
      (case_id, practice_id, user_id, actor_user_id, event_type, occurred_at)
      values (${expiredCaseId}, ${targetPractice}, ${targetUser},
        ${requesterUser}, 'requested', ${expiredRequestAt})`;
    await tx`insert into auth_recovery_events
      (case_id, practice_id, user_id, actor_user_id, event_type, occurred_at)
      values (${expiredCaseId}, ${targetPractice}, ${targetUser},
        ${approverUser}, 'approved', ${expiredApprovalAt})`;
  });
  const forgedConsumptionAt = new Date(
    expiredApprovalAt.getTime() + 60 * 1_000,
  );
  check(
    "an expired recovery grant cannot be revived with a backdated timestamp",
    await rejected(() =>
      systemTransaction(app, async (tx) => {
        await tx`update auth_recovery_cases set status = 'consumed',
          consumed_at = ${forgedConsumptionAt},
          updated_at = ${forgedConsumptionAt}
          where id = ${expiredCaseId}`;
        await tx`insert into auth_recovery_events
          (case_id, practice_id, user_id, actor_user_id, event_type, occurred_at)
          values (${expiredCaseId}, ${targetPractice}, ${targetUser},
            ${targetUser}, 'grant_consumed', ${forgedConsumptionAt})`;
      }),
    ),
  );
  const expiryRace = await Promise.all([
    expireDueCases(app, 1),
    expireDueCases(appPeer, 1),
  ]);
  const expiryReplayCount = await expireDueCases(app, 1);
  const replacementCaseId = randomUUID();
  await insertRequest({
    caseId: replacementCaseId,
    targetId: targetUser,
    targetSessionVersion: 3,
    requestedAt: new Date(),
  });
  const [expiryState] = await systemTransaction(
    app,
    (tx) => tx<
      Array<{
        expiredStatus: string;
        expiryEvents: number;
        replacementStatus: string;
        sessionVersion: number;
        activeCredentials: number;
      }>
    >`select expired.status as "expiredStatus",
        (select count(*)::int from auth_recovery_events event
          where event.case_id = expired.id and event.event_type = 'expired')
          as "expiryEvents",
        replacement.status as "replacementStatus",
        account.session_version as "sessionVersion",
        (select count(*)::int from webauthn_credentials credential
          where credential.user_id = account.id and credential.deleted_at is null)
          as "activeCredentials"
      from auth_recovery_cases expired
      join users account on account.id = expired.user_id
      join auth_recovery_cases replacement
        on replacement.id = ${replacementCaseId}
      where expired.id = ${expiredCaseId}`,
  );
  check(
    "expiry is evidenced, leaves the account locked, and permits a new request",
    expiryRace[0] + expiryRace[1] === 1 &&
      expiryReplayCount === 0 &&
      expiryState?.expiredStatus === "expired" &&
      expiryState.expiryEvents === 1 &&
      expiryState.replacementStatus === "pending" &&
      expiryState.sessionVersion === 3 &&
      expiryState.activeCredentials === 0,
  );
  check(
    "recovery events cannot be updated or deleted by the app role",
    (await rejected(() =>
      systemTransaction(
        app,
        (tx) => tx`update auth_recovery_events set occurred_at = now()
          where case_id = ${recoveryCaseId}`,
      ),
    )) &&
      (await rejected(() =>
        systemTransaction(
          app,
          (tx) => tx`delete from auth_recovery_events
            where case_id = ${recoveryCaseId}`,
        ),
      )),
  );
  check(
    "recovery cases cannot be deleted by the app role",
    await rejected(() =>
      systemTransaction(
        app,
        (tx) => tx`delete from auth_recovery_cases
          where id = ${recoveryCaseId}`,
      ),
    ),
  );
} finally {
  await owner`set session_replication_role = replica`;
  await owner`delete from auth_recovery_events
    where practice_id in (${targetPractice}, ${operatorPractice})`;
  await owner`delete from auth_recovery_cases
    where practice_id in (${targetPractice}, ${operatorPractice})`;
  await owner`delete from privileged_action_proofs
    where practice_id in (${targetPractice}, ${operatorPractice})`;
  await owner`delete from webauthn_challenges
    where practice_id in (${targetPractice}, ${operatorPractice})`;
  await owner`delete from webauthn_credentials
    where practice_id in (${targetPractice}, ${operatorPractice})`;
  await owner`delete from users
    where practice_id in (${targetPractice}, ${operatorPractice})`;
  await owner`delete from practices
    where id in (${targetPractice}, ${operatorPractice})`;
  await owner`set session_replication_role = origin`;
  await owner.end();
  await app.end();
  await appPeer.end();
}

if (failures > 0) {
  console.error(`\n✗ ${failures} account-recovery database check(s) FAILED`);
  process.exit(1);
}
console.log("\n✓ Account-recovery database contract passed.");
