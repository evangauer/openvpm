/**
 * Real-Postgres lifecycle-email outbox release gate.
 * Run only against a disposable database after all migrations are applied.
 */
import { randomUUID } from "node:crypto";
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (process.env.LIFECYCLE_EMAIL_DB_INTEGRATION !== "1") {
  throw new Error("LIFECYCLE_EMAIL_DB_INTEGRATION=1 is required");
}

type SqlClient = ReturnType<typeof postgres>;
type JobFixture = { jobId: string; communicationId: string; dedupeKey: string };

const owner = postgres(databaseUrl, { max: 1 });
const racerA = postgres(databaseUrl, { max: 1 });
const racerB = postgres(databaseUrl, { max: 1 });
const practiceId = randomUUID();
const subscriptionId = `sub_gate_${randomUUID()}`;

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function expectSqlState(
  action: () => Promise<unknown>,
  code: string,
  message: string,
) {
  try {
    await action();
  } catch (error) {
    check(
      (error as { code?: string }).code === code,
      `${message}: unexpected SQLSTATE ${(error as { code?: string }).code}`,
    );
    return;
  }
  throw new Error(`${message}: statement unexpectedly succeeded`);
}

async function insertCommunication(
  sql: SqlClient,
  communicationId: string,
  dedupeKey: string,
) {
  await sql`insert into communications (
    id, practice_id, channel, direction, subject, content, status, dedupe_key
  ) values (
    ${communicationId}, ${practiceId}, 'email', 'outbound',
    'subscription_confirmed', 'subscription_confirmed', 'pending', ${dedupeKey}
  )`;
}

async function insertJob(
  sql: SqlClient,
  label: string,
): Promise<JobFixture> {
  const fixture = {
    jobId: randomUUID(),
    communicationId: randomUUID(),
    dedupeKey: `lc:gate:${label}:${randomUUID()}`,
  };
  await insertCommunication(sql, fixture.communicationId, fixture.dedupeKey);
  await sql`insert into lifecycle_email_jobs (
    id, practice_id, communication_id, kind, dedupe_key,
    provider_idempotency_key, recipient_hash_sha256, practice_name,
    subscription_id, subscription_generation
  ) values (
    ${fixture.jobId}, ${practiceId}, ${fixture.communicationId},
    'subscription_confirmed', ${fixture.dedupeKey}, ${fixture.dedupeKey},
    ${"a".repeat(64)}, 'Lifecycle Gate Practice', ${subscriptionId}, 0
  )`;
  return fixture;
}

async function testAtomicEnqueue() {
  const rollbackCommunicationId = randomUUID();
  const rollbackDedupeKey = `lc:gate:rollback:${randomUUID()}`;
  try {
    await owner.begin(async (tx) => {
      const sql = tx as unknown as SqlClient;
      await insertCommunication(sql, rollbackCommunicationId, rollbackDedupeKey);
      await sql`insert into lifecycle_email_jobs (
        practice_id, communication_id, kind, dedupe_key,
        provider_idempotency_key, recipient_hash_sha256, practice_name,
        subscription_id, subscription_generation
      ) values (
        ${practiceId}, ${rollbackCommunicationId}, 'subscription_confirmed',
        ${rollbackDedupeKey}, ${rollbackDedupeKey}, ${"b".repeat(64)},
        'Lifecycle Gate Practice', ${subscriptionId}, 0
      )`;
      throw new Error("intentional rollback");
    });
  } catch (error) {
    check(
      (error as Error).message === "intentional rollback",
      "atomic enqueue rollback returned an unexpected error",
    );
  }
  const [rolledBack] = await owner<{ communications: number; jobs: number }[]>`
    select
      (select count(*)::int from communications where id = ${rollbackCommunicationId}) as communications,
      (select count(*)::int from lifecycle_email_jobs where dedupe_key = ${rollbackDedupeKey}) as jobs`;
  check(
    rolledBack?.communications === 0 && rolledBack.jobs === 0,
    "communication and lifecycle job must roll back atomically",
  );

  const committed = await owner.begin(async (tx) =>
    insertJob(tx as unknown as SqlClient, "atomic-commit"),
  );
  const [counts] = await owner<{ communications: number; jobs: number }[]>`
    select
      (select count(*)::int from communications where id = ${committed.communicationId}) as communications,
      (select count(*)::int from lifecycle_email_jobs where id = ${committed.jobId}) as jobs`;
  check(
    counts?.communications === 1 && counts.jobs === 1,
    "communication and lifecycle job must commit atomically",
  );
}

async function testRls() {
  await racerA.begin(async (tx) => {
    const sql = tx as unknown as SqlClient;
    await sql.unsafe("set local role openpims_app");
    const [denied] = await sql<{ count: number }[]>`
      select count(*)::int as count from lifecycle_email_jobs
      where practice_id = ${practiceId}`;
    check(denied?.count === 0, "tenant context must not read system outbox rows");
    await sql`select set_config('app.rls_bypass', 'on', true)`;
    const [allowed] = await sql<{ count: number }[]>`
      select count(*)::int as count from lifecycle_email_jobs
      where practice_id = ${practiceId}`;
    check((allowed?.count ?? 0) > 0, "system context must read outbox rows");
  });
}

async function testSkipLocked() {
  await insertJob(owner, "skip-locked-a");
  await insertJob(owner, "skip-locked-b");
  let releaseFirst!: () => void;
  let reportFirst!: (id: string) => void;
  const release = new Promise<void>((resolve) => (releaseFirst = resolve));
  const selected = new Promise<string>((resolve) => (reportFirst = resolve));
  const firstTransaction = racerA.begin(async (tx) => {
    const sql = tx as unknown as SqlClient;
    const [row] = await sql<{ id: string }[]>`
      select id from lifecycle_email_jobs
      where practice_id = ${practiceId} and state = 'pending'
      order by created_at, id limit 1 for update skip locked`;
    check(row, "first worker must claim a job");
    reportFirst(row.id);
    await release;
    return row.id;
  });
  const firstId = await selected;
  const secondId = await racerB.begin(async (tx) => {
    const sql = tx as unknown as SqlClient;
    const [row] = await sql<{ id: string }[]>`
      select id from lifecycle_email_jobs
      where practice_id = ${practiceId} and state = 'pending'
      order by created_at, id limit 1 for update skip locked`;
    return row?.id;
  });
  releaseFirst();
  await firstTransaction;
  check(secondId && secondId !== firstId, "SKIP LOCKED workers must select different jobs");
}

async function testLeaseCasAndCrashRecovery() {
  const fixture = await insertJob(owner, "crash-recovery");
  const oldLease = randomUUID();
  const newLease = randomUUID();
  const attemptId = randomUUID();
  await owner`update lifecycle_email_jobs set
    state = 'delivering', next_attempt_at = null, lease_token = ${oldLease},
    lease_expires_at = clock_timestamp() - interval '1 minute', attempt_count = 1,
    first_attempt_at = clock_timestamp(), request_fingerprint_sha256 = ${"c".repeat(64)}
    where id = ${fixture.jobId}`;
  await owner`insert into lifecycle_email_attempts (
    id, practice_id, job_id, attempt_number, provider, request_fingerprint_sha256
  ) values (${attemptId}, ${practiceId}, ${fixture.jobId}, 1, 'resend', ${"c".repeat(64)})`;

  try {
    await owner.begin(async (tx) => {
      const sql = tx as unknown as SqlClient;
      await sql`update lifecycle_email_attempts set
        resolved_at = clock_timestamp(), outcome = 'accepted',
        provider_message_id = ${`provider-${randomUUID()}`}
        where id = ${attemptId} and resolved_at is null`;
      await sql`update lifecycle_email_jobs set
        state = 'delivered', lease_token = null, lease_expires_at = null,
        completed_at = clock_timestamp(), provider_message_id = 'rolled-back',
        last_outcome = 'accepted'
        where id = ${fixture.jobId} and lease_token = ${oldLease}`;
      throw new Error("simulate persistence crash");
    });
  } catch (error) {
    check(
      (error as Error).message === "simulate persistence crash",
      "crash simulation returned an unexpected error",
    );
  }
  const [afterCrash] = await owner<
    { state: string; resolved_at: Date | null; provider_idempotency_key: string }[]
  >`select job.state, attempt.resolved_at, job.provider_idempotency_key
    from lifecycle_email_jobs job
    join lifecycle_email_attempts attempt on attempt.job_id = job.id
    where job.id = ${fixture.jobId} and attempt.id = ${attemptId}`;
  check(
    afterCrash?.state === "delivering" && afterCrash.resolved_at === null,
    "accepted-then-crash must retain unresolved attempt evidence",
  );
  check(
    afterCrash.provider_idempotency_key === fixture.dedupeKey,
    "crash recovery must retain the stable provider key",
  );

  await owner`update lifecycle_email_jobs set lease_token = ${newLease},
    lease_expires_at = clock_timestamp() + interval '5 minutes'
    where id = ${fixture.jobId} and state = 'delivering'
      and lease_token = ${oldLease} and lease_expires_at <= clock_timestamp()`;
  const staleCas = await owner`update lifecycle_email_jobs set updated_at = clock_timestamp()
    where id = ${fixture.jobId} and lease_token = ${oldLease}
    returning id`;
  check(staleCas.length === 0, "an expired lease token must lose its persistence CAS");
}

async function testAttemptImmutability() {
  const fixture = await insertJob(owner, "attempt-immutability");
  const attemptId = randomUUID();
  await owner`insert into lifecycle_email_attempts (
    id, practice_id, job_id, attempt_number, provider, request_fingerprint_sha256
  ) values (${attemptId}, ${practiceId}, ${fixture.jobId}, 1, 'resend', ${"d".repeat(64)})`;
  await expectSqlState(
    () => owner`update lifecycle_email_attempts set attempt_number = 2 where id = ${attemptId}`,
    "55000",
    "attempt identity mutation",
  );
  await owner`update lifecycle_email_attempts set
    resolved_at = clock_timestamp(), outcome = 'outcome_unknown',
    failure_code = 'provider_outcome_ambiguous'
    where id = ${attemptId}`;
  await expectSqlState(
    () => owner`update lifecycle_email_attempts set failure_code = 'rewritten' where id = ${attemptId}`,
    "55000",
    "resolved attempt rewrite",
  );
  await expectSqlState(
    () => owner`delete from lifecycle_email_attempts where id = ${attemptId}`,
    "55000",
    "attempt delete outside owner maintenance",
  );
}

async function testDispatchFence() {
  let releaseFence!: () => void;
  let reportFence!: () => void;
  const release = new Promise<void>((resolve) => (releaseFence = resolve));
  const locked = new Promise<void>((resolve) => (reportFence = resolve));
  const fence = racerA.begin(async (tx) => {
    const sql = tx as unknown as SqlClient;
    await sql`select id from practices where id = ${practiceId} for update`;
    reportFence();
    await release;
  });
  await locked;
  let updateSettled = false;
  const mutation = racerB`
    update practices set email = 'after-fence@example.test' where id = ${practiceId}`
    .then(() => {
      updateSettled = true;
    });
  await new Promise((resolve) => setTimeout(resolve, 100));
  check(!updateSettled, "practice mutation must wait behind the dispatch fence");
  releaseFence();
  await Promise.all([fence, mutation]);
}

async function cleanup() {
  await owner.begin(async (tx) => {
    const sql = tx as unknown as SqlClient;
    await sql`select set_config('app.ledger_maintenance', 'on', true)`;
    await sql`delete from lifecycle_email_attempts where practice_id = ${practiceId}`;
    await sql`delete from lifecycle_email_jobs where practice_id = ${practiceId}`;
    await sql`delete from communications where practice_id = ${practiceId}`;
    await sql`delete from practices where id = ${practiceId}`;
  });
}

try {
  await owner`insert into practices (
    id, name, email, billing_status, stripe_subscription_id
  ) values (
    ${practiceId}, 'Lifecycle Gate Practice', 'before-fence@example.test',
    'active', ${subscriptionId}
  )`;
  await testAtomicEnqueue();
  await testRls();
  await testSkipLocked();
  await testLeaseCasAndCrashRecovery();
  await testAttemptImmutability();
  await testDispatchFence();
  console.log("Lifecycle-email PostgreSQL release gate passed.");
} finally {
  await cleanup().catch(() => undefined);
  await Promise.all([owner.end(), racerA.end(), racerB.end()]);
}
