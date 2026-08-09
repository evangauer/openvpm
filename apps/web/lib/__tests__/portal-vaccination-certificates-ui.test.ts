import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("portal vaccination certificate UI", () => {
  const source = readFileSync(
    "app/portal/[token]/pets/[petId]/page.tsx",
    "utf8"
  );
  const portalRouter = readFileSync("server/routers/portal.ts", "utf8");

  it("exposes a real certificate download action for portal vaccinations", () => {
    expect(source).toContain("downloadVaccinationCertificate");
    expect(source).toContain("generateVaccinationCertificatePdf");
    expect(source).toContain('import("@/lib/pdf")');
    expect(source).toContain("Certificate");
    expect(source).toContain("Download");
    expect(source).toContain("void downloadVaccinationCertificate(v)");
    expect(source).not.toMatch(/from ["']@\/lib\/pdf["']/);
  });

  it("builds certificates from fresh authorized portal data", () => {
    expect(source).toContain("const petDetail = data");
    expect(source).toContain(
      "utils.portal.getVaccinationCertificateData.fetch"
    );
    expect(source).toContain("{ staleTime: 0 }");
    expect(source).toContain("vaccinationRecordId: vaccination.id");
    expect(source).toContain("practiceName: certificate.practice.name");
    expect(source).toContain(
      "practiceAddress: certificate.practice.address ?? undefined"
    );
    expect(source).toContain("clientName: certificate.clientName");
    expect(source).toContain("patientName: certificate.patient.name");
    expect(source).toContain(
      "vaccineName: certificate.vaccination.vaccineName"
    );
    expect(source).toContain(
      "manufacturer: certificate.vaccination.manufacturer ?? undefined"
    );
    expect(source).toContain(
      "lotNumber: certificate.vaccination.lotNumber ?? undefined"
    );
    expect(source).toContain(
      "generatedDate: formatDate(new Date(), certificateTimeZone)"
    );
    expect(source).toContain("certificate.vaccination.vaccineName");
  });

  it("does not return corrected vaccination data that could mint a certificate", () => {
    expect(portalRouter).toContain(
      "clinical_record_corrections as vaccination_correction"
    );
    expect(portalRouter).toContain(
      "vaccination_correction.vaccination_record_id = ${vaccinationRecords.id}"
    );
    expect(portalRouter).toContain("getVaccinationCertificateData");
    expect(portalRouter).toContain(
      'message: "Vaccination certificate is not available"'
    );
    expect(source).toContain('role="alert"');
    expect(source).toContain("certificatePendingId !== null");
  });
});
