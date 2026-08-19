import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  destinationSubscriptionItemsMatch,
  migrationConfirmation,
  migrationRebindIds,
  readPrivateManifest,
} from "./rebind-stripe-subscriptions";

const temporaryDirectories: string[] = [];

function manifestPath(value: unknown, mode = 0o600): string {
  const directory = mkdtempSync(join(tmpdir(), "openvpm-stripe-migration-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "manifest.json");
  writeFileSync(path, JSON.stringify(value), { mode });
  chmodSync(path, mode);
  return path;
}

function validManifest() {
  return {
    sourceAccountId: "acct_source123",
    destinationAccountId: "acct_destination456",
    entries: [
      {
        practiceId: "11111111-1111-4111-8111-111111111111",
        customerId: "cus_customer123",
        sourceSubscriptionId: "sub_source123",
        destinationSubscriptionId: "sub_destination456",
      },
    ],
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Stripe subscription migration manifest", () => {
  it("accepts a private, bounded, account-specific manifest", () => {
    const result = readPrivateManifest(manifestPath(validManifest()));

    expect(result.manifest).toEqual(validManifest());
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects a manifest that can be read by another user", () => {
    expect(() =>
      readPrivateManifest(manifestPath(validManifest(), 0o644)),
    ).toThrow("permissions must be 0600");
  });

  it("rejects identifiers with the wrong Stripe object type", () => {
    const invalid = validManifest();
    invalid.entries[0]!.customerId = "sub_not_a_customer";

    expect(() => readPrivateManifest(manifestPath(invalid))).toThrow(
      "entry is invalid",
    );
  });

  it("rejects duplicate practice migrations", () => {
    const invalid = validManifest();
    invalid.entries.push({
      ...invalid.entries[0]!,
      customerId: "cus_customer456",
      sourceSubscriptionId: "sub_source456",
      destinationSubscriptionId: "sub_destination789",
    });

    expect(() => readPrivateManifest(manifestPath(invalid))).toThrow(
      "entries must be unique",
    );
  });

  it("derives distinct, digest-bound forward and rollback operations", () => {
    const entry = validManifest().entries[0]!;
    expect(migrationConfirmation("forward", "abc123")).toBe("MIGRATE:abc123");
    expect(migrationConfirmation("rollback", "abc123")).toBe("ROLLBACK:abc123");
    expect(migrationRebindIds("forward", entry)).toEqual({
      expectedSubscriptionId: entry.sourceSubscriptionId,
      replacementSubscriptionId: entry.destinationSubscriptionId,
    });
    expect(migrationRebindIds("rollback", entry)).toEqual({
      expectedSubscriptionId: entry.destinationSubscriptionId,
      replacementSubscriptionId: entry.sourceSubscriptionId,
    });
  });
});

describe("Stripe subscription migration item topology", () => {
  const base = (id: string, interval: "month" | "year", quantity: number) => ({
    quantity,
    price: { id, recurring: { interval, usage_type: "licensed" } },
  });
  const meter = (id: string) => ({
    quantity: null,
    price: {
      id,
      recurring: { interval: "month", usage_type: "metered" },
    },
  });
  const common = {
    allowedBasePriceIds: ["price_month", "price_year"],
    aiOveragePriceId: "price_ai",
    smsOveragePriceId: "price_sms",
  };

  it("requires both metered items on migrated monthly subscriptions", () => {
    const sourceItems = [
      base("price_source", "month", 2),
      meter("price_source_ai"),
      meter("price_source_sms"),
    ];
    const validDestination = [
      base("price_month", "month", 2),
      meter("price_ai"),
      meter("price_sms"),
    ];

    expect(
      destinationSubscriptionItemsMatch({
        ...common,
        sourceItems,
        destinationItems: validDestination,
      }),
    ).toBe(true);
    expect(
      destinationSubscriptionItemsMatch({
        ...common,
        sourceItems,
        destinationItems: validDestination.slice(0, 2),
      }),
    ).toBe(false);
    expect(
      destinationSubscriptionItemsMatch({
        ...common,
        sourceItems,
        destinationItems: [...validDestination, meter("price_unexpected")],
      }),
    ).toBe(false);
  });

  it("keeps annual founding subscriptions flat-rate", () => {
    const sourceItems = [base("price_source_year", "year", 1)];
    expect(
      destinationSubscriptionItemsMatch({
        ...common,
        sourceItems,
        destinationItems: [base("price_year", "year", 1)],
      }),
    ).toBe(true);
    expect(
      destinationSubscriptionItemsMatch({
        ...common,
        sourceItems,
        destinationItems: [
          base("price_year", "year", 1),
          meter("price_ai"),
          meter("price_sms"),
        ],
      }),
    ).toBe(false);
  });
});
