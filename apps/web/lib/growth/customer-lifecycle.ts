import type { StopReason } from "@/lib/growth/checkout-recovery";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const CUSTOMER_LIFECYCLE_ENABLED_ENV = "CUSTOMER_LIFECYCLE_ENABLED";
export const CUSTOMER_LIFECYCLE_ROLLOUT_AT_ENV = "CUSTOMER_LIFECYCLE_ROLLOUT_AT";

export type CustomerLifecycleConfig =
  | { enabled: false; reason: "disabled" | "rollout_at_invalid" }
  | { enabled: true; rolloutAt: Date };

/**
 * Default-off, prospective-only. Each campaign only reaches clinics whose
 * triggering moment (trial start, trial end, first payment) is after rollout.
 */
export function customerLifecycleConfig(): CustomerLifecycleConfig {
  if (
    process.env[CUSTOMER_LIFECYCLE_ENABLED_ENV]?.trim().toLowerCase() !== "true"
  ) {
    return { enabled: false, reason: "disabled" };
  }
  const rolloutAt = new Date(
    process.env[CUSTOMER_LIFECYCLE_ROLLOUT_AT_ENV]?.trim() ?? "",
  );
  if (Number.isNaN(rolloutAt.getTime())) {
    return { enabled: false, reason: "rollout_at_invalid" };
  }
  return { enabled: true, rolloutAt };
}

function validDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// ---------------------------------------------------------------------------
// Team invite: one nudge for a clinic that is using OpenVPM alone.
// ---------------------------------------------------------------------------

export const TEAM_INVITE_DEDUPE_BASE = "lc:team-invite:v1:";
/** Days after the trial starts before nudging, so setup comes first. */
export const TEAM_INVITE_AFTER_DAYS = 3;

export function teamInviteDedupeKey(practiceId: string): string {
  return `${TEAM_INVITE_DEDUPE_BASE}${practiceId}`;
}

// ---------------------------------------------------------------------------
// Trial win-back: three notes after a trial ends without billing.
// ---------------------------------------------------------------------------

export type TrialWinbackStep = 1 | 2 | 3;

export const TRIAL_WINBACK_DEDUPE_BASE = "lc:trial-winback:v1:";
export const TRIAL_WINBACK_SCHEDULE: ReadonlyArray<{
  step: TrialWinbackStep;
  afterHours: number;
}> = [
  { step: 1, afterHours: 24 },
  { step: 2, afterHours: 7 * 24 },
  { step: 3, afterHours: 21 * 24 },
];
export const TRIAL_WINBACK_MAX_EMAILS = TRIAL_WINBACK_SCHEDULE.length;
export const TRIAL_WINBACK_MIN_GAP_HOURS = 72;
export const TRIAL_WINBACK_MAX_AGE_DAYS = 30;

/** Reasons a lapsed clinic can give in one click; card is not one of them. */
export const TRIAL_WINBACK_REASONS: readonly StopReason[] = [
  "price",
  "missing_feature",
  "timing",
  "self_host",
  "other",
];

export function trialWinbackDedupeKey(
  practiceId: string,
  step: TrialWinbackStep,
): string {
  return `${TRIAL_WINBACK_DEDUPE_BASE}${practiceId}:${step}`;
}

export function trialWinbackStepDue(input: {
  now: Date;
  trialEndedAt: Date | string;
  existingEmailCount: number;
  lastEmailAt: Date | string | null;
}): TrialWinbackStep | null {
  const endedAt = validDate(input.trialEndedAt);
  if (!endedAt) return null;
  const ageMs = input.now.getTime() - endedAt.getTime();
  if (ageMs < 0 || ageMs > TRIAL_WINBACK_MAX_AGE_DAYS * DAY_MS) return null;

  const next = TRIAL_WINBACK_SCHEDULE[input.existingEmailCount];
  if (!next || ageMs < next.afterHours * HOUR_MS) return null;

  const lastEmailAt = validDate(input.lastEmailAt);
  if (
    lastEmailAt &&
    input.now.getTime() - lastEmailAt.getTime() <
      TRIAL_WINBACK_MIN_GAP_HOURS * HOUR_MS
  ) {
    return null;
  }
  return next.step;
}

// ---------------------------------------------------------------------------
// Adoption: one note two weeks after the first payment, naming what the
// clinic has not turned on yet.
// ---------------------------------------------------------------------------

export const ADOPTION_DEDUPE_BASE = "lc:adoption:v1:";
export const ADOPTION_AFTER_DAYS = 14;
/** Older than this and the note no longer reads as onboarding. */
export const ADOPTION_MAX_AGE_DAYS = 45;

export type AdoptionGap = "reminders" | "team" | "portal";

export function adoptionDedupeKey(practiceId: string): string {
  return `${ADOPTION_DEDUPE_BASE}${practiceId}`;
}

/** What a paying clinic has not set up yet, most valuable first. */
export function adoptionGaps(usage: {
  remindersEnabled: boolean;
  staffCount: number;
  portalSessions: number;
}): AdoptionGap[] {
  const gaps: AdoptionGap[] = [];
  if (!usage.remindersEnabled) gaps.push("reminders");
  if (usage.staffCount <= 1) gaps.push("team");
  if (usage.portalSessions === 0) gaps.push("portal");
  return gaps;
}

// ---------------------------------------------------------------------------
// NPS: first ask 30 days after the first payment, then every 90 days.
// ---------------------------------------------------------------------------

export const NPS_DEDUPE_BASE = "lc:nps:v1:";
export const NPS_FIRST_AFTER_DAYS = 30;
export const NPS_INTERVAL_DAYS = 90;
/** A cycle's email goes out only in its first two weeks, never late. */
export const NPS_SEND_WINDOW_DAYS = 14;

/**
 * The survey cycle due now (1 at day 30, 2 at day 120, ...) or null between
 * windows. The cycle names the survey, so each one is asked once.
 */
export function npsCycleDue(input: {
  now: Date;
  payingSince: Date | string;
}): number | null {
  const since = validDate(input.payingSince);
  if (!since) return null;
  const ageDays = (input.now.getTime() - since.getTime()) / DAY_MS;
  if (ageDays < NPS_FIRST_AFTER_DAYS) return null;
  const intoCycles = ageDays - NPS_FIRST_AFTER_DAYS;
  const cycle = Math.floor(intoCycles / NPS_INTERVAL_DAYS) + 1;
  const intoWindow = intoCycles - (cycle - 1) * NPS_INTERVAL_DAYS;
  return intoWindow < NPS_SEND_WINDOW_DAYS ? cycle : null;
}

export function npsSurveyKey(cycle: number): string {
  return `nps:${cycle}`;
}

export function npsDedupeKey(practiceId: string, cycle: number): string {
  return `${NPS_DEDUPE_BASE}${practiceId}:${cycle}`;
}

export type NpsCategory = "promoter" | "passive" | "detractor";

export function npsCategory(score: number): NpsCategory {
  if (score >= 9) return "promoter";
  if (score >= 7) return "passive";
  return "detractor";
}

export function isNpsScore(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 10;
}

export const NPS_COMMENT_MAX_LENGTH = 1000;

/** Net Promoter Score (-100 to 100), or null with no answers. */
export function netPromoterScore(scores: readonly number[]): number | null {
  if (scores.length === 0) return null;
  const promoters = scores.filter((s) => s >= 9).length;
  const detractors = scores.filter((s) => s <= 6).length;
  return Math.round(((promoters - detractors) / scores.length) * 100);
}

/** "14 clients and 22 appointments" for a win-back note, or null. */
export function usageSummaryPhrase(usage: {
  clients: number;
  appointments: number;
  invoices: number;
}): string | null {
  const parts = [
    usage.clients > 0
      ? `${usage.clients} client${usage.clients === 1 ? "" : "s"}`
      : null,
    usage.appointments > 0
      ? `${usage.appointments} appointment${usage.appointments === 1 ? "" : "s"}`
      : null,
    usage.invoices > 0
      ? `${usage.invoices} invoice${usage.invoices === 1 ? "" : "s"}`
      : null,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
