import { randomUUID } from "node:crypto";
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

type SqlClient = ReturnType<typeof postgres>;

const owner = postgres(databaseUrl, { max: 1 });
const racerA = postgres(databaseUrl, { max: 1 });
const racerB = postgres(databaseUrl, { max: 1 });

const practiceId = randomUUID();
const userId = randomUUID();
const clientId = randomUUID();
const patientId = randomUUID();
const serviceId = randomUUID();
const planId = randomUUID();

async function seed() {
  await owner.begin(async (tx) => {
    const scoped = tx as unknown as SqlClient;
    await scoped`insert into practices (id, name) values (${practiceId}, 'Treatment plan concurrency fixture')`;
    await scoped`insert into users (id, email, password_hash, name, role, practice_id)
      values (${userId}, ${`treatment-plan-${practiceId}@example.test`}, 'x', 'Fixture doctor', 'veterinarian', ${practiceId})`;
    await scoped`insert into clients (id, practice_id, first_name, last_name)
      values (${clientId}, ${practiceId}, 'Fixture', 'Client')`;
    await scoped`insert into patients (id, practice_id, client_id, name, species)
      values (${patientId}, ${practiceId}, ${clientId}, 'Fixture patient', 'canine')`;
    await scoped`insert into services (id, practice_id, name, default_price, taxable)
      values (${serviceId}, ${practiceId}, 'Fixture exam', 100, true)`;
    await scoped`insert into visit_treatment_plans (
      id, practice_id, client_id, patient_id, created_by, title,
      operation_id, operation_payload_hash
    ) values (
      ${planId}, ${practiceId}, ${clientId}, ${patientId}, ${userId},
      'Concurrent treatment plan', ${randomUUID()}, ${"a".repeat(64)}
    )`;
  });
}

async function raceRevision(client: postgres.Sql) {
  const revisionId = randomUUID();
  const lineId = randomUUID();
  const operationId = randomUUID();
  return client.begin(async (tx) => {
    const scoped = tx as unknown as SqlClient;
    await scoped.unsafe("set local role openpims_app");
    await scoped`select set_config('app.current_practice_id', ${practiceId}, true)`;
    await scoped`select id from visit_treatment_plans
      where practice_id = ${practiceId} and id = ${planId}
      for update`;
    await scoped`insert into visit_treatment_plan_revision_lines (
      id, practice_id, plan_id, revision_id, sort_order, description,
      offered_quantity, unit_price, line_subtotal, tax_amount, line_total,
      taxable, item_type, service_id
    ) values (
      ${lineId}, ${practiceId}, ${planId}, ${revisionId}, 0, 'Fixture exam',
      1, 100, 100, 8, 108, true, 'service', ${serviceId}
    )`;
    const [hashRow] = await scoped<{ hash: string }[]>`
      select compute_visit_treatment_plan_revision_sha256(
        ${practiceId}::uuid, ${planId}::uuid, ${revisionId}::uuid,
        1, 'USD', 100::numeric, 8::numeric, 108::numeric
      ) as hash`;
    await scoped`select pg_sleep(0.1)`;
    await scoped`insert into visit_treatment_plan_revisions (
      id, practice_id, plan_id, revision_number, currency, subtotal, tax,
      total, authored_by, operation_id, operation_payload_hash, content_sha256
    ) values (
      ${revisionId}, ${practiceId}, ${planId}, 1, 'USD', 100, 8, 108,
      ${userId}, ${operationId}, ${"b".repeat(64)}, ${hashRow!.hash}
    )`;
    return revisionId;
  });
}

async function cleanup() {
  await owner.begin(async (tx) => {
    const scoped = tx as unknown as SqlClient;
    await scoped`select set_config('app.rls_bypass', 'on', true)`;
    await scoped`delete from visit_treatment_plan_revision_lines where practice_id = ${practiceId}`;
    await scoped`delete from visit_treatment_plan_revisions where practice_id = ${practiceId}`;
    await scoped`delete from visit_treatment_plans where practice_id = ${practiceId}`;
    await scoped`delete from services where practice_id = ${practiceId}`;
    await scoped`delete from patients where practice_id = ${practiceId}`;
    await scoped`delete from clients where practice_id = ${practiceId}`;
    await scoped`delete from users where practice_id = ${practiceId}`;
    await scoped`delete from practices where id = ${practiceId}`;
  });
}

try {
  await seed();
  const outcomes = await Promise.allSettled([
    raceRevision(racerA),
    raceRevision(racerB),
  ]);
  const fulfilled = outcomes.filter(
    (outcome) => outcome.status === "fulfilled",
  );
  const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
  if (fulfilled.length !== 1 || rejected.length !== 1) {
    throw new Error(
      `Expected one revision winner and one loser; got ${fulfilled.length}/${rejected.length}`,
    );
  }
  const loser = rejected[0]!.reason as { code?: string; message?: string };
  if (
    loser.code !== "23514" ||
    !loser.message?.includes("stale or non-sequential")
  ) {
    throw new Error(`Unexpected concurrency loser: ${JSON.stringify(loser)}`);
  }
  const [counts] = await owner<
    { revisions: number; lines: number; revision_number: number }[]
  >`
    select
      (select count(*)::int from visit_treatment_plan_revisions where practice_id = ${practiceId}) as revisions,
      (select count(*)::int from visit_treatment_plan_revision_lines where practice_id = ${practiceId}) as lines,
      (select max(revision_number)::int from visit_treatment_plan_revisions where practice_id = ${practiceId}) as revision_number
  `;
  if (
    counts?.revisions !== 1 ||
    counts.lines !== 1 ||
    counts.revision_number !== 1
  ) {
    throw new Error(
      `Concurrent loser left partial evidence: ${JSON.stringify(counts)}`,
    );
  }
  console.log("Treatment-plan two-session revision race passed.");
} finally {
  await cleanup().catch(() => undefined);
  await Promise.all([owner.end(), racerA.end(), racerB.end()]);
}
