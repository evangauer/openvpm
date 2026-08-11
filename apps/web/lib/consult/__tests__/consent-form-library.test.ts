import { describe, expect, it } from "vitest";
import {
  CONSENT_BODY_MAX_LENGTH,
  CONSENT_TITLE_MAX_LENGTH,
  hasUnresolvedConsentPlaceholders,
} from "../consent-template";
import { CONSENT_FORM_LIBRARY } from "../consent-form-library";

describe("consent form starter library", () => {
  it("has unique slugs and sort orders", () => {
    const slugs = CONSENT_FORM_LIBRARY.map((form) => form.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    const orders = CONSENT_FORM_LIBRARY.map((form) => form.sortOrder);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it("starts with the plain consent-to-treatment form", () => {
    expect(CONSENT_FORM_LIBRARY[0]).toMatchObject({
      slug: "treatment",
      sortOrder: 0,
    });
  });

  it("fits every form inside the dispatch field limits", () => {
    for (const form of CONSENT_FORM_LIBRARY) {
      expect(form.title.length).toBeGreaterThan(0);
      expect(form.title.length).toBeLessThanOrEqual(CONSENT_TITLE_MAX_LENGTH);
      expect(form.body.trim().length).toBeGreaterThan(0);
      expect(form.body.length).toBeLessThanOrEqual(CONSENT_BODY_MAX_LENGTH);
      expect(form.slug).toMatch(/^[a-z0-9-]{1,64}$/);
    }
  });

  it("keeps the voice rules: no em dashes anywhere", () => {
    for (const form of CONSENT_FORM_LIBRARY) {
      expect(form.title).not.toContain("—");
      expect(form.body).not.toContain("—");
    }
  });

  it("covers the core forms a clinic needs on day one", () => {
    const slugs = new Set(CONSENT_FORM_LIBRARY.map((form) => form.slug));
    for (const required of [
      "treatment",
      "surgery-anesthesia",
      "dental",
      "euthanasia",
      "estimate-approval",
      "boarding",
    ]) {
      expect(slugs.has(required)).toBe(true);
    }
  });

  it("detects unresolved material blanks and staff-only instructions", () => {
    for (const unresolved of [
      "Procedure: ____",
      "Approved total: {{amount}}",
      "Call ${phoneNumber}",
      "Send records to [insert destination]",
      "I choose (staff: circle before sending): CPR / no CPR.",
    ]) {
      expect(hasUnresolvedConsentPlaceholders(unresolved)).toBe(true);
    }
  });

  it("allows completed consent copy and ordinary punctuation", () => {
    expect(
      hasUnresolvedConsentPlaceholders(
        "Procedure: dental cleaning. I approve costs up to $850. Call 555-0100.",
      ),
    ).toBe(false);
    expect(hasUnresolvedConsentPlaceholders("I agree [after review].")).toBe(
      false,
    );
  });
});
