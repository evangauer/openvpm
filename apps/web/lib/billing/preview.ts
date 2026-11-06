/**
 * Preview before card: a hosted clinic shapes its workspace on sample data
 * before it is asked for payment details. The preview grants in-app setup
 * only. Anything that reaches people outside the clinic (email, texting, AI,
 * file storage, portal payments) still waits for the card-backed trial.
 *
 * Client-safe: the register form uses the same arm assignment as the server
 * so its copy matches what registration will do.
 */

import { inTreatment, percentFromEnv } from "@/lib/experiments/bucket";

const HOUR_MS = 60 * 60 * 1000;

/** How long a clinic can look around before the trial asks for a card. */
export const PREVIEW_HOURS = 72;

export const PREVIEW_PERCENT_ENV = "HOSTED_PREVIEW_PERCENT";

export type PreviewArm = "preview" | "control";

/**
 * Share of card-required hosted signups (0-100) that get the preview first.
 * Defaults to 0, so the existing checkout-first flow is unchanged until set.
 */
export function previewPercent(
  raw: string | undefined = process.env[PREVIEW_PERCENT_ENV],
): number {
  return percentFromEnv(raw);
}

/**
 * Deterministic arm for a funnel visitor, so a refresh or a second visit sees
 * the same signup. Visitors without a funnel id stay on the control path,
 * which keeps every preview signup attributable.
 */
export function previewArmFor(
  funnelId: string | null | undefined,
  percent: number,
): PreviewArm {
  return inTreatment(funnelId, percent, "preview-before-card")
    ? "preview"
    : "control";
}

export function previewEndsAtFrom(from: Date = new Date()): Date {
  return new Date(from.getTime() + PREVIEW_HOURS * HOUR_MS);
}

function validDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export interface PreviewPracticeState {
  billingStatus: string | null | undefined;
  trialEndsAt: Date | string | null | undefined;
  stripeSubscriptionId?: string | null;
  previewEndsAt: Date | string | null | undefined;
}

/**
 * The clinic started in a preview and has not yet started a trial or
 * subscription. True after the preview window closes, too: outbound sending
 * stays off until a card-backed trial exists.
 */
export function isPreviewPractice(practice: PreviewPracticeState): boolean {
  return (
    validDate(practice.previewEndsAt) !== null &&
    (practice.billingStatus ?? "none") === "none" &&
    !practice.trialEndsAt &&
    !practice.stripeSubscriptionId
  );
}

/** In-app setup access during an unexpired preview window. */
export function hasPreviewAccess(
  practice: PreviewPracticeState,
  now: Date = new Date(),
): boolean {
  if (!isPreviewPractice(practice)) return false;
  return validDate(practice.previewEndsAt)!.getTime() > now.getTime();
}

export const PREVIEW_OUTBOUND_BLOCK_MESSAGE =
  "Start your free trial to send email or texts to clients and staff. Your setup stays exactly as it is.";
