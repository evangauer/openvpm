import { describe, it, expect } from "vitest";
import { isQuietHours, pickReminderChannel } from "../reminders";

describe("isQuietHours", () => {
  // America/New_York is UTC-5 in January (EST).
  it("is quiet at 9:30pm local", () => {
    expect(
      isQuietHours(new Date("2026-01-16T02:30:00Z"), "America/New_York"),
    ).toBe(true); // 21:30 EST
  });
  it("trims saved timezone values before checking quiet hours", () => {
    expect(
      isQuietHours(new Date("2026-01-16T02:30:00Z"), " America/New_York "),
    ).toBe(true); // 21:30 EST
  });
  it("is quiet at 7:30am local", () => {
    expect(
      isQuietHours(new Date("2026-01-15T12:30:00Z"), "America/New_York"),
    ).toBe(true); // 07:30 EST
  });
  it("is allowed at 8:00am local", () => {
    expect(
      isQuietHours(new Date("2026-01-15T13:00:00Z"), "America/New_York"),
    ).toBe(false); // 08:00 EST
  });
  it("is allowed at 3:00pm local", () => {
    expect(
      isQuietHours(new Date("2026-01-15T20:00:00Z"), "America/New_York"),
    ).toBe(false); // 15:00 EST
  });
  it("fails closed when timezone is unknown or invalid", () => {
    expect(isQuietHours(new Date("2026-01-16T02:30:00Z"), null)).toBe(true);
    expect(isQuietHours(new Date("2026-01-16T02:30:00Z"), "Not/AZone")).toBe(
      true,
    );
  });
});

describe("pickReminderChannel", () => {
  const base = {
    preferredContactMethod: "sms" as string | null,
    phone: "+15555550123" as string | null,
    smsConsent: true,
    hasEmail: true,
    quietHours: false,
  };

  it("picks sms when preferred, consented, has phone, not quiet hours", () => {
    expect(pickReminderChannel(base)).toBe("sms");
  });
  it("falls back to email when not consented", () => {
    expect(pickReminderChannel({ ...base, smsConsent: false })).toBe("email");
  });
  it("falls back to email when no phone", () => {
    expect(pickReminderChannel({ ...base, phone: null })).toBe("email");
  });
  it("falls back to email when the stored phone is not SMS-capable", () => {
    expect(pickReminderChannel({ ...base, phone: "12345" })).toBe("email");
  });
  it("falls back to email when contact method is not sms", () => {
    expect(
      pickReminderChannel({ ...base, preferredContactMethod: "email" }),
    ).toBe("email");
  });
  it("skips (defers) when sms-preferred during quiet hours with no email", () => {
    expect(
      pickReminderChannel({ ...base, quietHours: true, hasEmail: false }),
    ).toBe("skip");
  });
  it("falls back to email during quiet hours when email exists", () => {
    expect(pickReminderChannel({ ...base, quietHours: true })).toBe("email");
  });
  it("defers automated SMS during quiet hours instead of changing channel", () => {
    expect(
      pickReminderChannel({
        ...base,
        quietHours: true,
        deferQuietHoursSms: true,
      }),
    ).toBe("skip");
  });
  it("returns none when there is no usable channel", () => {
    expect(
      pickReminderChannel({
        preferredContactMethod: "phone",
        phone: null,
        smsConsent: false,
        hasEmail: false,
        quietHours: false,
      }),
    ).toBe("none");
  });
  it("returns none instead of deferring quiet-hours SMS when the phone is invalid and no email exists", () => {
    expect(
      pickReminderChannel({
        ...base,
        phone: "not-a-phone",
        hasEmail: false,
        quietHours: true,
      }),
    ).toBe("none");
  });
});
