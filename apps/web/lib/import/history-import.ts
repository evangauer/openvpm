import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import {
  clientContacts,
  clients,
  externalLabObservations,
  externalLabReports,
  externalPrescriptionFills,
  externalPrescriptions,
  historicalAppointments,
  legacyFinancialAllocations,
  legacyFinancialDocuments,
  legacyFinancialLineItems,
  legacyFinancialPayments,
  migrationRuns,
  patients,
  practices,
} from "@openpims/db";
import type { Database } from "@openpims/db/client";
import { migrationImportFingerprint } from "./fingerprint";
import {
  aggregateHistoricalPlanHash,
  classifyHistoricalPlacement,
  HISTORY_IMPORT_PLAN_VERSION,
  historicalDomainReviewedPlanHash,
  historicalEntityKind,
  mapScalarLabObservation,
  reconcileHistoricalPlacement,
  type HistoricalPlacementRow,
  type HistoryDomain,
  type HistoryPlacement,
} from "./historical-placement";
import type {
  ClientContactImportRecord,
  ExternalLabObservationImportRecord,
  ExternalLabReportImportRecord,
  ExternalPrescriptionFillImportRecord,
  ExternalPrescriptionImportRecord,
  HistoricalAppointmentImportRecord,
  LegacyFinancialAllocationImportRecord,
  LegacyFinancialDocumentImportRecord,
  LegacyFinancialLineItemImportRecord,
  LegacyFinancialPaymentImportRecord,
  ShepherdHistoryAdaptation,
} from "./shepherd-history-adapter";

export { HISTORY_IMPORT_PLAN_VERSION } from "./historical-placement";

type HistoryInput = Pick<
  ShepherdHistoryAdaptation,
  | "clientContacts"
  | "historicalAppointments"
  | "externalPrescriptions"
  | "externalPrescriptionFills"
  | "externalLabReports"
  | "externalLabObservations"
  | "legacyFinancialDocuments"
  | "legacyFinancialLineItems"
  | "legacyFinancialPayments"
  | "legacyFinancialAllocations"
>;

export interface HistoryImportError {
  domain: HistoryDomain;
  rowIndex: number;
  code:
    | "missing_client"
    | "missing_patient"
    | "missing_parent"
    | "source_identity_conflict"
    | "fingerprint_conflict"
    | "existing_record_deleted";
}

interface PlannedDomain {
  mode: HistoryDomain;
  sourceRows: number;
  rows: Record<string, unknown>[];
  duplicateCount: number;
  unmatchedCount: number;
  inRecordCount: number;
  archiveOnlyCount: number;
  needsReviewCount: number;
  placements: HistoricalPlacementRow[];
  errors: HistoryImportError[];
  sourcePayloadHash: string;
  sourcePayloadSizeBytes: number;
  reviewedPlanHash: string;
}

export interface HistoricalImportPlan {
  version: typeof HISTORY_IMPORT_PLAN_VERSION;
  practiceId: string;
  source: string;
  planHash: string;
  ready: boolean;
  totals: {
    sourceRows: number;
    plannedInsertCount: number;
    duplicateCount: number;
    unmatchedCount: number;
    errorCount: number;
    inRecordCount: number;
    archiveOnlyCount: number;
    needsReviewCount: number;
  };
  domains: Array<{
    mode: HistoryDomain;
    sourceRows: number;
    plannedInsertCount: number;
    duplicateCount: number;
    unmatchedCount: number;
    errorCount: number;
    inRecordCount: number;
    archiveOnlyCount: number;
    needsReviewCount: number;
    sourcePayloadHash: string;
    reviewedPlanHash: string;
  }>;
  errors: HistoryImportError[];
  /** Internal insert plan. Never serialize this property into shared evidence. */
  _domains: PlannedDomain[];
}

export interface HistoricalImportCommitResult {
  planHash: string;
  alreadyCommitted: boolean;
  importedCount: number;
  duplicateCount: number;
  unmatchedCount: number;
  byDomain: Record<HistoryDomain, number>;
}

export class HistoricalImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoricalImportError";
  }
}

type ExistingIdentity = {
  id: string;
  externalId: string;
  importFingerprint: string;
  deletedAt: Date | null;
  attributionStatus?: "matched" | "needs_review" | null;
};

type IdentityState = {
  byExternalId: Map<string, ExistingIdentity>;
  byFingerprint: Map<string, ExistingIdentity>;
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalPayload(records: readonly unknown[]): {
  hash: string;
  size: number;
} {
  const payload = JSON.stringify(records);
  return {
    hash: sha256(payload),
    size: Math.max(1, Buffer.byteLength(payload, "utf8")),
  };
}

function value(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function recordFingerprint(
  mode: HistoryDomain,
  source: string,
  externalId: string,
  fields: readonly unknown[],
): string {
  return migrationImportFingerprint(mode, [
    source,
    externalId,
    ...fields.map(value),
  ]);
}

async function existingIdentityState(
  db: Database,
  table: any,
  practiceId: string,
  source: string,
  options?: { withAttribution?: boolean },
): Promise<IdentityState> {
  const projection = {
    id: table.id,
    externalId: table.externalId,
    importFingerprint: table.importFingerprint,
    deletedAt: table.deletedAt,
    ...(options?.withAttribution
      ? { attributionStatus: table.attributionStatus }
      : {}),
  };
  const rows = (await db
    .select(projection)
    .from(table)
    .where(
      and(eq(table.practiceId, practiceId), eq(table.externalSource, source)),
    )) as ExistingIdentity[];
  return {
    byExternalId: new Map(rows.map((row) => [row.externalId, row])),
    byFingerprint: new Map(rows.map((row) => [row.importFingerprint, row])),
  };
}

function classifyIdentity(
  domain: HistoryDomain,
  rowIndex: number,
  externalId: string,
  fingerprint: string,
  state: IdentityState,
  errors: HistoryImportError[],
): "insert" | "duplicate" | "error" {
  const external = state.byExternalId.get(externalId);
  if (external) {
    if (external.deletedAt) {
      errors.push({ domain, rowIndex, code: "existing_record_deleted" });
      return "error";
    }
    if (external.importFingerprint === fingerprint) return "duplicate";
    errors.push({ domain, rowIndex, code: "source_identity_conflict" });
    return "error";
  }
  const samePayload = state.byFingerprint.get(fingerprint);
  if (samePayload) {
    if (samePayload.deletedAt) {
      errors.push({ domain, rowIndex, code: "existing_record_deleted" });
      return "error";
    }
    errors.push({ domain, rowIndex, code: "fingerprint_conflict" });
    return "error";
  }
  return "insert";
}

function addPlannedIdentity(
  state: IdentityState,
  id: string,
  externalId: string,
  fingerprint: string,
) {
  const row = { id, externalId, importFingerprint: fingerprint, deletedAt: null };
  state.byExternalId.set(externalId, row);
  state.byFingerprint.set(fingerprint, row);
}

async function importedOwnerMap(
  db: Database,
  table: any,
  practiceId: string,
  source: string,
): Promise<Map<string, string>> {
  const rows = (await db
    .select({ id: table.id, externalId: table.externalId })
    .from(table)
    .where(
      and(
        eq(table.practiceId, practiceId),
        eq(table.externalSource, source),
        isNull(table.deletedAt),
      ),
    )) as Array<{ id: string; externalId: string | null }>;
  return new Map(
    rows
      .filter((row): row is { id: string; externalId: string } => !!row.externalId)
      .map((row) => [row.externalId, row.id]),
  );
}

function domainPlan(
  mode: HistoryDomain,
  sourceRecords: readonly unknown[],
): PlannedDomain {
  const payload = canonicalPayload(sourceRecords);
  return {
    mode,
    sourceRows: sourceRecords.length,
    rows: [],
    duplicateCount: 0,
    unmatchedCount: 0,
    inRecordCount: 0,
    archiveOnlyCount: 0,
    needsReviewCount: 0,
    placements: [],
    errors: [],
    sourcePayloadHash: payload.hash,
    sourcePayloadSizeBytes: payload.size,
    reviewedPlanHash: "",
  };
}

function trackError(plan: PlannedDomain, rowIndex: number) {
  plan.placements.push({ rowIndex, action: "error" });
}

function rejectRow(
  plan: PlannedDomain,
  rowIndex: number,
  code: HistoryImportError["code"],
) {
  plan.errors.push({ domain: plan.mode, rowIndex, code });
  trackError(plan, rowIndex);
}

function trackPlaced(
  plan: PlannedDomain,
  rowIndex: number,
  action: "insert" | "duplicate",
  placement: HistoryPlacement,
) {
  if (action === "duplicate") plan.duplicateCount++;
  plan.placements.push({ rowIndex, action, placement });
  if (placement === "in_record") plan.inRecordCount++;
  else if (placement === "archive_only") plan.archiveOnlyCount++;
  else plan.needsReviewCount++;
}

/** Returns true only when the caller should append an insert row. */
function continueInsert(
  plan: PlannedDomain,
  rowIndex: number,
  action: "insert" | "duplicate" | "error",
  placement: HistoryPlacement,
): boolean {
  if (action === "error") {
    trackError(plan, rowIndex);
    return false;
  }
  trackPlaced(plan, rowIndex, action, placement);
  return action === "insert";
}

function date(value: string | undefined): Date | null {
  return value ? new Date(value) : null;
}

function checkedId(
  map: Map<string, string>,
  externalId: string | undefined,
): string | null {
  return externalId ? (map.get(externalId) ?? null) : null;
}

function bindDomainReview(
  domain: PlannedDomain,
  source: string,
) {
  reconcileHistoricalPlacement({
    sourceRows: domain.sourceRows,
    inRecord: domain.inRecordCount,
    archiveOnly: domain.archiveOnlyCount,
    needsReview: domain.needsReviewCount,
    errorCount: domain.errors.length,
  });
  if (domain.placements.length !== domain.sourceRows) {
    throw new HistoricalImportError(
      "Historical placement rows do not reconcile.",
    );
  }
  domain.reviewedPlanHash = historicalDomainReviewedPlanHash({
    mode: domain.mode,
    source,
    sourcePayloadHash: domain.sourcePayloadHash,
    sourceRows: domain.sourceRows,
    plannedInsertCount: domain.rows.length,
    duplicateCount: domain.duplicateCount,
    unmatchedCount: domain.unmatchedCount,
    errorCount: domain.errors.length,
    inRecord: domain.inRecordCount,
    archiveOnly: domain.archiveOnlyCount,
    needsReview: domain.needsReviewCount,
    entityKind: historicalEntityKind(domain.mode),
    placements: domain.placements,
  });
}

export async function planHistoricalImport(
  db: Database,
  input: {
    practiceId: string;
    source: string;
    records: HistoryInput;
  },
): Promise<HistoricalImportPlan> {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(input.source)) {
    throw new HistoricalImportError("Migration source is invalid.");
  }

  const clientIds = await importedOwnerMap(
    db,
    clients,
    input.practiceId,
    input.source,
  );
  const patientIds = await importedOwnerMap(
    db,
    patients,
    input.practiceId,
    input.source,
  );

  const contacts = domainPlan("client_contacts", input.records.clientContacts);
  const contactState = await existingIdentityState(
    db,
    clientContacts,
    input.practiceId,
    input.source,
  );
  input.records.clientContacts.forEach(
    (record: ClientContactImportRecord, rowIndex) => {
      const clientId = checkedId(clientIds, record.externalClientId);
      const unmatched = record.attributionStatus === "needs_review";
      if (unmatched) contacts.unmatchedCount++;
      if (!unmatched && !clientId) {
        rejectRow(contacts, rowIndex, "missing_client");
        return;
      }
      const fingerprint = recordFingerprint(
        contacts.mode,
        input.source,
        record.externalContactId,
        [
          record.externalClientId,
          record.attributionStatus,
          record.kind,
          record.firstName,
          record.lastName,
          record.email?.toLowerCase(),
          record.phone,
        ],
      );
      const action = classifyIdentity(
        contacts.mode,
        rowIndex,
        record.externalContactId,
        fingerprint,
        contactState,
        contacts.errors,
      );
      const placement = classifyHistoricalPlacement({
        domain: contacts.mode,
        unmatched,
      });
      if (!continueInsert(contacts, rowIndex, action, placement)) return;
      const id = randomUUID();
      contacts.rows.push({
        id,
        practiceId: input.practiceId,
        clientId,
        attributionStatus: unmatched ? "needs_review" : "matched",
        kind: record.kind,
        firstName: record.firstName ?? null,
        lastName: record.lastName ?? null,
        email: record.email ?? null,
        phone: record.phone ?? null,
        externalSource: input.source,
        externalId: record.externalContactId,
        importFingerprint: fingerprint,
      });
      addPlannedIdentity(contactState, id, record.externalContactId, fingerprint);
    },
  );

  const appointmentsPlan = domainPlan(
    "historical_appointments",
    input.records.historicalAppointments,
  );
  const appointmentState = await existingIdentityState(
    db,
    historicalAppointments,
    input.practiceId,
    input.source,
  );
  input.records.historicalAppointments.forEach(
    (record: HistoricalAppointmentImportRecord, rowIndex) => {
      const clientId = checkedId(clientIds, record.externalClientId);
      const patientId = checkedId(patientIds, record.externalPatientId);
      if (!clientId || !patientId) {
        rejectRow(
          appointmentsPlan,
          rowIndex,
          clientId ? "missing_patient" : "missing_client",
        );
        return;
      }
      const fingerprint = recordFingerprint(
        appointmentsPlan.mode,
        input.source,
        record.externalAppointmentId,
        [
          record.externalClientId,
          record.externalPatientId,
          record.startedAt,
          record.endedAt,
          record.status,
          record.appointmentType,
          record.reason,
          record.notes,
        ],
      );
      const action = classifyIdentity(
        appointmentsPlan.mode,
        rowIndex,
        record.externalAppointmentId,
        fingerprint,
        appointmentState,
        appointmentsPlan.errors,
      );
      const placement = classifyHistoricalPlacement({
        domain: appointmentsPlan.mode,
        unmatched: false,
      });
      if (!continueInsert(appointmentsPlan, rowIndex, action, placement)) return;
      const id = randomUUID();
      appointmentsPlan.rows.push({
        id,
        practiceId: input.practiceId,
        patientId,
        clientId,
        startedAt: new Date(record.startedAt),
        endedAt: new Date(record.endedAt),
        status: record.status,
        appointmentType: record.appointmentType ?? null,
        reason: record.reason ?? null,
        notes: record.notes ?? null,
        externalSource: input.source,
        externalId: record.externalAppointmentId,
        importFingerprint: fingerprint,
      });
      addPlannedIdentity(
        appointmentState,
        id,
        record.externalAppointmentId,
        fingerprint,
      );
    },
  );

  const prescriptionsPlan = domainPlan(
    "external_prescriptions",
    input.records.externalPrescriptions,
  );
  const prescriptionState = await existingIdentityState(
    db,
    externalPrescriptions,
    input.practiceId,
    input.source,
  );
  const prescriptionIds = new Map(
    [...prescriptionState.byExternalId].map(([externalId, row]) => [
      externalId,
      row.id,
    ]),
  );
  input.records.externalPrescriptions.forEach(
    (record: ExternalPrescriptionImportRecord, rowIndex) => {
      const patientId = checkedId(patientIds, record.externalPatientId);
      if (!patientId) {
        rejectRow(prescriptionsPlan, rowIndex, "missing_patient");
        return;
      }
      const fingerprint = recordFingerprint(
        prescriptionsPlan.mode,
        input.source,
        record.externalPrescriptionId,
        [
          record.externalPatientId,
          record.medicationName,
          record.directions,
          record.quantity,
          record.refillCount,
          record.prescribedAt,
          record.expiresAt,
          record.status,
          record.isChronic,
        ],
      );
      const action = classifyIdentity(
        prescriptionsPlan.mode,
        rowIndex,
        record.externalPrescriptionId,
        fingerprint,
        prescriptionState,
        prescriptionsPlan.errors,
      );
      const placement = classifyHistoricalPlacement({
        domain: prescriptionsPlan.mode,
        unmatched: false,
      });
      if (!continueInsert(prescriptionsPlan, rowIndex, action, placement)) {
        return;
      }
      const id = randomUUID();
      prescriptionsPlan.rows.push({
        id,
        practiceId: input.practiceId,
        patientId,
        medicationName: record.medicationName,
        directions: record.directions ?? null,
        quantity: record.quantity ?? null,
        refillCount: record.refillCount ?? null,
        prescribedAt: date(record.prescribedAt),
        expiresAt: date(record.expiresAt),
        status: record.status,
        isChronic: record.isChronic,
        reviewStatus: "unreviewed",
        externalSource: input.source,
        externalId: record.externalPrescriptionId,
        importFingerprint: fingerprint,
      });
      prescriptionIds.set(record.externalPrescriptionId, id);
      addPlannedIdentity(
        prescriptionState,
        id,
        record.externalPrescriptionId,
        fingerprint,
      );
    },
  );

  const fillsPlan = domainPlan(
    "external_prescription_fills",
    input.records.externalPrescriptionFills,
  );
  const fillState = await existingIdentityState(
    db,
    externalPrescriptionFills,
    input.practiceId,
    input.source,
  );
  input.records.externalPrescriptionFills.forEach(
    (record: ExternalPrescriptionFillImportRecord, rowIndex) => {
      const prescriptionId = prescriptionIds.get(record.externalPrescriptionId);
      if (!prescriptionId) {
        rejectRow(fillsPlan, rowIndex, "missing_parent");
        return;
      }
      const fingerprint = recordFingerprint(
        fillsPlan.mode,
        input.source,
        record.externalFillId,
        [
          record.externalPrescriptionId,
          record.filledAt,
          record.quantityDispensed,
          record.directions,
          record.sourceStatus,
        ],
      );
      const action = classifyIdentity(
        fillsPlan.mode,
        rowIndex,
        record.externalFillId,
        fingerprint,
        fillState,
        fillsPlan.errors,
      );
      const placement = classifyHistoricalPlacement({
        domain: fillsPlan.mode,
        unmatched: false,
      });
      if (!continueInsert(fillsPlan, rowIndex, action, placement)) return;
      const id = randomUUID();
      fillsPlan.rows.push({
        id,
        practiceId: input.practiceId,
        prescriptionId,
        filledAt: date(record.filledAt),
        quantityDispensed: record.quantityDispensed ?? null,
        directions: record.directions ?? null,
        sourceStatus: record.sourceStatus ?? null,
        externalSource: input.source,
        externalId: record.externalFillId,
        importFingerprint: fingerprint,
      });
      addPlannedIdentity(fillState, id, record.externalFillId, fingerprint);
    },
  );

  const labReportsPlan = domainPlan(
    "external_lab_reports",
    input.records.externalLabReports,
  );
  const labReportState = await existingIdentityState(
    db,
    externalLabReports,
    input.practiceId,
    input.source,
    { withAttribution: true },
  );
  const labReportIds = new Map(
    [...labReportState.byExternalId].map(([externalId, row]) => [
      externalId,
      row.id,
    ]),
  );
  const reportPlacement = new Map<string, HistoryPlacement>(
    [...labReportState.byExternalId].map(([externalId, row]) => [
      externalId,
      row.attributionStatus === "needs_review" ? "needs_review" : "in_record",
    ]),
  );
  input.records.externalLabReports.forEach(
    (record: ExternalLabReportImportRecord, rowIndex) => {
      const patientId = checkedId(patientIds, record.externalPatientId);
      const unmatched = record.attributionStatus === "needs_review";
      if (unmatched) labReportsPlan.unmatchedCount++;
      if (!unmatched && !patientId) {
        rejectRow(labReportsPlan, rowIndex, "missing_patient");
        return;
      }
      const fingerprint = recordFingerprint(
        labReportsPlan.mode,
        input.source,
        record.externalLabReportId,
        [
          record.externalPatientId,
          record.attributionStatus,
          record.orderedAt,
          record.resultedAt,
          record.status,
          record.orderName,
          record.accessionNumber,
          record.summary,
        ],
      );
      const action = classifyIdentity(
        labReportsPlan.mode,
        rowIndex,
        record.externalLabReportId,
        fingerprint,
        labReportState,
        labReportsPlan.errors,
      );
      const placement = classifyHistoricalPlacement({
        domain: labReportsPlan.mode,
        unmatched,
      });
      if (action !== "error") {
        reportPlacement.set(record.externalLabReportId, placement);
      }
      if (!continueInsert(labReportsPlan, rowIndex, action, placement)) return;
      const id = randomUUID();
      labReportsPlan.rows.push({
        id,
        practiceId: input.practiceId,
        patientId,
        attributionStatus: unmatched ? "needs_review" : "matched",
        orderedAt: date(record.orderedAt),
        resultedAt: date(record.resultedAt),
        status: record.status,
        orderName: record.orderName ?? null,
        accessionNumber: record.accessionNumber ?? null,
        summary: record.summary ?? null,
        reviewStatus: "unreviewed",
        externalSource: input.source,
        externalId: record.externalLabReportId,
        importFingerprint: fingerprint,
      });
      labReportIds.set(record.externalLabReportId, id);
      addPlannedIdentity(
        labReportState,
        id,
        record.externalLabReportId,
        fingerprint,
      );
    },
  );

  const observationsPlan = domainPlan(
    "external_lab_observations",
    input.records.externalLabObservations,
  );
  const observationState = await existingIdentityState(
    db,
    externalLabObservations,
    input.practiceId,
    input.source,
  );
  input.records.externalLabObservations.forEach(
    (record: ExternalLabObservationImportRecord, rowIndex) => {
      const reportId = labReportIds.get(record.externalLabReportId);
      const parentPlacement = reportPlacement.get(record.externalLabReportId);
      if (!reportId || !parentPlacement) {
        rejectRow(observationsPlan, rowIndex, "missing_parent");
        return;
      }
      const fingerprint = recordFingerprint(
        observationsPlan.mode,
        input.source,
        record.externalObservationId,
        [
          record.externalLabReportId,
          record.sortOrder,
          record.name,
          record.value,
          record.unit,
          record.referenceRange,
          record.flag,
        ],
      );
      const action = classifyIdentity(
        observationsPlan.mode,
        rowIndex,
        record.externalObservationId,
        fingerprint,
        observationState,
        observationsPlan.errors,
      );
      const placement = classifyHistoricalPlacement({
        domain: observationsPlan.mode,
        unmatched: parentPlacement === "needs_review",
        scalarLab: mapScalarLabObservation(record) !== null,
      });
      if (!continueInsert(observationsPlan, rowIndex, action, placement)) return;
      const id = randomUUID();
      observationsPlan.rows.push({
        id,
        practiceId: input.practiceId,
        reportId,
        sortOrder: record.sortOrder,
        name: record.name,
        value: record.value ?? null,
        unit: record.unit ?? null,
        referenceRange: record.referenceRange ?? null,
        flag: record.flag ?? null,
        externalSource: input.source,
        externalId: record.externalObservationId,
        importFingerprint: fingerprint,
      });
      addPlannedIdentity(
        observationState,
        id,
        record.externalObservationId,
        fingerprint,
      );
    },
  );

  const documentsPlan = domainPlan(
    "legacy_financial_documents",
    input.records.legacyFinancialDocuments,
  );
  const documentState = await existingIdentityState(
    db,
    legacyFinancialDocuments,
    input.practiceId,
    input.source,
  );
  const documentIds = new Map(
    [...documentState.byExternalId].map(([externalId, row]) => [
      externalId,
      row.id,
    ]),
  );
  input.records.legacyFinancialDocuments.forEach(
    (record: LegacyFinancialDocumentImportRecord, rowIndex) => {
      const clientId = checkedId(clientIds, record.externalClientId);
      const patientId = checkedId(patientIds, record.externalPatientId);
      if (!clientId || (record.externalPatientId && !patientId)) {
        rejectRow(
          documentsPlan,
          rowIndex,
          clientId ? "missing_patient" : "missing_client",
        );
        return;
      }
      const fingerprint = recordFingerprint(
        documentsPlan.mode,
        input.source,
        record.externalDocumentId,
        [
          record.externalClientId,
          record.externalPatientId,
          record.documentType,
          record.documentNumber,
          record.issuedAt,
          record.status,
          record.subtotal,
          record.tax,
          record.discount,
          record.total,
          record.paidAmount,
          record.balance,
          record.sourceStatus,
        ],
      );
      const action = classifyIdentity(
        documentsPlan.mode,
        rowIndex,
        record.externalDocumentId,
        fingerprint,
        documentState,
        documentsPlan.errors,
      );
      const placement = classifyHistoricalPlacement({
        domain: documentsPlan.mode,
        unmatched: false,
      });
      if (!continueInsert(documentsPlan, rowIndex, action, placement)) return;
      const id = randomUUID();
      documentsPlan.rows.push({
        id,
        practiceId: input.practiceId,
        clientId,
        patientId,
        documentType: record.documentType,
        documentNumber: record.documentNumber ?? null,
        issuedAt: new Date(record.issuedAt),
        status: record.status,
        subtotal: record.subtotal,
        tax: record.tax,
        discount: record.discount,
        total: record.total,
        paidAmount: record.paidAmount,
        balance: record.balance,
        sourceStatus: record.sourceStatus ?? null,
        externalSource: input.source,
        externalId: record.externalDocumentId,
        importFingerprint: fingerprint,
      });
      documentIds.set(record.externalDocumentId, id);
      addPlannedIdentity(
        documentState,
        id,
        record.externalDocumentId,
        fingerprint,
      );
    },
  );

  const lineItemsPlan = domainPlan(
    "legacy_financial_line_items",
    input.records.legacyFinancialLineItems,
  );
  const lineItemState = await existingIdentityState(
    db,
    legacyFinancialLineItems,
    input.practiceId,
    input.source,
  );
  input.records.legacyFinancialLineItems.forEach(
    (record: LegacyFinancialLineItemImportRecord, rowIndex) => {
      const documentId = documentIds.get(record.externalDocumentId);
      const patientId = checkedId(patientIds, record.externalPatientId);
      if (!documentId || (record.externalPatientId && !patientId)) {
        rejectRow(
          lineItemsPlan,
          rowIndex,
          documentId ? "missing_patient" : "missing_parent",
        );
        return;
      }
      const fingerprint = recordFingerprint(
        lineItemsPlan.mode,
        input.source,
        record.externalLineItemId,
        [
          record.externalDocumentId,
          record.externalPatientId,
          record.sortOrder,
          record.description,
          record.quantity,
          record.unitPrice,
          record.subtotal,
          record.tax,
          record.discount,
          record.total,
        ],
      );
      const action = classifyIdentity(
        lineItemsPlan.mode,
        rowIndex,
        record.externalLineItemId,
        fingerprint,
        lineItemState,
        lineItemsPlan.errors,
      );
      const placement = classifyHistoricalPlacement({
        domain: lineItemsPlan.mode,
        unmatched: false,
      });
      if (!continueInsert(lineItemsPlan, rowIndex, action, placement)) return;
      const id = randomUUID();
      lineItemsPlan.rows.push({
        id,
        practiceId: input.practiceId,
        documentId,
        patientId,
        sortOrder: record.sortOrder,
        description: record.description,
        quantity: record.quantity,
        unitPrice: record.unitPrice,
        subtotal: record.subtotal,
        tax: record.tax,
        discount: record.discount,
        total: record.total,
        externalSource: input.source,
        externalId: record.externalLineItemId,
        importFingerprint: fingerprint,
      });
      addPlannedIdentity(
        lineItemState,
        id,
        record.externalLineItemId,
        fingerprint,
      );
    },
  );

  const paymentsPlan = domainPlan(
    "legacy_financial_payments",
    input.records.legacyFinancialPayments,
  );
  const paymentState = await existingIdentityState(
    db,
    legacyFinancialPayments,
    input.practiceId,
    input.source,
  );
  const paymentIds = new Map(
    [...paymentState.byExternalId].map(([externalId, row]) => [
      externalId,
      row.id,
    ]),
  );
  input.records.legacyFinancialPayments.forEach(
    (record: LegacyFinancialPaymentImportRecord, rowIndex) => {
      const clientId = checkedId(clientIds, record.externalClientId);
      const unmatched = record.attributionStatus === "needs_review";
      if (unmatched) paymentsPlan.unmatchedCount++;
      if (!unmatched && !clientId) {
        rejectRow(paymentsPlan, rowIndex, "missing_client");
        return;
      }
      const fingerprint = recordFingerprint(
        paymentsPlan.mode,
        input.source,
        record.externalPaymentId,
        [
          record.externalClientId,
          record.attributionStatus,
          record.entryType,
          record.amount,
          record.receivedAt,
          record.method,
          record.sourceStatus,
          record.reference,
          record.note,
        ],
      );
      const action = classifyIdentity(
        paymentsPlan.mode,
        rowIndex,
        record.externalPaymentId,
        fingerprint,
        paymentState,
        paymentsPlan.errors,
      );
      const placement = classifyHistoricalPlacement({
        domain: paymentsPlan.mode,
        unmatched,
      });
      if (!continueInsert(paymentsPlan, rowIndex, action, placement)) return;
      const id = randomUUID();
      paymentsPlan.rows.push({
        id,
        practiceId: input.practiceId,
        clientId,
        attributionStatus: unmatched ? "needs_review" : "matched",
        entryType: record.entryType,
        amount: record.amount,
        receivedAt: new Date(record.receivedAt),
        method: record.method ?? null,
        sourceStatus: record.sourceStatus ?? null,
        reference: record.reference ?? null,
        note: record.note ?? null,
        externalSource: input.source,
        externalId: record.externalPaymentId,
        importFingerprint: fingerprint,
      });
      paymentIds.set(record.externalPaymentId, id);
      addPlannedIdentity(
        paymentState,
        id,
        record.externalPaymentId,
        fingerprint,
      );
    },
  );

  const allocationsPlan = domainPlan(
    "legacy_financial_allocations",
    input.records.legacyFinancialAllocations,
  );
  const allocationState = await existingIdentityState(
    db,
    legacyFinancialAllocations,
    input.practiceId,
    input.source,
  );
  input.records.legacyFinancialAllocations.forEach(
    (record: LegacyFinancialAllocationImportRecord, rowIndex) => {
      const documentId = documentIds.get(record.externalDocumentId);
      const paymentId = paymentIds.get(record.externalPaymentId);
      if (!documentId || !paymentId) {
        rejectRow(allocationsPlan, rowIndex, "missing_parent");
        return;
      }
      const fingerprint = recordFingerprint(
        allocationsPlan.mode,
        input.source,
        record.externalAllocationId,
        [
          record.externalDocumentId,
          record.externalPaymentId,
          record.amount,
          record.allocatedAt,
          record.description,
        ],
      );
      const action = classifyIdentity(
        allocationsPlan.mode,
        rowIndex,
        record.externalAllocationId,
        fingerprint,
        allocationState,
        allocationsPlan.errors,
      );
      const placement = classifyHistoricalPlacement({
        domain: allocationsPlan.mode,
        unmatched: false,
      });
      if (!continueInsert(allocationsPlan, rowIndex, action, placement)) return;
      const id = randomUUID();
      allocationsPlan.rows.push({
        id,
        practiceId: input.practiceId,
        documentId,
        paymentId,
        amount: record.amount,
        allocatedAt: date(record.allocatedAt),
        description: record.description ?? null,
        externalSource: input.source,
        externalId: record.externalAllocationId,
        importFingerprint: fingerprint,
      });
      addPlannedIdentity(
        allocationState,
        id,
        record.externalAllocationId,
        fingerprint,
      );
    },
  );

  const domains = [
    contacts,
    appointmentsPlan,
    prescriptionsPlan,
    fillsPlan,
    labReportsPlan,
    observationsPlan,
    documentsPlan,
    lineItemsPlan,
    paymentsPlan,
    allocationsPlan,
  ];
  for (const domain of domains) {
    bindDomainReview(domain, input.source);
  }
  const errors = domains.flatMap((domain) => domain.errors);
  const totals = domains.reduce(
    (result, domain) => ({
      sourceRows: result.sourceRows + domain.sourceRows,
      plannedInsertCount: result.plannedInsertCount + domain.rows.length,
      duplicateCount: result.duplicateCount + domain.duplicateCount,
      unmatchedCount: result.unmatchedCount + domain.unmatchedCount,
      errorCount: result.errorCount + domain.errors.length,
      inRecordCount: result.inRecordCount + domain.inRecordCount,
      archiveOnlyCount: result.archiveOnlyCount + domain.archiveOnlyCount,
      needsReviewCount: result.needsReviewCount + domain.needsReviewCount,
    }),
    {
      sourceRows: 0,
      plannedInsertCount: 0,
      duplicateCount: 0,
      unmatchedCount: 0,
      errorCount: 0,
      inRecordCount: 0,
      archiveOnlyCount: 0,
      needsReviewCount: 0,
    },
  );
  reconcileHistoricalPlacement({
    sourceRows: totals.sourceRows,
    inRecord: totals.inRecordCount,
    archiveOnly: totals.archiveOnlyCount,
    needsReview: totals.needsReviewCount,
    errorCount: totals.errorCount,
  });
  return {
    version: HISTORY_IMPORT_PLAN_VERSION,
    practiceId: input.practiceId,
    source: input.source,
    planHash: aggregateHistoricalPlanHash({
      practiceId: input.practiceId,
      source: input.source,
      domains: domains.map((domain) => ({
        mode: domain.mode,
        reviewedPlanHash: domain.reviewedPlanHash,
      })),
    }),
    ready: errors.length === 0,
    totals,
    domains: domains.map((domain) => ({
      mode: domain.mode,
      sourceRows: domain.sourceRows,
      plannedInsertCount: domain.rows.length,
      duplicateCount: domain.duplicateCount,
      unmatchedCount: domain.unmatchedCount,
      errorCount: domain.errors.length,
      inRecordCount: domain.inRecordCount,
      archiveOnlyCount: domain.archiveOnlyCount,
      needsReviewCount: domain.needsReviewCount,
      sourcePayloadHash: domain.sourcePayloadHash,
      reviewedPlanHash: domain.reviewedPlanHash,
    })),
    errors,
    _domains: domains,
  };
}

/**
 * Archive tables this commit writes. Live appointments, prescriptions,
 * invoices, and lab results are intentionally absent: historical visits never
 * become calendar work, and imported medications are never dispensable.
 */
export const HISTORICAL_IMPORT_TARGET_TABLES = [
  "client_contacts",
  "historical_appointments",
  "external_prescriptions",
  "external_prescription_fills",
  "external_lab_reports",
  "external_lab_observations",
  "legacy_financial_documents",
  "legacy_financial_line_items",
  "legacy_financial_payments",
  "legacy_financial_allocations",
] as const;

const TABLE_BY_DOMAIN: Record<
  (typeof HISTORICAL_IMPORT_TARGET_TABLES)[number],
  any
> = {
  client_contacts: clientContacts,
  historical_appointments: historicalAppointments,
  external_prescriptions: externalPrescriptions,
  external_prescription_fills: externalPrescriptionFills,
  external_lab_reports: externalLabReports,
  external_lab_observations: externalLabObservations,
  legacy_financial_documents: legacyFinancialDocuments,
  legacy_financial_line_items: legacyFinancialLineItems,
  legacy_financial_payments: legacyFinancialPayments,
  legacy_financial_allocations: legacyFinancialAllocations,
};

async function insertChunks(
  db: Database,
  table: any,
  rows: Record<string, unknown>[],
) {
  for (let offset = 0; offset < rows.length; offset += 500) {
    await db.insert(table).values(rows.slice(offset, offset + 500) as any);
  }
}

/**
 * Commit the exact reviewed plan under the practice recovery hold. This path
 * never mutates live scheduling, accounts receivable, inventory, consent, or
 * provider state; it only appends source-attributed archive records.
 */
export async function commitHistoricalImport(
  db: Database,
  input: {
    practiceId: string;
    actorId: string;
    source: string;
    expectedPlanHash: string;
    records: HistoryInput;
  },
): Promise<HistoricalImportCommitResult> {
  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    const [practice] = await database
      .select({ id: practices.id, recoveryHold: practices.recoveryHold })
      .from(practices)
      .where(
        and(eq(practices.id, input.practiceId), isNull(practices.deletedAt)),
      )
      .limit(1)
      .for("update");
    if (!practice) throw new HistoricalImportError("Practice not found.");
    if (!practice.recoveryHold) {
      throw new HistoricalImportError(
        "Historical migration requires an active practice recovery hold.",
      );
    }

    const plan = await planHistoricalImport(database, input);
    if (!plan.ready) {
      throw new HistoricalImportError(
        "Historical migration plan contains unresolved structural errors.",
      );
    }
    if (plan.planHash !== input.expectedPlanHash) {
      throw new HistoricalImportError(
        "Historical migration plan changed after review.",
      );
    }

    const byDomain = Object.fromEntries(
      plan._domains.map((domain) => [domain.mode, 0]),
    ) as Record<HistoryDomain, number>;
    const now = new Date();
    let alreadyCommitted = true;

    for (const domain of plan._domains) {
      if (domain.sourceRows === 0) continue;
      const [prior] = await database
        .select({ id: migrationRuns.id })
        .from(migrationRuns)
        .where(
          and(
            eq(migrationRuns.practiceId, input.practiceId),
            eq(migrationRuns.mode, domain.mode),
            eq(migrationRuns.source, input.source),
            eq(migrationRuns.fileHash, domain.sourcePayloadHash),
            eq(migrationRuns.status, "committed"),
            isNull(migrationRuns.deletedAt),
          ),
        )
        .limit(1);
      if (prior) {
        if (domain.rows.length !== 0) {
          throw new HistoricalImportError(
            "Committed migration evidence does not match current archive rows.",
          );
        }
        continue;
      }

      alreadyCommitted = false;
      await insertChunks(database, TABLE_BY_DOMAIN[domain.mode], domain.rows);
      byDomain[domain.mode] = domain.rows.length;
      await database.insert(migrationRuns).values({
        id: randomUUID(),
        practiceId: input.practiceId,
        createdBy: input.actorId,
        committedBy: input.actorId,
        mode: domain.mode,
        source: input.source,
        fileHash: domain.sourcePayloadHash,
        reviewedPlanHash: domain.reviewedPlanHash,
        fileSizeBytes: domain.sourcePayloadSizeBytes,
        status: "committed",
        sourceRowCount: domain.sourceRows,
        plannedInsertCount: domain.rows.length,
        duplicateCount: domain.duplicateCount,
        unmatchedCount: domain.unmatchedCount,
        errorCount: domain.errors.length,
        importedCount: domain.rows.length,
        previewExpiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        committedAt: now,
      });
    }

    return {
      planHash: plan.planHash,
      alreadyCommitted,
      importedCount: Object.values(byDomain).reduce(
        (sum, count) => sum + count,
        0,
      ),
      duplicateCount: plan.totals.duplicateCount,
      unmatchedCount: plan.totals.unmatchedCount,
      byDomain,
    };
  });
}
