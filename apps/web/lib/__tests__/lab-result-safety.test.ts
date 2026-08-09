import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("lab result clinical safety contract", () => {
  it("keeps immutable events tied to an exact bounded result snapshot", () => {
    const schema = read("../../packages/db/schema/lab-result-events.ts");
    const migration = read("../../packages/db/drizzle/0059_daffy_darkstar.sql");
    const router = read("server/routers/records.ts");

    expect(schema).toContain('resultValue: varchar("result_value", { length: 128 })');
    expect(schema).toContain('unit: varchar("unit", { length: 32 })');
    expect(schema).toContain('referenceRangeLow: numeric("reference_range_low"');
    expect(schema).toContain("${table.statusAfter} in ('completed', 'reviewed')");
    expect(schema).toContain("length(btrim(coalesce(${table.resultValue}, ''))) between 1 and 128");
    expect(migration).toContain('"result_value" varchar(128)');
    expect(migration).toContain("source.appointment_id IS NOT DISTINCT FROM NEW.appointment_id");
    expect(migration).not.toContain("source.status = NEW.status_after");
    expect(migration).not.toContain("source.result_value IS NOT DISTINCT FROM NEW.result_value");
    expect(migration).toContain("app.ledger_maintenance");
    expect(migration).toContain("Lab result events are append-only and cannot be updated or deleted.");
    expect(router.match(/resultValue: updated\.resultValue/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(router).toContain("resultValue: created.resultValue");
  });

  it("enforces fail-safe lifecycle and review attribution during migration", () => {
    const migration = read("../../packages/db/drizzle/0059_daffy_darkstar.sql");
    const schema = read("../../packages/db/schema/clinical.ts");

    expect(migration).toContain("Rows without a result cannot truthfully remain completed or reviewed");
    expect(migration).toContain("A legacy reviewed row without an attributable reviewer is awaiting review");
    expect(migration).toContain('SET "result_value" = null');
    expect(schema).toContain("table.status} = 'reviewed'");
    expect(schema).toContain("${table.reviewedBy} is not null");
    expect(schema).toContain("${table.completedAt} is not null");
    expect(migration).toContain('"lab_result_events"."status_after" <> \'pending\' or "lab_result_events"."follow_up_status" = \'not_required\'');
    expect(migration).toContain('"lab_result_events"."follow_up_status" in (\'open\', \'completed\')');
    expect(migration).toContain('"lab_results"."follow_up_status" in (\'open\', \'completed\')');
  });

  it("keeps lab mutations idempotent and the clinic queue bounded", () => {
    const router = read("server/routers/records.ts");
    const inbox = read("app/(dashboard)/lab-results/page.tsx");

    expect(router).toContain("pg_advisory_xact_lock");
    expect(router).toContain("operationPayloadHash !== expected.payloadHash");
    expect(router).toContain(".limit(input.resultId ? 2 : input.limit + 1)");
    expect(router).toContain("truncated: !input.resultId && visibleRows.length > input.limit");
    expect(router).toContain("when 'critical' then 0 else 1 end");
    expect(router).toContain("coalesce(${labResults.followUpDueAt}, 'infinity'::timestamptz)");
    expect(inbox).toContain("reviewOperationIds.current.get(resultId)");
    expect(inbox).toContain("operationId: actionPanel.operationId");
    expect(inbox).toContain("More than 100 results match this view");
    expect(router).toContain("resultId: z.string().uuid().optional()");
    expect(router).toContain("eq(labResults.id, input.resultId)");
    expect(router).toContain("input.resultId ? 2 : input.limit + 1");
    expect(inbox).toContain("UUID_PATTERN.test(requestedResultId)");
    expect(inbox).toContain("Showing selected result");
    expect(inbox).toContain("Return to queue");
  });

  it("makes immutable evidence visible and tenant-isolated", () => {
    const router = read("server/routers/records.ts");
    const inbox = read("app/(dashboard)/lab-results/page.tsx");
    const rls = read("../../packages/db/rls/enable-rls.sql");
    const rlsTest = read("../../packages/db/test-rls.ts");
    const backup = read("lib/backup/export.ts");
    const migration = read("../../packages/db/drizzle/0059_daffy_darkstar.sql");

    expect(router).toContain("listLabResultHistory: protectedProcedure");
    expect(router).toContain("eq(labResultEvents.practiceId, ctx.practiceId)");
    expect(inbox).toContain("Show evidence history");
    expect(inbox).toContain("Snapshot:");
    expect(router).toContain('const frontDeskMode = ctx.user.role === "front_desk"');
    expect(router).toContain('eq(labResults.followUpAssignedTo, ctx.user.id)');
    expect(router).toContain('resultFlag: "unknown" as const');
    expect(inbox).toContain("Clinical values are restricted; follow the instructions below.");
    expect(inbox).toMatch(/!isFrontDesk \? <div>\s*<dt[^>]*>Clinical review<\/dt>/);
    expect(inbox).toContain("Your 100 highest-priority assigned items are shown.");
    expect(rls).toContain("'lab_result_events'");
    expect(rlsTest).toContain("application role cannot rewrite lab result evidence");
    expect(rlsTest).toContain("lab evidence owner mutation requires the maintenance GUC");
    expect(rlsTest).toContain("cross-tenant lab evidence actor is blocked");
    expect(migration).toContain("AND current_user = (");
    expect(migration).toContain("class.relname = TG_TABLE_NAME");
    expect(backup).toContain("labResultEvents: labResultEventRows");
    expect(backup).toContain('restorePracticeRows("labResultEvents", labResultEvents)');
  });

  it("seeds a truthful chronological lab evidence chain", () => {
    const seed = read("../../packages/db/seed.ts");

    expect(seed).toContain("await db.insert(labResultEvents).values(labEventValues)");
    expect(seed).toContain('eventType: "created"');
    expect(seed).toContain('statusAfter: "pending"');
    expect(seed).toContain('resultValue: null');
    expect(seed).toContain('resultFlag: "unknown"');
    expect(seed).toContain('eventType: "completed"');
    expect(seed).toContain('statusBefore: "pending"');
    expect(seed).toContain('statusAfter: "completed"');
    expect(seed).toContain("createdAt: result.createdAt");
    expect(seed).toContain("createdAt: result.completedAt!");
    expect(seed).toContain("createdAt: result.reviewedAt!");
    expect(seed).toContain("operationId: result.creationOperationId!");
    expect(seed).toContain("operationPayloadHash: result.creationPayloadHash!");
    expect(seed).not.toContain("legacyLabResultShape");
  });
});
