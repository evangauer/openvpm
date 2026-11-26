import { and, asc, desc, eq, isNull, ne, sql, type Column } from "drizzle-orm";
import {
  externalLabObservations,
  externalLabReports,
  externalPrescriptionFills,
  externalPrescriptions,
  files,
  historicalAppointments,
  historicalDocuments,
  patients,
} from "@openpims/db";
import type { Database } from "@openpims/db/client";
import {
  importedSourceBadge,
  mapScalarLabObservation,
} from "@/lib/import/historical-placement";

/**
 * A chart row is linked only when the live patient still carries the same
 * source identity the archive row was imported under. Name matches and
 * unlinked archive rows stay out of the chart.
 */
export function importedPatientLink(
  table: {
    practiceId: Column;
    patientId: Column;
    externalSource: Column;
    deletedAt: Column;
  },
  practiceId: string,
  patientId: string,
) {
  return and(
    eq(table.practiceId, practiceId),
    eq(table.patientId, patientId),
    isNull(table.deletedAt),
    eq(patients.id, patientId),
    eq(patients.practiceId, practiceId),
    isNull(patients.deletedAt),
    sql`${patients.externalId} is not null`,
    eq(patients.externalSource, table.externalSource),
  );
}

export function importedVisitFilter(practiceId: string, patientId: string) {
  return importedPatientLink(historicalAppointments, practiceId, patientId);
}

export function importedPrescriptionFilter(practiceId: string, patientId: string) {
  return importedPatientLink(externalPrescriptions, practiceId, patientId);
}

export function importedLabReportFilter(practiceId: string, patientId: string) {
  return and(
    importedPatientLink(externalLabReports, practiceId, patientId),
    eq(externalLabReports.attributionStatus, "matched"),
  );
}

export function importedDocumentFilter(practiceId: string, patientId: string) {
  return and(
    importedPatientLink(historicalDocuments, practiceId, patientId),
    eq(historicalDocuments.linkStatus, "linked"),
    ne(historicalDocuments.kind, "financial"),
  );
}

export interface PatientImportedChart {
  visits: Array<{
    id: string;
    startedAt: string;
    endedAt: string;
    status: string;
    appointmentType: string | null;
    reason: string | null;
    badge: string;
    createsCalendarWork: false;
  }>;
  prescriptions: Array<{
    id: string;
    medicationName: string;
    directions: string | null;
    status: string;
    prescribedAt: string | null;
    badge: string;
    dispensable: false;
    refillable: false;
    fills: Array<{
      id: string;
      filledAt: string | null;
      quantityDispensed: string | null;
      sourceStatus: string | null;
    }>;
  }>;
  labResults: Array<{
    id: string;
    testName: string;
    resultValue: string;
    unit: string | null;
    referenceRangeLow: string | null;
    referenceRangeHigh: string | null;
    resultFlag: string;
    resultedAt: string | null;
    badge: string;
  }>;
  labReports: Array<{
    id: string;
    orderName: string | null;
    status: string;
    resultedAt: string | null;
    badge: string;
    panelKeptInArchive: boolean;
  }>;
  documents: Array<{
    id: string;
    title: string;
    kind: string;
    documentDate: string | null;
    fileUrl: string | null;
    badge: string;
  }>;
}

export const IMPORTED_VISIT_SAFETY = { createsCalendarWork: false } as const;
export const IMPORTED_PRESCRIPTION_SAFETY = {
  dispensable: false,
  refillable: false,
} as const;

function iso(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export async function loadPatientImportedChart(
  db: Database,
  practiceId: string,
  patientId: string,
): Promise<PatientImportedChart | null> {
  const [patient] = await db
    .select({ id: patients.id })
    .from(patients)
    .where(
      and(
        eq(patients.id, patientId),
        eq(patients.practiceId, practiceId),
        isNull(patients.deletedAt),
      ),
    )
    .limit(1);
  if (!patient) return null;

  const visits = await db
    .select({
      id: historicalAppointments.id,
      startedAt: historicalAppointments.startedAt,
      endedAt: historicalAppointments.endedAt,
      status: historicalAppointments.status,
      appointmentType: historicalAppointments.appointmentType,
      reason: historicalAppointments.reason,
      externalSource: historicalAppointments.externalSource,
    })
    .from(historicalAppointments)
    .innerJoin(patients, eq(historicalAppointments.patientId, patients.id))
    .where(importedVisitFilter(practiceId, patientId))
    .orderBy(desc(historicalAppointments.startedAt), asc(historicalAppointments.id));

  const prescriptions = await db
    .select({
      id: externalPrescriptions.id,
      medicationName: externalPrescriptions.medicationName,
      directions: externalPrescriptions.directions,
      status: externalPrescriptions.status,
      prescribedAt: externalPrescriptions.prescribedAt,
      externalSource: externalPrescriptions.externalSource,
    })
    .from(externalPrescriptions)
    .innerJoin(patients, eq(externalPrescriptions.patientId, patients.id))
    .where(importedPrescriptionFilter(practiceId, patientId))
    .orderBy(
      desc(externalPrescriptions.prescribedAt),
      asc(externalPrescriptions.id),
    );

  const prescriptionIds = prescriptions.map((row) => row.id);
  const fills =
    prescriptionIds.length === 0
      ? []
      : await db
          .select({
            id: externalPrescriptionFills.id,
            prescriptionId: externalPrescriptionFills.prescriptionId,
            filledAt: externalPrescriptionFills.filledAt,
            quantityDispensed: externalPrescriptionFills.quantityDispensed,
            sourceStatus: externalPrescriptionFills.sourceStatus,
          })
          .from(externalPrescriptionFills)
          .innerJoin(
            externalPrescriptions,
            and(
              eq(externalPrescriptionFills.prescriptionId, externalPrescriptions.id),
              eq(externalPrescriptionFills.practiceId, practiceId),
              eq(externalPrescriptions.practiceId, practiceId),
            ),
          )
          .where(
            and(
              eq(externalPrescriptionFills.practiceId, practiceId),
              isNull(externalPrescriptionFills.deletedAt),
              isNull(externalPrescriptions.deletedAt),
              sql`${externalPrescriptionFills.prescriptionId} in (${sql.join(
                prescriptionIds.map((id) => sql`${id}`),
                sql`, `,
              )})`,
            ),
          )
          .orderBy(
            desc(externalPrescriptionFills.filledAt),
            asc(externalPrescriptionFills.id),
          );

  const reports = await db
    .select({
      id: externalLabReports.id,
      orderName: externalLabReports.orderName,
      status: externalLabReports.status,
      resultedAt: externalLabReports.resultedAt,
      externalSource: externalLabReports.externalSource,
    })
    .from(externalLabReports)
    .innerJoin(patients, eq(externalLabReports.patientId, patients.id))
    .where(importedLabReportFilter(practiceId, patientId))
    .orderBy(desc(externalLabReports.resultedAt), asc(externalLabReports.id));

  const reportIds = reports.map((row) => row.id);
  const observations =
    reportIds.length === 0
      ? []
      : await db
          .select({
            id: externalLabObservations.id,
            reportId: externalLabObservations.reportId,
            name: externalLabObservations.name,
            value: externalLabObservations.value,
            unit: externalLabObservations.unit,
            referenceRange: externalLabObservations.referenceRange,
            flag: externalLabObservations.flag,
            externalSource: externalLabObservations.externalSource,
          })
          .from(externalLabObservations)
          .innerJoin(
            externalLabReports,
            and(
              eq(externalLabObservations.reportId, externalLabReports.id),
              eq(externalLabObservations.practiceId, practiceId),
              eq(externalLabReports.practiceId, practiceId),
            ),
          )
          .where(
            and(
              eq(externalLabObservations.practiceId, practiceId),
              isNull(externalLabObservations.deletedAt),
              isNull(externalLabReports.deletedAt),
              sql`${externalLabObservations.reportId} in (${sql.join(
                reportIds.map((id) => sql`${id}`),
                sql`, `,
              )})`,
            ),
          )
          .orderBy(
            asc(externalLabObservations.sortOrder),
            asc(externalLabObservations.id),
          );

  const documents = await db
    .select({
      id: historicalDocuments.id,
      title: historicalDocuments.title,
      kind: historicalDocuments.kind,
      documentDate: historicalDocuments.documentDate,
      externalSource: historicalDocuments.externalSource,
      fileUrl: files.fileUrl,
      fileDeletedAt: files.deletedAt,
      storageStatus: files.storageStatus,
    })
    .from(historicalDocuments)
    .innerJoin(patients, eq(historicalDocuments.patientId, patients.id))
    .innerJoin(
      files,
      and(
        eq(historicalDocuments.fileId, files.id),
        eq(files.practiceId, practiceId),
      ),
    )
    .where(importedDocumentFilter(practiceId, patientId))
    .orderBy(desc(historicalDocuments.documentDate), asc(historicalDocuments.id));

  const fillsByPrescription = new Map<string, typeof fills>();
  for (const fill of fills) {
    const current = fillsByPrescription.get(fill.prescriptionId) ?? [];
    current.push(fill);
    fillsByPrescription.set(fill.prescriptionId, current);
  }
  const observationsByReport = new Map<string, typeof observations>();
  for (const observation of observations) {
    const current = observationsByReport.get(observation.reportId) ?? [];
    current.push(observation);
    observationsByReport.set(observation.reportId, current);
  }

  const labResults: PatientImportedChart["labResults"] = [];
  const labReports: PatientImportedChart["labReports"] = reports.map((report) => {
    const rows = observationsByReport.get(report.id) ?? [];
    let panelKeptInArchive = rows.length === 0;
    for (const row of rows) {
      const mapped = mapScalarLabObservation(row);
      if (!mapped) {
        panelKeptInArchive = true;
        continue;
      }
      labResults.push({
        id: row.id,
        ...mapped,
        resultedAt: iso(report.resultedAt),
        badge: importedSourceBadge(row.externalSource),
      });
    }
    return {
      id: report.id,
      orderName: report.orderName,
      status: report.status,
      resultedAt: iso(report.resultedAt),
      badge: importedSourceBadge(report.externalSource),
      panelKeptInArchive,
    };
  });

  return {
    visits: visits.map((visit) => ({
      id: visit.id,
      startedAt: visit.startedAt.toISOString(),
      endedAt: visit.endedAt.toISOString(),
      status: visit.status,
      appointmentType: visit.appointmentType,
      reason: visit.reason,
      badge: importedSourceBadge(visit.externalSource),
      createsCalendarWork: IMPORTED_VISIT_SAFETY.createsCalendarWork,
    })),
    prescriptions: prescriptions.map((prescription) => ({
      id: prescription.id,
      medicationName: prescription.medicationName,
      directions: prescription.directions,
      status: prescription.status,
      prescribedAt: iso(prescription.prescribedAt),
      badge: importedSourceBadge(prescription.externalSource),
      dispensable: IMPORTED_PRESCRIPTION_SAFETY.dispensable,
      refillable: IMPORTED_PRESCRIPTION_SAFETY.refillable,
      fills: (fillsByPrescription.get(prescription.id) ?? []).map((fill) => ({
        id: fill.id,
        filledAt: iso(fill.filledAt),
        quantityDispensed: fill.quantityDispensed,
        sourceStatus: fill.sourceStatus,
      })),
    })),
    labResults,
    labReports,
    documents: documents.map((document) => ({
      id: document.id,
      title: document.title,
      kind: document.kind,
      documentDate: document.documentDate,
      fileUrl:
        document.fileDeletedAt || document.storageStatus !== "available"
          ? null
          : document.fileUrl,
      badge: importedSourceBadge(document.externalSource),
    })),
  };
}
