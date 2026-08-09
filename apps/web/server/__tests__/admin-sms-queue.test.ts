import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("server/routers/admin.ts", "utf8");

describe("SMS operator recovery queue", () => {
  const queue = source.slice(
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
    expect(queue).toContain("noStore()");
    expect(queue).toContain(".slice(0, input.limit)");
    expect(queue).toContain('cacheControl: "no-store" as const');
  });
});

describe("SMS delivery reconciliation queue", () => {
  const deliveryQueue = source.slice(
    source.indexOf("smsDeliveryEventQueue:"),
    source.indexOf("smsSendAttemptQueue:"),
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

  it("does not expose phone, body, or raw callback payloads", () => {
    expect(deliveryQueue).not.toContain("destinationE164");
    expect(deliveryQueue).not.toContain("body:");
    expect(deliveryQueue).not.toContain("rawBody");
    expect(deliveryQueue).toContain("providerMessageHint: null");
  });

  it("provides a bounded redacted evidence/history detail workflow", () => {
    expect(deliveryQueue).toContain("smsDeliveryEventDetail:");
    expect(deliveryQueue).toContain("providerMessageId:");
    expect(deliveryQueue).toContain("reviewedHistoryId:");
    expect(deliveryQueue).toContain(
      "redactedOperatorIdentity(row.actorIdentity)",
    );
    expect(deliveryQueue).toContain(
      "historyLimit: z.number().int().min(1).max(200).default(100)",
    );
    expect(deliveryQueue).toContain(".limit(input.historyLimit + 1)");
    expect(deliveryQueue).toContain("desc(smsDeliveryEventHistory.createdAt)");
    expect(deliveryQueue).toContain("const visibleHistory = history");
    expect(deliveryQueue).toContain(".reverse()");
    expect(deliveryQueue).toContain(
      "candidateAttempts: candidateAttempts.slice(0, 100)",
    );
    expect(deliveryQueue).toContain("candidateAttemptsTruncated");
    expect(deliveryQueue).toContain(".limit(101)");
    expect(deliveryQueue).toContain(
      'eq(smsSendAttemptEvents.outcome, "accepted")',
    );
    expect(deliveryQueue).toContain("truncated");
    expect(deliveryQueue).not.toContain("destinationE164");
    expect(deliveryQueue).not.toContain("content:");
  });
});
