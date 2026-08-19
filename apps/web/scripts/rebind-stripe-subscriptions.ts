#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { and, eq, isNull } from "drizzle-orm";
import Stripe from "stripe";
import { auditLog, practices } from "@openpims/db";
import type { Database } from "@openpims/db/client";
import { withSystem } from "../lib/tenant-db";
import { STRIPE_API_VERSION } from "../lib/stripe";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STRIPE_ACCOUNT_ID_PATTERN = /^acct_[A-Za-z0-9]+$/;
const STRIPE_CUSTOMER_ID_PATTERN = /^cus_[A-Za-z0-9]+$/;
const STRIPE_SUBSCRIPTION_ID_PATTERN = /^sub_[A-Za-z0-9]+$/;
const MAX_MANIFEST_BYTES = 64_000;
const MAX_ENTRIES = 20;
const BILLING_TIME_TOLERANCE_SECONDS = 5 * 60;

type MigrationEntry = {
  practiceId: string;
  customerId: string;
  sourceSubscriptionId: string;
  destinationSubscriptionId: string;
};

type MigrationManifest = {
  sourceAccountId: string;
  destinationAccountId: string;
  entries: MigrationEntry[];
};

export type MigrationDirection = "forward" | "rollback";

type ParsedArgs = {
  manifestPath: string;
  execute: boolean;
  confirmation?: string;
  direction: MigrationDirection;
};

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseArgs(args: string[]): ParsedArgs {
  const manifestPath = flagValue(args, "manifest");
  if (!manifestPath || !isAbsolute(manifestPath)) {
    throw new Error("--manifest must be an absolute path.");
  }
  return {
    manifestPath,
    execute: args.includes("--execute"),
    confirmation: flagValue(args, "confirmation"),
    direction: args.includes("--rollback") ? "rollback" : "forward",
  };
}

export function migrationConfirmation(
  direction: MigrationDirection,
  digest: string,
): string {
  return `${direction === "forward" ? "MIGRATE" : "ROLLBACK"}:${digest}`;
}

export function migrationRebindIds(
  direction: MigrationDirection,
  entry: MigrationEntry,
): { expectedSubscriptionId: string; replacementSubscriptionId: string } {
  return direction === "forward"
    ? {
        expectedSubscriptionId: entry.sourceSubscriptionId,
        replacementSubscriptionId: entry.destinationSubscriptionId,
      }
    : {
        expectedSubscriptionId: entry.destinationSubscriptionId,
        replacementSubscriptionId: entry.sourceSubscriptionId,
      };
}

function isWithin(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return (
    fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== "..")
  );
}

export function readPrivateManifest(path: string): {
  manifest: MigrationManifest;
  digest: string;
} {
  const canonicalPath = realpathSync(path);
  const repositoryRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
  if (isWithin(repositoryRoot, canonicalPath)) {
    throw new Error(
      "Migration manifest must be stored outside the repository.",
    );
  }
  const stat = statSync(canonicalPath);
  if (!stat.isFile())
    throw new Error("Migration manifest must be a regular file.");
  if (typeof process.getuid !== "function" || stat.uid !== process.getuid()) {
    throw new Error("Migration manifest must be owned by the current user.");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error("Migration manifest permissions must be 0600.");
  }
  if (stat.size < 1 || stat.size > MAX_MANIFEST_BYTES) {
    throw new Error("Migration manifest size is invalid.");
  }
  const bytes = readFileSync(canonicalPath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Migration manifest is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Migration manifest shape is invalid.");
  }
  const value = parsed as Partial<MigrationManifest>;
  if (
    typeof value.sourceAccountId !== "string" ||
    typeof value.destinationAccountId !== "string" ||
    !STRIPE_ACCOUNT_ID_PATTERN.test(value.sourceAccountId) ||
    !STRIPE_ACCOUNT_ID_PATTERN.test(value.destinationAccountId) ||
    !Array.isArray(value.entries) ||
    value.entries.length < 1 ||
    value.entries.length > MAX_ENTRIES
  ) {
    throw new Error("Migration manifest shape is invalid.");
  }
  const entries = value.entries as MigrationEntry[];
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry !== "object" ||
      !UUID_PATTERN.test(entry.practiceId) ||
      !STRIPE_CUSTOMER_ID_PATTERN.test(entry.customerId) ||
      !STRIPE_SUBSCRIPTION_ID_PATTERN.test(entry.sourceSubscriptionId) ||
      !STRIPE_SUBSCRIPTION_ID_PATTERN.test(entry.destinationSubscriptionId) ||
      entry.sourceSubscriptionId === entry.destinationSubscriptionId
    ) {
      throw new Error("Migration manifest entry is invalid.");
    }
  }
  if (
    new Set(entries.map((entry) => entry.practiceId)).size !== entries.length ||
    new Set(entries.map((entry) => entry.customerId)).size !== entries.length ||
    new Set(entries.map((entry) => entry.destinationSubscriptionId)).size !==
      entries.length
  ) {
    throw new Error("Migration manifest entries must be unique.");
  }
  return { manifest: value as MigrationManifest, digest };
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function subscriptionCustomerId(subscription: Stripe.Subscription): string {
  return typeof subscription.customer === "string"
    ? subscription.customer
    : subscription.customer.id;
}

function sourceServiceEnd(subscription: Stripe.Subscription): number | null {
  const periodEnds = subscription.items.data
    .map((item) => item.current_period_end)
    .filter((value): value is number => Number.isFinite(value));
  return periodEnds.length > 0
    ? Math.max(...periodEnds)
    : subscription.trial_end;
}

function destinationStart(subscription: Stripe.Subscription): number {
  return subscription.trial_end ?? subscription.billing_cycle_anchor;
}

function pauseCollectionMatches(
  source: Stripe.Subscription,
  destination: Stripe.Subscription,
): boolean {
  if (!source.pause_collection && !destination.pause_collection) return true;
  if (!source.pause_collection || !destination.pause_collection) return false;
  return (
    source.pause_collection.behavior ===
      destination.pause_collection.behavior &&
    source.pause_collection.resumes_at ===
      destination.pause_collection.resumes_at
  );
}

function idDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

type SubscriptionItemLike = {
  quantity?: number | null;
  price: {
    id: string;
    recurring?: {
      interval: string;
      usage_type: string;
    } | null;
  };
};

export function destinationSubscriptionItemsMatch(input: {
  sourceItems: SubscriptionItemLike[];
  destinationItems: SubscriptionItemLike[];
  allowedBasePriceIds: string[];
  aiOveragePriceId: string;
  smsOveragePriceId: string;
}): boolean {
  const allowedBasePrices = new Set(input.allowedBasePriceIds);
  const sourceBaseItems = input.sourceItems.filter(
    (item) => item.price.recurring?.usage_type === "licensed",
  );
  const destinationBaseItems = input.destinationItems.filter((item) =>
    allowedBasePrices.has(item.price.id),
  );
  if (sourceBaseItems.length !== 1 || destinationBaseItems.length !== 1) {
    return false;
  }
  const sourceBase = sourceBaseItems[0]!;
  const destinationBase = destinationBaseItems[0]!;
  const interval = sourceBase.price.recurring?.interval;
  if (
    !interval ||
    destinationBase.price.recurring?.usage_type !== "licensed" ||
    destinationBase.price.recurring.interval !== interval ||
    (destinationBase.quantity ?? 0) < 1 ||
    destinationBase.quantity !== sourceBase.quantity
  ) {
    return false;
  }

  const expectedPriceIds =
    interval === "month"
      ? new Set([
          destinationBase.price.id,
          input.aiOveragePriceId,
          input.smsOveragePriceId,
        ])
      : interval === "year"
        ? new Set([destinationBase.price.id])
        : null;
  if (
    !expectedPriceIds ||
    input.destinationItems.length !== expectedPriceIds.size ||
    new Set(input.destinationItems.map((item) => item.price.id)).size !==
      expectedPriceIds.size ||
    input.destinationItems.some((item) => !expectedPriceIds.has(item.price.id))
  ) {
    return false;
  }
  if (interval === "month") {
    return [input.aiOveragePriceId, input.smsOveragePriceId].every(
      (priceId) => {
        const item = input.destinationItems.find(
          (candidate) => candidate.price.id === priceId,
        );
        return (
          item?.price.recurring?.usage_type === "metered" &&
          item.price.recurring.interval === "month" &&
          item.quantity == null
        );
      },
    );
  }
  return true;
}

async function database(): Promise<Database> {
  process.env.DATABASE_URL = requiredEnv("STRIPE_MIGRATION_DATABASE_URL");
  const dbModule = await import("@openpims/db/client");
  return dbModule.db;
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const { manifest, digest } = readPrivateManifest(args.manifestPath);
  const expectedConfirmation = migrationConfirmation(args.direction, digest);
  if (args.execute && args.confirmation !== expectedConfirmation) {
    throw new Error(
      `--confirmation must exactly equal ${expectedConfirmation}.`,
    );
  }

  const sourceStripe = new Stripe(
    requiredEnv("STRIPE_MIGRATION_SOURCE_SECRET_KEY"),
    { apiVersion: STRIPE_API_VERSION },
  );
  const destinationStripe = new Stripe(requiredEnv("STRIPE_SECRET_KEY"), {
    apiVersion: STRIPE_API_VERSION,
  });
  const [sourceAccount, destinationAccount] = await Promise.all([
    sourceStripe.accounts.retrieveCurrent(),
    destinationStripe.accounts.retrieveCurrent(),
  ]);
  if (
    sourceAccount.id !== manifest.sourceAccountId ||
    destinationAccount.id !== manifest.destinationAccountId ||
    sourceAccount.id === destinationAccount.id
  ) {
    throw new Error("Stripe migration account identity check failed.");
  }

  const allowedBasePrices = new Set([
    requiredEnv("STRIPE_PRICE_CLOUD_LOCATION"),
    requiredEnv("STRIPE_PRICE_CLOUD_LOCATION_ANNUAL"),
  ]);
  const aiOveragePriceId = requiredEnv("STRIPE_PRICE_AI_OVERAGE");
  const smsOveragePriceId = requiredEnv("STRIPE_PRICE_SMS_OVERAGE");
  const databaseClient = await database();

  for (const entry of manifest.entries) {
    const [
      sourceSubscription,
      destinationSubscription,
      destinationCustomer,
      practice,
    ] = await Promise.all([
      sourceStripe.subscriptions.retrieve(entry.sourceSubscriptionId),
      destinationStripe.subscriptions.retrieve(
        entry.destinationSubscriptionId,
        { expand: ["latest_invoice"] },
      ),
      destinationStripe.customers.retrieve(entry.customerId),
      withSystem(databaseClient, async (tx) => {
        const [row] = await tx
          .select({
            id: practices.id,
            stripeCustomerId: practices.stripeCustomerId,
            stripeSubscriptionId: practices.stripeSubscriptionId,
          })
          .from(practices)
          .where(
            and(
              eq(practices.id, entry.practiceId),
              isNull(practices.deletedAt),
            ),
          )
          .limit(1);
        return row ?? null;
      }),
    ]);
    if (
      !practice ||
      practice.stripeCustomerId !== entry.customerId ||
      practice.stripeSubscriptionId !==
        migrationRebindIds(args.direction, entry).expectedSubscriptionId
    ) {
      throw new Error(
        "Database billing identity does not match the migration manifest.",
      );
    }
    if (
      subscriptionCustomerId(sourceSubscription) !== entry.customerId ||
      subscriptionCustomerId(destinationSubscription) !== entry.customerId
    ) {
      throw new Error(
        "Stripe customer identity does not match the migration manifest.",
      );
    }
    if (destinationCustomer.deleted) {
      throw new Error("Destination Stripe customer was deleted.");
    }
    const destinationPaymentMethod =
      destinationSubscription.default_payment_method ??
      destinationSubscription.default_source ??
      destinationCustomer.invoice_settings.default_payment_method ??
      destinationCustomer.default_source;
    if (!destinationPaymentMethod) {
      throw new Error("Destination customer has no default payment method.");
    }
    const metadataPracticeId =
      destinationSubscription.metadata.practiceId?.trim();
    if (metadataPracticeId && metadataPracticeId !== entry.practiceId) {
      throw new Error(
        "Destination subscription metadata conflicts with the practice.",
      );
    }
    if (
      args.direction === "forward" &&
      !new Set(["active", "trialing"]).has(destinationSubscription.status)
    ) {
      throw new Error("Destination subscription is not active or trialing.");
    }
    if (
      args.direction === "rollback" &&
      (!new Set(["active", "trialing"]).has(sourceSubscription.status) ||
        sourceSubscription.cancel_at_period_end ||
        !(
          destinationSubscription.status === "canceled" ||
          destinationSubscription.cancel_at_period_end
        ))
    ) {
      throw new Error(
        "Rollback requires the source renewal restored and the destination scheduled to stop.",
      );
    }
    if (
      !destinationSubscriptionItemsMatch({
        sourceItems: sourceSubscription.items.data,
        destinationItems: destinationSubscription.items.data,
        allowedBasePriceIds: [...allowedBasePrices],
        aiOveragePriceId,
        smsOveragePriceId,
      })
    ) {
      throw new Error(
        "Destination subscription does not preserve the OpenVPM item topology.",
      );
    }
    if (
      destinationSubscription.currency !== sourceSubscription.currency ||
      destinationSubscription.collection_method !==
        sourceSubscription.collection_method ||
      destinationSubscription.automatic_tax.enabled !==
        sourceSubscription.automatic_tax.enabled
    ) {
      throw new Error(
        "Destination subscription billing policy does not match source.",
      );
    }
    if (!pauseCollectionMatches(sourceSubscription, destinationSubscription)) {
      throw new Error(
        "Destination subscription does not preserve collection pause state.",
      );
    }
    if (
      args.direction === "forward" &&
      sourceSubscription.status !== "canceled" &&
      !sourceSubscription.cancel_at_period_end
    ) {
      throw new Error("Source subscription is not scheduled to stop.");
    }
    if (sourceSubscription.status !== "canceled") {
      const destinationInvoice = destinationSubscription.latest_invoice;
      if (
        destinationInvoice &&
        typeof destinationInvoice === "object" &&
        "amount_paid" in destinationInvoice &&
        destinationInvoice.amount_paid > 0
      ) {
        throw new Error(
          "Destination subscription already charged before cutover.",
        );
      }
      const serviceEnd = sourceServiceEnd(sourceSubscription);
      if (
        !serviceEnd ||
        Math.abs(destinationStart(destinationSubscription) - serviceEnd) >
          BILLING_TIME_TOLERANCE_SECONDS
      ) {
        throw new Error(
          "Destination subscription does not preserve the paid-through date.",
        );
      }
    }
  }

  if (!args.execute) {
    process.stdout.write(
      `${JSON.stringify({
        status: "verified",
        dryRun: true,
        direction: args.direction,
        entries: manifest.entries.length,
        manifestDigest: digest,
        requiredConfirmation: expectedConfirmation,
      })}\n`,
    );
    return;
  }

  await withSystem(databaseClient, async (tx) => {
    for (const entry of manifest.entries) {
      const rebind = migrationRebindIds(args.direction, entry);
      const [updated] = await tx
        .update(practices)
        .set({ stripeSubscriptionId: rebind.replacementSubscriptionId })
        .where(
          and(
            eq(practices.id, entry.practiceId),
            eq(practices.stripeCustomerId, entry.customerId),
            eq(practices.stripeSubscriptionId, rebind.expectedSubscriptionId),
            isNull(practices.deletedAt),
          ),
        )
        .returning({ id: practices.id });
      if (!updated)
        throw new Error("A migration database precondition changed.");
      await tx.insert(auditLog).values({
        practiceId: entry.practiceId,
        userId: null,
        action:
          args.direction === "forward"
            ? "subscription_rebound"
            : "subscription_rebound_rollback",
        entityType: "stripe_account_migration",
        entityId: entry.practiceId,
        changes: {
          source: "stripe_account_migration_cli",
          direction: args.direction,
          sourceAccountId: manifest.sourceAccountId,
          destinationAccountId: manifest.destinationAccountId,
          customerIdPreserved: true,
          sourceSubscriptionDigest: idDigest(entry.sourceSubscriptionId),
          destinationSubscriptionDigest: idDigest(
            entry.destinationSubscriptionId,
          ),
          manifestDigest: digest,
        },
      });
    }
  });
  process.stdout.write(
    `${JSON.stringify({
      status: args.direction === "forward" ? "migrated" : "rolled_back",
      dryRun: false,
      direction: args.direction,
      entries: manifest.entries.length,
      manifestDigest: digest,
    })}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : "Migration failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
