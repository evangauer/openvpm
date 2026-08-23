import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { buildPatientHistoryQuery } from "../patient-history";

const practiceId = "11111111-1111-4111-8111-111111111111";
const patientId = "22222222-2222-4222-8222-222222222222";

describe("patient history SQL projection", () => {
  it("is explicit, tenant scoped, finalized-SOAP only, and private-surface free", () => {
    const compiled = new PgDialect().sqlToQuery(
      buildPatientHistoryQuery({
        practiceId,
        input: {
          patientId,
          query: String.raw`Carprofen%_\dose`,
          recordTypes: ["soap_note", "prescription"],
          state: "all",
          limit: 25,
        },
      }),
    );

    expect(compiled.sql).toContain('from "soap_notes" soap');
    expect(compiled.sql).toContain("soap.status = 'finalized'");
    expect(compiled.sql).toContain('from "prescriptions" prescription');
    expect(compiled.sql).toContain('from "soap_note_addenda" addendum');
    expect(compiled.sql).toContain(
      'left join "clinical_record_corrections" correction',
    );
    expect(compiled.sql).toContain(
      'left join "soap_note_replacements" source_link',
    );
    expect(compiled.sql).toContain("history.record_type in (");
    expect(compiled.sql).toContain("ilike");
    expect(compiled.sql).toContain("escape '\\'");
    expect(compiled.sql).toContain("string_to_array(page.search_text");
    expect(compiled.sql).toContain("regexp_replace");
    expect(compiled.sql).toContain("strpos(lower(match.line)");
    expect(compiled.sql).toContain("limit 3");
    expect(compiled.sql).toContain(
      "order by matched.occurred_at desc, matched.record_type desc, matched.id desc",
    );
    expect(compiled.sql).not.toContain("clinical_notes");
    expect(compiled.sql).not.toContain("communications");
    expect(compiled.sql).not.toContain("appointment_notes");
    expect(compiled.sql).not.toContain("follow_up_note");
    expect(compiled.sql).not.toContain("follow_up_outcome");
    expect(compiled.sql).not.toContain("prescriber.deleted_at");
    expect(compiled.sql).not.toContain("administrator.deleted_at");
    expect(compiled.sql).not.toContain("ordered_by.deleted_at");
    expect(compiled.sql).not.toContain("performer.deleted_at");
    expect(compiled.sql).not.toContain("recorder.deleted_at");
    expect(compiled.params).toContain(practiceId);
    expect(compiled.params).toContain(patientId);
    expect(compiled.params).toContain(String.raw`%Carprofen\%\_\\dose%`);
    expect(compiled.params).toContain(26);
  });

  it("composes date, correction, and keyset cursor predicates", () => {
    const compiled = new PgDialect().sqlToQuery(
      buildPatientHistoryQuery({
        practiceId,
        input: {
          patientId,
          recordTypes: ["lab_result"],
          state: "corrected",
          fromDate: "2026-03-08",
          toDate: "2026-11-01",
          cursor: {
            occurredAt: "2026-08-20T16:00:00.000Z",
            recordType: "lab_result",
            id: "33333333-3333-4333-8333-333333333333",
          },
          limit: 10,
        },
      }),
    );

    expect(compiled.sql).toContain("history.corrected = true");
    expect(compiled.sql).toContain("history.occurred_date >=");
    expect(compiled.sql).toContain("history.occurred_date <=");
    expect(compiled.sql).toContain(
      "(matched.occurred_at, matched.record_type, matched.id) <",
    );
    expect(compiled.params).toEqual(
      expect.arrayContaining([
        "2026-03-08",
        "2026-11-01",
        "2026-08-20T16:00:00.000Z",
        "lab_result",
        "33333333-3333-4333-8333-333333333333",
        11,
      ]),
    );
  });
});
