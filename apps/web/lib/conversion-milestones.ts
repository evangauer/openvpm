import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Database } from "@openpims/db/client";
import {
  practiceConversionMilestones,
  practices,
  stripeEvents,
} from "@openpims/db";
import { withSystem } from "@/lib/tenant-db";

export const PRACTICE_CONVERSION_MILESTONES = [
  "registered",
  "activated",
  "payment_method_collected",
  "first_positive_payment",
] as const;

export type PracticeConversionMilestone =
  (typeof PRACTICE_CONVERSION_MILESTONES)[number];

export type ConversionEvidenceSource =
  | "practice_created"
  | "product_records"
  | "stripe_webhook";

export type ConversionMilestoneInput = {
  practiceId: string;
  milestone: PracticeConversionMilestone;
  occurredAt: Date;
  evidenceSource: ConversionEvidenceSource;
  evidenceKey: string;
  amountCents?: number | null;
  currency?: string | null;
};

export interface ConversionReconciliationResult {
  registrationsRepaired: number;
  activationsRepaired: number;
  paymentMethodsRepaired: number;
  positivePaymentsRepaired: number;
}

interface ActivationEvidenceRow {
  practiceId: string;
  practiceCreatedAt: Date | string;
  clientId: string;
  clientCreatedAt: Date | string;
  appointmentId: string;
  appointmentCreatedAt: Date | string;
}

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

function validDate(value: Date | string): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function laterDate(...values: Array<Date | string>): Date | null {
  const dates = values.map(validDate);
  if (dates.some((date) => date == null)) return null;
  return new Date(Math.max(...dates.map((date) => date!.getTime())));
}

/**
 * Atomically insert a projected milestone or repair it to earlier exact source
 * evidence. `observed_at` remains the first projection time; only the repairable
 * projection changes. Source product rows and Stripe claims remain untouched.
 */
export async function upsertPracticeConversionMilestone(
  db: Database,
  input: ConversionMilestoneInput,
): Promise<boolean> {
  const rows = await db
    .insert(practiceConversionMilestones)
    .values({
      practiceId: input.practiceId,
      milestone: input.milestone,
      occurredAt: input.occurredAt,
      evidenceSource: input.evidenceSource,
      evidenceKey: input.evidenceKey,
      amountCents: input.amountCents ?? null,
      currency: input.currency ?? null,
    })
    .onConflictDoUpdate({
      target: [
        practiceConversionMilestones.practiceId,
        practiceConversionMilestones.milestone,
      ],
      set: {
        occurredAt: sql`excluded.occurred_at`,
        evidenceSource: sql`excluded.evidence_source`,
        evidenceKey: sql`excluded.evidence_key`,
        amountCents: sql`excluded.amount_cents`,
        currency: sql`excluded.currency`,
        updatedAt: new Date(),
      },
      setWhere: sql`${practiceConversionMilestones.occurredAt} > excluded.occurred_at`,
    })
    .returning({ practiceId: practiceConversionMilestones.practiceId });
  return rows.length > 0;
}

/** The committed practice row is the sole registration source of truth. */
export async function projectRegistrationMilestone(
  db: Database,
  practiceId: string,
): Promise<boolean> {
  return withSystem(db, async (tx) => {
    const [practice] = await tx
      .select({
        id: practices.id,
        createdAt: practices.createdAt,
      })
      .from(practices)
      .where(eq(practices.id, practiceId))
      .limit(1);
    if (!practice) return false;
    return upsertPracticeConversionMilestone(tx, {
      practiceId: practice.id,
      milestone: "registered",
      occurredAt: practice.createdAt,
      evidenceSource: "practice_created",
      evidenceKey: `practice:${practice.id}`,
    });
  });
}

/**
 * Project the first observed real-use activation with exact source time.
 * Historical creation still counts after a later soft-delete; sample ids saved
 * in practice settings never count.
 */
export async function projectActivationMilestone(
  db: Database,
  practiceId: string,
): Promise<boolean> {
  return withSystem(db, async (tx) => {
    const result = await tx.execute(sql`
      select
        p.id as "practiceId",
        p.created_at as "practiceCreatedAt",
        c.id as "clientId",
        c.created_at as "clientCreatedAt",
        a.id as "appointmentId",
        a.created_at as "appointmentCreatedAt"
      from practices p
      join lateral (
        select c.id, c.created_at
        from clients c
        where c.practice_id = p.id
          and not (
            coalesce(p.settings -> 'demoData' -> 'clientIds', '[]'::jsonb)
              @> to_jsonb(c.id::text)
          )
        order by c.created_at, c.id
        limit 1
      ) c on true
      join lateral (
        select a.id, a.created_at
        from appointments a
        where a.practice_id = p.id
          and not (
            coalesce(p.settings -> 'demoData' -> 'appointmentIds', '[]'::jsonb)
              @> to_jsonb(a.id::text)
          )
        order by a.created_at, a.id
        limit 1
      ) a on true
      where p.id = ${practiceId}::uuid
        and p.deleted_at is null
      limit 1
    `);
    const row = rowsFromExecute<ActivationEvidenceRow>(result)[0];
    if (!row) return false;
    const occurredAt = laterDate(
      row.practiceCreatedAt,
      row.clientCreatedAt,
      row.appointmentCreatedAt,
    );
    if (!occurredAt) return false;
    return upsertPracticeConversionMilestone(tx, {
      practiceId: row.practiceId,
      milestone: "activated",
      occurredAt,
      evidenceSource: "product_records",
      evidenceKey: `client:${row.clientId}|appointment:${row.appointmentId}`,
    });
  });
}

async function recordActivationAfterProductAction(
  db: Database,
  practiceId: string,
  source: string,
): Promise<boolean> {
  try {
    return await projectActivationMilestone(db, practiceId);
  } catch (error) {
    // A committed product action is authoritative. The local reconciliation
    // cron will retry projection without making the user repeat their work.
    console.error(`[${source}] activation milestone projection failed:`, error);
    return false;
  }
}

export function recordActivationAfterClientCreated(
  db: Database,
  practiceId: string,
  source: string,
): Promise<boolean> {
  return recordActivationAfterProductAction(db, practiceId, source);
}

export function recordActivationAfterAppointmentCreated(
  db: Database,
  practiceId: string,
  source: string,
): Promise<boolean> {
  return recordActivationAfterProductAction(db, practiceId, source);
}

/** Project one durable Stripe claim after the authoritative billing tx commits. */
export async function projectStripeConversionMilestonesForEvent(
  db: Database,
  eventId: string,
): Promise<number> {
  return withSystem(db, async (tx) => {
    const evidence = await tx
      .select({
        eventId: stripeEvents.eventId,
        practiceId: stripeEvents.practiceId,
        eventCreatedAt: stripeEvents.eventCreatedAt,
        evidenceKind: stripeEvents.evidenceKind,
        amountCents: stripeEvents.amountCents,
        currency: stripeEvents.currency,
      })
      .from(stripeEvents)
      .where(
        and(
          eq(stripeEvents.eventId, eventId),
          eq(stripeEvents.endpoint, "subscription"),
          isNotNull(stripeEvents.practiceId),
          isNotNull(stripeEvents.eventCreatedAt),
          isNotNull(stripeEvents.evidenceKind),
        ),
      );

    let projected = 0;
    for (const row of evidence) {
      if (!row.practiceId || !row.eventCreatedAt || !row.evidenceKind) continue;
      const isPositivePayment =
        row.evidenceKind === "positive_subscription_invoice_paid";
      if (
        isPositivePayment &&
        (!(row.amountCents && row.amountCents > 0) || !row.currency)
      ) {
        continue;
      }
      const changed = await upsertPracticeConversionMilestone(tx, {
        practiceId: row.practiceId,
        milestone: isPositivePayment
          ? "first_positive_payment"
          : "payment_method_collected",
        occurredAt: row.eventCreatedAt,
        evidenceSource: "stripe_webhook",
        evidenceKey: `stripe:${row.eventId}`,
        amountCents: isPositivePayment ? row.amountCents : null,
        currency: isPositivePayment ? row.currency : null,
      });
      if (changed) projected++;
    }
    return projected;
  });
}

/**
 * Rebuild every canonical milestone from local authoritative data only. No
 * Stripe/network call is permitted here; legacy payment dates stay unknown.
 */
export async function reconcileConversionMilestones(
  db: Database,
): Promise<ConversionReconciliationResult> {
  return withSystem(db, async (tx) => {
    const registrations = await tx.execute(sql`
      insert into practice_conversion_milestones (
        practice_id, milestone, occurred_at, evidence_source, evidence_key
      )
      select
        p.id,
        'registered'::practice_conversion_milestone,
        p.created_at,
        'practice_created'::conversion_evidence_source,
        'practice:' || p.id::text
      from practices p
      where p.deleted_at is null
      on conflict (practice_id, milestone) do update set
        occurred_at = excluded.occurred_at,
        evidence_source = excluded.evidence_source,
        evidence_key = excluded.evidence_key,
        amount_cents = null,
        currency = null,
        updated_at = now()
      where practice_conversion_milestones.occurred_at > excluded.occurred_at
      returning practice_id
    `);

    const activations = await tx.execute(sql`
      with activation_evidence as (
        select
          p.id as practice_id,
          greatest(p.created_at, c.created_at, a.created_at) as occurred_at,
          'client:' || c.id::text || '|appointment:' || a.id::text as evidence_key
        from practices p
        join lateral (
          select c.id, c.created_at
          from clients c
          where c.practice_id = p.id
            and not (
              coalesce(p.settings -> 'demoData' -> 'clientIds', '[]'::jsonb)
                @> to_jsonb(c.id::text)
            )
          order by c.created_at, c.id
          limit 1
        ) c on true
        join lateral (
          select a.id, a.created_at
          from appointments a
          where a.practice_id = p.id
            and not (
              coalesce(p.settings -> 'demoData' -> 'appointmentIds', '[]'::jsonb)
                @> to_jsonb(a.id::text)
            )
          order by a.created_at, a.id
          limit 1
        ) a on true
        where p.deleted_at is null
      )
      insert into practice_conversion_milestones (
        practice_id, milestone, occurred_at, evidence_source, evidence_key
      )
      select
        practice_id,
        'activated'::practice_conversion_milestone,
        occurred_at,
        'product_records'::conversion_evidence_source,
        evidence_key
      from activation_evidence
      on conflict (practice_id, milestone) do update set
        occurred_at = excluded.occurred_at,
        evidence_source = excluded.evidence_source,
        evidence_key = excluded.evidence_key,
        amount_cents = null,
        currency = null,
        updated_at = now()
      where practice_conversion_milestones.occurred_at > excluded.occurred_at
      returning practice_id
    `);

    const paymentMethods = await reconcileStripeEvidenceKind(
      tx,
      "subscription_checkout_completed",
      "payment_method_collected",
    );
    const positivePayments = await reconcileStripeEvidenceKind(
      tx,
      "positive_subscription_invoice_paid",
      "first_positive_payment",
    );

    return {
      registrationsRepaired:
        rowsFromExecute<{ practiceId: string }>(registrations).length,
      activationsRepaired:
        rowsFromExecute<{ practiceId: string }>(activations).length,
      paymentMethodsRepaired: paymentMethods,
      positivePaymentsRepaired: positivePayments,
    };
  });
}

async function reconcileStripeEvidenceKind(
  tx: Database,
  evidenceKind:
    | "subscription_checkout_completed"
    | "positive_subscription_invoice_paid",
  milestone: "payment_method_collected" | "first_positive_payment",
): Promise<number> {
  const isPositivePayment = milestone === "first_positive_payment";
  const result = await tx.execute(sql`
    with earliest_evidence as (
      select distinct on (se.practice_id)
        se.practice_id,
        se.event_id,
        se.event_created_at,
        se.amount_cents,
        se.currency
      from stripe_events se
      join practices p on p.id = se.practice_id and p.deleted_at is null
      where se.endpoint = 'subscription'
        and se.evidence_kind = ${evidenceKind}::stripe_conversion_evidence_kind
        and se.practice_id is not null
        and se.event_created_at is not null
        and (
          ${!isPositivePayment} or
          (se.amount_cents > 0 and se.currency ~ '^[a-z]{3}$')
        )
      order by se.practice_id, se.event_created_at, se.event_id
    )
    insert into practice_conversion_milestones (
      practice_id,
      milestone,
      occurred_at,
      evidence_source,
      evidence_key,
      amount_cents,
      currency
    )
    select
      practice_id,
      ${milestone}::practice_conversion_milestone,
      event_created_at,
      'stripe_webhook'::conversion_evidence_source,
      'stripe:' || event_id,
      case when ${isPositivePayment} then amount_cents else null end,
      case when ${isPositivePayment} then currency else null end
    from earliest_evidence
    on conflict (practice_id, milestone) do update set
      occurred_at = excluded.occurred_at,
      evidence_source = excluded.evidence_source,
      evidence_key = excluded.evidence_key,
      amount_cents = excluded.amount_cents,
      currency = excluded.currency,
      updated_at = now()
    where practice_conversion_milestones.occurred_at > excluded.occurred_at
    returning practice_id
  `);
  return rowsFromExecute<{ practiceId: string }>(result).length;
}
