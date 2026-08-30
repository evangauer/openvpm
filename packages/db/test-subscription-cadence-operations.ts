/** Real-PostgreSQL contract test. Creates and destroys one isolated database. */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { driftIsClean, findSchemaDrift } from "./schema-drift";

type SqlClient = ReturnType<typeof postgres>;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function expectSqlState(
  label: string,
  operation: () => Promise<unknown>,
  expected: string | string[],
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const actual = (error as { code?: string }).code ?? "";
    const allowed = Array.isArray(expected) ? expected : [expected];
    check(
      allowed.includes(actual),
      `${label}: expected ${allowed.join("/")}, received ${actual || "unknown"}`,
    );
    return;
  }
  throw new Error(`${label}: statement unexpectedly succeeded`);
}

const adminUrl = requiredEnv("DATABASE_URL");
const suffix = randomUUID().replaceAll("-", "");
const databaseName = `openpims_cadence_${suffix}`;
const ownerRole = `openpims_cadence_owner_${suffix}`;
const appRole = `openpims_cadence_app_${suffix}`;
const ownerPassword = randomUUID();
const appPassword = randomUUID();
const safeIdentifier = /^[a-z][a-z0-9_]+$/;

for (const identifier of [databaseName, ownerRole, appRole]) {
  if (!safeIdentifier.test(identifier) || identifier.length > 63) {
    throw new Error("unsafe disposable PostgreSQL identifier");
  }
}

const targetAdminUrl = new URL(adminUrl);
targetAdminUrl.pathname = `/${databaseName}`;
targetAdminUrl.search = "";
targetAdminUrl.hash = "";
const ownerUrl = new URL(targetAdminUrl);
ownerUrl.username = ownerRole;
ownerUrl.password = ownerPassword;
const appUrl = new URL(targetAdminUrl);
appUrl.username = appRole;
appUrl.password = appPassword;

const repoRoot = resolve(process.cwd(), "../..");
const admin = postgres(adminUrl, { max: 1 });
let owner: SqlClient | undefined;
let app: SqlClient | undefined;
let databaseCreated = false;
let ownerRoleCreated = false;
let appRoleCreated = false;

const ids = {
  practiceA: randomUUID(),
  practiceB: randomUUID(),
  userA: randomUUID(),
  userB: randomUUID(),
  operationA: randomUUID(),
  operationB: randomUUID(),
  locationA: randomUUID(),
};

function createKey(id: string): string {
  return `openvpm:cadence:${id}:create`;
}

function configureKey(id: string): string {
  return `openvpm:cadence:${id}:configure`;
}

async function insertReserved(
  sql: SqlClient,
  input: {
    id: string;
    practiceId: string;
    userId: string;
    customerId: string;
    subscriptionId: string;
    generation: number;
    revision: number;
  },
): Promise<void> {
  await sql`insert into subscription_cadence_operations (
    id, practice_id, requested_by, from_cadence, target_cadence,
    stripe_customer_id, stripe_subscription_id, subscription_generation,
    subscription_sync_revision, target_location_price_id,
    requested_location_quantity, request_fingerprint_sha256,
    schedule_create_idempotency_key, schedule_configure_idempotency_key
  ) values (
    ${input.id}, ${input.practiceId}, ${input.userId}, 'month', 'year',
    ${input.customerId}, ${input.subscriptionId}, ${input.generation},
    ${input.revision}, 'price_location_annual', 1, ${"a".repeat(64)},
    ${createKey(input.id)}, ${configureKey(input.id)}
  )`;
}

try {
  await admin.unsafe(
    `create role "${ownerRole}" login password '${ownerPassword}'`,
  );
  ownerRoleCreated = true;
  await admin.unsafe(
    `create role "${appRole}" login password '${appPassword}'`,
  );
  appRoleCreated = true;
  await admin.unsafe(`create database "${databaseName}" owner "${ownerRole}"`);
  databaseCreated = true;

  execFileSync("pnpm", ["--filter", "@openpims/db", "db:migrate"], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: ownerUrl.toString() },
    stdio: "pipe",
  });
  owner = postgres(ownerUrl.toString(), { max: 4 });
  const [ownerIdentity] = await owner<{ currentUser: string }[]>`
    select current_user as "currentUser"`;
  check(
    ownerIdentity?.currentUser === ownerRole,
    "owner test role was not active",
  );
  await owner`set client_min_messages to warning`;
  await owner
    .unsafe(
      readFileSync(resolve(repoRoot, "packages/db/rls/enable-rls.sql"), "utf8"),
    )
    .simple();

  await owner`insert into practices (
    id, name, billing_status, stripe_customer_id, stripe_subscription_id,
    subscription_generation, stripe_subscription_sync_revision
  ) values
    (${ids.practiceA}, 'Cadence A', 'active', 'cus_a', 'sub_a', 4, 7),
    (${ids.practiceB}, 'Cadence B', 'trialing', 'cus_b', 'sub_b', 2, 3)`;
  await owner`insert into users (
    id, email, password_hash, name, role, practice_id
  ) values
    (${ids.userA}, ${`cadence-a-${suffix}@example.com`}, 'test', 'Cadence A', 'admin', ${ids.practiceA}),
    (${ids.userB}, ${`cadence-b-${suffix}@example.com`}, 'test', 'Cadence B', 'admin', ${ids.practiceB})`;
  await owner`insert into locations (id, practice_id, name, is_primary) values
    (${ids.locationA}, ${ids.practiceA}, 'Primary', true)`;

  await expectSqlState(
    "cross-tenant requester",
    () =>
      insertReserved(owner!, {
        id: randomUUID(),
        practiceId: ids.practiceA,
        userId: ids.userB,
        customerId: "cus_a",
        subscriptionId: "sub_a",
        generation: 4,
        revision: 7,
      }),
    ["23503", "23514"],
  );
  await expectSqlState(
    "stale subscription revision",
    () =>
      insertReserved(owner!, {
        id: randomUUID(),
        practiceId: ids.practiceA,
        userId: ids.userA,
        customerId: "cus_a",
        subscriptionId: "sub_a",
        generation: 4,
        revision: 6,
      }),
    "23514",
  );
  await owner`update practices set recovery_hold = true,
    recovery_hold_reason = 'isolated test', recovery_hold_set_at = clock_timestamp()
    where id = ${ids.practiceB}`;
  await expectSqlState(
    "protected recovery",
    () =>
      insertReserved(owner!, {
        id: randomUUID(),
        practiceId: ids.practiceB,
        userId: ids.userB,
        customerId: "cus_b",
        subscriptionId: "sub_b",
        generation: 2,
        revision: 3,
      }),
    "23514",
  );
  await owner`update practices set recovery_hold = false,
    recovery_hold_released_at = clock_timestamp()
    where id = ${ids.practiceB}`;
  await owner`update practices set stripe_quantity_sync_lease_token = ${randomUUID()},
    stripe_quantity_sync_lease_expires_at = clock_timestamp() + interval '2 minutes'
    where id = ${ids.practiceB}`;
  await expectSqlState(
    "quantity reconciliation lease",
    () =>
      insertReserved(owner!, {
        id: randomUUID(),
        practiceId: ids.practiceB,
        userId: ids.userB,
        customerId: "cus_b",
        subscriptionId: "sub_b",
        generation: 2,
        revision: 3,
      }),
    "55000",
  );
  await owner`update practices set stripe_quantity_sync_lease_token = null,
    stripe_quantity_sync_lease_expires_at = null where id = ${ids.practiceB}`;

  await insertReserved(owner, {
    id: ids.operationA,
    practiceId: ids.practiceA,
    userId: ids.userA,
    customerId: "cus_a",
    subscriptionId: "sub_a",
    generation: 4,
    revision: 7,
  });
  await expectSqlState(
    "second active operation",
    () =>
      insertReserved(owner!, {
        id: randomUUID(),
        practiceId: ids.practiceA,
        userId: ids.userA,
        customerId: "cus_a",
        subscriptionId: "sub_a",
        generation: 4,
        revision: 7,
      }),
    "23505",
  );

  await owner`update subscription_cadence_operations set
    state = 'inspecting', revision = 1, attempt_count = 1,
    first_provider_attempt_at = clock_timestamp(),
    last_provider_attempt_at = clock_timestamp(),
    lease_token = ${randomUUID()},
    lease_expires_at = clock_timestamp() + interval '2 minutes',
    updated_at = clock_timestamp()
    where id = ${ids.operationA}`;
  await expectSqlState(
    "practice identity mutation during provider inspection",
    () =>
      owner!`update practices set stripe_subscription_id = 'sub_raced'
        where id = ${ids.practiceA}`,
    "55000",
  );
  await expectSqlState(
    "location quantity mutation during provider inspection",
    () =>
      owner!`insert into locations (practice_id, name) values
        (${ids.practiceA}, 'Raced location')`,
    "55000",
  );
  await expectSqlState(
    "skipped revision",
    () =>
      owner!`update subscription_cadence_operations set
        revision = 3, updated_at = clock_timestamp()
        where id = ${ids.operationA}`,
    "55000",
  );

  await owner`update subscription_cadence_operations set
    state = 'authorized', revision = 2,
    lease_token = null, lease_expires_at = null,
    authorized_at = clock_timestamp(),
    provider_snapshot_fingerprint_sha256 = ${"b".repeat(64)},
    current_location_item_id = 'si_monthly',
    current_location_price_id = 'price_location_monthly',
    current_location_quantity = 1,
    current_period_start = '2026-08-01T00:00:00Z',
    current_period_end = '2026-09-01T00:00:00Z',
    updated_at = clock_timestamp()
    where id = ${ids.operationA}`;
  await owner`update subscription_cadence_operations set
    state = 'creating_schedule', revision = 3, attempt_count = 2,
    last_provider_attempt_at = clock_timestamp(),
    lease_token = ${randomUUID()},
    lease_expires_at = clock_timestamp() + interval '2 minutes',
    updated_at = clock_timestamp()
    where id = ${ids.operationA}`;
  await owner`update subscription_cadence_operations set
    state = 'outcome_unknown', revision = 4,
    lease_token = null, lease_expires_at = null,
    last_error_code = 'stripe.timeout', updated_at = clock_timestamp()
    where id = ${ids.operationA}`;
  await expectSqlState(
    "practice identity mutation during unknown provider outcome",
    () =>
      owner!`update practices set stripe_subscription_id = 'sub_unknown_race'
        where id = ${ids.practiceA}`,
    "55000",
  );
  await expectSqlState(
    "unknown create outcome skipping to configure",
    () =>
      owner!`update subscription_cadence_operations set
        state = 'configuring_schedule', revision = 5, attempt_count = 3,
        lease_token = ${randomUUID()},
        lease_expires_at = clock_timestamp() + interval '2 minutes',
        last_error_code = null, updated_at = clock_timestamp()
        where id = ${ids.operationA}`,
    "55000",
  );
  await owner`update subscription_cadence_operations set
    state = 'creating_schedule', revision = 5, attempt_count = 3,
    last_provider_attempt_at = clock_timestamp(),
    lease_token = ${randomUUID()},
    lease_expires_at = clock_timestamp() + interval '2 minutes',
    last_error_code = null, updated_at = clock_timestamp()
    where id = ${ids.operationA}`;
  await owner`update subscription_cadence_operations set
    state = 'schedule_created', revision = 6,
    lease_token = null, lease_expires_at = null,
    provider_schedule_id = 'sub_sched_owned',
    schedule_created_at = clock_timestamp(), updated_at = clock_timestamp()
    where id = ${ids.operationA}`;
  await owner`update subscription_cadence_operations set
    state = 'configuring_schedule', revision = 7, attempt_count = 4,
    last_provider_attempt_at = clock_timestamp(),
    lease_token = ${randomUUID()},
    lease_expires_at = clock_timestamp() + interval '2 minutes',
    updated_at = clock_timestamp()
    where id = ${ids.operationA}`;
  await owner`update subscription_cadence_operations set
    state = 'scheduled', revision = 8,
    lease_token = null, lease_expires_at = null,
    scheduled_at = clock_timestamp(),
    effective_at = '2026-09-01T00:00:00Z', updated_at = clock_timestamp()
    where id = ${ids.operationA}`;
  await owner`update subscription_cadence_operations set
    state = 'applied', revision = 9,
    applied_at = '2026-09-01T00:00:01Z', updated_at = clock_timestamp()
    where id = ${ids.operationA}`;
  await expectSqlState(
    "terminal operation mutation",
    () =>
      owner!`update subscription_cadence_operations set
        revision = 10, updated_at = clock_timestamp()
        where id = ${ids.operationA}`,
    "55000",
  );
  await expectSqlState(
    "operation deletion",
    () =>
      owner!`delete from subscription_cadence_operations where id = ${ids.operationA}`,
    "55000",
  );

  await insertReserved(owner, {
    id: ids.operationB,
    practiceId: ids.practiceB,
    userId: ids.userB,
    customerId: "cus_b",
    subscriptionId: "sub_b",
    generation: 2,
    revision: 3,
  });
  await owner`update subscription_cadence_operations set
    state = 'inspecting', revision = 1, attempt_count = 1,
    first_provider_attempt_at = clock_timestamp(),
    last_provider_attempt_at = clock_timestamp(),
    lease_token = ${randomUUID()},
    lease_expires_at = clock_timestamp() + interval '2 minutes',
    updated_at = clock_timestamp()
    where id = ${ids.operationB}`;
  await owner`update subscription_cadence_operations set
    state = 'manual_review', revision = 2,
    lease_token = null, lease_expires_at = null,
    observed_provider_schedule_id = 'sub_sched_custom',
    manual_review_at = clock_timestamp(),
    last_error_code = 'schedule.custom', updated_at = clock_timestamp()
    where id = ${ids.operationB}`;
  await expectSqlState(
    "custom schedule automatic resume",
    () =>
      owner!`update subscription_cadence_operations set
        state = 'creating_schedule', revision = 3, attempt_count = 2,
        lease_token = ${randomUUID()},
        lease_expires_at = clock_timestamp() + interval '2 minutes',
        last_error_code = null, manual_review_at = null,
        updated_at = clock_timestamp()
        where id = ${ids.operationB}`,
    ["23514", "55000"],
  );

  await owner.unsafe(
    `grant connect on database "${databaseName}" to "${appRole}"`,
  );
  await owner.unsafe(`grant usage on schema public to "${appRole}"`);
  await owner.unsafe(
    `grant select, insert, update on subscription_cadence_operations to "${appRole}"`,
  );
  app = postgres(appUrl.toString(), { max: 1 });
  const [appIdentity] = await app<{ currentUser: string }[]>`
    select current_user as "currentUser"`;
  check(
    appIdentity?.currentUser === appRole,
    "application test role was not active",
  );
  const visible = await app.begin(async (tx) => {
    const scoped = tx as unknown as SqlClient;
    await scoped`select set_config('app.current_practice_id', ${ids.practiceA}, true)`;
    const rows =
      await scoped`select id from subscription_cadence_operations order by id`;
    return rows;
  });
  check(
    visible.length === 1,
    `RLS did not isolate cadence operation history (visible=${visible.length})`,
  );
  await expectSqlState(
    "tenant delete privilege",
    () =>
      app!.begin(async (tx) => {
        const scoped = tx as unknown as SqlClient;
        await scoped`select set_config('app.current_practice_id', ${ids.practiceA}, true)`;
        await scoped`delete from subscription_cadence_operations where id = ${ids.operationA}`;
      }),
    "42501",
  );
  await expectSqlState(
    "direct guard execution",
    () => app!`select guard_subscription_cadence_operation_mutation()`,
    "42501",
  );

  const [policy] = await owner<{ enabled: boolean; policyCount: number }[]>`
    select c.relrowsecurity as enabled,
      count(p.polname)::int as "policyCount"
    from pg_catalog.pg_class c
    left join pg_catalog.pg_policy p on p.polrelid = c.oid
    where c.oid = 'public.subscription_cadence_operations'::regclass
    group by c.relrowsecurity`;
  check(
    policy?.enabled && policy.policyCount === 1,
    "cadence RLS policy missing",
  );
  const drift = await findSchemaDrift(drizzle(owner));
  check(
    driftIsClean(drift),
    `fresh migrated schema drifted: ${JSON.stringify(drift)}`,
  );

  console.log(
    "Subscription cadence PostgreSQL contract passed: tenant identity, immutable revisions, crash resume, custom-schedule containment, provider dispatch fences, RLS, and no-delete controls enforced.",
  );
} finally {
  if (app) await app.end();
  if (owner) await owner.end();
  if (databaseCreated) {
    await admin.unsafe(`drop database "${databaseName}" with (force)`);
  }
  if (appRoleCreated) await admin.unsafe(`drop role "${appRole}"`);
  if (ownerRoleCreated) await admin.unsafe(`drop role "${ownerRole}"`);
  await admin.end();
}
