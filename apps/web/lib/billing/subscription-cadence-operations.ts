import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  auditLog,
  locations,
  practices,
  subscriptionCadenceOperations,
  users,
} from "@openpims/db";
import type { Database } from "@openpims/db/client";
import { rowsFromExecute } from "@/lib/db/execute-rows";
import { withSystem } from "@/lib/tenant-db";
import {
  CadenceProviderError,
  stripeCadenceProvider,
  type CadenceProvider,
  type CadenceProviderInspection,
} from "./subscription-cadence-provider";
import { cloudCheckoutPriceIds, cloudMeteredPriceIds } from "./plans";

const PROVIDER_LEASE_MS = 2 * 60 * 1000;
const PROVIDER_IDEMPOTENCY_WINDOW_MS = 23 * 60 * 60 * 1000;
const MAX_INSPECTION_ATTEMPTS = 3;

const ACTIVE_STATES = [
  "reserved",
  "inspecting",
  "authorized",
  "creating_schedule",
  "schedule_created",
  "configuring_schedule",
  "outcome_unknown",
  "scheduled",
  "manual_review",
] as const;

type OperationRow = typeof subscriptionCadenceOperations.$inferSelect;

export type CadenceOperationPublicState =
  | "none"
  | "processing"
  | "scheduled"
  | "applied"
  | "failed"
  | "manual_review"
  | "superseded";

export type CadenceOperationStatus = {
  operationId: string | null;
  state: CadenceOperationPublicState;
  requestedCadence: "year" | null;
  effectiveAt: Date | string | null;
  errorCode: string | null;
};

export type SignedCadenceReconciliationOutcome =
  | "none"
  | "unchanged"
  | "applied"
  | "manual_review"
  | "superseded";

export const CADENCE_SUPERSEDE_REASONS = [
  "provider_corrected",
  "request_abandoned",
  "subscription_replaced",
] as const;

export type CadenceSupersedeReason = (typeof CADENCE_SUPERSEDE_REASONS)[number];

export class CadenceOperationError extends Error {
  constructor(
    public readonly code:
      | "billing_not_configured"
      | "subscription_ineligible"
      | "subscription_identity_missing"
      | "already_annual"
      | "operation_conflict"
      | "recovery_hold"
      | "quantity_sync_pending",
    message: string,
  ) {
    super(message);
    this.name = "CadenceOperationError";
  }
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function publicState(
  state: OperationRow["state"],
): CadenceOperationPublicState {
  switch (state) {
    case "scheduled":
      return "scheduled";
    case "applied":
      return "applied";
    case "failed":
      return "failed";
    case "manual_review":
      return "manual_review";
    case "superseded":
      return "superseded";
    default:
      return "processing";
  }
}

export async function readCadenceOperationStatus(
  tx: Database,
  practiceId: string,
): Promise<CadenceOperationStatus> {
  const [operation] = await tx
    .select({
      id: subscriptionCadenceOperations.id,
      state: subscriptionCadenceOperations.state,
      effectiveAt: subscriptionCadenceOperations.effectiveAt,
      lastErrorCode: subscriptionCadenceOperations.lastErrorCode,
    })
    .from(subscriptionCadenceOperations)
    .innerJoin(
      practices,
      and(
        eq(practices.id, subscriptionCadenceOperations.practiceId),
        eq(
          practices.stripeSubscriptionId,
          subscriptionCadenceOperations.stripeSubscriptionId,
        ),
        eq(
          practices.stripeCustomerId,
          subscriptionCadenceOperations.stripeCustomerId,
        ),
        eq(
          practices.subscriptionGeneration,
          subscriptionCadenceOperations.subscriptionGeneration,
        ),
        isNull(practices.deletedAt),
      ),
    )
    .where(eq(subscriptionCadenceOperations.practiceId, practiceId))
    .orderBy(
      sql`${subscriptionCadenceOperations.createdAt} desc`,
      sql`${subscriptionCadenceOperations.id} desc`,
    )
    .limit(1);
  if (!operation) {
    return {
      operationId: null,
      state: "none",
      requestedCadence: null,
      effectiveAt: null,
      errorCode: null,
    };
  }
  return {
    operationId: operation.id,
    state: publicState(operation.state),
    requestedCadence: "year",
    effectiveAt: operation.effectiveAt,
    errorCode: operation.lastErrorCode,
  };
}

type BillingSyncSettings = {
  billingSync?: { billingCadence?: "month" | "year" };
};

export async function reserveAnnualCadenceOperation(
  tx: Database,
  input: {
    practiceId: string;
    requestedBy: string;
    monthlyPriceId: string;
    annualPriceId: string;
  },
): Promise<{ operationId: string; reused: boolean }> {
  if (!input.monthlyPriceId || !input.annualPriceId) {
    throw new CadenceOperationError(
      "billing_not_configured",
      "Monthly and annual hosted billing prices must both be configured.",
    );
  }
  const [practice] = await tx
    .select({
      customerId: practices.stripeCustomerId,
      subscriptionId: practices.stripeSubscriptionId,
      subscriptionGeneration: practices.subscriptionGeneration,
      subscriptionSyncRevision: practices.stripeSubscriptionSyncRevision,
      billingStatus: practices.billingStatus,
      recoveryHold: practices.recoveryHold,
      quantityLeaseToken: practices.stripeQuantitySyncLeaseToken,
      settings: practices.settings,
    })
    .from(practices)
    .where(and(eq(practices.id, input.practiceId), isNull(practices.deletedAt)))
    .limit(1)
    .for("update", { of: practices });
  if (!practice?.customerId || !practice.subscriptionId) {
    throw new CadenceOperationError(
      "subscription_identity_missing",
      "A connected hosted subscription is required.",
    );
  }
  if (practice.recoveryHold) {
    throw new CadenceOperationError(
      "recovery_hold",
      "Billing changes are paused during protected recovery.",
    );
  }
  if (
    practice.billingStatus !== "active" &&
    practice.billingStatus !== "trialing"
  ) {
    throw new CadenceOperationError(
      "subscription_ineligible",
      "Resolve the subscription status before scheduling a cadence change.",
    );
  }
  if (practice.quantityLeaseToken) {
    throw new CadenceOperationError(
      "quantity_sync_pending",
      "Wait for subscription quantity reconciliation to finish.",
    );
  }
  const billingCadence = (practice.settings as BillingSyncSettings | null)
    ?.billingSync?.billingCadence;
  if (billingCadence === "year") {
    throw new CadenceOperationError(
      "already_annual",
      "This clinic is already billed annually.",
    );
  }

  const active = await tx
    .select()
    .from(subscriptionCadenceOperations)
    .where(
      and(
        eq(subscriptionCadenceOperations.practiceId, input.practiceId),
        inArray(subscriptionCadenceOperations.state, [...ACTIVE_STATES]),
      ),
    )
    .orderBy(subscriptionCadenceOperations.createdAt)
    .limit(1)
    .for("update", { of: subscriptionCadenceOperations });
  const existing = active[0];
  if (existing) {
    if (
      existing.stripeCustomerId === practice.customerId &&
      existing.stripeSubscriptionId === practice.subscriptionId &&
      existing.subscriptionGeneration === practice.subscriptionGeneration &&
      existing.targetLocationPriceId === input.annualPriceId
    ) {
      return { operationId: existing.id, reused: true };
    }
    throw new CadenceOperationError(
      "operation_conflict",
      "Another subscription cadence operation requires resolution first.",
    );
  }

  const [locationCountRow] = await tx
    .select({ count: sql<number>`greatest(count(*)::int, 1)` })
    .from(locations)
    .where(
      and(
        eq(locations.practiceId, input.practiceId),
        isNull(locations.deletedAt),
      ),
    );
  const locationQuantity = Number(locationCountRow?.count ?? 1);
  const operationId = randomUUID();
  const canonical = {
    operationId,
    practiceId: input.practiceId,
    requestedBy: input.requestedBy,
    fromCadence: "month",
    targetCadence: "year",
    customerId: practice.customerId,
    subscriptionId: practice.subscriptionId,
    subscriptionGeneration: practice.subscriptionGeneration,
    subscriptionSyncRevision: practice.subscriptionSyncRevision,
    monthlyPriceId: input.monthlyPriceId,
    annualPriceId: input.annualPriceId,
    locationQuantity,
  };
  await tx.insert(subscriptionCadenceOperations).values({
    id: operationId,
    practiceId: input.practiceId,
    requestedBy: input.requestedBy,
    fromCadence: "month",
    targetCadence: "year",
    stripeCustomerId: practice.customerId,
    stripeSubscriptionId: practice.subscriptionId,
    subscriptionGeneration: practice.subscriptionGeneration,
    subscriptionSyncRevision: practice.subscriptionSyncRevision,
    targetLocationPriceId: input.annualPriceId,
    requestedLocationQuantity: locationQuantity,
    requestFingerprintSha256: fingerprint(canonical),
    scheduleCreateIdempotencyKey: `openvpm:cadence:${operationId}:create`,
    scheduleConfigureIdempotencyKey: `openvpm:cadence:${operationId}:configure`,
  });
  return { operationId, reused: false };
}

type Claim =
  | { kind: "pending"; operation: OperationRow }
  | { kind: "terminal"; operation: OperationRow }
  | { kind: "inspect"; operation: OperationRow; leaseToken: string }
  | { kind: "create"; operation: OperationRow; leaseToken: string }
  | { kind: "configure"; operation: OperationRow; leaseToken: string };

function retryWindowElapsed(operation: OperationRow, now: Date): boolean {
  return Boolean(
    operation.firstProviderAttemptAt &&
    now.getTime() - operation.firstProviderAttemptAt.getTime() >=
      PROVIDER_IDEMPOTENCY_WINDOW_MS,
  );
}

async function claimNext(
  rootDb: Database,
  operationId: string,
): Promise<Claim> {
  return withSystem(rootDb, async (tx) => {
    const result = await tx.execute<{ databaseNow: Date | string }>(sql`
      select clock_timestamp() as "databaseNow"
    `);
    const now = new Date(
      rowsFromExecute<{ databaseNow: Date | string }>(result)[0]!.databaseNow,
    );
    const [operation] = await tx
      .select()
      .from(subscriptionCadenceOperations)
      .where(eq(subscriptionCadenceOperations.id, operationId))
      .limit(1)
      .for("update", { of: subscriptionCadenceOperations });
    if (!operation) throw new Error("Subscription cadence operation missing.");
    if (
      operation.state === "scheduled" ||
      operation.state === "applied" ||
      operation.state === "failed" ||
      operation.state === "manual_review" ||
      operation.state === "superseded"
    ) {
      return {
        kind:
          operation.state === "scheduled" || operation.state === "manual_review"
            ? "pending"
            : "terminal",
        operation,
      };
    }
    if (
      (operation.state === "inspecting" ||
        operation.state === "creating_schedule" ||
        operation.state === "configuring_schedule") &&
      operation.leaseExpiresAt &&
      operation.leaseExpiresAt > now
    ) {
      return { kind: "pending", operation };
    }

    const [practice] = await tx
      .select({
        customerId: practices.stripeCustomerId,
        subscriptionId: practices.stripeSubscriptionId,
        subscriptionGeneration: practices.subscriptionGeneration,
        subscriptionSyncRevision: practices.stripeSubscriptionSyncRevision,
        billingStatus: practices.billingStatus,
        recoveryHold: practices.recoveryHold,
        quantityLeaseToken: practices.stripeQuantitySyncLeaseToken,
      })
      .from(practices)
      .where(
        and(
          eq(practices.id, operation.practiceId),
          isNull(practices.deletedAt),
        ),
      )
      .limit(1)
      .for("update", { of: practices });
    const [requester] = await tx
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.id, operation.requestedBy),
          eq(users.practiceId, operation.practiceId),
          eq(users.role, "admin"),
          isNull(users.deletedAt),
        ),
      )
      .limit(1);
    const [locationCountRow] = await tx
      .select({ count: sql<number>`greatest(count(*)::int, 1)` })
      .from(locations)
      .where(
        and(
          eq(locations.practiceId, operation.practiceId),
          isNull(locations.deletedAt),
        ),
      );
    const stale =
      !practice ||
      !requester ||
      practice.recoveryHold ||
      (practice.billingStatus !== "active" &&
        practice.billingStatus !== "trialing") ||
      practice.customerId !== operation.stripeCustomerId ||
      practice.subscriptionId !== operation.stripeSubscriptionId ||
      practice.subscriptionGeneration !== operation.subscriptionGeneration ||
      practice.subscriptionSyncRevision !==
        operation.subscriptionSyncRevision ||
      practice.quantityLeaseToken !== null ||
      Number(locationCountRow?.count ?? 1) !==
        operation.requestedLocationQuantity;
    if (stale) {
      const [superseded] = await tx
        .update(subscriptionCadenceOperations)
        .set({
          state: "superseded",
          revision: operation.revision + 1,
          updatedAt: sql`clock_timestamp()`,
          leaseToken: null,
          leaseExpiresAt: null,
          supersededAt: sql`clock_timestamp()`,
          lastErrorCode: "local_identity_superseded",
        })
        .where(
          and(
            eq(subscriptionCadenceOperations.id, operation.id),
            eq(subscriptionCadenceOperations.revision, operation.revision),
          ),
        )
        .returning();
      if (!superseded) throw new Error("Cadence supersession CAS was lost.");
      return { kind: "terminal", operation: superseded };
    }
    if (
      (operation.state === "creating_schedule" ||
        operation.state === "configuring_schedule" ||
        operation.state === "outcome_unknown") &&
      retryWindowElapsed(operation, now)
    ) {
      const [manual] = await tx
        .update(subscriptionCadenceOperations)
        .set({
          state: "manual_review",
          revision: operation.revision + 1,
          updatedAt: sql`clock_timestamp()`,
          leaseToken: null,
          leaseExpiresAt: null,
          manualReviewAt: sql`clock_timestamp()`,
          lastErrorCode: "idempotency_window_elapsed",
        })
        .where(
          and(
            eq(subscriptionCadenceOperations.id, operation.id),
            eq(subscriptionCadenceOperations.revision, operation.revision),
          ),
        )
        .returning();
      if (!manual) throw new Error("Cadence manual-review CAS was lost.");
      return { kind: "pending", operation: manual };
    }

    const kind: "inspect" | "create" | "configure" =
      operation.state === "reserved" || operation.state === "inspecting"
        ? "inspect"
        : operation.state === "authorized" ||
            operation.state === "creating_schedule" ||
            (operation.state === "outcome_unknown" &&
              !operation.providerScheduleId)
          ? "create"
          : "configure";
    const nextState =
      kind === "inspect"
        ? "inspecting"
        : kind === "create"
          ? "creating_schedule"
          : "configuring_schedule";
    const leaseToken = randomUUID();
    const [claimed] = await tx
      .update(subscriptionCadenceOperations)
      .set({
        state: nextState,
        revision: operation.revision + 1,
        updatedAt: sql`clock_timestamp()`,
        attemptCount: operation.attemptCount + 1,
        firstProviderAttemptAt: operation.firstProviderAttemptAt ?? now,
        lastProviderAttemptAt: now,
        leaseToken,
        leaseExpiresAt: new Date(now.getTime() + PROVIDER_LEASE_MS),
        lastErrorCode: null,
      })
      .where(
        and(
          eq(subscriptionCadenceOperations.id, operation.id),
          eq(subscriptionCadenceOperations.revision, operation.revision),
        ),
      )
      .returning();
    if (!claimed) throw new Error("Cadence provider claim CAS was lost.");
    return { kind, operation: claimed, leaseToken };
  });
}

async function persistInspection(
  rootDb: Database,
  claim: Extract<Claim, { kind: "inspect" }>,
  inspection: CadenceProviderInspection,
): Promise<void> {
  await withSystem(rootDb, async (tx) => {
    const values =
      inspection.outcome === "manual_review"
        ? {
            state: "manual_review" as const,
            manualReviewAt: sql`clock_timestamp()`,
            lastErrorCode: inspection.code,
            observedProviderScheduleId: inspection.observedScheduleId ?? null,
          }
        : {
            state: "authorized" as const,
            authorizedAt: sql`clock_timestamp()`,
            providerSnapshotFingerprintSha256:
              inspection.currentPhaseFingerprintSha256,
            currentLocationItemId: inspection.currentLocationItemId,
            currentLocationPriceId: inspection.currentLocationPriceId,
            currentLocationQuantity: inspection.currentLocationQuantity,
            currentPeriodStart: inspection.currentPeriodStart,
            currentPeriodEnd: inspection.currentPeriodEnd,
            lastErrorCode: null,
          };
    const [updated] = await tx
      .update(subscriptionCadenceOperations)
      .set({
        ...values,
        revision: claim.operation.revision + 1,
        updatedAt: sql`clock_timestamp()`,
        leaseToken: null,
        leaseExpiresAt: null,
      })
      .where(
        and(
          eq(subscriptionCadenceOperations.id, claim.operation.id),
          eq(subscriptionCadenceOperations.state, "inspecting"),
          eq(subscriptionCadenceOperations.revision, claim.operation.revision),
          eq(subscriptionCadenceOperations.leaseToken, claim.leaseToken),
        ),
      )
      .returning({ id: subscriptionCadenceOperations.id });
    if (!updated)
      throw new Error("Cadence inspection persistence CAS was lost.");
  });
}

async function deferInspection(
  rootDb: Database,
  claim: Extract<Claim, { kind: "inspect" }>,
  terminalCode?: string,
): Promise<void> {
  await withSystem(rootDb, async (tx) => {
    const manual =
      claim.operation.attemptCount >= MAX_INSPECTION_ATTEMPTS || terminalCode;
    const [updated] = await tx
      .update(subscriptionCadenceOperations)
      .set({
        state: manual ? "manual_review" : "inspecting",
        revision: claim.operation.revision + 1,
        updatedAt: sql`clock_timestamp()`,
        ...(manual
          ? {
              leaseToken: null,
              leaseExpiresAt: null,
              manualReviewAt: sql`clock_timestamp()`,
              lastErrorCode: terminalCode ?? "provider_inspection_failed",
            }
          : { leaseExpiresAt: sql`clock_timestamp()` }),
      })
      .where(
        and(
          eq(subscriptionCadenceOperations.id, claim.operation.id),
          eq(subscriptionCadenceOperations.state, "inspecting"),
          eq(subscriptionCadenceOperations.revision, claim.operation.revision),
          eq(subscriptionCadenceOperations.leaseToken, claim.leaseToken),
        ),
      )
      .returning({ id: subscriptionCadenceOperations.id });
    if (!updated) throw new Error("Cadence inspection retry CAS was lost.");
  });
}

async function persistScheduleCreated(
  rootDb: Database,
  claim: Extract<Claim, { kind: "create" }>,
  scheduleId: string,
): Promise<void> {
  await withSystem(rootDb, async (tx) => {
    const [updated] = await tx
      .update(subscriptionCadenceOperations)
      .set({
        state: "schedule_created",
        revision: claim.operation.revision + 1,
        updatedAt: sql`clock_timestamp()`,
        leaseToken: null,
        leaseExpiresAt: null,
        providerScheduleId: scheduleId,
        scheduleCreatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(subscriptionCadenceOperations.id, claim.operation.id),
          eq(subscriptionCadenceOperations.state, "creating_schedule"),
          eq(subscriptionCadenceOperations.revision, claim.operation.revision),
          eq(subscriptionCadenceOperations.leaseToken, claim.leaseToken),
        ),
      )
      .returning({ id: subscriptionCadenceOperations.id });
    if (!updated) throw new Error("Cadence schedule identity CAS was lost.");
  });
}

async function persistScheduled(
  rootDb: Database,
  claim: Extract<Claim, { kind: "configure" }>,
  effectiveAt: Date,
): Promise<void> {
  if (
    !claim.operation.currentPeriodEnd ||
    effectiveAt.getTime() !== claim.operation.currentPeriodEnd.getTime()
  ) {
    throw new Error("Cadence effective date differs from authorized renewal.");
  }
  await withSystem(rootDb, async (tx) => {
    const [updated] = await tx
      .update(subscriptionCadenceOperations)
      .set({
        state: "scheduled",
        revision: claim.operation.revision + 1,
        updatedAt: sql`clock_timestamp()`,
        leaseToken: null,
        leaseExpiresAt: null,
        effectiveAt,
        scheduledAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(subscriptionCadenceOperations.id, claim.operation.id),
          eq(subscriptionCadenceOperations.state, "configuring_schedule"),
          eq(subscriptionCadenceOperations.revision, claim.operation.revision),
          eq(subscriptionCadenceOperations.leaseToken, claim.leaseToken),
        ),
      )
      .returning({ id: subscriptionCadenceOperations.id });
    if (!updated)
      throw new Error("Cadence scheduled persistence CAS was lost.");
  });
}

async function persistProviderUncertainty(
  rootDb: Database,
  claim: Extract<Claim, { kind: "create" | "configure" }>,
  manualCode?: string,
): Promise<void> {
  await withSystem(rootDb, async (tx) => {
    const [updated] = await tx
      .update(subscriptionCadenceOperations)
      .set({
        state: manualCode ? "manual_review" : "outcome_unknown",
        revision: claim.operation.revision + 1,
        updatedAt: sql`clock_timestamp()`,
        leaseToken: null,
        leaseExpiresAt: null,
        ...(manualCode
          ? {
              manualReviewAt: sql`clock_timestamp()`,
              lastErrorCode: manualCode,
            }
          : { lastErrorCode: "provider_outcome_unknown" }),
      })
      .where(
        and(
          eq(subscriptionCadenceOperations.id, claim.operation.id),
          eq(subscriptionCadenceOperations.state, claim.operation.state),
          eq(subscriptionCadenceOperations.revision, claim.operation.revision),
          eq(subscriptionCadenceOperations.leaseToken, claim.leaseToken),
        ),
      )
      .returning({ id: subscriptionCadenceOperations.id });
    if (!updated)
      throw new Error("Cadence uncertainty persistence CAS was lost.");
  });
}

export async function dispatchAnnualCadenceOperation(
  rootDb: Database,
  operationId: string,
  prices: {
    monthlyPriceId: string;
    allowedCompanionPriceIds: readonly string[];
  },
  provider: CadenceProvider = stripeCadenceProvider,
): Promise<CadenceOperationStatus> {
  for (let step = 0; step < 6; step += 1) {
    const claim = await claimNext(rootDb, operationId);
    if (claim.kind === "pending" || claim.kind === "terminal") {
      return {
        operationId: claim.operation.id,
        state: publicState(claim.operation.state),
        requestedCadence: "year",
        effectiveAt: claim.operation.effectiveAt,
        errorCode: claim.operation.lastErrorCode,
      };
    }
    if (claim.kind === "inspect") {
      try {
        const inspection = await provider.inspectSubscription({
          operationId: claim.operation.id,
          practiceId: claim.operation.practiceId,
          customerId: claim.operation.stripeCustomerId,
          subscriptionId: claim.operation.stripeSubscriptionId,
          monthlyPriceId: prices.monthlyPriceId,
          annualPriceId: claim.operation.targetLocationPriceId,
          allowedCompanionPriceIds: prices.allowedCompanionPriceIds,
          locationQuantity: claim.operation.requestedLocationQuantity,
        });
        await persistInspection(rootDb, claim, inspection);
      } catch (error) {
        await deferInspection(
          rootDb,
          claim,
          error instanceof CadenceProviderError &&
            error.code === "provider_unconfigured"
            ? error.code
            : undefined,
        );
        return {
          operationId,
          state:
            error instanceof CadenceProviderError &&
            error.code === "provider_unconfigured"
              ? "manual_review"
              : "processing",
          requestedCadence: "year",
          effectiveAt: null,
          errorCode:
            error instanceof CadenceProviderError &&
            error.code === "provider_unconfigured"
              ? error.code
              : null,
        };
      }
      continue;
    }
    if (claim.kind === "create") {
      try {
        const created = await provider.createSchedule({
          operationId: claim.operation.id,
          practiceId: claim.operation.practiceId,
          customerId: claim.operation.stripeCustomerId,
          subscriptionId: claim.operation.stripeSubscriptionId,
          idempotencyKey: claim.operation.scheduleCreateIdempotencyKey,
        });
        await persistScheduleCreated(rootDb, claim, created.scheduleId);
      } catch (error) {
        await persistProviderUncertainty(
          rootDb,
          claim,
          error instanceof CadenceProviderError &&
            error.code === "provider_unconfigured"
            ? error.code
            : undefined,
        );
        return {
          operationId,
          state:
            error instanceof CadenceProviderError &&
            error.code === "provider_unconfigured"
              ? "manual_review"
              : "processing",
          requestedCadence: "year",
          effectiveAt: null,
          errorCode:
            error instanceof CadenceProviderError &&
            error.code === "provider_unconfigured"
              ? error.code
              : "provider_outcome_unknown",
        };
      }
      continue;
    }

    try {
      if (
        !claim.operation.providerScheduleId ||
        !claim.operation.currentLocationPriceId ||
        !claim.operation.currentPeriodStart ||
        !claim.operation.currentPeriodEnd
      ) {
        throw new CadenceProviderError(
          "provider_schedule_mismatch",
          "Committed schedule authorization evidence is incomplete.",
        );
      }
      const configured = await provider.configureSchedule({
        operationId: claim.operation.id,
        practiceId: claim.operation.practiceId,
        customerId: claim.operation.stripeCustomerId,
        subscriptionId: claim.operation.stripeSubscriptionId,
        scheduleId: claim.operation.providerScheduleId,
        monthlyPriceId: claim.operation.currentLocationPriceId,
        annualPriceId: claim.operation.targetLocationPriceId,
        locationQuantity: claim.operation.requestedLocationQuantity,
        currentPeriodStart: claim.operation.currentPeriodStart,
        currentPeriodEnd: claim.operation.currentPeriodEnd,
        providerSnapshotFingerprintSha256:
          claim.operation.providerSnapshotFingerprintSha256!,
        idempotencyKey: claim.operation.scheduleConfigureIdempotencyKey,
      });
      await persistScheduled(rootDb, claim, configured.effectiveAt);
    } catch (error) {
      const manualCode =
        error instanceof CadenceProviderError &&
        (error.code === "provider_unconfigured" ||
          error.code === "provider_schedule_mismatch" ||
          error.code === "provider_schedule_custom")
          ? error.code
          : undefined;
      await persistProviderUncertainty(rootDb, claim, manualCode);
      return {
        operationId,
        state: manualCode ? "manual_review" : "processing",
        requestedCadence: "year",
        effectiveAt: null,
        errorCode: manualCode ?? "provider_outcome_unknown",
      };
    }
  }
  throw new Error("Subscription cadence dispatch exceeded bounded stages.");
}

export type CadenceRecoveryBatchResult = {
  candidates: number;
  scheduled: number;
  manualReview: number;
  deferred: number;
  failed: number;
};

/**
 * Bounded retry driver for durable pre-schedule states. Provider mutations
 * still happen only inside dispatchAnnualCadenceOperation, after its short DB
 * claim transaction commits and under the same stable idempotency keys.
 */
export async function runDurableCadenceOperationRecoveryBatch(
  rootDb: Database,
  prices?: {
    monthlyPriceId: string;
    allowedCompanionPriceIds: readonly string[];
  },
  provider: CadenceProvider = stripeCadenceProvider,
  limit = 10,
): Promise<CadenceRecoveryBatchResult> {
  const configuredPrices =
    prices ??
    (() => {
      const monthlyPriceId = cloudCheckoutPriceIds("month").locationPriceId;
      if (!monthlyPriceId) {
        throw new Error(
          "Monthly hosted billing price is unavailable for cadence recovery.",
        );
      }
      const { aiOveragePriceId, smsOveragePriceId } = cloudMeteredPriceIds();
      return {
        monthlyPriceId,
        allowedCompanionPriceIds: [aiOveragePriceId, smsOveragePriceId].filter(
          (priceId): priceId is string => Boolean(priceId),
        ),
      };
    })();
  const { candidates, outstandingManualReview } = await withSystem(
    rootDb,
    async (tx) => {
      const [manualReviewRow] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(subscriptionCadenceOperations)
        .where(eq(subscriptionCadenceOperations.state, "manual_review"));
      const candidates = await tx
        .select({ id: subscriptionCadenceOperations.id })
        .from(subscriptionCadenceOperations)
        .where(
          or(
            inArray(subscriptionCadenceOperations.state, [
              "reserved",
              "authorized",
              "schedule_created",
              "outcome_unknown",
            ]),
            and(
              inArray(subscriptionCadenceOperations.state, [
                "inspecting",
                "creating_schedule",
                "configuring_schedule",
              ]),
              lte(
                subscriptionCadenceOperations.leaseExpiresAt,
                sql`clock_timestamp()`,
              ),
            ),
          ),
        )
        .orderBy(
          subscriptionCadenceOperations.createdAt,
          subscriptionCadenceOperations.id,
        )
        .limit(Math.max(1, Math.min(limit, 25)));
      return {
        candidates,
        outstandingManualReview: Number(manualReviewRow?.count ?? 0),
      };
    },
  );

  const result: CadenceRecoveryBatchResult = {
    candidates: candidates.length,
    scheduled: 0,
    manualReview: outstandingManualReview,
    deferred: 0,
    failed: 0,
  };
  for (const candidate of candidates) {
    try {
      const outcome = await dispatchAnnualCadenceOperation(
        rootDb,
        candidate.id,
        configuredPrices,
        provider,
      );
      if (outcome.state === "scheduled") result.scheduled += 1;
      else if (outcome.state === "manual_review") result.manualReview += 1;
      else if (outcome.state === "processing") result.deferred += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}

/**
 * Owner-only local release after independent provider review. This never
 * changes Stripe. A provider schedule that remains attached will be detected
 * and contained again before any later cadence mutation.
 */
export async function supersedeManualCadenceOperation(
  tx: Database,
  input: {
    operationId: string;
    expectedRevision: number;
    reason: CadenceSupersedeReason;
    providerScheduleReviewed: true;
    subscriptionReviewed: true;
    quantityReviewed: true;
  },
): Promise<{
  id: string;
  practiceId: string;
  state: "superseded";
  revision: number;
}> {
  if (
    input.providerScheduleReviewed !== true ||
    input.subscriptionReviewed !== true ||
    input.quantityReviewed !== true
  ) {
    throw new Error("Cadence supersede requires every recovery attestation.");
  }
  const [operation] = await tx
    .select()
    .from(subscriptionCadenceOperations)
    .where(eq(subscriptionCadenceOperations.id, input.operationId))
    .limit(1)
    .for("update", { of: subscriptionCadenceOperations });
  if (!operation) throw new Error("Cadence operation was not found.");
  if (operation.state !== "manual_review") {
    throw new Error(
      "Only a manual-review cadence operation can be superseded.",
    );
  }
  if (operation.revision !== input.expectedRevision) {
    throw new Error(
      `Cadence revision changed; inspect again (current ${operation.revision}).`,
    );
  }
  const [updated] = await tx
    .update(subscriptionCadenceOperations)
    .set({
      state: "superseded",
      revision: operation.revision + 1,
      updatedAt: sql`clock_timestamp()`,
      supersededAt: sql`clock_timestamp()`,
      manualReviewAt: null,
      lastErrorCode: `operator_superseded:${input.reason}`,
    })
    .where(
      and(
        eq(subscriptionCadenceOperations.id, operation.id),
        eq(subscriptionCadenceOperations.state, "manual_review"),
        eq(subscriptionCadenceOperations.revision, operation.revision),
      ),
    )
    .returning({
      id: subscriptionCadenceOperations.id,
      practiceId: subscriptionCadenceOperations.practiceId,
      state: subscriptionCadenceOperations.state,
      revision: subscriptionCadenceOperations.revision,
    });
  if (!updated || updated.state !== "superseded") {
    throw new Error("Cadence supersede CAS was lost.");
  }
  await tx.insert(auditLog).values({
    practiceId: operation.practiceId,
    userId: null,
    action: "supersede",
    entityType: "subscription_cadence_operation",
    entityId: operation.id,
    changes: {
      source: "owner_cadence_recovery_cli",
      reason: input.reason,
      previousState: operation.state,
      previousRevision: operation.revision,
      providerScheduleReviewed: true,
      subscriptionReviewed: true,
      quantityReviewed: true,
    },
  });
  return updated as {
    id: string;
    practiceId: string;
    state: "superseded";
    revision: number;
  };
}

/**
 * Contain a schedule-aware quantity-sync conflict without rewriting provider
 * evidence. The quantity worker still owns and can clear its practice lease.
 */
export async function markCadenceScheduleQuantityConflict(
  rootDb: Database,
  input: { practiceId: string; scheduleId: string },
): Promise<boolean> {
  return withSystem(rootDb, async (tx) => {
    const [operation] = await tx
      .select()
      .from(subscriptionCadenceOperations)
      .where(
        and(
          eq(subscriptionCadenceOperations.practiceId, input.practiceId),
          eq(
            subscriptionCadenceOperations.providerScheduleId,
            input.scheduleId,
          ),
          eq(subscriptionCadenceOperations.state, "scheduled"),
        ),
      )
      .limit(1)
      .for("update", { of: subscriptionCadenceOperations });
    if (!operation) return false;
    const [updated] = await tx
      .update(subscriptionCadenceOperations)
      .set({
        state: "manual_review",
        revision: operation.revision + 1,
        updatedAt: sql`clock_timestamp()`,
        manualReviewAt: sql`clock_timestamp()`,
        lastErrorCode: "schedule_quantity_conflict",
      })
      .where(
        and(
          eq(subscriptionCadenceOperations.id, operation.id),
          eq(subscriptionCadenceOperations.revision, operation.revision),
          eq(subscriptionCadenceOperations.state, "scheduled"),
        ),
      )
      .returning({ id: subscriptionCadenceOperations.id });
    return Boolean(updated);
  });
}

/**
 * Reconcile a scheduled cadence operation from a subscription snapshot that
 * has already passed the dedicated Stripe webhook signature and identity
 * authorization boundary. This function never calls Stripe and must run in
 * the same transaction as the authoritative subscription persistence.
 */
export async function reconcileCadenceOperationFromSignedSubscriptionSnapshot(
  tx: Database,
  input: {
    practiceId: string;
    subscriptionId: string;
    billingStatus: string;
    providerScheduleId: string | null;
    itemPriceIds: ReadonlyArray<string | null>;
  },
): Promise<SignedCadenceReconciliationOutcome> {
  const [operation] = await tx
    .select()
    .from(subscriptionCadenceOperations)
    .where(
      and(
        eq(subscriptionCadenceOperations.practiceId, input.practiceId),
        eq(
          subscriptionCadenceOperations.stripeSubscriptionId,
          input.subscriptionId,
        ),
        eq(subscriptionCadenceOperations.state, "scheduled"),
      ),
    )
    .limit(1)
    .for("update", { of: subscriptionCadenceOperations });
  if (!operation) return "none";

  const nowResult = await tx.execute<{ databaseNow: Date | string }>(sql`
    select clock_timestamp() as "databaseNow"
  `);
  const databaseNow = new Date(
    rowsFromExecute<{ databaseNow: Date | string }>(nowResult)[0]!.databaseNow,
  );

  if (input.billingStatus === "canceled") {
    const [superseded] = await tx
      .update(subscriptionCadenceOperations)
      .set({
        state: "superseded",
        revision: operation.revision + 1,
        updatedAt: sql`clock_timestamp()`,
        supersededAt: sql`clock_timestamp()`,
        lastErrorCode: "subscription_canceled",
      })
      .where(
        and(
          eq(subscriptionCadenceOperations.id, operation.id),
          eq(subscriptionCadenceOperations.state, "scheduled"),
          eq(subscriptionCadenceOperations.revision, operation.revision),
        ),
      )
      .returning({ id: subscriptionCadenceOperations.id });
    if (!superseded) {
      throw new Error("Cadence cancellation reconciliation CAS was lost.");
    }
    return "superseded";
  }

  let manualCode: string | null = null;
  if (input.providerScheduleId !== operation.providerScheduleId) {
    manualCode = "provider_schedule_identity_changed";
  }

  const targetPriceCount = input.itemPriceIds.filter(
    (priceId) => priceId === operation.targetLocationPriceId,
  ).length;
  if (!manualCode && targetPriceCount > 1) {
    manualCode = "annual_price_duplicated";
  }
  if (
    !manualCode &&
    targetPriceCount === 1 &&
    input.itemPriceIds.length !== 1
  ) {
    manualCode = "annual_plan_ambiguous";
  }
  if (!manualCode && targetPriceCount === 1) {
    if (!operation.effectiveAt || databaseNow < operation.effectiveAt) {
      manualCode = "annual_price_applied_early";
    } else {
      const [applied] = await tx
        .update(subscriptionCadenceOperations)
        .set({
          state: "applied",
          revision: operation.revision + 1,
          updatedAt: sql`clock_timestamp()`,
          appliedAt: sql`clock_timestamp()`,
          lastErrorCode: null,
        })
        .where(
          and(
            eq(subscriptionCadenceOperations.id, operation.id),
            eq(subscriptionCadenceOperations.state, "scheduled"),
            eq(subscriptionCadenceOperations.revision, operation.revision),
            sql`clock_timestamp() >= ${subscriptionCadenceOperations.effectiveAt}`,
          ),
        )
        .returning({ id: subscriptionCadenceOperations.id });
      if (!applied) {
        throw new Error("Cadence application reconciliation CAS was lost.");
      }
      return "applied";
    }
  }
  if (
    !manualCode &&
    targetPriceCount === 0 &&
    operation.effectiveAt &&
    databaseNow >= operation.effectiveAt
  ) {
    manualCode = "annual_price_missing_at_renewal";
  }
  if (!manualCode) return "unchanged";

  const [manual] = await tx
    .update(subscriptionCadenceOperations)
    .set({
      state: "manual_review",
      revision: operation.revision + 1,
      updatedAt: sql`clock_timestamp()`,
      manualReviewAt: sql`clock_timestamp()`,
      lastErrorCode: manualCode,
    })
    .where(
      and(
        eq(subscriptionCadenceOperations.id, operation.id),
        eq(subscriptionCadenceOperations.state, "scheduled"),
        eq(subscriptionCadenceOperations.revision, operation.revision),
      ),
    )
    .returning({ id: subscriptionCadenceOperations.id });
  if (!manual) {
    throw new Error("Cadence manual-review reconciliation CAS was lost.");
  }
  return "manual_review";
}
