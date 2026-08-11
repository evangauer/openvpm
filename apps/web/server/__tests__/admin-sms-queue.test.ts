import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("server/routers/admin.ts", "utf8");
const sharedQueues = readFileSync(
  "lib/messaging/sms-operations-queues.ts",
  "utf8",
);

describe("SMS operator recovery queue", () => {
  it("checks the durable provider-event gate before provider profile work", () => {
    const helper = source.slice(
      source.indexOf("async function withMessagingProviderEffectsAllowed"),
      source.indexOf("const MESSAGING_SUBMISSION_LOCK_STALE_MS"),
    );
    const activation = source.slice(
      source.indexOf("setMessagingProfileEnabled:"),
      source.indexOf("submitMessagingBrand:"),
    );
    const readiness = source.slice(
      source.indexOf("async function recordMessagingProfileReady"),
      source.indexOf("async function recordMessagingProfileDisabled"),
    );

    expect(helper).toContain('.for("update", { of: practices })');
    expect(helper).toContain("loadSmsProviderEventGateSummaryInTransaction");
    expect(helper).toContain("providerEventGate.total > 0");
    expect(helper.indexOf("providerEventGate.total > 0")).toBeLessThan(
      helper.indexOf("return action"),
    );
    expect(activation).toContain("requireProviderEventClear: input.enabled");
    expect(activation).toContain("locationId: input.locationId");
    expect(activation).toMatch(
      /recordMessagingProfileReady\(\s*\{[\s\S]*?\},\s*providerTx,\s*\);/,
    );
    expect(readiness).toContain("if (leaseTx)");
    expect(readiness).toContain("persistReady(leaseTx, true)");
  });

  it("masks phone-like provider identifiers before any recovery DTO leaves tRPC", () => {
    expect(source).toContain("function safeOperationalProviderId");
    expect(source).toContain("WITHHELD_PHONE_LIKE_OPERATIONAL_ID");
    expect(source).toContain("/^\\+?\\d[\\d ().-]{6,18}$/");
  });
  const queue = sharedQueues.slice(
    sharedQueues.indexOf("loadSmsSendAttemptQueue"),
  );
  const routerQueue = source.slice(
    source.indexOf("smsSendAttemptQueue:"),
    source.indexOf("smsSendAttempt:", source.indexOf("smsSendAttemptQueue:")),
  );

  it("includes only stale pending communication claims with no attempt", () => {
    expect(queue).toContain('"orphan_pending_communication"');
    expect(queue).toContain('eq(communications.channel, "sms")');
    expect(queue).toContain('eq(communications.direction, "outbound")');
    expect(queue).toContain('eq(communications.status, "pending")');
    expect(queue).toContain("lte(communications.createdAt, cutoff)");
    expect(queue).toContain("not exists (");
    expect(queue).toContain("orphan_attempt.communication_id");
  });

  it("surfaces terminal attempt outcomes whose communication stayed pending", () => {
    expect(queue).toContain('"terminal_projection_pending"');
    expect(queue).toContain("in ('accepted', 'definite_failure')");
    expect(queue).toContain("pending_projection.status = 'pending'");
  });

  it("keeps the queue bounded, oldest-first, and no-store", () => {
    expect(routerQueue).toContain("noStore()");
    expect(routerQueue).toContain("loadSmsSendAttemptQueue(db, input)");
    expect(queue).toContain(".slice(0, input.limit)");
    expect(queue).toContain('cacheControl: "no-store" as const');
  });
});

describe("SMS delivery reconciliation queue", () => {
  const deliveryQueue = sharedQueues.slice(
    sharedQueues.indexOf("loadSmsDeliveryEventQueue"),
    sharedQueues.indexOf("loadSmsSendAttemptQueue"),
  );
  const deliveryDetail = source.slice(
    source.indexOf("smsDeliveryEventDetail:"),
    source.indexOf("smsSendAttemptQueue:"),
  );
  const sendDetail = source.slice(
    source.indexOf("smsSendAttempt:", source.indexOf("smsSendAttemptQueue:")),
    source.indexOf("reconcileSmsSendAttempt:"),
  );

  it("uses later exact attribution/projection to resolve historical queue rows", () => {
    expect(deliveryQueue).toContain("not (${hasAttribution})");
    expect(deliveryQueue).toContain("latestProjectionResult");
    expect(deliveryQueue).toContain("operator_reviewed");
    expect(deliveryQueue).toContain("latestReviewReason");
    expect(deliveryQueue).toContain("review.reviewed_history_id = conflict.id");
    expect(deliveryQueue).toContain(
      "review.reviewed_history_id = unmatched.id",
    );
  });

  it("treats ambiguity as the current incident and never resurfaces stale unmatched history", () => {
    expect(deliveryQueue).toContain(
      "any_conflict.delivery_event_id = unmatched.delivery_event_id",
    );
    expect(deliveryQueue).toContain("any_conflict.result = 'ambiguous'");
    expect(deliveryQueue).toContain("pending.result = 'ambiguous'");
    expect(deliveryQueue).toContain(
      "case when pending.result = 'ambiguous' then 0 else 1 end",
    );
    expect(deliveryQueue).toContain("pending.created_at desc");

    const currentIncident = (
      history: Array<{
        id: string;
        result: "unmatched" | "ambiguous" | "operator_reviewed";
        reviewedHistoryId?: string;
      }>,
    ) => {
      const reviewed = new Set(
        history.flatMap((row) =>
          row.reviewedHistoryId ? [row.reviewedHistoryId] : [],
        ),
      );
      const ambiguities = history.filter((row) => row.result === "ambiguous");
      return (
        [
          ...(ambiguities.length
            ? ambiguities
            : history.filter((row) => row.result === "unmatched")),
        ]
          .reverse()
          .find((row) => !reviewed.has(row.id))?.id ?? null
      );
    };

    const rows: Array<{
      id: string;
      result: "unmatched" | "ambiguous" | "operator_reviewed";
      reviewedHistoryId?: string;
    }> = [
      { id: "unmatched-old", result: "unmatched" },
      { id: "ambiguity-one", result: "ambiguous" },
    ];
    expect(currentIncident(rows)).toBe("ambiguity-one");
    rows.push({
      id: "review-one",
      result: "operator_reviewed",
      reviewedHistoryId: "ambiguity-one",
    });
    expect(currentIncident(rows)).toBeNull();
    rows.push({ id: "ambiguity-two", result: "ambiguous" });
    expect(currentIncident(rows)).toBe("ambiguity-two");
  });

  it("keeps actionable events separate from monitor-only stale acceptance", () => {
    expect(deliveryQueue).toContain("items: rows.map");
    expect(deliveryQueue).toContain("staleAcceptedWithoutFinalDelivery");
    expect(deliveryQueue).toContain("stale_without_final_delivery");
    expect(deliveryQueue).toContain(
      "receipt.provider_event_type = 'message.finalized'",
    );
  });

  it("keeps correlated queue identity qualified and serializes timestamp cutoffs", () => {
    expect(deliveryQueue).toContain(
      'attributed.delivery_event_id = "sms_delivery_events"."id"',
    );
    expect(deliveryQueue).toContain(
      'accepted_reconciliation.attempt_id = "sms_send_attempts"."id"',
    );
    expect(sharedQueues).toContain(
      'queue_event.attempt_id = "sms_send_attempts"."id"',
    );
    expect(deliveryQueue).toContain("receiptCutoff.toISOString()");
    expect(deliveryQueue).toContain("::timestamptz");
  });

  it("does not expose phone, body, or raw callback payloads", () => {
    expect(deliveryQueue).not.toContain("destinationE164");
    expect(deliveryQueue).not.toContain("body:");
    expect(deliveryQueue).not.toContain("rawBody");
    expect(deliveryQueue).toContain("providerMessageHint: null");
  });

  it("provides a bounded allowlisted delivery evidence/history DTO", () => {
    expect(deliveryDetail).toContain("smsDeliveryEventDetail:");
    expect(deliveryDetail).toContain("providerMessageId:");
    expect(deliveryDetail).toContain(
      "providerMessageId: safeOperationalProviderId(",
    );
    expect(deliveryDetail).toContain("reviewedHistoryId:");
    expect(deliveryDetail).toContain(
      "historyLimit: z.number().int().min(1).max(200).default(100)",
    );
    expect(deliveryDetail).toContain(".limit(input.historyLimit + 1)");
    expect(deliveryDetail).toContain("desc(smsDeliveryEventHistory.createdAt)");
    expect(deliveryDetail).toContain("const visibleHistory = history");
    expect(deliveryDetail).toContain(".reverse()");
    expect(deliveryDetail).toContain(
      "candidateAttempts: candidateAttempts.slice(0, 100)",
    );
    expect(deliveryDetail).toContain("candidateAttemptsTruncated");
    expect(deliveryDetail).toContain(".limit(101)");
    expect(deliveryDetail).toContain(
      'eq(smsSendAttemptEvents.outcome, "accepted")',
    );
    expect(deliveryDetail).toContain("truncated");
    expect(deliveryDetail).not.toContain("destinationE164");
    expect(deliveryDetail).not.toContain("content:");
    expect(deliveryDetail).not.toContain("detail:");
    expect(deliveryDetail).not.toContain("actorIdentity:");
    expect(deliveryDetail).not.toContain("actorName:");
    expect(deliveryDetail).not.toContain("operatorReasonCode:");
    expect(deliveryDetail).not.toContain("communicationId:");
    expect(deliveryDetail).not.toContain("occurredAt:");
    expect(deliveryDetail).not.toContain("rawBody:");
  });

  it("provides an allowlisted send-attempt evidence DTO", () => {
    expect(sendDetail).toContain("smsSendAttempt:");
    expect(sendDetail).toContain("communicationId:");
    expect(sendDetail).toContain("providerMessageId:");
    expect(sendDetail).toContain("events: events.map((event) => ({");
    expect(sendDetail).toContain(
      "providerMessageId: safeOperationalProviderId(",
    );
    expect(sendDetail).toContain("eventKey:");
    expect(sendDetail).not.toContain("destinationE164:");
    expect(sendDetail).not.toContain("senderE164:");
    expect(sendDetail).not.toContain("clientId:");
    expect(sendDetail).not.toContain("sourceId:");
    expect(sendDetail).not.toContain("idempotencyKey:");
    expect(sendDetail).not.toContain("registeredDisplayName:");
    expect(sendDetail).not.toContain("senderMessagingServiceId:");
    expect(sendDetail).not.toContain("requestedBy");
    expect(sendDetail).not.toContain("detail:");
    expect(sendDetail).not.toContain("actorIdentity:");
    expect(sendDetail).not.toContain("actorName:");
  });
});
