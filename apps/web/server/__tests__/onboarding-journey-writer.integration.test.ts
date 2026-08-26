import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";

import * as schema from "../../../../packages/db/schema/index";
import { withTenant } from "@/lib/tenant-db";
import type { Database } from "@openpims/db/client";
import { appRouter } from "../routers/_app";

vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn(async () => undefined),
}));

const repoRoot = resolve(process.cwd(), "../..");
const describeWithPostgres =
  process.env.ONBOARDING_JOURNEY_WRITER_DB_INTEGRATION === "1"
    ? describe.sequential
    : describe.skip;

type AppDatabase = ReturnType<typeof drizzle<typeof schema>>;

function runPnpm(args: string[], databaseUrl: string): void {
  const pnpmCliPath = process.env.PNPM_CLI_PATH?.trim();
  execFileSync(
    pnpmCliPath ? process.execPath : "pnpm",
    pnpmCliPath ? [pnpmCliPath, ...args] : args,
    {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: "utf8",
      timeout: 45_000,
    },
  );
}

function callerFor(database: AppDatabase, practiceId: string, userId: string) {
  return appRouter.createCaller({
    db: database,
    session: {
      user: {
        id: userId,
        email: "synthetic-onboarding-admin@example.invalid",
        name: "Synthetic onboarding admin",
        role: "admin",
        practiceId,
      },
    },
  } as never);
}

function settingsState(settings: unknown): Record<string, unknown> {
  const root = (settings ?? {}) as Record<string, unknown>;
  return (root.onboardingState ?? {}) as Record<string, unknown>;
}

describeWithPostgres(
  "onboarding journey writer PostgreSQL, CAS, and RLS contract",
  () => {
    it("serializes revisions, preserves evidence, rolls back failures, and clears tenant GUCs", async () => {
      const adminUrl = process.env.DATABASE_URL?.trim();
      if (!adminUrl) throw new Error("DATABASE_URL is required");
      const hostname = new URL(adminUrl).hostname;
      if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) {
        throw new Error(
          "This test is restricted to disposable local PostgreSQL",
        );
      }
      const appPassword = process.env.OPENPIMS_APP_DB_PASSWORD?.trim();
      if (!appPassword) {
        throw new Error("OPENPIMS_APP_DB_PASSWORD is required");
      }

      const databaseName = `openpims_onboarding_writer_${randomUUID().replaceAll("-", "")}`;
      if (!/^openpims_onboarding_writer_[a-f0-9]+$/.test(databaseName)) {
        throw new Error("unsafe disposable database name");
      }
      const databaseUrl = new URL(adminUrl);
      databaseUrl.pathname = `/${databaseName}`;
      databaseUrl.search = "";
      databaseUrl.hash = "";
      const appUrl = new URL(databaseUrl);
      appUrl.username = "openpims_app";
      appUrl.password = appPassword;

      const adminSql = postgres(adminUrl, { max: 1 });
      let ownerSql: ReturnType<typeof postgres> | undefined;
      let appSql: ReturnType<typeof postgres> | undefined;
      let raceSqlA: ReturnType<typeof postgres> | undefined;
      let raceSqlB: ReturnType<typeof postgres> | undefined;
      let databaseCreated = false;

      try {
        await adminSql.unsafe(`create database "${databaseName}"`);
        databaseCreated = true;
        runPnpm(
          ["--filter", "@openpims/db", "db:migrate"],
          databaseUrl.toString(),
        );
        runPnpm(["--filter", "@openpims/db", "db:rls"], databaseUrl.toString());

        ownerSql = postgres(databaseUrl.toString(), { max: 1 });
        appSql = postgres(appUrl.toString(), { max: 1 });
        raceSqlA = postgres(appUrl.toString(), { max: 1 });
        raceSqlB = postgres(appUrl.toString(), { max: 1 });
        const ownerDb = drizzle(ownerSql, { schema });
        const appDb = drizzle(appSql, { schema });
        const raceDbA = drizzle(raceSqlA, { schema });
        const raceDbB = drizzle(raceSqlB, { schema });

        const [practice, otherPractice, legacyPractice, rollbackPractice] =
          await ownerDb
            .insert(schema.practices)
            .values([
              {
                name: "Synthetic prospective onboarding clinic",
                settings: {
                  onboardingState: {
                    journeyEvidenceVersion: 1,
                    journeyRevision: 0,
                  },
                },
              },
              {
                name: "Synthetic private onboarding clinic",
                settings: {
                  onboardingState: {
                    journeyEvidenceVersion: 1,
                    journeyRevision: 0,
                  },
                },
              },
              {
                name: "Synthetic legacy onboarding clinic",
                settings: {
                  onboardingState: {
                    journeyRevision: 0,
                    onboardingIntent: "alongside",
                    onboardingIntentSelectedAt: "2026-08-01T12:00:00.000Z",
                    journeyStepId: "allSet",
                  },
                },
              },
              {
                name: "Synthetic rollback onboarding clinic",
                settings: {
                  onboardingState: {
                    journeyEvidenceVersion: 1,
                    journeyRevision: 0,
                  },
                },
              },
            ])
            .returning({
              id: schema.practices.id,
              createdAt: schema.practices.createdAt,
            });
        if (
          !practice ||
          !otherPractice ||
          !legacyPractice ||
          !rollbackPractice
        ) {
          throw new Error("failed to seed onboarding practices");
        }

        const [admin, otherAdmin, legacyAdmin, rollbackAdmin] = await ownerDb
          .insert(schema.users)
          .values([
            {
              practiceId: practice.id,
              email: "prospective-onboarding@example.invalid",
              passwordHash: "not-a-real-password-hash",
              name: "Prospective admin",
              role: "admin",
            },
            {
              practiceId: otherPractice.id,
              email: "private-onboarding@example.invalid",
              passwordHash: "not-a-real-password-hash",
              name: "Private admin",
              role: "admin",
            },
            {
              practiceId: legacyPractice.id,
              email: "legacy-onboarding@example.invalid",
              passwordHash: "not-a-real-password-hash",
              name: "Legacy admin",
              role: "admin",
            },
            {
              practiceId: rollbackPractice.id,
              email: "rollback-onboarding@example.invalid",
              passwordHash: "not-a-real-password-hash",
              name: "Rollback admin",
              role: "admin",
            },
          ])
          .returning({ id: schema.users.id });
        if (!admin || !otherAdmin || !legacyAdmin || !rollbackAdmin) {
          throw new Error("failed to seed onboarding admins");
        }

        const identity = await appSql<{ currentUser: string }[]>`
          select current_user as "currentUser"
        `;
        expect(identity[0]?.currentUser).toBe("openpims_app");
        const noContextRows = await appDb.select().from(schema.practices);
        expect(noContextRows).toEqual([]);
        const tenantRows = await withTenant(
          appDb as unknown as Database,
          practice.id,
          (tx) => tx.select({ id: schema.practices.id }).from(schema.practices),
        );
        expect(tenantRows).toEqual([{ id: practice.id }]);

        const caller = callerFor(appDb, practice.id, admin.id);
        const intent = await caller.settings.setOnboardingIntent({
          intent: "alongside",
          clinicModel: "mobile",
          firstGoal: "run_visit",
          expectedRevision: 0,
        });
        expect(intent).toMatchObject({
          journeyStepId: "intent",
          journeyRevision: 1,
          journeyEvidenceMode: "prospective",
        });
        const intentAt = intent.journeyIntentCompletedAt;
        expect(intentAt).toBeTruthy();

        const basics = await caller.settings.setJourneyProgress({
          stepId: "basics",
          dismissed: false,
          expectedRevision: 1,
        });
        expect(basics).toMatchObject({
          journeyStepId: "basics",
          journeyRevision: 2,
          journeyIntentCompletedAt: intentAt,
        });

        const race = await Promise.allSettled([
          callerFor(raceDbA, practice.id, admin.id).settings.setJourneyProgress(
            {
              stepId: "data",
              dismissed: false,
              expectedRevision: 2,
            },
          ),
          callerFor(raceDbB, practice.id, admin.id).settings.setJourneyProgress(
            {
              stepId: "data",
              dismissed: false,
              expectedRevision: 2,
            },
          ),
        ]);
        expect(
          race.filter((result) => result.status === "fulfilled"),
        ).toHaveLength(1);
        expect(
          race.filter((result) => result.status === "rejected"),
        ).toHaveLength(1);
        const raceFailure = race.find(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        );
        expect(raceFailure?.reason).toMatchObject({ code: "CONFLICT" });

        const afterRace = await caller.settings.getOnboardingState();
        expect(afterRace).toMatchObject({
          journeyStepId: "data",
          journeyRevision: 3,
          journeyEvidenceMode: "prospective",
        });
        const basicsAt = afterRace.journeyBasicsCompletedAt;
        expect(basicsAt).toBeTruthy();

        const allSet = await caller.settings.setJourneyProgress({
          stepId: "allSet",
          dismissed: false,
          expectedRevision: 3,
        });
        expect(allSet).toMatchObject({
          journeyStepId: "allSet",
          journeyRevision: 4,
        });
        const dataAt = allSet.journeyDataCompletedAt;
        expect(dataAt).toBeTruthy();

        const completed = await caller.settings.completeOnboarding({
          expectedRevision: 4,
        });
        expect(completed).toMatchObject({
          journeyRevision: 5,
          journeyEvidenceMode: "prospective",
        });
        const allSetAt = completed.journeyAllSetCompletedAt;
        const completedAt = completed.onboardingCompletedAt;
        expect(allSetAt).toBe(completedAt);
        expect(
          [intentAt, basicsAt, dataAt, allSetAt].map((value) =>
            Date.parse(value!),
          ),
        ).toEqual(
          [...[intentAt, basicsAt, dataAt, allSetAt]]
            .map((value) => Date.parse(value!))
            .sort((left, right) => left - right),
        );

        const repeated = await caller.settings.completeOnboarding({
          expectedRevision: 5,
        });
        expect(repeated).toMatchObject({
          journeyRevision: 5,
          journeyAllSetCompletedAt: allSetAt,
          onboardingCompletedAt: completedAt,
        });
        await expect(
          caller.settings.completeOnboarding({ expectedRevision: 4 }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        await expect(
          caller.settings.setJourneyProgress({
            stepId: "data",
            expectedRevision: 5,
          }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        await expect(
          caller.settings.setOnboardingIntent({
            intent: "replace",
            expectedRevision: 5,
          }),
        ).rejects.toMatchObject({ code: "CONFLICT" });

        const legacyCaller = callerFor(
          appDb,
          legacyPractice.id,
          legacyAdmin.id,
        );
        const legacyCompleted = await legacyCaller.settings.completeOnboarding({
          expectedRevision: 0,
        });
        expect(legacyCompleted).toMatchObject({
          journeyEvidenceMode: "legacy",
          journeyRevision: 1,
          journeyIntentCompletedAt: null,
          journeyBasicsCompletedAt: null,
          journeyDataCompletedAt: null,
        });
        expect(legacyCompleted.journeyAllSetCompletedAt).toBeTruthy();

        await ownerSql.unsafe(`
          create function onboarding_writer_test_failure() returns trigger
          language plpgsql as $$
          begin
            if new.name = 'Synthetic rollback onboarding clinic'
              and coalesce((new.settings->'onboardingState'->>'journeyRevision')::integer, 0) > 0
            then
              raise exception 'synthetic onboarding rollback';
            end if;
            return new;
          end
          $$;
          create trigger onboarding_writer_test_failure
          before update on practices
          for each row execute function onboarding_writer_test_failure();
        `);
        const rollbackCaller = callerFor(
          appDb,
          rollbackPractice.id,
          rollbackAdmin.id,
        );
        await expect(
          rollbackCaller.settings.setOnboardingIntent({
            intent: "alongside",
            expectedRevision: 0,
          }),
        ).rejects.toThrow();
        const [rolledBack] = await ownerDb
          .select({ settings: schema.practices.settings })
          .from(schema.practices)
          .where(eq(schema.practices.id, rollbackPractice.id));
        expect(settingsState(rolledBack?.settings)).toEqual({
          journeyEvidenceVersion: 1,
          journeyRevision: 0,
        });

        const [otherUnchanged] = await ownerDb
          .select({ settings: schema.practices.settings })
          .from(schema.practices)
          .where(eq(schema.practices.id, otherPractice.id));
        expect(settingsState(otherUnchanged?.settings)).toEqual({
          journeyEvidenceVersion: 1,
          journeyRevision: 0,
        });

        for (const client of [appSql, raceSqlA, raceSqlB]) {
          const guc = await client<{ practiceId: string | null }[]>`
            select nullif(current_setting('app.current_practice_id', true), '') as "practiceId"
          `;
          expect(guc[0]?.practiceId).toBeNull();
        }
      } finally {
        await Promise.allSettled([
          ownerSql?.end({ timeout: 2 }),
          appSql?.end({ timeout: 2 }),
          raceSqlA?.end({ timeout: 2 }),
          raceSqlB?.end({ timeout: 2 }),
        ]);
        if (databaseCreated) {
          await adminSql.unsafe(`drop database "${databaseName}" with (force)`);
        }
        await adminSql.end({ timeout: 2 });
      }
    }, 120_000);
  },
);
