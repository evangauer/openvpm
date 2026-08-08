export const PRESCRIPTION_LIFECYCLE_REASON_MAX_LENGTH = 500;
export const PRESCRIPTION_LIFECYCLE_REASON_MIN_LENGTH = 5;

export type PrescriptionStatus =
  | "active"
  | "completed"
  | "cancelled"
  | "expired";

export type PrescriptionEventType =
  | "created"
  | "refill_dispensed"
  | "refill_authorized"
  | "completed"
  | "cancelled"
  | "expired";

export function effectivePrescriptionStatus(input: {
  status: PrescriptionStatus;
  endDate: string | null;
  today: string;
}): PrescriptionStatus {
  if (
    input.status === "active" &&
    input.endDate !== null &&
    input.endDate < input.today
  ) {
    return "expired";
  }
  return input.status;
}

export function isPrescriptionLifecycleReasonValid(value: string): boolean {
  const length = value.trim().length;
  return (
    length >= PRESCRIPTION_LIFECYCLE_REASON_MIN_LENGTH &&
    length <= PRESCRIPTION_LIFECYCLE_REASON_MAX_LENGTH
  );
}

export function prescriptionLifecycleLabel(
  eventType: PrescriptionEventType,
): string {
  switch (eventType) {
    case "created":
      return "Prescription created";
    case "refill_dispensed":
      return "Refill dispensed";
    case "refill_authorized":
      return "External refill authorized";
    case "completed":
      return "Prescription completed";
    case "cancelled":
      return "Prescription cancelled";
    case "expired":
      return "Prescription expired";
  }
}

export function prescriptionLifecycleHistoryLabel(input: {
  eventType: PrescriptionEventType;
  productId: string | null;
  quantity: number | null;
}): string {
  if (
    input.eventType === "created" &&
    input.productId &&
    input.quantity &&
    input.quantity > 0
  ) {
    return `Prescription created and ${input.quantity} dispensed from clinic inventory`;
  }
  return prescriptionLifecycleLabel(input.eventType);
}
