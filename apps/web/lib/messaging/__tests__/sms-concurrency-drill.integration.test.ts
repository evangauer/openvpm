import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  auditLog,
  communications,
  locationMessaging,
  locations,
  practices,
  smsDeliveryEventHistory,
  smsDeliveryEvents,
  smsProviderEventConflicts,
  smsProviderEvents,
  smsSendAttemptEvents,
  smsSendAttempts,
} from "@openpims/db";
import { db, type Database } from "@openpims/db/client";
import { rowsFromExecute } from "@/lib/db/execute-rows";
import { lockPracticeForExternalSideEffects } from "@/lib/recovery-hold";
import { withSystem } from "@/lib/tenant-db";
import {
  hasBlockingSmsProviderEventForDispatchInTransaction,
  loadSmsProviderEventGateSummaryInTransaction,
} from "../sms-provider-event-operations";
import {
  ingestSmsProviderEvent,
  projectSmsProviderEvent,
  projectSmsProviderEventForLockedPracticeInTransaction,
  projectSmsProviderEventInTransaction,
} from "../sms-provider-events";
import { acquireSmsRecipientLockInTransaction } from "../suppression";

const describeWithPostgres = process.env.SMS_CONCURRENCY_DB_INTEGRATION
  ? describe.sequential
  : describe.skip;

const SMS_FLAGS = [
  "MESSAGING_PROVISIONING_ENABLED",
  "MESSAGING_INBOUND_ENABLED",
  "MESSAGING_SENDING_ENABLED",
] as const;

type Fixture = {
  prefix: string;
  practiceId: string;
  locationId: string;
  senderE164: string;
  recipientE164: string;
  messagingProfileId: string;
};

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function within<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = 8_000,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} exceeded ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function syntheticE164(): string {
  const suffix = String(Math.floor(Math.random() * 10_000_000)).padStart(
    7,
    "0",
  );
  return `+1555${suffix}`;
}

async function setDrillTimeouts(tx: Database): Promise<void> {
  await tx.execute(sql`set local statement_timeout = '7s'`);
  await tx.execute(sql`set local lock_timeout = '6s'`);
}

async function backendPid(tx: Database): Promise<number> {
  const result = await tx.execute(sql`select pg_backend_pid()::int as pid`);
  const pid = rowsFromExecute<{ pid: number }>(result)[0]?.pid;
  if (!pid) throw new Error("Concurrency drill could not read backend PID");
  return Number(pid);
}

async function waitForBackendBlock(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await db.execute(sql`
      select cardinality(pg_blocking_pids(${pid}))::int as blockers
    `);
    const blockers = Number(
      rowsFromExecute<{ blockers: number }>(result)[0]?.blockers ?? 0,
    );
    if (blockers > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Backend ${pid} never reached an observable lock wait`);
}

async function advisoryWaiterCount(lockKey: string): Promise<number> {
  const result = await db.execute(sql`
    with hashed as (
      select hashtextextended(${lockKey}, 0)::bigint as value
    )
    select count(*)::int as count
    from pg_locks lock
    cross join hashed
    where lock.locktype = 'advisory'
      and lock.objsubid = 1
      and lock.classid::bigint = ((hashed.value >> 32) & 4294967295)
      and lock.objid::bigint = (hashed.value & 4294967295)
      and not lock.granted
  `);
  return Number(rowsFromExecute<{ count: number }>(result)[0]?.count ?? 0);
}

async function waitForAdvisoryWaiters(
  lockKey: string,
  expected: number,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await advisoryWaiterCount(lockKey)) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Advisory lock ${lockKey} never reached ${expected} waiter(s)`,
  );
}

async function createFixture(
  options: {
    recoveryHold?: boolean;
  } = {},
): Promise<Fixture> {
  const prefix = `sms-drill-${randomUUID()}`;
  const practiceId = randomUUID();
  const locationId = randomUUID();
  const senderE164 = syntheticE164();
  let recipientE164 = syntheticE164();
  while (recipientE164 === senderE164) recipientE164 = syntheticE164();
  const messagingProfileId = `${prefix}-profile`;
  const recoveryHold = options.recoveryHold === true;

  await withSystem(db, async (tx) => {
    await tx.insert(practices).values({
      id: practiceId,
      name: `Synthetic SMS drill ${prefix}`,
      recoveryHold,
      recoveryHoldReason: recoveryHold ? "Synthetic concurrency drill" : null,
      recoveryHoldSetAt: recoveryHold ? new Date() : null,
    });
    await tx.insert(locations).values({
      id: locationId,
      practiceId,
      name: "Synthetic drill location",
      isPrimary: true,
    });
    await tx.insert(locationMessaging).values({
      practiceId,
      locationId,
      provider: "telnyx",
      senderE164,
      messagingProfileId,
      registrationStatus: "not_started",
      providerProfileReady: false,
      enabled: false,
    });
  });

  return {
    prefix,
    practiceId,
    locationId,
    senderE164,
    recipientE164,
    messagingProfileId,
  };
}

function assertLocalDrillDatabase(): void {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl)
    throw new Error("DATABASE_URL is required for the SMS drill");
  const hostname = new URL(databaseUrl).hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) {
    throw new Error(
      "The SMS concurrency drill is restricted to disposable local PostgreSQL",
    );
  }
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  const providerEventPattern = `${fixture.prefix}%`;
  await withSystem(db, async (tx) => {
    const resolutionResult = await tx.execute(sql`
      select count(*)::int as count
      from sms_provider_event_resolutions resolution
      join sms_provider_events event on event.id = resolution.event_id
      where event.practice_id = ${fixture.practiceId}::uuid
        or event.provider_event_id like ${providerEventPattern}
    `);
    const resolutionCount = Number(
      rowsFromExecute<{ count: number }>(resolutionResult)[0]?.count ?? 0,
    );
    if (resolutionCount > 0) {
      throw new Error(
        "Concurrency drill unexpectedly created immutable remediation evidence",
      );
    }
    // Provider-event rows are immutable in normal operation. The drill only
    // runs as the owner of a disposable local database, so use the schema's
    // explicit disaster-recovery bypass for synthetic fixture cleanup.
    await tx.execute(
      sql`select set_config('app.ledger_maintenance', 'on', true)`,
    );
    await tx.execute(sql`
      delete from sms_provider_event_conflict_reviews review
      using sms_provider_event_conflicts conflict, sms_provider_events event
      where review.conflict_id = conflict.id
        and conflict.original_event_id = event.id
        and (event.practice_id = ${fixture.practiceId}::uuid
          or event.provider_event_id like ${providerEventPattern})
    `);
    await tx.execute(sql`
      delete from sms_provider_event_conflicts conflict
      using sms_provider_events event
      where conflict.original_event_id = event.id
        and (event.practice_id = ${fixture.practiceId}::uuid
          or event.provider_event_id like ${providerEventPattern})
    `);
    await tx.execute(sql`
      delete from sms_provider_events
      where practice_id = ${fixture.practiceId}::uuid
        or provider_event_id like ${providerEventPattern}
    `);
    await tx.execute(sql`
      delete from sms_delivery_event_history history
      using sms_delivery_events event
      where history.delivery_event_id = event.id
        and (history.practice_id = ${fixture.practiceId}::uuid
          or event.provider_event_id like ${providerEventPattern})
    `);
    await tx.execute(sql`
      delete from sms_delivery_events
      where provider_event_id like ${providerEventPattern}
    `);
    await tx.execute(sql`
      delete from sms_send_attempt_events
      where practice_id = ${fixture.practiceId}::uuid
    `);
    await tx.execute(sql`
      delete from sms_send_attempts
      where practice_id = ${fixture.practiceId}::uuid
    `);
    await tx.execute(sql`
      delete from sms_consent_events
      where practice_id = ${fixture.practiceId}::uuid
    `);
    await tx.execute(sql`
      delete from sms_suppressions
      where practice_id = ${fixture.practiceId}::uuid
    `);
    await tx.execute(sql`
      delete from communications
      where practice_id = ${fixture.practiceId}::uuid
    `);
    await tx.execute(sql`
      delete from audit_log
      where practice_id = ${fixture.practiceId}::uuid
    `);
    await tx.execute(sql`
      delete from location_messaging
      where practice_id = ${fixture.practiceId}::uuid
    `);
    await tx.execute(sql`
      delete from users
      where practice_id = ${fixture.practiceId}::uuid
    `);
    await tx.execute(sql`
      delete from locations
      where practice_id = ${fixture.practiceId}::uuid
    `);
    await tx.execute(sql`
      delete from practices where id = ${fixture.practiceId}::uuid
    `);
  });
}

async function createAcceptedSend(
  fixture: Fixture,
  suffix: string,
): Promise<{
  communicationId: string;
  attemptId: string;
  providerMessageId: string;
}> {
  const communicationId = randomUUID();
  const attemptId = randomUUID();
  const providerMessageId = `${fixture.prefix}-${suffix}-message`;
  const body = `Synthetic provider-free concurrency drill ${suffix}`;

  await withSystem(db, async (tx) => {
    await tx.insert(communications).values({
      id: communicationId,
      practiceId: fixture.practiceId,
      channel: "sms",
      direction: "outbound",
      content: body,
      status: "sent",
      providerMessageId,
    });
    await tx.insert(smsSendAttempts).values({
      id: attemptId,
      practiceId: fixture.practiceId,
      locationId: fixture.locationId,
      communicationId,
      source: "sms_concurrency_drill",
      sourceId: `${fixture.prefix}-${suffix}`,
      idempotencyKey: `${fixture.prefix}-${suffix}`,
      destinationE164: fixture.recipientE164,
      registeredDisplayName: "Synthetic Drill Clinic",
      body,
      bodySha256: createHash("sha256").update(body).digest("hex"),
      provider: "telnyx",
      senderMessagingServiceId: fixture.messagingProfileId,
      senderE164: fixture.senderE164,
    });
    await tx.insert(smsSendAttemptEvents).values({
      practiceId: fixture.practiceId,
      attemptId,
      kind: "provider_result",
      outcome: "accepted",
      providerMessageId,
      eventKey: `${fixture.prefix}-${suffix}-accepted`,
    });
  });

  return { communicationId, attemptId, providerMessageId };
}

function deliveryProviderEventValues(
  fixture: Fixture,
  suffix: string,
  providerMessageId: string,
) {
  const providerEventId = `${fixture.prefix}-${suffix}-dlr`;
  const rawBody = `synthetic:${providerEventId}`;
  return {
    id: randomUUID(),
    provider: "telnyx" as const,
    kind: "delivery" as const,
    providerEventId,
    providerMessageId,
    providerEventType: "message.delivered",
    eventKey: `id:${providerEventId}`,
    rawBodyFingerprintSha256: createHash("sha256")
      .update(rawBody)
      .digest("hex"),
    occurredAt: new Date(),
    deliveryClassification: "delivered" as const,
    providerStatus: "delivered",
    practiceId: fixture.practiceId,
    locationId: fixture.locationId,
    state: "pending" as const,
  };
}

const originalHostedBilling = process.env.HOSTED_BILLING_ENABLED;

describeWithPostgres("provider-free SMS concurrency drill", () => {
  beforeAll(() => {
    assertLocalDrillDatabase();
    for (const flag of SMS_FLAGS) {
      const value = process.env[flag]?.trim().toLowerCase();
      if (value && !["0", "false", "no", "off"].includes(value)) {
        throw new Error(`${flag} must remain disabled for the SMS drill`);
      }
      process.env[flag] = "false";
    }
    // Preserve hosted fail-closed inbound behavior without enabling an SMS flag.
    process.env.HOSTED_BILLING_ENABLED = "true";
  });

  afterAll(() => {
    if (originalHostedBilling === undefined) {
      delete process.env.HOSTED_BILLING_ENABLED;
    } else {
      process.env.HOSTED_BILLING_ENABLED = originalHostedBilling;
    }
  });

  it("serializes STOP intake ahead of the outbound final barrier", async () => {
    const fixture = await createFixture();
    const intakeLocked = deferred();
    const releaseIntake = deferred();
    const outboundPid = deferred<number>();
    let providerCallCount = 0;
    let outbound: Promise<boolean> | undefined;

    const intake = withSystem(db, async (tx) => {
      await setDrillTimeouts(tx);
      expect(
        await lockPracticeForExternalSideEffects(tx, fixture.practiceId),
      ).toBe(true);
      await acquireSmsRecipientLockInTransaction(
        tx,
        fixture.practiceId,
        fixture.recipientE164,
      );
      intakeLocked.resolve();
      await releaseIntake.promise;
      const providerEventId = `${fixture.prefix}-stop`;
      await tx.insert(smsProviderEvents).values({
        provider: "telnyx",
        kind: "inbound",
        providerEventId,
        providerMessageId: `${fixture.prefix}-stop-message`,
        providerEventType: "message.received",
        eventKey: `id:${providerEventId}`,
        rawBodyFingerprintSha256: createHash("sha256")
          .update(`synthetic:${providerEventId}`)
          .digest("hex"),
        occurredAt: new Date(),
        fromE164: fixture.recipientE164,
        toE164: fixture.senderE164,
        messagingProfileId: fixture.messagingProfileId,
        messageBody: "STOP",
        inboundClassification: "stop",
        practiceId: fixture.practiceId,
        locationId: fixture.locationId,
        state: "pending",
      });
    });

    try {
      await intakeLocked.promise;
      outbound = withSystem(db, async (tx) => {
        await setDrillTimeouts(tx);
        expect(
          await lockPracticeForExternalSideEffects(tx, fixture.practiceId),
        ).toBe(true);
        outboundPid.resolve(await backendPid(tx));
        await acquireSmsRecipientLockInTransaction(
          tx,
          fixture.practiceId,
          fixture.recipientE164,
        );
        const blocked =
          await hasBlockingSmsProviderEventForDispatchInTransaction(
            tx,
            fixture.practiceId,
            fixture.recipientE164,
          );
        if (!blocked) providerCallCount += 1;
        return blocked;
      });

      await waitForBackendBlock(await outboundPid.promise);
      releaseIntake.resolve();
      const [blocked] = await within(
        Promise.all([outbound, intake]),
        "STOP/outbound serialization",
      );
      expect(blocked).toBe(true);
      expect(providerCallCount).toBe(0);
    } finally {
      releaseIntake.resolve();
      await Promise.allSettled([intake, ...(outbound ? [outbound] : [])]);
      await cleanupFixture(fixture);
    }
  });

  it("serializes conflict replay and projection in practice-sender-recipient-event order", async () => {
    const fixture = await createFixture();
    const providerEventId = `${fixture.prefix}-identity`;
    const original = await ingestSmsProviderEvent({
      provider: "telnyx",
      kind: "inbound",
      providerEventId,
      providerMessageId: `${fixture.prefix}-inbound-message`,
      providerEventType: "message.received",
      rawBody: `synthetic:${providerEventId}:start`,
      occurredAt: new Date(),
      fromE164: fixture.recipientE164,
      toE164: fixture.senderE164,
      messagingProfileId: fixture.messagingProfileId,
      messageBody: "START",
      inboundClassification: "start",
    });
    const holderReady = deferred();
    const releaseHolder = deferred();
    const holder = withSystem(db, async (tx) => {
      await setDrillTimeouts(tx);
      await acquireSmsRecipientLockInTransaction(
        tx,
        fixture.practiceId,
        fixture.recipientE164,
      );
      holderReady.resolve();
      await releaseHolder.promise;
    });
    let conflictingReplay:
      | ReturnType<typeof ingestSmsProviderEvent>
      | undefined;
    let projection:
      | Promise<
          Awaited<ReturnType<typeof projectSmsProviderEventInTransaction>>
        >
      | undefined;

    try {
      await holderReady.promise;
      const lockKey = `sms:${fixture.practiceId}:${fixture.recipientE164}`;
      conflictingReplay = ingestSmsProviderEvent({
        provider: "telnyx",
        kind: "inbound",
        providerEventId,
        providerMessageId: `${fixture.prefix}-inbound-message`,
        providerEventType: "message.received",
        rawBody: `synthetic:${providerEventId}:conflicting-stop`,
        occurredAt: new Date(),
        fromE164: fixture.recipientE164,
        toE164: fixture.senderE164,
        messagingProfileId: fixture.messagingProfileId,
        messageBody: "STOP",
        inboundClassification: "stop",
      });
      await waitForAdvisoryWaiters(lockKey, 1);

      const projectionPid = deferred<number>();
      projection = withSystem(db, async (tx) => {
        await setDrillTimeouts(tx);
        projectionPid.resolve(await backendPid(tx));
        return projectSmsProviderEventInTransaction(tx, original.eventId);
      });
      await waitForBackendBlock(await projectionPid.promise);
      await waitForAdvisoryWaiters(lockKey, 2);
      releaseHolder.resolve();

      const [conflict, projectionResult] = await within(
        Promise.all([conflictingReplay, projection]),
        "conflict/projection lock order",
      );
      expect(conflict).toMatchObject({
        eventId: original.eventId,
        conflict: true,
        duplicate: false,
      });
      expect(["quarantined", "already_terminal"]).toContain(
        projectionResult.outcome,
      );

      const [event] = await db
        .select({ state: smsProviderEvents.state })
        .from(smsProviderEvents)
        .where(eq(smsProviderEvents.id, original.eventId))
        .limit(1);
      const conflicts = await db
        .select({ id: smsProviderEventConflicts.id })
        .from(smsProviderEventConflicts)
        .where(eq(smsProviderEventConflicts.originalEventId, original.eventId));
      expect(event?.state).toBe("quarantined");
      expect(conflicts).toHaveLength(1);
    } finally {
      releaseHolder.resolve();
      await Promise.allSettled([
        holder,
        ...(conflictingReplay ? [conflictingReplay] : []),
        ...(projection ? [projection] : []),
      ]);
      await cleanupFixture(fixture);
    }
  });

  it("converges a callback-first DLR after accepted-send evidence arrives", async () => {
    const fixture = await createFixture();
    const providerEventId = `${fixture.prefix}-callback-first-dlr`;
    const providerMessageId = `${fixture.prefix}-callback-first-message`;
    try {
      const ingested = await ingestSmsProviderEvent({
        provider: "telnyx",
        kind: "delivery",
        providerEventId,
        providerMessageId,
        providerEventType: "message.delivered",
        rawBody: `synthetic:${providerEventId}:before-attempt`,
        occurredAt: new Date(),
        deliveryClassification: "delivered",
        providerStatus: "delivered",
      });
      await expect(projectSmsProviderEvent(ingested.eventId)).resolves.toEqual({
        outcome: "retry",
      });

      const communicationId = randomUUID();
      const attemptId = randomUUID();
      const body = "Synthetic callback-first DLR drill";
      await withSystem(db, async (tx) => {
        await tx.insert(communications).values({
          id: communicationId,
          practiceId: fixture.practiceId,
          channel: "sms",
          direction: "outbound",
          content: body,
          status: "sent",
          providerMessageId,
        });
        await tx.insert(smsSendAttempts).values({
          id: attemptId,
          practiceId: fixture.practiceId,
          locationId: fixture.locationId,
          communicationId,
          source: "sms_concurrency_drill",
          sourceId: `${fixture.prefix}-callback-first`,
          idempotencyKey: `${fixture.prefix}-callback-first`,
          destinationE164: fixture.recipientE164,
          registeredDisplayName: "Synthetic Drill Clinic",
          body,
          bodySha256: createHash("sha256").update(body).digest("hex"),
          provider: "telnyx",
          senderMessagingServiceId: fixture.messagingProfileId,
          senderE164: fixture.senderE164,
        });
        await tx.insert(smsSendAttemptEvents).values({
          practiceId: fixture.practiceId,
          attemptId,
          kind: "provider_result",
          outcome: "accepted",
          providerMessageId,
          eventKey: `${fixture.prefix}-callback-first-accepted`,
        });
        // Make the retry immediately due without violating the invariant that
        // next_attempt_at remains later than its committed last_attempt_at.
        await tx
          .update(smsProviderEvents)
          .set({ nextAttemptAt: sql`clock_timestamp()` })
          .where(eq(smsProviderEvents.id, ingested.eventId));
      });

      await expect(projectSmsProviderEvent(ingested.eventId)).resolves.toEqual({
        outcome: "projected",
      });
      const [event] = await db
        .select({
          state: smsProviderEvents.state,
          practiceId: smsProviderEvents.practiceId,
        })
        .from(smsProviderEvents)
        .where(eq(smsProviderEvents.id, ingested.eventId))
        .limit(1);
      const [communication] = await db
        .select({ status: communications.status })
        .from(communications)
        .where(eq(communications.id, communicationId))
        .limit(1);
      const [deliveryEvent] = await db
        .select({ id: smsDeliveryEvents.id })
        .from(smsDeliveryEvents)
        .where(eq(smsDeliveryEvents.providerEventId, providerEventId))
        .limit(1);
      const history = await db
        .select({ result: smsDeliveryEventHistory.result })
        .from(smsDeliveryEventHistory)
        .where(eq(smsDeliveryEventHistory.deliveryEventId, deliveryEvent!.id));
      expect(event).toEqual({
        state: "projected",
        practiceId: fixture.practiceId,
      });
      expect(communication?.status).toBe("delivered");
      expect(history.map((row) => row.result)).toEqual(
        expect.arrayContaining(["unmatched", "attributed", "projected"]),
      );
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("preserves prior recovery drain progress across a failed savepoint and releases only after zero backlog", async () => {
    const fixture = await createFixture({ recoveryHold: true });
    const firstSend = await createAcceptedSend(fixture, "recovery-first");
    const secondSend = await createAcceptedSend(fixture, "recovery-second");
    const firstEvent = deliveryProviderEventValues(
      fixture,
      "recovery-first",
      firstSend.providerMessageId,
    );
    const secondEvent = deliveryProviderEventValues(
      fixture,
      "recovery-second",
      secondSend.providerMessageId,
    );
    await withSystem(db, (tx) =>
      tx.insert(smsProviderEvents).values([firstEvent, secondEvent]),
    );

    try {
      let projectionErrors = 0;
      await withSystem(db, async (tx) => {
        await setDrillTimeouts(tx);
        const [practice] = await tx
          .select({ recoveryHold: practices.recoveryHold })
          .from(practices)
          .where(eq(practices.id, fixture.practiceId))
          .for("update")
          .limit(1);
        expect(practice?.recoveryHold).toBe(true);

        await tx.transaction((eventTx) =>
          projectSmsProviderEventForLockedPracticeInTransaction(
            eventTx as unknown as Database,
            {
              practiceId: fixture.practiceId,
              eventId: firstEvent.id,
              force: true,
            },
          ),
        );
        try {
          await tx.transaction(async (eventTx) => {
            await eventTx.execute(sql`select 1 / 0`);
            return projectSmsProviderEventForLockedPracticeInTransaction(
              eventTx as unknown as Database,
              {
                practiceId: fixture.practiceId,
                eventId: secondEvent.id,
                force: true,
              },
            );
          });
        } catch {
          projectionErrors += 1;
        }

        const remaining = await loadSmsProviderEventGateSummaryInTransaction(
          tx,
          {
            practiceId: fixture.practiceId,
          },
        );
        expect(remaining.total).toBe(1);
        await tx.insert(auditLog).values({
          practiceId: fixture.practiceId,
          userId: null,
          action: "hold_release_blocked",
          entityType: "practice_recovery",
          entityId: fixture.practiceId,
          changes: {
            source: "sms_concurrency_drill",
            state: "held",
            projectionErrors,
            remaining: remaining.total,
          },
        });
      });
      expect(projectionErrors).toBe(1);

      const firstCheckpoint = await db
        .select({ id: smsProviderEvents.id, state: smsProviderEvents.state })
        .from(smsProviderEvents)
        .where(inArray(smsProviderEvents.id, [firstEvent.id, secondEvent.id]));
      const [heldPractice] = await db
        .select({ recoveryHold: practices.recoveryHold })
        .from(practices)
        .where(eq(practices.id, fixture.practiceId))
        .limit(1);
      expect(firstCheckpoint).toEqual(
        expect.arrayContaining([
          { id: firstEvent.id, state: "projected" },
          { id: secondEvent.id, state: "pending" },
        ]),
      );
      expect(heldPractice?.recoveryHold).toBe(true);

      await withSystem(db, async (tx) => {
        await setDrillTimeouts(tx);
        await tx
          .select({ id: practices.id })
          .from(practices)
          .where(eq(practices.id, fixture.practiceId))
          .for("update")
          .limit(1);
        await tx.transaction((eventTx) =>
          projectSmsProviderEventForLockedPracticeInTransaction(
            eventTx as unknown as Database,
            {
              practiceId: fixture.practiceId,
              eventId: secondEvent.id,
              force: true,
            },
          ),
        );
        const remaining = await loadSmsProviderEventGateSummaryInTransaction(
          tx,
          {
            practiceId: fixture.practiceId,
          },
        );
        expect(remaining.total).toBe(0);
        await tx
          .update(practices)
          .set({
            recoveryHold: false,
            recoveryHoldReleasedAt: new Date(),
          })
          .where(
            and(
              eq(practices.id, fixture.practiceId),
              eq(practices.recoveryHold, true),
            ),
          );
        await tx.insert(auditLog).values({
          practiceId: fixture.practiceId,
          userId: null,
          action: "hold_released",
          entityType: "practice_recovery",
          entityId: fixture.practiceId,
          changes: { source: "sms_concurrency_drill", state: "released" },
        });
      });

      const [releasedPractice] = await db
        .select({ recoveryHold: practices.recoveryHold })
        .from(practices)
        .where(eq(practices.id, fixture.practiceId))
        .limit(1);
      const events = await db
        .select({ state: smsProviderEvents.state })
        .from(smsProviderEvents)
        .where(inArray(smsProviderEvents.id, [firstEvent.id, secondEvent.id]));
      const audits = await db
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(eq(auditLog.practiceId, fixture.practiceId));
      expect(releasedPractice?.recoveryHold).toBe(false);
      expect(events).toHaveLength(2);
      expect(events.every((event) => event.state === "projected")).toBe(true);
      expect(audits.map((entry) => entry.action)).toEqual(
        expect.arrayContaining(["hold_release_blocked", "hold_released"]),
      );
    } finally {
      await cleanupFixture(fixture);
    }
  });
});
