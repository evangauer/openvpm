"use client";

import { useState, useEffect, useId, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  CalendarPlus,
  ClipboardList,
  Clock,
  Loader2,
  MapPin,
  User,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { PATIENT_SPECIES_EMOJI } from "@/lib/patients/species";
import { EmptyState } from "@/components/common/empty-state";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// --- Types ---

type AppointmentStatus =
  | "scheduled"
  | "confirmed"
  | "checked_in"
  | "in_exam"
  | "checked_out"
  | "no_show"
  | "cancelled";

type WhiteboardAppointment = {
  id: string;
  status: string;
  startTime: Date | string;
  notes: string | null;
  patientId: string | null;
  clientId: string | null;
  patientName: string | null;
  patientSpecies: string | null;
  patientPhotoUrl: string | null;
  clientFirstName: string | null;
  clientLastName: string | null;
  doctorName: string | null;
  roomName: string | null;
  locationName: string | null;
  locationId: string | null;
  typeName: string | null;
  typeColor: string | null;
};

const DIALOG_FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusElementAfterNavigation(elementId: string) {
  const startedAt = performance.now();
  function moveFocus() {
    const target = document.getElementById(elementId);
    if (target) {
      if (!target.hasAttribute("tabindex"))
        target.setAttribute("tabindex", "-1");
      target.focus({ preventScroll: true });
      return;
    }
    if (performance.now() - startedAt < 5_000) {
      window.requestAnimationFrame(moveFocus);
    }
  }
  window.requestAnimationFrame(moveFocus);
}

// --- Constants ---

const COLUMNS = [
  {
    key: "waiting",
    label: "Waiting",
    statuses: ["confirmed"],
    color: "bg-blue-500",
    headerBg: "bg-blue-500/10",
    headerText: "text-blue-700 dark:text-blue-400",
  },
  {
    key: "in_progress",
    label: "In Progress",
    statuses: ["checked_in", "in_exam"],
    color: "bg-amber-500",
    headerBg: "bg-amber-500/10",
    headerText: "text-amber-700 dark:text-amber-400",
  },
  {
    key: "completed",
    label: "Completed",
    statuses: ["checked_out"],
    color: "bg-green-500",
    headerBg: "bg-green-500/10",
    headerText: "text-green-700 dark:text-green-400",
  },
] as const;

const STATUS_LABELS: Record<AppointmentStatus, string> = {
  scheduled: "Scheduled",
  confirmed: "Confirmed",
  checked_in: "Checked In",
  in_exam: "In Exam",
  checked_out: "Checked Out",
  no_show: "No Show",
  cancelled: "Cancelled",
};

const STATUS_COLORS: Record<AppointmentStatus, string> = {
  scheduled: "bg-blue-500",
  confirmed: "bg-blue-500",
  checked_in: "bg-amber-500",
  in_exam: "bg-amber-500",
  checked_out: "bg-green-500",
  no_show: "bg-red-500",
  cancelled: "bg-red-500",
};

const SPECIES_EMOJI: Record<string, string> = PATIENT_SPECIES_EMOJI;

function canUpdateWhiteboardStatusRole(role?: string | null): boolean {
  return (
    role === "admin" ||
    role === "veterinarian" ||
    role === "technician" ||
    role === "front_desk"
  );
}

// --- Helpers ---

function getSpeciesEmoji(species: string | null): string {
  if (!species) return "\uD83D\uDC3E";
  return SPECIES_EMOJI[species.toLowerCase()] || "\uD83D\uDC3E";
}

function getTimeAgo(startTime: Date | string): string {
  const start = new Date(startTime);
  const now = new Date();
  const diffMs = now.getTime() - start.getTime();
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 0) {
    const absMin = Math.abs(diffMin);
    if (absMin < 60) return `in ${absMin} min`;
    const hours = Math.floor(absMin / 60);
    return `in ${hours}h ${absMin % 60}m`;
  }
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin} min ago`;
  const hours = Math.floor(diffMin / 60);
  const mins = diffMin % 60;
  if (mins === 0) return `${hours}h ago`;
  return `${hours}h ${mins}m ago`;
}

function formatCurrentTime(date: Date, timeZone?: string | null): string {
  const options: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZone: timeZone ?? undefined,
  };
  try {
    return date.toLocaleTimeString("en-US", options);
  } catch {
    return date.toLocaleTimeString("en-US", {
      ...options,
      timeZone: undefined,
    });
  }
}

function formatCurrentDate(date: Date, timeZone?: string | null): string {
  const options: Intl.DateTimeFormatOptions = {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: timeZone ?? undefined,
  };
  try {
    return date.toLocaleDateString("en-US", options);
  } catch {
    return date.toLocaleDateString("en-US", {
      ...options,
      timeZone: undefined,
    });
  }
}

function formatAppointmentTime(date: Date, timeZone?: string | null): string {
  const options: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: timeZone ?? undefined,
  };
  try {
    return date.toLocaleTimeString("en-US", options);
  } catch {
    return date.toLocaleTimeString("en-US", {
      ...options,
      timeZone: undefined,
    });
  }
}

// --- Components ---

function LiveIndicator() {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-green-600 dark:text-green-400">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
      </span>
      Live
    </span>
  );
}

function StatusDot({ status }: { status: string }) {
  const colorClass = STATUS_COLORS[status as AppointmentStatus] || "bg-gray-400";
  return (
    <span
      className={cn("inline-block h-2 w-2 rounded-full shrink-0", colorClass)}
    />
  );
}

function WhiteboardCard({
  appointment,
  onClick,
}: {
  appointment: WhiteboardAppointment;
  onClick: () => void;
}) {
  const clientName = [appointment.clientFirstName, appointment.clientLastName]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-lg border border-border bg-card p-3 text-left transition-all hover:shadow-md hover:border-border/80 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1"
    >
      {/* Patient name + species */}
      <div className="flex items-center gap-2">
        <span className="text-base leading-none">
          {getSpeciesEmoji(appointment.patientSpecies)}
        </span>
        <span className="font-medium text-sm truncate">
          {appointment.patientName || "Unknown Patient"}
        </span>
        <StatusDot status={appointment.status} />
      </div>

      {/* Owner */}
      {clientName && (
        <p className="mt-1.5 text-xs text-muted-foreground truncate">
          {clientName}
        </p>
      )}

      {/* Details row */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {appointment.doctorName && (
          <span className="inline-flex items-center gap-1">
            <User className="h-3 w-3" />
            Dr. {appointment.doctorName}
          </span>
        )}
        {(appointment.locationName || appointment.roomName) && (
          <span className="inline-flex items-center gap-1">
            <MapPin className="h-3 w-3" />
            {[appointment.locationName, appointment.roomName]
              .filter(Boolean)
              .join(" · ")}
          </span>
        )}
      </div>

      {/* Type + time */}
      <div className="mt-2 flex items-center justify-between">
        {appointment.typeName && (
          <span
            className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium"
            style={{
              backgroundColor: appointment.typeColor
                ? `${appointment.typeColor}20`
                : undefined,
              color: appointment.typeColor || undefined,
            }}
          >
            {appointment.typeName}
          </span>
        )}
        <span className="text-[10px] text-muted-foreground flex items-center gap-1">
          <Clock className="h-2.5 w-2.5" />
          {getTimeAgo(appointment.startTime)}
        </span>
      </div>
    </button>
  );
}

function AppointmentDetailModal({
  appointment,
  timeZone,
  onClose,
  onStatusChange,
  canUpdateStatus,
  isUpdating,
}: {
  appointment: WhiteboardAppointment;
  timeZone?: string | null;
  onClose: () => void;
  onStatusChange: (id: string, status: AppointmentStatus) => void;
  canUpdateStatus: boolean;
  isUpdating: boolean;
}) {
  const modalRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const restoreFocusRef = useRef(true);
  const dialogTitleId = useId();
  const start = new Date(appointment.startTime);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previouslyFocusedElement =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const focusFrame = window.requestAnimationFrame(() => {
      modalRef.current?.focus();
    });

    function handleClickOutside(e: MouseEvent) {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        onCloseRef.current();
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !modalRef.current) return;

      const focusableElements = Array.from(
        modalRef.current.querySelectorAll<HTMLElement>(
          DIALOG_FOCUSABLE_SELECTOR,
        ),
      );
      if (focusableElements.length === 0) {
        e.preventDefault();
        modalRef.current.focus();
        return;
      }

      const firstElement = focusableElements[0]!;
      const lastElement = focusableElements[focusableElements.length - 1]!;
      const activeElement = document.activeElement;
      if (activeElement === modalRef.current) {
        e.preventDefault();
        (e.shiftKey ? lastElement : firstElement).focus();
      } else if (
        e.shiftKey &&
        (activeElement === firstElement ||
          !modalRef.current.contains(activeElement))
      ) {
        e.preventDefault();
        lastElement.focus();
      } else if (
        !e.shiftKey &&
        (activeElement === lastElement ||
          !modalRef.current.contains(activeElement))
      ) {
        e.preventDefault();
        firstElement.focus();
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
      if (restoreFocusRef.current && previouslyFocusedElement?.isConnected) {
        previouslyFocusedElement.focus();
      }
    };
  }, []);

  const clientName =
    [appointment.clientFirstName, appointment.clientLastName]
      .filter(Boolean)
      .join(" ") || "Unknown Client";

  const current = appointment.status as AppointmentStatus;
  const missingClinicalTarget =
    !appointment.patientId || !appointment.clientId;

  const statusActions: {
    label: string;
    status: AppointmentStatus;
    variant: "default" | "outline" | "destructive";
  }[] = [];

  if (current === "confirmed") {
    statusActions.push({ label: "Check In", status: "checked_in", variant: "default" });
    statusActions.push({ label: "No Show", status: "no_show", variant: "outline" });
    statusActions.push({ label: "Cancel", status: "cancelled", variant: "destructive" });
  } else if (current === "checked_in") {
    statusActions.push({ label: "Start Exam", status: "in_exam", variant: "default" });
  }
  const visibleStatusActions = canUpdateStatus ? statusActions : [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={dialogTitleId}
        tabIndex={-1}
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
            aria-label="Close appointment details"
            onClick={onClose}
            className="rounded-md p-1 hover:bg-muted transition-colors"
          >
            <X className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>

        {/* Body */}
        <div className="px-4 py-3 space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-lg">
              {getSpeciesEmoji(appointment.patientSpecies)}
            </span>
            <div>
              <h3 id={dialogTitleId} className="font-semibold text-base">
                {appointment.patientName || "Unknown Patient"}
              </h3>
              {appointment.patientSpecies && (
                <p className="text-xs text-muted-foreground capitalize">
                  {appointment.patientSpecies}
                </p>
              )}
            </div>
          </div>

          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2 text-muted-foreground">
              <User className="h-3.5 w-3.5" />
              <span>Client: {clientName}</span>
            </div>
            <div className="flex items-center gap-2 text-muted-foreground">
              <Clock className="h-3.5 w-3.5" />
              <span>
                {formatAppointmentTime(start, timeZone)}{" "}
                ({getTimeAgo(appointment.startTime)})
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
                <span
                  className="ml-0.5 h-3 w-3 rounded-full inline-block"
                  style={{
                    backgroundColor: appointment.typeColor || "#6b7280",
                  }}
                />
                <span>{appointment.typeName}</span>
              </div>
            )}
            {(appointment.locationName || appointment.roomName) && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <MapPin className="h-3.5 w-3.5" />
                <span>
                  {[appointment.locationName, appointment.roomName]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </div>
            )}
            {appointment.notes && (
              <p className="text-muted-foreground text-xs mt-1 bg-muted/50 rounded-lg p-2">
                {appointment.notes}
              </p>
            )}
          </div>
        </div>

        {/* Actions */}
        {(visibleStatusActions.length > 0 || appointment.id) && (
          <div className="flex flex-wrap gap-2 border-t border-border px-4 py-3">
            <Button size="sm" asChild>
              <Link
                href={
                  current === "in_exam"
                    ? `/encounters/${appointment.id}#visit-closeout`
                    : `/encounters/${appointment.id}`
                }
                onNavigate={() => {
                  restoreFocusRef.current = false;
                  if (current === "in_exam") {
                    focusElementAfterNavigation("visit-closeout");
                  }
                }}
              >
                 {current === "in_exam"
                   ? "Review closeout"
                   : "Open visit"}
              </Link>
            </Button>
            {visibleStatusActions.map((action) => (
              <Button
                key={action.status}
                size="sm"
                variant={action.variant}
                disabled={
                  isUpdating ||
                  (action.status === "in_exam" && missingClinicalTarget)
                }
                title={
                  action.status === "in_exam" && missingClinicalTarget
                    ? "Open the visit and attach an active patient before starting the exam."
                    : undefined
                }
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

// --- Main Page ---

export default function WhiteboardPage() {
  const router = useRouter();
  const { data: session } = useSession();
  const canUpdateStatus = canUpdateWhiteboardStatusRole(session?.user?.role);
  const [selectedAppointment, setSelectedAppointment] =
    useState<WhiteboardAppointment | null>(null);
  const [currentTime, setCurrentTime] = useState<Date | null>(null);

  // Set initial time on client mount and update every second to avoid
  // SSR/client hydration mismatch from Date() evaluating differently.
  useEffect(() => {
    setCurrentTime(new Date());
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const {
    data: activeAppointments,
    isLoading,
    error,
  } = trpc.whiteboard.getActive.useQuery(undefined, {
    refetchInterval: 30000,
  });
  const settingsQuery = trpc.whiteboard.settings.useQuery();
  const practiceSettings = settingsQuery.data;
  const pageError = error ?? settingsQuery.error;
  const isPageLoading = isLoading || settingsQuery.isLoading;
  const activeAppointmentsMissing = !isLoading && !error && !activeAppointments;
  const settingsMissing =
    !settingsQuery.isLoading && !settingsQuery.error && !settingsQuery.data;
  const pageMissing = activeAppointmentsMissing || settingsMissing;
  const verifiedActiveAppointments =
    error || activeAppointmentsMissing || !activeAppointments
      ? null
      : activeAppointments;
  const verifiedPracticeSettings =
    settingsQuery.error || settingsMissing || !practiceSettings
      ? null
      : practiceSettings;
  const pageReady =
    !pageError &&
    !isPageLoading &&
    !pageMissing &&
    Boolean(verifiedActiveAppointments && verifiedPracticeSettings);
  const practiceClockReady = Boolean(
    currentTime && verifiedPracticeSettings && !pageError
  );

  const utils = trpc.useUtils();
  const updateStatus = trpc.whiteboard.updateStatus.useMutation({
    onSuccess: () => {
      toast.success("Status updated");
      setSelectedAppointment(null);
      utils.whiteboard.getActive.invalidate();
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const handleStatusChange = (id: string, status: AppointmentStatus) => {
    updateStatus.mutate({ id, status });
  };

  const selectedAppointmentFromList = selectedAppointment
    ? verifiedActiveAppointments?.find(
        (appt) => appt.id === selectedAppointment.id
      ) ?? null
    : null;
  const selectedAppointmentStillActive = Boolean(selectedAppointmentFromList);

  useEffect(() => {
    if (!selectedAppointment) return;
    if (pageError || pageMissing) {
      setSelectedAppointment(null);
      return;
    }
    if (verifiedActiveAppointments && !selectedAppointmentStillActive) {
      setSelectedAppointment(null);
    }
  }, [
    pageError,
    pageMissing,
    selectedAppointment,
    selectedAppointmentStillActive,
    verifiedActiveAppointments,
  ]);

  // Group appointments into columns
  const columnData = COLUMNS.map((col) => {
    const items = (verifiedActiveAppointments ?? []).filter((appt) =>
      (col.statuses as readonly string[]).includes(appt.status as string)
    );
    return { ...col, items };
  });
  const hasWhiteboardPatients = columnData.some((col) => col.items.length > 0);

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="font-heading text-xl font-semibold">
              Practice Whiteboard
            </h2>
            <LiveIndicator />
          </div>
          <p className="text-sm text-muted-foreground">
            Live patient status board
          </p>
        </div>
        <div className="text-right">
          <p className="text-sm font-medium">
            {practiceClockReady && currentTime && verifiedPracticeSettings
              ? formatCurrentTime(currentTime, verifiedPracticeSettings.timezone)
              : "\u00A0"}
          </p>
          <p className="text-xs text-muted-foreground">
            {practiceClockReady && currentTime && verifiedPracticeSettings
              ? formatCurrentDate(currentTime, verifiedPracticeSettings.timezone)
              : "\u00A0"}
          </p>
        </div>
      </div>

      {/* Board area (the "your day" guide spotlights this region) */}
      <div data-tour="whiteboard-board">
      {pageError || pageMissing ? (
        <div className="mt-4 rounded-lg border border-destructive bg-destructive/10 p-4 text-sm text-destructive">
          {pageError?.message ?? "Unable to load whiteboard. Please retry."}
        </div>
      ) : isPageLoading ? (
        <div className="mt-12 flex items-center justify-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading whiteboard...
        </div>
      ) : hasWhiteboardPatients ? (
        /* Kanban columns */
        <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3">
          {columnData.map((col) => (
            <div
              key={col.key}
              className="rounded-lg border border-border bg-muted/30"
            >
              {/* Column header */}
              <div
                className={cn(
                  "flex items-center justify-between rounded-t-lg px-4 py-3",
                  col.headerBg
                )}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={cn("h-2.5 w-2.5 rounded-full", col.color)}
                  />
                  <h3
                    className={cn(
                      "text-sm font-semibold",
                      col.headerText
                    )}
                  >
                    {col.label}
                  </h3>
                </div>
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-xs font-medium",
                    col.headerBg,
                    col.headerText
                  )}
                >
                  {col.items.length}
                </span>
              </div>

              {/* Column body */}
              <div className="space-y-3 p-3" style={{ minHeight: 120 }}>
                {col.items.length === 0 ? (
                  <div className="flex h-20 items-center justify-center">
                    <p className="text-xs text-muted-foreground">No patients</p>
                  </div>
                ) : (
                  col.items.map((appt) => (
                    <WhiteboardCard
                      key={appt.id}
                      appointment={appt}
                      onClick={() => setSelectedAppointment(appt)}
                    />
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          className="mt-6"
          icon={ClipboardList}
          title="No patients on the whiteboard"
          description="Checked-in and in-progress appointments will appear here as the day moves."
          action={{
            label: "Open schedule",
            onClick: () => router.push("/schedule"),
            icon: CalendarPlus,
          }}
        />
      )}
      </div>

      {/* Detail modal */}
      {selectedAppointmentFromList &&
        verifiedPracticeSettings &&
        pageReady &&
        selectedAppointmentStillActive && (
          <AppointmentDetailModal
            appointment={selectedAppointmentFromList}
            timeZone={verifiedPracticeSettings.timezone}
            onClose={() => setSelectedAppointment(null)}
            onStatusChange={handleStatusChange}
            canUpdateStatus={canUpdateStatus}
            isUpdating={updateStatus.isPending}
          />
        )}
    </div>
  );
}
