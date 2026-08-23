import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

function sourceSection(source: string, start: string, end: string): string {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt + start.length);
  expect(startAt).toBeGreaterThanOrEqual(0);
  expect(endAt).toBeGreaterThan(startAt);
  return source.slice(startAt, endAt);
}

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

  it("serializes correction semantics and preserves financial history", () => {
    const router = read("server/routers/records.ts");
    const correction = sourceSection(
      router,
      "markLabResultEnteredInError: protectedProcedure",
      "createLabResult: protectedProcedure",
    );

    expect(correction).toContain('kind: "lab_result_entered_in_error"');
    expect(correction).toContain("reason: input.reason");
    expect(correction.indexOf("lockLabOperation")).toBeLessThan(
      correction.indexOf("lockLabResultSource"),
    );
    expect(correction.indexOf("lockLabResultSource")).toBeLessThan(
      correction.indexOf("const [operationReplay]"),
    );
    expect(correction).toContain(
      "sourceCorrection.operationPayloadHash === operationPayloadHash",
    );
    expect(correction).toContain("return sourceCorrection");
    expect(correction).toContain(
      "This lab result already has a different correction. Refresh the chart.",
    );
    expect(correction).toContain('recordType: "lab_result"');
    expect(correction).toContain('action: "entered_in_error"');
    expect(correction).toContain('eq(visitWorkItems.status, "unresolved")');
    expect(correction).toContain("isNull(visitWorkItems.invoiceId)");
    expect(correction).toContain("isNull(visitWorkItems.invoiceItemId)");
    expect(correction).not.toContain('eq(visitWorkItems.status, "charged")');
    expect(correction).not.toContain('eq(visitWorkItems.status, "no_charge")');
  });

  it("creates and replays exact replacement evidence with bounded visit work", () => {
    const router = read("server/routers/records.ts");
    const creation = sourceSection(
      router,
      "createLabResult: protectedProcedure",
      "updateLabResultStatus: protectedProcedure",
    );

    expect(creation).toContain("input.replacesLabResultId && ctx.user.role");
    expect(router).toContain(
      "input.replacesLabResultId && !input.resultValue?.trim()",
    );
    expect(router).toContain(
      "A fresh result value is required when replacing an entered-in-error lab result.",
    );
    expect(creation).toContain('kind: "create"');
    expect(creation).toContain(
      "replacesLabResultId: input.replacesLabResultId ?? null",
    );
    expect(creation.indexOf("lockLabOperation")).toBeLessThan(
      creation.indexOf("lockLabResultSource"),
    );
    expect(creation.indexOf("lockLabResultSource")).toBeLessThan(
      creation.indexOf("const existingReplay"),
    );
    expect(creation.match(/assertLabReplacementReplay/g)).toHaveLength(2);
    expect(creation).toContain("replacementCorrectionId = source.correctionId");
    expect(creation).toContain("await tx.insert(labResultReplacements).values");
    expect(creation).toMatch(
      /sourceWork\?\.status === "charged"\s*\|\|\s*sourceWork\?\.status === "no_charge"/,
    );
    expect(creation).toContain(
      'replacementAppointment.status === "checked_in"',
    );
    expect(creation).toContain('replacementAppointment.status === "in_exam"');
    expect(creation).toContain(
      "if (created?.appointmentId && shouldRegisterVisitWork)",
    );
    expect(creation).toContain(
      "await registerVisitWorkItem(txCtx, created.appointmentId",
    );
  });

  it("locks every active lifecycle mutation before replay and CAS", () => {
    const router = read("server/routers/records.ts");
    const routeNames = [
      [
        "updateLabResultStatus: protectedProcedure",
        "completeLabResult: protectedProcedure",
      ],
      [
        "completeLabResult: protectedProcedure",
        "assignLabFollowUp: protectedProcedure",
      ],
      [
        "assignLabFollowUp: protectedProcedure",
        "completeLabFollowUp: protectedProcedure",
      ],
      ["completeLabFollowUp: protectedProcedure", "// Procedures"],
    ] as const;

    for (const [start, end] of routeNames) {
      const lifecycle = sourceSection(router, start, end);
      expect(lifecycle.indexOf("lockLabOperation")).toBeLessThan(
        lifecycle.indexOf("lockLabResultSource"),
      );
      expect(lifecycle.indexOf("lockLabResultSource")).toBeLessThan(
        lifecycle.indexOf("getLabOperationReplay"),
      );
      expect(lifecycle).toContain("activeLabResultPredicate(ctx.practiceId)");
      expect(lifecycle).toContain(".update(labResults)");
      expect(lifecycle).toContain(".returning()");
    }
  });

  it("excludes corrected results from active queues and trends but exposes chart evidence", () => {
    const router = read("server/routers/records.ts");
    const records = read("app/(dashboard)/records/page.tsx");
    const inbox = sourceSection(
      router,
      "listLabReviewInbox: protectedProcedure",
      "listLabAssignees: protectedProcedure",
    );

    expect(inbox).toContain("activeLabResultPredicate(ctx.practiceId)");
    expect(records).toContain(
      "(labResultsList ?? []).filter((result) => !result.correctionId)",
    );
    expect(records).toContain("function CorrectedLabResultHistory");
    expect(records).toContain("{ enabled: expanded, staleTime: 60_000 }");
    expect(records).toContain("formatClinicalDateTime(");
    expect(records).toContain('"Time unavailable"');
    expect(records).toContain("Show evidence history");
    expect(records).toContain("event.eventType.replaceAll");
  });

  it("supports deliberate cross-patient repair and exact bidirectional navigation", () => {
    const records = read("app/(dashboard)/records/page.tsx");

    expect(records).toContain("canSearchReplacementPatients");
    expect(records).toContain("Replacement patient");
    expect(records).toContain("wrong-patient repair");
    expect(records).toContain("replacementPatient?.id === selectedPatient?.id");
    expect(records).toContain("replacementSourceLabResult?.appointmentId ??");
    expect(records).toContain("Only the test name was copied");
    expect(records).toContain(
      "!replacesLabResultId || Boolean(labForm.resultValue.trim())",
    );
    expect(records).toContain(
      "A replacement cannot be saved as an empty pending result.",
    );
    expect(records).toContain('resultValue: ""');
    expect(records).toContain('resultFlag: "unknown"');
    expect(records).toContain("lab.replacementLabResultPatientId ?? patientId");
    expect(records).toContain("lab.replacesLabResultPatientId ?? patientId");
    expect(records).toMatch(/Prior charged\s+or/);
    expect(records).toMatch(/wrong-patient\s+replacements/);
  });

  it("renders correction attribution in the practice timezone", () => {
    const records = read("app/(dashboard)/records/page.tsx");
    const correctionControl = read(
      "components/records/clinical-correction-control.tsx",
    );

    expect(correctionControl).toContain("formatClinicalDateTime(");
    expect(correctionControl).toContain('"Unknown time"');
    expect(correctionControl).not.toContain("correctedAt.toLocaleString()");
    expect(
      records.match(/timeZone=\{recordsTimeZone\}/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(4);
  });

  it("registers correction and replacement ledgers in backup and RLS maintenance", () => {
    const backup = read("lib/backup/export.ts");
    const rls = read("../../packages/db/rls/enable-rls.sql");
    const rlsTest = read("../../packages/db/test-rls.ts");
    const reset = read("../../packages/db/reset.ts");

    expect(backup).toContain("labResultReplacements: labReplacementRows");
    expect(backup).toContain(
      'restorePracticeRows("labResultReplacements", labResultReplacements)',
    );
    expect(backup).toContain(
      ".correctionId must identify the exact lab correction for its source.",
    );
    expect(backup).toContain("directed replacement cycle");
    expect(rls).toContain("'lab_result_replacements'");
    expect(rls).toContain(
      "GRANT SELECT, INSERT ON lab_result_replacements TO openpims_app",
    );
    const apiRoleRevokes = rls.slice(
      rls.indexOf("'REVOKE ALL ON auth_email_attempts"),
      rls.indexOf("FROM %I', r"),
    );
    for (const table of [
      "clinical_record_corrections",
      "demo_accesses",
      "dispense_charge_queue",
      "file_object_replicas",
      "file_storage_events",
      "funnel_events",
      "lab_result_events",
      "lab_result_replacements",
    ]) {
      expect(apiRoleRevokes).toContain(table);
    }
    expect(rls).toContain("FROM %I', r");
    expect(rlsTest).toContain("cross-tenant lab replacement INSERT is blocked");
    expect(rlsTest).toContain(
      "lab replacement owner mutation requires the maintenance GUC",
    );
    expect(rlsTest).toContain(
      "application role cannot delete correction evidence even with bypass GUCs",
    );
    expect(reset.indexOf('"lab_result_replacements"')).toBeLessThan(
      reset.indexOf('"clinical_record_corrections"'),
    );
  });

  it("seeds a reviewed fresh-value replacement at creation time", () => {
    const seed = read("../../packages/db/seed.ts");

    expect(seed).toContain("Incorrect transcribed value retained");
    expect(seed).not.toContain("Duplicate manual entry retained");
    expect(seed).toContain('const replacementValue = "87"');
    expect(seed).toContain('status: "reviewed"');
    expect(seed).toContain("createdAt: replacementCreatedAt");
    expect(seed).toContain("await db.insert(labResultReplacements).values");
    expect(seed).toContain("Lab results: ${insertedLabResults.length + 1}");
  });
});
