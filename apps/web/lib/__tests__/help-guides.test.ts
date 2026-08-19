import { describe, expect, it } from "vitest";
import {
  HELP_CATEGORIES,
  HELP_GUIDES,
  POPULAR_GUIDE_SLUGS,
  getHelpGuide,
} from "../../app/help/help-data";
import {
  getTrainingPlanGuides,
  getTrainingPlanMinutes,
  TRAINING_PLANS,
} from "../../app/help/training-data";

describe("staff help guides", () => {
  it("covers every documentation category with unique stable slugs", () => {
    const slugs = HELP_GUIDES.map((guide) => guide.slug);

    expect(new Set(slugs).size).toBe(slugs.length);
    expect(HELP_GUIDES.length).toBeGreaterThanOrEqual(25);
    for (const guide of HELP_GUIDES) {
      expect(guide.audience.length).toBeGreaterThan(0);
      expect(guide.appHref.startsWith("/")).toBe(true);
      expect(guide.appLabel.length).toBeGreaterThan(0);
      expect(guide.lastVerified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    for (const category of HELP_CATEGORIES) {
      expect(HELP_GUIDES.some((guide) => guide.category === category.id)).toBe(
        true,
      );
    }
  });

  it("keeps every next and popular guide reference resolvable", () => {
    for (const guide of HELP_GUIDES) {
      if (guide.next) expect(getHelpGuide(guide.next)).toBeDefined();
    }
    for (const slug of POPULAR_GUIDE_SLUGS) {
      expect(getHelpGuide(slug)).toBeDefined();
    }
  });

  it("documents the real appointment and payment boundaries", () => {
    const appointment = getHelpGuide("book-an-appointment");
    const payment = getHelpGuide("take-a-payment");
    const paymentText = payment?.steps
      .flatMap((step) => step.paragraphs)
      .join(" ");

    expect(appointment?.preview).toBe("appointment");
    expect(appointment?.before).toContain("client and patient");
    expect(payment?.preview).toBe("payment");
    expect(payment?.before).toContain("sent or overdue");
    expect(paymentText).toContain("Record Payment");
    expect(paymentText).toContain("Take Card");
    expect(paymentText).toContain("Stripe Checkout");
  });

  it("matches the verified appointment, whiteboard, and role boundaries", () => {
    const appointment = getHelpGuide("book-an-appointment");
    const whiteboard = getHelpGuide("use-the-whiteboard");
    const visit = getHelpGuide("document-a-visit");
    const charges = getHelpGuide("capture-visit-charges");
    const requests = getHelpGuide("manage-appointment-requests");

    expect(JSON.stringify(appointment)).toContain("Record confirmation");
    expect(JSON.stringify(appointment)).toContain("Checked Out");
    expect(JSON.stringify(appointment)).not.toContain("Ready for Checkout");
    expect(JSON.stringify(whiteboard)).toContain("Waiting");
    expect(JSON.stringify(whiteboard)).toContain("In Progress");
    expect(JSON.stringify(whiteboard)).toContain("Completed");
    expect(JSON.stringify(visit)).toContain(
      "Veterinarians or admins create and finalize SOAP notes",
    );
    expect(charges?.audience).toBe("Front desk and admins");
    expect(requests?.appHref).toBe("/inbox");
  });

  it("does not publish workflows that have no application UI", () => {
    expect(getHelpGuide("create-a-treatment-plan")).toBeUndefined();
    expect(JSON.stringify(HELP_GUIDES)).not.toContain("treatment plan");
    expect(JSON.stringify(TRAINING_PLANS)).not.toContain(
      "create-a-treatment-plan",
    );
  });

  it("keeps every staff training plan complete and resolvable", () => {
    expect(TRAINING_PLANS.map((plan) => plan.slug)).toEqual([
      "front-desk",
      "clinical-team",
      "practice-administration",
    ]);

    for (const plan of TRAINING_PLANS) {
      const guides = getTrainingPlanGuides(plan);
      expect(guides.length).toBeGreaterThanOrEqual(8);
      expect(new Set(guides.map((guide) => guide.slug)).size).toBe(
        guides.length,
      );
      expect(getTrainingPlanMinutes(plan)).toBeGreaterThan(30);
    }

    expect(getTrainingPlanMinutes(TRAINING_PLANS[0]!)).toBe(53);
  });
});
