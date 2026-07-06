import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countBillableStaffRows } from "../subscription-sync";

describe("countBillableStaffRows", () => {
  it("counts every non-deleted staff user and excludes deleted users", () => {
    expect(
      countBillableStaffRows([
        { deletedAt: null },
        {},
        { deletedAt: new Date("2026-06-01T00:00:00Z") },
        { deletedAt: "2026-06-02T00:00:00Z" },
      ])
    ).toBe(2);
  });
});

describe("billing sync practice scoping", () => {
  const source = readFileSync(
    new URL("../subscription-sync.ts", import.meta.url),
    "utf8"
  );

  it("keeps sync-state reads and writes scoped to active practices", () => {
    expect(source).toMatch(
      /select\(\{ settings: practices\.settings \}\)[\s\S]+?where\(and\(eq\(practices\.id, practiceId\), isNull\(practices\.deletedAt\)\)\)/s
    );
    expect(source).toMatch(
      /update\(practices\)[\s\S]+?where\(and\(eq\(practices\.id, practiceId\), isNull\(practices\.deletedAt\)\)\)/s
    );
    const readState = source.slice(
      source.indexOf("export async function readBillingSyncState"),
      source.indexOf("export async function syncPracticeSubscriptionQuantities")
    );
    expect(readState).toContain("if (!practice) return null;");
    expect(readState).toContain(
      "const settings = (practice.settings ?? {}) as PracticeSettings;"
    );
    expect(readState).not.toContain("practice?.settings");
  });

  it("skips quantity sync when the practice is deleted or missing", () => {
    const syncState = source.slice(
      source.indexOf("export async function syncPracticeSubscriptionQuantities"),
      source.length
    );

    expect(source).toContain("Practice is unavailable for billing sync.");
    expect(source).toMatch(
      /select\(\{\s*stripeSubscriptionId: practices\.stripeSubscriptionId,[\s\S]+?where\(and\(eq\(practices\.id, practiceId\), isNull\(practices\.deletedAt\)\)\)/s
    );
    expect(syncState.indexOf("if (!practice)")).toBeLessThan(
      syncState.indexOf("const counts = await countBillableLocationsAndSeats")
    );
    expect(syncState).toContain("{ locationCount: 0, billableSeatCount: 0 }");
  });

  it("resolves Stripe price IDs through trim-aware billing helpers", () => {
    const syncState = source.slice(
      source.indexOf("export async function syncPracticeSubscriptionQuantities"),
      source.length
    );

    expect(syncState).toContain("cloudCheckoutPriceIds()");
    expect(syncState).toContain(
      "stripePriceIdFromEnv(STRIPE_PRICE_CLOUD_LEGACY_ENV)"
    );
    expect(syncState).not.toContain(
      "process.env[STRIPE_PRICE_CLOUD_LOCATION_ENV]"
    );
    expect(syncState).not.toContain("process.env[STRIPE_PRICE_CLOUD_USER_ENV]");
    expect(syncState).not.toContain(
      "process.env[STRIPE_PRICE_CLOUD_LEGACY_ENV]"
    );
  });
});
