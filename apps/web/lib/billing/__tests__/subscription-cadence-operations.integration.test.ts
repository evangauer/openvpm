import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import {
  auditLog,
  practices,
  subscriptionCadenceOperations,
  users,
} from "@openpims/db";
import type { Database } from "@openpims/db/client";
import { withSystem, withTenant } from "@/lib/tenant-db";
import {
  dispatchAnnualCadenceOperation,
  readCadenceOperationStatus,
  reconcileCadenceOperationFromSignedSubscriptionSnapshot,
  reserveAnnualCadenceOperation,
  runDurableCadenceOperationRecoveryBatch,
  supersedeManualCadenceOperation,
} from "../subscription-cadence-operations";
import type {
  CadenceProvider,
  CadenceProviderInspection,
} from "../subscription-cadence-provider";

const enabled = process.env.SUBSCRIPTION_CADENCE_DB_INTEGRATION === "1";
const integration = enabled ? describe : describe.skip;
const PERIOD_END = new Date(Date.now() - 24 * 60 * 60 * 1000);
const PERIOD_START = new Date(PERIOD_END.getTime() - 31 * 24 * 60 * 60 * 1000);

integration("durable subscription cadence orchestration", () => {
  let admin: ReturnType<typeof postgres>;
  let owner: ReturnType<typeof postgres>;
  let rootDb: Database;
  let monitoredDb: Database;
  let databaseName = "";
  let ownerRole = "";
  let databaseCreated = false;
  let roleCreated = false;
  let transactionDepth = 0;
  const ids = {
    practiceSuccess: randomUUID(),
    practiceCrash: randomUUID(),
    practiceCustom: randomUUID(),
    userSuccess: randomUUID(),
    userCrash: randomUUID(),
    userCustom: randomUUID(),
  };

  beforeAll(async () => {
    const adminUrl = process.env.DATABASE_URL?.trim();
    if (!adminUrl) throw new Error("DATABASE_URL is required");
    const suffix = randomUUID().replaceAll("-", "");
    databaseName = `openpims_cadence_app_${suffix}`;
    ownerRole = `openpims_cadence_app_owner_${suffix}`;
    const ownerPassword = randomUUID();
    admin = postgres(adminUrl, { max: 1 });
    await admin.unsafe(
      `create role "${ownerRole}" login password '${ownerPassword}'`,
    );
    roleCreated = true;
    await admin.unsafe(
      `create database "${databaseName}" owner "${ownerRole}"`,
    );
    databaseCreated = true;

    const ownerUrl = new URL(adminUrl);
    ownerUrl.pathname = `/${databaseName}`;
    ownerUrl.username = ownerRole;
    ownerUrl.password = ownerPassword;
    ownerUrl.search = "";
    ownerUrl.hash = "";
    execFileSync("pnpm", ["--filter", "@openpims/db", "db:migrate"], {
      cwd: resolve(process.cwd(), "../.."),
      env: { ...process.env, DATABASE_URL: ownerUrl.toString() },
      stdio: "pipe",
    });
    owner = postgres(ownerUrl.toString(), { max: 4 });
    const [identity] = await owner<{ currentUser: string }[]>`
      select current_user as "currentUser"`;
    expect(identity?.currentUser).toBe(ownerRole);
    rootDb = drizzle(owner) as unknown as Database;
    monitoredDb = new Proxy(rootDb, {
      get(target, property, receiver) {
        if (property !== "transaction") {
          return Reflect.get(target, property, receiver);
        }
        return async <T>(callback: (tx: Database) => Promise<T>) =>
          target.transaction(async (tx) => {
            transactionDepth += 1;
            try {
              return await callback(tx as unknown as Database);
            } finally {
              transactionDepth -= 1;
            }
          });
      },
    });

    await rootDb.insert(practices).values(
      [
        [ids.practiceSuccess, "Success", "cus_success", "sub_success", 1, 1],
        [ids.practiceCrash, "Crash", "cus_crash", "sub_crash", 2, 2],
        [ids.practiceCustom, "Custom", "cus_custom", "sub_custom", 3, 3],
      ].map(([id, name, customerId, subscriptionId, generation, revision]) => ({
        id: id as string,
        name: name as string,
        billingStatus: "active",
        stripeCustomerId: customerId as string,
        stripeSubscriptionId: subscriptionId as string,
        subscriptionGeneration: generation as number,
        stripeSubscriptionSyncRevision: revision as number,
        settings: {
          billingSync: {
            billingCadence: "month",
            status: "ok",
            updatedAt: "2026-08-30T00:00:00.000Z",
            locationCount: 1,
            billableSeatCount: 1,
            message: "Synthetic integration fixture",
          },
        },
      })),
    );
    await rootDb.insert(users).values([
      {
        id: ids.userSuccess,
        email: `cadence-success-${suffix}@example.com`,
        passwordHash: "test",
        name: "Success Admin",
        role: "admin",
        practiceId: ids.practiceSuccess,
      },
      {
        id: ids.userCrash,
        email: `cadence-crash-${suffix}@example.com`,
        passwordHash: "test",
        name: "Crash Admin",
        role: "admin",
        practiceId: ids.practiceCrash,
      },
      {
        id: ids.userCustom,
        email: `cadence-custom-${suffix}@example.com`,
        passwordHash: "test",
        name: "Custom Admin",
        role: "admin",
        practiceId: ids.practiceCustom,
      },
    ]);
  }, 30_000);

  afterAll(async () => {
    if (owner) await owner.end();
    if (databaseCreated) {
      await admin.unsafe(`drop database "${databaseName}" with (force)`);
    }
    if (roleCreated) await admin.unsafe(`drop role "${ownerRole}"`);
    if (admin) await admin.end();
  });

  function assertProviderBoundary(): void {
    expect(transactionDepth).toBe(0);
  }

  function authorized(): CadenceProviderInspection {
    return {
      outcome: "authorized",
      currentLocationItemId: "si_monthly",
      currentLocationPriceId: "price_monthly",
      currentLocationQuantity: 1,
      currentPeriodStart: PERIOD_START,
      currentPeriodEnd: PERIOD_END,
      currentPhaseFingerprintSha256: "a".repeat(64),
    };
  }

  async function reserve(practiceId: string, requestedBy: string) {
    return withTenant(monitoredDb, practiceId, (tx) =>
      reserveAnnualCadenceOperation(tx, {
        practiceId,
        requestedBy,
        monthlyPriceId: "price_monthly",
        annualPriceId: "price_annual",
      }),
    );
  }

  it("commits every checkpoint around provider calls", async () => {
    const calls: string[] = [];
    const provider: CadenceProvider = {
      async inspectSubscription() {
        assertProviderBoundary();
        calls.push("inspect");
        return authorized();
      },
      async createSchedule() {
        assertProviderBoundary();
        calls.push("create");
        return { scheduleId: "sub_sched_success" };
      },
      async configureSchedule() {
        assertProviderBoundary();
        calls.push("configure");
        return { effectiveAt: PERIOD_END };
      },
    };
    const reservation = await reserve(ids.practiceSuccess, ids.userSuccess);
    const result = await dispatchAnnualCadenceOperation(
      monitoredDb,
      reservation.operationId,
      { monthlyPriceId: "price_monthly", allowedCompanionPriceIds: [] },
      provider,
    );
    expect(result).toMatchObject({
      state: "scheduled",
      effectiveAt: PERIOD_END,
    });
    expect(calls).toEqual(["inspect", "create", "configure"]);

    const reconciliation = await withSystem(rootDb, (tx) =>
      reconcileCadenceOperationFromSignedSubscriptionSnapshot(tx, {
        practiceId: ids.practiceSuccess,
        subscriptionId: "sub_success",
        billingStatus: "active",
        providerScheduleId: "sub_sched_success",
        itemPriceIds: ["price_annual"],
      }),
    );
    expect(reconciliation).toBe("applied");
    const [applied] = await rootDb
      .select()
      .from(subscriptionCadenceOperations)
      .where(eq(subscriptionCadenceOperations.id, reservation.operationId));
    expect(applied).toMatchObject({
      state: "applied",
      providerScheduleId: "sub_sched_success",
      lastErrorCode: null,
    });
    expect(applied?.appliedAt).toBeInstanceOf(Date);

    await expect(
      withTenant(rootDb, ids.practiceSuccess, (tx) =>
        readCadenceOperationStatus(tx, ids.practiceSuccess),
      ),
    ).resolves.toMatchObject({
      operationId: reservation.operationId,
      state: "applied",
    });

    await withSystem(rootDb, (tx) =>
      tx
        .update(practices)
        .set({
          stripeSubscriptionId: "sub_success_replacement",
          subscriptionGeneration: 2,
        })
        .where(eq(practices.id, ids.practiceSuccess)),
    );
    await expect(
      withTenant(rootDb, ids.practiceSuccess, (tx) =>
        readCadenceOperationStatus(tx, ids.practiceSuccess),
      ),
    ).resolves.toEqual({
      operationId: null,
      state: "none",
      requestedCadence: null,
      effectiveAt: null,
      errorCode: null,
    });
  });

  it("replays one stable create key after a provider-accepted crash", async () => {
    const createKeys: string[] = [];
    let firstCreate = true;
    const provider: CadenceProvider = {
      async inspectSubscription() {
        assertProviderBoundary();
        return authorized();
      },
      async createSchedule(input) {
        assertProviderBoundary();
        createKeys.push(input.idempotencyKey);
        if (firstCreate) {
          firstCreate = false;
          throw new Error("synthetic connection loss after provider accept");
        }
        return { scheduleId: "sub_sched_crash_replay" };
      },
      async configureSchedule() {
        assertProviderBoundary();
        return { effectiveAt: PERIOD_END };
      },
    };
    const reservation = await reserve(ids.practiceCrash, ids.userCrash);
    const first = await dispatchAnnualCadenceOperation(
      monitoredDb,
      reservation.operationId,
      { monthlyPriceId: "price_monthly", allowedCompanionPriceIds: [] },
      provider,
    );
    expect(first).toMatchObject({
      state: "processing",
      errorCode: "provider_outcome_unknown",
    });
    const recovery = await runDurableCadenceOperationRecoveryBatch(
      monitoredDb,
      { monthlyPriceId: "price_monthly", allowedCompanionPriceIds: [] },
      provider,
    );
    expect(recovery).toMatchObject({
      candidates: 1,
      scheduled: 1,
      deferred: 0,
      failed: 0,
    });
    expect(createKeys).toHaveLength(2);
    expect(new Set(createKeys).size).toBe(1);
    const [stored] = await rootDb
      .select()
      .from(subscriptionCadenceOperations)
      .where(eq(subscriptionCadenceOperations.id, reservation.operationId));
    expect(stored).toMatchObject({
      state: "scheduled",
      providerScheduleId: "sub_sched_crash_replay",
      attemptCount: 4,
    });
  });

  it("contains an attached custom schedule before any mutation", async () => {
    let mutationCalls = 0;
    const provider: CadenceProvider = {
      async inspectSubscription() {
        assertProviderBoundary();
        return {
          outcome: "manual_review",
          code: "provider_schedule_attached",
          observedScheduleId: "sub_sched_custom",
        };
      },
      async createSchedule() {
        mutationCalls += 1;
        return { scheduleId: "never" };
      },
      async configureSchedule() {
        mutationCalls += 1;
        return { effectiveAt: PERIOD_END };
      },
    };
    const reservation = await reserve(ids.practiceCustom, ids.userCustom);
    const result = await dispatchAnnualCadenceOperation(
      monitoredDb,
      reservation.operationId,
      { monthlyPriceId: "price_monthly", allowedCompanionPriceIds: [] },
      provider,
    );
    expect(result).toMatchObject({
      state: "manual_review",
      errorCode: "provider_schedule_attached",
    });
    expect(mutationCalls).toBe(0);
    const [manual] = await rootDb
      .select()
      .from(subscriptionCadenceOperations)
      .where(eq(subscriptionCadenceOperations.id, reservation.operationId));
    await expect(
      runDurableCadenceOperationRecoveryBatch(
        monitoredDb,
        { monthlyPriceId: "price_monthly", allowedCompanionPriceIds: [] },
        provider,
      ),
    ).resolves.toMatchObject({
      candidates: 0,
      manualReview: 1,
      deferred: 0,
      failed: 0,
    });
    expect(mutationCalls).toBe(0);
    const superseded = await withSystem(rootDb, (tx) =>
      supersedeManualCadenceOperation(tx, {
        operationId: reservation.operationId,
        expectedRevision: manual!.revision,
        reason: "provider_corrected",
        providerScheduleReviewed: true,
        subscriptionReviewed: true,
        quantityReviewed: true,
      }),
    );
    expect(superseded).toMatchObject({ state: "superseded" });
    const [audit] = await rootDb
      .select({ action: auditLog.action, changes: auditLog.changes })
      .from(auditLog)
      .where(eq(auditLog.entityId, reservation.operationId));
    expect(audit).toMatchObject({
      action: "supersede",
      changes: expect.objectContaining({
        source: "owner_cadence_recovery_cli",
        providerScheduleReviewed: true,
      }),
    });
  });
});
