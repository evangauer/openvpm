import { sql } from "drizzle-orm";
import type { Database } from "@openpims/db/client";
import { withSystem } from "@/lib/tenant-db";

const DAY_MS = 24 * 60 * 60 * 1000;
export const TRIAL_ENDING_SOON_DAYS = 3;

export type RecoveryTrialState =
  | "active"
  | "ending_soon"
  | "expired"
  | "no_trial";

export type RecoveryStage =
  | "registered"
  | "setup_started"
  | "setup_complete"
  | "client_added"
  | "appointment_booked"
  | "activated"
  | "payment_method_collected"
  | "first_positive_payment";

export interface RecoveryNextAction {
  priority: number;
  label: string;
}

export interface ActivationRecoveryPractice {
  queueRank: number;
  practiceId: string;
  practiceName: string;
  billingStatus: string;
  trialEndsAt: Date | null;
  trialState: RecoveryTrialState;
  timezone: string;
  createdAt: Date;
  verifiedAdminName: string | null;
  verifiedAdminEmail: string | null;
  verifiedAdminEmailAt: Date | null;
  setupStage: string;
  setupHelpRequestedAt: Date | null;
  realClientCount: number;
  realAppointmentCount: number;
  lastMeaningfulActivityAt: Date;
  stallAgeDays: number;
  authoritativeStage: RecoveryStage;
  nextAction: string;
  nextActionPriority: number;
}

interface RecoveryRow {
  practiceId: string;
  practiceName: string;
  billingStatus: string;
  trialEndsAt: Date | string | null;
  timezone: string;
  createdAt: Date | string;
  settings: unknown;
  verifiedAdminName: string | null;
  verifiedAdminEmail: string | null;
  verifiedAdminEmailAt: Date | string | null;
  activeAdminCount: number | string;
  realClientCount: number | string;
  realAppointmentCount: number | string;
  activated: boolean;
  paymentMethodCollected: boolean;
  firstPositivePayment: boolean;
  lastMeaningfulActivityAt: Date | string;
}

type RecoverySettings = {
  onboardingCompletedAt?: string | null;
  onboardingState?: {
    journeyStepId?: string | null;
    journeyDismissed?: boolean;
    setupHelpRequestedAt?: string | null;
  };
};

const setupStepLabels: Record<string, string> = {
  intent: "Starting path",
  basics: "Clinic basics",
  branding: "Branding",
  team: "Team",
  data: "Data import",
  agent: "AI helper",
  phone: "Texting",
  billing: "Billing",
  allSet: "Finish",
};

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

function validDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function classifyRecoveryTrial(
  billingStatus: string,
  trialEndsAt: Date | string | null | undefined,
  now: Date,
): RecoveryTrialState {
  const end = validDate(trialEndsAt);
  if (billingStatus !== "trialing" || !end) return "no_trial";
  if (end.getTime() <= now.getTime()) return "expired";
  if (end.getTime() <= now.getTime() + TRIAL_ENDING_SOON_DAYS * DAY_MS) {
    return "ending_soon";
  }
  return "active";
}

export function recoverySetupState(settingsValue: unknown): {
  completed: boolean;
  completedAt: Date | null;
  started: boolean;
  stage: string;
  helpRequestedAt: Date | null;
} {
  const settings = (settingsValue ?? {}) as RecoverySettings;
  const state = settings.onboardingState;
  const helpRequestedAt = validDate(state?.setupHelpRequestedAt);
  const completedAt = validDate(settings.onboardingCompletedAt);
  if (completedAt) {
    return {
      completed: true,
      completedAt,
      started: true,
      stage: "Complete",
      helpRequestedAt,
    };
  }
  const step = state?.journeyStepId?.trim();
  if (step) {
    const label = setupStepLabels[step] ?? step;
    return {
      completed: false,
      completedAt: null,
      started: true,
      stage: state?.journeyDismissed ? `Paused at ${label}` : label,
      helpRequestedAt,
    };
  }
  return {
    completed: false,
    completedAt: null,
    started: false,
    stage: "Not started",
    helpRequestedAt,
  };
}

export function deriveRecoveryStage(input: {
  activated: boolean;
  paymentMethodCollected: boolean;
  firstPositivePayment: boolean;
  setupStarted: boolean;
  setupCompleted: boolean;
  realClientCount: number;
  realAppointmentCount: number;
}): RecoveryStage {
  if (input.firstPositivePayment) return "first_positive_payment";
  if (input.paymentMethodCollected) return "payment_method_collected";
  if (input.activated) return "activated";
  if (input.realAppointmentCount > 0) return "appointment_booked";
  if (input.realClientCount > 0) return "client_added";
  if (input.setupCompleted) return "setup_complete";
  if (input.setupStarted) return "setup_started";
  return "registered";
}

export function deriveRecoveryNextAction(input: {
  billingStatus: string;
  trialState: RecoveryTrialState;
  stage: RecoveryStage;
  setupStage: string;
  setupHelpRequested: boolean;
  hasVerifiedAdmin: boolean;
  hasAnyAdmin: boolean;
}): RecoveryNextAction {
  if (input.setupHelpRequested) {
    return { priority: 100, label: "Respond to setup help request" };
  }
  if (!input.hasVerifiedAdmin) {
    return {
      priority: 95,
      label: input.hasAnyAdmin
        ? "Verify the primary admin email"
        : "Restore an admin contact",
    };
  }
  if (input.billingStatus === "past_due") {
    return { priority: 92, label: "Resolve the past-due subscription" };
  }
  if (input.trialState === "expired") {
    return { priority: 90, label: "Review a qualified trial extension" };
  }
  if (input.trialState === "no_trial" && input.billingStatus !== "active") {
    return { priority: 85, label: "Restore trial or billing access" };
  }
  if (input.stage === "first_positive_payment") {
    return { priority: 20, label: "Support retention and expansion" };
  }
  if (
    input.billingStatus === "active" &&
    input.stage !== "payment_method_collected"
  ) {
    return {
      priority: 50,
      label: "Review unknown historical payment evidence",
    };
  }
  if (
    input.trialState === "ending_soon" &&
    input.stage !== "payment_method_collected"
  ) {
    return {
      priority: 80,
      label: "Help add a payment method before trial end",
    };
  }
  switch (input.stage) {
    case "registered":
      return { priority: 75, label: "Invite clinic into guided setup" };
    case "setup_started":
      return { priority: 70, label: `Unblock ${input.setupStage}` };
    case "setup_complete":
      return { priority: 65, label: "Help import the first real client" };
    case "client_added":
      return { priority: 60, label: "Help book the first real appointment" };
    case "appointment_booked":
      return { priority: 60, label: "Help add the appointment's client" };
    case "activated":
      return { priority: 55, label: "Invite clinic to add a payment method" };
    case "payment_method_collected":
      return {
        priority: 45,
        label: "Support the first successful clinic week",
      };
  }
}

/**
 * One system-scoped aggregate statement for the operator recovery queue. Demo,
 * analytics-excluded, and soft-deleted rows never become clinic progress.
 */
export async function computeActivationRecovery(
  db: Database,
  now: Date = new Date(),
): Promise<ActivationRecoveryPractice[]> {
  const result = await withSystem(db, (tx) =>
    tx.execute(sql`
      with practice_base as (
        select
          p.id,
          p.name,
          p.billing_status,
          p.trial_ends_at,
          p.timezone,
          p.created_at,
          p.settings,
          coalesce(p.settings -> 'demoData' -> 'clientIds', '[]'::jsonb)
            as demo_client_ids,
          coalesce(p.settings -> 'demoData' -> 'appointmentIds', '[]'::jsonb)
            as demo_appointment_ids
        from practices p
        where p.deleted_at is null
          and p.settings ->> 'analyticsExcluded' is distinct from 'true'
      ), verified_admin as (
        select distinct on (u.practice_id)
          u.practice_id,
          u.name,
          u.email,
          u.email_verified_at
        from users u
        join practice_base pb on pb.id = u.practice_id
        where u.role = 'admin'
          and u.deleted_at is null
          and u.email_verified_at is not null
        order by u.practice_id, u.created_at, u.id
      ), admin_stats as (
        select u.practice_id, count(*)::int as active_admin_count
        from users u
        join practice_base pb on pb.id = u.practice_id
        where u.role = 'admin'
          and u.deleted_at is null
        group by u.practice_id
      ), client_stats as (
        select
          pb.id as practice_id,
          count(c.id)::int as real_client_count,
          max(greatest(c.created_at, c.updated_at)) as last_real_client_at
        from practice_base pb
        left join clients c
          on c.practice_id = pb.id
          and c.deleted_at is null
          and not (pb.demo_client_ids @> to_jsonb(c.id::text))
        group by pb.id
      ), appointment_stats as (
        select
          pb.id as practice_id,
          count(a.id)::int as real_appointment_count,
          max(greatest(a.created_at, a.updated_at)) as last_real_appointment_at
        from practice_base pb
        left join appointments a
          on a.practice_id = pb.id
          and a.deleted_at is null
          and not (pb.demo_appointment_ids @> to_jsonb(a.id::text))
        group by pb.id
      ), milestone_stats as (
        select
          pcm.practice_id,
          bool_or(pcm.milestone = 'activated') as activated,
          bool_or(pcm.milestone = 'payment_method_collected')
            as payment_method_collected,
          bool_or(pcm.milestone = 'first_positive_payment')
            as first_positive_payment,
          max(pcm.occurred_at) as last_milestone_at
        from practice_conversion_milestones pcm
        join practice_base pb on pb.id = pcm.practice_id
        group by pcm.practice_id
      )
      select
        pb.id as "practiceId",
        pb.name as "practiceName",
        pb.billing_status as "billingStatus",
        pb.trial_ends_at as "trialEndsAt",
        pb.timezone,
        pb.created_at as "createdAt",
        pb.settings,
        verified_admin.name as "verifiedAdminName",
        verified_admin.email as "verifiedAdminEmail",
        verified_admin.email_verified_at as "verifiedAdminEmailAt",
        coalesce(admins.active_admin_count, 0)::int as "activeAdminCount",
        coalesce(client_stats.real_client_count, 0)::int as "realClientCount",
        coalesce(appointment_stats.real_appointment_count, 0)::int
          as "realAppointmentCount",
        coalesce(milestone_stats.activated, false) as "activated",
        coalesce(milestone_stats.payment_method_collected, false)
          as "paymentMethodCollected",
        coalesce(milestone_stats.first_positive_payment, false)
          as "firstPositivePayment",
        greatest(
          pb.created_at,
          client_stats.last_real_client_at,
          appointment_stats.last_real_appointment_at,
          milestone_stats.last_milestone_at
        ) as "lastMeaningfulActivityAt"
      from practice_base pb
      left join verified_admin on verified_admin.practice_id = pb.id
      left join admin_stats admins on admins.practice_id = pb.id
      left join client_stats on client_stats.practice_id = pb.id
      left join appointment_stats on appointment_stats.practice_id = pb.id
      left join milestone_stats on milestone_stats.practice_id = pb.id
      order by pb.created_at, pb.id
    `),
  );

  const practices = rowsFromExecute<RecoveryRow>(result).map((row) => {
    const createdAt = validDate(row.createdAt) ?? now;
    const trialEndsAt = validDate(row.trialEndsAt);
    const verifiedAdminEmailAt = validDate(row.verifiedAdminEmailAt);
    const realClientCount = Number(row.realClientCount) || 0;
    const realAppointmentCount = Number(row.realAppointmentCount) || 0;
    const setup = recoverySetupState(row.settings);
    const lastMeaningfulActivityAt = [
      createdAt,
      validDate(row.lastMeaningfulActivityAt),
      setup.completedAt,
      setup.helpRequestedAt,
    ].reduce<Date>(
      (latest, candidate) =>
        candidate && candidate.getTime() > latest.getTime()
          ? candidate
          : latest,
      createdAt,
    );
    const trialState = classifyRecoveryTrial(
      row.billingStatus,
      trialEndsAt,
      now,
    );
    const authoritativeStage = deriveRecoveryStage({
      activated: row.activated,
      paymentMethodCollected: row.paymentMethodCollected,
      firstPositivePayment: row.firstPositivePayment,
      setupStarted: setup.started,
      setupCompleted: setup.completed,
      realClientCount,
      realAppointmentCount,
    });
    const nextAction = deriveRecoveryNextAction({
      billingStatus: row.billingStatus,
      trialState,
      stage: authoritativeStage,
      setupStage: setup.stage,
      setupHelpRequested: setup.helpRequestedAt != null,
      hasVerifiedAdmin: Boolean(row.verifiedAdminEmail && verifiedAdminEmailAt),
      hasAnyAdmin: Number(row.activeAdminCount) > 0,
    });

    return {
      queueRank: 0,
      practiceId: row.practiceId,
      practiceName: row.practiceName,
      billingStatus: row.billingStatus,
      trialEndsAt,
      trialState,
      timezone: row.timezone,
      createdAt,
      verifiedAdminName: row.verifiedAdminName,
      verifiedAdminEmail: row.verifiedAdminEmail,
      verifiedAdminEmailAt,
      setupStage: setup.stage,
      setupHelpRequestedAt: setup.helpRequestedAt,
      realClientCount,
      realAppointmentCount,
      lastMeaningfulActivityAt,
      stallAgeDays: Math.max(
        0,
        Math.floor(
          (now.getTime() - lastMeaningfulActivityAt.getTime()) / DAY_MS,
        ),
      ),
      authoritativeStage,
      nextAction: nextAction.label,
      nextActionPriority: nextAction.priority,
    };
  });

  practices.sort(
    (a, b) =>
      b.nextActionPriority - a.nextActionPriority ||
      b.stallAgeDays - a.stallAgeDays ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      a.practiceId.localeCompare(b.practiceId),
  );
  return practices.map((practice, index) => ({
    ...practice,
    queueRank: index + 1,
  }));
}
