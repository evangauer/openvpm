import { describe, expect, it } from "vitest";
import { getChargeCaptureLock } from "./charge-capture-access";

const editable = {
  roleCanManageBilling: true,
  appointmentStatus: "in_exam",
  appointmentStatusLabel: "In exam",
  closeoutStatus: "draft",
};

describe("getChargeCaptureLock", () => {
  it("allows editing for billing roles during an open exam", () => {
    expect(getChargeCaptureLock(editable)).toBeNull();
    expect(
      getChargeCaptureLock({ ...editable, closeoutStatus: null }),
    ).toBeNull();
  });

  it("explains role restrictions only for roles without billing access", () => {
    const lock = getChargeCaptureLock({
      ...editable,
      roleCanManageBilling: false,
    });
    expect(lock?.reason).toBe("role");
    expect(lock?.message).toMatch(/read-only for your role/);
  });

  it("tells billing roles charges open once the visit is in exam", () => {
    const lock = getChargeCaptureLock({
      ...editable,
      appointmentStatus: "checked_in",
      appointmentStatusLabel: "Checked in",
    });
    expect(lock).toEqual({
      reason: "not_in_exam",
      message:
        "Charges open once the visit is in exam. This visit is currently Checked in.",
    });
    expect(lock?.message).not.toMatch(/role/);
  });

  it("explains that charges closed after the exam ended", () => {
    const lock = getChargeCaptureLock({
      ...editable,
      appointmentStatus: "checked_out",
      appointmentStatusLabel: "Checked out",
    });
    expect(lock?.reason).toBe("not_in_exam");
    expect(lock?.message).toBe(
      "Charges can only be added while the visit is in exam. This visit is currently Checked out.",
    );
  });

  it("falls back to a readable raw status without a label", () => {
    const lock = getChargeCaptureLock({
      roleCanManageBilling: true,
      appointmentStatus: "no_show",
      closeoutStatus: null,
    });
    expect(lock?.message).toMatch(/currently no show\.$/);
  });

  it("explains completed closeouts", () => {
    const lock = getChargeCaptureLock({
      ...editable,
      closeoutStatus: "completed",
    });
    expect(lock?.reason).toBe("closed_out");
  });

  it("matches the original editability rule", () => {
    for (const roleCanManageBilling of [true, false]) {
      for (const appointmentStatus of ["checked_in", "in_exam", "checked_out"]) {
        for (const closeoutStatus of [null, "draft", "completed"]) {
          const expected =
            roleCanManageBilling &&
            appointmentStatus === "in_exam" &&
            closeoutStatus !== "completed";
          expect(
            getChargeCaptureLock({
              roleCanManageBilling,
              appointmentStatus,
              closeoutStatus,
            }) === null,
          ).toBe(expected);
        }
      }
    }
  });
});
