import { createHash } from "node:crypto";
import { normalizeKey } from "@/lib/csv/parse";
import type { ShepherdRawRow, ShepherdTableKind } from "./shepherd-bundle";
import type { ShepherdBundleRows, ShepherdDomainCoverage } from "./shepherd-core-adapter";

type NormalizedRow = Record<string, string | undefined>;

export type ShepherdHistoryIssueCode =
  | "deleted_source_row"
  | "missing_source_identity"
  | "missing_client_link"
  | "missing_patient_link"
  | "missing_parent_link"
  | "invalid_source_date"
  | "invalid_source_amount"
  | "missing_required_text"
  | "ambiguous_patient_link"
  | "unstructured_lab_result"
  | "source_notification_preferences_ignored";

export interface ShepherdHistoryIssue {
  domain: string;
  rowIndex: number;
  code: ShepherdHistoryIssueCode;
  severity: "warning" | "error";
}

export interface ClientContactImportRecord {
  externalContactId: string;
  externalClientId?: string;
  attributionStatus: "matched" | "needs_review";
  kind: "co_owner";
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
}

export interface HistoricalAppointmentImportRecord {
  externalAppointmentId: string;
  externalClientId: string;
  externalPatientId: string;
  startedAt: string;
  endedAt: string;
  status: "completed" | "cancelled" | "no_show" | "unknown";
  appointmentType?: string;
  reason?: string;
  notes?: string;
}

export interface ExternalPrescriptionImportRecord {
  externalPrescriptionId: string;
  externalPatientId: string;
  medicationName: string;
  directions?: string;
  quantity?: string;
  refillCount?: number;
  prescribedAt?: string;
  expiresAt?: string;
  status: "active" | "completed" | "cancelled" | "expired" | "unknown";
  isChronic: boolean;
}

export interface ExternalPrescriptionFillImportRecord {
  externalFillId: string;
  externalPrescriptionId: string;
  filledAt?: string;
  quantityDispensed?: string;
  directions?: string;
  sourceStatus?: string;
}

export interface ExternalLabReportImportRecord {
  externalLabReportId: string;
  externalPatientId?: string;
  attributionStatus: "matched" | "needs_review";
  orderedAt?: string;
  resultedAt?: string;
  status: "ordered" | "partial" | "final" | "corrected" | "cancelled" | "unknown";
  orderName?: string;
  accessionNumber?: string;
  summary?: string;
}

export interface ExternalLabObservationImportRecord {
  externalObservationId: string;
  externalLabReportId: string;
  sortOrder: number;
  name: string;
  value?: string;
  unit?: string;
  referenceRange?: string;
  flag?: string;
}

export interface LegacyFinancialDocumentImportRecord {
  externalDocumentId: string;
  externalClientId: string;
  externalPatientId?: string;
  documentType: "invoice" | "credit_note" | "estimate";
  documentNumber?: string;
  issuedAt: string;
  status: "open" | "partial" | "paid" | "void" | "unknown";
  subtotal: string;
  tax: string;
  discount: string;
  total: string;
  paidAmount: string;
  balance: string;
  sourceStatus?: string;
}

export interface LegacyFinancialLineItemImportRecord {
  externalLineItemId: string;
  externalDocumentId: string;
  externalPatientId?: string;
  sortOrder: number;
  description: string;
  quantity: string;
  unitPrice: string;
  subtotal: string;
  tax: string;
  discount: string;
  total: string;
}

export interface LegacyFinancialPaymentImportRecord {
  externalPaymentId: string;
  externalClientId?: string;
  attributionStatus: "matched" | "needs_review";
  entryType: "payment" | "refund" | "adjustment";
  amount: string;
  receivedAt: string;
  method?: string;
  sourceStatus?: string;
  reference?: string;
  note?: string;
}

export interface LegacyFinancialAllocationImportRecord {
  externalAllocationId: string;
  externalDocumentId: string;
  externalPaymentId: string;
  amount: string;
  allocatedAt?: string;
  description?: string;
}

export interface ShepherdHistoryAdaptation {
  clientContacts: ClientContactImportRecord[];
  historicalAppointments: HistoricalAppointmentImportRecord[];
  externalPrescriptions: ExternalPrescriptionImportRecord[];
  externalPrescriptionFills: ExternalPrescriptionFillImportRecord[];
  externalLabReports: ExternalLabReportImportRecord[];
  externalLabObservations: ExternalLabObservationImportRecord[];
  legacyFinancialDocuments: LegacyFinancialDocumentImportRecord[];
  legacyFinancialLineItems: LegacyFinancialLineItemImportRecord[];
  legacyFinancialPayments: LegacyFinancialPaymentImportRecord[];
  legacyFinancialAllocations: LegacyFinancialAllocationImportRecord[];
  issues: ShepherdHistoryIssue[];
  coverage: Record<string, ShepherdDomainCoverage>;
}

function normalize(row: ShepherdRawRow): NormalizedRow {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [normalizeKey(key), value?.trim()]),
  );
}

function table(bundle: ShepherdBundleRows, kind: ShepherdTableKind): NormalizedRow[] {
  return (bundle[kind] ?? []).map(normalize);
}

function truthy(value: string | undefined): boolean {
  return ["1", "true", "yes", "y"].includes(value?.trim().toLowerCase() ?? "");
}

function sourceDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function decimal(
  value: string | undefined,
  scale: 2 | 3,
  absolute = false,
): string | undefined {
  if (!value || !/^-?\d+(?:\.\d+)?$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  const normalized = absolute ? Math.abs(parsed) : parsed;
  if (normalized < 0 || normalized >= 100_000_000_000) return undefined;
  return normalized.toFixed(scale);
}

function nonnegativeInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function bounded(value: string | undefined, limit: number): string | undefined {
  const text = value?.trim();
  return text ? text.slice(0, limit) : undefined;
}

function opaqueSourceIdentity(parts: readonly (string | undefined)[]): string {
  return createHash("sha256")
    .update(JSON.stringify(parts.map((part) => part?.trim() || null)), "utf8")
    .digest("hex");
}

function coverage(
  sourceRows: number,
  plannedRows: number,
  deferredRows: number,
  excludedRows: number,
  errorRows: number,
): ShepherdDomainCoverage {
  if (plannedRows + deferredRows + excludedRows + errorRows !== sourceRows) {
    throw new Error("Shepherd history coverage must account for every row.");
  }
  return { sourceRows, plannedRows, deferredRows, excludedRows, errorRows };
}

function dictionary(bundle: ShepherdBundleRows, kind: ShepherdTableKind): Map<string, string> {
  return new Map(
    table(bundle, kind)
      .filter((row) => row.id && (row.name || row.description))
      .map((row) => [row.id!, row.name || row.description!] as const),
  );
}

function issue(
  issues: ShepherdHistoryIssue[],
  domain: string,
  rowIndex: number,
  code: ShepherdHistoryIssueCode,
  severity: "warning" | "error",
) {
  issues.push({ domain, rowIndex, code, severity });
}

export function adaptShepherdHistory(
  bundle: ShepherdBundleRows,
  now = new Date(),
): ShepherdHistoryAdaptation {
  const issues: ShepherdHistoryIssue[] = [];
  const coverageByDomain: Record<string, ShepherdDomainCoverage> = {};
  const activeClientIds = new Set(
    table(bundle, "client")
      .filter((row) => row.id && !truthy(row.deleted) && !truthy(row.isdeleted))
      .map((row) => row.id!),
  );
  const activePatientIds = new Set(
    table(bundle, "patient")
      .filter((row) => row.id && !truthy(row.deleted) && !truthy(row.isdeleted))
      .map((row) => row.id!),
  );
  const primaryClientByPatient = new Map(
    table(bundle, "client_patient")
      .filter((row) => row.patientid && row.clientid)
      .map((row) => [row.patientid!, row.clientid!] as const),
  );

  const coownerPhones = new Map<string, string>();
  for (const row of table(bundle, "client_coowner_phone")) {
    if (!row.clientcoownerid || !row.phonenumber) continue;
    if (truthy(row.isprimary) || !coownerPhones.has(row.clientcoownerid)) {
      coownerPhones.set(row.clientcoownerid, row.phonenumber);
    }
  }
  const contactRows = table(bundle, "client_coowner");
  const clientContacts: ClientContactImportRecord[] = [];
  const contactErrors = 0;
  contactRows.forEach((row, rowIndex) => {
    const matched = !!row.clientid && activeClientIds.has(row.clientid);
    if (!matched) {
      issue(issues, "client_contacts", rowIndex, "missing_client_link", "warning");
    }
    clientContacts.push({
      externalContactId: opaqueSourceIdentity([
        row.id,
        row.clientid,
        row.email?.toLowerCase(),
        row.firstname,
        row.lastname,
      ]),
      externalClientId: matched ? row.clientid : undefined,
      attributionStatus: matched ? "matched" : "needs_review",
      kind: "co_owner",
      firstName: row.firstname || undefined,
      lastName: row.lastname || undefined,
      email: row.email || undefined,
      phone: row.clientid ? coownerPhones.get(row.clientid) : undefined,
    });
    if (
      row.emailnotification ||
      row.smsnotification ||
      row.emailmasscommuncationnotification ||
      row.smsmasscommuncationnotification
    ) {
      issue(
        issues,
        "client_contacts",
        rowIndex,
        "source_notification_preferences_ignored",
        "warning",
      );
    }
  });
  coverageByDomain.clientContacts = coverage(
    contactRows.length,
    clientContacts.length,
    0,
    0,
    contactErrors,
  );

  const appointmentRows = table(bundle, "appointment");
  const appointmentById = new Map(
    appointmentRows.filter((row) => row.id).map((row) => [row.id!, row] as const),
  );
  const appointmentTypes = dictionary(bundle, "appointment_type");
  const appointmentStatuses = dictionary(bundle, "appointment_status");
  const appointmentPatients = table(bundle, "appointment_patient");
  const historicalAppointments: HistoricalAppointmentImportRecord[] = [];
  let appointmentErrors = 0;
  appointmentPatients.forEach((link, rowIndex) => {
    const row = link.appointmentid ? appointmentById.get(link.appointmentid) : undefined;
    if (!row || !row.id) {
      appointmentErrors++;
      issue(issues, "historical_appointments", rowIndex, "missing_parent_link", "error");
      return;
    }
    const patientId = link.patientid;
    const clientId = patientId ? primaryClientByPatient.get(patientId) : undefined;
    if (!patientId || !activePatientIds.has(patientId) || !clientId || !activeClientIds.has(clientId)) {
      appointmentErrors++;
      issue(issues, "historical_appointments", rowIndex, "missing_patient_link", "error");
      return;
    }
    const startedAt = sourceDate(row.startdate);
    const endedAt = sourceDate(row.enddate);
    if (!startedAt || !endedAt || startedAt >= endedAt) {
      appointmentErrors++;
      issue(issues, "historical_appointments", rowIndex, "invalid_source_date", "error");
      return;
    }
    const sourceStatus = appointmentStatuses.get(row.appointmentstatusid ?? "")?.toLowerCase() ?? "";
    const status: HistoricalAppointmentImportRecord["status"] =
      truthy(row.isdeleted) || row.datecanceled || sourceStatus.includes("cancel")
        ? "cancelled"
        : sourceStatus.includes("no show") || sourceStatus.includes("noshow")
          ? "no_show"
          : sourceStatus.includes("complete") || sourceStatus.includes("check")
            ? "completed"
            : "unknown";
    historicalAppointments.push({
      externalAppointmentId: `${row.id}:${patientId}`,
      externalClientId: clientId,
      externalPatientId: patientId,
      startedAt,
      endedAt,
      status,
      appointmentType: appointmentTypes.get(row.appointmenttypeid ?? ""),
      reason: bounded(row.visitreason, 4000),
      notes: bounded(row.cancellationnote, 12000),
    });
  });
  const appointmentExcluded = appointmentRows.length - new Set(
    appointmentPatients.map((row) => row.appointmentid).filter(Boolean),
  ).size;
  coverageByDomain.historicalAppointments = coverage(
    appointmentPatients.length + appointmentExcluded,
    historicalAppointments.length,
    0,
    appointmentExcluded,
    appointmentErrors,
  );

  const products = new Map(
    table(bundle, "product")
      .filter((row) => row.id && row.name)
      .map((row) => [row.id!, row.name!] as const),
  );
  const prescriptionRows = table(bundle, "prescription");
  const externalPrescriptions: ExternalPrescriptionImportRecord[] = [];
  const importedPrescriptionIds = new Set<string>();
  let prescriptionErrors = 0;
  prescriptionRows.forEach((row, rowIndex) => {
    if (!row.id) {
      prescriptionErrors++;
      issue(issues, "external_prescriptions", rowIndex, "missing_source_identity", "error");
      return;
    }
    if (!row.patientid || !activePatientIds.has(row.patientid)) {
      prescriptionErrors++;
      issue(issues, "external_prescriptions", rowIndex, "missing_patient_link", "error");
      return;
    }
    const medicationName = bounded(row.writtenproduct || products.get(row.productid ?? ""), 255);
    if (!medicationName) {
      prescriptionErrors++;
      issue(issues, "external_prescriptions", rowIndex, "missing_required_text", "error");
      return;
    }
    const quantity = row.quantity ? decimal(row.quantity, 3) : undefined;
    if (row.quantity && !quantity) {
      issue(issues, "external_prescriptions", rowIndex, "invalid_source_amount", "warning");
    }
    const prescribedAt = sourceDate(row.datecreated);
    const expiresAt = sourceDate(row.expirationdate);
    const status: ExternalPrescriptionImportRecord["status"] = truthy(row.iscanceled)
      ? "cancelled"
      : expiresAt && new Date(expiresAt) < now
        ? "expired"
        : truthy(row.ischronicmedication) || truthy(row.iswritten)
          ? "active"
          : "unknown";
    externalPrescriptions.push({
      externalPrescriptionId: row.id,
      externalPatientId: row.patientid,
      medicationName,
      directions: bounded(row.direction, 12000),
      quantity,
      refillCount: nonnegativeInteger(row.refillcount ?? row.refillquantity),
      prescribedAt,
      expiresAt,
      status,
      isChronic: truthy(row.ischronicmedication),
    });
    importedPrescriptionIds.add(row.id);
  });
  coverageByDomain.externalPrescriptions = coverage(
    prescriptionRows.length,
    externalPrescriptions.length,
    0,
    0,
    prescriptionErrors,
  );

  const refillRows = table(bundle, "refill");
  const externalPrescriptionFills: ExternalPrescriptionFillImportRecord[] = [];
  let refillErrors = 0;
  refillRows.forEach((row, rowIndex) => {
    const externalId = row.id || row.refillid;
    if (!externalId) {
      refillErrors++;
      issue(issues, "external_prescription_fills", rowIndex, "missing_source_identity", "error");
      return;
    }
    if (!row.prescriptionid || !importedPrescriptionIds.has(row.prescriptionid)) {
      refillErrors++;
      issue(issues, "external_prescription_fills", rowIndex, "missing_parent_link", "error");
      return;
    }
    const quantityDispensed = row.quantitydispensed
      ? decimal(row.quantitydispensed, 3)
      : undefined;
    if (row.quantitydispensed && !quantityDispensed) {
      issue(issues, "external_prescription_fills", rowIndex, "invalid_source_amount", "warning");
    }
    externalPrescriptionFills.push({
      externalFillId: externalId,
      externalPrescriptionId: row.prescriptionid,
      filledAt: sourceDate(row.datefilled),
      quantityDispensed,
      directions: bounded(row.direction, 12000),
      sourceStatus: bounded(row.refillstatusid, 128),
    });
  });
  coverageByDomain.externalPrescriptionFills = coverage(
    refillRows.length,
    externalPrescriptionFills.length,
    0,
    0,
    refillErrors,
  );

  const labRows = table(bundle, "lab_order");
  const labMediaByOrder = new Map<string, NormalizedRow[]>();
  for (const media of table(bundle, "lab_media")) {
    if (!media.labintegrationorderid) continue;
    const existing = labMediaByOrder.get(media.labintegrationorderid) ?? [];
    existing.push(media);
    labMediaByOrder.set(media.labintegrationorderid, existing);
  }
  const externalLabReports: ExternalLabReportImportRecord[] = [];
  const externalLabObservations: ExternalLabObservationImportRecord[] = [];
  let labErrors = 0;
  labRows.forEach((row, rowIndex) => {
    if (!row.id) {
      labErrors++;
      issue(issues, "external_lab_reports", rowIndex, "missing_source_identity", "error");
      return;
    }
    const matchedPatient = !!row.patientid && activePatientIds.has(row.patientid);
    if (!matchedPatient) {
      issue(issues, "external_lab_reports", rowIndex, "missing_patient_link", "warning");
    }
    const media = labMediaByOrder.get(row.id) ?? [];
    const status: ExternalLabReportImportRecord["status"] = truthy(row.isdeleted)
      ? "cancelled"
      : truthy(row.haspartialresults)
        ? "partial"
        : media.length > 0
          ? "final"
          : "unknown";
    externalLabReports.push({
      externalLabReportId: row.id,
      externalPatientId: matchedPatient ? row.patientid : undefined,
      attributionStatus: matchedPatient ? "matched" : "needs_review",
      orderedAt: sourceDate(row.datecreated),
      resultedAt: media
        .map((entry) => sourceDate(entry.dateupdated || entry.datecreated))
        .filter((value): value is string => !!value)
        .sort()
        .at(-1),
      status,
      orderName: "Imported laboratory order",
      accessionNumber: bounded(row.orderid, 160),
    });
    issue(issues, "external_lab_reports", rowIndex, "unstructured_lab_result", "warning");
  });
  coverageByDomain.externalLabReports = coverage(
    labRows.length,
    externalLabReports.length,
    0,
    0,
    labErrors,
  );
  coverageByDomain.externalLabObservations = coverage(0, 0, 0, 0, 0);

  const invoiceRows = table(bundle, "invoice");
  const invoiceItems = table(bundle, "invoice_item");
  const itemsByInvoice = new Map<string, NormalizedRow[]>();
  invoiceItems.forEach((row) => {
    if (!row.invoiceid) return;
    const current = itemsByInvoice.get(row.invoiceid) ?? [];
    current.push(row);
    itemsByInvoice.set(row.invoiceid, current);
  });
  const legacyFinancialDocuments: LegacyFinancialDocumentImportRecord[] = [];
  const importedInvoiceIds = new Set<string>();
  let invoiceErrors = 0;
  invoiceRows.forEach((row, rowIndex) => {
    if (!row.id) {
      invoiceErrors++;
      issue(issues, "legacy_financial_documents", rowIndex, "missing_source_identity", "error");
      return;
    }
    if (!row.clientid || !activeClientIds.has(row.clientid)) {
      invoiceErrors++;
      issue(issues, "legacy_financial_documents", rowIndex, "missing_client_link", "error");
      return;
    }
    const issuedAt = sourceDate(row.dateissued || row.datecreated);
    const subtotal = decimal(row.subtotal, 2, true);
    const tax = decimal(row.tax || "0", 2, true);
    const discount = decimal(row.discount || "0", 2, true);
    const total = decimal(row.total, 2, true);
    const balance = decimal(row.balance || "0", 2, true);
    const paidAmount = total && balance
      ? Math.max(0, Number(total) - Number(balance)).toFixed(2)
      : undefined;
    if (!issuedAt) {
      invoiceErrors++;
      issue(issues, "legacy_financial_documents", rowIndex, "invalid_source_date", "error");
      return;
    }
    if (!subtotal || !tax || !discount || !total || !balance || !paidAmount) {
      invoiceErrors++;
      issue(issues, "legacy_financial_documents", rowIndex, "invalid_source_amount", "error");
      return;
    }
    const patientIds = new Set(
      (itemsByInvoice.get(row.id) ?? [])
        .map((item) => item.patientid)
        .filter((id): id is string => !!id && activePatientIds.has(id)),
    );
    const documentType: LegacyFinancialDocumentImportRecord["documentType"] = truthy(row.isreturn)
      ? "credit_note"
      : truthy(row.isinvoice)
        ? "invoice"
        : "estimate";
    const status: LegacyFinancialDocumentImportRecord["status"] =
      truthy(row.isdeleted) || row.dateexcluded
        ? "void"
        : truthy(row.isfullysettled) || Number(balance) === 0
          ? "paid"
          : Number(paidAmount) > 0
            ? "partial"
            : "open";
    legacyFinancialDocuments.push({
      externalDocumentId: row.id,
      externalClientId: row.clientid,
      externalPatientId: patientIds.size === 1 ? [...patientIds][0] : undefined,
      documentType,
      documentNumber: bounded(row.invoicenumber, 160),
      issuedAt,
      status,
      subtotal,
      tax,
      discount,
      total,
      paidAmount,
      balance,
      sourceStatus: bounded(row.statusid, 128),
    });
    importedInvoiceIds.add(row.id);
  });
  coverageByDomain.legacyFinancialDocuments = coverage(
    invoiceRows.length,
    legacyFinancialDocuments.length,
    0,
    0,
    invoiceErrors,
  );

  const legacyFinancialLineItems: LegacyFinancialLineItemImportRecord[] = [];
  let itemErrors = 0;
  invoiceItems.forEach((row, rowIndex) => {
    if (!row.id) {
      itemErrors++;
      issue(issues, "legacy_financial_line_items", rowIndex, "missing_source_identity", "error");
      return;
    }
    if (!row.invoiceid || !importedInvoiceIds.has(row.invoiceid)) {
      itemErrors++;
      issue(issues, "legacy_financial_line_items", rowIndex, "missing_parent_link", "error");
      return;
    }
    const quantity = decimal(row.productquantity || "0", 3, true);
    const unitPrice = decimal(row.price || "0", 2, true);
    const subtotal = decimal(row.subtotal || "0", 2, true);
    const tax = decimal(row.tax || "0", 2, true);
    const discount = decimal(row.discount || "0", 2, true);
    const total = decimal(row.total || "0", 2, true);
    const description = bounded(row.name || products.get(row.productid ?? ""), 500);
    if (!quantity || !unitPrice || !subtotal || !tax || !discount || !total) {
      itemErrors++;
      issue(issues, "legacy_financial_line_items", rowIndex, "invalid_source_amount", "error");
      return;
    }
    if (!description) {
      itemErrors++;
      issue(issues, "legacy_financial_line_items", rowIndex, "missing_required_text", "error");
      return;
    }
    legacyFinancialLineItems.push({
      externalLineItemId: row.id,
      externalDocumentId: row.invoiceid,
      externalPatientId:
        row.patientid && activePatientIds.has(row.patientid) ? row.patientid : undefined,
      sortOrder: nonnegativeInteger(row.linenumber) ?? rowIndex,
      description,
      quantity,
      unitPrice,
      subtotal,
      tax,
      discount,
      total,
    });
  });
  coverageByDomain.legacyFinancialLineItems = coverage(
    invoiceItems.length,
    legacyFinancialLineItems.length,
    0,
    0,
    itemErrors,
  );

  const paymentRows = table(bundle, "payment");
  const legacyFinancialPayments: LegacyFinancialPaymentImportRecord[] = [];
  const importedPaymentIds = new Set<string>();
  let paymentErrors = 0;
  paymentRows.forEach((row, rowIndex) => {
    if (!row.id) {
      paymentErrors++;
      issue(issues, "legacy_financial_payments", rowIndex, "missing_source_identity", "error");
      return;
    }
    const matchedClient = !!row.clientid && activeClientIds.has(row.clientid);
    if (!matchedClient) {
      issue(issues, "legacy_financial_payments", rowIndex, "missing_client_link", "warning");
    }
    const receivedAt = sourceDate(row.paymentdate || row.datecreated);
    const amount = decimal(row.amount, 2, true);
    if (!receivedAt) {
      paymentErrors++;
      issue(issues, "legacy_financial_payments", rowIndex, "invalid_source_date", "error");
      return;
    }
    if (!amount) {
      paymentErrors++;
      issue(issues, "legacy_financial_payments", rowIndex, "invalid_source_amount", "error");
      return;
    }
    const entryType: LegacyFinancialPaymentImportRecord["entryType"] =
      row.refundedpaymentid || truthy(row.isgoodwillrefund) || Number(row.amount) < 0
        ? "refund"
        : row.transferpaymentid
          ? "adjustment"
          : "payment";
    legacyFinancialPayments.push({
      externalPaymentId: row.id,
      externalClientId: matchedClient ? row.clientid : undefined,
      attributionStatus: matchedClient ? "matched" : "needs_review",
      entryType,
      amount,
      receivedAt,
      method: bounded(row.paymentmethodid, 128),
      sourceStatus: bounded(row.paymentstatusid, 128),
      reference: bounded(row.referencenumber || row.transactionid || row.checknumber, 255),
      note: bounded(row.note, 4000),
    });
    importedPaymentIds.add(row.id);
  });
  coverageByDomain.legacyFinancialPayments = coverage(
    paymentRows.length,
    legacyFinancialPayments.length,
    0,
    0,
    paymentErrors,
  );

  const allocationRows = table(bundle, "payment_allocation");
  const legacyFinancialAllocations: LegacyFinancialAllocationImportRecord[] = [];
  let allocationErrors = 0;
  allocationRows.forEach((row, rowIndex) => {
    if (!row.id) {
      allocationErrors++;
      issue(issues, "legacy_financial_allocations", rowIndex, "missing_source_identity", "error");
      return;
    }
    if (!row.invoiceid || !importedInvoiceIds.has(row.invoiceid) || !row.paymentid || !importedPaymentIds.has(row.paymentid)) {
      allocationErrors++;
      issue(issues, "legacy_financial_allocations", rowIndex, "missing_parent_link", "error");
      return;
    }
    const amount = decimal(row.closedamount, 2, true);
    if (!amount) {
      allocationErrors++;
      issue(issues, "legacy_financial_allocations", rowIndex, "invalid_source_amount", "error");
      return;
    }
    legacyFinancialAllocations.push({
      externalAllocationId: row.id,
      externalDocumentId: row.invoiceid,
      externalPaymentId: row.paymentid,
      amount,
      allocatedAt: sourceDate(row.closeddate),
      description: bounded(row.description, 500),
    });
  });
  coverageByDomain.legacyFinancialAllocations = coverage(
    allocationRows.length,
    legacyFinancialAllocations.length,
    0,
    0,
    allocationErrors,
  );

  return {
    clientContacts,
    historicalAppointments,
    externalPrescriptions,
    externalPrescriptionFills,
    externalLabReports,
    externalLabObservations,
    legacyFinancialDocuments,
    legacyFinancialLineItems,
    legacyFinancialPayments,
    legacyFinancialAllocations,
    issues,
    coverage: coverageByDomain,
  };
}
