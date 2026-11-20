import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  CARD_GATE_AT,
  billingRegimeForPractice,
  formatBillingRegimeLine,
  formatSignupPaidReadout,
  groupPracticesByBillingRegime,
} from "@/lib/admin/billing-regime";

const BEFORE = "2026-09-15T12:00:00.000Z";
const JUST_BEFORE = "2026-10-01T19:32:45.999Z";
const AT_GATE = CARD_GATE_AT;
const AFTER = "2026-11-02T15:04:00.000Z";

describe("billing regime grouping", () => {
  const practices = [
    {
      id: "before-null",
      createdAt: BEFORE,
      stripeBillingAccount: null,
    },
    {
      id: "before-openvpm",
      createdAt: new Date(JUST_BEFORE),
      stripeBillingAccount: "openvpm",
    },
    {
      id: "before-legacy",
      createdAt: BEFORE,
      stripeBillingAccount: "legacy",
    },
    {
      id: "at-gate-openvpm",
      createdAt: AT_GATE,
      stripeBillingAccount: "openvpm",
    },
    {
      id: "after-openvpm",
      createdAt: new Date(AFTER),
      stripeBillingAccount: "openvpm",
    },
    {
      id: "after-legacy",
      createdAt: AFTER,
      stripeBillingAccount: "legacy",
    },
    {
      id: "after-null",
      createdAt: AFTER,
      stripeBillingAccount: null,
    },
    {
      id: "unreadable",
      createdAt: "not-a-date",
      stripeBillingAccount: "openvpm",
    },
  ];

  it("keeps clinics on both sides of the card gate in separate cohorts", () => {
    const groups = groupPracticesByBillingRegime(practices);

    expect(groups.pre_card_gate.map((practice) => practice.id)).toEqual([
      "before-null",
      "before-openvpm",
      "before-legacy",
      "after-legacy",
      "after-null",
      "unreadable",
    ]);
    expect(groups.card_required.map((practice) => practice.id)).toEqual([
      "at-gate-openvpm",
      "after-openvpm",
    ]);
    expect(billingRegimeForPractice(practices[3]!)).toBe("card_required");
    expect(billingRegimeForPractice(practices[1]!)).toBe("pre_card_gate");
  });

  it("uses the same gate instant and account column as the activation query", () => {
    const source = readFileSync(
      new URL("../activation-funnel.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("CARD_GATE_AT");
    expect(source).toContain("p.stripe_billing_account = 'openvpm'");
    expect(source).toContain("then 'card_required'");
    expect(source).toContain("else 'pre_card_gate'");
    expect(CARD_GATE_AT).toBe("2026-10-01T19:32:46Z");
  });

  it("reads signup to paid the same way for an open card-required trial", () => {
    const cardRequired = {
      signups: 3,
      checkoutStarted: 3,
      paymentMethodCollected: 2,
      firstPositivePayment: 0,
      trialNotYetEnded: 2,
    };
    const beforeGate = {
      signups: 2,
      checkoutStarted: 1,
      paymentMethodCollected: 1,
      firstPositivePayment: 1,
      trialNotYetEnded: 0,
    };

    expect(formatSignupPaidReadout({
      signups: 5,
      checkoutStarted: 4,
      paymentMethodCollected: 3,
      firstPositivePayment: 1,
      trialNotYetEnded: 2,
    })).toBe(
      "5 signups → 4 checkout started → 3 card collected → 1 paid",
    );
    expect(formatBillingRegimeLine("pre_card_gate", beforeGate)).toMatchInlineSnapshot(
      `"Before the card gate: 2 signups → 1 checkout started → 1 card collected → 1 paid · 0 trial not yet ended"`,
    );
    expect(formatBillingRegimeLine("card_required", cardRequired)).toMatchInlineSnapshot(
      `"Card required: 3 signups → 3 checkout started → 2 card collected → 0 paid · 2 trial not yet ended"`,
    );
  });
});
