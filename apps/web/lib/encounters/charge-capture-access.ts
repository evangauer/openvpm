export type ChargeCaptureLockReason = "role" | "closed_out" | "not_in_exam";

export type ChargeCaptureLock = {
  reason: ChargeCaptureLockReason;
  message: string;
};

const PRE_EXAM_STATUSES = new Set(["scheduled", "confirmed", "checked_in"]);

/**
 * Explains why charge capture is unavailable for a visit, or returns null when
 * charges can be edited. Charges are editable only for billing roles, while
 * the visit is in exam, and before closeout is completed.
 */
export function getChargeCaptureLock(input: {
  roleCanManageBilling: boolean;
  appointmentStatus: string;
  appointmentStatusLabel?: string;
  closeoutStatus: string | null | undefined;
}): ChargeCaptureLock | null {
  if (!input.roleCanManageBilling) {
    return {
      reason: "role",
      message:
        "Charge capture is read-only for your role. An admin or front desk teammate can add charges and create the invoice.",
    };
  }
  if (input.closeoutStatus === "completed") {
    return {
      reason: "closed_out",
      message:
        "Charge capture is closed because this visit's closeout is complete.",
    };
  }
  if (input.appointmentStatus !== "in_exam") {
    const statusLabel = (
      input.appointmentStatusLabel ?? input.appointmentStatus.replace(/_/g, " ")
    ).toLowerCase();
    return {
      reason: "not_in_exam",
      message: PRE_EXAM_STATUSES.has(input.appointmentStatus)
        ? `Charges open once the visit is in exam. This visit is currently ${statusLabel}.`
        : `Charges can only be added while the visit is in exam. This visit is currently ${statusLabel}.`,
    };
  }
  return null;
}
