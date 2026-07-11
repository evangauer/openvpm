import { describe, expect, it } from "vitest";
import {
  CONSENT_FILE_CATEGORY,
  PATIENT_PHOTO_CATEGORY,
  patientFileKind,
  patientFileLabel,
} from "../file-kinds";

describe("patientFileKind", () => {
  it("classifies capture photos as photos", () => {
    expect(
      patientFileKind({
        category: PATIENT_PHOTO_CATEGORY,
        mimeType: "image/jpeg",
      })
    ).toBe("photo");
  });

  it("classifies signed consent PDFs as consents, never photos", () => {
    expect(
      patientFileKind({
        category: CONSENT_FILE_CATEGORY,
        mimeType: "application/pdf",
      })
    ).toBe("consent");
  });

  it("keeps consents out of the photo bucket even with an image mime type", () => {
    // Category wins: a consent artifact stored as an image is still a consent.
    expect(
      patientFileKind({ category: CONSENT_FILE_CATEGORY, mimeType: "image/png" })
    ).toBe("consent");
  });

  it("classifies uncategorized images as photos", () => {
    expect(patientFileKind({ category: null, mimeType: "image/webp" })).toBe(
      "photo"
    );
  });

  it("classifies everything else as documents", () => {
    expect(
      patientFileKind({ category: null, mimeType: "application/pdf" })
    ).toBe("document");
    expect(patientFileKind({ category: "misc", mimeType: null })).toBe(
      "document"
    );
  });
});

describe("patientFileLabel", () => {
  it("labels signed consents with what was signed", () => {
    expect(
      patientFileLabel({
        category: CONSENT_FILE_CATEGORY,
        mimeType: "application/pdf",
        fileName: "signed-consent-1a2b3c4d.pdf",
        consentTitle: "Consent to treatment",
      })
    ).toBe("Consent to treatment");
  });

  it("falls back to the file name when there is no consent title", () => {
    expect(
      patientFileLabel({
        category: CONSENT_FILE_CATEGORY,
        mimeType: "application/pdf",
        fileName: "signed-consent-1a2b3c4d.pdf",
        consentTitle: null,
      })
    ).toBe("signed-consent-1a2b3c4d.pdf");
  });

  it("uses the file name for photos and documents", () => {
    expect(
      patientFileLabel({
        category: PATIENT_PHOTO_CATEGORY,
        mimeType: "image/jpeg",
        fileName: "wound-day-3.jpg",
      })
    ).toBe("wound-day-3.jpg");
  });
});
