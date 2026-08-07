"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import { useSession } from "next-auth/react";
import Link from "next/link";
import {
  ChevronLeft,
  ChevronRight,
  Calendar,
  Clock,
  User,
  Filter,
  X,
  Loader2,
  Plus,
  Mail,
  Repeat2,
  Stethoscope,
} from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/common/empty-state";
import { CalendarSubscribe } from "@/components/schedule/calendar-subscribe";
import { cn } from "@/lib/utils";
import { dateInputTimeUtcInstant } from "@/lib/date-input";
import {
  addCalendarDays,
  addCalendarMonths,
  buildMonthGrid,
  buildWeekDays,
  groupByCalendarDate,
  startOfCalendarDay,
  toISODate,
  type CalendarDay,
  type CalendarView,
} from "@/lib/scheduling/calendar-views";
import {
  APPOINTMENT_DURATION_MAX_MINUTES,
  APPOINTMENT_DURATION_MIN_MINUTES,
  APPOINTMENT_DURATION_STEP_MINUTES,
  APPOINTMENT_NOTES_MAX_LENGTH,
  APPOINTMENT_PATIENT_SEARCH_MAX_LENGTH,
  APPOINTMENT_RECURRENCE_INTERVAL_MAX,
  APPOINTMENT_RECURRENCE_INTERVAL_MIN,
  APPOINTMENT_RECURRENCE_OCCURRENCES_MAX,
  APPOINTMENT_RECURRENCE_OCCURRENCES_MIN,
  isAppointmentDateInputValid,
  isAppointmentDurationInputValid,
  isAppointmentNotesInputValid,
  isAppointmentPatientSearchInputValid,
  isAppointmentRecurrenceIntervalInputValid,
  isAppointmentRecurrenceOccurrencesInputValid,
} from "@/lib/scheduling/appointment-policy";
import {
  layoutOverlaps,
  type OverlapPosition,
} from "@/lib/scheduling/overlap-layout";

// --- Constants ---

const START_HOUR = 8;
const END_HOUR = 18;
const HOUR_HEIGHT = 60; // px per hour
const TOTAL_HOURS = END_HOUR - START_HOUR;
const CALENDAR_HEIGHT = TOTAL_HOURS * HOUR_HEIGHT;
const DEFAULT_APPOINTMENT_COLOR = "#0d9488";

type AppointmentStatus =
  | "scheduled"
  | "confirmed"
  | "checked_in"
  | "in_exam"
  | "checked_out"
  | "no_show"
  | "cancelled";

type RecurrenceFrequency = "weekly" | "monthly" | "annual";

const STATUS_COLORS: Record<AppointmentStatus, string> = {
  scheduled: "bg-blue-500",
  confirmed: "bg-blue-500",
  checked_in: "bg-amber-500",
  in_exam: "bg-amber-500",
  checked_out: "bg-green-500",
  no_show: "bg-red-500",
  cancelled: "bg-red-500",
};

const STATUS_LABELS: Record<AppointmentStatus, string> = {
  scheduled: "Scheduled",
  confirmed: "Confirmed",
  checked_in: "Checked In",
  in_exam: "In Exam",
  checked_out: "Checked Out",
  no_show: "No Show",
  cancelled: "Cancelled",
};

function canCreateAppointmentsRole(role?: string | null): boolean {
  return role === "admin" || role === "veterinarian" || role === "front_desk";
}

function canUpdateAppointmentStatusRole(role?: string | null): boolean {
  return (
    role === "admin" ||
    role === "veterinarian" ||
    role === "technician" ||
    role === "front_desk"
  );
}

function canSendAppointmentRemindersRole(role?: string | null): boolean {
  return role === "admin" || role === "front_desk";
}

// --- Helpers ---

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function formatTime(date: Date, timeZone?: string | null): string {
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: timeZone ?? undefined,
  });
}

function getZonedHourMinute(
  date: Date,
  timeZone?: string | null
): { hour: number; minute: number } {
  if (!timeZone) return { hour: date.getHours(), minute: date.getMinutes() };

  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(date);
    const hour = Number(parts.find((part) => part.type === "hour")?.value);
    const minute = Number(parts.find((part) => part.type === "minute")?.value);
    if (Number.isFinite(hour) && Number.isFinite(minute)) {
      return { hour, minute };
    }
  } catch {
    // Fall back to browser-local positioning if the saved timezone is invalid.
  }

  return { hour: date.getHours(), minute: date.getMinutes() };
}

function formatTimeInput(date: Date, timeZone?: string | null): string {
  const { hour, minute } = getZonedHourMinute(date, timeZone);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function appointmentDurationMinutes(start: Date, end: Date): number {
  const minutes = Math.round((end.getTime() - start.getTime()) / 60000);
  return isAppointmentDurationInputValid(minutes) ? minutes : 30;
}

function getTopOffset(time: Date, timeZone?: string | null): number {
  const { hour, minute } = getZonedHourMinute(time, timeZone);
  const hours = hour + minute / 60;
  return (hours - START_HOUR) * HOUR_HEIGHT;
}

function getAppointmentLayout(
  start: Date,
  end: Date,
  timeZone?: string | null
): {
  top: number;
  height: number;
} {
  const rawTop = getTopOffset(start, timeZone);
  const rawBottom = getTopOffset(end, timeZone);
  const top = Math.min(Math.max(rawTop, 0), CALENDAR_HEIGHT - 20);
  const bottom = Math.min(Math.max(rawBottom, top + 20), CALENDAR_HEIGHT);
  return { top, height: bottom - top };
}

function getAppointmentColor(appointment: Appointment): string {
  return appointment.typeColor || DEFAULT_APPOINTMENT_COLOR;
}

function sortAppointments(appointments: Appointment[]): Appointment[] {
  return [...appointments].sort(
    (a, b) =>
      new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
  );
}

/** Side-by-side columns for concurrent appointments (never stacked). */
function buildOverlapLayout(
  appointments: Appointment[]
): Map<string, OverlapPosition> {
  return layoutOverlaps(
    appointments.map((appt) => ({
      id: appt.id,
      startMs: new Date(appt.startTime).getTime(),
      endMs: new Date(appt.endTime).getTime(),
    }))
  );
}

/**
 * One lane per doctor for the day view, derived from the day's own
 * appointments (works even when the only provider is the practice admin).
 * Unassigned appointments (tech work like nail trims) share a Team lane.
 */
function buildDayLanes(
  appointments: Appointment[]
): { key: string; label: string; appointments: Appointment[] }[] {
  const byDoctor = new Map<string, { label: string; appointments: Appointment[] }>();
  for (const appt of appointments) {
    const key = appt.doctorId ?? "team";
    const existing = byDoctor.get(key);
    if (existing) {
      existing.appointments.push(appt);
    } else {
      byDoctor.set(key, {
        label: appt.doctorId ? appt.doctorName ?? "Doctor" : "Team",
        appointments: [appt],
      });
    }
  }
  const lanes = [...byDoctor.entries()].map(([key, lane]) => ({
    key,
    label: lane.label,
    appointments: lane.appointments,
  }));
  // Doctors alphabetically, the shared Team lane last.
  lanes.sort((a, b) => {
    if (a.key === "team") return 1;
    if (b.key === "team") return -1;
    return a.label.localeCompare(b.label);
  });
  return lanes;
}

function formatToolbarDate(date: Date, view: CalendarView): string {
  if (view === "month") {
    return date.toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
    });
  }

  if (view === "week") {
    const days = buildWeekDays(date);
    const start = days[0]!;
    const end = days[6]!;
    const sameMonth =
      start.getMonth() === end.getMonth() &&
      start.getFullYear() === end.getFullYear();

    if (sameMonth) {
      return `${start.toLocaleDateString("en-US", {
        month: "short",
      })} ${start.getDate()}-${end.getDate()}, ${end.getFullYear()}`;
    }

    return `${start.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    })} - ${end.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    })}`;
  }

  return formatDate(date);
}

function getSnappedTimeFromY(y: number): string {
  const hoursFromTop = y / HOUR_HEIGHT;
  const totalMinutes = Math.round((START_HOUR + hoursFromTop) * 60);
  const snapped = Math.round(totalMinutes / 30) * 30;
  const clamped = Math.min(
    Math.max(snapped, START_HOUR * 60),
    (END_HOUR - 0.5) * 60
  );
  const hour = Math.floor(clamped / 60);
  const min = clamped % 60;
  return `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function appointmentInstantFromDateAndTime(
  date: string,
  time: string,
  timeZone?: string | null
): Date {
  const [hour = 0, minute = 0] = time.split(":").map(Number);
  return dateInputTimeUtcInstant(date, { hour, minute }, timeZone);
}

// --- Types for appointment from API ---

type Appointment = {
  id: string;
  startTime: Date | string;
  endTime: Date | string;
  status: string;
  notes: string | null;
  recurringSeriesId: string | null;
  patientName: string | null;
  patientSpecies: string | null;
  patientId: string | null;
  clientFirstName: string | null;
  clientLastName: string | null;
  clientId: string | null;
  doctorName: string | null;
  doctorId: string | null;
  typeName: string | null;
  typeColor: string | null;
  typeDuration: number | null;
  roomName: string | null;
};

// --- Components ---

function StatusDot({ status }: { status: string }) {
  const colorClass = STATUS_COLORS[status as AppointmentStatus] || "bg-gray-400";
  return (
    <span
      className={cn("inline-block h-2 w-2 rounded-full shrink-0", colorClass)}
    />
  );
}

function TimeSlots() {
  const slots = [];
  for (let hour = START_HOUR; hour <= END_HOUR; hour++) {
    const label =
      hour === 0
        ? "12 AM"
        : hour < 12
          ? `${hour} AM`
          : hour === 12
            ? "12 PM"
            : `${hour - 12} PM`;
    slots.push(
      <div
        key={hour}
        className="relative"
        style={{ height: hour < END_HOUR ? HOUR_HEIGHT : 0 }}
      >
        <span className="absolute -top-3 right-3 text-xs text-muted-foreground select-none">
          {label}
        </span>
      </div>
    );
  }
  return <div className="w-16 shrink-0 pt-0">{slots}</div>;
}

function GridLines() {
  const lines = [];
  for (let hour = START_HOUR; hour < END_HOUR; hour++) {
    lines.push(
      <div
        key={`h-${hour}`}
        className="absolute left-0 right-0 border-t border-border"
        style={{ top: (hour - START_HOUR) * HOUR_HEIGHT }}
      />
    );
    // Half-hour dashed line
    lines.push(
      <div
        key={`hh-${hour}`}
        className="absolute left-0 right-0 border-t border-border/40 border-dashed"
        style={{ top: (hour - START_HOUR) * HOUR_HEIGHT + HOUR_HEIGHT / 2 }}
      />
    );
  }
  // Bottom line
  lines.push(
    <div
      key="bottom"
      className="absolute left-0 right-0 border-t border-border"
      style={{ top: TOTAL_HOURS * HOUR_HEIGHT }}
    />
  );
  return <>{lines}</>;
}

function AppointmentBlock({
  appointment,
  timeZone,
  onClick,
  position,
}: {
  appointment: Appointment;
  timeZone?: string | null;
  onClick: () => void;
  position?: OverlapPosition;
}) {
  const start = new Date(appointment.startTime);
  const end = new Date(appointment.endTime);
  const { top, height } = getAppointmentLayout(start, end, timeZone);
  const bgColor = getAppointmentColor(appointment);
  // Concurrent appointments split the column width; a lone appointment
  // keeps the old full-width look.
  const widthPct = 100 / (position?.columns ?? 1);
  const leftPct = (position?.column ?? 0) * widthPct;

  return (
    <button
      type="button"
      onClick={onClick}
      className="absolute rounded-md px-2 py-1 text-left text-xs overflow-hidden cursor-pointer transition-opacity hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1"
      style={{
        top,
        height,
        left: `calc(${leftPct}% + 3px)`,
        width: `calc(${widthPct}% - 6px)`,
        backgroundColor: `${bgColor}20`,
        borderLeft: `3px solid ${bgColor}`,
      }}
    >
      <div className="flex items-center gap-1.5 font-medium text-foreground truncate">
        <StatusDot status={appointment.status} />
        <span className="truncate">{appointment.patientName || "Unknown Patient"}</span>
      </div>
      {height >= 36 && (
        <div className="text-muted-foreground truncate mt-0.5">
          {appointment.typeName || "Appointment"} &middot;{" "}
          {formatTime(start, timeZone)} - {formatTime(end, timeZone)}
        </div>
      )}
    </button>
  );
}

function DayCalendar({
  appointments,
  timeZone,
  showNowLine,
  nowTop,
  onSlotClick,
  onAppointmentClick,
}: {
  appointments: Appointment[];
  timeZone?: string | null;
  showNowLine: boolean;
  nowTop: number;
  onSlotClick?: (y: number) => void;
  onAppointmentClick: (appointment: Appointment) => void;
}) {
  // A real clinic day: one lane per doctor (plus a Team lane for
  // unassigned/tech work). With one provider or none it stays the single
  // clean column it always was.
  const lanes = buildDayLanes(appointments);
  const showLanes = lanes.length > 1;

  const laneColumn = (laneAppointments: Appointment[], key: string) => {
    const layout = buildOverlapLayout(laneAppointments);
    return (
      <div
        key={key}
        className={cn(
          "relative flex-1 border-l border-border",
          onSlotClick && "cursor-pointer"
        )}
        style={{ height: CALENDAR_HEIGHT, minWidth: showLanes ? 160 : undefined }}
        onClick={(e) => {
          if (!onSlotClick) return;
          if ((e.target as HTMLElement).closest("button")) return;
          const rect = e.currentTarget.getBoundingClientRect();
          onSlotClick(e.clientY - rect.top);
        }}
      >
        <GridLines />

        {showNowLine && (
          <div
            className="absolute left-0 right-0 z-10 flex items-center"
            style={{ top: nowTop }}
          >
            <div className="h-2.5 w-2.5 rounded-full bg-red-500 -ml-1" />
            <div className="flex-1 border-t-2 border-red-500" />
          </div>
        )}

        {laneAppointments.map((appt) => (
          <AppointmentBlock
            key={appt.id}
            appointment={appt}
            timeZone={timeZone}
            onClick={() => onAppointmentClick(appt)}
            position={layout.get(appt.id)}
          />
        ))}
      </div>
    );
  };

  return (
    <div className="mt-4 overflow-hidden rounded-lg border border-border bg-card">
      <div className="overflow-x-auto">
        <div
          style={{
            minWidth: showLanes ? 64 + lanes.length * 160 : undefined,
          }}
        >
          {showLanes && (
            <div className="flex border-b border-border bg-muted/30">
              <div className="w-16 shrink-0" />
              {lanes.map((lane) => (
                <div
                  key={lane.key}
                  className="flex-1 border-l border-border px-3 py-2"
                  style={{ minWidth: 160 }}
                >
                  <p className="truncate text-sm font-medium">{lane.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {lane.appointments.length} appointment
                    {lane.appointments.length !== 1 ? "s" : ""}
                  </p>
                </div>
              ))}
            </div>
          )}

          <div
            className="flex overflow-y-auto"
            style={{ maxHeight: "calc(100vh - 220px)" }}
          >
            <TimeSlots />

            {appointments.length > 0 ? (
              showLanes ? (
                lanes.map((lane) => laneColumn(lane.appointments, lane.key))
              ) : (
                laneColumn(appointments, "all")
              )
            ) : (
              <div
                className={cn(
                  "relative flex-1 border-l border-border",
                  onSlotClick && "cursor-pointer"
                )}
                style={{ height: CALENDAR_HEIGHT }}
                onClick={(e) => {
                  if (!onSlotClick) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  onSlotClick(e.clientY - rect.top);
                }}
              >
                <GridLines />
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div className="text-center">
                    <Calendar className="mx-auto h-8 w-8 text-muted-foreground/40" />
                    <p className="mt-2 text-sm text-muted-foreground">
                      No appointments for this day
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {appointments.length > 0 && (
        <div className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
          {appointments.length} appointment{appointments.length !== 1 ? "s" : ""}
          {showLanes && ` · ${lanes.length} lanes`}
        </div>
      )}
    </div>
  );
}

function WeekCalendar({
  days,
  appointmentsByDate,
  timeZone,
  todayKey,
  showNowLine,
  nowTop,
  onSlotClick,
  onAppointmentClick,
}: {
  days: Date[];
  appointmentsByDate: Record<string, Appointment[]>;
  timeZone?: string | null;
  todayKey: string;
  showNowLine: boolean;
  nowTop: number;
  onSlotClick?: (date: Date, y: number) => void;
  onAppointmentClick: (appointment: Appointment) => void;
}) {
  return (
    <div className="mt-4 overflow-hidden rounded-lg border border-border bg-card">
      <div className="overflow-auto">
        <div className="min-w-[920px]">
          <div className="flex border-b border-border bg-muted/30">
            <div className="w-16 shrink-0" />
            <div className="grid flex-1 grid-cols-7">
              {days.map((day) => {
                const key = toISODate(day);
                const dayAppointments = appointmentsByDate[key] ?? [];
                const isToday = key === todayKey;

                return (
                  <div
                    key={key}
                    className={cn(
                      "border-l border-border px-3 py-2",
                      isToday && "bg-primary/5"
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <p className="text-xs font-medium uppercase text-muted-foreground">
                          {day.toLocaleDateString("en-US", { weekday: "short" })}
                        </p>
                        <p
                          className={cn(
                            "text-lg font-semibold",
                            isToday && "text-primary"
                          )}
                        >
                          {day.getDate()}
                        </p>
                      </div>
                      <span className="rounded-full bg-background px-2 py-0.5 text-xs text-muted-foreground">
                        {dayAppointments.length}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex overflow-auto" style={{ maxHeight: "calc(100vh - 270px)" }}>
            <TimeSlots />
            <div className="grid flex-1 grid-cols-7" style={{ height: CALENDAR_HEIGHT }}>
              {days.map((day) => {
                const key = toISODate(day);
                const isToday = key === todayKey;
                const dayAppointments = sortAppointments(appointmentsByDate[key] ?? []);
                const dayLayout = buildOverlapLayout(dayAppointments);

                return (
                  <div
                    key={key}
                    className={cn(
                      "relative border-l border-border",
                      onSlotClick && "cursor-pointer",
                      isToday && "bg-primary/5"
                    )}
                    onClick={(e) => {
                      if (!onSlotClick) return;
                      if ((e.target as HTMLElement).closest("button")) return;
                      const rect = e.currentTarget.getBoundingClientRect();
                      onSlotClick(day, e.clientY - rect.top);
                    }}
                  >
                    <GridLines />
                    {showNowLine && isToday && (
                      <div
                        className="absolute left-0 right-0 z-10 flex items-center"
                        style={{ top: nowTop }}
                      >
                        <div className="h-2.5 w-2.5 rounded-full bg-red-500 -ml-1" />
                        <div className="flex-1 border-t-2 border-red-500" />
                      </div>
                    )}
                    {dayAppointments.map((appt) => (
                      <AppointmentBlock
                        key={appt.id}
                        appointment={appt}
                        timeZone={timeZone}
                        onClick={() => onAppointmentClick(appt)}
                        position={dayLayout.get(appt.id)}
                      />
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function AppointmentChip({
  appointment,
  timeZone,
  onClick,
}: {
  appointment: Appointment;
  timeZone?: string | null;
  onClick: () => void;
}) {
  const start = new Date(appointment.startTime);
  const color = getAppointmentColor(appointment);

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-6 w-full items-center gap-1.5 rounded-md border px-2 py-1 text-left text-[11px] leading-tight transition-opacity hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1"
      style={{
        backgroundColor: `${color}18`,
        borderColor: `${color}55`,
      }}
    >
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
      />
      <span className="min-w-0 flex-1 truncate">
        {formatTime(start, timeZone)} {appointment.patientName || "Unknown"}
      </span>
    </button>
  );
}

function MonthCalendar({
  days,
  appointmentsByDate,
  currentDate,
  timeZone,
  todayKey,
  canCreateAppointments,
  onCreateClick,
  onDayOpen,
  onAppointmentClick,
}: {
  days: CalendarDay[];
  appointmentsByDate: Record<string, Appointment[]>;
  currentDate: Date;
  timeZone?: string | null;
  todayKey: string;
  canCreateAppointments: boolean;
  onCreateClick: (date: Date) => void;
  onDayOpen: (date: Date) => void;
  onAppointmentClick: (appointment: Appointment) => void;
}) {
  const weekLabels = buildWeekDays(currentDate).map((day) =>
    day.toLocaleDateString("en-US", { weekday: "short" })
  );

  return (
    <div className="mt-4 overflow-hidden rounded-lg border border-border bg-card">
      <div className="grid grid-cols-7 border-b border-border bg-muted/30">
        {weekLabels.map((label) => (
          <div
            key={label}
            className="border-l border-border px-3 py-2 first:border-l-0"
          >
            <p className="text-xs font-medium uppercase text-muted-foreground">
              {label}
            </p>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {days.map((day) => {
          const appointments = sortAppointments(
            appointmentsByDate[day.dateKey] ?? []
          );
          const isToday = day.dateKey === todayKey;
          const visibleAppointments = appointments.slice(0, 3);
          const hiddenCount = appointments.length - visibleAppointments.length;

          return (
            <div
              key={day.dateKey}
              className={cn(
                "min-h-[8.5rem] border-l border-t border-border p-2 first:border-l-0",
                !day.isCurrentMonth && "bg-muted/20 text-muted-foreground",
                isToday && "bg-primary/5"
              )}
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <button
                  type="button"
                  className={cn(
                    "h-7 min-w-7 rounded-md px-2 text-sm font-medium hover:bg-muted focus:outline-none focus:ring-2 focus:ring-ring",
                    isToday && "bg-primary text-primary-foreground hover:bg-primary/90"
                  )}
                  onClick={() => onDayOpen(day.date)}
                >
                  {day.date.getDate()}
                </button>
                {canCreateAppointments && (
                  <button
                    type="button"
                    className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                    onClick={() => onCreateClick(day.date)}
                    aria-label={`Create appointment on ${day.date.toLocaleDateString(
                      "en-US"
                    )}`}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              <div className="space-y-1">
                {visibleAppointments.map((appt) => (
                  <AppointmentChip
                    key={appt.id}
                    appointment={appt}
                    timeZone={timeZone}
                    onClick={() => onAppointmentClick(appt)}
                  />
                ))}
                {hiddenCount > 0 && (
                  <button
                    type="button"
                    className="w-full rounded-md px-2 py-1 text-left text-[11px] font-medium text-muted-foreground hover:bg-muted focus:outline-none focus:ring-2 focus:ring-ring"
                    onClick={() => onDayOpen(day.date)}
                  >
                    +{hiddenCount} more
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AppointmentDetailPopover({
  appointment,
  timeZone,
  onClose,
  onStatusChange,
  onReschedule,
  onCancelRecurringSeries,
  canUpdateStatus,
  canManageSchedule,
  canSendReminders,
  isUpdating,
  isRescheduling,
  isCancellingSeries,
}: {
  appointment: Appointment;
  timeZone?: string | null;
  onClose: () => void;
  onStatusChange: (id: string, status: AppointmentStatus) => void;
  onReschedule: (input: {
    id: string;
    startTime: string;
    endTime: string;
  }) => void;
  onCancelRecurringSeries: (seriesId: string) => void;
  canUpdateStatus: boolean;
  canManageSchedule: boolean;
  canSendReminders: boolean;
  isUpdating: boolean;
  isRescheduling: boolean;
  isCancellingSeries: boolean;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const start = new Date(appointment.startTime);
  const end = new Date(appointment.endTime);
  const [showRescheduleForm, setShowRescheduleForm] = useState(false);
  const [rescheduleDate, setRescheduleDate] = useState(() =>
    toISODate(start, timeZone)
  );
  const [rescheduleTime, setRescheduleTime] = useState(() =>
    formatTimeInput(start, timeZone)
  );
  const [rescheduleDuration, setRescheduleDuration] = useState(() =>
    appointmentDurationMinutes(start, end)
  );

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [onClose]);

  useEffect(() => {
    setShowRescheduleForm(false);
    setRescheduleDate(toISODate(start, timeZone));
    setRescheduleTime(formatTimeInput(start, timeZone));
    setRescheduleDuration(appointmentDurationMinutes(start, end));
  }, [appointment.id, appointment.startTime, appointment.endTime, timeZone]);

  const clientName = [appointment.clientFirstName, appointment.clientLastName]
    .filter(Boolean)
    .join(" ") || "Unknown Client";

  const statusActions: { label: string; status: AppointmentStatus; variant: "default" | "outline" | "destructive" }[] = [];
  const current = appointment.status as AppointmentStatus;
  const canMoveAppointment = current === "scheduled" || current === "confirmed";

  if (current === "scheduled" || current === "confirmed") {
    statusActions.push({ label: "Check In", status: "checked_in", variant: "default" });
    statusActions.push({ label: "No Show", status: "no_show", variant: "outline" });
    statusActions.push({ label: "Cancel", status: "cancelled", variant: "destructive" });
  } else if (current === "checked_in" || current === "in_exam") {
    statusActions.push({ label: "Check Out", status: "checked_out", variant: "default" });
    if (current === "checked_in") {
      statusActions.push({ label: "In Exam", status: "in_exam", variant: "outline" });
    }
    statusActions.push({ label: "No Show", status: "no_show", variant: "outline" });
  } else if (current === "no_show" || current === "cancelled") {
    statusActions.push({ label: "Reopen", status: "scheduled", variant: "outline" });
  }
  const visibleStatusActions = canUpdateStatus ? statusActions : [];
  const canSubmitReschedule =
    isAppointmentDateInputValid(rescheduleDate) &&
    isAppointmentDurationInputValid(rescheduleDuration) &&
    !isRescheduling;

  const handleReschedule = () => {
    if (!canSubmitReschedule) return;
    const startDt = appointmentInstantFromDateAndTime(
      rescheduleDate,
      rescheduleTime,
      timeZone
    );
    const endDt = new Date(startDt.getTime() + rescheduleDuration * 60 * 1000);
    onReschedule({
      id: appointment.id,
      startTime: startDt.toISOString(),
      endTime: endDt.toISOString(),
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div
        ref={popoverRef}
        className="w-full max-w-sm rounded-lg border border-border bg-card shadow-lg"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <StatusDot status={appointment.status} />
            <span className="text-sm font-medium">
              {STATUS_LABELS[current] || appointment.status}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 hover:bg-muted transition-colors"
          >
            <X className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>

        {/* Body */}
        <div className="px-4 py-3 space-y-3">
          <div>
            <h3 className="font-semibold text-base">
              {appointment.patientName || "Unknown Patient"}
            </h3>
            {appointment.patientSpecies && (
              <p className="text-xs text-muted-foreground">{appointment.patientSpecies}</p>
            )}
          </div>

          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2 text-muted-foreground">
              <User className="h-3.5 w-3.5" />
              <span>Client: {clientName}</span>
            </div>
            <div className="flex items-center gap-2 text-muted-foreground">
              <Clock className="h-3.5 w-3.5" />
              <span>
                {formatTime(start, timeZone)} - {formatTime(end, timeZone)}
              </span>
            </div>
            {appointment.doctorName && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <User className="h-3.5 w-3.5" />
                <span>Dr. {appointment.doctorName}</span>
              </div>
            )}
            {appointment.typeName && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Calendar className="h-3.5 w-3.5" />
                <span>{appointment.typeName}</span>
              </div>
            )}
            {appointment.recurringSeriesId && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Repeat2 className="h-3.5 w-3.5" />
                <span>Recurring series</span>
              </div>
            )}
            {appointment.roomName && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <span className="ml-0.5 h-3.5 w-3.5 text-center text-xs font-bold">#</span>
                <span>{appointment.roomName}</span>
              </div>
            )}
            {appointment.notes && (
              <p className="text-muted-foreground text-xs mt-1 bg-muted/50 rounded p-2">
                {appointment.notes}
              </p>
            )}
          </div>
        </div>

        {showRescheduleForm && (
          <div className="border-t border-border px-4 py-3">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground">
                  Date
                </label>
                <Input
                  type="date"
                  value={rescheduleDate}
                  aria-invalid={!isAppointmentDateInputValid(rescheduleDate)}
                  onChange={(e) => setRescheduleDate(e.target.value)}
                  className="mt-1 h-9 text-sm"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">
                  Time
                </label>
                <select
                  value={rescheduleTime}
                  onChange={(e) => setRescheduleTime(e.target.value)}
                  className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  {TIME_SLOTS.map((slot) => (
                    <option key={slot.value} value={slot.value}>
                      {slot.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">
                  Duration
                </label>
                <Input
                  type="number"
                  min={APPOINTMENT_DURATION_MIN_MINUTES}
                  max={APPOINTMENT_DURATION_MAX_MINUTES}
                  step={APPOINTMENT_DURATION_STEP_MINUTES}
                  value={rescheduleDuration}
                  aria-invalid={!isAppointmentDurationInputValid(rescheduleDuration)}
                  onChange={(e) => setRescheduleDuration(Number(e.target.value))}
                  className="mt-1 h-9 text-sm"
                />
              </div>
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setShowRescheduleForm(false)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={!canSubmitReschedule}
                onClick={handleReschedule}
              >
                {isRescheduling && (
                  <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                )}
                Move Appointment
              </Button>
            </div>
          </div>
        )}

        {/* Actions */}
        {(appointment.id ||
          appointment.patientId ||
          visibleStatusActions.length > 0 ||
          (canManageSchedule && canMoveAppointment) ||
          (canManageSchedule && appointment.recurringSeriesId) ||
          (canSendReminders &&
            (current === "scheduled" || current === "confirmed"))) && (
          <div className="flex flex-wrap gap-2 border-t border-border px-4 py-3">
            <Button size="sm" asChild>
              <Link href={`/encounters/${appointment.id}`}>
                <Stethoscope className="mr-1.5 h-3 w-3" />
                Open visit
              </Link>
            </Button>
            {appointment.patientId && (
              <Button size="sm" variant="outline" asChild>
                <Link href={`/patients/${appointment.patientId}`}>View chart</Link>
              </Button>
            )}
            {canManageSchedule && canMoveAppointment && (
              <Button
                size="sm"
                variant="outline"
                disabled={isRescheduling}
                onClick={() => setShowRescheduleForm((show) => !show)}
              >
                <Clock className="mr-1.5 h-3 w-3" />
                Reschedule
              </Button>
            )}
            {canSendReminders &&
              (current === "scheduled" || current === "confirmed") && (
              <SendReminderButton appointmentId={appointment.id} />
            )}
            {canManageSchedule && appointment.recurringSeriesId && (
              <Button
                size="sm"
                variant="destructive"
                disabled={isCancellingSeries}
                onClick={() => onCancelRecurringSeries(appointment.recurringSeriesId!)}
              >
                {isCancellingSeries ? (
                  <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                ) : (
                  <Repeat2 className="mr-1.5 h-3 w-3" />
                )}
                Cancel Future Series
              </Button>
            )}
            {visibleStatusActions.map((action) => (
              <Button
                key={action.status}
                size="sm"
                variant={action.variant}
                disabled={isUpdating}
                onClick={() => onStatusChange(appointment.id, action.status)}
              >
                {isUpdating ? (
                  <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                ) : null}
                {action.label}
              </Button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SendReminderButton({ appointmentId }: { appointmentId: string }) {
  const sendReminder = trpc.notifications.sendAppointmentReminder.useMutation({
    onSuccess: () => {
      toast.success("Reminder sent");
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={sendReminder.isPending}
      onClick={() => sendReminder.mutate({ appointmentId })}
    >
      {sendReminder.isPending ? (
        <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
      ) : (
        <Mail className="mr-1.5 h-3 w-3" />
      )}
      Send Reminder
    </Button>
  );
}

// --- Time slot helpers for booking form ---

function generateTimeSlots(): { label: string; value: string }[] {
  const slots: { label: string; value: string }[] = [];
  for (let hour = 8; hour <= 17; hour++) {
    for (const min of [0, 30]) {
      if (hour === 17 && min > 30) break;
      const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
      const ampm = hour < 12 ? "AM" : "PM";
      const label = `${h12}:${String(min).padStart(2, "0")} ${ampm}`;
      const value = `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
      slots.push({ label, value });
    }
  }
  return slots;
}

const TIME_SLOTS = generateTimeSlots();

function useDebounce(value: string, delay: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function BookingForm({
  onClose,
  defaultDate,
  defaultTime,
  timeZone,
}: {
  onClose: () => void;
  defaultDate: Date;
  defaultTime?: string;
  timeZone?: string | null;
}) {
  const modalRef = useRef<HTMLDivElement>(null);
  const utils = trpc.useUtils();

  // Form state
  const [patientSearch, setPatientSearch] = useState("");
  const [selectedPatient, setSelectedPatient] = useState<{
    id: string;
    name: string;
    species: string | null;
    clientFirstName: string | null;
    clientLastName: string | null;
  } | null>(null);
  const [showPatientDropdown, setShowPatientDropdown] = useState(false);
  const [typeId, setTypeId] = useState("");
  const [doctorId, setDoctorId] = useState("");
  const [roomId, setRoomId] = useState("");
  const [date, setDate] = useState(toISODate(defaultDate));
  const [startTime, setStartTime] = useState(defaultTime || "09:00");
  const [duration, setDuration] = useState(30);
  const [notes, setNotes] = useState("");
  const [isRecurring, setIsRecurring] = useState(false);
  const [recurrenceFrequency, setRecurrenceFrequency] =
    useState<RecurrenceFrequency>("weekly");
  const [recurrenceInterval, setRecurrenceInterval] = useState(1);
  const [recurrenceOccurrences, setRecurrenceOccurrences] = useState(4);

  const debouncedSearch = useDebounce(patientSearch, 300);
  const canSearchPatients = isAppointmentPatientSearchInputValid(patientSearch);
  const canRunPatientSearch =
    debouncedSearch.trim().length >= 1 &&
    isAppointmentPatientSearchInputValid(debouncedSearch);
  const hasPatientSearch = patientSearch.trim().length > 0;
  const hasValidDate = isAppointmentDateInputValid(date);
  const hasValidDuration = isAppointmentDurationInputValid(duration);
  const hasValidNotes = isAppointmentNotesInputValid(notes);
  const hasValidRecurrenceInterval =
    isAppointmentRecurrenceIntervalInputValid(recurrenceInterval);
  const hasValidRecurrenceOccurrences =
    isAppointmentRecurrenceOccurrencesInputValid(recurrenceOccurrences);
  const hasRecurringPatient = !isRecurring || Boolean(selectedPatient?.id);

  // Queries
  const {
    data: searchResults,
    isLoading: isSearchingPatients,
    error: patientSearchError,
  } = trpc.patients.search.useQuery(
    { query: debouncedSearch },
    {
      enabled: canRunPatientSearch,
    }
  );
  const patientSearchMissing =
    canRunPatientSearch &&
    !selectedPatient &&
    !isSearchingPatients &&
    !patientSearchError &&
    !searchResults;
  const appointmentTypesQuery = trpc.appointments.listTypes.useQuery();
  const doctorsQuery = trpc.appointments.listDoctors.useQuery();
  const roomsQuery = trpc.appointments.listRooms.useQuery();
  const appointmentTypes = appointmentTypesQuery.data;
  const doctors = doctorsQuery.data;
  const roomsList = roomsQuery.data;
  const appointmentTypesMissing =
    !appointmentTypesQuery.isLoading &&
    !appointmentTypesQuery.error &&
    !appointmentTypes;
  const doctorsMissing =
    !doctorsQuery.isLoading && !doctorsQuery.error && !doctors;
  const roomsMissing = !roomsQuery.isLoading && !roomsQuery.error && !roomsList;
  const appointmentTypesUnavailable =
    appointmentTypesQuery.isLoading ||
    Boolean(appointmentTypesQuery.error) ||
    appointmentTypesMissing;
  const doctorsUnavailable =
    doctorsQuery.isLoading || Boolean(doctorsQuery.error) || doctorsMissing;
  const roomsUnavailable =
    roomsQuery.isLoading || Boolean(roomsQuery.error) || roomsMissing;

  const createAppointment = trpc.appointments.create.useMutation({
    onSuccess: () => {
      toast.success("Appointment created");
      utils.appointments.list.invalidate();
      onClose();
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const createRecurringAppointment = trpc.appointments.createRecurring.useMutation({
    onSuccess: (result) => {
      const skippedMessage =
        result.skipped > 0 ? `; skipped ${result.skipped} conflicts` : "";
      toast.success(
        `Created ${result.created} recurring appointments${skippedMessage}`
      );
      utils.appointments.list.invalidate();
      onClose();
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const canSaveAppointment =
    hasValidDate &&
    hasValidDuration &&
    hasValidNotes &&
    hasRecurringPatient &&
    (!isRecurring ||
      (hasValidRecurrenceInterval && hasValidRecurrenceOccurrences)) &&
    !createAppointment.isPending &&
    !createRecurringAppointment.isPending;

  // When appointment type changes, update duration
  useEffect(() => {
    if (typeId && appointmentTypes) {
      const found = appointmentTypes.find((t) => t.id === typeId);
      if (found?.durationMinutes) {
        setDuration(found.durationMinutes);
      }
    }
  }, [typeId, appointmentTypes]);

  // Close on escape / click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [onClose]);

  const handleSave = () => {
    if (!canSaveAppointment) return;
    const startDt = appointmentInstantFromDateAndTime(
      date,
      startTime,
      timeZone
    );
    const endDt = new Date(startDt.getTime() + duration * 60 * 1000);

    if (isRecurring) {
      if (!selectedPatient?.id) return;
      createRecurringAppointment.mutate({
        patientId: selectedPatient.id,
        startTime: startDt.toISOString(),
        endTime: endDt.toISOString(),
        frequency: recurrenceFrequency,
        interval: recurrenceInterval,
        occurrences: recurrenceOccurrences,
        typeId: typeId || undefined,
        doctorId: doctorId || undefined,
        roomId: roomId || undefined,
        notes: notes.trim() || undefined,
      });
      return;
    }

    createAppointment.mutate({
      startTime: startDt.toISOString(),
      endTime: endDt.toISOString(),
      patientId: selectedPatient?.id,
      typeId: typeId || undefined,
      doctorId: doctorId || undefined,
      roomId: roomId || undefined,
      notes: notes.trim() || undefined,
    });
  };

  const clientName = selectedPatient
    ? [selectedPatient.clientFirstName, selectedPatient.clientLastName]
        .filter(Boolean)
        .join(" ")
    : "";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div
        ref={modalRef}
        className="w-full max-w-md rounded-lg border border-border bg-card shadow-lg max-h-[90vh] overflow-y-auto"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h3 className="text-sm font-semibold">New Appointment</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 hover:bg-muted transition-colors"
          >
            <X className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>

        {/* Body */}
        <div className="px-4 py-3 space-y-4">
          {/* Patient search */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">Patient</label>
            {selectedPatient ? (
              <div className="mt-1 flex items-center gap-2 rounded-md border border-input bg-muted/50 px-3 py-2 text-sm">
                <span className="flex-1">
                  {selectedPatient.name}
                  {selectedPatient.species && (
                    <span className="text-muted-foreground"> ({selectedPatient.species})</span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedPatient(null);
                    setPatientSearch("");
                  }}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <div className="relative mt-1">
                <Input
                  placeholder="Search patients..."
                  value={patientSearch}
                  maxLength={APPOINTMENT_PATIENT_SEARCH_MAX_LENGTH}
                  aria-invalid={!canSearchPatients}
                  onChange={(e) => {
                    setPatientSearch(e.target.value);
                    setShowPatientDropdown(true);
                  }}
                  onFocus={() => setShowPatientDropdown(true)}
                  className="h-9 text-sm"
                />
                {showPatientDropdown &&
                  hasPatientSearch &&
                  canSearchPatients &&
                  (isSearchingPatients ||
                    patientSearchError ||
                    patientSearchMissing ||
                    searchResults) && (
                  <div className="absolute z-10 mt-1 w-full rounded-md border border-border bg-popover shadow-md max-h-48 overflow-y-auto">
                    {patientSearchError || patientSearchMissing ? (
                      <div className="px-3 py-2 text-sm text-destructive">
                        {patientSearchError?.message ??
                          "Unable to search patients. Please retry."}
                      </div>
                    ) : isSearchingPatients ? (
                      <div className="px-3 py-2 text-sm text-muted-foreground">
                        Searching patients...
                      </div>
                    ) : searchResults && searchResults.length > 0 ? (
                      searchResults.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          className="w-full px-3 py-2 text-left text-sm hover:bg-muted transition-colors"
                          onClick={() => {
                            setSelectedPatient(p);
                            setShowPatientDropdown(false);
                            setPatientSearch("");
                          }}
                        >
                          <div className="font-medium">{p.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {p.species}
                            {(p.clientFirstName || p.clientLastName) && (
                              <> &middot; Owner: {[p.clientFirstName, p.clientLastName].filter(Boolean).join(" ")}</>
                            )}
                          </div>
                        </button>
                      ))
                    ) : (
                      <div className="px-3 py-2 text-sm text-muted-foreground">
                        No patients found
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
            {clientName && (
              <p className="mt-1 text-xs text-muted-foreground">Client: {clientName}</p>
            )}
          </div>

          {/* Appointment Type */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">Appointment Type</label>
            <select
              value={typeId}
              onChange={(e) => setTypeId(e.target.value)}
              disabled={appointmentTypesUnavailable}
              className="mt-1 h-9 w-full appearance-none rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">
                {appointmentTypesUnavailable
                  ? "Appointment types unavailable"
                  : "Select type..."}
              </option>
              {appointmentTypes?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.durationMinutes} min)
                </option>
              ))}
            </select>
            {appointmentTypesQuery.error || appointmentTypesMissing ? (
              <p className="mt-1 text-xs text-destructive">
                {appointmentTypesQuery.error?.message ??
                  "Unable to load appointment types. Please retry."}
              </p>
            ) : appointmentTypesQuery.isLoading ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Loading appointment types...
              </p>
            ) : null}
          </div>

          {/* Doctor */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">Doctor</label>
            <select
              value={doctorId}
              onChange={(e) => setDoctorId(e.target.value)}
              disabled={doctorsUnavailable}
              className="mt-1 h-9 w-full appearance-none rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">
                {doctorsUnavailable ? "Doctors unavailable" : "Select doctor..."}
              </option>
              {doctors?.map((doc) => (
                <option key={doc.id} value={doc.id}>
                  Dr. {doc.name}
                </option>
              ))}
            </select>
            {doctorsQuery.error || doctorsMissing ? (
              <p className="mt-1 text-xs text-destructive">
                {doctorsQuery.error?.message ??
                  "Unable to load doctors. Please retry."}
              </p>
            ) : doctorsQuery.isLoading ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Loading doctors...
              </p>
            ) : null}
          </div>

          {/* Room */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">Room</label>
            <select
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
              disabled={roomsUnavailable}
              className="mt-1 h-9 w-full appearance-none rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">
                {roomsUnavailable ? "Rooms unavailable" : "Select room..."}
              </option>
              {roomsList?.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            {roomsQuery.error || roomsMissing ? (
              <p className="mt-1 text-xs text-destructive">
                {roomsQuery.error?.message ??
                  "Unable to load rooms. Please retry."}
              </p>
            ) : roomsQuery.isLoading ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Loading rooms...
              </p>
            ) : null}
          </div>

          {/* Date */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">Date</label>
            <Input
              type="date"
              value={date}
              aria-invalid={!hasValidDate}
              onChange={(e) => setDate(e.target.value)}
              className="mt-1 h-9 text-sm"
            />
          </div>

          {/* Start Time */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">Start Time</label>
            <select
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              className="mt-1 h-9 w-full appearance-none rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              {TIME_SLOTS.map((slot) => (
                <option key={slot.value} value={slot.value}>
                  {slot.label}
                </option>
              ))}
            </select>
          </div>

          {/* Duration */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">Duration (minutes)</label>
            <Input
              type="number"
              min={APPOINTMENT_DURATION_MIN_MINUTES}
              max={APPOINTMENT_DURATION_MAX_MINUTES}
              step={APPOINTMENT_DURATION_STEP_MINUTES}
              value={duration}
              aria-invalid={!hasValidDuration}
              onChange={(e) => setDuration(Number(e.target.value))}
              className="mt-1 h-9 text-sm"
            />
          </div>

          {/* Recurrence */}
          <div className="rounded-md border border-border bg-muted/30 p-3">
            <label className="flex items-center gap-2 text-sm font-medium">
              <Checkbox
                checked={isRecurring}
                onChange={(e) => setIsRecurring(e.target.checked)}
              />
              <Repeat2 className="h-3.5 w-3.5 text-muted-foreground" />
              Repeat appointment
            </label>
            {isRecurring && (
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">
                    Frequency
                  </label>
                  <select
                    value={recurrenceFrequency}
                    onChange={(e) =>
                      setRecurrenceFrequency(e.target.value as RecurrenceFrequency)
                    }
                    className="mt-1 h-9 w-full appearance-none rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                    <option value="annual">Annual</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">
                    Every
                  </label>
                  <Input
                    type="number"
                    min={APPOINTMENT_RECURRENCE_INTERVAL_MIN}
                    max={APPOINTMENT_RECURRENCE_INTERVAL_MAX}
                    step={1}
                    value={recurrenceInterval}
                    aria-invalid={!hasValidRecurrenceInterval}
                    onChange={(e) => setRecurrenceInterval(Number(e.target.value))}
                    className="mt-1 h-9 text-sm"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">
                    Occurrences
                  </label>
                  <Input
                    type="number"
                    min={APPOINTMENT_RECURRENCE_OCCURRENCES_MIN}
                    max={APPOINTMENT_RECURRENCE_OCCURRENCES_MAX}
                    step={1}
                    value={recurrenceOccurrences}
                    aria-invalid={!hasValidRecurrenceOccurrences}
                    onChange={(e) =>
                      setRecurrenceOccurrences(Number(e.target.value))
                    }
                    className="mt-1 h-9 text-sm"
                  />
                </div>
                {!hasRecurringPatient && (
                  <p className="sm:col-span-3 text-xs text-destructive">
                    Select a patient for recurring appointments.
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Notes */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">Notes</label>
            <textarea
              value={notes}
              maxLength={APPOINTMENT_NOTES_MAX_LENGTH}
              aria-invalid={!hasValidNotes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none"
              placeholder="Optional notes..."
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={!canSaveAppointment}
          >
            {(createAppointment.isPending ||
              createRecurringAppointment.isPending) && (
              <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
            )}
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}

// --- Main Page ---

export default function SchedulePage() {
  const { data: session } = useSession();
  const userRole = session?.user?.role;
  const canCreateAppointments = canCreateAppointmentsRole(userRole);
  const canUpdateAppointmentStatus = canUpdateAppointmentStatusRole(userRole);
  const canSendAppointmentReminders =
    canSendAppointmentRemindersRole(userRole);
  const [currentDate, setCurrentDate] = useState(() =>
    startOfCalendarDay(new Date())
  );
  const [view, setView] = useState<CalendarView>("day");
  const [doctorFilter, setDoctorFilter] = useState<string>("all");
  const [selectedAppointment, setSelectedAppointment] = useState<Appointment | null>(null);
  const [showBookingForm, setShowBookingForm] = useState(false);
  const [bookingDefaultDate, setBookingDefaultDate] = useState(() =>
    startOfCalendarDay(new Date())
  );
  const [bookingDefaultTime, setBookingDefaultTime] = useState<string | undefined>(undefined);

  const weekDays = useMemo(() => buildWeekDays(currentDate), [currentDate]);
  const monthDays = useMemo(() => buildMonthGrid(currentDate), [currentDate]);
  const calendarSettingsQuery = trpc.appointments.calendarSettings.useQuery();
  const calendarSettings = calendarSettingsQuery.data;
  const calendarSettingsMissing =
    !calendarSettingsQuery.isLoading &&
    !calendarSettingsQuery.error &&
    !calendarSettings;
  const verifiedCalendarSettings =
    calendarSettingsQuery.error || calendarSettingsMissing || !calendarSettings
      ? null
      : calendarSettings;
  const calendarTimeZone = verifiedCalendarSettings
    ? verifiedCalendarSettings.timezone
    : null;
  const queryRangeInput = useMemo(() => {
    if (view === "week") {
      return {
        startDate: toISODate(weekDays[0]!),
        endDate: toISODate(weekDays[6]!),
      };
    }

    if (view === "month") {
      return {
        startDate: monthDays[0]!.dateKey,
        endDate: monthDays[monthDays.length - 1]!.dateKey,
      };
    }

    const dateKey = toISODate(currentDate);
    return { startDate: dateKey, endDate: dateKey };
  }, [currentDate, monthDays, view, weekDays]);

  const { data: appointmentsData, isLoading, error } =
    trpc.appointments.list.useQuery(
      {
        startDate: queryRangeInput.startDate,
        endDate: queryRangeInput.endDate,
        doctorId: doctorFilter !== "all" ? doctorFilter : undefined,
      },
      {
        enabled: verifiedCalendarSettings !== null,
      }
    );
  const scheduleError = calendarSettingsQuery.error ?? error;
  const isScheduleLoading = calendarSettingsQuery.isLoading || isLoading;
  const appointmentsMissing =
    verifiedCalendarSettings !== null &&
    !isLoading &&
    !error &&
    !appointmentsData;
  const scheduleMissing = calendarSettingsMissing || appointmentsMissing;
  const verifiedAppointmentsData =
    error || appointmentsMissing || !appointmentsData ? null : appointmentsData;

  const { data: doctors } = trpc.appointments.listDoctors.useQuery();
  const appointments = useMemo(
    () => sortAppointments(verifiedAppointmentsData ?? []),
    [verifiedAppointmentsData]
  );
  const scheduleReady =
    !scheduleError &&
    !isScheduleLoading &&
    !scheduleMissing &&
    Boolean(verifiedCalendarSettings && verifiedAppointmentsData);
  const canUseScheduleInteractions = canCreateAppointments && scheduleReady;
  const selectedAppointmentFromList = selectedAppointment
    ? appointments.find((appt) => appt.id === selectedAppointment.id) ?? null
    : null;
  const selectedAppointmentStillListed = Boolean(selectedAppointmentFromList);
  const appointmentsByDate = useMemo(
    () =>
      groupByCalendarDate(
        appointments,
        (appt) => appt.startTime,
        calendarTimeZone
      ),
    [appointments, calendarTimeZone]
  );

  const updateStatus = trpc.appointments.updateStatus.useMutation({
    onSuccess: () => {
      toast.success("Appointment status updated");
      setSelectedAppointment(null);
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const utils = trpc.useUtils();

  const rescheduleAppointment = trpc.appointments.reschedule.useMutation({
    onSuccess: () => {
      toast.success("Appointment rescheduled");
      setSelectedAppointment(null);
      utils.appointments.list.invalidate();
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const cancelRecurringSeries = trpc.appointments.cancelRecurringSeries.useMutation({
    onSuccess: (result) => {
      const message =
        result.cancelledCount === 0
          ? "Recurring series ended; no future appointments needed cancellation"
          : result.cancelledCount === 1
            ? "Cancelled 1 future appointment in the recurring series"
            : `Cancelled ${result.cancelledCount} future appointments in the recurring series`;
      toast.success(message);
      setSelectedAppointment(null);
      utils.appointments.list.invalidate();
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const handleStatusChange = (id: string, status: AppointmentStatus) => {
    updateStatus.mutate(
      { id, status },
      {
        onSuccess: () => {
          utils.appointments.list.invalidate();
        },
      }
    );
  };

  const handleRescheduleAppointment = (input: {
    id: string;
    startTime: string;
    endTime: string;
  }) => {
    rescheduleAppointment.mutate(input);
  };

  const handleCancelRecurringSeries = (seriesId: string) => {
    if (
      !window.confirm(
        "Cancel future appointments in this recurring series? Past, completed, and in-progress appointments will stay unchanged."
      )
    ) {
      return;
    }

    cancelRecurringSeries.mutate({ seriesId });
  };

  const openBookingForm = (date: Date, time?: string) => {
    if (!canUseScheduleInteractions) return;
    setBookingDefaultDate(startOfCalendarDay(date));
    setBookingDefaultTime(time);
    setShowBookingForm(true);
  };

  const goToday = () => setCurrentDate(startOfCalendarDay(new Date()));
  const goPrev = () =>
    setCurrentDate((d) =>
      view === "month"
        ? addCalendarMonths(d, -1)
        : addCalendarDays(d, view === "week" ? -7 : -1)
    );
  const goNext = () =>
    setCurrentDate((d) =>
      view === "month"
        ? addCalendarMonths(d, 1)
        : addCalendarDays(d, view === "week" ? 7 : 1)
    );

  useEffect(() => {
    if (scheduleError || scheduleMissing) {
      setSelectedAppointment(null);
      setShowBookingForm(false);
      return;
    }
    if (
      verifiedAppointmentsData &&
      selectedAppointment &&
      !selectedAppointmentStillListed
    ) {
      setSelectedAppointment(null);
    }
  }, [
    scheduleError,
    scheduleMissing,
    selectedAppointment,
    selectedAppointmentStillListed,
    verifiedAppointmentsData,
  ]);

  const viewOptions: { id: CalendarView; label: string }[] = [
    { id: "day", label: "Day" },
    { id: "week", label: "Week" },
    { id: "month", label: "Month" },
  ];

  // Current time indicator position
  const now = new Date();
  const todayKey = toISODate(now, calendarTimeZone);
  const currentDateKey = toISODate(currentDate);
  const isToday = currentDateKey === todayKey;
  const nowParts = getZonedHourMinute(now, calendarTimeZone);
  const showNowLine = nowParts.hour >= START_HOUR && nowParts.hour < END_HOUR;
  const showDayNowLine = isToday && showNowLine;
  const nowTop = getTopOffset(now, calendarTimeZone);

  return (
    <div>
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-heading text-xl font-semibold">Schedule</h2>
          <p className="text-sm text-muted-foreground">Appointment calendar</p>
        </div>
        <CalendarSubscribe />
      </div>

      {/* Toolbar */}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {/* Date navigation */}
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" onClick={goPrev} className="h-9 w-9">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant={isToday ? "secondary" : "outline"}
            size="sm"
            onClick={goToday}
          >
            Today
          </Button>
          <Button variant="outline" size="icon" onClick={goNext} className="h-9 w-9">
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>

        <h3 className="text-sm font-medium">{formatToolbarDate(currentDate, view)}</h3>

        <div className="ml-auto flex items-center gap-2">
          {/* View toggle */}
          <div className="flex rounded-md border border-border">
            {viewOptions.map((option, index) => (
              <button
                key={option.id}
                type="button"
                onClick={() => setView(option.id)}
                className={cn(
                  "px-3 py-1.5 text-xs font-medium transition-colors",
                  index > 0 && "border-l border-border",
                  index === 0 && "rounded-l-md",
                  index === viewOptions.length - 1 && "rounded-r-md",
                  view === option.id
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted"
                )}
              >
                {option.label}
              </button>
            ))}
          </div>

          {/* Doctor filter */}
          <div className="relative">
            <Filter className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <select
              value={doctorFilter}
              onChange={(e) => setDoctorFilter(e.target.value)}
              className="h-9 appearance-none rounded-md border border-input bg-background pl-8 pr-8 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="all">All Doctors</option>
              {doctors?.map((doc) => (
                <option key={doc.id} value={doc.id}>
                  Dr. {doc.name}
                </option>
              ))}
            </select>
          </div>

          {/* New Appointment button */}
          {canCreateAppointments && (
            <Button
              size="sm"
              disabled={!canUseScheduleInteractions}
              onClick={() => {
                openBookingForm(currentDate);
              }}
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              New Appointment
            </Button>
          )}
        </div>
      </div>

      {/* Calendar area (the "your day" guide spotlights this region) */}
      <div data-tour="schedule-calendar">
      {scheduleError || scheduleMissing ? (
        <div className="mt-4 rounded-lg border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
          {scheduleError?.message ?? "Unable to load schedule. Please retry."}
        </div>
      ) : isScheduleLoading ? (
        <div className="mt-6 flex items-center justify-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading appointments...
        </div>
      ) : view === "week" ? (
        appointments.length > 0 ? (
          <WeekCalendar
            days={weekDays}
            appointmentsByDate={appointmentsByDate}
            timeZone={calendarTimeZone}
            todayKey={todayKey}
            showNowLine={showNowLine}
            nowTop={nowTop}
            onSlotClick={
              canUseScheduleInteractions
                ? (date, y) => openBookingForm(date, getSnappedTimeFromY(y))
                : undefined
            }
            onAppointmentClick={setSelectedAppointment}
          />
        ) : (
          <>
            <EmptyState
              icon={Calendar}
              title="No appointments this week"
              description="The selected schedule is clear for this week."
              className="mt-4"
            />
            <WeekCalendar
              days={weekDays}
              appointmentsByDate={appointmentsByDate}
              timeZone={calendarTimeZone}
              todayKey={todayKey}
              showNowLine={showNowLine}
              nowTop={nowTop}
              onSlotClick={
                canUseScheduleInteractions
                  ? (date, y) => openBookingForm(date, getSnappedTimeFromY(y))
                  : undefined
              }
              onAppointmentClick={setSelectedAppointment}
            />
          </>
        )
      ) : view === "month" ? (
        appointments.length > 0 ? (
          <MonthCalendar
            days={monthDays}
            appointmentsByDate={appointmentsByDate}
            currentDate={currentDate}
            timeZone={calendarTimeZone}
            todayKey={todayKey}
            canCreateAppointments={canUseScheduleInteractions}
            onCreateClick={(date) => openBookingForm(date)}
            onDayOpen={(date) => {
              setCurrentDate(startOfCalendarDay(date));
              setView("day");
            }}
            onAppointmentClick={setSelectedAppointment}
          />
        ) : (
          <>
            <EmptyState
              icon={Calendar}
              title="No appointments in this month"
              description="The selected schedule is clear for this month."
              className="mt-4"
            />
            <MonthCalendar
              days={monthDays}
              appointmentsByDate={appointmentsByDate}
              currentDate={currentDate}
              timeZone={calendarTimeZone}
              todayKey={todayKey}
              canCreateAppointments={canUseScheduleInteractions}
              onCreateClick={(date) => openBookingForm(date)}
              onDayOpen={(date) => {
                setCurrentDate(startOfCalendarDay(date));
                setView("day");
              }}
              onAppointmentClick={setSelectedAppointment}
            />
          </>
        )
      ) : (
        <DayCalendar
          appointments={appointments}
          timeZone={calendarTimeZone}
          showNowLine={showDayNowLine}
          nowTop={nowTop}
          onSlotClick={
            canUseScheduleInteractions
              ? (y) => openBookingForm(currentDate, getSnappedTimeFromY(y))
              : undefined
          }
          onAppointmentClick={setSelectedAppointment}
        />
      )}
      </div>

      {/* Detail popover */}
      {selectedAppointmentFromList &&
        verifiedCalendarSettings &&
        scheduleReady &&
        selectedAppointmentStillListed && (
          <AppointmentDetailPopover
            appointment={selectedAppointmentFromList}
            timeZone={verifiedCalendarSettings.timezone}
            onClose={() => setSelectedAppointment(null)}
            onStatusChange={handleStatusChange}
            onReschedule={handleRescheduleAppointment}
            onCancelRecurringSeries={handleCancelRecurringSeries}
            canUpdateStatus={canUpdateAppointmentStatus}
            canManageSchedule={canCreateAppointments}
            canSendReminders={canSendAppointmentReminders}
            isUpdating={updateStatus.isPending}
            isRescheduling={rescheduleAppointment.isPending}
            isCancellingSeries={cancelRecurringSeries.isPending}
          />
        )}

      {/* Booking form */}
      {canUseScheduleInteractions &&
        showBookingForm &&
        verifiedCalendarSettings && (
          <BookingForm
            onClose={() => setShowBookingForm(false)}
            defaultDate={bookingDefaultDate}
            defaultTime={bookingDefaultTime}
            timeZone={verifiedCalendarSettings.timezone}
          />
        )}
    </div>
  );
}
