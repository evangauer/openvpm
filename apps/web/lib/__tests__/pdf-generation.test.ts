import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateMedicalSummaryPdf } from "../pdf";

describe("medical summary header", () => {
  const source = readFileSync("lib/pdf.ts", "utf8");

  it("stacks logo, clinic name, then the title so long names cannot collide", () => {
    const headerSection = source.slice(
      source.indexOf("export function generateMedicalSummaryPdf"),
      source.indexOf('sectionHeading("Patient Information")')
    );
    const logoAt = headerSection.indexOf("drawPawMark");
    const nameAt = headerSection.indexOf("splitTextToSize(data.practiceName");
    const titleAt = headerSection.indexOf('"MEDICAL RECORD SUMMARY"');
    expect(logoAt).toBeGreaterThan(-1);
    expect(nameAt).toBeGreaterThan(logoAt);
    expect(titleAt).toBeGreaterThan(nameAt);
    // The title is no longer right-aligned onto the same line as the name.
    expect(headerSection).not.toContain('align: "right"');
  });

  it("renders with a very long clinic name without throwing", () => {
    const doc = generateMedicalSummaryPdf({
      practiceName:
        "Bushwick Veterinary Clinic and Animal Wellness Center of Greater Brooklyn",
      practiceAddress: "123 Knickerbocker Ave, Brooklyn, NY",
      practicePhone: "(555) 000-1234",
      patientName: "Biscuit",
      species: "Canine",
      clientName: "Jordan Avery",
      allergies: [],
      problems: [],
      vaccinations: [{ name: "Rabies", date: "2026-05-01", nextDue: "2027-05-01" }],
      recentNotes: [],
      prescriptions: [],
      generatedDate: "7/11/2026",
    });
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(1);
    expect(doc.output("arraybuffer").byteLength).toBeGreaterThan(1000);
  });

  it("paginates long SOAP sections and addenda while retaining correction evidence", () => {
    const longClinicalText = Array.from(
      { length: 900 },
      (_, index) => `observation-${index}`,
    ).join(" ");
    const doc = generateMedicalSummaryPdf({
      practiceName: "OpenVPM Test Clinic",
      patientName: "Biscuit",
      species: "Canine",
      clientName: "Jordan Avery",
      allergies: [],
      problems: [],
      vaccinations: [],
      recentNotes: [
        {
          date: "August 9, 2026",
          subjective: longClinicalText,
          authorName: "Dr. Rivera",
          finalizerName: "Dr. Rivera",
          finalizedAt: "August 9, 2026 at 10:30 AM",
          addenda: [
            {
              content: longClinicalText,
              authorName: "Dr. Rivera",
              createdAt: "August 9, 2026 at 11:00 AM",
            },
          ],
        },
      ],
      recordCorrections: [
        {
          recordLabel: "SOAP note dated August 8, 2026",
          reason: "Documented on the wrong visit.",
          correctedByName: "Dr. Rivera",
          correctedAt: "August 9, 2026 at 11:30 AM",
        },
      ],
      prescriptions: [],
      generatedDate: "8/9/2026",
    });

    expect(doc.getNumberOfPages()).toBeGreaterThan(2);
    expect(doc.output("arraybuffer").byteLength).toBeGreaterThan(10_000);
  });
});

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
