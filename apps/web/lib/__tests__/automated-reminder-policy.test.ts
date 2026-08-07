import { describe, expect, it } from "vitest";
import {
  automatedAppointmentReminderSuppressionReason,
  hasReservedEmailDomain,
} from "../automated-reminder-policy";

describe("automated reminder delivery policy", () => {
  it("suppresses records marked as either a seeded demo client or appointment", () => {
    expect(
      automatedAppointmentReminderSuppressionReason({
        isSeededDemoClient: true,
        clientEmail: "client@realclinic.com",
      })
    ).toBe("seeded_demo_data");

    expect(
      automatedAppointmentReminderSuppressionReason({
        isSeededDemoAppointment: true,
        clientEmail: "client@realclinic.com",
      })
    ).toBe("seeded_demo_data");
  });

  it.each([
    "client@example.com",
    "client@subdomain.example.net",
    "client@clinic.example",
    "client@clinic.invalid",
    "client@clinic.localhost",
    "client@reminders.openvpm.test",
  ])("recognizes reserved fixture address %s", (email) => {
    expect(hasReservedEmailDomain(email)).toBe(true);
    expect(
      automatedAppointmentReminderSuppressionReason({ clientEmail: email })
    ).toBe("reserved_email_domain");
  });

  it.each([
    "client@realclinic.com",
    "test@gmail.com",
    "client@example.health",
    "client@contest.com",
  ])("does not suppress deliverable-looking address %s", (email) => {
    expect(hasReservedEmailDomain(email)).toBe(false);
    expect(
      automatedAppointmentReminderSuppressionReason({ clientEmail: email })
    ).toBeNull();
  });
});
