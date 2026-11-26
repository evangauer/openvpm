import { trialEndsAtFrom, TRIAL_DAYS } from "@/lib/billing/plans";
import { formatCheckoutTrialEnd } from "@/lib/billing/checkout-summary";

/** Stripe signup success lands here instead of a bare sign-in screen. */
export const CHECKOUT_WELCOME_PATH = "/welcome?checkout=success";

/** Sign-in returns to the same confirmation when the Checkout session cookie is gone. */
export const CHECKOUT_WELCOME_SIGN_IN_PATH = `/login?next=${encodeURIComponent(
  CHECKOUT_WELCOME_PATH,
)}`;

/** Dashboard entry that reopens post-login onboarding, including clinic model and first goal. */
export const CHECKOUT_WELCOME_ONBOARDING_PATH = "/?setup=resume";

/**
 * How long the confirmation waits for the subscription webhook.
 * Eight reads, 1.5s apart: long enough for Stripe to land, short enough to
 * leave the clinic on an explicit finalizing state.
 */
export const CHECKOUT_WELCOME_POLL_INTERVAL_MS = 1_500;
export const CHECKOUT_WELCOME_POLL_ATTEMPTS = 8;
export const CHECKOUT_WELCOME_POLL_BUDGET_MS =
  CHECKOUT_WELCOME_POLL_INTERVAL_MS * CHECKOUT_WELCOME_POLL_ATTEMPTS;

export type CheckoutWelcomeState = "finalizing" | "active" | "signed_out";

export function checkoutWelcomeState(input: {
  authenticated: boolean;
  hasFullAccess: boolean;
}): CheckoutWelcomeState {
  if (!input.authenticated) return "signed_out";
  if (input.hasFullAccess) return "active";
  return "finalizing";
}

export function checkoutWelcomeTrialEnd(input?: {
  trialEndsAt?: Date | string | null;
  now?: Date;
}): Date {
  if (input?.trialEndsAt) {
    const parsed = new Date(input.trialEndsAt);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return trialEndsAtFrom(input?.now ?? new Date());
}

export function checkoutWelcomeMessage(trialEndLabel: string): string {
  return `Your ${TRIAL_DAYS}-day trial is active, ends ${trialEndLabel}, you won't be charged until then, cancel anytime in Billing`;
}

export function checkoutWelcomeTrialEndLabel(input?: {
  trialEndsAt?: Date | string | null;
  now?: Date;
}): string {
  return formatCheckoutTrialEnd(checkoutWelcomeTrialEnd(input));
}

/**
 * Signup Checkout return events from the activation funnel. The event names
 * are optional so this page still builds before that funnel is merged; when
 * the names exist, a successful Checkout records the same success event.
 */
export function checkoutWelcomeReturnEvent(
  events: object,
  checkout: string | null,
): { name: string; source: "signup"; path: "/welcome" } | null {
  const named = events as {
    checkoutSucceeded?: string;
    checkoutCancelled?: string;
  };
  const name =
    checkout === "success"
      ? named.checkoutSucceeded
      : checkout === "cancelled"
        ? named.checkoutCancelled
        : undefined;
  if (!name) return null;
  return { name, source: "signup", path: "/welcome" };
}
