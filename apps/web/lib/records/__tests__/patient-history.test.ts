import { describe, expect, it } from "vitest";
import {
  PATIENT_HISTORY_DEFAULT_PAGE_SIZE,
  PATIENT_HISTORY_MAX_PAGE_SIZE,
  PATIENT_HISTORY_QUERY_MAX_LENGTH,
  PATIENT_HISTORY_RECORD_TYPES,
  escapePatientHistoryQuery,
  patientHistoryContainsPattern,
} from "../patient-history";

describe("patient history search policy", () => {
  it("keeps LIKE wildcard and escape characters literal", () => {
    expect(escapePatientHistoryQuery(String.raw`50%_off\plan`)).toBe(
      String.raw`50\%\_off\\plan`,
    );
    expect(patientHistoryContainsPattern(String.raw`  50%_off\plan  `)).toBe(
      String.raw`%50\%\_off\\plan%`,
    );
  });

  it("pins the bounded allowlist and response sizes", () => {
    expect(PATIENT_HISTORY_RECORD_TYPES).toEqual([
      "soap_note",
      "prescription",
      "vaccination",
      "lab_result",
      "procedure",
      "problem",
      "vital_sign",
      "allergy",
    ]);
    expect(PATIENT_HISTORY_QUERY_MAX_LENGTH).toBe(120);
    expect(PATIENT_HISTORY_DEFAULT_PAGE_SIZE).toBe(25);
    expect(PATIENT_HISTORY_MAX_PAGE_SIZE).toBe(50);
  });
});
