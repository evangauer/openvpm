import { describe, expect, it } from "vitest";
import {
  hasPreviewAccess,
  isPreviewPractice,
  PREVIEW_HOURS,
  previewArmFor,
  previewEndsAtFrom,
  previewPercent,
} from "@/lib/billing/preview";

const NOW = new Date("2026-11-05T12:00:00Z");
const HOUR = 60 * 60 * 1000;

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

describe("previewPercent", () => {
  it("defaults to off and clamps to 0-100", () => {
    expect(previewPercent(undefined)).toBe(0);
    expect(previewPercent("")).toBe(0);
    expect(previewPercent("abc")).toBe(0);
    expect(previewPercent("-5")).toBe(0);
    expect(previewPercent(" 25 ")).toBe(25);
    expect(previewPercent("250")).toBe(100);
  });
});

describe("previewArmFor", () => {
  it("keeps visitors without a funnel id on the control path", () => {
    expect(previewArmFor(null, 100)).toBe("control");
    expect(previewArmFor("  ", 100)).toBe("control");
  });

  it("honors 0 and 100 exactly", () => {
    expect(previewArmFor(uuid(1), 0)).toBe("control");
    expect(previewArmFor(uuid(1), 100)).toBe("preview");
  });

  it("is stable per visitor and case-insensitive", () => {
    const id = "ABCDEF12-3456-4789-8abc-def012345678";
    const arm = previewArmFor(id, 50);
    for (let i = 0; i < 5; i++) expect(previewArmFor(id, 50)).toBe(arm);
    expect(previewArmFor(id.toLowerCase(), 50)).toBe(arm);
  });

  it("splits visitors close to the configured share", () => {
    let preview = 0;
    const total = 4000;
    for (let i = 0; i < total; i++) {
      if (previewArmFor(uuid(i), 30) === "preview") preview++;
    }
    expect(preview / total).toBeGreaterThan(0.26);
    expect(preview / total).toBeLessThan(0.34);
  });
});

describe("preview access", () => {
  const preview = {
    billingStatus: "none",
    trialEndsAt: null,
    stripeSubscriptionId: null,
    previewEndsAt: new Date(NOW.getTime() + 2 * HOUR),
  };

  it("lasts the preview window from signup", () => {
    expect(previewEndsAtFrom(NOW).getTime() - NOW.getTime()).toBe(
      PREVIEW_HOURS * HOUR,
    );
  });

  it("grants setup access only inside the window", () => {
    expect(hasPreviewAccess(preview, NOW)).toBe(true);
    expect(
      hasPreviewAccess(
        { ...preview, previewEndsAt: new Date(NOW.getTime() - 1) },
        NOW,
      ),
    ).toBe(false);
  });

  it("still counts as a preview clinic after the window, until a trial starts", () => {
    const ended = { ...preview, previewEndsAt: new Date(NOW.getTime() - HOUR) };
    expect(isPreviewPractice(ended)).toBe(true);
    expect(hasPreviewAccess(ended, NOW)).toBe(false);
  });

  it("ends once a trial or subscription exists", () => {
    expect(
      isPreviewPractice({
        ...preview,
        billingStatus: "trialing",
        trialEndsAt: new Date(NOW.getTime() + 14 * 24 * HOUR),
      }),
    ).toBe(false);
    expect(
      isPreviewPractice({ ...preview, stripeSubscriptionId: "sub_123" }),
    ).toBe(false);
  });

  it("never applies to clinics that did not start in a preview", () => {
    expect(isPreviewPractice({ ...preview, previewEndsAt: null })).toBe(false);
    expect(hasPreviewAccess({ ...preview, previewEndsAt: null }, NOW)).toBe(
      false,
    );
  });
});
