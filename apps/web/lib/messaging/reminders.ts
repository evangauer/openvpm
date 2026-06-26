/**
 * Shared reminder-delivery policy: quiet-hours windows and channel selection.
 * Pure functions so the cron sweep and the manual notifications router apply
 * identical rules (consent, preference, suppression-by-send, quiet hours).
 */

// TCPA quiet hours: no non-urgent texts before 8am or at/after 9pm local.
const QUIET_END_HOUR = 8; // 8am — sending allowed from here
const QUIET_START_HOUR = 21; // 9pm — quiet from here

/**
 * Is `now` within quiet hours for the given IANA timezone? We approximate the
 * recipient's local time with the practice/location timezone (we don't store a
 * per-client tz). Unknown/empty tz → not quiet (don't block).
 */
export function isQuietHours(
  now: Date,
  timeZone: string | null | undefined
): boolean {
  if (!timeZone) return false;
  let hour: number;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      hour12: false,
    }).formatToParts(now);
    hour = Number(parts.find((p) => p.type === "hour")?.value ?? "") % 24; // "24" → 0
  } catch {
    return false; // invalid tz → don't block
  }
  if (Number.isNaN(hour)) return false;
  return hour < QUIET_END_HOUR || hour >= QUIET_START_HOUR;
}

export type ReminderChannel = "sms" | "email" | "skip" | "none";

/**
 * Choose the channel for one reminder:
 * - "sms"   — client prefers SMS, has a phone + consent, and it's not quiet hours
 * - "email" — fall back to email whenever SMS isn't chosen and an email exists
 * - "skip"  — SMS-preferred but quiet hours and no email → defer to a later run
 * - "none"  — no usable channel
 * (The suppression list is enforced separately as a hard gate inside sendSms.)
 */
export function pickReminderChannel(opts: {
  preferredContactMethod: string | null | undefined;
  phone: string | null | undefined;
  smsConsent: boolean;
  hasEmail: boolean;
  quietHours: boolean;
}): ReminderChannel {
  const smsEligible =
    opts.preferredContactMethod === "sms" &&
    Boolean(opts.phone) &&
    opts.smsConsent;
  if (smsEligible && !opts.quietHours) return "sms";
  if (opts.hasEmail) return "email";
  if (smsEligible && opts.quietHours) return "skip";
  return "none";
}
