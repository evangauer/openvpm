import { describe, expect, it } from "vitest";
import {
  BUILD_PRACTICE_PROFILES,
  BUILD_PRACTICE_TYPES,
  BUILD_SERVICE_MAX,
  buildDraftSchema,
  buildFirstGoal,
  builderPercent,
  inBuilderArm,
} from "@/lib/build/catalog";
import { previewArmFor } from "@/lib/billing/preview";

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

describe("build catalog", () => {
  it("gives every practice type a startable profile", () => {
    for (const type of BUILD_PRACTICE_TYPES) {
      const profile = BUILD_PRACTICE_PROFILES[type];
      expect(profile.services.length).toBeGreaterThan(0);
      expect(profile.services.length).toBeLessThanOrEqual(BUILD_SERVICE_MAX);
      expect(
        buildDraftSchema.safeParse({
          practiceType: type,
          currentSystem: "paper",
          brandColor: "#0d9488",
          services: profile.services,
        }).success,
      ).toBe(true);
    }
  });

  it("rejects malformed drafts", () => {
    const valid = {
      practiceType: "companion",
      currentSystem: "avimark",
      brandColor: "#2563eb",
      services: [{ name: "Wellness Exam", price: 65 }],
    };
    expect(buildDraftSchema.safeParse(valid).success).toBe(true);
    for (const bad of [
      { ...valid, practiceType: "zoo" },
      { ...valid, brandColor: "blue" },
      { ...valid, services: [{ name: "", price: 1 }] },
      { ...valid, services: [{ name: "Exam", price: -1 }] },
      { ...valid, services: Array(BUILD_SERVICE_MAX + 1).fill({ name: "x", price: 1 }) },
      { ...valid, extra: true },
    ]) {
      expect(buildDraftSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("starts migrating clinics on the import step", () => {
    expect(buildFirstGoal("shepherd")).toBe("import_records");
    expect(buildFirstGoal("paper")).toBe("run_visit");
    expect(buildFirstGoal("other")).toBe("run_visit");
  });

  it("splits visitors independently of the preview experiment", () => {
    expect(builderPercent(undefined)).toBe(0);
    expect(builderPercent("40")).toBe(40);
    expect(inBuilderArm(null, 100)).toBe(false);
    expect(inBuilderArm(uuid(1), 0)).toBe(false);

    let builder = 0;
    let disagreements = 0;
    for (let i = 0; i < 2000; i++) {
      const id = uuid(i);
      const inBuilder = inBuilderArm(id, 50);
      if (inBuilder) builder++;
      if (inBuilder !== (previewArmFor(id, 50) === "preview")) disagreements++;
    }
    expect(builder / 2000).toBeGreaterThan(0.45);
    expect(builder / 2000).toBeLessThan(0.55);
    // Different salts: the two experiments must not assign the same people.
    expect(disagreements).toBeGreaterThan(600);
  });
});
