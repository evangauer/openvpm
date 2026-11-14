import { describe, expect, it } from "vitest";
import { fieldPreparationTarget, fieldVisitHref } from "../field-navigation";

const patientId = "00000000-0000-4000-8000-000000000001";
const appointmentId = "00000000-0000-4000-8000-000000000002";

describe("field preparation handoff", () => {
  it("keeps patient and appointment identities in the fragment, outside server requests", () => {
    const url = new URL(
      fieldVisitHref(patientId, appointmentId),
      "https://example.invalid",
    );
    expect(url.pathname).toBe("/offline/field.html");
    expect(url.search).toBe("");
    expect(fieldPreparationTarget(url.hash)).toEqual({
      patientId,
      appointmentId,
    });
    expect(
      fieldPreparationTarget(new URL(fieldVisitHref(patientId), url).hash),
    ).toEqual({ patientId });
  });

  it.each([
    "",
    "#field-main",
    "#patientId=invalid",
    `#appointmentId=${appointmentId}`,
    `#patientId=${patientId}&appointmentId=invalid`,
  ])("ignores incomplete or invalid preparation targets: %s", (hash) => {
    expect(fieldPreparationTarget(hash)).toBeNull();
  });
});
