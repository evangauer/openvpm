import { describe, expect, it } from "vitest";
import { usesClinicBuilder } from "../registration-entry";
import { inBuilderArm } from "../build/catalog";

const funnelId = "b85f9426-5b40-45e3-93a5-5bae6d5c3029";

describe("registration entry routing", () => {
  it("sends hosted card-required signups to the enabled builder", () => {
    expect(
      usesClinicBuilder({ cardRequired: true, builderPercent: 100, funnelId }),
    ).toBe(true);
  });
  it("keeps self-hosted, no-card, disabled and unresolved visitors on the standard path", () => {
    expect(
      usesClinicBuilder({ cardRequired: false, builderPercent: 100, funnelId }),
    ).toBe(false);
    expect(
      usesClinicBuilder({ cardRequired: true, builderPercent: 0, funnelId }),
    ).toBe(false);
    expect(usesClinicBuilder({ cardRequired: true, builderPercent: 100 })).toBe(
      false,
    );
  });
  it("preserves the existing experiment assignment for partial rollouts", () => {
    for (const builderPercent of [20, 50, 80]) {
      expect(
        usesClinicBuilder({ cardRequired: true, builderPercent, funnelId }),
      ).toBe(inBuilderArm(funnelId, builderPercent));
    }
  });
});
