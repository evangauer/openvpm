import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  buildConsentPdf,
  buildConsentPdfForVersion,
  buildConsentPdfV1,
  CONSENT_PDF_RENDERER_V1,
  CONSENT_PDF_RENDERER_V2,
  consentSignaturePngDecodes,
} from "../consent-pdf";
import {
  CONSENT_ELECTRONIC_SIGNATURE_INTENT,
  CONSENT_SIGNER_AUTHORITY_ATTESTATION,
  DEFAULT_CONSENT_BODY,
  DEFAULT_CONSENT_TITLE,
} from "../consent-template";

// 1x1 PNG.
const SIGNATURE_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const DOCUMENT_ID = "00000000-0000-0000-0000-000000000005";

function consentInput() {
  return {
    documentId: DOCUMENT_ID,
    practiceId: "00000000-0000-0000-0000-000000000001",
    patientId: "00000000-0000-0000-0000-000000000002",
    title: DEFAULT_CONSENT_TITLE,
    bodyText: DEFAULT_CONSENT_BODY,
    signerName: "Jordan Marsh",
    signerAttestation: `${CONSENT_SIGNER_AUTHORITY_ATTESTATION} ${CONSENT_ELECTRONIC_SIGNATURE_INTENT}`,
    signedAtIso: "2026-07-10T12:00:00.000Z",
    signaturePngDataUrl: SIGNATURE_DATA_URL,
  };
}

describe("buildConsentPdf", () => {
  it("produces a real PDF with the consent copy and signer", () => {
    const pdf = buildConsentPdf(consentInput());

    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    expect(pdf.length).toBeGreaterThan(1_000);
  });

  it("survives long consent bodies by paginating", () => {
    const longBody = Array.from(
      { length: 200 },
      (_, i) => `Line ${i + 1}: the team explained the plan for my pet.`,
    ).join("\n");

    const pdf = buildConsentPdf({
      ...consentInput(),
      bodyText: longBody,
      title: "Long consent",
    });

    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    // Multiple pages: jspdf writes one /Type /Page object per page.
    const pages = pdf.toString("latin1").match(/\/Type \/Page[^s]/g) ?? [];
    expect(pages.length).toBeGreaterThan(1);
  });

  it("renders identical bytes for the same persisted signing metadata", () => {
    expect(buildConsentPdf(consentInput())).toEqual(
      buildConsentPdf(consentInput()),
    );
  });

  it("freezes the pre-attestation v1 bytes for existing reservations", () => {
    const input = consentInput();
    const legacy = buildConsentPdfV1(input);

    expect(legacy).toEqual(
      buildConsentPdfForVersion(CONSENT_PDF_RENDERER_V1, input),
    );
    expect(createHash("sha256").update(legacy).digest("hex")).toBe(
      "dc113f9150853453a27fca6be7296fa43defa55c0ab4d5c53380636468efd466",
    );
    expect(
      buildConsentPdfForVersion(CONSENT_PDF_RENDERER_V2, input),
    ).not.toEqual(legacy);
  });

  it("fully decodes PNG chunks before signature evidence is claimed", () => {
    expect(consentSignaturePngDecodes(SIGNATURE_DATA_URL)).toBe(true);

    const corrupt = Buffer.from(
      SIGNATURE_DATA_URL.slice("data:image/png;base64,".length),
      "base64",
    );
    corrupt[40] = corrupt[40]! ^ 1;
    expect(
      consentSignaturePngDecodes(
        `data:image/png;base64,${corrupt.toString("base64")}`,
      ),
    ).toBe(false);
    expect(
      consentSignaturePngDecodes(
        `data:image/png;base64,${corrupt.subarray(0, 40).toString("base64")}`,
      ),
    ).toBe(false);
  });

  it("keeps the default template in the product voice", () => {
    expect(DEFAULT_CONSENT_BODY).not.toMatch(/[—–]/);
    expect(DEFAULT_CONSENT_TITLE).not.toMatch(/[—–]/);
  });
});
