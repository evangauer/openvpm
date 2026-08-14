import { describe, expect, it } from "vitest";
import {
  CLINIC_MODEL_OPTIONS,
  FIRST_GOAL_OPTIONS,
  firstDayTasks,
  onboardingIntentForGoal,
} from "../clinic-profile";

describe("clinic onboarding profile", () => {
  it("keeps every first-day choice stable and coarse", () => {
    expect(CLINIC_MODEL_OPTIONS.map((option) => option.value)).toEqual([
      "companion",
      "mobile",
      "equine",
      "specialty",
      "shelter",
      "exploring",
    ]);
    expect(FIRST_GOAL_OPTIONS.map((option) => option.value)).toEqual([
      "run_visit",
      "import_records",
      "start_fresh",
      "explore_sample",
    ]);
  });

  it("maps outcomes onto the existing safe adoption paths", () => {
    expect(onboardingIntentForGoal("run_visit")).toBe("alongside");
    expect(onboardingIntentForGoal("start_fresh")).toBe("alongside");
    expect(onboardingIntentForGoal("import_records")).toBe("replace");
    expect(onboardingIntentForGoal("explore_sample")).toBe("explore");
    expect(onboardingIntentForGoal("self_host")).toBe("self_host");
  });

  it("uses migration tasks when migration is the chosen first value", () => {
    expect(firstDayTasks("equine", "import_records")).toEqual([
      "Inventory your current export",
      "Preview supported record counts",
      "Review a representative chart",
      "Plan your first live visit",
    ]);
  });

  it("uses honest care-model tasks for a field practice", () => {
    expect(firstDayTasks("mobile", "run_visit")).toEqual([
      "Map one house-call workflow",
      "Add a real client and patient",
      "Test a visit from your phone",
      "Review the field handoff",
    ]);
  });
});
