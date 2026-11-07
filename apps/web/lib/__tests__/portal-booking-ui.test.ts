import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("portal booking UI", () => {
  const source = readFileSync("app/portal/[token]/book/page.tsx", "utf8");
  const appointmentsSource = readFileSync(
    "app/portal/[token]/appointments/page.tsx",
    "utf8"
  );

  it("fails closed while portal client data is loading or invalid", () => {
    expect(source).toContain('import { EmptyState } from "@/components/common/empty-state"');
    expect(source).toContain("if (client.isLoading)");
    expect(source).toContain("if (client.error || !client.data)");
    expect(source).toContain('title="Unable to load booking form"');
    expect(source).toContain('title="No pets on file yet"');
    expect(source).toContain("clientData.locations.length === 0");
    expect(source).toContain(
      "has not configured an active scheduling location",
    );
    expect(source).not.toContain("if (!client.data) return null");
  });

  it("requests open slots using the selected appointment type duration", () => {
    expect(source).toContain(
      "const verifiedAppointmentTypes ="
    );
    expect(source).toContain(
      "types.error || appointmentTypesMissing || !types.data ? null : types.data"
    );
    expect(source).toContain(
      "const appointmentTypes = verifiedAppointmentTypes ?? []"
    );
    expect(source).toContain(
      "const selectedType = verifiedAppointmentTypes?.find((t) => t.id === typeId)"
    );
    expect(source).toContain(
      "const selectedDurationMinutes = selectedType?.durationMinutes ?? 30"
    );
    expect(source).toContain(
      "const timeBounds = portalBookingTimeBounds(selectedDurationMinutes)"
    );
    expect(source).toContain("const hasValidBookingWindow = Boolean(timeBounds.maxTime)");
    expect(source).toContain(
      "const hasValidPreferredTime = isPortalBookingStartWithinBounds("
    );
    expect(source).toContain(
      "durationMinutes: selectedDurationMinutes,\n      typeId: typeId || undefined,\n      locationId: locationId || undefined"
    );
    expect(source).not.toContain("const appointmentTypes = types.data ?? []");
    expect(source).not.toContain(
      "{ token, date: preferredDate, durationMinutes: 30 }"
    );
  });

  it("bounds manual time entry to the selected duration's booking window", () => {
    expect(source).toContain(
      'import { formatPortalDateInput } from "@/lib/portal/date"'
    );
    expect(source).toContain(
      "const clientData = client.data"
    );
    expect(source).toContain(
      "const today = formatPortalDateInput(new Date(), clientData.timezone)"
    );
    expect(source).toContain("const pets = clientData.patients");
    expect(source.indexOf("if (client.error || !client.data)")).toBeLessThan(
      source.indexOf("const today = formatPortalDateInput")
    );
    expect(source).not.toContain("client.data?.timezone");
    expect(source).not.toContain("new Date().toISOString().slice(0, 10)");
    expect(source).toContain('min={timeBounds.minTime}');
    expect(source).toContain('max={timeBounds.maxTime ?? timeBounds.minTime}');
    expect(source).toContain('disabled={!hasValidBookingWindow}');
    expect(source).toContain("hasValidPreferredTime &&");
    expect(source).toContain("aria-invalid={showTimeBoundsError}");
    expect(source).toContain("Choose a start time from");
    expect(source).toContain("This visit type is longer than the online booking window.");
  });

  it("clears stale preferred times when date or appointment type changes", () => {
    expect(
      source.match(/setPreferredTime\(""\)/g)?.length
    ).toBeGreaterThanOrEqual(2);
  });

  it("surfaces appointment type and slot query states", () => {
    expect(source).toContain("const appointmentTypesMissing =");
    expect(source).toContain("const appointmentTypesUnavailable =");
    expect(source).toContain("Boolean(types.error) || appointmentTypesMissing");
    expect(source).toContain("appointmentTypes.length === 0");
    expect(source).toContain('title="Appointment requests are unavailable"');
    expect(source).toContain(
      "const hasValidAppointmentType = Boolean(typeId && selectedType)"
    );
    expect(source).toContain(
      "{ enabled: !!preferredDate && hasValidAppointmentType && !!locationId }"
    );
    expect(source).toContain(
      "patientId,\n      typeId,\n      locationId,\n      preferredDate,"
    );
    expect(source).toContain("slots.isLoading");
    expect(source).toContain("Checking suggested times");
    expect(source).toContain("const slotsUnavailable = Boolean(");
    expect(source).toContain("Boolean(slots.error) || !slots.data");
    expect(source).toContain("Suggested times could not be loaded");
    expect(source).toContain(
      "No suggested request times are available for this date"
    );
    expect(source).toContain("slots.data.length === 0");
    expect(source).toContain("slots.data.length > 0");
    expect(source).not.toContain("(slots.data?.length ?? 0)");
    expect(source).not.toContain("slots.data!.map");
  });

  it("bounds appointment request reasons before submit", () => {
    expect(source).toContain("isPortalBookingReasonValid");
    expect(source).toContain("PORTAL_BOOKING_REASON_MAX_LENGTH");
    expect(source).toContain("const hasValidReason = isPortalBookingReasonValid(reason)");
    expect(source).toContain("hasValidReason &&");
    expect(source).toContain("maxLength={PORTAL_BOOKING_REASON_MAX_LENGTH}");
    expect(source).toContain("aria-invalid={reason.length > 0 && !hasValidReason}");
    expect(source).not.toContain("reason.trim() &&");
  });

  it("does not present an unconfirmed request as a scheduled appointment", () => {
    expect(source).toContain("Requested — not yet confirmed");
    expect(appointmentsSource).toContain(
      'if (status === "scheduled" && isClientRequest)'
    );
    expect(appointmentsSource).toContain(
      'return status.replace(/_/g, " ").replace(/\\b\\w/g, (c) => c.toUpperCase())'
    );
    expect(appointmentsSource).toContain(
      "formatStatusLabel(appt.status, appt.isClientRequest)"
    );
    expect(appointmentsSource).toContain("Upcoming and requests");
  });
});
