import { describe, expect, it } from "vitest";
import {
  handoutSections,
  handoutText,
  type DischargeHandout,
} from "./discharge-handout";

const draft: DischargeHandout = {
  patient: " Clover ",
  contact: "",
  instructions: "First line.\n\nSecond line.",
  warningSigns: "   ",
  followUp: "Call the clinic on Friday.",
};

describe("standalone discharge handouts", () => {
  it("copies the reviewed sections in order and omits unused fields", () => {
    expect(handoutSections(draft)).toEqual([
      { label: "Home care", text: draft.instructions },
      { label: "Follow-up", text: draft.followUp },
    ]);
    expect(handoutText("Example Clinic", draft)).toBe(
      "Discharge instructions for Clover\n\nExample Clinic\n\nHome care\nFirst line.\n\nSecond line.\n\nFollow-up\nCall the clinic on Friday.",
    );
  });

  it("preserves the clinician's exact wording, symbols, and contact", () => {
    const reviewed = handoutText("Example Clinic", {
      ...draft,
      contact: "555-0100",
      warningSigns: "L’appétit < ½ du repas.",
    });
    expect(reviewed).toContain("Example Clinic\n555-0100");
    expect(reviewed).toContain(
      "When to call the clinic\nL’appétit < ½ du repas.",
    );
  });
});
