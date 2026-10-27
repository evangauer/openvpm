import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  generateMedicalSummaryPdf,
  generateRabiesVaccinationCertificatePdf,
  generateVaccinationHistoryCertificatePdf,
} from "../pdf";

describe("medical summary header", () => {
  const source = readFileSync("lib/pdf.ts", "utf8");

  it("stacks logo, clinic name, then the title so long names cannot collide", () => {
    const headerSection = source.slice(
      source.indexOf("export function generateMedicalSummaryPdf"),
      source.indexOf('sectionHeading("Patient Information")'),
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
      vaccinations: [
        { name: "Rabies", date: "2026-05-01", nextDue: "2027-05-01" },
      ],
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

describe("plain-text chart notes in medical summaries", () => {
  const summary = {
    practiceName: "Synthetic Clinic",
    patientName: "Synthetic Cat",
    species: "Feline",
    clientName: "Synthetic Owner",
    allergies: [],
    problems: [],
    vaccinations: [],
    recentNotes: [],
    prescriptions: [],
  };

  it("retains full pasted text and authorship across pages and labels a limited summary", () => {
    const doc = generateMedicalSummaryPdf({
      ...summary,
      chartNotes: {
        items: [
          {
            date: "October 26, 2026 at 10:30 AM",
            type: "Phone call",
            authorName: "Synthetic Doctor",
            content:
              "<script>literal pasted text</script>\n" +
              "Long pasted observation. ".repeat(750) +
              "\nCHART_NOTE_END_MARKER",
          },
        ],
        hasMore: true,
      },
    });
    expect(doc.getNumberOfPages()).toBeGreaterThan(2);
    const output = doc.output();
    expect(output).toContain("<script>literal pasted text</script>");
    expect(output).toContain("Authored by Synthetic Doctor");
    expect(output).toContain("CHART_NOTE_END_MARKER");
    expect(output).toContain("Showing the latest 25 chart notes.");
  });

  it("explicitly identifies summaries that cannot include chart notes", () => {
    expect(
      generateMedicalSummaryPdf({ ...summary, chartNotes: null }).output(),
    ).toContain("Chart notes are not included for this access level.");
  });
});

describe("pdf generation date labels", () => {
  const source = readFileSync("lib/pdf.ts", "utf8");

  it("uses caller-provided generated dates for medical summaries", () => {
    expect(source).toContain("generatedDate?: string;");
    expect(source).toContain("function formatGeneratedDateUtc()");
    expect(source).toContain(
      'return new Date().toLocaleDateString("en-US", { timeZone: "UTC" })',
    );
    expect(source).toContain(
      "const generatedDate = data.generatedDate ?? formatGeneratedDateUtc()",
    );
    expect(source).toContain("`Generated on ${generatedDate}");
    expect(source).not.toContain(
      "const today = new Date().toLocaleDateString()",
    );
  });

  it("generates vaccination certificates with caller-provided date labels", () => {
    expect(source).toContain("export interface VaccinationCertificateData");
    expect(source).toContain(
      "export function generateVaccinationCertificatePdf",
    );
    expect(source).toContain("VACCINATION CERTIFICATE");
    expect(source).toContain('["Vaccine", data.vaccineName]');
    expect(source).toContain('["Administered", data.administeredAt]');
    expect(source).toContain('["Next due", data.nextDueDate]');
    expect(source).toContain('["Manufacturer", data.manufacturer]');
    expect(source).toContain('["Lot number", data.lotNumber]');
    expect(source).toContain(
      "const generatedDate = data.generatedDate ?? formatGeneratedDateUtc()",
    );
  });

  it("generates generic tabular report PDFs", () => {
    expect(source).toContain("export interface ReportPdfData");
    expect(source).toContain("export function generateReportPdf");
    expect(source).toContain(
      'orientation: data.columns.length > 4 ? "landscape" : "portrait"',
    );
    expect(source).toContain("data.columns.forEach((column, index) =>");
    expect(source).toContain(
      'doc.text(data.emptyMessage ?? "No report data available.", margin, y)',
    );
    expect(source).toContain("doc.text(`Page ${i} of ${pageCount}`");
  });
});

describe("staff vaccination certificate PDFs", () => {
  const identity = {
    certificateId: "00000000-0000-0000-0000-000000000001",
    generatedDate: "Aug 24, 2026",
    practice: {
      name: "Neighborhood Veterinary",
      address: "100 Clinic Way, Brooklyn, NY",
      phone: "555-0100",
      email: "care@example.test",
    },
    owner: {
      name: "Alex Rivera",
      address: "10 Main Street\nBrooklyn, NY, 11201",
      phone: "555-0102",
    },
    patient: {
      name: "Biscuit",
      species: "Canine",
      breed: "Mixed breed",
      sex: "Female (Spayed)",
      dob: "May 1, 2020",
      color: "Brown",
      microchipNumber: "985141000000001",
      weightKg: "18.250",
    },
  };

  it("renders a multi-page vaccination history with certificate identity", () => {
    const doc = generateVaccinationHistoryCertificatePdf({
      ...identity,
      vaccinations: Array.from({ length: 60 }, (_, index) => ({
        vaccineName: `Vaccination ${index + 1}`,
        productName: `Product ${index + 1}`,
        administeredAt: "Aug 24, 2026",
        nextDueDate: "Aug 24, 2027",
        lotNumber: `LOT-${index + 1}`,
        administeredByName: "Dr. Rivera",
      })),
    });

    expect(doc.getNumberOfPages()).toBeGreaterThan(1);
    expect(doc.output("arraybuffer").byteLength).toBeGreaterThan(10_000);
  });

  it("renders all required routine rabies evidence and a wet-signature line", () => {
    const doc = generateRabiesVaccinationCertificatePdf({
      ...identity,
      vaccination: {
        vaccineName: "Rabies",
        productName: "Defensor 3",
        manufacturer: "Zoetis",
        lotNumber: "LOT-123",
        productExpirationDate: "May 1, 2027",
        doseType: "booster",
        licensedDurationMonths: 36,
        rabiesTagNumber: "TAG-42",
        administeredAt: "Aug 24, 2026",
        nextDueDate: "Aug 24, 2029",
        administeredByName: "Taylor Tech",
        veterinarianName: "Dr. Rivera",
        veterinarianLicenseNumber: "NY-12345",
      },
    });

    expect(doc.getNumberOfPages()).toBe(1);
    expect(doc.output("arraybuffer").byteLength).toBeGreaterThan(4_000);
    const source = readFileSync("lib/pdf.ts", "utf8");
    expect(source).toContain("Veterinarian signature");
    expect(source).toContain(
      "Routine vaccination record — not a travel health certificate",
    );
    expect(source).toContain("Certificate ID: ${data.certificateId}");
  });
});
