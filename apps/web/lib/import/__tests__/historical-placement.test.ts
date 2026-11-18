import { describe, expect, it } from "vitest";
import type { Database } from "@openpims/db/client";
import {
  HISTORICAL_IMPORT_TARGET_TABLES,
  planHistoricalImport,
} from "../history-import";
import {
  aggregateHistoricalPlanHash,
  classifyHistoricalPlacement,
  historicalDomainReviewedPlanHash,
  mapScalarLabObservation,
  reconcileHistoricalPlacement,
} from "../historical-placement";
import { migrationReviewedPlanHash } from "../run-ledger";

const PRACTICE_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = "22222222-2222-4222-8222-222222222222";
const PATIENT_ID = "33333333-3333-4333-8333-333333333333";

function emptyDatabase(script: unknown[][] = []): Database {
  let call = 0;
  const chain = {
    from() {
      return chain;
    },
    where() {
      const rows = script[call] ?? [];
      call += 1;
      return Promise.resolve(rows);
    },
  };
  return { select: () => chain } as unknown as Database;
}

function owners(): unknown[][] {
  return [
    [{ id: CLIENT_ID, externalId: "owner-1" }],
    [{ id: PATIENT_ID, externalId: "patient-1" }],
  ];
}

describe("scalar lab mapping", () => {
  it("maps a single numeric result and rejects panels and free-text ranges", () => {
    expect(
      mapScalarLabObservation({
        name: "ALT",
        value: "42",
        unit: "U/L",
        referenceRange: "10-40",
        flag: "H",
      }),
    ).toEqual({
      testName: "ALT",
      resultValue: "42",
      unit: "U/L",
      referenceRangeLow: "10.000",
      referenceRangeHigh: "40.000",
      resultFlag: "abnormal",
    });
    expect(
      mapScalarLabObservation({
        name: "CBC",
        value: "WBC 5.1; RBC 6.2",
        unit: "",
      }),
    ).toBeNull();
    expect(
      mapScalarLabObservation({
        name: "ALT",
        value: "42",
        referenceRange: "see chart",
      }),
    ).toBeNull();
    expect(
      mapScalarLabObservation({
        name: "Snap",
        value: "Positive",
      }),
    ).toMatchObject({ resultValue: "Positive", resultFlag: "unknown" });
  });
});

describe("historical placement", () => {
  it("keeps financial rows archive-only and linked visits in the chart", () => {
    expect(
      classifyHistoricalPlacement({
        domain: "historical_appointments",
        unmatched: false,
      }),
    ).toBe("in_record");
    expect(
      classifyHistoricalPlacement({
        domain: "legacy_financial_documents",
        unmatched: false,
      }),
    ).toBe("archive_only");
    expect(
      classifyHistoricalPlacement({
        domain: "external_lab_reports",
        unmatched: true,
      }),
    ).toBe("needs_review");
    expect(
      classifyHistoricalPlacement({
        domain: "external_lab_observations",
        unmatched: false,
        scalarLab: false,
      }),
    ).toBe("archive_only");
  });

  it("rejects placement totals that do not add up", () => {
    expect(() =>
      reconcileHistoricalPlacement({
        sourceRows: 3,
        inRecord: 1,
        archiveOnly: 1,
        needsReview: 0,
        errorCount: 0,
      }),
    ).toThrow(/reconcile exactly/);
  });

  it("binds placement counts to the reviewed-plan hash", () => {
    const base = {
      mode: "external_lab_observations" as const,
      source: "shepherd",
      sourcePayloadHash: "a".repeat(64),
      sourceRows: 2,
      plannedInsertCount: 2,
      duplicateCount: 0,
      unmatchedCount: 0,
      errorCount: 0,
      entityKind: "external_lab_observation" as const,
      placements: [
        { rowIndex: 0, action: "insert" as const, placement: "in_record" as const },
        {
          rowIndex: 1,
          action: "insert" as const,
          placement: "archive_only" as const,
        },
      ],
    };
    const inChart = historicalDomainReviewedPlanHash({
      ...base,
      inRecord: 1,
      archiveOnly: 1,
      needsReview: 0,
    });
    const swapped = historicalDomainReviewedPlanHash({
      ...base,
      inRecord: 0,
      archiveOnly: 2,
      needsReview: 0,
      placements: [
        { rowIndex: 0, action: "insert", placement: "archive_only" },
        { rowIndex: 1, action: "insert", placement: "archive_only" },
      ],
    });
    expect(inChart).not.toBe(swapped);

    const withoutPlacement = migrationReviewedPlanHash({
      mode: "patients",
      source: "shepherd",
      csv: "name\nSynthetic",
      summary: { sourceRowCount: 1, plannedInsertCount: 1, errorCount: 0 },
    });
    const withPlacement = migrationReviewedPlanHash({
      mode: "patients",
      source: "shepherd",
      csv: "name\nSynthetic",
      summary: { sourceRowCount: 1, plannedInsertCount: 1, errorCount: 0 },
      reviewedPlan: {
        plannerVersion: "history-v2",
        placementCounts: { inRecord: 1, archiveOnly: 0, needsReview: 0 },
        dispositions: [],
        targets: [],
      },
    });
    expect(withPlacement).not.toBe(withoutPlacement);
    expect(aggregateHistoricalPlanHash({
      practiceId: PRACTICE_ID,
      source: "shepherd",
      domains: [{ mode: "external_lab_observations", reviewedPlanHash: inChart }],
    })).not.toBe(
      aggregateHistoricalPlanHash({
        practiceId: PRACTICE_ID,
        source: "shepherd",
        domains: [{ mode: "external_lab_observations", reviewedPlanHash: swapped }],
      }),
    );
  });
});

describe("planHistoricalImport preview", () => {
  const records = {
    clientContacts: [],
    historicalAppointments: [
      {
        externalAppointmentId: "visit-1",
        externalClientId: "owner-1",
        externalPatientId: "patient-1",
        startedAt: "2024-01-10T14:00:00.000Z",
        endedAt: "2024-01-10T14:30:00.000Z",
        status: "completed" as const,
        appointmentType: "Wellness",
        reason: "Synthetic visit",
      },
    ],
    externalPrescriptions: [
      {
        externalPrescriptionId: "rx-1",
        externalPatientId: "patient-1",
        medicationName: "Medication Alpha",
        status: "completed" as const,
        isChronic: false,
      },
    ],
    externalPrescriptionFills: [
      {
        externalFillId: "fill-1",
        externalPrescriptionId: "rx-1",
        filledAt: "2024-02-01T10:00:00.000Z",
        quantityDispensed: "1.000",
      },
    ],
    externalLabReports: [
      {
        externalLabReportId: "lab-1",
        externalPatientId: "patient-1",
        attributionStatus: "matched" as const,
        status: "final" as const,
        orderName: "ALT",
      },
      {
        externalLabReportId: "lab-2",
        attributionStatus: "needs_review" as const,
        status: "unknown" as const,
      },
    ],
    externalLabObservations: [
      {
        externalObservationId: "obs-scalar",
        externalLabReportId: "lab-1",
        sortOrder: 0,
        name: "ALT",
        value: "42",
        unit: "U/L",
        referenceRange: "10-40",
        flag: "H",
      },
      {
        externalObservationId: "obs-panel",
        externalLabReportId: "lab-1",
        sortOrder: 1,
        name: "CBC",
        value: "WBC 5.1; RBC 6.2",
      },
      {
        externalObservationId: "obs-unlinked",
        externalLabReportId: "lab-2",
        sortOrder: 0,
        name: "ALT",
        value: "10",
      },
    ],
    legacyFinancialDocuments: [
      {
        externalDocumentId: "invoice-1",
        externalClientId: "owner-1",
        externalPatientId: "patient-1",
        documentType: "invoice" as const,
        issuedAt: "2024-01-10T15:00:00.000Z",
        status: "paid" as const,
        subtotal: "10.00",
        tax: "0.00",
        discount: "0.00",
        total: "10.00",
        paidAmount: "10.00",
        balance: "0.00",
      },
    ],
    legacyFinancialLineItems: [],
    legacyFinancialPayments: [],
    legacyFinancialAllocations: [],
  };

  it("reconciles in-record, archive-only, and needs-review counts", async () => {
    const plan = await planHistoricalImport(emptyDatabase(owners()), {
      practiceId: PRACTICE_ID,
      source: "shepherd",
      records,
    });

    expect(plan.ready).toBe(true);
    const byMode = Object.fromEntries(plan.domains.map((domain) => [domain.mode, domain]));
    expect(byMode.historical_appointments).toMatchObject({
      inRecordCount: 1,
      archiveOnlyCount: 0,
      needsReviewCount: 0,
    });
    expect(byMode.external_prescriptions?.inRecordCount).toBe(1);
    expect(byMode.external_prescription_fills?.inRecordCount).toBe(1);
    expect(byMode.external_lab_reports).toMatchObject({
      inRecordCount: 1,
      needsReviewCount: 1,
    });
    expect(byMode.external_lab_observations).toMatchObject({
      inRecordCount: 1,
      archiveOnlyCount: 1,
      needsReviewCount: 1,
    });
    expect(byMode.legacy_financial_documents).toMatchObject({
      inRecordCount: 0,
      archiveOnlyCount: 1,
      needsReviewCount: 0,
    });
    for (const domain of plan.domains) {
      expect(
        domain.inRecordCount +
          domain.archiveOnlyCount +
          domain.needsReviewCount +
          domain.errorCount,
      ).toBe(domain.sourceRows);
      expect(domain.reviewedPlanHash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(
      plan.totals.inRecordCount +
        plan.totals.archiveOnlyCount +
        plan.totals.needsReviewCount +
        plan.totals.errorCount,
    ).toBe(plan.totals.sourceRows);
    expect(plan.planHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("treats an exact retry as a duplicate and a changed row as a conflict", async () => {
    const first = await planHistoricalImport(emptyDatabase(owners()), {
      practiceId: PRACTICE_ID,
      source: "shepherd",
      records,
    });
    const prescription = first._domains.find(
      (domain) => domain.mode === "external_prescriptions",
    )?.rows[0] as { id: string; externalId: string; importFingerprint: string };

    const retryScript = owners();
    retryScript[4] = [
      {
        id: prescription.id,
        externalId: prescription.externalId,
        importFingerprint: prescription.importFingerprint,
        deletedAt: null,
      },
    ];
    const retry = await planHistoricalImport(emptyDatabase(retryScript), {
      practiceId: PRACTICE_ID,
      source: "shepherd",
      records,
    });
    expect(
      retry.domains.find((domain) => domain.mode === "external_prescriptions"),
    ).toMatchObject({ duplicateCount: 1, plannedInsertCount: 0, errorCount: 0 });

    const changed = {
      ...records,
      externalPrescriptions: [
        { ...records.externalPrescriptions[0], medicationName: "Medication Beta" },
      ],
    };
    const conflict = await planHistoricalImport(emptyDatabase(retryScript), {
      practiceId: PRACTICE_ID,
      source: "shepherd",
      records: changed,
    });
    expect(conflict.ready).toBe(false);
    expect(conflict.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          domain: "external_prescriptions",
          code: "source_identity_conflict",
        }),
      ]),
    );
    expect(conflict.planHash).not.toBe(retry.planHash);
  });

  it("does not target live calendar, prescription, invoice, or lab tables", () => {
    expect(HISTORICAL_IMPORT_TARGET_TABLES).not.toContain("appointments");
    expect(HISTORICAL_IMPORT_TARGET_TABLES).not.toContain("prescriptions");
    expect(HISTORICAL_IMPORT_TARGET_TABLES).not.toContain("invoices");
    expect(HISTORICAL_IMPORT_TARGET_TABLES).not.toContain("lab_results");
  });
});
