import type { Database } from "@openpims/db/client";
import { practices, stripeEvents } from "@openpims/db";
import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, isNull, lte, or, sql } from "drizzle-orm";

export type StripeConversionEvidenceInput = {
  eventCreatedAt: Date;
  objectId: string;
  evidenceKind:
    | "subscription_checkout_completed"
    | "positive_subscription_invoice_paid";
  amountCents?: number | null;
  currency?: string | null;
};

/**
 * Claim a Stripe webhook event inside the caller's transaction.
 *
 * Returns false for a duplicate event-id/endpoint pair, allowing each Stripe
 * surface to inspect shared event types independently while still making
 * redelivery to the same endpoint idempotent.
 */
export async function claimStripeEvent(
  db: Database,
  opts: {
    eventId: string;
    endpoint: "client-invoice" | "client-invoice-connect" | "subscription";
    eventType: string;
    evidence?: StripeConversionEvidenceInput;
  },
): Promise<boolean> {
  const rows = await db
    .insert(stripeEvents)
    .values({
      eventId: opts.eventId,
      endpoint: opts.endpoint,
      eventType: opts.eventType,
      ...(opts.evidence
        ? {
            eventCreatedAt: opts.evidence.eventCreatedAt,
            objectId: opts.evidence.objectId,
            evidenceKind: opts.evidence.evidenceKind,
            amountCents: opts.evidence.amountCents ?? null,
            currency: opts.evidence.currency ?? null,
          }
        : {}),
    })
    .onConflictDoNothing()
    .returning({ eventId: stripeEvents.eventId });

  return rows.length > 0;
}

/**
 * Attach a verified Stripe claim to the active practice resolved by the
 * authoritative webhook transaction. The row is not externally visible and
 * stores no customer/contact payload.
 */
export async function attachStripeEventPractice(
  db: Database,
  opts: {
    eventId: string;
    endpoint: "subscription";
    practiceId: string;
  },
): Promise<void> {
  const rows = await db
    .update(stripeEvents)
    .set({ practiceId: opts.practiceId })
    .where(
      and(
        eq(stripeEvents.eventId, opts.eventId),
        eq(stripeEvents.endpoint, opts.endpoint),
        or(
          isNull(stripeEvents.practiceId),
          eq(stripeEvents.practiceId, opts.practiceId),
        ),
      ),
    )
    .returning({ eventId: stripeEvents.eventId });

  if (rows.length !== 1) {
    throw new Error(
      `Stripe event ${opts.eventId} is missing or already belongs to a different practice.`,
    );
  }
}

export async function authorizeStripeSubscriptionSync(
  db: Database,
  opts: {
    eventId: string;
    eventType: string;
    practiceId: string;
    subscriptionId: string;
    evidence?: StripeConversionEvidenceInput;
  },
): Promise<{ state: "authorized"; revision: number } | { state: "duplicate" }> {
  await claimStripeEvent(db, {
    eventId: opts.eventId,
    endpoint: "subscription",
    eventType: opts.eventType,
    ...(opts.evidence ? { evidence: opts.evidence } : {}),
  });
  const [event] = await db
    .select({
      practiceId: stripeEvents.practiceId,
      state: stripeEvents.subscriptionReconciliationState,
      subscriptionId: stripeEvents.subscriptionReconciliationSubscriptionId,
    })
    .from(stripeEvents)
    .where(
      and(
        eq(stripeEvents.eventId, opts.eventId),
        eq(stripeEvents.endpoint, "subscription"),
      ),
    )
    .for("update")
    .limit(1);
  if (
    !event ||
    (event.practiceId && event.practiceId !== opts.practiceId) ||
    (event.subscriptionId && event.subscriptionId !== opts.subscriptionId)
  ) {
    throw new Error("Stripe event has conflicting subscription ownership.");
  }
  if (event.state === "applied" || event.state === "superseded") {
    return { state: "duplicate" };
  }
  const [practice] = await db
    .update(practices)
    .set({
      stripeSubscriptionSyncRevision: sql`${practices.stripeSubscriptionSyncRevision} + 1`,
    })
    .where(
      and(
        eq(practices.id, opts.practiceId),
        isNull(practices.deletedAt),
        eq(practices.recoveryHold, false),
        or(
          isNull(practices.stripeQuantitySyncLeaseToken),
          lte(
            practices.stripeQuantitySyncLeaseExpiresAt,
            sql`clock_timestamp()`,
          ),
        ),
      ),
    )
    .returning({ revision: practices.stripeSubscriptionSyncRevision });
  if (!practice) throw new Error("Stripe subscription practice is inactive.");
  const [authorized] = await db
    .update(stripeEvents)
    .set({
      practiceId: opts.practiceId,
      subscriptionReconciliationState: "authorized",
      subscriptionReconciliationSubscriptionId: opts.subscriptionId,
      subscriptionReconciliationRevision: practice.revision,
      subscriptionReconciliationAttempts: sql`${stripeEvents.subscriptionReconciliationAttempts} + 1`,
      subscriptionReconciliationAuthorizedAt: sql`coalesce(${stripeEvents.subscriptionReconciliationAuthorizedAt}, clock_timestamp())`,
    })
    .where(
      and(
        eq(stripeEvents.eventId, opts.eventId),
        eq(stripeEvents.endpoint, "subscription"),
        isNull(stripeEvents.subscriptionReconciliationResolvedAt),
      ),
    )
    .returning({ eventId: stripeEvents.eventId });
  if (!authorized)
    throw new Error("Stripe subscription authorization was lost.");
  return { state: "authorized", revision: practice.revision };
}

export async function lockStripeSubscriptionReconciliationOutcome(
  db: Database,
  opts: { eventId: string; expectedRevision: number },
): Promise<boolean> {
  const [row] = await db
    .select({ eventId: stripeEvents.eventId })
    .from(stripeEvents)
    .where(
      and(
        eq(stripeEvents.eventId, opts.eventId),
        eq(stripeEvents.endpoint, "subscription"),
        eq(stripeEvents.subscriptionReconciliationState, "authorized"),
        eq(
          stripeEvents.subscriptionReconciliationRevision,
          opts.expectedRevision,
        ),
        isNull(stripeEvents.subscriptionReconciliationResolvedAt),
      ),
    )
    .for("update")
    .limit(1);
  return Boolean(row);
}

export async function resolveStripeSubscriptionReconciliation(
  db: Database,
  opts: {
    eventId: string;
    expectedRevision: number;
    outcome: "applied" | "superseded";
    queueQuantitySync: boolean;
  },
): Promise<boolean> {
  const rows = await db
    .update(stripeEvents)
    .set({
      subscriptionReconciliationState: opts.outcome,
      subscriptionReconciliationResolvedAt: sql`clock_timestamp()`,
      ...(opts.outcome === "applied" && opts.queueQuantitySync
        ? { subscriptionQuantitySyncState: "pending" }
        : {}),
    })
    .where(
      and(
        eq(stripeEvents.eventId, opts.eventId),
        eq(stripeEvents.endpoint, "subscription"),
        eq(stripeEvents.subscriptionReconciliationState, "authorized"),
        eq(
          stripeEvents.subscriptionReconciliationRevision,
          opts.expectedRevision,
        ),
        isNull(stripeEvents.subscriptionReconciliationResolvedAt),
      ),
    )
    .returning({ eventId: stripeEvents.eventId });
  return rows.length === 1;
}

export async function requestPracticeSubscriptionQuantitySync(
  db: Database,
  opts: { practiceId: string },
): Promise<boolean> {
  const [practice] = await db
    .select({
      subscriptionId: practices.stripeSubscriptionId,
      recoveryHold: practices.recoveryHold,
    })
    .from(practices)
    .where(and(eq(practices.id, opts.practiceId), isNull(practices.deletedAt)))
    .for("update")
    .limit(1);
  if (!practice?.subscriptionId || practice.recoveryHold) return false;
  const rows = await db
    .update(practices)
    .set({
      stripeQuantitySyncRequestedRevision: sql`${practices.stripeQuantitySyncRequestedRevision} + 1`,
    })
    .where(
      and(
        eq(practices.id, opts.practiceId),
        eq(practices.stripeSubscriptionId, practice.subscriptionId),
        eq(practices.recoveryHold, false),
      ),
    )
    .returning({ id: practices.id });
  return rows.length === 1;
}

type PracticeQuantityJob = {
  practiceId: string;
  subscriptionId: string;
  requestedRevision: number;
  leaseToken: string;
  leaseExpiresAt: Date;
};

export async function claimPracticeSubscriptionQuantitySync(
  db: Database,
  opts: { practiceId: string; now: Date },
): Promise<
  | { state: "claimed"; job: PracticeQuantityJob }
  | { state: "busy" }
  | { state: "none" }
> {
  const [practice] = await db
    .select({
      subscriptionId: practices.stripeSubscriptionId,
      recoveryHold: practices.recoveryHold,
      requestedRevision: practices.stripeQuantitySyncRequestedRevision,
      completedRevision: practices.stripeQuantitySyncCompletedRevision,
      leaseToken: practices.stripeQuantitySyncLeaseToken,
      leaseExpiresAt: practices.stripeQuantitySyncLeaseExpiresAt,
    })
    .from(practices)
    .where(and(eq(practices.id, opts.practiceId), isNull(practices.deletedAt)))
    .for("update")
    .limit(1);
  if (
    !practice?.subscriptionId ||
    practice.requestedRevision <= practice.completedRevision
  ) {
    return { state: "none" };
  }
  if (
    practice.recoveryHold ||
    (practice.leaseToken &&
      practice.leaseExpiresAt &&
      practice.leaseExpiresAt > opts.now)
  ) {
    return { state: "busy" };
  }
  const leaseToken = randomUUID();
  const leaseExpiresAt = new Date(opts.now.getTime() + 5 * 60 * 1000);
  const rows = await db
    .update(practices)
    .set({
      stripeQuantitySyncLeaseToken: leaseToken,
      stripeQuantitySyncLeaseExpiresAt: leaseExpiresAt,
    })
    .where(
      and(
        eq(practices.id, opts.practiceId),
        eq(practices.stripeSubscriptionId, practice.subscriptionId),
        eq(practices.recoveryHold, false),
        or(
          isNull(practices.stripeQuantitySyncLeaseToken),
          lte(practices.stripeQuantitySyncLeaseExpiresAt, opts.now),
        ),
      ),
    )
    .returning({ id: practices.id });
  return rows.length === 1
    ? {
        state: "claimed",
        job: {
          practiceId: opts.practiceId,
          subscriptionId: practice.subscriptionId,
          requestedRevision: practice.requestedRevision,
          leaseToken,
          leaseExpiresAt,
        },
      }
    : { state: "busy" };
}

export async function resolvePracticeSubscriptionQuantitySync(
  db: Database,
  opts: {
    practiceId: string;
    leaseToken: string;
    requestedRevision: number;
    outcome: "completed" | "retry";
  },
): Promise<boolean> {
  const rows = await db
    .update(practices)
    .set({
      ...(opts.outcome === "completed"
        ? {
            stripeQuantitySyncCompletedRevision: sql`greatest(${practices.stripeQuantitySyncCompletedRevision}, ${opts.requestedRevision})`,
          }
        : {}),
      stripeQuantitySyncLeaseToken: null,
      stripeQuantitySyncLeaseExpiresAt: null,
    })
    .where(
      and(
        eq(practices.id, opts.practiceId),
        eq(practices.stripeQuantitySyncLeaseToken, opts.leaseToken),
      ),
    )
    .returning({ id: practices.id });
  return rows.length === 1;
}

export async function listRetryablePracticeSubscriptionQuantitySyncs(
  db: Database,
  opts: { now: Date; limit: number },
): Promise<string[]> {
  const rows = await db
    .select({ practiceId: practices.id })
    .from(practices)
    .where(
      and(
        isNull(practices.deletedAt),
        eq(practices.recoveryHold, false),
        isNotNull(practices.stripeSubscriptionId),
        sql`${practices.stripeQuantitySyncRequestedRevision} > ${practices.stripeQuantitySyncCompletedRevision}`,
        or(
          isNull(practices.stripeQuantitySyncLeaseToken),
          lte(practices.stripeQuantitySyncLeaseExpiresAt, opts.now),
        ),
      ),
    )
    .orderBy(practices.updatedAt, practices.id)
    .limit(Math.max(1, Math.min(opts.limit, 100)));
  return rows.map((row) => row.practiceId);
}

type EventQuantityJob = {
  eventId: string;
  practiceId: string;
  subscriptionId: string;
  leaseToken: string;
  leaseExpiresAt: Date;
};

export async function claimStripeSubscriptionQuantitySync(
  db: Database,
  opts: { eventId: string; now: Date },
): Promise<
  | { state: "claimed"; job: EventQuantityJob }
  | { state: "busy" }
  | { state: "none" }
> {
  const [event] = await db
    .select({
      practiceId: stripeEvents.practiceId,
      subscriptionId: stripeEvents.subscriptionReconciliationSubscriptionId,
      state: stripeEvents.subscriptionQuantitySyncState,
      leaseToken: stripeEvents.subscriptionQuantitySyncLeaseToken,
      leaseExpiresAt: stripeEvents.subscriptionQuantitySyncLeaseExpiresAt,
    })
    .from(stripeEvents)
    .where(
      and(
        eq(stripeEvents.eventId, opts.eventId),
        eq(stripeEvents.endpoint, "subscription"),
      ),
    )
    .for("update")
    .limit(1);
  if (!event?.practiceId || !event.subscriptionId) return { state: "none" };
  if (
    event.state === "running" &&
    event.leaseExpiresAt &&
    event.leaseExpiresAt > opts.now
  ) {
    return { state: "busy" };
  }
  if (
    event.state !== "pending" &&
    !(
      event.state === "running" &&
      event.leaseExpiresAt &&
      event.leaseExpiresAt <= opts.now
    )
  ) {
    return { state: "none" };
  }
  const leaseToken = randomUUID();
  const leaseExpiresAt = new Date(opts.now.getTime() + 5 * 60 * 1000);
  const [practice] = await db
    .select({
      subscriptionId: practices.stripeSubscriptionId,
      recoveryHold: practices.recoveryHold,
      leaseToken: practices.stripeQuantitySyncLeaseToken,
      leaseExpiresAt: practices.stripeQuantitySyncLeaseExpiresAt,
    })
    .from(practices)
    .where(and(eq(practices.id, event.practiceId), isNull(practices.deletedAt)))
    .for("update")
    .limit(1);
  if (!practice || practice.subscriptionId !== event.subscriptionId) {
    await db
      .update(stripeEvents)
      .set({
        subscriptionQuantitySyncState: "completed",
        subscriptionQuantitySyncAttempts: sql`${stripeEvents.subscriptionQuantitySyncAttempts} + 1`,
        subscriptionQuantitySyncLastAttemptAt: opts.now,
        subscriptionQuantitySyncCompletedAt: opts.now,
        subscriptionQuantitySyncLeaseToken: null,
        subscriptionQuantitySyncLeaseExpiresAt: null,
      })
      .where(
        and(
          eq(stripeEvents.eventId, opts.eventId),
          eq(stripeEvents.endpoint, "subscription"),
        ),
      );
    if (event.leaseToken) {
      await db
        .update(practices)
        .set({
          stripeQuantitySyncLeaseToken: null,
          stripeQuantitySyncLeaseExpiresAt: null,
        })
        .where(
          and(
            eq(practices.id, event.practiceId),
            eq(practices.stripeQuantitySyncLeaseToken, event.leaseToken),
          ),
        );
    }
    return { state: "none" };
  }
  if (
    practice.recoveryHold ||
    (practice.leaseToken &&
      practice.leaseExpiresAt &&
      practice.leaseExpiresAt > opts.now)
  ) {
    return { state: "busy" };
  }
  const practiceLease = await db
    .update(practices)
    .set({
      stripeQuantitySyncLeaseToken: leaseToken,
      stripeQuantitySyncLeaseExpiresAt: leaseExpiresAt,
    })
    .where(
      and(
        eq(practices.id, event.practiceId),
        eq(practices.stripeSubscriptionId, event.subscriptionId),
        eq(practices.recoveryHold, false),
        or(
          isNull(practices.stripeQuantitySyncLeaseToken),
          lte(practices.stripeQuantitySyncLeaseExpiresAt, opts.now),
        ),
      ),
    )
    .returning({ id: practices.id });
  if (practiceLease.length !== 1) return { state: "busy" };
  const rows = await db
    .update(stripeEvents)
    .set({
      subscriptionQuantitySyncState: "running",
      subscriptionQuantitySyncAttempts: sql`${stripeEvents.subscriptionQuantitySyncAttempts} + 1`,
      subscriptionQuantitySyncLeaseToken: leaseToken,
      subscriptionQuantitySyncLeaseExpiresAt: leaseExpiresAt,
      subscriptionQuantitySyncLastAttemptAt: opts.now,
    })
    .where(
      and(
        eq(stripeEvents.eventId, opts.eventId),
        eq(stripeEvents.endpoint, "subscription"),
        or(
          eq(stripeEvents.subscriptionQuantitySyncState, "pending"),
          and(
            eq(stripeEvents.subscriptionQuantitySyncState, "running"),
            lte(stripeEvents.subscriptionQuantitySyncLeaseExpiresAt, opts.now),
          ),
        ),
      ),
    )
    .returning({ eventId: stripeEvents.eventId });
  if (rows.length !== 1) {
    await db
      .update(practices)
      .set({
        stripeQuantitySyncLeaseToken: null,
        stripeQuantitySyncLeaseExpiresAt: null,
      })
      .where(
        and(
          eq(practices.id, event.practiceId),
          eq(practices.stripeQuantitySyncLeaseToken, leaseToken),
        ),
      );
    return { state: "busy" };
  }
  return {
    state: "claimed",
    job: {
      eventId: opts.eventId,
      practiceId: event.practiceId,
      subscriptionId: event.subscriptionId,
      leaseToken,
      leaseExpiresAt,
    },
  };
}

export async function resolveStripeSubscriptionQuantitySync(
  db: Database,
  opts: { eventId: string; leaseToken: string; outcome: "completed" | "retry" },
): Promise<boolean> {
  const [event] = await db
    .select({ practiceId: stripeEvents.practiceId })
    .from(stripeEvents)
    .where(
      and(
        eq(stripeEvents.eventId, opts.eventId),
        eq(stripeEvents.endpoint, "subscription"),
        eq(stripeEvents.subscriptionQuantitySyncLeaseToken, opts.leaseToken),
      ),
    )
    .for("update")
    .limit(1);
  if (!event?.practiceId) return false;
  const rows = await db
    .update(stripeEvents)
    .set(
      opts.outcome === "completed"
        ? {
            subscriptionQuantitySyncState: "completed",
            subscriptionQuantitySyncLeaseToken: null,
            subscriptionQuantitySyncLeaseExpiresAt: null,
            subscriptionQuantitySyncCompletedAt: sql`clock_timestamp()`,
          }
        : {
            subscriptionQuantitySyncState: "pending",
            subscriptionQuantitySyncLeaseToken: null,
            subscriptionQuantitySyncLeaseExpiresAt: null,
          },
    )
    .where(
      and(
        eq(stripeEvents.eventId, opts.eventId),
        eq(stripeEvents.endpoint, "subscription"),
        eq(stripeEvents.subscriptionQuantitySyncState, "running"),
        eq(stripeEvents.subscriptionQuantitySyncLeaseToken, opts.leaseToken),
      ),
    )
    .returning({ eventId: stripeEvents.eventId });
  if (rows.length === 1) {
    await db
      .update(practices)
      .set({
        stripeQuantitySyncLeaseToken: null,
        stripeQuantitySyncLeaseExpiresAt: null,
      })
      .where(
        and(
          eq(practices.id, event.practiceId),
          eq(practices.stripeQuantitySyncLeaseToken, opts.leaseToken),
        ),
      );
  }
  return rows.length === 1;
}

export async function listRetryableStripeSubscriptionQuantitySyncs(
  db: Database,
  opts: { now: Date; limit: number },
): Promise<string[]> {
  const rows = await db
    .select({ eventId: stripeEvents.eventId })
    .from(stripeEvents)
    .where(
      and(
        eq(stripeEvents.endpoint, "subscription"),
        or(
          eq(stripeEvents.subscriptionQuantitySyncState, "pending"),
          and(
            eq(stripeEvents.subscriptionQuantitySyncState, "running"),
            lte(stripeEvents.subscriptionQuantitySyncLeaseExpiresAt, opts.now),
          ),
        ),
      ),
    )
    .orderBy(
      stripeEvents.subscriptionQuantitySyncLeaseExpiresAt,
      stripeEvents.eventId,
    )
    .limit(Math.max(1, Math.min(opts.limit, 100)));
  return rows.map((row) => row.eventId);
}
