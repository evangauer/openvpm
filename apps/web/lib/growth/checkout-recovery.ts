const HOUR_MS = 60 * 60 * 1000;

export const CHECKOUT_RECOVERY_ENABLED_ENV = "CHECKOUT_RECOVERY_ENABLED";
export const CHECKOUT_RECOVERY_ROLLOUT_AT_ENV = "CHECKOUT_RECOVERY_ROLLOUT_AT";
export const CHECKOUT_RECOVERY_VERSION = "v1";

export type CheckoutRecoveryStep = 1 | 2 | 3 | 4;

/**
 * Registered-but-never-trialed follow-up. Each step is due a fixed time after
 * registration; the minimum gap keeps a delayed cron from sending a burst.
 */
export const CHECKOUT_RECOVERY_SCHEDULE: ReadonlyArray<{
  step: CheckoutRecoveryStep;
  afterHours: number;
}> = [
  { step: 1, afterHours: 1 },
  { step: 2, afterHours: 24 },
  { step: 3, afterHours: 72 },
  { step: 4, afterHours: 240 },
];

export const CHECKOUT_RECOVERY_MAX_EMAILS = CHECKOUT_RECOVERY_SCHEDULE.length;
/**
 * An unverified address may not belong to the person who registered, so it
 * gets only the resume link and the one-click question, never the full run.
 */
export const CHECKOUT_RECOVERY_UNVERIFIED_MAX_EMAILS = 2;
export const CHECKOUT_RECOVERY_MIN_GAP_HOURS = 20;
/** Registrations older than this are left to personal follow-up. */
export const CHECKOUT_RECOVERY_MAX_AGE_HOURS = 30 * 24;

export type CheckoutRecoveryConfig =
  | { enabled: false; reason: "disabled" | "rollout_at_invalid" }
  | { enabled: true; rolloutAt: Date };

/**
 * Prospective-only campaign gate, matching first-clinic-win: the rollout
 * timestamp is mandatory so enabling the campaign never emails every
 * historical registration.
 */
export function checkoutRecoveryConfig(): CheckoutRecoveryConfig {
  if (
    process.env[CHECKOUT_RECOVERY_ENABLED_ENV]?.trim().toLowerCase() !== "true"
  ) {
    return { enabled: false, reason: "disabled" };
  }
  const rolloutAt = new Date(
    process.env[CHECKOUT_RECOVERY_ROLLOUT_AT_ENV]?.trim() ?? "",
  );
  if (Number.isNaN(rolloutAt.getTime())) {
    return { enabled: false, reason: "rollout_at_invalid" };
  }
  return { enabled: true, rolloutAt };
}

export const CHECKOUT_RECOVERY_DEDUPE_BASE = `lc:checkout-recovery:${CHECKOUT_RECOVERY_VERSION}:`;

export function checkoutRecoveryDedupePrefix(practiceId: string): string {
  return `${CHECKOUT_RECOVERY_DEDUPE_BASE}${practiceId}:`;
}

export function checkoutRecoveryDedupeKey(
  practiceId: string,
  step: CheckoutRecoveryStep,
): string {
  return `${checkoutRecoveryDedupePrefix(practiceId)}${step}`;
}

function validDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The step due now, or null when nothing should send this run. */
export function checkoutRecoveryStepDue(input: {
  now: Date;
  createdAt: Date | string;
  existingEmailCount: number;
  lastEmailAt: Date | string | null;
  recipientVerified: boolean;
}): CheckoutRecoveryStep | null {
  const createdAt = validDate(input.createdAt);
  if (!createdAt) return null;
  const ageMs = input.now.getTime() - createdAt.getTime();
  if (ageMs > CHECKOUT_RECOVERY_MAX_AGE_HOURS * HOUR_MS) return null;

  const maxEmails = input.recipientVerified
    ? CHECKOUT_RECOVERY_MAX_EMAILS
    : CHECKOUT_RECOVERY_UNVERIFIED_MAX_EMAILS;
  if (input.existingEmailCount >= maxEmails) return null;
  const next = CHECKOUT_RECOVERY_SCHEDULE[input.existingEmailCount];
  if (!next) return null;
  if (ageMs < next.afterHours * HOUR_MS) return null;

  const lastEmailAt = validDate(input.lastEmailAt);
  if (
    lastEmailAt &&
    input.now.getTime() - lastEmailAt.getTime() <
      CHECKOUT_RECOVERY_MIN_GAP_HOURS * HOUR_MS
  ) {
    return null;
  }
  return next.step;
}

export const STOP_REASONS = [
  "card",
  "price",
  "timing",
  "missing_feature",
  "self_host",
  "other",
] as const;

export type StopReason = (typeof STOP_REASONS)[number];

export const STOP_REASON_LABELS: Record<StopReason, string> = {
  card: "I didn't want to enter a card yet",
  price: "The price doesn't fit",
  timing: "It's not the right time",
  missing_feature: "It's missing something we need",
  self_host: "We'd rather self-host",
  other: "Something else",
};

export function isStopReason(value: unknown): value is StopReason {
  return (
    typeof value === "string" &&
    (STOP_REASONS as readonly string[]).includes(value)
  );
}

export const STOP_REASON_NOTE_MAX_LENGTH = 500;

/** First word of the admin's name, for a personal greeting. */
export function greetingName(name: string | null | undefined): string | null {
  const first = name?.trim().split(/\s+/)[0];
  return first && first.length <= 40 ? first : null;
}
