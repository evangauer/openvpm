import { jsPDF } from "jspdf";

/**
 * Composes the signed consent PDF server-side at signing time (the durable
 * artifact stored in the files table). Kept dependency-light: jspdf is
 * already used for invoice/record exports in lib/pdf.ts.
 */

const PAGE_MARGIN = 20; // mm
const PAGE_WIDTH = 210;
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;
const SIGNATURE_WIDTH_MM = 70;
const SIGNATURE_HEIGHT_MM = 26;

export interface ConsentPdfInput {
  practiceName: string;
  patientName: string;
  title: string;
  bodyText: string;
  signerName: string;
  signedAtIso: string;
  /** PNG data URL of the drawn signature. */
  signaturePngDataUrl: string;
}

function ensureSpace(doc: jsPDF, y: number, needed: number): number {
  const pageHeight = doc.internal.pageSize.getHeight();
  if (y + needed > pageHeight - PAGE_MARGIN) {
    doc.addPage();
    return PAGE_MARGIN;
  }
  return y;
}

export function buildConsentPdf(input: ConsentPdfInput): Buffer {
  const doc = new jsPDF();
  let y = PAGE_MARGIN;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.setTextColor(51, 51, 51);
  doc.text(input.title, PAGE_MARGIN, y);
  y += 8;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(102, 102, 102);
  doc.text(
    `${input.practiceName}  ·  Patient: ${input.patientName}`,
    PAGE_MARGIN,
    y
  );
  y += 4;
  doc.setDrawColor(238, 238, 238);
  doc.setLineWidth(0.5);
  doc.line(PAGE_MARGIN, y, PAGE_WIDTH - PAGE_MARGIN, y);
  y += 8;

  doc.setFontSize(11);
  doc.setTextColor(51, 51, 51);
  const lines = doc.splitTextToSize(input.bodyText, CONTENT_WIDTH) as string[];
  for (const line of lines) {
    y = ensureSpace(doc, y, 6);
    doc.text(line, PAGE_MARGIN, y);
    y += 6;
  }

  y = ensureSpace(doc, y + 6, SIGNATURE_HEIGHT_MM + 30);
  y += 6;
  doc.setFontSize(10);
  doc.setTextColor(102, 102, 102);
  doc.text("Signed by", PAGE_MARGIN, y);
  y += 6;

  doc.addImage(
    input.signaturePngDataUrl,
    "PNG",
    PAGE_MARGIN,
    y,
    SIGNATURE_WIDTH_MM,
    SIGNATURE_HEIGHT_MM
  );
  y += SIGNATURE_HEIGHT_MM + 2;
  doc.setDrawColor(102, 102, 102);
  doc.line(PAGE_MARGIN, y, PAGE_MARGIN + SIGNATURE_WIDTH_MM, y);
  y += 6;

  doc.setFontSize(11);
  doc.setTextColor(51, 51, 51);
  doc.text(input.signerName, PAGE_MARGIN, y);
  y += 6;
  doc.setFontSize(10);
  doc.setTextColor(102, 102, 102);
  doc.text(
    `Signed ${new Date(input.signedAtIso).toUTCString()}`,
    PAGE_MARGIN,
    y
  );

  return Buffer.from(doc.output("arraybuffer"));
}
