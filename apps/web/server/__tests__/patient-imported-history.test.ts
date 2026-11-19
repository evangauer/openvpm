import { readFileSync } from "node:fs";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  IMPORTED_PRESCRIPTION_SAFETY,
  IMPORTED_VISIT_SAFETY,
  importedDocumentFilter,
  importedLabReportFilter,
  importedPrescriptionFilter,
  importedVisitFilter,
} from "../patient-imported-history";

const practiceId = "11111111-1111-4111-8111-111111111111";
const otherPracticeId = "99999999-9999-4999-8999-999999999999";
const patientId = "22222222-2222-4222-8222-222222222222";

function compiled(filter: ReturnType<typeof importedVisitFilter>) {
  return new PgDialect().sqlToQuery(filter!);
}

describe("imported patient history filters", () => {
  it("links visits only by practice and source identity", () => {
    const query = compiled(importedVisitFilter(practiceId, patientId));
    expect(query.sql).toContain('"historical_appointments"."practice_id"');
    expect(query.sql).toContain('"patients"."practice_id"');
    expect(query.sql).toContain('"patients"."external_id" is not null');
    expect(query.sql).toContain(
      '"patients"."external_source" = "historical_appointments"."external_source"',
    );
    expect(query.params).toContain(practiceId);
    expect(query.params).toContain(patientId);
    expect(query.params).not.toContain(otherPracticeId);
    expect(query.sql).not.toContain("legacy_financial");
    expect(query.sql).not.toMatch(/from "appointments"/);
  });

  it("keeps unlinked labs and financial documents off the chart", () => {
    const labs = compiled(importedLabReportFilter(practiceId, patientId));
    expect(labs.sql).toContain(`"external_lab_reports"."attribution_status" =`);
    expect(labs.params).toContain("matched");
    expect(labs.sql).toContain('"patients"."external_source"');

    const documents = compiled(importedDocumentFilter(practiceId, patientId));
    expect(documents.sql).toContain('"historical_documents"."link_status"');
    expect(documents.params).toContain("linked");
    expect(documents.sql).toContain('"historical_documents"."kind"');
    expect(documents.params).toContain("financial");

    const medications = compiled(importedPrescriptionFilter(practiceId, patientId));
    expect(medications.sql).toContain('"external_prescriptions"."practice_id"');
    expect(medications.sql).not.toMatch(/from "prescriptions"/);
  });

  it("never marks imported visits or medications as operational", () => {
    expect(IMPORTED_VISIT_SAFETY).toEqual({ createsCalendarWork: false });
    expect(IMPORTED_PRESCRIPTION_SAFETY).toEqual({
      dispensable: false,
      refillable: false,
    });
    const source = readFileSync(
      new URL("../patient-imported-history.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("legacyFinancial");
    expect(source).not.toContain("from(appointments)");
    expect(source).not.toContain("from(prescriptions)");
    expect(source).not.toContain("from(labResults)");
  });
});
