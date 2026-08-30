import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const patientPage = readFileSync(
  "app/(dashboard)/patients/[id]/page.tsx",
  "utf8",
);
const recordsPage = readFileSync("app/(dashboard)/records/page.tsx", "utf8");
const vaccinationForm = readFileSync(
  "components/records/vaccination-form-fields.tsx",
  "utf8",
);
const router = readFileSync("server/routers/records.ts", "utf8");

describe("staff vaccination certificates", () => {
  it("prepares fresh server-authorized data before lazily loading PDF code", () => {
    const downloadSection = patientPage.slice(
      patientPage.indexOf("async function downloadCertificate"),
      patientPage.indexOf(
        "if (error)",
        patientPage.indexOf("async function downloadCertificate"),
      ),
    );
    const prepareAt = downloadSection.indexOf("prepareCertificate.mutateAsync");
    const readyAt = downloadSection.indexOf("if (!certificate.ready)");
    const importAt = downloadSection.indexOf('await import("@/lib/pdf")');
    expect(prepareAt).toBeGreaterThan(0);
    expect(readyAt).toBeGreaterThan(prepareAt);
    expect(importAt).toBeGreaterThan(readyAt);
    expect(downloadSection).not.toMatch(/from ["']@\/lib\/pdf["']/);
    expect(downloadSection).not.toContain("crypto.randomUUID()");
    expect(downloadSection).toContain(
      "generateVaccinationHistoryCertificatePdf",
    );
    expect(downloadSection).toContain(
      "generateRabiesVaccinationCertificatePdf",
    );
  });

  it("fails rabies issuance closed and excludes corrected records", () => {
    expect(router).toContain("prepareVaccinationCertificate");
    expect(router).toContain("ready: warnings.length === 0");
    expect(router).toContain('warnings.push("owner address")');
    expect(router).toContain('warnings.push("microchip or rabies tag number")');
    expect(router).toContain('warnings.push("current patient weight")');
    expect(router).toContain('warnings.push("veterinarian license number")');
    expect(router).toContain("isNull(clinicalRecordCorrections.id)");
    expect(router).toContain("const certificateId = randomUUID()");
    expect(router).toContain('action: "vaccination_certificate_prepared"');
    expect(router).toContain("vaccinationRecordIds:");
    expect(patientPage).toContain("Complete these details before issuing");
  });

  it("requires audited reasons for certificate-detail corrections", () => {
    const updateSection = router.slice(
      router.indexOf("updateVaccinationCertificateDetails"),
      router.indexOf("prepareVaccinationCertificate"),
    );
    expect(router).toContain("updateVaccinationCertificateDetails");
    expect(updateSection).toContain("app.vaccination_certificate_actor_id");
    expect(updateSection).toContain("app.vaccination_certificate_reason");
    expect(updateSection).toContain("app.vaccination_certificate_ip");
    expect(router).toContain("expectedUpdatedAt");
    expect(updateSection).toContain("notExists(");
    expect(updateSection).toContain('.for("update")');
    expect(updateSection).toContain("assertVaccinationDateOrder(");
    expect(updateSection).not.toContain(".leftJoin(");
    expect(updateSection).not.toContain(
      "eq(vaccinationRecords.updatedAt, current.updatedAt)",
    );
    expect(patientPage).toContain(
      "Reason for change (required, at least 10 characters)",
    );
    expect(patientPage).toContain("Save audited changes");
  });

  it("captures complete rabies product and veterinarian details at entry", () => {
    expect(recordsPage).toContain("isVaccinationFormValid(vaccinationForm)");
    expect(vaccinationForm).toContain("Product expiration *");
    expect(vaccinationForm).toContain("Dose type *");
    expect(vaccinationForm).toContain("Licensed duration *");
    expect(vaccinationForm).toContain("Supervising veterinarian *");
    expect(vaccinationForm).toContain("license missing");
    expect(vaccinationForm).toContain("Boolean(form.nextDueDate)");
  });
});
