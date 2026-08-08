export const appointmentStatusValues = [
  "scheduled",
  "confirmed",
  "checked_in",
  "in_exam",
  "checked_out",
  "no_show",
  "cancelled",
] as const;

export type AppointmentStatus = (typeof appointmentStatusValues)[number];

const allowedAppointmentStatusTransitions: Record<
  AppointmentStatus,
  readonly AppointmentStatus[]
> = {
  scheduled: ["confirmed", "checked_in", "no_show", "cancelled"],
  confirmed: ["scheduled", "checked_in", "no_show", "cancelled"],
  checked_in: ["in_exam", "no_show", "cancelled"],
  in_exam: ["checked_out", "cancelled"],
  checked_out: [],
  no_show: ["scheduled"],
  cancelled: ["scheduled"],
};

export function canTransitionAppointmentStatus(
  current: AppointmentStatus,
  next: AppointmentStatus
): boolean {
  if (current === next) return true;
  return allowedAppointmentStatusTransitions[current].includes(next);
}
