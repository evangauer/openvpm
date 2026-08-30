#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import { subscriptionCadenceOperations } from "@openpims/db";
import type { Database } from "@openpims/db/client";
import { withSystem } from "../lib/tenant-db";
import {
  CADENCE_SUPERSEDE_REASONS,
  supersedeManualCadenceOperation,
  type CadenceSupersedeReason,
} from "../lib/billing/subscription-cadence-operations";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type CadenceRecoveryArgs = {
  command: "inspect" | "supersede";
  operationId: string;
  expectedRevision?: number;
  reason?: CadenceSupersedeReason;
  execute: boolean;
  providerScheduleReviewed: boolean;
  subscriptionReviewed: boolean;
  quantityReviewed: boolean;
  confirmation?: string;
};

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

export function parseCadenceRecoveryArgs(args: string[]): CadenceRecoveryArgs {
  const command = args[0];
  if (command !== "inspect" && command !== "supersede") {
    throw new Error("First argument must be inspect or supersede.");
  }
  const operationId = flagValue(args, "operation-id")?.trim() ?? "";
  if (!UUID_PATTERN.test(operationId)) {
    throw new Error("--operation-id must be a UUID.");
  }
  const execute = args.includes("--execute");
  const revisionText = flagValue(args, "expected-revision")?.trim();
  const expectedRevision = revisionText ? Number(revisionText) : undefined;
  const reasonText = flagValue(args, "reason")?.trim();
  const reason = CADENCE_SUPERSEDE_REASONS.find(
    (value) => value === reasonText,
  );
  const parsed: CadenceRecoveryArgs = {
    command,
    operationId,
    expectedRevision,
    reason,
    execute,
    providerScheduleReviewed: args.includes("--provider-schedule-reviewed"),
    subscriptionReviewed: args.includes("--subscription-reviewed"),
    quantityReviewed: args.includes("--quantity-reviewed"),
    confirmation: flagValue(args, "confirmation")?.trim(),
  };

  if (command === "supersede") {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision! < 0) {
      throw new Error("supersede requires --expected-revision >= 0.");
    }
    if (!reason) {
      throw new Error(
        `supersede requires --reason ${CADENCE_SUPERSEDE_REASONS.join("|")}.`,
      );
    }
    if (
      !parsed.providerScheduleReviewed ||
      !parsed.subscriptionReviewed ||
      !parsed.quantityReviewed
    ) {
      throw new Error(
        "supersede requires --provider-schedule-reviewed, --subscription-reviewed, and --quantity-reviewed.",
      );
    }
    if (execute) {
      const expected = `SUPERSEDE:${operationId}:${expectedRevision}`;
      if (parsed.confirmation !== expected) {
        throw new Error(`--confirmation must exactly equal ${expected}.`);
      }
    }
  }
  return parsed;
}

async function ownerDatabase(): Promise<Database> {
  const ownerUrl = process.env.OWNER_RECOVERY_DATABASE_URL?.trim();
  if (!ownerUrl) {
    throw new Error("OWNER_RECOVERY_DATABASE_URL is required.");
  }
  process.env.DATABASE_URL = ownerUrl;
  const { db } = await import("@openpims/db/client");
  return db;
}

async function inspectOperation(database: Database, operationId: string) {
  return withSystem(database, async (tx) => {
    const [operation] = await tx
      .select({
        id: subscriptionCadenceOperations.id,
        practiceId: subscriptionCadenceOperations.practiceId,
        state: subscriptionCadenceOperations.state,
        revision: subscriptionCadenceOperations.revision,
        stripeCustomerId: subscriptionCadenceOperations.stripeCustomerId,
        stripeSubscriptionId:
          subscriptionCadenceOperations.stripeSubscriptionId,
        providerScheduleId: subscriptionCadenceOperations.providerScheduleId,
        observedProviderScheduleId:
          subscriptionCadenceOperations.observedProviderScheduleId,
        requestedLocationQuantity:
          subscriptionCadenceOperations.requestedLocationQuantity,
        targetLocationPriceId:
          subscriptionCadenceOperations.targetLocationPriceId,
        currentLocationQuantity:
          subscriptionCadenceOperations.currentLocationQuantity,
        currentLocationPriceId:
          subscriptionCadenceOperations.currentLocationPriceId,
        currentPeriodStart: subscriptionCadenceOperations.currentPeriodStart,
        currentPeriodEnd: subscriptionCadenceOperations.currentPeriodEnd,
        effectiveAt: subscriptionCadenceOperations.effectiveAt,
        attemptCount: subscriptionCadenceOperations.attemptCount,
        firstProviderAttemptAt:
          subscriptionCadenceOperations.firstProviderAttemptAt,
        lastProviderAttemptAt:
          subscriptionCadenceOperations.lastProviderAttemptAt,
        scheduleCreatedAt: subscriptionCadenceOperations.scheduleCreatedAt,
        scheduledAt: subscriptionCadenceOperations.scheduledAt,
        manualReviewAt: subscriptionCadenceOperations.manualReviewAt,
        lastErrorCode: subscriptionCadenceOperations.lastErrorCode,
        updatedAt: subscriptionCadenceOperations.updatedAt,
      })
      .from(subscriptionCadenceOperations)
      .where(eq(subscriptionCadenceOperations.id, operationId))
      .limit(1);
    if (!operation) throw new Error("Cadence operation was not found.");
    return operation;
  });
}

async function supersedeOperation(
  database: Database,
  args: CadenceRecoveryArgs,
) {
  const operation = await inspectOperation(database, args.operationId);
  if (operation.state !== "manual_review") {
    throw new Error(
      "Only a manual-review cadence operation can be superseded.",
    );
  }
  if (operation.revision !== args.expectedRevision) {
    throw new Error(
      `Cadence revision changed; inspect again (current ${operation.revision}).`,
    );
  }
  if (!args.execute) {
    return {
      executed: false,
      operationId: operation.id,
      practiceId: operation.practiceId,
      state: operation.state,
      revision: operation.revision,
      wouldBecome: "superseded" as const,
    };
  }
  return withSystem(database, (tx) =>
    supersedeManualCadenceOperation(tx, {
      operationId: args.operationId,
      expectedRevision: args.expectedRevision!,
      reason: args.reason!,
      providerScheduleReviewed: true,
      subscriptionReviewed: true,
      quantityReviewed: true,
    }),
  );
}

export async function runCadenceRecoveryCli(args: string[]): Promise<unknown> {
  const parsed = parseCadenceRecoveryArgs(args);
  const database = await ownerDatabase();
  if (parsed.command === "inspect") {
    return inspectOperation(database, parsed.operationId);
  }
  return supersedeOperation(database, parsed);
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runCadenceRecoveryCli(process.argv.slice(2))
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
