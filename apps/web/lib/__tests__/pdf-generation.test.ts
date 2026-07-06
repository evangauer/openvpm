import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("pdf generation date labels", () => {
  const source = readFileSync("lib/pdf.ts", "utf8");

  it("uses caller-provided generated dates for medical summaries", () => {
    expect(source).toContain("generatedDate?: string;");
    expect(source).toContain("function formatGeneratedDateUtc()");
    expect(source).toContain(
      'return new Date().toLocaleDateString("en-US", { timeZone: "UTC" })'
    );
    expect(source).toContain(
      "const generatedDate = data.generatedDate ?? formatGeneratedDateUtc()"
    );
    expect(source).toContain("`Generated on ${generatedDate}");
    expect(source).not.toContain("const today = new Date().toLocaleDateString()");
  });

  it("generates vaccination certificates with caller-provided date labels", () => {
    expect(source).toContain("export interface VaccinationCertificateData");
    expect(source).toContain("export function generateVaccinationCertificatePdf");
    expect(source).toContain("VACCINATION CERTIFICATE");
    expect(source).toContain("[\"Vaccine\", data.vaccineName]");
    expect(source).toContain("[\"Administered\", data.administeredAt]");
    expect(source).toContain("[\"Next due\", data.nextDueDate]");
    expect(source).toContain("[\"Manufacturer\", data.manufacturer]");
    expect(source).toContain("[\"Lot number\", data.lotNumber]");
    expect(source).toContain(
      "const generatedDate = data.generatedDate ?? formatGeneratedDateUtc()"
    );
  });

  it("generates generic tabular report PDFs", () => {
    expect(source).toContain("export interface ReportPdfData");
    expect(source).toContain("export function generateReportPdf");
    expect(source).toContain(
      'orientation: data.columns.length > 4 ? "landscape" : "portrait"'
    );
    expect(source).toContain("data.columns.forEach((column, index) =>");
    expect(source).toContain(
      'doc.text(data.emptyMessage ?? "No report data available.", margin, y)'
    );
    expect(source).toContain("doc.text(`Page ${i} of ${pageCount}`");
  });
});
