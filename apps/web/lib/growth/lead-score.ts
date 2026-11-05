import { isStopReason, STOP_REASON_LABELS } from "@/lib/growth/checkout-recovery";

const DAY_MS = 24 * 60 * 60 * 1000;

export const LEAD_INTENT_DECAY_DAYS = 14;
export const LEAD_HOT_THRESHOLD = 70;
export const LEAD_WARM_THRESHOLD = 40;

export type LeadTier = "hot" | "warm" | "nurture" | "self_host" | "customer";

export interface LeadScoreInput {
  now: Date;
  clinicModel: string | null;
  firstGoal: string | null;
  onboardingIntent: string | null;
  setupStarted: boolean;
  setupCompleted: boolean;
  helpRequested: boolean;
  stopReason: string | null;
  realClientCount: number;
  realAppointmentCount: number;
  activated: boolean;
  paymentMethodCollected: boolean;
  firstPositivePayment: boolean;
  lastMeaningfulActivityAt: Date;
}

export interface LeadScore {
  fit: number;
  intent: number;
  total: number;
  tier: LeadTier;
  /** Human-readable reasons, strongest first. Shown beside the rank. */
  reasons: string[];
}

const CLINIC_MODEL_FIT: Record<string, [number, string]> = {
  companion: [25, "Companion clinic"],
  mobile: [20, "Mobile practice"],
  specialty: [20, "Specialty practice"],
  equine: [12, "Equine or farm"],
  shelter: [12, "Shelter or nonprofit"],
  exploring: [5, "Exploring"],
};

const FIRST_GOAL_FIT: Record<string, [number, string]> = {
  run_visit: [25, "Wants to run a real visit"],
  import_records: [25, "Wants to bring over records"],
  start_fresh: [20, "Starting fresh"],
  explore_sample: [8, "Exploring sample data"],
};

type Signal = { points: number; reason: string };

function sum(signals: Signal[], cap: number): number {
  return Math.min(
    cap,
    signals.reduce((total, signal) => total + signal.points, 0),
  );
}

/**
 * Transparent v0 lead score: fit (who they are) plus intent (what they did).
 * Opens and sample-data clicks never count. Intent halves after two quiet
 * weeks so old activity stops outranking a fresh hand-raise.
 */
export function scoreLead(input: LeadScoreInput): LeadScore {
  const fitSignals: Signal[] = [];
  const model = input.clinicModel ? CLINIC_MODEL_FIT[input.clinicModel] : null;
  if (model) fitSignals.push({ points: model[0], reason: model[1] });
  const goal = input.firstGoal ? FIRST_GOAL_FIT[input.firstGoal] : null;
  if (goal) fitSignals.push({ points: goal[0], reason: goal[1] });

  const handRaise = input.helpRequested || isStopReason(input.stopReason);
  const intentSignals: Signal[] = [];
  if (input.helpRequested) {
    intentSignals.push({ points: 25, reason: "Asked for setup help" });
  }
  if (isStopReason(input.stopReason)) {
    intentSignals.push({
      points: 25,
      reason: `Told us why they stopped: ${STOP_REASON_LABELS[input.stopReason].toLowerCase()}`,
    });
  }
  if (input.activated) {
    intentSignals.push({ points: 20, reason: "Ran a first real visit" });
  }
  if (input.paymentMethodCollected) {
    intentSignals.push({ points: 15, reason: "Added a payment method" });
  }
  if (input.realClientCount > 0) {
    intentSignals.push({
      points: 15,
      reason: `${input.realClientCount} real client${input.realClientCount === 1 ? "" : "s"}`,
    });
  }
  if (input.setupCompleted) {
    intentSignals.push({ points: 5, reason: "Finished guided setup" });
  } else if (input.setupStarted) {
    intentSignals.push({ points: 3, reason: "Started guided setup" });
  }
  intentSignals.push({ points: 10, reason: "Created an account" });

  const fit = sum(fitSignals, 50);
  let intent = sum(intentSignals, 50);
  const quietDays = Math.floor(
    (input.now.getTime() - input.lastMeaningfulActivityAt.getTime()) / DAY_MS,
  );
  const decayed = quietDays > LEAD_INTENT_DECAY_DAYS;
  if (decayed) intent = Math.floor(intent / 2);
  const total = fit + intent;

  let tier: LeadTier;
  if (input.firstPositivePayment) tier = "customer";
  else if (
    input.onboardingIntent === "self_host" ||
    input.firstGoal === "self_host" ||
    input.stopReason === "self_host"
  ) {
    tier = "self_host";
  } else if (handRaise || total >= LEAD_HOT_THRESHOLD) tier = "hot";
  else if (total >= LEAD_WARM_THRESHOLD) tier = "warm";
  else tier = "nurture";

  const reasons = [...intentSignals, ...fitSignals]
    .sort((a, b) => b.points - a.points)
    .map((signal) => signal.reason);
  if (decayed) reasons.push(`Quiet for ${quietDays} days`);

  return { fit, intent, total, tier, reasons };
}
