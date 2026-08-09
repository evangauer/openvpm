import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
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
} from "../scheduling/appointment-policy";

describe("schedule appointment form UX", () => {
  it("offers a direct handoff from a saved appointment into the visit workflow", () => {
    const source = readFileSync("app/(dashboard)/schedule/page.tsx", "utf8");

    expect(source).toContain("onSuccess: (appointment) => {");
    expect(source).toContain('toast.success("Appointment created", {');
    expect(source).toContain('label: "Open visit"');
    expect(source).toContain(
      "window.location.assign(`/encounters/${appointment.id}`)",
    );
  });

  it("bounds New Appointment inputs before creating appointments", () => {
    const source = readFileSync("app/(dashboard)/schedule/page.tsx", "utf8");

    expect(APPOINTMENT_PATIENT_SEARCH_MAX_LENGTH).toBe(128);
    expect(APPOINTMENT_NOTES_MAX_LENGTH).toBe(2000);
    expect(APPOINTMENT_DURATION_MIN_MINUTES).toBe(5);
    expect(APPOINTMENT_DURATION_MAX_MINUTES).toBe(480);
    expect(APPOINTMENT_DURATION_STEP_MINUTES).toBe(5);
    expect(APPOINTMENT_RECURRENCE_INTERVAL_MIN).toBe(1);
    expect(APPOINTMENT_RECURRENCE_INTERVAL_MAX).toBe(12);
    expect(APPOINTMENT_RECURRENCE_OCCURRENCES_MIN).toBe(1);
    expect(APPOINTMENT_RECURRENCE_OCCURRENCES_MAX).toBe(52);
    expect(isAppointmentPatientSearchInputValid(" Biscuit ")).toBe(true);
    expect(isAppointmentPatientSearchInputValid("x".repeat(129))).toBe(false);
    expect(isAppointmentDateInputValid("2026-06-28")).toBe(true);
    expect(isAppointmentDateInputValid("2026-02-31")).toBe(false);
    expect(isAppointmentDurationInputValid(30)).toBe(true);
    expect(isAppointmentDurationInputValid(0)).toBe(false);
    expect(isAppointmentDurationInputValid(481)).toBe(false);
    expect(isAppointmentDurationInputValid(30.5)).toBe(false);
    expect(isAppointmentNotesInputValid(" Bring stool sample ")).toBe(true);
    expect(isAppointmentNotesInputValid("x".repeat(2001))).toBe(false);
    expect(isAppointmentRecurrenceIntervalInputValid(1)).toBe(true);
    expect(isAppointmentRecurrenceIntervalInputValid(13)).toBe(false);
    expect(isAppointmentRecurrenceOccurrencesInputValid(4)).toBe(true);
    expect(isAppointmentRecurrenceOccurrencesInputValid(53)).toBe(false);

    expect(source).toContain("const canSaveAppointment =");
    expect(source).toContain(
      "const canSearchPatients = isAppointmentPatientSearchInputValid(patientSearch);"
    );
    expect(source).toContain("isAppointmentDateInputValid(date)");
    expect(source).toContain("isAppointmentDurationInputValid(duration)");
    expect(source).toContain("isAppointmentNotesInputValid(notes)");
    expect(source).toContain("maxLength={APPOINTMENT_PATIENT_SEARCH_MAX_LENGTH}");
    expect(source).toContain("maxLength={APPOINTMENT_NOTES_MAX_LENGTH}");
    expect(source).toContain("min={APPOINTMENT_DURATION_MIN_MINUTES}");
    expect(source).toContain("max={APPOINTMENT_DURATION_MAX_MINUTES}");
    expect(source).toContain("step={APPOINTMENT_DURATION_STEP_MINUTES}");
    expect(source).toContain("notes: notes.trim() || undefined");
    expect(source).toContain("disabled={!canSaveAppointment}");
    expect(source).not.toContain("disabled={createAppointment.isPending}");
  });

  it("builds booking instants from the practice timezone instead of the browser timezone", () => {
    const source = readFileSync("app/(dashboard)/schedule/page.tsx", "utf8");

    expect(source).toContain('import { dateInputTimeUtcInstant } from "@/lib/date-input"');
    expect(source).toContain("function appointmentInstantFromDateAndTime(");
    expect(source).toContain("trpc.appointments.calendarSettings.useQuery");
    expect(source).toContain(
      "const calendarSettingsQuery = trpc.appointments.calendarSettings.useQuery()"
    );
    expect(source).toContain("const verifiedCalendarSettings =");
    expect(source).toContain(
      "const calendarTimeZone = verifiedCalendarSettings\n    ? verifiedCalendarSettings.timezone\n    : null"
    );
    expect(source).toContain("enabled: verifiedCalendarSettings !== null");
    expect(source).toContain(
      "dateInputTimeUtcInstant(date, { hour, minute }, timeZone)"
    );
    expect(source).toContain("timeZone={calendarTimeZone}");
    expect(source).not.toContain("calendarSettings?.timezone");
    expect(source).not.toContain('new Date(`${date}T${startTime}:00`)');
  });

  it("renders schedule appointments and now-line in the practice timezone", () => {
    const source = readFileSync("app/(dashboard)/schedule/page.tsx", "utf8");

    expect(source).toContain("function formatTime(date: Date, timeZone?: string | null)");
    expect(source).toContain("function getZonedHourMinute(");
    expect(source).toContain("getAppointmentLayout(start, end, timeZone)");
    expect(source).toContain("formatTime(start, timeZone)");
    expect(source).toContain("groupByCalendarDate(");
    expect(source).toContain("calendarTimeZone");
    expect(source).toContain("const todayKey = toISODate(now, calendarTimeZone)");
    expect(source).toContain("const nowParts = getZonedHourMinute(now, calendarTimeZone)");
    expect(source).toContain("const nowTop = getTopOffset(now, calendarTimeZone)");
    expect(source).not.toContain("now.getHours() >= START_HOUR");
  });

  it("gates timezone-sensitive schedule rendering on calendar settings", () => {
    const source = readFileSync("app/(dashboard)/schedule/page.tsx", "utf8");

    expect(source).toContain("const scheduleError = calendarSettingsQuery.error ?? error");
    expect(source).toContain(
      "const isScheduleLoading = calendarSettingsQuery.isLoading || isLoading"
    );
    expect(source).toContain("const calendarSettingsMissing =");
    expect(source).toContain("const appointmentsMissing =");
    expect(source).toContain("const scheduleMissing =");
    expect(source).toContain("const verifiedAppointmentsData =");
    expect(source).toContain("const scheduleReady =");
    expect(source).toContain(
      "Boolean(verifiedCalendarSettings && verifiedAppointmentsData)"
    );
    expect(source).toContain(
      "const canUseScheduleInteractions = canCreateAppointments && scheduleReady"
    );
    expect(source).toContain("const selectedAppointmentFromList = selectedAppointment");
    expect(source).toContain(
      "const selectedAppointmentStillListed = Boolean(selectedAppointmentFromList)"
    );
    expect(source).toContain("if (scheduleError || scheduleMissing)");
    expect(source).toContain("setShowBookingForm(false)");
    expect(source).toContain("{scheduleError || scheduleMissing ? (");
    expect(source).toContain(
      '{scheduleError?.message ?? "Unable to load schedule. Please retry."}'
    );
    expect(source).toContain(") : isScheduleLoading ? (");
    expect(source).toContain("disabled={!canUseScheduleInteractions}");
    expect(source).toMatch(
      /canUseScheduleInteractions\s+\?\s+\(date, y\) => openBookingForm/
    );
    expect(source).toContain("canCreateAppointments={canUseScheduleInteractions}");
    expect(source).toContain("{selectedAppointmentFromList &&");
    expect(source).toContain("scheduleReady &&");
    expect(source).toContain("selectedAppointmentStillListed &&");
    expect(source).toContain("appointment={selectedAppointmentFromList}");
    expect(source).toContain("timeZone={verifiedCalendarSettings.timezone}");
    expect(source).toContain(
      "{canUseScheduleInteractions &&\n        showBookingForm &&\n        verifiedCalendarSettings && ("
    );
    expect(source.indexOf("scheduleError || scheduleMissing")).toBeLessThan(
      source.indexOf("No appointments this week")
    );
    expect(source.indexOf("scheduleError || scheduleMissing")).toBeLessThan(
      source.indexOf("No appointments in this month")
    );
    expect(source).not.toContain("{error ? (");
    expect(source).not.toContain(") : isLoading ? (");
    expect(source).not.toContain("{selectedAppointment && (\n        <AppointmentDetailPopover");
    expect(source).not.toContain("{canCreateAppointments && showBookingForm && (");
    expect(source).not.toContain("enabled: calendarSettings !== undefined");
  });

  it("creates recurring appointments from the booking modal with bounded inputs", () => {
    const source = readFileSync("app/(dashboard)/schedule/page.tsx", "utf8");

    expect(source).toContain("const [isRecurring, setIsRecurring] = useState(false)");
    expect(source).toContain("trpc.appointments.createRecurring.useMutation");
    expect(source).toContain("createRecurringAppointment.mutate({");
    expect(source).toContain("patientId: selectedPatient.id");
    expect(source).toContain("frequency: recurrenceFrequency");
    expect(source).toContain("interval: recurrenceInterval");
    expect(source).toContain("occurrences: recurrenceOccurrences");
    expect(source).toContain("Repeat appointment");
    expect(source).toContain("APPOINTMENT_RECURRENCE_INTERVAL_MAX");
    expect(source).toContain("APPOINTMENT_RECURRENCE_OCCURRENCES_MAX");
    expect(source).toContain("hasRecurringPatient");
    expect(source).toContain("Select a patient for recurring appointments.");
    expect(source).toContain("Created ${result.created} recurring appointments");
  });

  it("surfaces patient search loading, error, and empty states in the modal", () => {
    const source = readFileSync("app/(dashboard)/schedule/page.tsx", "utf8");

    expect(source).toContain("isLoading: isSearchingPatients");
    expect(source).toContain("error: patientSearchError");
    expect(source).toContain("const patientSearchMissing =");
    expect(source).toContain("patientSearchError || patientSearchMissing");
    expect(source).toContain("isSearchingPatients ? (");
    expect(source).toContain("Unable to search patients. Please retry.");
    expect(source).toContain("Searching patients...");
    expect(source).toContain("No patients found");
    expect(source.indexOf("patientSearchError || patientSearchMissing")).toBeLessThan(
      source.indexOf("No patients found")
    );
  });

  it("keeps schedule write actions aligned to appointment role gates", () => {
    const source = readFileSync("app/(dashboard)/schedule/page.tsx", "utf8");

    expect(source).toContain('import { useSession } from "next-auth/react"');
    expect(source).toContain("function canCreateAppointmentsRole");
    expect(source).toContain(
      'role === "admin" || role === "veterinarian" || role === "front_desk"'
    );
    expect(source).toContain("function canUpdateAppointmentStatusRole");
    expect(source).toContain('role === "technician"');
    expect(source).toContain("function canSendAppointmentRemindersRole");
    expect(source).toContain('role === "admin" || role === "front_desk"');
    expect(source).toContain(
      "const canCreateAppointments = canCreateAppointmentsRole(userRole)"
    );
    expect(source).toContain(
      "const canUpdateAppointmentStatus = canUpdateAppointmentStatusRole(userRole)"
    );
    expect(source).toContain(
      "const canSendAppointmentReminders =\n    canSendAppointmentRemindersRole(userRole)"
    );
    expect(source).toContain("if (!canUseScheduleInteractions) return;");
    expect(source).toContain("{canCreateAppointments && (");
    expect(source).toContain("canCreateAppointments={canUseScheduleInteractions}");
    expect(source).toContain("canManageSchedule={canCreateAppointments}");
    expect(source).toContain("canUpdateStatus={canUpdateAppointmentStatus}");
    expect(source).toContain("canSendReminders={canSendAppointmentReminders}");
    expect(source).toContain("onSlotClick?:");
    expect(source).toContain("if (!onSlotClick) return;");
    expect(source).toContain("const visibleStatusActions = canUpdateStatus");
    expect(source).toContain("canSendReminders &&");
    expect(source).toContain("canManageSchedule && canMoveAppointment");
  });

  it("surfaces optional booking reference-data lookup failures", () => {
    const source = readFileSync("app/(dashboard)/schedule/page.tsx", "utf8");

    expect(source).toContain(
      "const appointmentTypesQuery = trpc.appointments.listTypes.useQuery()"
    );
    expect(source).toContain(
      "const doctorsQuery = trpc.appointments.listDoctors.useQuery()"
    );
    expect(source).toContain(
      "const roomsQuery = trpc.appointments.listRooms.useQuery()"
    );
    expect(source).toContain("const appointmentTypesMissing =");
    expect(source).toContain("const doctorsMissing =");
    expect(source).toContain("const roomsMissing =");
    expect(source).toContain("const appointmentTypesUnavailable =");
    expect(source).toContain("const doctorsUnavailable =");
    expect(source).toContain("const roomsUnavailable =");
    expect(source).toContain("disabled={appointmentTypesUnavailable}");
    expect(source).toContain("disabled={doctorsUnavailable}");
    expect(source).toContain("disabled={roomsUnavailable}");
    expect(source).toContain("appointmentTypesQuery.error || appointmentTypesMissing");
    expect(source).toContain("doctorsQuery.error || doctorsMissing");
    expect(source).toContain("roomsQuery.error || roomsMissing");
    expect(source).toContain("Unable to load appointment types. Please retry.");
    expect(source).toContain("Unable to load doctors. Please retry.");
    expect(source).toContain("Unable to load rooms. Please retry.");
    expect(source).toContain("Loading appointment types...");
    expect(source).toContain("Loading doctors...");
    expect(source).toContain("Loading rooms...");
  });

  it("surfaces recurring appointment lifecycle actions in the detail popover", () => {
    const source = readFileSync("app/(dashboard)/schedule/page.tsx", "utf8");

    expect(source).toContain("recurringSeriesId: string | null");
    expect(source).toContain("Recurring series");
    expect(source).toContain("Cancel Future Series");
    expect(source).toContain("trpc.appointments.cancelRecurringSeries.useMutation");
    expect(source).toContain("onCancelRecurringSeries(appointment.recurringSeriesId");
    expect(source).toContain(
      "Past, completed, and in-progress appointments will stay unchanged."
    );
  });

  it("reschedules appointments from the detail popover with bounded practice-time inputs", () => {
    const source = readFileSync("app/(dashboard)/schedule/page.tsx", "utf8");

    expect(source).toContain("function formatTimeInput(");
    expect(source).toContain("function appointmentDurationMinutes(");
    expect(source).toContain("const [showRescheduleForm, setShowRescheduleForm]");
    expect(source).toContain("trpc.appointments.reschedule.useMutation");
    expect(source).toContain("onReschedule={handleRescheduleAppointment}");
    expect(source).toContain("isAppointmentDateInputValid(rescheduleDate)");
    expect(source).toContain("isAppointmentDurationInputValid(rescheduleDuration)");
    expect(source).toContain(
      "appointmentInstantFromDateAndTime("
    );
    expect(source).toContain("rescheduleDate,");
    expect(source).toContain("rescheduleTime,");
    expect(source).toContain("timeZone");
    expect(source).toContain("Save changes");
    expect(source).toContain('label: "Confirm",');
    expect(source).toContain("Record client confirmation");
    expect(source).toContain(
      "Contact the client first. This records how they agreed to the"
    );
    expect(source).toContain("it does not send a message.");
    expect(source).toContain('type="radio"');
    expect(source).toContain("confirmationContactMethod");
    expect(source).toContain("Record confirmation");
    expect(source).toContain("doctorRequiredForAdvance");
    expect(source).toContain("setRescheduleDoctorId");
    expect(source).toContain("setRescheduleRoomId");
    expect(source).toContain(
      "Assign a doctor before confirming or checking in this appointment"
    );
    expect(source).toContain('disabled: doctorRequiredForAdvance');
    expect(source).toContain('current === "confirmed" && (');
    expect(source).toContain(
      "Changing the date, time, or duration returns this appointment to"
    );
    expect(source).toContain(
      "Appointment moved; contact the client and confirm the new time"
    );
    expect(source).toContain("resourceOptionsUnavailable");
    expect(source).toContain("Retry options");
    expect(source).toContain("max-h-[calc(100dvh-1.5rem)]");
    expect(source).toContain("overflow-y-auto");
    expect(source).toContain("htmlFor={rescheduleDoctorFieldId}");
    expect(source).toContain("id={rescheduleDoctorFieldId}");
    expect(source).toContain("htmlFor={rescheduleRoomFieldId}");
    expect(source).toContain("id={rescheduleRoomFieldId}");
    expect(source).toContain('label: "Reopen", status: "scheduled"');
    expect(source).not.toContain('label: "Reschedule", status: "scheduled"');
  });
});
