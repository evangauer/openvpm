import { describe, expect, it } from "vitest";
import { csvToClientRecords, csvToVaccinationRecords, remapRowIssues, rowIssuesCsv, summarizeRowIssues } from "../import";
import { parseCsv } from "../parse";

describe("CSV repair summaries", () => {
  it("counts distinct affected rows, groups issues, and limits the displayed positions", () => {
    const errors = Array.from({ length: 25 }, (_, i) => `Row ${25 - i}: name is required.`);
    errors.push("Row 1: name is required.", "Row 1: owner is missing.", "CSV is missing a species column.");
    const original = [...errors];
    const summary = summarizeRowIssues(errors);
    expect(summary.affectedRows).toBe(25);
    expect(summary.groups[0]).toEqual({ message: "name is required.", count: 25, rows: Array.from({ length: 20 }, (_, i) => i + 1), remaining: 5 });
    expect(summary.groups[1]).toMatchObject({ count: 1, rows: [1] });
    expect(summary.fileIssues).toEqual(["CSV is missing a species column."]);
    expect(errors).toEqual(original);
  });

  it("keeps original positions after rejected rows and blank lines", () => {
    const parsed = csvToClientRecords("First Name,Last Name,Email\nIncomplete,,bad@example.invalid\n\nValid,Owner,valid@example.invalid\nAnother,Owner,another@example.invalid");
    expect(parsed.sourceRows).toEqual([2, 3]);
    expect(remapRowIssues(["Row 1: Skipped a duplicate client.", "Row 2: Review this client.", "File issue"], parsed.sourceRows)).toEqual([
      "Row 2: Skipped a duplicate client.", "Row 3: Review this client.", "File issue",
    ]);
    expect(remapRowIssues(["Row 1: Legacy issue."])).toEqual(["Row 1: Legacy issue."]);
  });

  it("does not treat a warning as a rejected row when mapping later planner errors", () => {
    const parsed = csvToVaccinationRecords("Patient ID,Vaccine Name,Date Given,Next Due Date\npet-1,Rabies,2026-01-01,bad-date\npet-2,Rabies,2026-01-02,2027-01-02");
    expect(parsed.records).toHaveLength(2);
    expect(parsed.sourceRows).toEqual([1, 2]);
    expect(parsed.errors[0]).toContain("the row imports without it");
    expect(remapRowIssues(["Row 2: Patient not found."], parsed.sourceRows)).toEqual(["Row 2: Patient not found."]);
  });

  it("exports only affected source rows with every issue and correct CSV quoting", () => {
    const csv = 'Name,Note\n"Doe, Jane","line one\nline two"\n\nUnaffected,ok\nOther,"She said ""hello"""';
    const report = rowIssuesCsv(csv, ["Row 3: Missing species.", "Row 1: Missing owner.", "Row 3: Check date.", "Row 3: Missing species."]);
    const parsed = parseCsv(report!);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toEqual([
      { "OpenVPM data row": "1", "OpenVPM issues": "Missing owner.", Name: "Doe, Jane", Note: "line one\nline two" },
      { "OpenVPM data row": "3", "OpenVPM issues": "Missing species.; Check date.", Name: "Other", Note: 'She said "hello"' },
    ]);
  });

  it("exports all affected rows even when the summary shows only the first 20", () => {
    const csv = ["Name", ...Array.from({ length: 25 }, (_, i) => `Sample ${i}`)].join("\n");
    const errors = Array.from({ length: 25 }, (_, i) => `Row ${i + 1}: Missing owner.`);
    expect(parseCsv(rowIssuesCsv(csv, errors)!).rows).toHaveLength(25);
  });

  it("neutralizes spreadsheet formulas in values and headers without colliding with source columns", () => {
    const report = rowIssuesCsv('OpenVPM data row,=header,Other\n=CMD(),+123,@SUM(A1)', ["Row 1: =DANGEROUS()"]);
    const parsed = parseCsv(report!);
    expect(parsed.headers).toContain("OpenVPM data row_report");
    expect(parsed.headers).toContain("'=header");
    expect(report).toContain('"1","\'=DANGEROUS()","\'=CMD()","\'+123","\'@SUM(A1)"');
    // Re-import removes the spreadsheet escape without altering source values.
    expect(parsed.rows[0]).toMatchObject({ "OpenVPM data row": "=CMD()", "\'=header": "+123", Other: "@SUM(A1)", "OpenVPM issues": "=DANGEROUS()" });
  });

  it("does not fabricate rows from malformed CSV or invalid row positions", () => {
    expect(rowIssuesCsv('Name\n"unfinished', ["Row 1: Problem."])).toBeNull();
    expect(rowIssuesCsv("Name,Name\na,b", ["Row 1: Problem."])).toBeNull();
    expect(rowIssuesCsv("Name\nSample", ["Row 0: Problem.", "Row 4: Problem.", "File issue"])).toBeNull();
    expect(summarizeRowIssues([])).toEqual({ groups: [], fileIssues: [], affectedRows: 0 });
  });
});
