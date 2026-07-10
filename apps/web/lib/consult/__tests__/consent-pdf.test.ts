import { describe, expect, it } from "vitest";
import { buildConsentPdf } from "../consent-pdf";
import {
  DEFAULT_CONSENT_BODY,
  DEFAULT_CONSENT_TITLE,
} from "../consent-template";

// 1x1 PNG.
const SIGNATURE_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("buildConsentPdf", () => {
  it("produces a real PDF with the consent copy and signer", () => {
    const pdf = buildConsentPdf({
      practiceName: "Drill Vet",
      patientName: "Peanut",
      title: DEFAULT_CONSENT_TITLE,
      bodyText: DEFAULT_CONSENT_BODY,
      signerName: "Jordan Marsh",
      signedAtIso: "2026-07-10T12:00:00.000Z",
      signaturePngDataUrl: SIGNATURE_DATA_URL,
    });

    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    expect(pdf.length).toBeGreaterThan(1_000);
  });

  it("survives long consent bodies by paginating", () => {
    const longBody = Array.from(
      { length: 200 },
      (_, i) => `Line ${i + 1}: the team explained the plan for my pet.`
    ).join("\n");

    const pdf = buildConsentPdf({
      practiceName: "Drill Vet",
      patientName: "Peanut",
      title: "Long consent",
      bodyText: longBody,
      signerName: "Jordan Marsh",
      signedAtIso: "2026-07-10T12:00:00.000Z",
      signaturePngDataUrl: SIGNATURE_DATA_URL,
    });

    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    // Multiple pages: jspdf writes one /Type /Page object per page.
    const pages = pdf.toString("latin1").match(/\/Type \/Page[^s]/g) ?? [];
    expect(pages.length).toBeGreaterThan(1);
  });

  it("keeps the default template in the product voice", () => {
    expect(DEFAULT_CONSENT_BODY).not.toMatch(/[—–]/);
    expect(DEFAULT_CONSENT_TITLE).not.toMatch(/[—–]/);
  });
});
