import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { practices, subscriptionCheckoutAttempts } from "@openpims/db";
import { db } from "@openpims/db/client";
import { describe, expect, it, vi } from "vitest";

const stripeMocks = vi.hoisted(() => ({
  create: vi.fn(),
  retrieve: vi.fn(),
}));

vi.mock("@/lib/stripe", () => ({
  createSubscriptionCheckoutSession: stripeMocks.create,
  retrieveDurableSubscriptionCheckoutSession: stripeMocks.retrieve,
}));

import {
  dispatchSubscriptionCheckoutAttempt,
  readSubscriptionSetupSnapshot,
  reserveSubscriptionCheckoutAttempt,
} from "../subscription-checkout-attempts";
import { withSystem, withTenant } from "@/lib/tenant-db";

const describeDatabase =
  process.env.SUBSCRIPTION_CHECKOUT_SERVICE_DB_INTEGRATION === "1"
    ? describe
    : describe.skip;

function request(practiceId: string, email = "billing@example.com") {
  return {
    practiceId,
    source: "settings" as const,
    billingCadence: "month" as const,
    returnTarget: "settings" as const,
    locationPriceId: "price_location",
    locationQuantity: 1,
    customerEmail: email,
    customerIdentitySource: "practice_email" as const,
    trialPeriodDays: 3,
    successUrl: "https://app.example.com/settings?checkout=success",
    cancelUrl: "https://app.example.com/settings?checkout=cancelled",
  };
}

async function practice(email = "billing@example.com") {
  const id = randomUUID();
  await db.insert(practices).values({ id, name: `Checkout ${id}`, email });
  return id;
}

async function reserve(practiceId: string) {
  return withSystem(db, (tx) =>
    reserveSubscriptionCheckoutAttempt(tx, request(practiceId)),
  );
}

describeDatabase("subscription Checkout service PostgreSQL transitions", () => {
  it("reads active setup and latest-attempt evidence from one tenant snapshot", async () => {
    const practiceId = await practice();
    await db
      .update(practices)
      .set({ stripeCustomerId: "cus_transport" })
      .where(eq(practices.id, practiceId));

    await expect(
      withTenant(db, practiceId, (tx) =>
        readSubscriptionSetupSnapshot(tx, practiceId, true),
      ),
    ).resolves.toMatchObject({
      setup: {
        hasStripeCustomer: true,
        hasSubscription: false,
        billingSetupCompleted: false,
        billingSetupState: "not_started",
        checkoutAction: "start",
      },
    });

    await withSystem(db, (tx) =>
      reserveSubscriptionCheckoutAttempt(tx, {
        ...request(practiceId),
        customerEmail: null,
        customerId: "cus_transport",
        customerIdentitySource: "stripe_customer",
      }),
    );
    await expect(
      withTenant(db, practiceId, (tx) =>
        readSubscriptionSetupSnapshot(tx, practiceId, true),
      ),
    ).resolves.toMatchObject({
      setup: {
        billingSetupState: "retryable",
        checkoutAction: "resume",
      },
    });

    await db
      .update(practices)
      .set({ deletedAt: new Date() })
      .where(eq(practices.id, practiceId));
    await expect(
      withTenant(db, practiceId, (tx) =>
        readSubscriptionSetupSnapshot(tx, practiceId, true),
      ),
    ).resolves.toBeNull();
  });

  it.each([
    [
      "soft deletion",
      async (practiceId: string) =>
        db
          .update(practices)
          .set({ deletedAt: new Date() })
          .where(eq(practices.id, practiceId)),
      "practice_inactive",
    ],
    [
      "recovery hold",
      async (practiceId: string) =>
        db
          .update(practices)
          .set({
            recoveryHold: true,
            recoveryHoldSetAt: new Date(),
            recoveryHoldReason: "Checkout integration race proof.",
          })
          .where(eq(practices.id, practiceId)),
      "practice_recovery_hold",
    ],
    [
      "concurrent subscription",
      async (practiceId: string) =>
        db
          .update(practices)
          .set({ stripeSubscriptionId: `sub_${randomUUID()}` })
          .where(eq(practices.id, practiceId)),
      "subscription_already_present",
    ],
    [
      "billing email drift",
      async (practiceId: string) =>
        db
          .update(practices)
          .set({ email: "changed@example.com" })
          .where(eq(practices.id, practiceId)),
      "billing_email_changed",
    ],
  ])("blocks %s before any provider POST", async (_label, mutate, reason) => {
    stripeMocks.create.mockReset();
    const practiceId = await practice();
    const reservation = await reserve(practiceId);
    await mutate(practiceId);

    const result = await dispatchSubscriptionCheckoutAttempt(db, reservation);

    expect(result.status).toBe("failed");
    expect(stripeMocks.create).not.toHaveBeenCalled();
    const [attempt] = await db
      .select({
        state: subscriptionCheckoutAttempts.state,
        lastErrorCode: subscriptionCheckoutAttempts.lastErrorCode,
      })
      .from(subscriptionCheckoutAttempts)
      .where(eq(subscriptionCheckoutAttempts.id, reservation.attemptId));
    expect(attempt).toEqual({ state: "failed", lastErrorCode: reason });
  });

  it("blocks a changed Stripe customer snapshot before POST", async () => {
    stripeMocks.create.mockReset();
    const practiceId = await practice();
    await db
      .update(practices)
      .set({ stripeCustomerId: "cus_original" })
      .where(eq(practices.id, practiceId));
    const reservation = await withSystem(db, (tx) =>
      reserveSubscriptionCheckoutAttempt(tx, {
        ...request(practiceId),
        customerEmail: null,
        customerId: "cus_original",
        customerIdentitySource: "stripe_customer",
      }),
    );
    await db
      .update(practices)
      .set({ stripeCustomerId: "cus_changed" })
      .where(eq(practices.id, practiceId));

    expect(
      await dispatchSubscriptionCheckoutAttempt(db, reservation),
    ).toMatchObject({ status: "failed" });
    expect(stripeMocks.create).not.toHaveBeenCalled();
  });

  it("reconciles a known open Session without POSTing again after email drift", async () => {
    stripeMocks.create.mockReset();
    stripeMocks.retrieve.mockReset();
    const practiceId = await practice();
    const reservation = await reserve(practiceId);
    const session = {
      sessionId: `cs_${randomUUID()}`,
      status: "open" as const,
      url: "https://checkout.stripe.com/c/safe_test",
      expiresAt: new Date(Date.now() + 3_600_000),
      practiceId,
      checkoutAttemptId: reservation.attemptId,
      customerId: null,
      subscriptionId: null,
    };
    stripeMocks.create.mockResolvedValueOnce(session);
    expect(
      await dispatchSubscriptionCheckoutAttempt(db, reservation),
    ).toMatchObject({ status: "open", reused: false });
    await db
      .update(practices)
      .set({ email: "changed@example.com" })
      .where(eq(practices.id, practiceId));
    stripeMocks.retrieve.mockResolvedValueOnce(session);

    expect(
      await dispatchSubscriptionCheckoutAttempt(db, reservation),
    ).toMatchObject({ status: "open", reused: true });
    expect(stripeMocks.create).toHaveBeenCalledTimes(1);
    expect(stripeMocks.retrieve).toHaveBeenCalledWith(session.sessionId);
  });

  it("persists bounded evidence when a known-Session GET fails", async () => {
    stripeMocks.create.mockReset();
    stripeMocks.retrieve.mockReset();
    const practiceId = await practice();
    const reservation = await reserve(practiceId);
    stripeMocks.create.mockResolvedValueOnce({
      sessionId: `cs_${randomUUID()}`,
      status: "open",
      url: "https://checkout.stripe.com/c/safe_test",
      expiresAt: new Date(Date.now() + 3_600_000),
      practiceId,
      checkoutAttemptId: reservation.attemptId,
      customerId: null,
      subscriptionId: null,
    });
    await dispatchSubscriptionCheckoutAttempt(db, reservation);
    stripeMocks.retrieve.mockRejectedValueOnce(new Error("provider timeout"));

    expect(
      await dispatchSubscriptionCheckoutAttempt(db, reservation),
    ).toMatchObject({ status: "pending" });
    const [attempt] = await db
      .select({ lastErrorCode: subscriptionCheckoutAttempts.lastErrorCode })
      .from(subscriptionCheckoutAttempts)
      .where(eq(subscriptionCheckoutAttempts.id, reservation.attemptId));
    expect(attempt?.lastErrorCode).toBe("provider_reconciliation_failed");
  });

  it("fails closed when the provider lease is lost before unknown persistence", async () => {
    stripeMocks.create.mockReset();
    const practiceId = await practice();
    const reservation = await reserve(practiceId);
    let rejectProvider!: (error: Error) => void;
    stripeMocks.create.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectProvider = reject;
        }),
    );
    const dispatch = dispatchSubscriptionCheckoutAttempt(db, reservation);
    await vi.waitFor(() => expect(stripeMocks.create).toHaveBeenCalledOnce());
    await db
      .update(subscriptionCheckoutAttempts)
      .set({ leaseToken: randomUUID() })
      .where(eq(subscriptionCheckoutAttempts.id, reservation.attemptId));
    rejectProvider(new Error("ambiguous provider timeout"));

    await expect(dispatch).rejects.toThrow("lease CAS was lost");
  });
});
