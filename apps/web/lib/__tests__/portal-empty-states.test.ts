import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

describe("portal empty states", () => {
  it("uses shared empty states on the portal home and invoice pages", () => {
    const home = source("app/portal/[token]/page.tsx");
    const invoices = source("app/portal/[token]/invoices/page.tsx");
    const messages = source("app/portal/[token]/messages/page.tsx");

    expect(home).toContain('import { EmptyState } from "@/components/common/empty-state"');
    expect(home).toContain('title="No pets on file yet"');
    expect(home).toContain('href={`/portal/${token}/messages`}');
    expect(invoices).toContain('import { EmptyState } from "@/components/common/empty-state"');
    expect(invoices).toContain('title="No invoices yet"');
    expect(messages).toContain('import { EmptyState } from "@/components/common/empty-state"');
    expect(messages).toContain('title="No portal messages yet"');
  });

  it("uses shared error states for portal load failures", () => {
    const home = source("app/portal/[token]/page.tsx");
    const appointments = source("app/portal/[token]/appointments/page.tsx");
    const invoices = source("app/portal/[token]/invoices/page.tsx");
    const messages = source("app/portal/[token]/messages/page.tsx");
    const petDetail = source("app/portal/[token]/pets/[petId]/page.tsx");

    for (const page of [home, appointments, invoices, messages, petDetail]) {
      expect(page).toContain("AlertCircle");
      expect(page).toContain("<EmptyState");
      expect(page).not.toContain('className="text-center py-20"');
    }

    expect(home).toContain('title="Unable to load portal"');
    expect(home).toContain("This portal link is invalid or has expired.");
    expect(home).toContain("if (error || !data)");
    expect(home).not.toContain("if (!data) return null");
    expect(appointments).toContain('title="Unable to load appointments"');
    expect(appointments).toContain("if (error || !data)");
    expect(appointments).not.toContain("data || []");
    expect(invoices).toContain('title="Unable to load invoices"');
    expect(invoices).toContain("if (error || !data)");
    expect(invoices).toContain("data.length === 0");
    expect(invoices).not.toContain("!data || data.length === 0");
    expect(messages).toContain('title="Unable to load messages"');
    expect(messages).toContain("if (error || !data)");
    expect(petDetail).toContain('title="Unable to load pet information"');
    expect(petDetail).toContain("if (error || !data)");
    expect(petDetail).not.toContain("if (!data) return null");
    expect(petDetail).toContain("Back to portal");
  });

  it("uses portal date helpers for portal pet dates", () => {
    const home = source("app/portal/[token]/page.tsx");
    const petDetail = source("app/portal/[token]/pets/[petId]/page.tsx");

    expect(home).toContain('import { calculatePortalAge } from "@/lib/portal/date"');
    expect(home).toContain("calculatePortalAge(pet.dob)");
    expect(home).not.toContain("new Date(dob)");
    expect(petDetail).toContain("formatPortalDate");
    expect(petDetail).toContain(
      "return formatPortalDate(d, undefined, timeZone)"
    );
    expect(petDetail).toContain(
      "formatDate(v.administeredAt, practiceTimeZone)"
    );
    expect(petDetail).toContain("formatDate(v.nextDueDate, practiceTimeZone)");
    expect(petDetail).toContain("formatDate(rx.endDate, practiceTimeZone)");
    expect(petDetail).toContain("formatDate(w.recordedAt, practiceTimeZone)");
    expect(petDetail).toContain(
      "portalCalendarDayDifference(\n      nextDue,\n      new Date(),\n      practiceTimeZone"
    );
    expect(petDetail).toContain("calculatePortalAge(data.dob)");
    expect(petDetail).not.toContain("new Date(nextDue)");
    expect(petDetail).not.toContain("new Date(dob)");
  });

  it("uses shared empty states for portal appointments", () => {
    const appointments = source("app/portal/[token]/appointments/page.tsx");

    expect(appointments).toContain('import { EmptyState } from "@/components/common/empty-state"');
    expect(appointments).toContain(
      'import { splitPortalAppointments } from "@/lib/portal/appointments"'
    );
    expect(appointments).toContain(
      "const { upcoming, past } = splitPortalAppointments(data)"
    );
    expect(appointments).not.toContain("Upcoming & Active");
    expect(appointments).toContain("Upcoming");
    expect(appointments).toContain(
      'title="No upcoming appointments or requests"'
    );
    expect(appointments).toContain('title="No past appointments"');
    expect(appointments).toContain('label: "Request appointment"');
    expect(appointments).not.toContain("data.filter((a)");
  });

  it("renders portal appointment times in the practice timezone", () => {
    const appointments = source("app/portal/[token]/appointments/page.tsx");

    expect(appointments).toContain(
      'import { formatPortalDateTime } from "@/lib/portal/date"'
    );
    expect(appointments).toContain(
      "function formatDateTime(d: string | Date, timeZone?: string | null)"
    );
    expect(appointments).toContain(
      "return formatPortalDateTime(d, undefined, timeZone)"
    );
    expect(appointments).toContain(
      "formatDateTime(appt.startTime, appt.timezone)"
    );
    expect(appointments).not.toContain("new Date(d).toLocaleString");
  });

  it("renders portal message times in the practice timezone", () => {
    const messages = source("app/portal/[token]/messages/page.tsx");

    expect(messages).toContain(
      'import { formatPortalDateTime } from "@/lib/portal/date"'
    );
    expect(messages).toContain("trpc.portal.getMessages.useQuery");
    expect(messages).toContain("trpc.portal.createMessage.useMutation");
    expect(messages).toContain("trpc.portal.markMessagesRead.useMutation");
    expect(messages).toContain('message.direction === "outbound"');
    expect(messages).toContain('message.status !== "read"');
    expect(messages).toContain("markedReadSignature.current = unreadClinicMessageIds");
    expect(messages).toContain("markMessagesRead.mutate({ token })");
    expect(messages).toContain(
      "formatPortalDateTime(\n                        message.createdAt,\n                        undefined,\n                        data.timezone"
    );
    expect(messages).not.toContain("new Date(message.createdAt)");
  });

  it("uses shared empty states for portal pet detail tabs", () => {
    const petDetail = source("app/portal/[token]/pets/[petId]/page.tsx");

    expect(petDetail).toContain('import { EmptyState } from "@/components/common/empty-state"');
    expect(petDetail).toContain('title="No vaccination records yet"');
    expect(petDetail).toContain('title="No active prescriptions"');
    expect(petDetail).toContain('title="No weight records yet"');
  });
});
