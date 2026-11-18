import { createHash } from "node:crypto";
import {
  migrationReviewedPlanHash,
  type MigrationChartPlacement,
  type MigrationReviewedDisposition,
  type MigrationRunMode,
} from "./run-ledger";

export const HISTORY_IMPORT_PLAN_VERSION = "history-v2";

export type HistoryDomain =
  | "client_contacts"
  | "historical_appointments"
  | "external_prescriptions"
  | "external_prescription_fills"
  | "external_lab_reports"
  | "external_lab_observations"
  | "legacy_financial_documents"
  | "legacy_financial_line_items"
  | "legacy_financial_payments"
  | "legacy_financial_allocations";

export type HistoryPlacement = MigrationChartPlacement;

const ENTITY_KIND: Record<HistoryDomain, MigrationReviewedDisposition["entityKind"]> = {
  client_contacts: "client_contact",
  historical_appointments: "historical_appointment",
  external_prescriptions: "external_prescription",
  external_prescription_fills: "external_prescription_fill",
  external_lab_reports: "external_lab_report",
  external_lab_observations: "external_lab_observation",
  legacy_financial_documents: "legacy_financial_document",
  legacy_financial_line_items: "legacy_financial_line_item",
  legacy_financial_payments: "legacy_financial_payment",
  legacy_financial_allocations: "legacy_financial_allocation",
};

export interface ScalarLabResult {
  testName: string;
  resultValue: string;
  unit: string | null;
  referenceRangeLow: string | null;
  referenceRangeHigh: string | null;
  resultFlag: "unknown" | "normal" | "abnormal" | "critical";
}

const LAB_FLAGS: Record<string, ScalarLabResult["resultFlag"]> = {
  unknown: "unknown",
  normal: "normal",
  n: "normal",
  abnormal: "abnormal",
  h: "abnormal",
  l: "abnormal",
  high: "abnormal",
  low: "abnormal",
  critical: "critical",
  hh: "critical",
  ll: "critical",
  panic: "critical",
};

/**
 * Project one source observation onto OpenVPM's scalar lab result.
 * Returns null when the source would lose meaning: panels, free-text ranges,
 * unknown flags, or values that do not fit the lab result columns.
 */
export function mapScalarLabObservation(input: {
  name?: string | null;
  value?: string | null;
  unit?: string | null;
  referenceRange?: string | null;
  flag?: string | null;
}): ScalarLabResult | null {
  const testName = input.name?.trim() ?? "";
  const resultValue = input.value?.trim() ?? "";
  if (!testName || testName.length > 255) return null;
  if (!resultValue || resultValue.length > 128) return null;
  if (/[\r\n;|]/.test(resultValue)) return null;

  const unitText = input.unit?.trim() ?? "";
  if (unitText.length > 32) return null;

  const rangeText = input.referenceRange?.trim() ?? "";
  let referenceRangeLow: string | null = null;
  let referenceRangeHigh: string | null = null;
  if (rangeText) {
    const match = rangeText.match(
      /^(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)$/,
    );
    if (!match) return null;
    const low = Number(match[1]);
    const high = Number(match[2]);
    if (!Number.isFinite(low) || !Number.isFinite(high) || low > high) return null;
    if (!fitsNumeric10Scale3(low) || !fitsNumeric10Scale3(high)) return null;
    referenceRangeLow = low.toFixed(3);
    referenceRangeHigh = high.toFixed(3);
  }

  const flagKey = input.flag?.trim().toLowerCase() ?? "";
  const resultFlag = flagKey ? LAB_FLAGS[flagKey] : "unknown";
  if (!resultFlag) return null;

  return {
    testName,
    resultValue,
    unit: unitText || null,
    referenceRangeLow,
    referenceRangeHigh,
    resultFlag,
  };
}

function fitsNumeric10Scale3(value: number): boolean {
  return Math.abs(value) < 10_000_000;
}

export function classifyHistoricalPlacement(input: {
  domain: HistoryDomain;
  unmatched: boolean;
  scalarLab?: boolean;
}): HistoryPlacement {
  switch (input.domain) {
    case "historical_appointments":
    case "external_prescriptions":
    case "external_prescription_fills":
      return "in_record";
    case "client_contacts":
    case "legacy_financial_payments":
      return input.unmatched ? "needs_review" : "archive_only";
    case "legacy_financial_documents":
    case "legacy_financial_line_items":
    case "legacy_financial_allocations":
      return "archive_only";
    case "external_lab_reports":
      return input.unmatched ? "needs_review" : "in_record";
    case "external_lab_observations":
      if (input.unmatched) return "needs_review";
      return input.scalarLab ? "in_record" : "archive_only";
    default:
      return "archive_only";
  }
}

export function reconcileHistoricalPlacement(counts: {
  sourceRows: number;
  inRecord: number;
  archiveOnly: number;
  needsReview: number;
  errorCount: number;
}): void {
  if (
    counts.inRecord + counts.archiveOnly + counts.needsReview + counts.errorCount !==
    counts.sourceRows
  ) {
    throw new Error("Historical placement counts must reconcile exactly.");
  }
}

export interface HistoricalPlacementRow {
  rowIndex: number;
  action: "insert" | "duplicate" | "error";
  placement?: HistoryPlacement;
}

export function historicalDomainReviewedPlanHash(input: {
  mode: MigrationRunMode;
  source: string;
  sourcePayloadHash: string;
  sourceRows: number;
  plannedInsertCount: number;
  duplicateCount: number;
  unmatchedCount: number;
  errorCount: number;
  inRecord: number;
  archiveOnly: number;
  needsReview: number;
  entityKind: MigrationReviewedDisposition["entityKind"];
  placements: readonly HistoricalPlacementRow[];
}): string {
  reconcileHistoricalPlacement({
    sourceRows: input.sourceRows,
    inRecord: input.inRecord,
    archiveOnly: input.archiveOnly,
    needsReview: input.needsReview,
    errorCount: input.errorCount,
  });
  return migrationReviewedPlanHash({
    mode: input.mode,
    source: input.source,
    csv: input.sourcePayloadHash,
    summary: {
      sourceRowCount: input.sourceRows,
      plannedInsertCount: input.plannedInsertCount,
      duplicateCount: input.duplicateCount,
      unmatchedCount: input.unmatchedCount,
      errorCount: input.errorCount,
    },
    reviewedPlan: {
      plannerVersion: HISTORY_IMPORT_PLAN_VERSION,
      placementCounts: {
        inRecord: input.inRecord,
        archiveOnly: input.archiveOnly,
        needsReview: input.needsReview,
      },
      dispositions: input.placements.map((row) => ({
        rowIndex: row.rowIndex,
        entityKind: input.entityKind,
        action: row.action,
        ...(row.placement ? { placement: row.placement } : {}),
      })),
      targets: [],
    },
  });
}

export function historicalEntityKind(
  domain: HistoryDomain,
): MigrationReviewedDisposition["entityKind"] {
  return ENTITY_KIND[domain];
}

export function aggregateHistoricalPlanHash(input: {
  practiceId: string;
  source: string;
  domains: readonly { mode: string; reviewedPlanHash: string }[];
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: HISTORY_IMPORT_PLAN_VERSION,
        practiceId: input.practiceId,
        source: input.source,
        domains: input.domains,
      }),
      "utf8",
    )
    .digest("hex");
}

export function importedSourceBadge(source: string): string {
  return source === "shepherd" ? "Imported from Shepherd" : "Imported";
}
