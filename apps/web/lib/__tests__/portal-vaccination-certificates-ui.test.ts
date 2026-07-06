import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("portal vaccination certificate UI", () => {
  const source = readFileSync(
    "app/portal/[token]/pets/[petId]/page.tsx",
    "utf8"
  );

  it("exposes a real certificate download action for portal vaccinations", () => {
    expect(source).toContain("downloadVaccinationCertificate");
    expect(source).toContain("generateVaccinationCertificatePdf");
    expect(source).toContain('import("@/lib/pdf")');
    expect(source).toContain("Certificate");
    expect(source).toContain("Download");
    expect(source).toContain(
      "onClick={() => void downloadVaccinationCertificate(v)}"
    );
    expect(source).not.toMatch(/from ["']@\/lib\/pdf["']/);
  });

  it("builds certificates from authorized portal pet-detail data", () => {
    expect(source).toContain("const petDetail = data");
    expect(source).toContain("practiceName: petDetail.practice.name");
    expect(source).toContain("practiceAddress: petDetail.practice.address ?? undefined");
    expect(source).toContain("clientName: petDetail.clientName");
    expect(source).toContain("patientName: petDetail.name");
    expect(source).toContain("vaccineName: vaccination.vaccineName");
    expect(source).toContain("manufacturer: vaccination.manufacturer ?? undefined");
    expect(source).toContain("lotNumber: vaccination.lotNumber ?? undefined");
    expect(source).toContain("generatedDate: formatDate(new Date(), practiceTimeZone)");
    expect(source).toContain(
      "certificateFilename(petDetail.name, vaccination.vaccineName)"
    );
  });
});
