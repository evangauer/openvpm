import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TRIAL_DAYS, trialEndsAtFrom } from "@/lib/billing/plans";
import { formatCheckoutTrialEnd } from "@/lib/billing/checkout-summary";
import {
  CHECKOUT_WELCOME_PATH,
  CHECKOUT_WELCOME_POLL_BUDGET_MS,
  CHECKOUT_WELCOME_SIGN_IN_PATH,
  checkoutWelcomeMessage,
  checkoutWelcomeReturnEvent,
  checkoutWelcomeState,
  checkoutWelcomeTrialEndLabel,
} from "@/lib/billing/checkout-welcome";

describe("checkout welcome confirmation", () => {
  const welcome = readFileSync("app/(auth)/welcome/page.tsx", "utf8");
  const auth = readFileSync("server/routers/auth.ts", "utf8");
  const middleware = readFileSync("middleware.ts", "utf8");

  it("sends signup Checkout to the confirmation and keeps the cancelled return", () => {
    expect(CHECKOUT_WELCOME_PATH).toBe("/welcome?checkout=success");
    expect(auth).toContain("successUrl: `${base}${CHECKOUT_WELCOME_PATH}`");
    expect(auth).toContain('cancelUrl: `${base}/login?checkout=cancelled`');
    expect(auth).not.toContain("/login?checkout=success");
    expect(middleware).toContain('"/welcome"');
  });

  it("names the pending, active, and signed-out states", () => {
    expect(
      checkoutWelcomeState({ authenticated: true, hasFullAccess: false }),
    ).toBe("finalizing");
    expect(
      checkoutWelcomeState({ authenticated: true, hasFullAccess: true }),
    ).toBe("active");
    expect(
      checkoutWelcomeState({ authenticated: false, hasFullAccess: true }),
    ).toBe("signed_out");
    expect(
      checkoutWelcomeState({ authenticated: false, hasFullAccess: false }),
    ).toBe("signed_out");
  });

  it("states the trial end, the no-charge promise, and Billing", () => {
    const now = new Date("2026-11-24T16:00:00.000Z");
    const label = checkoutWelcomeTrialEndLabel({ now });
    expect(label).toBe(formatCheckoutTrialEnd(trialEndsAtFrom(now)));
    const message = checkoutWelcomeMessage(label);
    expect(message).toContain(`Your ${TRIAL_DAYS}-day trial is active`);
    expect(message).toContain(`ends ${label}`);
    expect(message).toContain("you won't be charged until then");
    expect(message).toContain("cancel anytime in Billing");

    const stored = checkoutWelcomeTrialEndLabel({
      trialEndsAt: "2027-06-01T15:00:00.000Z",
      now,
    });
    expect(checkoutWelcomeMessage(stored)).toContain(stored);
    expect(stored).not.toBe(label);
  });

  it("polls briefly while the webhook is still pending", () => {
    expect(CHECKOUT_WELCOME_POLL_BUDGET_MS).toBeLessThanOrEqual(20_000);
    expect(welcome).toContain("Finalizing your trial");
    expect(welcome).toContain("subscription.get.useQuery");
    expect(welcome).toContain("CHECKOUT_WELCOME_POLL_INTERVAL_MS");
    expect(welcome).toContain("query.state.data?.hasFullAccess");
    expect(welcome).toContain("Set up your clinic");
    expect(welcome).toContain("CHECKOUT_WELCOME_SIGN_IN_PATH");
    expect(CHECKOUT_WELCOME_SIGN_IN_PATH).toContain(
      encodeURIComponent(CHECKOUT_WELCOME_PATH),
    );
  });

  it("records checkout success when that funnel event exists", () => {
    expect(checkoutWelcomeReturnEvent({}, "success")).toBeNull();
    expect(
      checkoutWelcomeReturnEvent(
        { checkoutSucceeded: "checkout_succeeded" },
        "success",
      ),
    ).toEqual({
      name: "checkout_succeeded",
      source: "signup",
      path: "/welcome",
    });
    expect(
      checkoutWelcomeReturnEvent(
        { checkoutCancelled: "checkout_cancelled" },
        "cancelled",
      ),
    ).toEqual({
      name: "checkout_cancelled",
      source: "signup",
      path: "/welcome",
    });
    expect(welcome).toContain("checkoutWelcomeReturnEvent(FUNNEL_EVENTS, checkout)");
  });
});
