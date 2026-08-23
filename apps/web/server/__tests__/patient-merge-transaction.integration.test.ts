import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import * as schema from "../../../../packages/db/schema/index";
import { appRouter } from "../routers/_app";

vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn(async () => undefined),
}));

const repoRoot = resolve(process.cwd(), "../..");
const describeWithPatientMergePostgres =
  process.env.PATIENT_MERGE_DB_INTEGRATION === "1" ? describe : describe.skip;

describeWithPatientMergePostgres(
  "patient merge outer transaction PostgreSQL contract",
  () => {
    it("runs the full protected route as openpims_app in one serializable tenant transaction", async () => {
      const adminUrl = process.env.DATABASE_URL;
      if (!adminUrl) throw new Error("DATABASE_URL is required");

      const databaseName = `openpims_patient_merge_${randomUUID().replaceAll("-", "")}`;
      if (!/^openpims_patient_merge_[a-f0-9]+$/.test(databaseName)) {
        throw new Error("unsafe disposable database name");
      }

      const databaseUrl = new URL(adminUrl);
      databaseUrl.pathname = `/${databaseName}`;
      databaseUrl.search = "";
      databaseUrl.hash = "";

      const appUrl = new URL(databaseUrl);
      appUrl.username = "openpims_app";
      appUrl.password =
        process.env.OPENPIMS_APP_DB_PASSWORD?.trim() || "openpims_app";

      const adminSql = postgres(adminUrl, { max: 1 });
      let ownerSql: ReturnType<typeof postgres> | undefined;
      let appSql: ReturnType<typeof postgres> | undefined;
      let raceSqlA: ReturnType<typeof postgres> | undefined;
      let raceSqlB: ReturnType<typeof postgres> | undefined;
      await adminSql.unsafe(`create database "${databaseName}"`);

      try {
        execFileSync("pnpm", ["--filter", "@openpims/db", "db:migrate"], {
          cwd: repoRoot,
          env: { ...process.env, DATABASE_URL: databaseUrl.toString() },
          encoding: "utf8",
          timeout: 45_000,
        });
        execFileSync("pnpm", ["--filter", "@openpims/db", "db:rls"], {
          cwd: repoRoot,
          env: { ...process.env, DATABASE_URL: databaseUrl.toString() },
          encoding: "utf8",
          timeout: 45_000,
        });

        ownerSql = postgres(databaseUrl.toString(), { max: 1 });
        const ownerDb = drizzle(ownerSql, { schema });

        const [practice] = await ownerDb
          .insert(schema.practices)
          .values({ name: "Synthetic Patient Merge Clinic" })
          .returning({ id: schema.practices.id });
        if (!practice) throw new Error("failed to seed practice");

        const [location] = await ownerDb
          .insert(schema.locations)
          .values({
            practiceId: practice.id,
            name: "Synthetic Merge Clinic",
            isPrimary: true,
          })
          .returning({ id: schema.locations.id });
        if (!location) throw new Error("failed to seed location");

        const [admin] = await ownerDb
          .insert(schema.users)
          .values({
            practiceId: practice.id,
            email: "synthetic-patient-merge@example.invalid",
            passwordHash: "not-a-real-password-hash",
            name: "Synthetic Merge Admin",
            role: "admin",
            emailVerifiedAt: new Date(),
          })
          .returning({ id: schema.users.id });
        if (!admin) throw new Error("failed to seed admin");

        const [client] = await ownerDb
          .insert(schema.clients)
          .values({
            practiceId: practice.id,
            firstName: "Synthetic",
            lastName: "Owner",
          })
          .returning({ id: schema.clients.id });
        if (!client) throw new Error("failed to seed client");

        const [
          keepPatient,
          sourcePatient,
          retryKeepPatient,
          retrySourcePatient,
          raceKeepPatient,
          raceSourcePatient,
          lineageKeepPatient,
          lineageSourcePatient,
        ] = await ownerDb
          .insert(schema.patients)
          .values([
            {
              practiceId: practice.id,
              clientId: client.id,
              name: "Synthetic Canonical",
              species: "canine",
            },
            {
              practiceId: practice.id,
              clientId: client.id,
              name: "Synthetic Duplicate",
              species: "canine",
            },
            {
              practiceId: practice.id,
              clientId: client.id,
              name: "Synthetic Retry Canonical",
              species: "feline",
            },
            {
              practiceId: practice.id,
              clientId: client.id,
              name: "Synthetic Retry Duplicate",
              species: "feline",
            },
            {
              practiceId: practice.id,
              clientId: client.id,
              name: "Synthetic Race Canonical",
              species: "canine",
            },
            {
              practiceId: practice.id,
              clientId: client.id,
              name: "Synthetic Race Duplicate",
              species: "canine",
            },
            {
              practiceId: practice.id,
              clientId: client.id,
              name: "Synthetic Lineage Canonical",
              species: "feline",
            },
            {
              practiceId: practice.id,
              clientId: client.id,
              name: "Synthetic Lineage Duplicate",
              species: "feline",
            },
          ])
          .returning({ id: schema.patients.id });
        if (
          !keepPatient ||
          !sourcePatient ||
          !retryKeepPatient ||
          !retrySourcePatient ||
          !raceKeepPatient ||
          !raceSourcePatient ||
          !lineageKeepPatient ||
          !lineageSourcePatient
        ) {
          throw new Error("failed to seed patients");
        }

        const futureStart = new Date(Date.now() + 86_400_000);
        const futureEnd = new Date(futureStart.getTime() + 1_800_000);
        const [successAppointment, retryAppointment, raceAppointment] =
          await ownerDb
            .insert(schema.appointments)
            .values([
              {
                practiceId: practice.id,
                locationId: location.id,
                clientId: client.id,
                patientId: sourcePatient.id,
                startTime: futureStart,
                endTime: futureEnd,
              },
              {
                practiceId: practice.id,
                locationId: location.id,
                clientId: client.id,
                patientId: retrySourcePatient.id,
                startTime: new Date(futureStart.getTime() + 3_600_000),
                endTime: new Date(futureEnd.getTime() + 3_600_000),
              },
              {
                practiceId: practice.id,
                locationId: location.id,
                clientId: client.id,
                patientId: raceSourcePatient.id,
                startTime: new Date(futureStart.getTime() + 7_200_000),
                endTime: new Date(futureEnd.getTime() + 7_200_000),
              },
            ])
            .returning({
              id: schema.appointments.id,
              updatedAt: schema.appointments.updatedAt,
            });
        const [successWaitlist, retryWaitlist, raceWaitlist] = await ownerDb
          .insert(schema.appointmentWaitlist)
          .values([
            {
              practiceId: practice.id,
              clientId: client.id,
              patientId: sourcePatient.id,
              createdBy: admin.id,
            },
            {
              practiceId: practice.id,
              clientId: client.id,
              patientId: retrySourcePatient.id,
              createdBy: admin.id,
            },
            {
              practiceId: practice.id,
              clientId: client.id,
              patientId: raceSourcePatient.id,
              createdBy: admin.id,
            },
          ])
          .returning({
            id: schema.appointmentWaitlist.id,
            updatedAt: schema.appointmentWaitlist.updatedAt,
          });
        if (
          !successAppointment ||
          !retryAppointment ||
          !raceAppointment ||
          !successWaitlist ||
          !retryWaitlist ||
          !raceWaitlist
        ) {
          throw new Error("failed to seed movable scheduling records");
        }

        await ownerSql.unsafe(`
          create table patient_merge_transaction_observations (
            practice_id uuid not null,
            operation_id uuid not null,
            isolation_level text not null,
            tenant_context text
          );

          create table patient_merge_failure_injections (
            patient_id uuid primary key
          );

          create function observe_patient_merge_transaction()
          returns trigger
          language plpgsql
          security definer
          set search_path = public, pg_temp
          as $function$
          begin
            if new.reason = 'Synthetic lineage constraint injection.' then
              raise exception using
                errcode = '23514',
                message = 'A canonical patient with incoming merge history cannot be retired.';
            end if;

            insert into patient_merge_transaction_observations (
              practice_id,
              operation_id,
              isolation_level,
              tenant_context
            ) values (
              new.practice_id,
              new.operation_id,
              current_setting('transaction_isolation'),
              nullif(current_setting('app.current_practice_id', true), '')
            );
            if new.reason = 'Synthetic concurrent merge race.' then
              perform pg_catalog.pg_sleep(1);
            end if;
            return new;
          end
          $function$;

          create trigger observe_patient_merge_transaction_trigger
          before insert on patient_merge_events
          for each row execute function observe_patient_merge_transaction();

          create function inject_patient_merge_retirement_failure()
          returns trigger
          language plpgsql
          security definer
          set search_path = public, pg_temp
          as $function$
          begin
            if new.deleted_at is not null
              and old.deleted_at is null
              and exists (
                select 1
                from patient_merge_failure_injections injection
                where injection.patient_id = old.id
              )
            then
              raise exception 'synthetic serialization conflict after merge writes'
                using errcode = '40001';
            end if;
            return new;
          end
          $function$;

          create trigger inject_patient_merge_retirement_failure_trigger
          before update on patients
          for each row execute function inject_patient_merge_retirement_failure();
        `);

        await ownerSql`
          insert into patient_merge_failure_injections (patient_id)
          values (${retrySourcePatient.id})
        `;

        appSql = postgres(appUrl.toString(), { max: 1 });
        const appDb = drizzle(appSql, { schema });
        const operationId = randomUUID();
        const caller = appRouter.createCaller({
          db: appDb,
          session: {
            user: {
              id: admin.id,
              email: "synthetic-patient-merge@example.invalid",
              name: "Synthetic Merge Admin",
              role: "admin",
              practiceId: practice.id,
            },
          },
        } as never);

        const merged = await caller.patients.merge({
          keepId: keepPatient.id,
          mergeId: sourcePatient.id,
          reason: "Synthetic duplicate chart verified for transaction proof.",
          operationId,
        });
        expect(merged).toMatchObject({
          id: keepPatient.id,
          mergeMetadata: {
            sourcePatientId: sourcePatient.id,
            canonicalId: keepPatient.id,
            replayed: false,
          },
        });

        const replayed = await caller.patients.merge({
          keepId: keepPatient.id,
          mergeId: sourcePatient.id,
          reason: "Synthetic duplicate chart verified for transaction proof.",
          operationId,
        });
        expect(replayed.mergeMetadata).toMatchObject({
          sourcePatientId: sourcePatient.id,
          canonicalId: keepPatient.id,
          replayed: true,
        });

        await expect(
          caller.patients.merge({
            keepId: keepPatient.id,
            mergeId: sourcePatient.id,
            reason: "Conflicting reuse of a completed synthetic operation.",
            operationId,
          }),
        ).rejects.toMatchObject({
          code: "CONFLICT",
          message:
            "This patient merge operation ID was already used for different details.",
        });

        const retryOperationId = randomUUID();
        await expect(
          caller.patients.merge({
            keepId: retryKeepPatient.id,
            mergeId: retrySourcePatient.id,
            reason: "Synthetic serialization conflict injection.",
            operationId: retryOperationId,
          }),
        ).rejects.toMatchObject({
          code: "CONFLICT",
          message:
            "Patient records changed during the merge. Refresh both charts and retry.",
        });

        const lineageOperationId = randomUUID();
        await expect(
          caller.patients.merge({
            keepId: lineageKeepPatient.id,
            mergeId: lineageSourcePatient.id,
            reason: "Synthetic lineage constraint injection.",
            operationId: lineageOperationId,
          }),
        ).rejects.toMatchObject({
          code: "PRECONDITION_FAILED",
          message:
            "The patient merge no longer satisfies the identity safety checks. Refresh both charts before continuing.",
        });

        raceSqlA = postgres(appUrl.toString(), { max: 1 });
        raceSqlB = postgres(appUrl.toString(), { max: 1 });
        const raceContext = (database: unknown) =>
          ({
            db: database,
            session: {
              user: {
                id: admin.id,
                email: "synthetic-patient-merge@example.invalid",
                name: "Synthetic Merge Admin",
                role: "admin",
                practiceId: practice.id,
              },
            },
          }) as never;
        const raceCallerA = appRouter.createCaller(
          raceContext(drizzle(raceSqlA, { schema })),
        );
        const raceCallerB = appRouter.createCaller(
          raceContext(drizzle(raceSqlB, { schema })),
        );
        const raceOperationId = randomUUID();
        const raceInput = {
          keepId: raceKeepPatient.id,
          mergeId: raceSourcePatient.id,
          reason: "Synthetic concurrent merge race.",
          operationId: raceOperationId,
        };
        const firstRaceCall = raceCallerA.patients.merge(raceInput);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
        const raceResults = await Promise.allSettled([
          firstRaceCall,
          raceCallerB.patients.merge(raceInput),
        ]);
        const fulfilledRaces = raceResults.filter(
          (result) => result.status === "fulfilled",
        );
        const rejectedRaces = raceResults.filter(
          (result) => result.status === "rejected",
        );
        expect(fulfilledRaces).toHaveLength(1);
        expect(rejectedRaces).toHaveLength(1);
        expect(rejectedRaces[0]).toMatchObject({
          reason: {
            code: "CONFLICT",
            message:
              "Patient records changed during the merge. Refresh both charts and retry.",
          },
        });

        const raceReplay = await raceCallerA.patients.merge(raceInput);
        expect(raceReplay.mergeMetadata).toMatchObject({
          sourcePatientId: raceSourcePatient.id,
          canonicalId: raceKeepPatient.id,
          replayed: true,
        });

        const [state] = await ownerSql<
          Array<{
            sourceDeleted: boolean;
            events: number;
            mergeAudits: number;
            observations: number;
            isolationLevel: string;
            tenantContext: string | null;
            retryPatientsActive: number;
            retryEvents: number;
            retryAudits: number;
            retryObservations: number;
            successAppointmentMoved: boolean;
            successWaitlistMoved: boolean;
            retryAppointmentPreserved: boolean;
            retryWaitlistPreserved: boolean;
            retryAppointmentTimestampPreserved: boolean;
            retryWaitlistTimestampPreserved: boolean;
            raceSourceDeleted: boolean;
            raceEvents: number;
            raceAudits: number;
            raceAppointmentMoved: boolean;
            raceWaitlistMoved: boolean;
            lineagePatientsActive: number;
            lineageEvents: number;
            lineageAudits: number;
          }>
        >`
          select
            (select deleted_at is not null from patients where id = ${sourcePatient.id}) as "sourceDeleted",
            (select count(*)::int from patient_merge_events where operation_id = ${operationId}) as events,
            (select count(*)::int from audit_log where action = 'merged' and entity_id = ${keepPatient.id}) as "mergeAudits",
            (select count(*)::int from patient_merge_transaction_observations where operation_id = ${operationId}) as observations,
            (select isolation_level from patient_merge_transaction_observations where operation_id = ${operationId}) as "isolationLevel",
            (select tenant_context from patient_merge_transaction_observations where operation_id = ${operationId}) as "tenantContext",
            (select count(*)::int from patients where id in (${retryKeepPatient.id}, ${retrySourcePatient.id}) and deleted_at is null) as "retryPatientsActive",
            (select count(*)::int from patient_merge_events where operation_id = ${retryOperationId}) as "retryEvents",
            (select count(*)::int from audit_log where action = 'merged' and entity_id = ${retryKeepPatient.id}) as "retryAudits",
            (select count(*)::int from patient_merge_transaction_observations where operation_id = ${retryOperationId}) as "retryObservations",
            (select patient_id = ${keepPatient.id} from appointments where id = ${successAppointment.id}) as "successAppointmentMoved",
            (select patient_id = ${keepPatient.id} from appointment_waitlist where id = ${successWaitlist.id}) as "successWaitlistMoved",
            (select patient_id = ${retrySourcePatient.id} from appointments where id = ${retryAppointment.id}) as "retryAppointmentPreserved",
            (select patient_id = ${retrySourcePatient.id} from appointment_waitlist where id = ${retryWaitlist.id}) as "retryWaitlistPreserved",
            (select date_trunc('milliseconds', updated_at) = ${retryAppointment.updatedAt.toISOString()}::timestamptz from appointments where id = ${retryAppointment.id}) as "retryAppointmentTimestampPreserved",
            (select date_trunc('milliseconds', updated_at) = ${retryWaitlist.updatedAt.toISOString()}::timestamptz from appointment_waitlist where id = ${retryWaitlist.id}) as "retryWaitlistTimestampPreserved",
            (select deleted_at is not null from patients where id = ${raceSourcePatient.id}) as "raceSourceDeleted",
            (select count(*)::int from patient_merge_events where operation_id = ${raceOperationId}) as "raceEvents",
            (select count(*)::int from audit_log where action = 'merged' and entity_id = ${raceKeepPatient.id}) as "raceAudits",
            (select patient_id = ${raceKeepPatient.id} from appointments where id = ${raceAppointment.id}) as "raceAppointmentMoved",
            (select patient_id = ${raceKeepPatient.id} from appointment_waitlist where id = ${raceWaitlist.id}) as "raceWaitlistMoved",
            (select count(*)::int from patients where id in (${lineageKeepPatient.id}, ${lineageSourcePatient.id}) and deleted_at is null) as "lineagePatientsActive",
            (select count(*)::int from patient_merge_events where operation_id = ${lineageOperationId}) as "lineageEvents",
            (select count(*)::int from audit_log where action = 'merged' and entity_id = ${lineageKeepPatient.id}) as "lineageAudits"
        `;
        expect(state).toEqual({
          sourceDeleted: true,
          events: 1,
          mergeAudits: 1,
          observations: 1,
          isolationLevel: "serializable",
          tenantContext: practice.id,
          retryPatientsActive: 2,
          retryEvents: 0,
          retryAudits: 0,
          retryObservations: 0,
          successAppointmentMoved: true,
          successWaitlistMoved: true,
          retryAppointmentPreserved: true,
          retryWaitlistPreserved: true,
          retryAppointmentTimestampPreserved: true,
          retryWaitlistTimestampPreserved: true,
          raceSourceDeleted: true,
          raceEvents: 1,
          raceAudits: 1,
          raceAppointmentMoved: true,
          raceWaitlistMoved: true,
          lineagePatientsActive: 2,
          lineageEvents: 0,
          lineageAudits: 0,
        });

        const [noContext] = await appSql<Array<{ patients: number }>>`
          select count(*)::int as patients from patients
        `;
        expect(noContext).toEqual({ patients: 0 });
      } finally {
        if (raceSqlB) await raceSqlB.end();
        if (raceSqlA) await raceSqlA.end();
        if (appSql) await appSql.end();
        if (ownerSql) await ownerSql.end();
        await adminSql.unsafe(
          `drop database if exists "${databaseName}" with (force)`,
        );
        await adminSql.end();
      }
    }, 120_000);
  },
);
