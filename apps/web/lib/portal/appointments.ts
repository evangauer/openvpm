import type { AppointmentStatus } from "@/lib/scheduling/appointment-status";

export type PortalAppointmentListItem = {
  startTime: string | Date;
  status: AppointmentStatus | string;
};

const portalUpcomingStatuses = new Set<AppointmentStatus>([
  "scheduled",
  "confirmed",
  "checked_in",
  "in_exam",
]);

const portalActiveVisitStatuses = new Set<AppointmentStatus>([
  "checked_in",
  "in_exam",
]);

function startTimeMs(appointment: PortalAppointmentListItem): number {
  const value = new Date(appointment.startTime).getTime();
  return Number.isNaN(value) ? 0 : value;
}

export function isPortalUpcomingAppointment(
  appointment: PortalAppointmentListItem,
  now = new Date()
): boolean {
  const status = appointment.status as AppointmentStatus;
  if (!portalUpcomingStatuses.has(status)) {
    return false;
  }
  if (portalActiveVisitStatuses.has(status)) {
    return true;
  }
  return startTimeMs(appointment) >= now.getTime();
}

export function splitPortalAppointments<T extends PortalAppointmentListItem>(
  appointments: readonly T[],
  now = new Date()
): { upcoming: T[]; past: T[] } {
  const upcoming: T[] = [];
  const past: T[] = [];

  for (const appointment of appointments) {
    if (isPortalUpcomingAppointment(appointment, now)) {
      upcoming.push(appointment);
    } else {
      past.push(appointment);
    }
  }

  upcoming.sort((a, b) => startTimeMs(a) - startTimeMs(b));
  past.sort((a, b) => startTimeMs(b) - startTimeMs(a));

  return { upcoming, past };
}
