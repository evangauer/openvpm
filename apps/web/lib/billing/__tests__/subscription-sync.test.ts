import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  retrieve: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
}));

vi.mock("@/lib/stripe", () => ({
  stripe: {
    subscriptions: { retrieve: mocks.retrieve },
    subscriptionItems: { update: mocks.update, create: mocks.create },
  },
}));

import {
  countBillableStaffRows,
  syncPracticeSubscriptionQuantities,
} from "../subscription-sync";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

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

  it("does not call Stripe or count billable rows while held", async () => {
    const locked = vi.fn(async () => [
      { stripeSubscriptionId: "sub_held", recoveryHold: true },
    ]);
    const limit = vi.fn(() => ({ for: locked }));
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));

    await expect(
      syncPracticeSubscriptionQuantities({
        db: { select } as never,
        practiceId: "practice-held",
      }),
    ).resolves.toMatchObject({
      status: "skipped",
      locationCount: 0,
      billableSeatCount: 0,
    });

    expect(select).toHaveBeenCalledOnce();
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("attaches missing metered overage items idempotently during sync", () => {
    const syncState = source.slice(
      source.indexOf("export async function syncPracticeSubscriptionQuantities"),
      source.length
    );

    // Checkout carries only the base price; sync adds the metered items and
    // must never duplicate ones that already exist on the subscription.
    expect(syncState).toContain("cloudMeteredPriceIds()");
    expect(syncState).toMatch(
      /meteredPriceId &&\s*!items\.some\(\(item\) => item\.price\?\.id === meteredPriceId\)/
    );
    expect(syncState).toContain("stripe.subscriptionItems.create({");
  });

  it("syncs annual quantity without attaching monthly metered items", async () => {
    vi.stubEnv("HOSTED_BILLING_ENABLED", "true");
    vi.stubEnv("STRIPE_PRICE_CLOUD_LOCATION", "price_monthly");
    vi.stubEnv("STRIPE_PRICE_CLOUD_LOCATION_ANNUAL", "price_annual");
    vi.stubEnv("STRIPE_PRICE_AI_OVERAGE", "price_ai");
    vi.stubEnv("STRIPE_PRICE_SMS_OVERAGE", "price_sms");
    mocks.retrieve.mockResolvedValue({
      items: {
        data: [{ id: "si_annual", price: { id: "price_annual" } }],
      },
    });
    mocks.update.mockResolvedValue({});

    let selectCall = 0;
    const select = vi.fn(() => {
      const rows =
        selectCall++ === 0
          ? [{ stripeSubscriptionId: "sub_annual", recoveryHold: false }]
          : [{ c: 1 }];
      const builder: Record<string, unknown> = {};
      builder.from = () => builder;
      builder.where = () => builder;
      builder.limit = () => builder;
      builder.for = async () => rows;
      builder.then = (
        resolve: (value: unknown[]) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => Promise.resolve(rows).then(resolve, reject);
      return builder;
    });
    const writeWhere = vi.fn(async () => []);
    const dbUpdate = vi.fn(() => ({
      set: () => ({ where: writeWhere }),
    }));

    await expect(
      syncPracticeSubscriptionQuantities({
        db: { select, update: dbUpdate } as never,
        practiceId: "practice-annual",
      }),
    ).resolves.toMatchObject({
      status: "ok",
      billingCadence: "year",
      locationCount: 1,
    });

    expect(mocks.update).toHaveBeenCalledWith("si_annual", { quantity: 1 });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(writeWhere).toHaveBeenCalledOnce();
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
