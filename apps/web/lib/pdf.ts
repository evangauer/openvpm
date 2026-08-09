import jsPDF from "jspdf";
import { soapSectionText } from "@/lib/records/soap-content";

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const COLOR_TEAL = "#0d9488";
const COLOR_DARK = "#333333";
const COLOR_GRAY = "#666666";
const COLOR_LIGHT_GRAY = "#eeeeee";
const FONT = "helvetica";
const PAGE_MARGIN = 20; // mm
const PAGE_WIDTH = 210; // A4 / letter approximate usable width
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.substring(0, 2), 16),
    parseInt(h.substring(2, 4), 16),
    parseInt(h.substring(4, 6), 16),
  ];
}

function setColor(doc: jsPDF, hex: string) {
  const [r, g, b] = hexToRgb(hex);
  doc.setTextColor(r, g, b);
}

function drawLine(doc: jsPDF, y: number) {
  const [r, g, b] = hexToRgb(COLOR_LIGHT_GRAY);
  doc.setDrawColor(r, g, b);
  doc.setLineWidth(0.5);
  doc.line(PAGE_MARGIN, y, PAGE_WIDTH - PAGE_MARGIN, y);
}

/**
 * Check remaining space on page; add a new page if needed.
 * Returns the (potentially reset) y position.
 */
function ensureSpace(doc: jsPDF, y: number, needed: number): number {
  const pageHeight = doc.internal.pageSize.getHeight();
  if (y + needed > pageHeight - 20) {
    doc.addPage();
    return PAGE_MARGIN;
  }
  return y;
}

function formatGeneratedDateUtc(): string {
  return new Date().toLocaleDateString("en-US", { timeZone: "UTC" });
}

/**
 * Brand mark: a white paw print on a teal rounded square, drawn with
 * primitives so PDFs need no image asset. Matches the in-app brand color.
 */
function drawPawMark(doc: jsPDF, x: number, y: number, size: number) {
  const [r, g, b] = hexToRgb(COLOR_TEAL);
  doc.setFillColor(r, g, b);
  doc.roundedRect(x, y, size, size, size * 0.22, size * 0.22, "F");

  doc.setFillColor(255, 255, 255);
  const cx = x + size / 2;
  const s = size / 12;
  // Main pad
  doc.ellipse(cx, y + 7.7 * s, 2.7 * s, 2.2 * s, "F");
  // Four toes
  doc.circle(cx - 3.3 * s, y + 4.7 * s, 1.15 * s, "F");
  doc.circle(cx - 1.15 * s, y + 3.5 * s, 1.15 * s, "F");
  doc.circle(cx + 1.15 * s, y + 3.5 * s, 1.15 * s, "F");
  doc.circle(cx + 3.3 * s, y + 4.7 * s, 1.15 * s, "F");
}

// ---------------------------------------------------------------------------
// 1. Invoice PDF
// ---------------------------------------------------------------------------

export interface InvoiceData {
  practiceName: string;
  practiceAddress?: string;
  practicePhone?: string;
  practiceEmail?: string;
  clientName: string;
  clientEmail?: string;
  clientAddress?: string;
  patientName?: string;
  invoiceDate: string;
  dueDate?: string;
  status: string;
  items: Array<{
    description: string;
    quantity: number;
    unitPrice: string;
    total: string;
  }>;
  subtotal: string;
  tax: string;
  total: string;
  paidAmount: string;
  /** Pre-formatted balance due (region-aware currency). Falls back to total − paid. */
  balanceDue?: string;
}

export function generateInvoicePdf(data: InvoiceData): jsPDF {
  const doc = new jsPDF();
  let y = PAGE_MARGIN;

  // --- Header: Practice info -------------------------------------------------
  doc.setFont(FONT, "bold");
  doc.setFontSize(20);
  setColor(doc, COLOR_TEAL);
  doc.text(data.practiceName, PAGE_MARGIN, y);
  y += 7;

  doc.setFont(FONT, "normal");
  doc.setFontSize(9);
  setColor(doc, COLOR_GRAY);
  if (data.practiceAddress) {
    doc.text(data.practiceAddress, PAGE_MARGIN, y);
    y += 4;
  }
  if (data.practicePhone) {
    doc.text(data.practicePhone, PAGE_MARGIN, y);
    y += 4;
  }
  if (data.practiceEmail) {
    doc.text(data.practiceEmail, PAGE_MARGIN, y);
    y += 4;
  }

  // --- INVOICE title (right-aligned) -----------------------------------------
  doc.setFont(FONT, "bold");
  doc.setFontSize(28);
  setColor(doc, COLOR_DARK);
  doc.text("INVOICE", PAGE_WIDTH - PAGE_MARGIN, PAGE_MARGIN, {
    align: "right",
  });

  // Status badge
  doc.setFontSize(10);
  const statusLabel = data.status.toUpperCase();
  const statusWidth = doc.getTextWidth(statusLabel) + 8;
  const statusX = PAGE_WIDTH - PAGE_MARGIN - statusWidth;
  const statusY = PAGE_MARGIN + 6;
  const [tr, tg, tb] = hexToRgb(COLOR_TEAL);
  doc.setFillColor(tr, tg, tb);
  doc.roundedRect(statusX, statusY, statusWidth, 7, 1, 1, "F");
  doc.setTextColor(255, 255, 255);
  doc.text(statusLabel, statusX + statusWidth / 2, statusY + 5, {
    align: "center",
  });

  // Date info right side
  setColor(doc, COLOR_GRAY);
  doc.setFont(FONT, "normal");
  doc.setFontSize(9);
  let dateY = statusY + 12;
  doc.text(`Date: ${data.invoiceDate}`, PAGE_WIDTH - PAGE_MARGIN, dateY, {
    align: "right",
  });
  if (data.dueDate) {
    dateY += 4;
    doc.text(`Due: ${data.dueDate}`, PAGE_WIDTH - PAGE_MARGIN, dateY, {
      align: "right",
    });
  }

  y = Math.max(y, dateY) + 8;
  drawLine(doc, y);
  y += 8;

  // --- Bill To ---------------------------------------------------------------
  doc.setFont(FONT, "bold");
  doc.setFontSize(10);
  setColor(doc, COLOR_DARK);
  doc.text("BILL TO", PAGE_MARGIN, y);
  y += 5;

  doc.setFont(FONT, "normal");
  doc.setFontSize(10);
  setColor(doc, COLOR_GRAY);
  doc.text(data.clientName, PAGE_MARGIN, y);
  y += 5;
  if (data.clientAddress) {
    doc.text(data.clientAddress, PAGE_MARGIN, y);
    y += 5;
  }
  if (data.clientEmail) {
    doc.text(data.clientEmail, PAGE_MARGIN, y);
    y += 5;
  }
  if (data.patientName) {
    y += 2;
    doc.setFont(FONT, "italic");
    setColor(doc, COLOR_DARK);
    doc.text(`Patient: ${data.patientName}`, PAGE_MARGIN, y);
    y += 5;
  }

  y += 6;

  // --- Line Items Table ------------------------------------------------------
  const colX = {
    desc: PAGE_MARGIN,
    qty: PAGE_MARGIN + CONTENT_WIDTH * 0.55,
    unit: PAGE_MARGIN + CONTENT_WIDTH * 0.7,
    total: PAGE_WIDTH - PAGE_MARGIN,
  };

  // Table header
  const [lr, lg, lb] = hexToRgb(COLOR_LIGHT_GRAY);
  doc.setFillColor(lr, lg, lb);
  doc.rect(PAGE_MARGIN, y - 4, CONTENT_WIDTH, 8, "F");
  doc.setFont(FONT, "bold");
  doc.setFontSize(9);
  setColor(doc, COLOR_DARK);
  doc.text("Description", colX.desc + 2, y);
  doc.text("Qty", colX.qty, y, { align: "center" });
  doc.text("Unit Price", colX.unit, y, { align: "center" });
  doc.text("Total", colX.total - 2, y, { align: "right" });
  y += 8;

  // Table rows
  doc.setFont(FONT, "normal");
  doc.setFontSize(9);
  setColor(doc, COLOR_DARK);
  for (const item of data.items) {
    y = ensureSpace(doc, y, 8);
    doc.text(item.description, colX.desc + 2, y);
    doc.text(String(item.quantity), colX.qty, y, { align: "center" });
    doc.text(item.unitPrice, colX.unit, y, { align: "center" });
    doc.text(item.total, colX.total - 2, y, { align: "right" });
    y += 6;
  }

  y += 4;
  drawLine(doc, y);
  y += 8;

  // --- Totals ----------------------------------------------------------------
  const totalsX = PAGE_WIDTH - PAGE_MARGIN - 60;
  const totalsValX = PAGE_WIDTH - PAGE_MARGIN;

  doc.setFont(FONT, "normal");
  doc.setFontSize(10);
  setColor(doc, COLOR_GRAY);

  doc.text("Subtotal:", totalsX, y);
  doc.text(data.subtotal, totalsValX, y, { align: "right" });
  y += 6;

  doc.text("Tax:", totalsX, y);
  doc.text(data.tax, totalsValX, y, { align: "right" });
  y += 6;

  drawLine(doc, y);
  y += 6;

  doc.setFont(FONT, "bold");
  doc.setFontSize(12);
  setColor(doc, COLOR_DARK);
  doc.text("Total:", totalsX, y);
  doc.text(data.total, totalsValX, y, { align: "right" });
  y += 7;

  doc.setFont(FONT, "normal");
  doc.setFontSize(10);
  setColor(doc, COLOR_GRAY);
  doc.text("Paid:", totalsX, y);
  doc.text(data.paidAmount, totalsValX, y, { align: "right" });
  y += 6;

  // Balance due — prefer the caller's region-formatted value; otherwise derive
  // it from total − paid (legacy callers without a currency context).
  const balanceParts = [data.total, data.paidAmount].map((v) =>
    parseFloat(v.replace(/[^0-9.-]/g, ""))
  );
  const balance =
    data.balanceDue ?? `$${(balanceParts[0]! - balanceParts[1]!).toFixed(2)}`;
  doc.setFont(FONT, "bold");
  setColor(doc, COLOR_TEAL);
  doc.text("Balance Due:", totalsX, y);
  doc.text(balance, totalsValX, y, { align: "right" });

  // --- Footer ----------------------------------------------------------------
  const pageHeight = doc.internal.pageSize.getHeight();
  doc.setFont(FONT, "italic");
  doc.setFontSize(9);
  setColor(doc, COLOR_GRAY);
  doc.text(
    "Thank you for trusting us with your pet's care",
    PAGE_WIDTH / 2,
    pageHeight - 15,
    { align: "center" }
  );

  return doc;
}

// ---------------------------------------------------------------------------
// 2. Prescription Label PDF
// ---------------------------------------------------------------------------

export interface PrescriptionLabelData {
  practiceName: string;
  practicePhone?: string;
  patientName: string;
  clientName: string;
  species: string;
  medicationName: string;
  dosage: string;
  frequency: string;
  instructions?: string;
  prescribedBy: string;
  startDate: string;
  quantity?: string;
  refillsRemaining?: number;
}

export function generatePrescriptionLabelPdf(
  data: PrescriptionLabelData
): jsPDF {
  // 4" x 2" landscape at 72 DPI  ➜  288 x 144 points
  const doc = new jsPDF({ format: [144, 288], orientation: "landscape" });

  // Convert points to mm for internal use (1 pt = 0.3528 mm)
  const W = 288 * 0.3528; // ~101.6 mm
  const H = 144 * 0.3528; // ~50.8 mm
  const M = 4; // margin in mm
  let y = M + 3;

  // Practice info
  doc.setFont(FONT, "bold");
  doc.setFontSize(9);
  setColor(doc, COLOR_TEAL);
  doc.text(data.practiceName, W / 2, y, { align: "center" });
  y += 3.5;

  if (data.practicePhone) {
    doc.setFont(FONT, "normal");
    doc.setFontSize(7);
    setColor(doc, COLOR_GRAY);
    doc.text(data.practicePhone, W / 2, y, { align: "center" });
    y += 3;
  }

  // Divider
  const [lr, lg, lb] = hexToRgb(COLOR_LIGHT_GRAY);
  doc.setDrawColor(lr, lg, lb);
  doc.setLineWidth(0.3);
  doc.line(M, y, W - M, y);
  y += 3;

  // Patient / Client
  doc.setFont(FONT, "normal");
  doc.setFontSize(7);
  setColor(doc, COLOR_DARK);
  doc.text(`Patient: ${data.patientName} (${data.species})`, M, y);
  doc.text(`Owner: ${data.clientName}`, W - M, y, { align: "right" });
  y += 4;

  // Medication (bold, larger)
  doc.setFont(FONT, "bold");
  doc.setFontSize(10);
  setColor(doc, COLOR_DARK);
  doc.text(data.medicationName, M, y);
  y += 4;

  // Dosage & frequency
  doc.setFontSize(8);
  doc.text(`${data.dosage}  —  ${data.frequency}`, M, y);
  y += 4;

  // Instructions
  if (data.instructions) {
    doc.setFont(FONT, "normal");
    doc.setFontSize(7);
    setColor(doc, COLOR_DARK);
    const lines = doc.splitTextToSize(data.instructions, W - M * 2);
    doc.text(lines, M, y);
    y += lines.length * 3;
  }

  y += 1;

  // Prescriber & date
  doc.setFont(FONT, "normal");
  doc.setFontSize(6.5);
  setColor(doc, COLOR_GRAY);
  doc.text(`Prescribed by: ${data.prescribedBy}`, M, y);
  doc.text(`Date: ${data.startDate}`, W - M, y, { align: "right" });
  y += 3;

  // Quantity & refills
  const extras: string[] = [];
  if (data.quantity) extras.push(`Qty: ${data.quantity}`);
  if (data.refillsRemaining !== undefined)
    extras.push(`Refills: ${data.refillsRemaining}`);
  if (extras.length > 0) {
    doc.text(extras.join("   |   "), M, y);
  }

  return doc;
}

// ---------------------------------------------------------------------------
// 3. Medical Record Summary PDF
// ---------------------------------------------------------------------------

export interface MedicalSummaryData {
  practiceName: string;
  practiceAddress?: string;
  practicePhone?: string;
  patientName: string;
  species: string;
  breed?: string;
  sex?: string;
  dob?: string;
  color?: string;
  microchip?: string;
  clientName: string;
  clientPhone?: string;
  clientEmail?: string;
  allergies: Array<{ allergen: string; severity: string }>;
  problems: Array<{ description: string; status: string; onsetDate?: string }>;
  vaccinations: Array<{ name: string; date: string; nextDue?: string }>;
  recentNotes: Array<{
    date: string;
    subjective?: string;
    objective?: string;
    assessment?: string;
    plan?: string;
    imported?: boolean;
    authorName?: string;
    finalizerName?: string;
    finalizedAt?: string;
    replacementForLabel?: string;
    addenda?: Array<{ content: string; authorName: string; createdAt: string }>;
  }>;
  recordCorrections?: Array<{
    recordLabel: string;
    reason: string;
    correctedByName: string;
    correctedAt: string;
    replacementLabel?: string;
  }>;
  prescriptions: Array<{
    medication: string;
    dosage: string;
    frequency: string;
    status: string;
  }>;
  generatedDate?: string;
}

export function generateMedicalSummaryPdf(data: MedicalSummaryData): jsPDF {
  const doc = new jsPDF();
  let y = PAGE_MARGIN;

  function writeWrappedText(
    value: string,
    x: number,
    width: number,
    lineHeight = 4,
  ) {
    const lines = doc.splitTextToSize(value, width) as string[];
    for (const line of lines) {
      y = ensureSpace(doc, y, lineHeight + 1);
      doc.text(line, x, y);
      y += lineHeight;
    }
  }

  // ---- Helper: section heading ---------------------------------------------
  function sectionHeading(title: string) {
    y = ensureSpace(doc, y, 16);
    y += 4;
    doc.setFont(FONT, "bold");
    doc.setFontSize(12);
    setColor(doc, COLOR_TEAL);
    doc.text(title, PAGE_MARGIN, y);
    y += 2;
    const [r, g, b] = hexToRgb(COLOR_TEAL);
    doc.setDrawColor(r, g, b);
    doc.setLineWidth(0.5);
    doc.line(PAGE_MARGIN, y, PAGE_WIDTH - PAGE_MARGIN, y);
    y += 6;
  }

  // ---- Header ---------------------------------------------------------------
  // Stacked top to bottom (logo, clinic name, document title) so any
  // clinic-name length fits without colliding with the title.
  const logoSize = 12;
  drawPawMark(doc, PAGE_MARGIN, y, logoSize);
  y += logoSize + 8;

  doc.setFont(FONT, "bold");
  doc.setFontSize(20);
  setColor(doc, COLOR_TEAL);
  const nameLines = doc.splitTextToSize(data.practiceName, CONTENT_WIDTH);
  doc.text(nameLines, PAGE_MARGIN, y);
  y += nameLines.length * 8;

  doc.setFont(FONT, "normal");
  doc.setFontSize(9);
  setColor(doc, COLOR_GRAY);
  if (data.practiceAddress) {
    doc.text(data.practiceAddress, PAGE_MARGIN, y);
    y += 4;
  }
  if (data.practicePhone) {
    doc.text(data.practicePhone, PAGE_MARGIN, y);
    y += 4;
  }
  y += 4;

  doc.setFont(FONT, "bold");
  doc.setFontSize(16);
  setColor(doc, COLOR_DARK);
  doc.text("MEDICAL RECORD SUMMARY", PAGE_MARGIN, y);

  y += 3;
  drawLine(doc, y);
  y += 8;

  // ---- Patient Info ---------------------------------------------------------
  sectionHeading("Patient Information");

  doc.setFont(FONT, "normal");
  doc.setFontSize(10);
  setColor(doc, COLOR_DARK);

  const patientFields: [string, string | undefined][] = [
    ["Name", data.patientName],
    ["Species", data.species],
    ["Breed", data.breed],
    ["Sex", data.sex],
    ["Date of Birth", data.dob],
    ["Color", data.color],
    ["Microchip", data.microchip],
  ];

  const colMid = PAGE_MARGIN + CONTENT_WIDTH / 2;
  let col = 0;
  for (const [label, value] of patientFields) {
    if (value === undefined) continue;
    const xPos = col === 0 ? PAGE_MARGIN : colMid;
    doc.setFont(FONT, "bold");
    doc.text(`${label}: `, xPos, y);
    const labelW = doc.getTextWidth(`${label}: `);
    doc.setFont(FONT, "normal");
    doc.text(value, xPos + labelW, y);
    col++;
    if (col === 2) {
      col = 0;
      y += 6;
    }
  }
  if (col !== 0) y += 6;

  // ---- Owner Info -----------------------------------------------------------
  sectionHeading("Owner Information");

  doc.setFont(FONT, "normal");
  doc.setFontSize(10);
  setColor(doc, COLOR_DARK);

  doc.setFont(FONT, "bold");
  doc.text("Name: ", PAGE_MARGIN, y);
  doc.setFont(FONT, "normal");
  doc.text(data.clientName, PAGE_MARGIN + doc.getTextWidth("Name: "), y);
  y += 6;

  if (data.clientPhone) {
    doc.setFont(FONT, "bold");
    doc.text("Phone: ", PAGE_MARGIN, y);
    doc.setFont(FONT, "normal");
    doc.text(
      data.clientPhone,
      PAGE_MARGIN + doc.getTextWidth("Phone: "),
      y
    );
    y += 6;
  }
  if (data.clientEmail) {
    doc.setFont(FONT, "bold");
    doc.text("Email: ", PAGE_MARGIN, y);
    doc.setFont(FONT, "normal");
    doc.text(
      data.clientEmail,
      PAGE_MARGIN + doc.getTextWidth("Email: "),
      y
    );
    y += 6;
  }

  // ---- Allergies ------------------------------------------------------------
  if (data.allergies.length > 0) {
    sectionHeading("Allergies");

    doc.setFontSize(10);
    for (const allergy of data.allergies) {
      y = ensureSpace(doc, y, 8);
      // Highlight background for allergies
      const [ar, ag, ab] = hexToRgb("#fef2f2"); // light red
      doc.setFillColor(ar, ag, ab);
      doc.rect(PAGE_MARGIN, y - 4, CONTENT_WIDTH, 7, "F");

      doc.setFont(FONT, "bold");
      setColor(doc, "#dc2626");
      doc.text(allergy.allergen, PAGE_MARGIN + 2, y);
      doc.setFont(FONT, "normal");
      setColor(doc, COLOR_GRAY);
      doc.text(`(${allergy.severity})`, PAGE_MARGIN + 2 + doc.getTextWidth(allergy.allergen + " "), y);
      y += 8;
    }
  }

  // ---- Active Problems ------------------------------------------------------
  if (data.problems.length > 0) {
    sectionHeading("Active Problems");

    doc.setFontSize(10);
    for (const problem of data.problems) {
      y = ensureSpace(doc, y, 8);
      doc.setFont(FONT, "normal");
      setColor(doc, COLOR_DARK);
      let text = `• ${problem.description}`;
      if (problem.onsetDate) text += ` (onset: ${problem.onsetDate})`;
      doc.text(text, PAGE_MARGIN + 2, y);
      doc.setFont(FONT, "italic");
      setColor(doc, COLOR_GRAY);
      doc.text(`[${problem.status}]`, PAGE_WIDTH - PAGE_MARGIN, y, {
        align: "right",
      });
      y += 6;
    }
  }

  // ---- Vaccination History --------------------------------------------------
  if (data.vaccinations.length > 0) {
    sectionHeading("Vaccination History");

    // Table header
    const vColName = PAGE_MARGIN;
    const vColDate = PAGE_MARGIN + CONTENT_WIDTH * 0.5;
    const vColNext = PAGE_WIDTH - PAGE_MARGIN;

    const [lr, lg, lb] = hexToRgb(COLOR_LIGHT_GRAY);
    doc.setFillColor(lr, lg, lb);
    doc.rect(PAGE_MARGIN, y - 4, CONTENT_WIDTH, 8, "F");
    doc.setFont(FONT, "bold");
    doc.setFontSize(9);
    setColor(doc, COLOR_DARK);
    doc.text("Vaccine", vColName + 2, y);
    doc.text("Date Given", vColDate, y);
    doc.text("Next Due", vColNext - 2, y, { align: "right" });
    y += 8;

    doc.setFont(FONT, "normal");
    for (const vax of data.vaccinations) {
      y = ensureSpace(doc, y, 7);
      setColor(doc, COLOR_DARK);
      doc.text(vax.name, vColName + 2, y);
      doc.text(vax.date, vColDate, y);
      setColor(doc, COLOR_GRAY);
      doc.text(vax.nextDue ?? "—", vColNext - 2, y, { align: "right" });
      y += 6;
    }
  }

  // ---- Recent SOAP Notes ----------------------------------------------------
  if (data.recentNotes.length > 0) {
    sectionHeading("Recent SOAP Notes");

    const notesToShow = data.recentNotes.slice(0, 5);
    for (const note of notesToShow) {
      y = ensureSpace(doc, y, 30);

      doc.setFont(FONT, "bold");
      doc.setFontSize(10);
      setColor(doc, COLOR_DARK);
      doc.text(
        note.imported
          ? `${note.date}  (Finalized imported record)`
          : `${note.date}  (Finalized)`,
        PAGE_MARGIN,
        y
      );
      y += 6;

      doc.setFont(FONT, "normal");
      doc.setFontSize(8);
      setColor(doc, COLOR_GRAY);
      const attribution = note.imported
        ? `Imported by ${note.authorName ?? "Unknown clinician"}`
        : `Authored by ${note.authorName ?? "Unknown clinician"}; finalized by ${note.finalizerName ?? "Unknown clinician"}${note.finalizedAt ? ` on ${note.finalizedAt}` : ""}`;
      writeWrappedText(attribution, PAGE_MARGIN, CONTENT_WIDTH);
      y += 2;
      if (note.replacementForLabel) {
        doc.setFont(FONT, "bold");
        setColor(doc, COLOR_TEAL);
        writeWrappedText(
          `Signed replacement for retained ${note.replacementForLabel}`,
          PAGE_MARGIN,
          CONTENT_WIDTH,
        );
        y += 2;
      }

      doc.setFontSize(9);
      const soapSections: [string, string | undefined][] = [
        ["S: ", soapSectionText(note.subjective)],
        ["O: ", soapSectionText(note.objective)],
        ["A: ", soapSectionText(note.assessment)],
        ["P: ", soapSectionText(note.plan)],
      ];

      for (const [prefix, content] of soapSections) {
        if (!content) continue;
        y = ensureSpace(doc, y, 10);
        doc.setFont(FONT, "bold");
        setColor(doc, COLOR_TEAL);
        doc.text(prefix, PAGE_MARGIN + 4, y);
        doc.setFont(FONT, "normal");
        setColor(doc, COLOR_DARK);
        writeWrappedText(content, PAGE_MARGIN + 14, CONTENT_WIDTH - 14);
        y += 2;
      }

      for (const addendum of note.addenda ?? []) {
        y = ensureSpace(doc, y, 14);
        doc.setFont(FONT, "bold");
        setColor(doc, COLOR_TEAL);
        writeWrappedText(
          `Addendum - ${addendum.authorName}, ${addendum.createdAt}`,
          PAGE_MARGIN + 4,
          CONTENT_WIDTH - 8,
          5,
        );
        doc.setFont(FONT, "normal");
        setColor(doc, COLOR_DARK);
        writeWrappedText(
          soapSectionText(addendum.content),
          PAGE_MARGIN + 4,
          CONTENT_WIDTH - 8,
        );
        y += 2;
      }

      y += 4;
      drawLine(doc, y);
      y += 4;
    }
  }

  // Invalidated clinical content stays excluded, while its durable correction
  // evidence remains visible to a downstream clinician reviewing the summary.
  if ((data.recordCorrections?.length ?? 0) > 0) {
    sectionHeading("Record Corrections");
    for (const correction of data.recordCorrections ?? []) {
      y = ensureSpace(doc, y, 18);
      doc.setFont(FONT, "bold");
      doc.setFontSize(9);
      setColor(doc, COLOR_DARK);
      writeWrappedText(
        correction.recordLabel,
        PAGE_MARGIN + 4,
        CONTENT_WIDTH - 8,
      );
      doc.setFont(FONT, "normal");
      setColor(doc, COLOR_GRAY);
      writeWrappedText(
        `Entered in error by ${correction.correctedByName} on ${correction.correctedAt}`,
        PAGE_MARGIN + 4,
        CONTENT_WIDTH - 8,
      );
      setColor(doc, COLOR_DARK);
      writeWrappedText(
        `Reason: ${soapSectionText(correction.reason)}`,
        PAGE_MARGIN + 4,
        CONTENT_WIDTH - 8,
      );
      if (correction.replacementLabel) {
        doc.setFont(FONT, "bold");
        setColor(doc, COLOR_TEAL);
        writeWrappedText(
          `Signed replacement: ${correction.replacementLabel}`,
          PAGE_MARGIN + 4,
          CONTENT_WIDTH - 8,
        );
      }
      y += 3;
    }
  }

  // ---- Current Prescriptions ------------------------------------------------
  if (data.prescriptions.length > 0) {
    sectionHeading("Current Prescriptions");

    // Table header
    const pColMed = PAGE_MARGIN;
    const pColDose = PAGE_MARGIN + CONTENT_WIDTH * 0.35;
    const pColFreq = PAGE_MARGIN + CONTENT_WIDTH * 0.6;
    const pColStat = PAGE_WIDTH - PAGE_MARGIN;

    const [lr2, lg2, lb2] = hexToRgb(COLOR_LIGHT_GRAY);
    doc.setFillColor(lr2, lg2, lb2);
    doc.rect(PAGE_MARGIN, y - 4, CONTENT_WIDTH, 8, "F");
    doc.setFont(FONT, "bold");
    doc.setFontSize(9);
    setColor(doc, COLOR_DARK);
    doc.text("Medication", pColMed + 2, y);
    doc.text("Dosage", pColDose, y);
    doc.text("Frequency", pColFreq, y);
    doc.text("Status", pColStat - 2, y, { align: "right" });
    y += 8;

    doc.setFont(FONT, "normal");
    for (const rx of data.prescriptions) {
      y = ensureSpace(doc, y, 7);
      setColor(doc, COLOR_DARK);
      doc.text(rx.medication, pColMed + 2, y);
      doc.text(rx.dosage, pColDose, y);
      doc.text(rx.frequency, pColFreq, y);
      setColor(doc, COLOR_GRAY);
      doc.text(rx.status, pColStat - 2, y, { align: "right" });
      y += 6;
    }
  }

  // ---- Footer ---------------------------------------------------------------
  const pageCount = doc.getNumberOfPages();
  const generatedDate = data.generatedDate ?? formatGeneratedDateUtc();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    const pageHeight = doc.internal.pageSize.getHeight();
    doc.setFont(FONT, "italic");
    doc.setFontSize(8);
    setColor(doc, COLOR_GRAY);
    doc.text(
      `Generated on ${generatedDate} — This document is for reference only`,
      PAGE_WIDTH / 2,
      pageHeight - 10,
      { align: "center" }
    );
    doc.text(`Page ${i} of ${pageCount}`, PAGE_WIDTH - PAGE_MARGIN, pageHeight - 10, {
      align: "right",
    });
  }

  return doc;
}

// ---------------------------------------------------------------------------
// 4. Vaccination Certificate
// ---------------------------------------------------------------------------

export interface VaccinationCertificateData {
  practiceName: string;
  practiceAddress?: string;
  practicePhone?: string;
  practiceEmail?: string;
  patientName: string;
  species: string;
  breed?: string;
  sex?: string;
  dob?: string;
  color?: string;
  clientName: string;
  vaccineName: string;
  administeredAt: string;
  nextDueDate?: string;
  manufacturer?: string;
  lotNumber?: string;
  generatedDate?: string;
}

export function generateVaccinationCertificatePdf(
  data: VaccinationCertificateData
): jsPDF {
  const doc = new jsPDF();
  let y = PAGE_MARGIN;

  doc.setFont(FONT, "bold");
  doc.setFontSize(20);
  setColor(doc, COLOR_TEAL);
  doc.text(data.practiceName || "Veterinary Practice", PAGE_MARGIN, y);
  y += 7;

  doc.setFont(FONT, "normal");
  doc.setFontSize(9);
  setColor(doc, COLOR_GRAY);
  if (data.practiceAddress) {
    doc.text(data.practiceAddress, PAGE_MARGIN, y);
    y += 4;
  }
  if (data.practicePhone) {
    doc.text(data.practicePhone, PAGE_MARGIN, y);
    y += 4;
  }
  if (data.practiceEmail) {
    doc.text(data.practiceEmail, PAGE_MARGIN, y);
    y += 4;
  }

  doc.setFont(FONT, "bold");
  doc.setFontSize(16);
  setColor(doc, COLOR_DARK);
  doc.text("VACCINATION CERTIFICATE", PAGE_WIDTH - PAGE_MARGIN, PAGE_MARGIN, {
    align: "right",
  });

  y = Math.max(y, PAGE_MARGIN + 14) + 4;
  drawLine(doc, y);
  y += 10;

  doc.setFont(FONT, "bold");
  doc.setFontSize(12);
  setColor(doc, COLOR_TEAL);
  doc.text("Patient", PAGE_MARGIN, y);
  doc.text("Owner", PAGE_MARGIN + CONTENT_WIDTH / 2, y);
  y += 6;

  doc.setFont(FONT, "normal");
  doc.setFontSize(10);
  setColor(doc, COLOR_DARK);
  const patientLines = [
    data.patientName,
    [data.breed, data.species].filter(Boolean).join(" / "),
    data.sex,
    data.dob ? `DOB: ${data.dob}` : undefined,
    data.color ? `Color: ${data.color}` : undefined,
  ].filter(Boolean) as string[];
  doc.text(patientLines, PAGE_MARGIN, y);
  doc.text(data.clientName, PAGE_MARGIN + CONTENT_WIDTH / 2, y);
  y += Math.max(patientLines.length, 1) * 5 + 10;

  doc.setFont(FONT, "bold");
  doc.setFontSize(12);
  setColor(doc, COLOR_TEAL);
  doc.text("Vaccination Record", PAGE_MARGIN, y);
  y += 6;

  const rows: [string, string | undefined][] = [
    ["Vaccine", data.vaccineName],
    ["Administered", data.administeredAt],
    ["Next due", data.nextDueDate],
    ["Manufacturer", data.manufacturer],
    ["Lot number", data.lotNumber],
  ];

  doc.setFontSize(10);
  for (const [label, value] of rows) {
    if (!value) continue;
    y = ensureSpace(doc, y, 8);
    doc.setFont(FONT, "bold");
    setColor(doc, COLOR_DARK);
    doc.text(`${label}:`, PAGE_MARGIN, y);
    doc.setFont(FONT, "normal");
    doc.text(value, PAGE_MARGIN + 36, y);
    y += 7;
  }

  y += 8;
  drawLine(doc, y);
  y += 8;

  doc.setFont(FONT, "normal");
  doc.setFontSize(9);
  setColor(doc, COLOR_GRAY);
  const note =
    "This certificate reflects the vaccination record currently available in the client portal.";
  doc.text(doc.splitTextToSize(note, CONTENT_WIDTH), PAGE_MARGIN, y);

  const generatedDate = data.generatedDate ?? formatGeneratedDateUtc();
  const pageHeight = doc.internal.pageSize.getHeight();
  doc.setFont(FONT, "italic");
  doc.setFontSize(8);
  setColor(doc, COLOR_GRAY);
  doc.text(`Generated on ${generatedDate}`, PAGE_WIDTH / 2, pageHeight - 10, {
    align: "center",
  });

  return doc;
}

// ---------------------------------------------------------------------------
// 5. Generic Report PDF
// ---------------------------------------------------------------------------

export type ReportPdfCell = string | number | null | undefined;

export interface ReportPdfData {
  title: string;
  subtitle?: string;
  columns: string[];
  rows: ReportPdfCell[][];
  emptyMessage?: string;
  generatedDate?: string;
}

export function generateReportPdf(data: ReportPdfData): jsPDF {
  const doc = new jsPDF({
    orientation: data.columns.length > 4 ? "landscape" : "portrait",
  });
  const margin = 16;
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const contentWidth = pageWidth - margin * 2;
  const colWidth = contentWidth / Math.max(data.columns.length, 1);
  let y = margin;

  function addPageIfNeeded(needed: number) {
    if (y + needed <= pageHeight - 18) return;
    doc.addPage();
    y = margin;
    drawTableHeader();
  }

  function drawTableHeader() {
    const [r, g, b] = hexToRgb(COLOR_LIGHT_GRAY);
    doc.setFillColor(r, g, b);
    doc.rect(margin, y - 4, contentWidth, 8, "F");
    doc.setFont(FONT, "bold");
    doc.setFontSize(8);
    setColor(doc, COLOR_DARK);
    data.columns.forEach((column, index) => {
      doc.text(column, margin + index * colWidth + 2, y);
    });
    y += 8;
  }

  doc.setFont(FONT, "bold");
  doc.setFontSize(18);
  setColor(doc, COLOR_TEAL);
  doc.text(data.title, margin, y);
  y += 7;

  if (data.subtitle) {
    doc.setFont(FONT, "normal");
    doc.setFontSize(9);
    setColor(doc, COLOR_GRAY);
    doc.text(data.subtitle, margin, y);
    y += 5;
  }

  const [reportLineR, reportLineG, reportLineB] = hexToRgb(COLOR_LIGHT_GRAY);
  doc.setDrawColor(reportLineR, reportLineG, reportLineB);
  doc.setLineWidth(0.5);
  doc.line(margin, y, pageWidth - margin, y);
  y += 8;

  if (data.rows.length === 0) {
    doc.setFont(FONT, "italic");
    doc.setFontSize(10);
    setColor(doc, COLOR_GRAY);
    doc.text(data.emptyMessage ?? "No report data available.", margin, y);
  } else {
    drawTableHeader();
    doc.setFont(FONT, "normal");
    doc.setFontSize(8);

    for (const row of data.rows) {
      const cellLines = data.columns.map((_, index) =>
        doc.splitTextToSize(String(row[index] ?? ""), colWidth - 4)
      );
      const rowHeight =
        Math.max(...cellLines.map((lines) => lines.length), 1) * 4 + 4;
      addPageIfNeeded(rowHeight);
      setColor(doc, COLOR_DARK);
      cellLines.forEach((lines, index) => {
        doc.text(lines, margin + index * colWidth + 2, y);
      });
      y += rowHeight;
    }
  }

  const generatedDate = data.generatedDate ?? formatGeneratedDateUtc();
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFont(FONT, "italic");
    doc.setFontSize(8);
    setColor(doc, COLOR_GRAY);
    doc.text(`Generated on ${generatedDate}`, pageWidth / 2, pageHeight - 8, {
      align: "center",
    });
    doc.text(`Page ${i} of ${pageCount}`, pageWidth - margin, pageHeight - 8, {
      align: "right",
    });
  }

  return doc;
}

// ---------------------------------------------------------------------------
// 6. Discharge Instructions
// ---------------------------------------------------------------------------

export interface DischargeInstructionsData {
  practiceName: string;
  practicePhone?: string;
  patientName: string;
  species: string;
  clientName: string;
  visitDate: string;
  doctorName?: string;
  diagnosis?: string;
  medications: Array<{
    name: string;
    dosage: string;
    frequency: string;
    instructions?: string;
  }>;
  instructions: string[];
  followUpDate?: string;
  followUpNotes?: string;
  restrictions?: string[];
  emergencyNotes?: string;
}

export function generateDischargeInstructions(
  data: DischargeInstructionsData
): jsPDF {
  const doc = new jsPDF();
  let y = PAGE_MARGIN;

  // Header
  doc.setFont(FONT, "bold");
  doc.setFontSize(16);
  setColor(doc, COLOR_TEAL);
  doc.text(data.practiceName || "Veterinary Practice", PAGE_MARGIN, y);
  y += 6;

  if (data.practicePhone) {
    doc.setFont(FONT, "normal");
    doc.setFontSize(9);
    setColor(doc, COLOR_GRAY);
    doc.text(data.practicePhone, PAGE_MARGIN, y);
    y += 4;
  }
  y += 4;

  // Title
  doc.setFont(FONT, "bold");
  doc.setFontSize(18);
  setColor(doc, COLOR_DARK);
  doc.text("DISCHARGE INSTRUCTIONS", PAGE_MARGIN, y);
  y += 10;
  drawLine(doc, y);
  y += 8;

  // Patient & Visit Info
  doc.setFontSize(10);
  doc.setFont(FONT, "bold");
  setColor(doc, COLOR_DARK);
  doc.text("Patient:", PAGE_MARGIN, y);
  doc.setFont(FONT, "normal");
  doc.text(`${data.patientName} (${data.species})`, PAGE_MARGIN + 22, y);

  doc.setFont(FONT, "bold");
  doc.text("Owner:", PAGE_WIDTH / 2, y);
  doc.setFont(FONT, "normal");
  doc.text(data.clientName, PAGE_WIDTH / 2 + 20, y);
  y += 6;

  doc.setFont(FONT, "bold");
  doc.text("Visit Date:", PAGE_MARGIN, y);
  doc.setFont(FONT, "normal");
  doc.text(data.visitDate, PAGE_MARGIN + 28, y);

  if (data.doctorName) {
    doc.setFont(FONT, "bold");
    doc.text("Doctor:", PAGE_WIDTH / 2, y);
    doc.setFont(FONT, "normal");
    doc.text(data.doctorName, PAGE_WIDTH / 2 + 20, y);
  }
  y += 10;

  // Diagnosis
  if (data.diagnosis) {
    drawLine(doc, y);
    y += 6;
    doc.setFont(FONT, "bold");
    doc.setFontSize(12);
    setColor(doc, COLOR_DARK);
    doc.text("Diagnosis", PAGE_MARGIN, y);
    y += 6;
    doc.setFont(FONT, "normal");
    doc.setFontSize(10);
    const diagLines = doc.splitTextToSize(data.diagnosis, CONTENT_WIDTH);
    doc.text(diagLines, PAGE_MARGIN, y);
    y += diagLines.length * 5 + 6;
  }

  // Medications
  if (data.medications.length > 0) {
    y = ensureSpace(doc, y, 30);
    drawLine(doc, y);
    y += 6;
    doc.setFont(FONT, "bold");
    doc.setFontSize(12);
    setColor(doc, COLOR_DARK);
    doc.text("Medications", PAGE_MARGIN, y);
    y += 8;

    for (const med of data.medications) {
      y = ensureSpace(doc, y, 20);
      doc.setFont(FONT, "bold");
      doc.setFontSize(10);
      doc.text(`${med.name} — ${med.dosage}`, PAGE_MARGIN + 4, y);
      y += 5;
      doc.setFont(FONT, "normal");
      setColor(doc, COLOR_GRAY);
      doc.text(`Frequency: ${med.frequency}`, PAGE_MARGIN + 4, y);
      y += 5;
      if (med.instructions) {
        const instrLines = doc.splitTextToSize(med.instructions, CONTENT_WIDTH - 8);
        setColor(doc, COLOR_DARK);
        doc.text(instrLines, PAGE_MARGIN + 4, y);
        y += instrLines.length * 5;
      }
      y += 4;
    }
  }

  // Care Instructions
  if (data.instructions.length > 0) {
    y = ensureSpace(doc, y, 20);
    drawLine(doc, y);
    y += 6;
    doc.setFont(FONT, "bold");
    doc.setFontSize(12);
    setColor(doc, COLOR_DARK);
    doc.text("Care Instructions", PAGE_MARGIN, y);
    y += 8;

    doc.setFont(FONT, "normal");
    doc.setFontSize(10);
    for (const instruction of data.instructions) {
      y = ensureSpace(doc, y, 10);
      const lines = doc.splitTextToSize(`• ${instruction}`, CONTENT_WIDTH - 4);
      doc.text(lines, PAGE_MARGIN + 4, y);
      y += lines.length * 5 + 2;
    }
    y += 4;
  }

  // Restrictions
  if (data.restrictions && data.restrictions.length > 0) {
    y = ensureSpace(doc, y, 20);
    drawLine(doc, y);
    y += 6;
    doc.setFont(FONT, "bold");
    doc.setFontSize(12);
    setColor(doc, COLOR_DARK);
    doc.text("Restrictions", PAGE_MARGIN, y);
    y += 8;

    doc.setFont(FONT, "normal");
    doc.setFontSize(10);
    for (const restriction of data.restrictions) {
      y = ensureSpace(doc, y, 10);
      const lines = doc.splitTextToSize(`• ${restriction}`, CONTENT_WIDTH - 4);
      doc.text(lines, PAGE_MARGIN + 4, y);
      y += lines.length * 5 + 2;
    }
    y += 4;
  }

  // Follow-up
  if (data.followUpDate || data.followUpNotes) {
    y = ensureSpace(doc, y, 20);
    drawLine(doc, y);
    y += 6;
    doc.setFont(FONT, "bold");
    doc.setFontSize(12);
    setColor(doc, COLOR_DARK);
    doc.text("Follow-Up", PAGE_MARGIN, y);
    y += 7;

    doc.setFontSize(10);
    if (data.followUpDate) {
      doc.setFont(FONT, "bold");
      doc.text("Scheduled:", PAGE_MARGIN + 4, y);
      doc.setFont(FONT, "normal");
      doc.text(data.followUpDate, PAGE_MARGIN + 30, y);
      y += 6;
    }
    if (data.followUpNotes) {
      doc.setFont(FONT, "normal");
      const lines = doc.splitTextToSize(data.followUpNotes, CONTENT_WIDTH - 8);
      doc.text(lines, PAGE_MARGIN + 4, y);
      y += lines.length * 5;
    }
    y += 6;
  }

  // Emergency notes
  if (data.emergencyNotes) {
    y = ensureSpace(doc, y, 25);
    drawLine(doc, y);
    y += 6;
    const [r, g, b] = hexToRgb("#dc2626");
    doc.setTextColor(r, g, b);
    doc.setFont(FONT, "bold");
    doc.setFontSize(11);
    doc.text("WHEN TO SEEK EMERGENCY CARE", PAGE_MARGIN, y);
    y += 7;
    doc.setFont(FONT, "normal");
    doc.setFontSize(10);
    setColor(doc, COLOR_DARK);
    const emergLines = doc.splitTextToSize(data.emergencyNotes, CONTENT_WIDTH);
    doc.text(emergLines, PAGE_MARGIN, y);
  }

  // Footer
  const pageHeight = doc.internal.pageSize.getHeight();
  doc.setFont(FONT, "italic");
  doc.setFontSize(8);
  setColor(doc, COLOR_GRAY);
  doc.text(
    "If you have any questions or concerns, please contact our office.",
    PAGE_WIDTH / 2,
    pageHeight - 15,
    { align: "center" }
  );
  if (data.practicePhone) {
    doc.text(data.practicePhone, PAGE_WIDTH / 2, pageHeight - 10, {
      align: "center",
    });
  }

  return doc;
}
