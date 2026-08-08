import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

describe("GET /api/v1/patients/:id canonical identity", () => {
  it("keeps direct and canonical patient reads tenant scoped and active", () => {
    expect(source.match(/eq\(patients\.practiceId, auth\.ctx\.practiceId\)/g))
      .toHaveLength(2);
    expect(source.match(/isNull\(patients\.deletedAt\)/g)).toHaveLength(2);
    expect(source).toContain("await assertActivePractice");
  });

  it("resolves an old source ID through the immutable merge ledger", () => {
    expect(source).toContain("from(patientMergeEvents)");
    expect(source).toContain(
      "eq(patientMergeEvents.practiceId, auth.ctx.practiceId)",
    );
    expect(source).toContain("eq(patientMergeEvents.sourcePatientId, id)");
    expect(source).toContain("eq(patients.id, mergeEvent.targetPatientId)");
  });

  it("returns explicit canonical and merge metadata without changing the patient payload", () => {
    expect(source).toContain("data: toApiPatient(row)");
    expect(source).toContain("requestedPatientId: id");
    expect(source).toContain("canonicalPatientId: row.id");
    expect(source).toContain("mergeMetadata");
  });
});
