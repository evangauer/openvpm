import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isWellnessPlanPriceInputValid,
  WELLNESS_PLAN_DESCRIPTION_MAX_LENGTH,
  WELLNESS_PLAN_NAME_MAX_LENGTH,
  WELLNESS_PLAN_PRICE_MAX,
  WELLNESS_PLAN_PRICE_MIN,
  WELLNESS_PLAN_PRICE_SCALE,
} from "../wellness/policy";

describe("wellness settings UI", () => {
  it("keeps wellness plan setup reachable from Settings", () => {
    const source = readFileSync("app/(dashboard)/settings/page.tsx", "utf8");

    expect(source).toContain('"wellness"');
    expect(source).toContain("Wellness Plans");
    expect(source).toContain("trpc.wellness.listPlans.useQuery");
    expect(source).toContain("trpc.wellness.createPlan.useMutation");
    expect(source).toContain("trpc.wellness.setPlanActive.useMutation");
    expect(source).toContain("utils.wellness.listPlans.invalidate");
    expect(source).toContain("utils.wellness.listDue.invalidate");
  });

  it("keeps wellness plan form controls aligned to shared policy", () => {
    const source = readFileSync("app/(dashboard)/settings/page.tsx", "utf8");

    expect(WELLNESS_PLAN_NAME_MAX_LENGTH).toBe(255);
    expect(WELLNESS_PLAN_DESCRIPTION_MAX_LENGTH).toBe(2000);
    expect(WELLNESS_PLAN_PRICE_MIN).toBe(0);
    expect(WELLNESS_PLAN_PRICE_MAX).toBe(99999999.99);
    expect(WELLNESS_PLAN_PRICE_SCALE).toBe(2);
    expect(isWellnessPlanPriceInputValid("25.50")).toBe(true);
    expect(isWellnessPlanPriceInputValid("25.123")).toBe(false);
    expect(isWellnessPlanPriceInputValid("100000000")).toBe(false);
    expect(source).toContain("maxLength={WELLNESS_PLAN_NAME_MAX_LENGTH}");
    expect(source).toContain(
      "maxLength={WELLNESS_PLAN_DESCRIPTION_MAX_LENGTH}"
    );
    expect(source).toContain("min={WELLNESS_PLAN_PRICE_MIN}");
    expect(source).toContain("max={WELLNESS_PLAN_PRICE_MAX}");
    expect(source).toContain("step={10 ** -WELLNESS_PLAN_PRICE_SCALE}");
    expect(source).toContain("isWellnessPlanPriceInputValid(addForm.price)");
    expect(source).toContain(
      "addForm.name.trim().length <= WELLNESS_PLAN_NAME_MAX_LENGTH"
    );
    expect(source).toContain(
      "addForm.description.trim().length <= WELLNESS_PLAN_DESCRIPTION_MAX_LENGTH"
    );
    expect(source).not.toContain("priceValue >= 0 &&");
  });

  it("lets admins retire and restore wellness plans from the settings table", () => {
    const source = readFileSync("app/(dashboard)/settings/page.tsx", "utf8");

    expect(source).toContain("Deactivate");
    expect(source).toContain("Reactivate");
    expect(source).toContain("disabled={setPlanActive.isPending}");
    expect(source).toContain("planId: plan.id");
    expect(source).toContain("active: !plan.active");
    expect(source).toContain("Wellness plan deactivated");
    expect(source).toContain("Wellness plan reactivated");
    expect(source).toContain("colSpan={5}");
  });
});
