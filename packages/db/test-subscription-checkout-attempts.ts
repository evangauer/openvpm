/** Real-Postgres release gate. Run only on a disposable migrated database. */
import { randomUUID } from "node:crypto";
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (process.env.SUBSCRIPTION_CHECKOUT_DB_INTEGRATION !== "1") {
  throw new Error("SUBSCRIPTION_CHECKOUT_DB_INTEGRATION=1 is required");
}

type Sql = ReturnType<typeof postgres>;
const owner = postgres(databaseUrl, { max: 1 });
const writerA = postgres(databaseUrl, { max: 1 });
const writerB = postgres(databaseUrl, { max: 1 });
const userMutators = postgres(databaseUrl, { max: 4 });
const practiceA = randomUUID();
const practiceB = randomUUID();
const practiceC = randomUUID();
const practiceD = randomUUID();
const practiceE = randomUUID();
const practiceF = randomUUID();
const practiceG = randomUUID();
const practiceH = randomUUID();
const practiceI = randomUUID();
const userE = randomUUID();
const userG = randomUUID();

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function expectSqlState(
  action: () => Promise<unknown>,
  expected: string | string[],
  message: string,
) {
  try {
    await action();
  } catch (error) {
    const code = (error as { code?: string }).code;
    const allowed = Array.isArray(expected) ? expected : [expected];
    check(
      allowed.includes(code ?? ""),
      `${message}: unexpected SQLSTATE ${code}`,
    );
    return;
  }
  throw new Error(`${message}: statement unexpectedly succeeded`);
}

async function insertReserved(sql: Sql, practiceId: string, id = randomUUID()) {
  await sql`insert into subscription_checkout_attempts (
    id, practice_id, source, billing_cadence, return_target,
    location_price_id, location_quantity, customer_email,
    customer_identity_source,
    trial_period_days, success_url, cancel_url,
    provider_idempotency_key, request_fingerprint_sha256
  ) values (
    ${id}, ${practiceId}, 'settings', 'month', 'settings',
    'price_location', 1, 'billing@example.com', 'practice_email', 3,
    'https://app.example.com/success', 'https://app.example.com/cancel',
    ${`openvpm:subscription-checkout-attempt:${id}`}, ${"a".repeat(64)}
  )`;
  return id;
}

async function insertUserEmailReserved(
  sql: Sql,
  practiceId: string,
  userId: string,
  email: string,
  id = randomUUID(),
) {
  await sql`insert into subscription_checkout_attempts (
    id, practice_id, source, billing_cadence, return_target,
    location_price_id, location_quantity, customer_email,
    customer_identity_source, customer_identity_user_id,
    trial_period_days, success_url, cancel_url,
    provider_idempotency_key, request_fingerprint_sha256
  ) values (
    ${id}, ${practiceId}, 'settings', 'month', 'settings',
    'price_location', 1, ${email}, 'user_email', ${userId}, 3,
    'https://app.example.com/success', 'https://app.example.com/cancel',
    ${`openvpm:subscription-checkout-attempt:${id}`}, ${"c".repeat(64)}
  )`;
  return id;
}

async function markCreating(id: string) {
  const firstAt = new Date("2026-08-25T14:00:00.000Z");
  await owner`update subscription_checkout_attempts set
    state = 'creating', attempt_count = 1,
    first_provider_attempt_at = ${firstAt}, last_attempt_at = ${firstAt},
    lease_token = ${randomUUID()},
    lease_expires_at = ${new Date(firstAt.getTime() + 120_000)}
    where id = ${id}`;
}

async function expectConcurrentUserMutationFence(
  userId: string,
  destinationPracticeId: string,
) {
  await Promise.all([
    expectSqlState(
      () =>
        userMutators`update users set deleted_at = now() where id = ${userId}`,
      "55000",
      "user deactivation was allowed while a provider POST was in flight",
    ),
    expectSqlState(
      () =>
        userMutators`update users set email = ${`${userId}@changed.example.com`} where id = ${userId}`,
      "55000",
      "user email changed while a provider POST was in flight",
    ),
    expectSqlState(
      () =>
        userMutators`update users set practice_id = ${destinationPracticeId} where id = ${userId}`,
      "55000",
      "user tenant changed while a provider POST was in flight",
    ),
    expectSqlState(
      () => userMutators`delete from users where id = ${userId}`,
      "55000",
      "user was deleted while a provider POST was in flight",
    ),
  ]);
}

async function assertUserMutationsReleased(
  userId: string,
  destinationPracticeId: string,
  releasedEmail: string,
) {
  await owner`update users set email = ${releasedEmail} where id = ${userId}`;
  await owner`update users set deleted_at = now() where id = ${userId}`;
  await owner`update users set practice_id = ${destinationPracticeId} where id = ${userId}`;
  await owner`delete from users where id = ${userId}`;
  const [remaining] = await owner<{ count: number }[]>`
    select count(*)::int as count from users where id = ${userId}`;
  check(
    remaining?.count === 0,
    "user mutations remained fenced after dispatch",
  );
}

async function testWriterSerialization() {
  let release!: () => void;
  let reportLocked!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  const locked = new Promise<void>((resolve) => (reportLocked = resolve));
  const firstId = randomUUID();
  const first = writerA.begin(async (tx) => {
    const sql = tx as unknown as Sql;
    await sql`select id from practices where id = ${practiceA} for update`;
    await insertReserved(sql, practiceA, firstId);
    reportLocked();
    await hold;
  });
  await locked;

  let secondAcquired = false;
  const second = writerB.begin(async (tx) => {
    const sql = tx as unknown as Sql;
    await sql`select id from practices where id = ${practiceA} for update`;
    secondAcquired = true;
    const [existing] = await sql<{ id: string }[]>`
      select id from subscription_checkout_attempts
      where practice_id = ${practiceA}
        and state in ('reserved', 'creating', 'outcome_unknown', 'manual_review', 'open')`;
    return existing?.id;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  check(!secondAcquired, "the second writer bypassed the practice row lock");
  release();
  await first;
  check(
    (await second) === firstId,
    "the second writer did not reuse the winner",
  );

  await expectSqlState(
    () => insertReserved(owner, practiceA),
    "23505",
    "the partial unique index allowed a second active attempt",
  );
}

async function testTransitionsAndImmutability() {
  const id = await insertReserved(owner, practiceB);
  const firstAt = new Date("2026-08-25T12:00:00.000Z");
  const lease = randomUUID();
  await owner`update subscription_checkout_attempts set
    state = 'creating', attempt_count = 1,
    first_provider_attempt_at = ${firstAt}, last_attempt_at = ${firstAt},
    lease_token = ${lease}, lease_expires_at = ${new Date(firstAt.getTime() + 120_000)}
    where id = ${id}`;
  await expectSqlState(
    () => owner`update subscription_checkout_attempts
      set first_provider_attempt_at = ${new Date(firstAt.getTime() + 1)} where id = ${id}`,
    "55000",
    "first provider attempt clock was mutable",
  );
  await owner`update subscription_checkout_attempts set
    state = 'outcome_unknown', lease_token = null, lease_expires_at = null,
    last_error_code = 'provider_outcome_unknown' where id = ${id}`;
  await owner`update subscription_checkout_attempts set
    state = 'manual_review', last_error_code = 'idempotency_window_elapsed'
    where id = ${id}`;
  await expectSqlState(
    () => owner`update subscription_checkout_attempts set billing_cadence = 'year'
      where id = ${id}`,
    "55000",
    "immutable attempt cadence was rewritten",
  );
  await owner`update subscription_checkout_attempts set
    state = 'completed', provider_session_id = ${`cs_gate_completed_${id}`},
    provider_expires_at = ${new Date("2026-08-26T12:00:00.000Z")},
    last_reconciled_at = ${new Date("2026-08-25T12:01:00.000Z")},
    completed_at = ${new Date("2026-08-25T12:01:00.000Z")},
    last_error_code = null where id = ${id}`;
  await expectSqlState(
    () => owner`update subscription_checkout_attempts set updated_at = now()
      where id = ${id}`,
    "55000",
    "terminal attempt was mutable",
  );
  await expectSqlState(
    () => owner`delete from subscription_checkout_attempts where id = ${id}`,
    "55000",
    "attempt deletion was allowed",
  );
}

async function testTenantRls() {
  await writerA.begin(async (tx) => {
    const sql = tx as unknown as Sql;
    await sql.unsafe("set local role openpims_app");
    await sql`select set_config('app.current_practice_id', ${practiceA}, true)`;
    const rows = await sql<{ practice_id: string }[]>`
      select practice_id from subscription_checkout_attempts`;
    check(
      rows.length === 1 && rows[0]?.practice_id === practiceA,
      "tenant RLS exposed another practice's attempts",
    );
  });
  await expectSqlState(
    () =>
      writerA.begin(async (tx) => {
        const sql = tx as unknown as Sql;
        await sql.unsafe("set local role openpims_app");
        await sql`select set_config('app.current_practice_id', ${practiceA}, true)`;
        await sql`insert into subscription_checkout_attempts (
          id, practice_id, source, billing_cadence, return_target,
          location_price_id, location_quantity, customer_email,
          customer_identity_source,
          success_url, cancel_url, provider_idempotency_key,
          request_fingerprint_sha256
        ) values (
          ${randomUUID()}, ${practiceB}, 'settings', 'month', 'settings',
          'price_location', 1, 'billing@example.com', 'practice_email',
          'https://app.example.com/success', 'https://app.example.com/cancel',
          ${`rls:${randomUUID()}`}, ${"b".repeat(64)}
        )`;
      }),
    "42501",
    "tenant RLS allowed a cross-tenant insert",
  );
  await expectSqlState(
    () =>
      writerA.begin(async (tx) => {
        const sql = tx as unknown as Sql;
        await sql.unsafe("set local role openpims_app");
        await sql`select set_config('app.current_practice_id', ${practiceA}, true)`;
        await sql`delete from subscription_checkout_attempts where practice_id = ${practiceA}`;
      }),
    ["42501", "55000"],
    "the app role was allowed to delete attempts",
  );
}

async function testDispatchPracticeMutationFence() {
  const id = await insertReserved(owner, practiceD);
  const firstAt = new Date("2026-08-25T12:00:00.000Z");
  await owner`update subscription_checkout_attempts set
    state = 'creating', attempt_count = 1,
    first_provider_attempt_at = ${firstAt}, last_attempt_at = ${firstAt},
    lease_token = ${randomUUID()},
    lease_expires_at = ${new Date(firstAt.getTime() + 120_000)}
    where id = ${id}`;
  await expectSqlState(
    () => owner`update practices set email = 'changed@example.com'
      where id = ${practiceD}`,
    "55000",
    "practice billing identity changed while a provider POST was in flight",
  );
  await expectSqlState(
    () => owner`update practices set recovery_hold = true,
      recovery_hold_set_at = now(), recovery_hold_reason = 'race guard'
      where id = ${practiceD}`,
    "55000",
    "practice recovery state changed while a provider POST was in flight",
  );
  await expectSqlState(
    () =>
      owner`update practices set deleted_at = now() where id = ${practiceD}`,
    "55000",
    "practice deletion state changed while a provider POST was in flight",
  );
  await expectSqlState(
    () => owner`update practices set stripe_customer_id = 'cus_race'
      where id = ${practiceD}`,
    "55000",
    "practice customer identity changed while a provider POST was in flight",
  );
  await expectSqlState(
    () => owner`update practices set stripe_subscription_id = 'sub_race'
      where id = ${practiceD}`,
    "55000",
    "practice subscription identity changed while a provider POST was in flight",
  );
  await expectSqlState(
    () => owner`delete from practices where id = ${practiceD}`,
    "55000",
    "practice was deleted while a provider POST was in flight",
  );
  await owner`update subscription_checkout_attempts set
    state = 'outcome_unknown', lease_token = null, lease_expires_at = null,
    last_error_code = 'provider_outcome_unknown' where id = ${id}`;
  await owner`update practices set email = 'changed@example.com'
    where id = ${practiceD}`;
  const [changed] = await owner<{ email: string | null }[]>`
    select email from practices where id = ${practiceD}`;
  check(
    changed?.email === "changed@example.com",
    "practice identity did not become mutable after provider dispatch ended",
  );
}

async function testUserEmailIdentityValidation() {
  await expectSqlState(
    () =>
      insertUserEmailReserved(
        owner,
        practiceF,
        userE,
        "checkout-user-e@example.com",
      ),
    "23514",
    "a cross-tenant user_email identity was accepted",
  );
  await expectSqlState(
    () =>
      insertUserEmailReserved(
        owner,
        practiceE,
        userE,
        "not-the-user@example.com",
      ),
    "23514",
    "a user_email identity with a mismatched email was accepted",
  );
  await owner`update users set deleted_at = now() where id = ${userE}`;
  await expectSqlState(
    () =>
      insertUserEmailReserved(
        owner,
        practiceE,
        userE,
        "checkout-user-e@example.com",
      ),
    "23514",
    "an inactive user_email identity was accepted",
  );
  await owner`update users set deleted_at = null where id = ${userE}`;
}

async function testUserDispatchMutationFence() {
  const outcomeUnknownId = await insertUserEmailReserved(
    owner,
    practiceE,
    userE,
    "checkout-user-e@example.com",
  );
  await markCreating(outcomeUnknownId);
  await expectConcurrentUserMutationFence(userE, practiceF);
  await owner`update subscription_checkout_attempts set
    state = 'outcome_unknown', lease_token = null, lease_expires_at = null,
    last_error_code = 'provider_outcome_unknown'
    where id = ${outcomeUnknownId}`;
  await assertUserMutationsReleased(
    userE,
    practiceF,
    "checkout-user-e-released@example.com",
  );

  const terminalId = await insertUserEmailReserved(
    owner,
    practiceG,
    userG,
    "checkout-user-g@example.com",
  );
  await markCreating(terminalId);
  await expectConcurrentUserMutationFence(userG, practiceH);
  await owner`update subscription_checkout_attempts set
    state = 'failed', lease_token = null, lease_expires_at = null,
    failed_at = now(), last_error_code = 'provider_definite_failure'
    where id = ${terminalId}`;
  await assertUserMutationsReleased(
    userG,
    practiceH,
    "checkout-user-g-released@example.com",
  );
}

async function testConflictRecoveryEvidence() {
  const id = await insertReserved(owner, practiceC);
  const firstAt = new Date("2026-08-25T12:00:00.000Z");
  await owner.begin(async (tx) => {
    const sql = tx as unknown as Sql;
    await sql`update subscription_checkout_attempts set
      state = 'manual_review', attempt_count = 1,
      first_provider_attempt_at = ${firstAt}, last_attempt_at = ${firstAt},
      provider_session_id = ${`cs_gate_conflict_${id}`},
      provider_expires_at = ${new Date("2026-08-26T12:00:00.000Z")},
      last_reconciled_at = ${firstAt},
      last_error_code = 'provider_identity_conflict'
      where id = ${id}`;
    await sql`update practices set
      recovery_hold = true, recovery_hold_set_at = ${firstAt},
      recovery_hold_reason = 'Subscription Checkout provider identity conflict requires billing reconciliation.'
      where id = ${practiceC}`;
  });
  const [evidence] = await owner<
    {
      state: string;
      recovery_hold: boolean;
      recovery_hold_reason: string | null;
    }[]
  >`select a.state, p.recovery_hold, p.recovery_hold_reason
    from subscription_checkout_attempts a join practices p on p.id = a.practice_id
    where a.id = ${id}`;
  check(
    evidence?.state === "manual_review" &&
      evidence.recovery_hold &&
      Boolean(evidence.recovery_hold_reason?.trim()),
    "provider identity conflict did not commit durable attempt and hold evidence",
  );
}

async function testDurableQuantityQueueSerialization() {
  const eventId = `evt_quantity_${randomUUID()}`;
  const subscriptionId = `sub_quantity_${randomUUID()}`;
  const authorizedAt = new Date("2026-08-25T15:00:00.000Z");
  await owner`update practices set
    stripe_subscription_id = ${subscriptionId},
    stripe_subscription_sync_revision = 1
    where id = ${practiceI}`;
  await owner`insert into stripe_events (
    event_id, endpoint, event_type, practice_id,
    subscription_reconciliation_state,
    subscription_reconciliation_attempts,
    subscription_reconciliation_revision,
    subscription_reconciliation_authorized_at,
    subscription_reconciliation_resolved_at,
    subscription_reconciliation_subscription_id,
    subscription_quantity_sync_state
  ) values (
    ${eventId}, 'subscription', 'customer.subscription.updated', ${practiceI},
    'applied', 1, 1, ${authorizedAt}, ${authorizedAt}, ${subscriptionId},
    'pending'
  )`;

  let release!: () => void;
  let reportLocked!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  const locked = new Promise<void>((resolve) => (reportLocked = resolve));
  const leaseToken = randomUUID();
  const leaseExpiresAt = new Date(authorizedAt.getTime() + 5 * 60 * 1000);
  const first = writerA.begin(async (tx) => {
    const sql = tx as unknown as Sql;
    await sql`select event_id from stripe_events
      where event_id = ${eventId} and endpoint = 'subscription' for update`;
    await sql`select id from practices where id = ${practiceI} for update`;
    await sql`update practices set
      stripe_quantity_sync_lease_token = ${leaseToken},
      stripe_quantity_sync_lease_expires_at = ${leaseExpiresAt}
      where id = ${practiceI}`;
    await sql`update stripe_events set
      subscription_quantity_sync_state = 'running',
      subscription_quantity_sync_attempts = 1,
      subscription_quantity_sync_lease_token = ${leaseToken},
      subscription_quantity_sync_lease_expires_at = ${leaseExpiresAt},
      subscription_quantity_sync_last_attempt_at = ${authorizedAt}
      where event_id = ${eventId} and endpoint = 'subscription'`;
    reportLocked();
    await hold;
  });
  await locked;

  let secondAcquired = false;
  const second = writerB.begin(async (tx) => {
    const sql = tx as unknown as Sql;
    const [row] = await sql<{ state: string }[]>`select
      subscription_quantity_sync_state as state from stripe_events
      where event_id = ${eventId} and endpoint = 'subscription' for update`;
    secondAcquired = true;
    return row?.state;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  check(!secondAcquired, "quantity queue writer bypassed the event row lock");
  release();
  await first;
  check(
    (await second) === "running",
    "quantity queue loser missed the live lease",
  );

  await owner.begin(async (tx) => {
    const sql = tx as unknown as Sql;
    await sql`select event_id from stripe_events
      where event_id = ${eventId} and endpoint = 'subscription' for update`;
    await sql`update stripe_events set
      subscription_quantity_sync_state = 'completed',
      subscription_quantity_sync_lease_token = null,
      subscription_quantity_sync_lease_expires_at = null,
      subscription_quantity_sync_completed_at = ${authorizedAt}
      where event_id = ${eventId} and endpoint = 'subscription'
        and subscription_quantity_sync_lease_token = ${leaseToken}`;
    await sql`update practices set
      stripe_quantity_sync_lease_token = null,
      stripe_quantity_sync_lease_expires_at = null
      where id = ${practiceI}
        and stripe_quantity_sync_lease_token = ${leaseToken}`;
  });
  const [completed] = await owner<{ state: string; token: string | null }[]>`
    select subscription_quantity_sync_state as state,
      subscription_quantity_sync_lease_token::text as token
    from stripe_events where event_id = ${eventId} and endpoint = 'subscription'`;
  check(
    completed?.state === "completed" && completed.token === null,
    "quantity queue did not persist its terminal lease-CAS transition",
  );
}

try {
  await owner`insert into practices (id, name) values
    (${practiceA}, 'Checkout Gate A'), (${practiceB}, 'Checkout Gate B'),
    (${practiceC}, 'Checkout Gate C'), (${practiceD}, 'Checkout Gate D'),
    (${practiceE}, 'Checkout Gate E'), (${practiceF}, 'Checkout Gate F'),
    (${practiceG}, 'Checkout Gate G'), (${practiceH}, 'Checkout Gate H'),
    (${practiceI}, 'Checkout Gate I')`;
  await owner`insert into users
    (id, email, password_hash, name, role, practice_id) values
    (${userE}, 'checkout-user-e@example.com', 'not-a-real-hash',
      'Checkout User E', 'front_desk', ${practiceE}),
    (${userG}, 'checkout-user-g@example.com', 'not-a-real-hash',
      'Checkout User G', 'front_desk', ${practiceG})`;
  await testWriterSerialization();
  await testTransitionsAndImmutability();
  await testTenantRls();
  await testConflictRecoveryEvidence();
  await testDispatchPracticeMutationFence();
  await testUserEmailIdentityValidation();
  await testUserDispatchMutationFence();
  await testDurableQuantityQueueSerialization();
  console.log(
    "Subscription Checkout PostgreSQL contract passed: writer serialization, one-active ownership, immutable identity/clock, tenant-safe user provenance, dispatch mutation fencing, durable quantity queue leases, transitions, RLS, and grants enforced.",
  );
} finally {
  await Promise.all([
    owner.end(),
    writerA.end(),
    writerB.end(),
    userMutators.end(),
  ]);
}
