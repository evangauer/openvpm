import { beforeEach, describe, expect, it, vi } from "vitest";

type Evidence = Record<string, unknown> & {
  id: string;
  provider: string;
  providerMessageId: string | null;
  eventKey: string;
  payloadFingerprintSha256: string;
  classification: "unknown" | "sent" | "failed" | "delivered";
};
type History = Record<string, unknown> & {
  id: string;
  deliveryEventId: string;
  result: string;
  eventKey: string;
};
type Attempt = {
  id: string;
  practiceId: string;
  communicationId: string | null;
  provider: string;
};
type AttemptEvent = {
  practiceId: string;
  attemptId: string;
  outcome: string;
  providerMessageId: string | null;
};
type Communication = {
  id: string;
  practiceId: string;
  status: "pending" | "sent" | "failed" | "delivered" | "read";
  deleted?: boolean;
};

const fake = vi.hoisted(() => {
  const state = {
    evidence: [] as Evidence[],
    history: [] as History[],
    attempts: [] as Attempt[],
    attemptEvents: [] as AttemptEvent[],
    communications: [] as Communication[],
    nextId: 1,
    currentEvidence: null as Evidence | null,
    currentAttemptId: null as string | null,
    lastEvidenceConflict: null as Evidence | null,
    lastHistoryConflictKey: null as string | null,
    updateCalls: [] as Array<Record<string, unknown>>,
    recoveryHolds: new Set<string>(),
  };

  function tableName(table: unknown): string {
    if (!table || typeof table !== "object") return "";
    for (const symbol of Object.getOwnPropertySymbols(table)) {
      if (symbol.description?.includes("Name")) {
        const value = (table as Record<symbol, unknown>)[symbol];
        if (typeof value === "string") return value;
      }
    }
    return "";
  }

  function rowsForSelect(
    fromName: string,
    joinName: string,
    selection: Record<string, unknown> | undefined,
    whereStrings: Set<string>,
  ): unknown[] {
    if (fromName === "practices") {
      return [...new Set(state.attempts.map((attempt) => attempt.practiceId))]
        .filter((practiceId) => whereStrings.has(practiceId))
        .map((id) => ({ id, recoveryHold: state.recoveryHolds.has(id) }));
    }
    if (fromName === "sms_delivery_events") {
      const exact = state.evidence.find(
        (row) => whereStrings.has(row.id) || whereStrings.has(row.eventKey),
      );
      return exact
        ? [exact]
        : state.lastEvidenceConflict
          ? [state.lastEvidenceConflict]
          : state.evidence.slice(0, 1);
    }
    if (
      fromName === "sms_delivery_event_history" &&
      joinName === "sms_send_attempts"
    ) {
      const attributed = state.history.find(
        (row) =>
          row.deliveryEventId === state.currentEvidence?.id &&
          row.result === "attributed",
      );
      const attempt = state.attempts.find(
        (row) => row.id === attributed?.attemptId,
      );
      if (!attempt) return [];
      state.currentAttemptId = attempt.id;
      return [
        {
          id: attempt.id,
          practiceId: attempt.practiceId,
          communicationId: attempt.communicationId,
        },
      ];
    }
    if (
      fromName === "sms_send_attempts" &&
      joinName === "sms_send_attempt_events"
    ) {
      const evidence = state.currentEvidence;
      if (!evidence?.providerMessageId) return [];
      const rows = state.attempts.filter(
        (attempt) =>
          attempt.provider === evidence.provider &&
          state.attemptEvents.some(
            (event) =>
              event.practiceId === attempt.practiceId &&
              event.attemptId === attempt.id &&
              event.outcome === "accepted" &&
              event.providerMessageId === evidence.providerMessageId,
          ),
      );
      if (rows.length === 1) state.currentAttemptId = rows[0]!.id;
      return rows.map((attempt) => ({
        id: attempt.id,
        practiceId: attempt.practiceId,
        communicationId: attempt.communicationId,
      }));
    }
    if (fromName === "communications") {
      const attempt = state.attempts.find(
        (row) => row.id === state.currentAttemptId,
      );
      const communication = state.communications.find(
        (row) => row.id === attempt?.communicationId && !row.deleted,
      );
      return communication ? [{ status: communication.status }] : [];
    }
    if (fromName === "sms_delivery_event_history") {
      if (
        state.lastHistoryConflictKey &&
        whereStrings.has(state.lastHistoryConflictKey)
      ) {
        const row = state.history.find(
          (item) => item.eventKey === state.lastHistoryConflictKey,
        );
        return row ? [row] : [];
      }
      if (
        selection &&
        Object.keys(selection).length === 1 &&
        "id" in selection
      ) {
        const exactId = state.history.find((row) =>
          whereStrings.has(row.id),
        )?.id;
        const result = whereStrings.has("ambiguous")
          ? "ambiguous"
          : whereStrings.has("unmatched")
            ? "unmatched"
            : null;
        return state.history.filter(
          (row) =>
            (!exactId || row.id === exactId) &&
            (!result || row.result === result) &&
            (row.result === "unmatched" || row.result === "ambiguous") &&
            !state.history.some(
              (review) => review.reviewedHistoryId === row.id,
            ),
        );
      }
      if (
        selection &&
        Object.keys(selection).length === 1 &&
        "classification" in selection
      ) {
        const reconciled = [...state.history]
          .reverse()
          .find((row) => row.result === "reconciled");
        return reconciled
          ? [{ classification: reconciled.classification }]
          : [];
      }
      if (!selection) {
        const eventKey = [...whereStrings].find((value) =>
          value.includes(":operator-reconciliation:"),
        );
        const operatorAction = eventKey
          ? state.history.find((row) => row.eventKey === eventKey)
          : [...state.history]
              .reverse()
              .find((row) => row.kind === "operator_reconciliation");
        return operatorAction ? [operatorAction] : [];
      }
      return state.history;
    }
    return selection ? [] : [];
  }

  const db = {
    execute: vi.fn(async () => undefined),
    select: vi.fn((selection?: Record<string, unknown>) => {
      let fromName = "";
      let joinName = "";
      const whereStrings = new Set<string>();
      function collectStrings(value: unknown, seen = new Set<unknown>()) {
        if (typeof value === "string") {
          whereStrings.add(value);
          return;
        }
        if (!value || typeof value !== "object" || seen.has(value)) return;
        seen.add(value);
        if (Array.isArray(value)) {
          for (const nested of value) collectStrings(nested, seen);
          return;
        }
        const record = value as Record<string, unknown>;
        if (value.constructor?.name === "Param") {
          collectStrings(record.value, seen);
          return;
        }
        if (Array.isArray(record.queryChunks)) {
          collectStrings(record.queryChunks, seen);
        }
      }
      const builder: Record<string, unknown> & PromiseLike<unknown[]> = {
        from(table: unknown) {
          fromName = tableName(table);
          return builder;
        },
        innerJoin(table: unknown) {
          joinName = tableName(table);
          return builder;
        },
        where(condition: unknown) {
          collectStrings(condition);
          return builder;
        },
        groupBy() {
          return builder;
        },
        orderBy() {
          return builder;
        },
        for() {
          return builder;
        },
        limit(count: number) {
          return Promise.resolve(
            rowsForSelect(fromName, joinName, selection, whereStrings).slice(
              0,
              count,
            ),
          );
        },
        then(resolve, reject) {
          return Promise.resolve(
            rowsForSelect(fromName, joinName, selection, whereStrings),
          ).then(resolve, reject);
        },
      };
      return builder;
    }),
    insert: vi.fn((table: unknown) => {
      const name = tableName(table);
      let values: Record<string, unknown>;
      const builder = {
        values(input: Record<string, unknown>) {
          values = input;
          return builder;
        },
        onConflictDoNothing() {
          return builder;
        },
        async returning(selection?: Record<string, unknown>) {
          if (name === "sms_delivery_events") {
            const prior = state.evidence.find(
              (row) =>
                row.provider === values.provider &&
                row.eventKey === values.eventKey,
            );
            if (prior) {
              state.currentEvidence = prior;
              state.lastEvidenceConflict = prior;
              return [];
            }
            const row = {
              ...values,
              id: `evidence-${state.nextId++}`,
              receivedAt: new Date(),
            } as unknown as Evidence;
            state.evidence.push(row);
            state.currentEvidence = row;
            state.lastEvidenceConflict = null;
            return [selection ? { id: row.id } : row];
          }
          if (name === "sms_delivery_event_history") {
            const eventKey = String(values.eventKey);
            const eventKeyConflict = state.history.find(
              (row) => row.eventKey === eventKey,
            );
            const attributionConflict =
              values.result === "attributed"
                ? state.history.find(
                    (row) =>
                      row.deliveryEventId === values.deliveryEventId &&
                      row.result === "attributed",
                  )
                : undefined;
            const reviewConflict = values.reviewedHistoryId
              ? state.history.find(
                  (row) => row.reviewedHistoryId === values.reviewedHistoryId,
                )
              : undefined;
            const prior =
              eventKeyConflict ?? attributionConflict ?? reviewConflict;
            if (prior) {
              state.lastHistoryConflictKey = eventKey;
              return [];
            }
            const row = {
              ...values,
              id: `history-${state.nextId++}`,
              createdAt: new Date(),
            } as unknown as History;
            state.history.push(row);
            state.lastHistoryConflictKey = null;
            return [selection ? { id: row.id } : row];
          }
          return [];
        },
      };
      return builder;
    }),
    update: vi.fn((_table: unknown) => {
      let values: Record<string, unknown>;
      const builder = {
        set(input: Record<string, unknown>) {
          values = input;
          state.updateCalls.push(input);
          return builder;
        },
        where() {
          return builder;
        },
        async returning() {
          const attempt = state.attempts.find(
            (row) => row.id === state.currentAttemptId,
          );
          const communication = state.communications.find(
            (row) => row.id === attempt?.communicationId && !row.deleted,
          );
          if (!communication) return [];
          const rank = {
            pending: 0,
            sent: 1,
            failed: 2,
            delivered: 3,
            read: 3,
          };
          const desired = values.status as Communication["status"];
          if (rank[desired] > rank[communication.status]) {
            communication.status = desired;
            return [{ id: communication.id }];
          }
          return [];
        },
      };
      return builder;
    }),
  };

  function reset() {
    state.evidence.length = 0;
    state.history.length = 0;
    state.attempts.length = 0;
    state.attemptEvents.length = 0;
    state.communications.length = 0;
    state.nextId = 1;
    state.currentEvidence = null;
    state.currentAttemptId = null;
    state.lastEvidenceConflict = null;
    state.lastHistoryConflictKey = null;
    state.updateCalls.length = 0;
    state.recoveryHolds.clear();
  }

  return { state, db, reset };
});

vi.mock("@openpims/db/client", () => ({ db: fake.db }));
vi.mock("@/lib/tenant-db", () => ({
  withSystem: vi.fn(async (_db: unknown, fn: (tx: unknown) => unknown) =>
    fn(fake.db),
  ),
}));

const {
  processPendingDeliveryEvidenceForAcceptedSend,
  recordSmsDeliveryCallback,
  reconcileSmsDeliveryEvent,
} = await import("../sms-delivery-ledger");

function acceptedAttempt(input: {
  id?: string;
  practiceId?: string;
  providerMessageId?: string;
  communicationId?: string | null;
}) {
  const id = input.id ?? "attempt-1";
  const practiceId = input.practiceId ?? "practice-1";
  const communicationId =
    input.communicationId === undefined
      ? "communication-1"
      : input.communicationId;
  fake.state.attempts.push({
    id,
    practiceId,
    communicationId,
    provider: "telnyx",
  });
  fake.state.attemptEvents.push({
    practiceId,
    attemptId: id,
    outcome: "accepted",
    providerMessageId: input.providerMessageId ?? "message-1",
  });
  if (
    communicationId &&
    !fake.state.communications.some((row) => row.id === communicationId)
  ) {
    fake.state.communications.push({
      id: communicationId,
      practiceId,
      status: "pending",
    });
  }
}

function callback(input: {
  eventId: string;
  messageId?: string;
  classification: "unknown" | "sent" | "failed" | "delivered";
  status?: string;
  errorCode?: string;
}) {
  return recordSmsDeliveryCallback({
    provider: "telnyx",
    providerEventId: input.eventId,
    providerMessageId: input.messageId ?? "message-1",
    providerEventType: "message.finalized",
    providerStatus: input.status ?? input.classification,
    providerErrorCode: input.errorCode,
    classification: input.classification,
  });
}

beforeEach(() => fake.reset());

describe("SMS delivery ledger service behavior", () => {
  it("resolves an early unmatched callback on an exact duplicate retry", async () => {
    await expect(
      callback({ eventId: "event-1", classification: "delivered" }),
    ).resolves.toMatchObject({ result: "unmatched" });
    acceptedAttempt({});

    await expect(
      callback({ eventId: "event-1", classification: "delivered" }),
    ).resolves.toMatchObject({ duplicate: true, result: "projected" });
    expect(fake.state.evidence).toHaveLength(1);
    expect(
      fake.state.history.filter((row) => row.result === "attributed"),
    ).toHaveLength(1);
    expect(fake.state.communications[0]!.status).toBe("delivered");
  });

  it("retains a bounded provider event id without overflowing its dedupe key", async () => {
    await callback({
      eventId: "e".repeat(300),
      classification: "unknown",
    });
    expect(String(fake.state.evidence[0]!.providerEventId)).toHaveLength(255);
    expect(fake.state.evidence[0]!.eventKey).toMatch(/^event:[0-9a-f]{64}$/);
    expect(fake.state.evidence[0]!.eventKey.length).toBeLessThanOrEqual(255);
  });

  it("resolves callback-first evidence from the accepted-send transaction hook", async () => {
    await callback({ eventId: "event-1", classification: "delivered" });
    acceptedAttempt({});

    await expect(
      processPendingDeliveryEvidenceForAcceptedSend(
        fake.db as never,
        "telnyx",
        "message-1",
      ),
    ).resolves.toEqual(["projected"]);
    expect(fake.state.evidence).toHaveLength(1);
    expect(
      fake.state.history.filter((row) => row.result === "attributed"),
    ).toHaveLength(1);
    expect(fake.state.communications[0]!.status).toBe("delivered");
  });

  it("quarantines a reused event id and preserves only its redacted conflicting observation", async () => {
    acceptedAttempt({});
    await callback({ eventId: "event-1", classification: "sent" });

    await expect(
      callback({
        eventId: "event-1",
        classification: "delivered",
        status: "delivery_success",
        errorCode: "provider_retry_42",
      }),
    ).resolves.toMatchObject({ result: "ambiguous" });
    expect(fake.state.evidence).toHaveLength(1);
    expect(fake.state.communications[0]!.status).toBe("sent");
    const conflict = fake.state.history.find(
      (row) => row.result === "ambiguous",
    )!;
    expect(conflict.classification).toBe("delivered");
    expect(JSON.parse(String(conflict.detail))).toMatchObject({
      providerMessageId: "message-1",
      providerEventType: "message.finalized",
      providerStatus: "delivery_success",
      providerErrorCode: "provider_retry_42",
      messageIdDiffers: false,
    });
    expect(String(conflict.detail)).not.toMatch(/phone|recipient|sender|body/i);
  });

  it("quarantines the same provider message id across practices", async () => {
    acceptedAttempt({ id: "attempt-a", practiceId: "practice-a" });
    acceptedAttempt({
      id: "attempt-b",
      practiceId: "practice-b",
      communicationId: "communication-b",
    });

    await expect(
      callback({ eventId: "event-1", classification: "delivered" }),
    ).resolves.toMatchObject({ result: "ambiguous" });
    expect(fake.state.history.some((row) => row.result === "attributed")).toBe(
      false,
    );
    expect(fake.state.updateCalls).toHaveLength(0);
  });

  it("reopens ambiguity when a second practice accepts an already-attributed provider id", async () => {
    acceptedAttempt({ id: "attempt-a", practiceId: "practice-a" });
    await callback({ eventId: "event-1", classification: "sent" });
    acceptedAttempt({
      id: "attempt-b",
      practiceId: "practice-b",
      communicationId: "communication-b",
    });

    await expect(
      processPendingDeliveryEvidenceForAcceptedSend(
        fake.db as never,
        "telnyx",
        "message-1",
      ),
    ).resolves.toEqual(["ambiguous"]);
    expect(
      fake.state.history.filter((row) => row.result === "attributed"),
    ).toHaveLength(1);
    expect(
      fake.state.history.some(
        (row) =>
          row.result === "ambiguous" && row.eventKey.includes("candidates:"),
      ),
    ).toBe(true);
  });

  it("moves unmatched evidence to ambiguity, reviews only the current incident, and reopens on a new candidate set", async () => {
    const recorded = await callback({
      eventId: "event-transition",
      classification: "unknown",
    });
    const staleUnmatched = fake.state.history.find(
      (row) => row.result === "unmatched",
    )!;
    acceptedAttempt({ id: "attempt-a", practiceId: "practice-a" });
    acceptedAttempt({
      id: "attempt-b",
      practiceId: "practice-b",
      communicationId: "communication-b",
    });
    await processPendingDeliveryEvidenceForAcceptedSend(
      fake.db as never,
      "telnyx",
      "message-1",
    );
    const ambiguity = fake.state.history.find(
      (row) => row.result === "ambiguous",
    )!;

    await reconcileSmsDeliveryEvent({
      deliveryEventId: recorded.eventId,
      reconciliationId: "00000000-0000-4000-8000-000000000009",
      reviewedHistoryId: ambiguity.id,
      reasonCode: "identity_conflict_review",
      actorIdentity: "operator@example.com",
      actorName: "Operator",
    });
    expect(
      fake.state.history.some((row) => row.reviewedHistoryId === ambiguity.id),
    ).toBe(true);
    expect(
      fake.state.history.some(
        (row) => row.reviewedHistoryId === staleUnmatched.id,
      ),
    ).toBe(false);

    acceptedAttempt({
      id: "attempt-c",
      practiceId: "practice-c",
      communicationId: "communication-c",
    });
    await processPendingDeliveryEvidenceForAcceptedSend(
      fake.db as never,
      "telnyx",
      "message-1",
    );
    const pendingAmbiguities = fake.state.history.filter(
      (row) =>
        row.result === "ambiguous" &&
        !fake.state.history.some(
          (review) => review.reviewedHistoryId === row.id,
        ),
    );
    expect(pendingAmbiguities).toHaveLength(1);
  });

  it("reviews one exact ambiguity without projection and a later conflict reopens", async () => {
    acceptedAttempt({});
    const recorded = await callback({
      eventId: "event-1",
      classification: "sent",
    });
    await callback({ eventId: "event-1", classification: "delivered" });
    const conflict = fake.state.history.find(
      (row) => row.result === "ambiguous",
    )!;
    const updatesBefore = fake.state.updateCalls.length;

    const review = {
      deliveryEventId: recorded.eventId,
      reconciliationId: "00000000-0000-4000-8000-000000000003",
      reviewedHistoryId: conflict.id,
      reasonCode: "identity_conflict_review" as const,
      actorIdentity: "operator@example.com",
      actorName: "Operator",
    };
    await expect(reconcileSmsDeliveryEvent(review)).resolves.toMatchObject({
      result: "identity_conflict_reviewed",
    });
    await expect(reconcileSmsDeliveryEvent(review)).resolves.toMatchObject({
      result: "identity_conflict_reviewed",
    });
    await expect(
      reconcileSmsDeliveryEvent({ ...review, actorName: "Changed Operator" }),
    ).rejects.toThrow("Reconciliation id collision");
    expect(fake.state.updateCalls).toHaveLength(updatesBefore);
    expect(
      fake.state.history.some((row) => row.reviewedHistoryId === conflict.id),
    ).toBe(true);

    await callback({
      eventId: "event-1",
      classification: "failed",
      status: "delivery_failed",
    });
    const pendingConflicts = fake.state.history.filter(
      (row) =>
        row.result === "ambiguous" &&
        !fake.state.history.some(
          (review) => review.reviewedHistoryId === row.id,
        ),
    );
    expect(pendingConflicts).toHaveLength(1);
  });

  it("is idempotent under concurrent duplicate attribution", async () => {
    acceptedAttempt({});
    const [left, right] = await Promise.all([
      callback({ eventId: "event-1", classification: "sent" }),
      callback({ eventId: "event-1", classification: "sent" }),
    ]);
    expect([left.result, right.result]).toEqual(["projected", "projected"]);
    expect(fake.state.evidence).toHaveLength(1);
    expect(
      fake.state.history.filter((row) => row.result === "attributed"),
    ).toHaveLength(1);
  });

  it.each([
    [
      [
        ["failed-1", "failed"],
        ["delivered-1", "delivered"],
      ],
      "delivered",
    ],
    [
      [
        ["delivered-1", "delivered"],
        ["failed-1", "failed"],
      ],
      "delivered",
    ],
  ] as const)(
    "projects failed/delivered permutation monotonically",
    async (events, expected) => {
      acceptedAttempt({});
      for (const [eventId, classification] of events) {
        await callback({ eventId, classification });
      }
      expect(fake.state.communications[0]!.status).toBe(expected);
    },
  );

  it.each([null, "soft-deleted"] as const)(
    "queues a projection miss for %s communication",
    async (mode) => {
      acceptedAttempt({
        communicationId: mode === null ? null : "communication-1",
      });
      if (mode === "soft-deleted") fake.state.communications[0]!.deleted = true;

      await expect(
        callback({ eventId: "event-1", classification: "delivered" }),
      ).resolves.toMatchObject({ result: "projection_miss" });
      expect(
        fake.state.history.some((row) => row.result === "projection_miss"),
      ).toBe(true);
    },
  );

  it("records unresolved operator quarantine review without projection", async () => {
    const recorded = await callback({
      eventId: "event-1",
      classification: "unknown",
      status: "provider_new_state",
    });
    const updatesBefore = fake.state.updateCalls.length;
    const unmatchedHistoryId = fake.state.history.find(
      (row) => row.result === "unmatched",
    )!.id;

    const review = {
      deliveryEventId: recorded.eventId,
      reconciliationId: "00000000-0000-4000-8000-000000000001",
      reviewedHistoryId: unmatchedHistoryId,
      reasonCode: "unmatched_evidence_review" as const,
      actorIdentity: "operator@example.com",
      actorName: "Operator",
    };
    await expect(reconcileSmsDeliveryEvent(review)).resolves.toMatchObject({
      result: "unmatched_evidence_reviewed",
    });
    await expect(reconcileSmsDeliveryEvent(review)).resolves.toMatchObject({
      result: "unmatched_evidence_reviewed",
    });
    await expect(
      reconcileSmsDeliveryEvent({ ...review, actorName: "Changed Operator" }),
    ).rejects.toThrow("Reconciliation id collision");
    expect(fake.state.updateCalls).toHaveLength(updatesBefore);
    expect(
      fake.state.history.some((row) => row.result === "operator_reviewed"),
    ).toBe(true);
  });

  it("replays exact reconciliation idempotently and rejects a changed snapshot", async () => {
    acceptedAttempt({});
    const recorded = await callback({
      eventId: "event-1",
      classification: "sent",
    });
    const base = {
      deliveryEventId: recorded.eventId,
      reconciliationId: "00000000-0000-4000-8000-000000000002",
      reasonCode: "projection_repair" as const,
      actorIdentity: "operator@example.com",
      actorName: "Operator",
    };

    await expect(reconcileSmsDeliveryEvent(base)).resolves.toMatchObject({
      classification: "sent",
      result: "projected",
    });
    await reconcileSmsDeliveryEvent({
      deliveryEventId: recorded.eventId,
      reconciliationId: "00000000-0000-4000-8000-000000000004",
      classification: "delivered",
      reasonCode: "provider_portal_status_review",
      actorIdentity: "operator@example.com",
      actorName: "Operator",
    });
    await expect(reconcileSmsDeliveryEvent(base)).resolves.toMatchObject({
      classification: "sent",
      result: "projected",
    });
    await expect(
      reconcileSmsDeliveryEvent({
        ...base,
        reasonCode: "exact_attribution_retry",
        actorName: "Changed Operator",
      }),
    ).rejects.toThrow("Reconciliation id collision");
    expect(
      fake.state.history.filter((row) => row.result === "reconciled"),
    ).toHaveLength(2);
  });

  it("defers operator projection while the attributed practice is recovery-held", async () => {
    acceptedAttempt({ practiceId: "practice-held" });
    const recorded = await callback({
      eventId: "event-held",
      classification: "unknown",
    });
    fake.state.recoveryHolds.add("practice-held");

    await expect(
      reconcileSmsDeliveryEvent({
        deliveryEventId: recorded.eventId,
        reconciliationId: "00000000-0000-0000-0000-0000000000aa",
        classification: "delivered",
        reasonCode: "provider_portal_status_review",
        actorIdentity: "operator-1",
        actorName: "Operator",
      }),
    ).rejects.toThrow("paused while the clinic is in recovery");
    expect(fake.state.communications[0]!.status).toBe("pending");
    expect(fake.state.history.some((row) => row.result === "reconciled")).toBe(
      false,
    );
  });

  it("rejects a quarantine reason aimed at the wrong incident type", async () => {
    const unmatched = await callback({
      eventId: "event-unmatched",
      classification: "unknown",
    });
    const unmatchedHistory = fake.state.history.find(
      (row) =>
        row.deliveryEventId === unmatched.eventId && row.result === "unmatched",
    )!;
    await expect(
      reconcileSmsDeliveryEvent({
        deliveryEventId: unmatched.eventId,
        reconciliationId: "00000000-0000-4000-8000-000000000005",
        reviewedHistoryId: unmatchedHistory.id,
        reasonCode: "identity_conflict_review",
        actorIdentity: "operator@example.com",
        actorName: "Operator",
      }),
    ).rejects.toThrow("No pending provider identity conflict exists");

    acceptedAttempt({});
    const attributed = await callback({
      eventId: "event-conflict",
      classification: "sent",
    });
    await callback({
      eventId: "event-conflict",
      classification: "delivered",
    });
    const ambiguousHistory = fake.state.history.find(
      (row) =>
        row.deliveryEventId === attributed.eventId &&
        row.result === "ambiguous",
    )!;
    await expect(
      reconcileSmsDeliveryEvent({
        deliveryEventId: attributed.eventId,
        reconciliationId: "00000000-0000-4000-8000-000000000006",
        reviewedHistoryId: ambiguousHistory.id,
        reasonCode: "unmatched_evidence_review",
        actorIdentity: "operator@example.com",
        actorName: "Operator",
      }),
    ).rejects.toThrow("Quarantine review reasons apply only");
  });

  it("repairs a projection with the latest monotone operator classification", async () => {
    acceptedAttempt({});
    fake.state.communications[0]!.deleted = true;
    const recorded = await callback({
      eventId: "event-1",
      classification: "unknown",
      status: "new_provider_state",
    });

    await expect(
      reconcileSmsDeliveryEvent({
        deliveryEventId: recorded.eventId,
        reconciliationId: "00000000-0000-4000-8000-000000000007",
        classification: "delivered",
        reasonCode: "provider_portal_status_review",
        actorIdentity: "operator@example.com",
        actorName: "Operator",
      }),
    ).resolves.toMatchObject({
      classification: "delivered",
      result: "projection_miss",
    });

    fake.state.communications[0]!.deleted = false;
    await expect(
      reconcileSmsDeliveryEvent({
        deliveryEventId: recorded.eventId,
        reconciliationId: "00000000-0000-4000-8000-000000000008",
        reasonCode: "projection_repair",
        actorIdentity: "operator@example.com",
        actorName: "Operator",
      }),
    ).resolves.toMatchObject({
      classification: "delivered",
      result: "projected",
    });
    expect(fake.state.communications[0]!.status).toBe("delivered");
  });
});
