import { describe, it, expect } from "vitest";
import { planClientImport, planPatientImport } from "../plan";
import {
  IMPORT_CSV_MAX_BYTES,
  IMPORT_MAX_ROWS,
  csvByteLength,
  isImportCsvSizeValid,
} from "../policy";

describe("import policy", () => {
  it("validates CSV payload size by UTF-8 bytes", () => {
    expect(IMPORT_MAX_ROWS).toBe(10_000);
    expect(IMPORT_CSV_MAX_BYTES).toBe(5_000_000);
    expect(csvByteLength("é")).toBe(2);

    const maxSizedCsv = "a".repeat(IMPORT_CSV_MAX_BYTES);
    expect(isImportCsvSizeValid(maxSizedCsv)).toBe(true);
    expect(isImportCsvSizeValid(`${maxSizedCsv}a`)).toBe(false);
  });
});

describe("planClientImport", () => {
  it("flags existing emails as duplicates (case-insensitive)", () => {
    const records = [{ email: "a@x.com" }, { email: "B@x.com" }, { email: "c@x.com" }];
    const plan = planClientImport(records, new Set(["a@x.com", "b@x.com"]));
    expect(plan).toEqual({ total: 3, duplicates: 2, willInsert: 1 });
  });
  it("treats records without an email as insertable", () => {
    const plan = planClientImport([{}, { email: "new@x.com" }], new Set(["old@x.com"]));
    expect(plan).toEqual({ total: 2, duplicates: 0, willInsert: 2 });
  });

  it("counts duplicate emails inside the import file", () => {
    const records = [{ email: "new@x.com" }, { email: " NEW@x.com " }];
    const plan = planClientImport(records, new Set());
    expect(plan).toEqual({ total: 2, duplicates: 1, willInsert: 1 });
  });
});

describe("planPatientImport", () => {
  it("counts pets whose owner email is missing as unmatched", () => {
    const records = [
      { clientEmail: "owner@x.com" },
      { clientEmail: "ghost@x.com" },
      { clientEmail: "OWNER@x.com" },
    ];
    const plan = planPatientImport(records, new Set(["owner@x.com"]));
    expect(plan).toEqual({ total: 3, unmatchedClient: 1, willInsert: 2 });
  });
  it("all insertable when every owner exists", () => {
    const plan = planPatientImport([{ clientEmail: "a@x.com" }], new Set(["a@x.com"]));
    expect(plan).toEqual({ total: 1, unmatchedClient: 0, willInsert: 1 });
  });
});
