import { describe, expect, it } from "vitest";
import {
  createSubscriptionCheckoutAttributionToken,
  verifySubscriptionCheckoutAttributionToken,
} from "@/lib/billing/checkout-attribution";

const PRACTICE_ID = "00000000-0000-4000-8000-0000000000aa";
const OTHER_PRACTICE_ID = "00000000-0000-4000-8000-0000000000bb";
const CLOSEOUT_ID = "00000000-0000-4000-8000-0000000000cc";
const NOW = new Date("2026-08-11T12:00:00.000Z");
const SECRET = "current-checkout-attribution-secret-at-least-32-bytes";
const PREVIOUS_SECRET = "previous-checkout-attribution-secret-at-least-32-bytes";

describe("subscription Checkout attribution", () => {
  it("round-trips a practice-bound first-visit campaign fact", () => {
    const token = createSubscriptionCheckoutAttributionToken(
      {
        practiceId: PRACTICE_ID,
        source: "first_visit_email",
        evidenceId: CLOSEOUT_ID,
      },
      { now: NOW, signingSecret: SECRET },
    );

    expect(token).toBeTruthy();
    expect(
      verifySubscriptionCheckoutAttributionToken(token, PRACTICE_ID, {
        now: NOW,
        signingSecret: SECRET,
      }),
    ).toEqual({
      practiceId: PRACTICE_ID,
      source: "first_visit_email",
      evidenceId: CLOSEOUT_ID,
    });
  });

  it("rejects a valid token presented by another practice", () => {
    const token = createSubscriptionCheckoutAttributionToken(
      {
        practiceId: PRACTICE_ID,
        source: "first_visit_email",
        evidenceId: CLOSEOUT_ID,
      },
      { now: NOW, signingSecret: SECRET },
    );

    expect(
      verifySubscriptionCheckoutAttributionToken(token, OTHER_PRACTICE_ID, {
        now: NOW,
        signingSecret: SECRET,
      }),
    ).toBeNull();
  });

  it("rejects tampering, expiry, malformed evidence, and unknown sources", () => {
    const token = createSubscriptionCheckoutAttributionToken(
      {
        practiceId: PRACTICE_ID,
        source: "trial_ending_email",
        evidenceId: "2026-08-14:t-3",
      },
      { now: NOW, signingSecret: SECRET },
    );

    expect(
      verifySubscriptionCheckoutAttributionToken(`${token}x`, PRACTICE_ID, {
        now: NOW,
        signingSecret: SECRET,
      }),
    ).toBeNull();
    expect(
      verifySubscriptionCheckoutAttributionToken(token, PRACTICE_ID, {
        now: new Date("2026-09-12T12:00:00.000Z"),
        signingSecret: SECRET,
      }),
    ).toBeNull();
    expect(
      createSubscriptionCheckoutAttributionToken(
        {
          practiceId: PRACTICE_ID,
          source: "first_visit_email",
          evidenceId: "contains spaces",
        },
        { now: NOW, signingSecret: SECRET },
      ),
    ).toBeNull();
    expect(
      createSubscriptionCheckoutAttributionToken(
        {
          practiceId: PRACTICE_ID,
          source: "unknown" as "first_visit_email",
          evidenceId: CLOSEOUT_ID,
        },
        { now: NOW, signingSecret: SECRET },
      ),
    ).toBeNull();
  });

  it("accepts an explicitly configured previous signing key", () => {
    const token = createSubscriptionCheckoutAttributionToken(
      {
        practiceId: PRACTICE_ID,
        source: "first_visit_email",
        evidenceId: CLOSEOUT_ID,
      },
      { now: NOW, signingSecret: PREVIOUS_SECRET },
    );

    expect(
      verifySubscriptionCheckoutAttributionToken(token, PRACTICE_ID, {
        now: NOW,
        signingSecret: SECRET,
        previousSigningSecrets: PREVIOUS_SECRET,
      }),
    ).toMatchObject({ source: "first_visit_email" });
  });

  it("fails closed when the configured signing key is absent or too short", () => {
    expect(
      createSubscriptionCheckoutAttributionToken(
        {
          practiceId: PRACTICE_ID,
          source: "first_visit_email",
          evidenceId: CLOSEOUT_ID,
        },
        { now: NOW, signingSecret: "short" },
      ),
    ).toBeNull();
  });
});
