import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { and, count, eq, max } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";

import * as schema from "../../../../packages/db/schema/index";
import { appRouter } from "../routers/_app";

vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn(async () => undefined),
}));

const repoRoot = resolve(process.cwd(), "../..");
const describeWithAuthoringPostgres =
  process.env.TREATMENT_PLAN_AUTHORING_DB_INTEGRATION === "1"
    ? describe
    : describe.skip;

type AppDatabase = ReturnType<typeof drizzle<typeof schema>>;

function callerFor(
  database: AppDatabase,
  practiceId: string,
  userId: string,
  role: "admin" | "veterinarian" | "technician" | "front_desk" = "admin",
) {
  return appRouter.createCaller({
    db: database,
    session: {
      user: {
        id: userId,
        email: `${role}@synthetic.invalid`,
        name: "Synthetic treatment-plan staff",
        role,
        practiceId,
      },
    },
  } as never);
}

describeWithAuthoringPostgres(
  "visit treatment-plan authoring PostgreSQL contract",
  () => {
    it("proves tenant safety, snapshot/replay/rollback semantics, and concurrent revision control", async () => {
      const adminUrl = process.env.DATABASE_URL;
      if (!adminUrl) throw new Error("DATABASE_URL is required");

      const databaseName = `openpims_plan_authoring_${randomUUID().replaceAll("-", "")}`;
      if (!/^openpims_plan_authoring_[a-f0-9]+$/.test(databaseName)) {
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

      const previousFlag = process.env.TREATMENT_PLAN_AUTHORING_ENABLED;
      process.env.TREATMENT_PLAN_AUTHORING_ENABLED = "true";

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
        const [practice, otherPractice] = await ownerDb
          .insert(schema.practices)
          .values([
            {
              name: "Synthetic Treatment Plan Clinic",
              currency: "usd",
              taxRatePercent: "8.25",
            },
            {
              name: "Other Synthetic Clinic",
              currency: "usd",
              taxRatePercent: "7.00",
            },
          ])
          .returning({ id: schema.practices.id });
        if (!practice || !otherPractice) {
          throw new Error("failed to seed practices");
        }

        const [location, otherLocation] = await ownerDb
          .insert(schema.locations)
          .values([
            {
              practiceId: practice.id,
              name: "Main Clinic",
              isPrimary: true,
            },
            {
              practiceId: otherPractice.id,
              name: "Other Clinic",
              isPrimary: true,
            },
          ])
          .returning({ id: schema.locations.id });
        const [staff, otherStaff] = await ownerDb
          .insert(schema.users)
          .values([
            {
              practiceId: practice.id,
              email: "plan-author@example.invalid",
              passwordHash: "not-a-real-password-hash",
              name: "Synthetic Plan Author",
              role: "admin",
              emailVerifiedAt: new Date(),
            },
            {
              practiceId: otherPractice.id,
              email: "other-plan-author@example.invalid",
              passwordHash: "not-a-real-password-hash",
              name: "Other Synthetic Author",
              role: "admin",
              emailVerifiedAt: new Date(),
            },
          ])
          .returning({ id: schema.users.id });
        const [client, otherClient] = await ownerDb
          .insert(schema.clients)
          .values([
            {
              practiceId: practice.id,
              firstName: "Synthetic",
              lastName: "Owner",
            },
            {
              practiceId: otherPractice.id,
              firstName: "Other",
              lastName: "Owner",
            },
          ])
          .returning({ id: schema.clients.id });
        if (
          !location ||
          !otherLocation ||
          !staff ||
          !otherStaff ||
          !client ||
          !otherClient
        ) {
          throw new Error("failed to seed treatment-plan identities");
        }

        const [patient, otherPatient] = await ownerDb
          .insert(schema.patients)
          .values([
            {
              practiceId: practice.id,
              clientId: client.id,
              name: "Synthetic Patient",
              species: "canine",
            },
            {
              practiceId: otherPractice.id,
              clientId: otherClient.id,
              name: "Other Patient",
              species: "feline",
            },
          ])
          .returning({ id: schema.patients.id });
        if (!patient || !otherPatient) {
          throw new Error("failed to seed patients");
        }

        const start = new Date(Date.now() + 86_400_000);
        const [appointment] = await ownerDb
          .insert(schema.appointments)
          .values({
            practiceId: practice.id,
            locationId: location.id,
            clientId: client.id,
            patientId: patient.id,
            startTime: start,
            endTime: new Date(start.getTime() + 1_800_000),
          })
          .returning({ id: schema.appointments.id });
        if (!appointment) throw new Error("failed to seed appointment");

        const [examService] = await ownerDb
          .insert(schema.services)
          .values({
            practiceId: practice.id,
            name: "Comprehensive exam",
            code: "EXAM",
            defaultPrice: "50.00",
            taxable: false,
          })
          .returning({ id: schema.services.id });
        const [medication, otherMedication] = await ownerDb
          .insert(schema.products)
          .values([
            {
              practiceId: practice.id,
              locationId: location.id,
              name: "Synthetic medication",
              sku: "MED-1",
              unitPrice: "12.34",
              taxable: true,
              inventoryTracked: true,
              stockQuantity: 20,
            },
            {
              practiceId: otherPractice.id,
              locationId: otherLocation.id,
              name: "Private other-clinic product",
              sku: "PRIVATE-1",
              unitPrice: "999.00",
              taxable: true,
              inventoryTracked: true,
              stockQuantity: 99,
            },
          ])
          .returning({ id: schema.products.id });
        if (!examService || !medication || !otherMedication) {
          throw new Error("failed to seed catalog");
        }

        appSql = postgres(appUrl.toString(), { max: 1 });
        raceSqlA = postgres(appUrl.toString(), { max: 1 });
        raceSqlB = postgres(appUrl.toString(), { max: 1 });
        const appDb = drizzle(appSql, { schema });
        const raceDbA = drizzle(raceSqlA, { schema });
        const raceDbB = drizzle(raceSqlB, { schema });
        const caller = callerFor(appDb, practice.id, staff.id);

        const createOperationId = randomUUID();
        const createInput = {
          operationId: createOperationId,
          clientId: client.id,
          patientId: patient.id,
          appointmentId: appointment.id,
          title: "Dental treatment plan",
          items: [
            {
              itemType: "service" as const,
              itemId: examService.id,
              quantity: "1",
            },
            {
              itemType: "product" as const,
              itemId: medication.id,
              quantity: "2.5",
            },
          ],
        };
        const created = await caller.visitTreatmentPlans.create(createInput);
        expect(created.plan).toMatchObject({
          clientId: client.id,
          patientId: patient.id,
          appointmentId: appointment.id,
          title: "Dental treatment plan",
          status: "open",
        });
        expect(created.revision).toMatchObject({
          revisionNumber: 1,
          currency: "USD",
          subtotal: "80.85",
          tax: "2.55",
          total: "83.40",
        });
        expect(created.revision.contentSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(created.lines).toHaveLength(2);
        expect(created.lines[0]).toMatchObject({
          description: "Comprehensive exam",
          offeredQuantity: "1.000",
          unitPrice: "50.00",
          lineSubtotal: "50.00",
          taxAmount: "0.00",
        });
        expect(created.lines[1]).toMatchObject({
          description: "Synthetic medication",
          offeredQuantity: "2.500",
          unitPrice: "12.34",
          lineSubtotal: "30.85",
          taxAmount: "2.55",
        });

        const replay = await caller.visitTreatmentPlans.create(createInput);
        expect(replay.plan.id).toBe(created.plan.id);
        expect(replay.revision.id).toBe(created.revision.id);
        await expect(
          caller.visitTreatmentPlans.create({
            ...createInput,
            title: "Different payload",
          }),
        ).rejects.toMatchObject({ code: "CONFLICT" });

        const concurrentCreateInput = {
          ...createInput,
          operationId: randomUUID(),
          title: "Concurrent create treatment plan",
        };
        const concurrentCreates = await Promise.all([
          callerFor(raceDbA, practice.id, staff.id).visitTreatmentPlans.create(
            concurrentCreateInput,
          ),
          callerFor(raceDbB, practice.id, staff.id).visitTreatmentPlans.create(
            concurrentCreateInput,
          ),
        ]);
        expect(concurrentCreates[0]?.plan.id).toBe(
          concurrentCreates[1]?.plan.id,
        );
        expect(concurrentCreates[0]?.revision.id).toBe(
          concurrentCreates[1]?.revision.id,
        );

        await ownerDb
          .update(schema.services)
          .set({ name: "Renamed catalog service", defaultPrice: "75.00" })
          .where(eq(schema.services.id, examService.id));
        const preserved = await caller.visitTreatmentPlans.preview({
          planId: created.plan.id,
          revisionNumber: 1,
        });
        expect(preserved.lines[0]).toMatchObject({
          description: "Comprehensive exam",
          unitPrice: "50.00",
        });

        const revised = await caller.visitTreatmentPlans.revise({
          operationId: randomUUID(),
          planId: created.plan.id,
          expectedRevisionNumber: 1,
          items: [
            {
              itemType: "product",
              itemId: medication.id,
              quantity: "1",
            },
          ],
        });
        expect(revised.revision.revisionNumber).toBe(2);
        expect(revised.lines).toHaveLength(1);
        await expect(
          caller.visitTreatmentPlans.revise({
            operationId: randomUUID(),
            planId: created.plan.id,
            expectedRevisionNumber: 1,
            items: [
              {
                itemType: "product",
                itemId: medication.id,
                quantity: "3",
              },
            ],
          }),
        ).rejects.toMatchObject({ code: "CONFLICT" });

        const beforeCrossTenant = await ownerDb
          .select({ value: count() })
          .from(schema.visitTreatmentPlanRevisionLines)
          .where(
            eq(schema.visitTreatmentPlanRevisionLines.planId, created.plan.id),
          );
        await expect(
          caller.visitTreatmentPlans.revise({
            operationId: randomUUID(),
            planId: created.plan.id,
            expectedRevisionNumber: 2,
            items: [
              {
                itemType: "product",
                itemId: otherMedication.id,
                quantity: "1",
              },
            ],
          }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        const afterCrossTenant = await ownerDb
          .select({ value: count() })
          .from(schema.visitTreatmentPlanRevisionLines)
          .where(
            eq(schema.visitTreatmentPlanRevisionLines.planId, created.plan.id),
          );
        expect(afterCrossTenant[0]?.value).toBe(beforeCrossTenant[0]?.value);

        await expect(
          caller.visitTreatmentPlans.create({
            ...createInput,
            operationId: randomUUID(),
            clientId: otherClient.id,
            patientId: otherPatient.id,
            appointmentId: undefined,
          }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });

        const injectedFaultOperationId = randomUUID();
        await ownerSql.unsafe(`
            create or replace function public.inject_plan_authoring_fault()
            returns trigger language plpgsql set search_path = '' as $$
            begin
              if new.operation_id = '${injectedFaultOperationId}'::uuid then
                raise exception using errcode = '40001', message = 'synthetic post-line authoring fault';
              end if;
              return new;
            end $$;
            create trigger aaa_inject_plan_authoring_fault
              before insert on public.visit_treatment_plan_revisions
              for each row execute function public.inject_plan_authoring_fault();
          `);
        const [beforeFault] = await ownerDb
          .select({
            revisions: count(schema.visitTreatmentPlanRevisions.id),
          })
          .from(schema.visitTreatmentPlanRevisions)
          .where(
            eq(schema.visitTreatmentPlanRevisions.planId, created.plan.id),
          );
        const [beforeFaultLines] = await ownerDb
          .select({ lines: count(schema.visitTreatmentPlanRevisionLines.id) })
          .from(schema.visitTreatmentPlanRevisionLines)
          .where(
            eq(schema.visitTreatmentPlanRevisionLines.planId, created.plan.id),
          );
        await expect(
          caller.visitTreatmentPlans.revise({
            operationId: injectedFaultOperationId,
            planId: created.plan.id,
            expectedRevisionNumber: 2,
            items: [
              {
                itemType: "service",
                itemId: examService.id,
                quantity: "4",
              },
            ],
          }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        await ownerSql.unsafe(`
            drop trigger aaa_inject_plan_authoring_fault
              on public.visit_treatment_plan_revisions;
            drop function public.inject_plan_authoring_fault();
          `);
        const [afterFault] = await ownerDb
          .select({
            revisions: count(schema.visitTreatmentPlanRevisions.id),
          })
          .from(schema.visitTreatmentPlanRevisions)
          .where(
            eq(schema.visitTreatmentPlanRevisions.planId, created.plan.id),
          );
        const [afterFaultLines] = await ownerDb
          .select({ lines: count(schema.visitTreatmentPlanRevisionLines.id) })
          .from(schema.visitTreatmentPlanRevisionLines)
          .where(
            eq(schema.visitTreatmentPlanRevisionLines.planId, created.plan.id),
          );
        expect(afterFault).toEqual(beforeFault);
        expect(afterFaultLines).toEqual(beforeFaultLines);

        const raceOperationA = randomUUID();
        const raceOperationB = randomUUID();
        const raceInputA = {
          operationId: raceOperationA,
          planId: created.plan.id,
          expectedRevisionNumber: 2,
          items: [
            {
              itemType: "service" as const,
              itemId: examService.id,
              quantity: "1",
            },
          ],
        };
        const raceInputB = {
          operationId: raceOperationB,
          planId: created.plan.id,
          expectedRevisionNumber: 2,
          items: [
            {
              itemType: "product" as const,
              itemId: medication.id,
              quantity: "2",
            },
          ],
        };
        const race = await Promise.allSettled([
          callerFor(raceDbA, practice.id, staff.id).visitTreatmentPlans.revise(
            raceInputA,
          ),
          callerFor(raceDbB, practice.id, staff.id).visitTreatmentPlans.revise(
            raceInputB,
          ),
        ]);
        const winners = race.filter(
          (
            result,
          ): result is PromiseFulfilledResult<
            Awaited<ReturnType<typeof caller.visitTreatmentPlans.revise>>
          > => result.status === "fulfilled",
        );
        const losers = race.filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        );
        expect(winners).toHaveLength(1);
        expect(losers).toHaveLength(1);
        expect(losers[0]?.reason).toMatchObject({ code: "CONFLICT" });
        expect(winners[0]?.value.revision.revisionNumber).toBe(3);

        const winningInput =
          race[0]?.status === "fulfilled" ? raceInputA : raceInputB;
        const replayedWinner =
          await caller.visitTreatmentPlans.revise(winningInput);
        expect(replayedWinner.revision.id).toBe(winners[0]?.value.revision.id);

        const [revisionSummary] = await ownerDb
          .select({
            count: count(),
            maxRevision: max(schema.visitTreatmentPlanRevisions.revisionNumber),
          })
          .from(schema.visitTreatmentPlanRevisions)
          .where(
            and(
              eq(schema.visitTreatmentPlanRevisions.practiceId, practice.id),
              eq(schema.visitTreatmentPlanRevisions.planId, created.plan.id),
            ),
          );
        expect(revisionSummary).toMatchObject({ count: 3, maxRevision: 3 });

        const [downstream] = await ownerDb
          .select({ invoiceCount: count(schema.invoices.id) })
          .from(schema.invoices)
          .where(eq(schema.invoices.practiceId, practice.id));
        expect(downstream?.invoiceCount).toBe(0);
        const [appointmentAfter] = await ownerDb
          .select({ status: schema.appointments.status })
          .from(schema.appointments)
          .where(eq(schema.appointments.id, appointment.id));
        expect(appointmentAfter?.status).toBe("scheduled");
        const [productAfter] = await ownerDb
          .select({ stockQuantity: schema.products.stockQuantity })
          .from(schema.products)
          .where(eq(schema.products.id, medication.id));
        expect(productAfter?.stockQuantity).toBe(20);

        const otherCaller = callerFor(appDb, otherPractice.id, otherStaff.id);
        await expect(
          otherCaller.visitTreatmentPlans.preview({
            planId: created.plan.id,
          }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });

        const noContextRows = await appDb
          .select({ id: schema.visitTreatmentPlans.id })
          .from(schema.visitTreatmentPlans);
        expect(noContextRows).toEqual([]);
      } finally {
        if (previousFlag === undefined) {
          delete process.env.TREATMENT_PLAN_AUTHORING_ENABLED;
        } else {
          process.env.TREATMENT_PLAN_AUTHORING_ENABLED = previousFlag;
        }
        await Promise.allSettled([
          appSql?.end({ timeout: 2 }),
          raceSqlA?.end({ timeout: 2 }),
          raceSqlB?.end({ timeout: 2 }),
          ownerSql?.end({ timeout: 2 }),
        ]);
        await adminSql.unsafe(
          `select pg_terminate_backend(pid) from pg_stat_activity where datname = '${databaseName}' and pid <> pg_backend_pid()`,
        );
        await adminSql.unsafe(`drop database if exists "${databaseName}"`);
        await adminSql.end({ timeout: 2 });
      }
    }, 120_000);
  },
);
