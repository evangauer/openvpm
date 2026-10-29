import { and, eq, isNull } from "drizzle-orm";
import {
  externalPrescriptions,
  externalLabReports,
  historicalDocuments,
  patients,
} from "@openpims/db";

/** Require both the imported row and the live patient to belong to this practice. */
export function patientArchiveFilter(
  table:
    | typeof externalPrescriptions
    | typeof externalLabReports
    | typeof historicalDocuments,
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
  );
}
